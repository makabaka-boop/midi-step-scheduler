/**
 * Lookahead transport scheduler.
 *
 * A short-period tick (every `tickMs`) runs two phases:
 *   1. schedule — materialize note-on/note-off events for every step whose
 *      start time falls inside the lookahead horizon (`now + lookaheadMs`);
 *   2. dispatch — send every queued event whose time has come due.
 *
 * The beat is therefore kept by the clock timeline, never by a chain of
 * per-step timers: a late tick simply schedules and dispatches whatever it
 * missed (bounded by `catchUpMs`, so a stalled tab cannot unleash a storm
 * of overdue notes).
 *
 * Because events only enter the queue one lookahead window ahead of time,
 * tempo changes and score edits naturally affect only steps that have not
 * been sent yet. `tempoChanged` additionally re-plans the not-yet-dispatched
 * part of the queue at the new tempo while leaving already-sounding notes
 * (and their note-offs) untouched.
 *
 * Pause, stop, output switch and output loss all run the same cleanup:
 * cancel every queued (unsent) message and immediately note-off every
 * note this scheduler started, so nothing can stick or fire twice.
 */

import type { Clock, TimerHandle } from './clock';
import { noteOff, noteOn } from './midi';
import type { MidiOutputAdapter } from './output';
import { STEPS_PER_BEAT, type Pattern } from './types';

export type TransportState = 'stopped' | 'playing' | 'paused';

export interface ScheduledEvent {
  id: number;
  kind: 'noteOn' | 'noteOff';
  /** Due time on the scheduler clock, ms. */
  time: number;
  channel: number;
  pitch: number;
  velocity: number;
  /** Links a note-off to the note-on it belongs to. */
  pairId: number;
}

interface ActiveNote {
  channel: number;
  pitch: number;
  /** True once the note-on was actually dispatched (audibly sounding). */
  sounding: boolean;
}

export interface SchedulerOptions {
  clock: Clock;
  /** Live pattern source; read at schedule time so edits apply to future steps. */
  getPattern: () => Pattern;
  /** Live tempo source (BPM); read at schedule time. */
  getTempo: () => number;
  lookaheadMs?: number;
  tickMs?: number;
  /** Steps older than this are skipped rather than fired late. */
  catchUpMs?: number;
  /** Playhead callback, fired when a step boundary is reached. */
  onStep?: (stepIndex: number, timeMs: number) => void;
  onStateChange?: (state: TransportState) => void;
}

const DEFAULT_LOOKAHEAD_MS = 120;
const DEFAULT_TICK_MS = 25;
const DEFAULT_CATCH_UP_MS = 240;

export class Scheduler {
  private readonly clock: Clock;
  private readonly getPattern: () => Pattern;
  private readonly getTempo: () => number;
  private readonly lookaheadMs: number;
  private readonly tickMs: number;
  private readonly catchUpMs: number;
  private readonly onStep?: (stepIndex: number, timeMs: number) => void;
  private readonly onStateChange?: (state: TransportState) => void;

  private output: MidiOutputAdapter | null = null;
  private state: TransportState = 'stopped';
  private timer: TimerHandle | null = null;

  /** Next step to schedule, and when it is due. */
  private stepIndex = 0;
  private nextStepTime = 0;
  /** Last step boundary that came due (drives tempo-change re-planning). */
  private lastBoundary: { step: number; time: number } = { step: -1, time: 0 };

  /** Queued, not yet dispatched events — the "已排队消息". */
  private pending: ScheduledEvent[] = [];
  /** Steps scheduled but not yet reached (for the playhead callback). */
  private stepTimes: { step: number; time: number }[] = [];
  /** Notes this scheduler started and has not yet closed, keyed by note-on event id. */
  private activeNotes = new Map<number, ActiveNote>();
  private eventSeq = 0;

  constructor(options: SchedulerOptions) {
    this.clock = options.clock;
    this.getPattern = options.getPattern;
    this.getTempo = options.getTempo;
    this.lookaheadMs = options.lookaheadMs ?? DEFAULT_LOOKAHEAD_MS;
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.catchUpMs = options.catchUpMs ?? DEFAULT_CATCH_UP_MS;
    this.onStep = options.onStep;
    this.onStateChange = options.onStateChange;
  }

  get transportState(): TransportState {
    return this.state;
  }

  get position(): number {
    return this.stepIndex;
  }

  get queuedEvents(): readonly ScheduledEvent[] {
    return this.pending;
  }

  get soundingNotes(): number {
    let n = 0;
    for (const note of this.activeNotes.values()) if (note.sounding) n++;
    return n;
  }

  /** Attach or replace the output. Null = no output (playback refused). */
  setOutput(output: MidiOutputAdapter | null): void {
    const old = this.output;
    if (old === output) return;
    this.output = output;
    if (old) {
      // Notes still sounding on the old device must be closed *there*,
      // or they would ring forever on hardware we no longer talk to.
      this.silence(old);
    }
    this.dropQueue();
    // Re-plan the current lookahead window onto the new output so a
    // mid-play switch does not swallow beats.
    if (this.state === 'playing') {
      this.rewindToLastBoundary();
    }
  }

  /**
   * Start or resume playback. Returns false (and changes nothing) when
   * there is no output — without a destination we refuse to pretend
   * to play. Repeated calls while playing are a no-op.
   */
  play(): boolean {
    if (this.state === 'playing') return true;
    if (!this.output) return false;
    if (this.state === 'stopped') {
      this.stepIndex = 0;
    }
    this.setState('playing');
    // Start the (possibly resumed) step almost immediately, but on the
    // clock timeline so the grid stays exact.
    this.nextStepTime = this.clock.now() + 1;
    this.lastBoundary = {
      step: this.stepIndex - 1,
      time: this.nextStepTime - this.stepDuration()
    };
    this.tick();
    return true;
  }

  /** Halt and keep position. Sounding notes are closed immediately. */
  pause(): void {
    if (this.state !== 'playing') return;
    this.setState('paused');
    this.cancelTimer();
    this.silence(this.output);
    this.dropQueue();
    // Resume from the first step that never made it out the door.
    this.stepIndex = this.lastBoundary.step + 1;
  }

  /** Halt and rewind to step 0. Sounding notes are closed immediately. */
  stop(): void {
    if (this.state === 'stopped') return;
    this.setState('stopped');
    this.cancelTimer();
    this.silence(this.output);
    this.dropQueue();
    this.stepIndex = 0;
    this.nextStepTime = 0;
    this.lastBoundary = { step: -1, time: 0 };
  }

  /**
   * Tempo changes only re-plan steps that have not been sent yet:
   * queued note-ons are dropped and re-scheduled at the new tempo from
   * the last reached boundary, while already-sounding notes keep their
   * original note-off times.
   */
  tempoChanged(): void {
    if (this.state !== 'playing') return;
    this.dropUndispatched();
    this.rewindToLastBoundary();
  }

  /** Duration of one step in ms at the current tempo. */
  stepDuration(): number {
    return 60000 / (this.getTempo() * STEPS_PER_BEAT);
  }

  // -------------------------------------------------------------------

  private setState(state: TransportState): void {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange?.(state);
  }

  private tick = (): void => {
    this.timer = null;
    if (this.state !== 'playing') return;
    const now = this.clock.now();
    this.scheduleAhead(now + this.lookaheadMs, now);
    this.dispatchDue(now);
    if (this.state === 'playing') {
      this.timer = this.clock.setTimeout(this.tick, this.tickMs);
    }
  };

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleAhead(horizon: number, now: number): void {
    // Guard against pathological tempos producing zero-length steps.
    const stepDur = Math.max(1, this.stepDuration());
    while (this.nextStepTime < horizon) {
      const time = this.nextStepTime;
      const step = this.stepIndex;
      // A step so far in the past that firing it now would be a
      // catch-up storm (e.g. after a stalled tab) is skipped, but the
      // playhead still advances over it.
      if (time >= now - this.catchUpMs) {
        this.scheduleStep(step, time, stepDur);
      }
      this.stepTimes.push({ step, time });
      this.nextStepTime += stepDur;
      this.stepIndex += 1;
    }
  }

  private scheduleStep(step: number, time: number, stepDur: number): void {
    const pattern = this.getPattern();
    for (const track of pattern.tracks) {
      if (track.muted || track.steps.length === 0) continue;
      const cell = track.steps[step % track.steps.length];
      if (!cell || !cell.enabled) continue;

      // Retrigger guard: any still-open instance of the same note (whether
      // already sounding or merely queued) is closed exactly when the new
      // one starts, so the two never overlap or stick.
      for (const e of this.pending) {
        if (
          e.kind === 'noteOff' &&
          e.channel === track.channel &&
          e.pitch === cell.pitch &&
          e.time > time
        ) {
          e.time = time;
        }
      }

      const onId = ++this.eventSeq;
      const offId = ++this.eventSeq;
      this.pending.push({
        id: onId,
        kind: 'noteOn',
        time,
        channel: track.channel,
        pitch: cell.pitch,
        velocity: cell.velocity,
        pairId: offId
      });
      this.pending.push({
        id: offId,
        kind: 'noteOff',
        time: time + stepDur * cell.gate,
        channel: track.channel,
        pitch: cell.pitch,
        velocity: 0,
        pairId: onId
      });
      this.activeNotes.set(onId, {
        channel: track.channel,
        pitch: cell.pitch,
        sounding: false
      });
    }
  }

  private dispatchDue(now: number): void {
    if (this.pending.length > 0) {
      const due = this.pending
        .filter((e) => e.time <= now)
        .sort((a, b) => a.time - b.time || a.id - b.id);
      this.pending = this.pending.filter((e) => e.time > now);
      for (const event of due) {
        if (this.output) {
          this.output.send(
            event.kind === 'noteOn'
              ? noteOn(event.channel, event.pitch, event.velocity)
              : noteOff(event.channel, event.pitch),
            event.time
          );
        }
        if (event.kind === 'noteOn') {
          const active = this.activeNotes.get(event.id);
          if (active) active.sounding = true;
        } else {
          this.activeNotes.delete(event.pairId);
        }
      }
    }
    if (this.stepTimes.length > 0) {
      const reached = this.stepTimes.filter((s) => s.time <= now);
      this.stepTimes = this.stepTimes.filter((s) => s.time > now);
      for (const s of reached) {
        this.lastBoundary = { step: s.step, time: s.time };
        this.onStep?.(s.step, s.time);
      }
    }
  }

  /** Send note-offs for every sounding note to the given output. */
  private silence(output: MidiOutputAdapter | null): void {
    if (!output) return;
    for (const note of this.activeNotes.values()) {
      if (note.sounding) output.send(noteOff(note.channel, note.pitch));
    }
  }

  /** Drop every queued-but-unsent message and forget all open notes. */
  private dropQueue(): void {
    this.pending = [];
    this.stepTimes = [];
    this.activeNotes.clear();
  }

  /**
   * Drop queued note-ons together with their paired note-offs, but keep
   * note-offs belonging to notes already dispatched (still sounding).
   */
  private dropUndispatched(): void {
    const unsentOnIds = new Set(
      this.pending.filter((e) => e.kind === 'noteOn').map((e) => e.id)
    );
    this.pending = this.pending.filter(
      (e) => e.kind === 'noteOff' && !unsentOnIds.has(e.pairId)
    );
    for (const id of unsentOnIds) this.activeNotes.delete(id);
    this.stepTimes = [];
  }

  /** Re-schedule the lookahead window starting at the last reached boundary. */
  private rewindToLastBoundary(): void {
    this.stepIndex = this.lastBoundary.step + 1;
    this.nextStepTime = Math.max(
      this.clock.now(),
      this.lastBoundary.time + this.stepDuration()
    );
  }
}
