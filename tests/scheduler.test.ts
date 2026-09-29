import { describe, expect, it, vi } from 'vitest';
import { LookaheadScheduler, ManualClock } from '../src/lib/scheduler';
import type { StepMessage } from '../src/lib/scheduler';
import { makePattern, updateStep } from '../src/lib/model';
import type { Pattern } from '../src/lib/model';
import { CollectingOutput } from './helpers';

function enabledPattern(): Pattern {
  let pattern = makePattern(2, 4);
  pattern = updateStep(pattern, 0, 0, { enabled: true, pitch: 48, velocity: 100, gate: 0.5 });
  pattern = updateStep(pattern, 1, 1, { enabled: true, pitch: 60, velocity: 80, gate: 0.25 });
  return pattern;
}

function setup() {
  const clock = new ManualClock(1000);
  const output = new CollectingOutput();
  const pattern = enabledPattern();
  const scheduler = new LookaheadScheduler(() => pattern, {
    clock,
    output,
    bpm: 120,
    lookaheadMs: 150,
    intervalMs: 25,
    startDelayMs: 0
  });
  return { clock, output, pattern, scheduler };
}

describe('LookaheadScheduler', () => {
  it('schedules notes on an absolute sixteenth-note grid using periodic lookahead', () => {
    const { clock, output, scheduler } = setup();

    scheduler.play();
    // First immediate wakeup schedules the 120 BPM steps at 0 and 125ms.
    expect(output.messages.map((message) => message.step)).toEqual([0, 1]);
    expect(output.messages[0]!.notes).toEqual([
      expect.objectContaining({
        track: 0,
        channel: 0,
        pitch: 48,
        velocity: 100,
        start: 1000,
        duration: 62.5
      })
    ]);
    expect(output.messages[1]!.notes).toEqual([
      expect.objectContaining({ track: 1, channel: 1, pitch: 60, velocity: 80, duration: 31.25 })
    ]);

    output.messages.length = 0;
    clock.advance(25);
    expect(output.messages).toHaveLength(0);
    clock.advance(125);
    // The wakeup at 1150 extends the plan, but already scheduled step 1 is not repeated.
    expect(output.messages.map((message) => message.step)).toEqual([2]);
  });

  it('ignores repeated play clicks and wraps at the pattern length', () => {
    const { clock, output, scheduler } = setup();

    scheduler.play();
    scheduler.play();
    expect(output.messages).toHaveLength(2);

    clock.advance(350);
    expect(output.messages.map((message) => message.step)).toEqual([0, 1, 2, 3, 4]);
    expect(output.messages[4]!.step).toBe(4);
    expect(output.messages[4]!.notes[0]!.track).toBe(0);
  });

  it('applies tempo and score edits only to steps not yet handed to the output', () => {
    const { clock, output, scheduler, pattern } = setup();
    scheduler.play();
    const originalStepOne = output.messages[1]!.time;

    let changed = updateStep(pattern, 1, 1, { enabled: false });
    Object.assign(pattern, changed);
    scheduler.setBpm(240);
    output.messages.length = 0;
    clock.advance(130);

    expect(originalStepOne).toBe(1125);
    expect(output.messages[0]!.step).toBe(2);
    expect(output.messages[0]!.time).toBeCloseTo(1187.5, 5);
    expect(output.messages.find((message) => message.step === 3)!.notes).toEqual([]);
  });

  it('pauses from the next unsent boundary and resume does not replay a note', () => {
    const { clock, output, scheduler } = setup();
    scheduler.play();

    clock.advance(130);
    output.nextReport = { active: [1], canceled: [2] };
    scheduler.pause();
    expect(output.flushed).toContain('pause');

    const resumeEvents: StepMessage[] = [];
    output.schedule = vi.fn((message: StepMessage) => resumeEvents.push(message));
    scheduler.play();
    expect(resumeEvents.map((message) => message.step)).toEqual([2, 3]);
    expect(resumeEvents[0]!.time).toBeGreaterThanOrEqual(clock.now());
  });

  it('stops flushes active sound, clears pending music, and resets to step zero', () => {
    const { clock, output, scheduler } = setup();
    const states: Array<[string, number]> = [];
    scheduler.subscribe((state, step) => states.push([state, step]));

    scheduler.play();
    clock.advance(130);
    scheduler.stop();
    scheduler.stop();

    expect(output.flushed).toEqual(['stop']);
    scheduler.play();
    expect(output.messages[0]!.step).toBe(0);
    expect(states).toContainEqual(['stopped', 0]);
  });

  it('hot-swapping an output rewinds queued steps but skips notes already audible', () => {
    const { clock } = setup();
    const oldOutput = new CollectingOutput();
    const newOutput = new CollectingOutput();
    const pattern = enabledPattern();
    const custom = new LookaheadScheduler(() => pattern, {
      clock,
      output: oldOutput,
      bpm: 120,
      lookaheadMs: 150,
      startDelayMs: 0
    });

    custom.play();
    clock.advance(130);
    oldOutput.nextReport = { active: [1], canceled: [2] };
    custom.setOutput(newOutput);

    expect(oldOutput.flushed).toEqual(['switch']);
    expect(newOutput.messages.map((message) => message.step)).toEqual([2]);
    expect(newOutput.messages.every((message) => message.step !== 1)).toBe(true);
    clock.advance(100);
    expect(newOutput.messages.map((message) => message.step)).toEqual([2, 3]);
  });

  it('handles output loss by silencing it, stopping pending scheduling, and allowing restart elsewhere', () => {
    const { clock, output, scheduler } = setup();
    scheduler.play();
    clock.advance(130);

    scheduler.outputLost(output);
    expect(output.flushed).toEqual(['disconnect']);
    expect(scheduler.state).toBe('stopped');

    const replacement = new CollectingOutput();
    scheduler.setOutput(replacement);
    scheduler.play();
    expect(replacement.messages[0]!.step).toBe(0);
  });

  it('does not emit a burst of stale music when a callback is very late', () => {
    const { clock, output, scheduler } = setup();
    scheduler.play();
    output.messages.length = 0;

    clock.set(3000);
    scheduler.tick();
    const immediateOldNotes = output.messages.filter((message) => message.notes.length > 0 && message.time < clock.now() - 12);
    expect(immediateOldNotes).toEqual([]);
  });
});
