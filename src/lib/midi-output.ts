import type { FlushResult, StepMessage, StepNote, StepperOutput } from './scheduler';

export type MidiSender = (status: number, data1: number, data2: number, timestamp?: number) => void;

export type QueuedOutputOptions = {
  send: MidiSender;
  now?: () => number;
  setInterval?: (callback: () => void, ms: number) => number;
  clearInterval?: (id: number) => void;
  /** Pump interval in milliseconds. */
  intervalMs?: number;
};

type Entry = {
  kind: 'off' | 'on' | 'marker';
  time: number;
  note?: StepNote;
  step?: number;
};

/**
 * Output adapter with a short second-stage queue. The scheduler hands notes
 * over early; this adapter sends them at their timestamps. The explicit
 * boundary makes pause, stop, hot-plug and disconnect behavior testable
 * without relying on cancellation of already delivered Web MIDI messages.
 */
export class QueuedMidiOutput implements StepperOutput {
  private readonly send: MidiSender;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => number;
  private readonly clearTimer: (id: number) => void;
  private readonly intervalMs: number;

  private queue: Entry[] = [];
  private active = new Map<string, StepNote>();
  private statusByStep = new Map<number, Set<'queued' | 'active' | 'passed'>>();
  private lastPassedStep: number | undefined;
  private timerId: number | null = null;
  private disconnected = false;

  constructor(options: QueuedOutputOptions) {
    this.send = options.send;
    this.now = options.now ?? (() => performance.now());
    this.setTimer = options.setInterval ?? ((callback, ms) => window.setInterval(callback, ms));
    this.clearTimer = options.clearInterval ?? ((id) => window.clearInterval(id));
    this.intervalMs = options.intervalMs ?? 8;
  }

  schedule(message: StepMessage): void {
    if (this.disconnected) return;

    if (message.notes.length > 0) {
      const states = this.statusByStep.get(message.step) ?? new Set<'queued' | 'active' | 'passed'>();
      states.add('queued');
      this.statusByStep.set(message.step, states);
    }

    for (const note of message.notes) {
      this.queue.push({ kind: 'on', time: note.start, note, step: message.step });
      this.queue.push({ kind: 'off', time: note.start + note.duration, note, step: message.step });
    }
    // Markers advance a rest step and clean queued status when note-off arrives
    // at the same instant as the next note-on.
    this.queue.push({ kind: 'marker', time: message.time, step: message.step });
    this.sortQueue();
    this.ensureTimer();
    this.pump();
  }

  flush(reason: 'pause' | 'stop' | 'switch' | 'disconnect'): FlushResult {
    const now = this.now();
    this.pump(now);

    const result: FlushResult = { active: [], canceled: [] };
    this.statusByStep.forEach((states, step) => {
      if (states.has('active')) result.active.push(step);
      else if (states.has('queued')) result.canceled.push(step);
    });
    result.active.sort((a, b) => a - b);
    result.canceled.sort((a, b) => a - b);
    result.lastPassed = [this.lastPassedStep ?? -1, ...result.active].reduce((max, step) => Math.max(max, step));
    if (result.lastPassed < 0) result.lastPassed = undefined;

    // Explicit note-offs have deterministic ordering. On disconnect, send
    // All Notes Off too because some implementations may drop queued events.
    const activeNotes = [...this.active.values()].sort(
      (a, b) => a.start - b.start || a.channel - b.channel || a.pitch - b.pitch
    );
    for (const note of activeNotes) this.sendNoteOff(note, now);

    if (reason === 'disconnect') {
      for (const channel of new Set(activeNotes.map((note) => note.channel))) {
        try {
          this.send(0xb0 | channel, 123, 0, now);
        } catch {
          // A closed port cannot be made quieter through software.
        }
      }
    }

    this.stopTimer();
    this.queue = [];
    this.active.clear();
    this.statusByStep.clear();
    this.lastPassedStep = undefined;
    this.disconnected = reason === 'disconnect';
    return result;
  }

  /** Exposed for deterministic tests; in production the interval calls it. */
  pump(at = this.now()): void {
    while (this.queue.length > 0 && this.queue[0].time <= at) {
      const entry = this.queue.shift();
      if (entry) this.dispatch(entry, at);
    }
    if (this.queue.length === 0) this.stopTimer();
  }

  private dispatch(entry: Entry, now: number): void {
    if (entry.kind === 'marker') {
      if (entry.step !== undefined) {
        const states = this.statusByStep.get(entry.step) ?? new Set<'queued' | 'active' | 'passed'>();
        if (!states.has('active')) {
          if (!states.has('queued')) states.add('passed');
          this.statusByStep.set(entry.step, states);
          this.lastPassedStep = Math.max(this.lastPassedStep ?? -1, entry.step);
        }
      }
      return;
    }

    const note = entry.note;
    const step = entry.step;
    if (!note || step === undefined) return;

    const key = noteKey(note);
    let states = this.statusByStep.get(step) ?? new Set<'queued' | 'active' | 'passed'>();

    if (entry.kind === 'on') {
      if (!this.active.has(key)) {
        this.send(0x90 | note.channel, note.pitch, note.velocity, Math.max(now, entry.time));
        this.active.set(key, note);
      }
      states.delete('queued');
      states.add('active');
    } else {
      if (this.active.has(key)) {
        this.sendNoteOff(note, Math.max(now, entry.time));
        this.active.delete(key);
      }
      states.delete('active');
      if (states.size === 0) this.statusByStep.delete(step);
    }
  }

  private sendNoteOff(note: StepNote, time: number): void {
    this.send(0x80 | note.channel, note.pitch, 0, time);
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => {
      if (a.time !== b.time) return a.time - b.time;
      const rank = { off: 0, on: 1, marker: 2 } as const;
      return rank[a.kind] - rank[b.kind];
    });
  }

  private ensureTimer(): void {
    if (this.timerId !== null || this.queue.length === 0) return;
    this.timerId = this.setTimer(() => this.pump(), this.intervalMs);
  }

  private stopTimer(): void {
    if (this.timerId !== null) {
      this.clearTimer(this.timerId);
      this.timerId = null;
    }
  }
}

function noteKey(note: StepNote): string {
  return `${note.channel}:${note.pitch}`;
}
