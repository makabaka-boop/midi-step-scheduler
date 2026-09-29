import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tick } from 'svelte';
import App from '../src/App.svelte';
import { FakeMidiService, FakeOutput, FakeScheduler, setRange } from './fakes';

function mountApp(options: ConstructorParameters<typeof FakeMidiService>[0] = {}) {
  FakeScheduler.instances = [];
  FakeMidiService.instances = [];
  const target = document.createElement('div');
  document.body.appendChild(target);

  const component = new App({
    target,
    props: {
      createScheduler: ((source: unknown) => new FakeScheduler(source as never)) as never,
      createMidiService: (() => new FakeMidiService(options)) as never
    }
  });

  return {
    target,
    component,
    scheduler: FakeScheduler.instances[0]!,
    midi: FakeMidiService.instances[0]!
  };
}

function button(target: HTMLElement, text: string): HTMLButtonElement {
  const match = [...target.querySelectorAll('button')].find((item) => item.textContent?.trim() === text);
  if (!match) throw new Error(`Missing button ${text}`);
  return match;
}

describe('stepper page', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does not pretend to play when Web MIDI is unavailable while retaining editable score', async () => {
    const { target, scheduler } = mountApp({ availability: 'unsupported', devices: [] });
    expect(target.textContent).toContain('Web MIDI unavailable');
    expect(button(target, 'Play').disabled).toBe(true);
    expect(button(target, 'Enable MIDI').disabled).toBe(true);

    const cell = target.querySelectorAll<HTMLButtonElement>('button.cell')[5]!;
    cell.click();
    await tick();
    expect(cell.classList.contains('on')).toBe(true);
    expect(scheduler.calls).not.toContain('play');
  });

  it('requires one explicit MIDI authorization click and sends selected output to scheduler', async () => {
    const { target, midi, scheduler } = mountApp({ availability: 'unauthorized' });
    button(target, 'Enable MIDI').click();
    await Promise.resolve();
    await tick();
    await tick();
    expect(midi.enableCalls).toBe(1);

    midi.availability = 'available';
    midi.emit('statechange');
    await tick();
    const select = target.querySelector('select')!;
    select.value = 'out';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
    await tick();

    expect(scheduler.output).toBeInstanceOf(FakeOutput);
    expect(midi.selectedId).toBe('out');
    expect(midi.availability).toBe('available');
    const play = button(target, 'Play');
    expect(play.disabled).toBe(false);
    play.click();
    await tick();
    expect(scheduler.calls).toContain('play');
  });

  it('collapses repeated transport clicks through disabled controls and calls pause/stop', async () => {
    const { target, scheduler } = mountApp();
    const select = target.querySelector('select')!;
    select.value = 'out';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
    await tick();

    const play = button(target, 'Play');
    await tick();
    play.click();
    await tick();
    expect(scheduler.calls.filter((call) => call === 'play')).toHaveLength(1);
    expect(play.disabled).toBe(true);

    button(target, 'Pause').click();
    await tick();
    expect(scheduler.calls).toContain('pause');
    button(target, 'Resume').click();
    await tick();
    button(target, 'Stop').click();
    await tick();
    expect(scheduler.calls).toContain('stop');
  });

  it('stops transport and clears the scheduler output on hot disconnect', async () => {
    const { target, midi, scheduler } = mountApp();
    const select = target.querySelector('select')!;
    select.value = 'out';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
    await tick();
    button(target, 'Play').click();
    await tick();

    midi.emit('outputLost', scheduler.output, { id: 'out', name: 'Fake Synth' });
    await tick();
    expect(scheduler.calls).toContain('outputLost');
    expect(target.textContent).toContain('Select a MIDI output');
    expect(button(target, 'Play').disabled).toBe(true);
  });

  it('edits pitch, velocity, gate and only changes dimensions while stopped', async () => {
    const { target } = mountApp({ devices: [] });
    const cells = () => target.querySelectorAll<HTMLButtonElement>('button.cell');
    cells()[0]!.click();
    await tick();

    const number = target.querySelector<HTMLInputElement>('.inspector input[type="number"]')!;
    number.value = '72';
    number.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(cells()[0]!.title).toContain('MIDI 72');

    const ranges = target.querySelectorAll<HTMLInputElement>('.inspector input[type="range"]');
    setRange(ranges[0]!, '64');
    setRange(ranges[1]!, '50');
    await tick();
    expect(target.textContent).toContain('Velocity (64)');
    expect(target.textContent).toContain('Gate (50%)');

    const trackRange = target.querySelectorAll<HTMLInputElement>('input[type="range"]')[0]!;
    expect(trackRange.disabled).toBe(false);
  });
});
