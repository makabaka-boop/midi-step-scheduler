import { clamp, MAX_BPM, MIN_BPM } from './model';
import type { Pattern, Step } from './model';

export type SchedulerState = 'stopped' | 'paused' | 'playing';

export type StepNote = {
  step: number;
  track: number;
  channel: number;
  pitch: number;
  velocity: number;
  start: number;
  duration: number;
};

export type StepMessage = {
  step: number;
  time: number;
  notes: StepNote[];
};

export type FlushResult = {
  active: number[];
  canceled: number[];
  lastPassed?: number;
};

export interface StepperOutput {
  schedule(message: StepMessage): void;
  flush(reason: 'pause' | 'stop' | 'switch' | 'disconnect'): FlushResult;
}

export type ClockCancellation = { cancel(): void };

export interface StepperClock {
  now(): number;
  setInterval(callback: () => void, milliseconds: number): ClockCancellation;
}

export type PatternSource = () => Pattern;
export type StateListener = (state: SchedulerState, step: number) => void;

export type SchedulerOptions = {
  clock?: StepperClock;
  output?: StepperOutput | null;
  bpm?: number;
  lookaheadMs?: number;
  intervalMs?: number;
  startDelayMs?: number;
};

/**
 * Plans notes on a musical time grid using a short-period wakeup timer.
 * The timer is not itself the metronome: every message carries an absolute
 * timestamp based on the BPM grid.
 */
export class LookaheadScheduler {
  state: SchedulerState = 'stopped';
  private currentStep = 0;

  private readonly clock: StepperClock;
  private output: StepperOutput | null;
  private readonly source: PatternSource;
  private readonly listeners = new Set<StateListener>();
  private timer: ClockCancellation | null = null;

  private bpmValue: number;
  private readonly lookaheadMs: number;
  private readonly intervalMs: number;
  private readonly startDelayMs: number;

  /** anchorStep occurs at anchorTime; global step numbers increase forever. */
  private anchorStep = 0;
  private anchorTime = 0;
  private nextStepNumber = 0;
  private resumeStep = 0;

  constructor(source: PatternSource, options: SchedulerOptions = {}) {
    this.source = source;
    this.clock = options.clock ?? browserClock;
    this.output = options.output ?? null;
    this.bpmValue = clamp(options.bpm ?? 120, MIN_BPM, MAX_BPM);
    this.lookaheadMs = options.lookaheadMs ?? 100;
    this.intervalMs = options.intervalMs ?? 25;
    this.startDelayMs = options.startDelayMs ?? 50;
  }

  get bpm(): number {
    return this.bpmValue;
  }

  get step(): number {
    return this.currentStep;
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.state, this.currentStep);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener(this.state, this.currentStep));
  }

  private setState(state: SchedulerState): void {
    if (this.state !== state) {
      this.state = state;
      this.emit();
    }
  }

  setBpm(value: number): void {
    const next = clamp(value, MIN_BPM, MAX_BPM);
    if (next === this.bpmValue) return;

    if (this.state === 'playing' || this.state === 'paused') {
      const anchor = this.nextStepNumber - 1;
      const anchorTime = this.timeForStep(anchor);
      this.bpmValue = next;
      this.anchorStep = anchor;
      this.anchorTime = anchorTime;
    } else {
      this.bpmValue = next;
    }
  }

  play(): void {
    if (this.state === 'playing') return;

    const globalStart = this.state === 'paused' ? this.resumeStep : 0;
    this.currentStep = globalStart % Math.max(1, this.source().length);
    this.anchorStep = globalStart;
    this.anchorTime = this.clock.now() + this.startDelayMs;
    this.nextStepNumber = globalStart;
    this.setState('playing');
    this.ensureTimer();
    this.tick();
  }

  pause(): void {
    if (this.state !== 'playing') return;

    this.stopTimer();
    const report = this.output?.flush('pause') ?? { active: [], canceled: [] };
    const candidates = [
      ...report.active.map((step) => step + 1),
      ...report.canceled,
      ...(typeof report.lastPassed === 'number' ? [report.lastPassed + 1] : [])
    ];
    const boundary = candidates.length > 0 ? Math.min(...candidates) : this.nextStepNumber;
    this.resumeStep = boundary;
    this.currentStep = boundary % Math.max(1, this.source().length);
    this.nextStepNumber = boundary;
    this.anchorStep = boundary;
    this.anchorTime = this.timeForStep(boundary);
    this.setState('paused');
  }

  stop(): void {
    if (this.state === 'stopped') return;

    this.stopTimer();
    this.output?.flush('stop');
    this.nextStepNumber = 0;
    this.resumeStep = 0;
    this.anchorStep = 0;
    this.anchorTime = 0;
    this.currentStep = 0;
    this.setState('stopped');
  }

  setOutput(output: StepperOutput | null): void {
    if (this.output === output) return;

    const report = this.output?.flush('switch') ?? { active: [], canceled: [] };
    this.output = output;

    if (this.state === 'playing') {
      this.rewindAfterFlush(report);
      if (output) {
        this.ensureTimer();
        this.tick();
      } else {
        this.stopTimer();
      }
    }
  }

  outputLost(output: StepperOutput): void {
    if (this.output !== output) return;

    output.flush('disconnect');
    this.output = null;
    this.stopTimer();
    this.currentStep = 0;
    this.nextStepNumber = 0;
    this.resumeStep = 0;
    this.anchorStep = 0;
    this.anchorTime = 0;
    this.setState('stopped');
  }

  private rewindAfterFlush(report: FlushResult): void {
    const candidates = [
      ...report.active.map((step) => step + 1),
      ...report.canceled,
      ...(typeof report.lastPassed === 'number' ? [report.lastPassed + 1] : [])
    ];
    if (candidates.length === 0) return;

    const earliest = Math.min(...candidates);
    const time = this.timeForStep(earliest);
    this.anchorStep = earliest;
    this.anchorTime = time;
    this.nextStepNumber = earliest;
  }

  private stepDurationMs(): number {
    return 60_000 / this.bpmValue / 4;
  }

  private timeForStep(step: number): number {
    return this.anchorTime + (step - this.anchorStep) * this.stepDurationMs();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = this.clock.setInterval(() => this.tick(), this.intervalMs);
  }

  private stopTimer(): void {
    this.timer?.cancel();
    this.timer = null;
  }

  tick(): void {
    if (this.state !== 'playing') return;

    const now = this.clock.now();
    const horizon = now + this.lookaheadMs;
    const pattern = this.snapshot();

    while (this.timeForStep(this.nextStepNumber) <= horizon) {
      const globalStep = this.nextStepNumber;
      const time = this.timeForStep(globalStep);

      // Do not dump an old bar onto a port after an unusually late callback.
      if (time < now - 12) {
        this.nextStepNumber = globalStep + 1;
        this.setCurrentStep(globalStep, pattern.length);
        continue;
      }

      const message: StepMessage = {
        step: globalStep,
        time,
        notes: this.notesAt(globalStep, time, this.stepDurationMs(), pattern)
      };
      try {
        this.output?.schedule(message);
      } catch (error) {
        console.error('MIDI scheduling failed', error);
      }
      this.nextStepNumber = globalStep + 1;
      if (time <= now + 1) this.setCurrentStep(globalStep, pattern.length);
    }
  }

  private setCurrentStep(globalStep: number, length: number): void {
    const wrapped = globalStep % length;
    if (this.currentStep !== wrapped) {
      this.currentStep = wrapped;
      this.emit();
    }
  }

  private snapshot(): Pattern {
    const pattern = this.source();
    return {
      length: pattern.length,
      tracks: pattern.tracks.map((track) => ({
        name: track.name,
        steps: track.steps.map((step) => ({ ...step }))
      }))
    };
  }

  private notesAt(globalStep: number, time: number, stepDuration: number, pattern: Pattern): StepNote[] {
    const stepIndex = globalStep % pattern.length;
    const notes: StepNote[] = [];

    pattern.tracks.forEach((track, trackIndex) => {
      const step: Step | undefined = track.steps[stepIndex];
      if (!step?.enabled || step.velocity <= 0 || step.gate <= 0) return;

      notes.push({
        step: globalStep,
        track: trackIndex,
        channel: trackIndex,
        pitch: clamp(Math.round(step.pitch), 0, 127),
        velocity: clamp(Math.round(step.velocity), 1, 127),
        start: time,
        duration: stepDuration * clamp(step.gate, 0, 1)
      });
    });

    return notes;
  }
}

export const browserClock: StepperClock = {
  now: () => performance.now(),
  setInterval(callback, milliseconds) {
    const id = window.setInterval(callback, milliseconds);
    return {
      cancel() {
        window.clearInterval(id);
      }
    };
  }
};

/** Deterministic clock. Advance pumps callbacks at their virtual instants. */
export class ManualClock implements StepperClock {
  private timeMs: number;
  private readonly timers = new Map<
    number,
    { callback: () => void; intervalMs: number; nextAt: number }
  >();
  private nextId = 1;

  constructor(start = 0) {
    this.timeMs = start;
  }

  now(): number {
    return this.timeMs;
  }

  advance(ms: number): void {
    const end = this.timeMs + ms;
    let timer = this.earliestDue(end);
    while (timer) {
      this.timeMs = timer.nextAt;
      timer.nextAt += timer.intervalMs;
      timer.callback();
      timer = this.earliestDue(end);
    }
    this.timeMs = end;
  }

  set(ms: number): void {
    this.timeMs = Math.max(ms, this.timeMs);
  }

  setInterval(callback: () => void, intervalMs: number): ClockCancellation {
    const id = this.nextId++;
    this.timers.set(id, { callback, intervalMs, nextAt: this.timeMs + intervalMs });
    return {
      cancel: () => {
        this.timers.delete(id);
      }
    };
  }

  private earliestDue(end: number) {
    const due = [...this.timers.values()].filter((timer) => timer.nextAt <= end);
    if (due.length === 0) return undefined;
    return due.reduce((earliest, timer) => (timer.nextAt < earliest.nextAt ? timer : earliest));
  }
}
