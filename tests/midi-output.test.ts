import { describe, expect, it } from 'vitest';
import { QueuedMidiOutput } from '../src/lib/midi-output';
import type { StepMessage } from '../src/lib/scheduler';
import type { SentMidi } from './helpers';

class TimerHarness {
  private nowValue = 100;
  callbacks = new Map<number, () => void>();
  private nextId = 1;
  events: SentMidi[] = [];

  now = () => this.nowValue;
  setInterval = (callback: () => void): number => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  };
  clearInterval = (id: number): void => {
    this.callbacks.delete(id);
  };
  send = (status: number, data1: number, data2: number, time?: number): void => {
    this.events.push({ status, data1, data2, time });
  };
  advance(ms: number): void {
    this.nowValue += ms;
    [...this.callbacks.values()].forEach((callback) => callback());
  }
}

function note(step: number, track: number, pitch: number, start: number, duration: number, velocity = 90) {
  return { step, track, channel: track, pitch, velocity, start, duration };
}

function message(step: number, time: number, notes: StepMessage['notes']) {
  return { step, time, notes };
}

describe('QueuedMidiOutput', () => {
  it('sends timestamped note-ons and note-offs without duplicated notes', () => {
    const timer = new TimerHarness();
    const output = new QueuedMidiOutput({
      send: timer.send,
      now: timer.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
      intervalMs: 5
    });

    output.schedule(message(0, 100, [note(0, 0, 48, 100, 50)]));
    timer.advance(0);
    timer.advance(50);

    expect(timer.events).toEqual([
      { status: 0x90, data1: 48, data2: 90, time: 100 },
      { status: 0x80, data1: 48, data2: 0, time: 150 }
    ]);
  });

  it('pause sends note-off for every active note and reports active versus queued steps', () => {
    const timer = new TimerHarness();
    const output = new QueuedMidiOutput({
      send: timer.send,
      now: timer.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval
    });

    output.schedule(message(0, 100, [note(0, 0, 48, 100, 100, 100)]));
    output.schedule(message(1, 200, [note(1, 1, 60, 200, 100, 80)]));
    timer.advance(0); // step 0 starts
    const report = output.flush('pause');

    expect(report.active).toEqual([0]);
    expect(report.canceled).toEqual([1]);
    expect(report.lastPassed).toBe(0);
    expect(timer.events).toEqual([
      { status: 0x90, data1: 48, data2: 100, time: 100 },
      { status: 0x80, data1: 48, data2: 0, time: 100 }
    ]);

    output.flush('stop');
    // No repeated note-offs for the first interrupted note.
    expect(timer.events.filter((event) => event.status === 0x80)).toHaveLength(1);
  });

  it('reports passed rest boundaries so pause does not return to an old step', () => {
    const timer = new TimerHarness();
    const output = new QueuedMidiOutput({
      send: timer.send,
      now: timer.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval
    });
    output.schedule(message(0, 100, []));
    output.schedule(message(1, 200, []));
    timer.advance(0);
    timer.advance(100);

    const report = output.flush('pause');
    expect(report.lastPassed).toBe(1);
  });

  it('disconnect sends explicit note-offs and All Notes Off to active channels', () => {
    const timer = new TimerHarness();
    const output = new QueuedMidiOutput({
      send: timer.send,
      now: timer.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval
    });
    output.schedule(message(0, 100, [note(0, 0, 48, 100, 100), note(0, 2, 72, 100, 100)]));
    timer.advance(0);

    const report = output.flush('disconnect');
    expect(report.active).toEqual([0]);
    expect(timer.events.map((event) => event.status)).toEqual([0x90, 0x92, 0x80, 0x82, 0xb0, 0xb2]);
    expect(timer.events.filter((event) => event.status === 0xb0).map((event) => event.data1)).toEqual([123]);
  });

  it('switch cuts audible notes but does not replay them after queued events are removed', () => {
    const timer = new TimerHarness();
    const output = new QueuedMidiOutput({
      send: timer.send,
      now: timer.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval
    });
    output.schedule(message(0, 100, [note(0, 0, 48, 100, 100)]));
    output.schedule(message(1, 200, [note(1, 0, 50, 200, 100)]));
    timer.advance(0);

    const report = output.flush('switch');
    expect(report.active).toEqual([0]);
    expect(report.canceled).toEqual([1]);
  });
});
