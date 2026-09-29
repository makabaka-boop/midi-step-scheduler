import type { Pattern } from '../src/lib/model';
import type { SchedulerState, StepMessage, StepperOutput } from '../src/lib/scheduler';
import type { MidiAvailability, MidiDeviceInfo } from '../src/lib/midi-service';

export class FakeScheduler {
  static instances: FakeScheduler[] = [];
  state: SchedulerState = 'stopped';
  bpm = 120;
  output: StepperOutput | null = null;
  calls: string[] = [];
  private listeners = new Set<(state: SchedulerState, step: number) => void>();

  constructor(public source: () => Pattern) {
    FakeScheduler.instances.push(this);
  }

  subscribe(listener: (state: SchedulerState, step: number) => void): () => void {
    this.listeners.add(listener);
    listener(this.state, 0);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setBpm(bpm: number): void {
    this.bpm = bpm;
  }

  play(): void {
    this.calls.push('play');
    this.state = 'playing';
    this.emit();
  }

  pause(): void {
    this.calls.push('pause');
    this.state = 'paused';
    this.emit();
  }

  stop(): void {
    this.calls.push('stop');
    this.state = 'stopped';
    this.emit();
  }

  setOutput(output: StepperOutput | null): void {
    this.calls.push('setOutput');
    this.output = output;
  }

  outputLost(output: StepperOutput): void {
    this.calls.push('outputLost');
    if (this.output === output) {
      this.output = null;
      this.state = 'stopped';
      this.emit();
    }
  }

  emit(state = this.state): void {
    this.listeners.forEach((listener) => listener(state, 0));
  }
}

export class FakeMidiService {
  static instances: FakeMidiService[] = [];
  availability: MidiAvailability;
  devices: MidiDeviceInfo[];
  selectedId = '';
  enableCalls = 0;
  revision = 0;
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  constructor(options: { availability?: MidiAvailability; devices?: MidiDeviceInfo[] } = {}) {
    this.availability = options.availability ?? 'available';
    this.devices = options.devices ?? [{ id: 'out', name: 'Fake Synth' }];
    FakeMidiService.instances.push(this);
  }

  on(event: string, listener: (...args: unknown[]) => void): () => void {
    (this.listeners[event] ??= []).push(listener);
    return () => {
      this.listeners[event] = this.listeners[event]?.filter((item) => item !== listener) ?? [];
    };
  }

  emit(event: string, ...args: unknown[]): void {
    if (event === 'outputLost') this.selectedId = '';
    this.revision += 1;
    this.listeners[event]?.forEach((listener) => listener(...args));
  }

  async enable(): Promise<void> {
    this.enableCalls += 1;
    this.availability = 'available';
    this.emit('statechange');
  }

  async select(id: string): Promise<FakeOutput | null> {
    if (!id) return null;
    if (!this.devices.some((device) => device.id === id)) throw new Error('The selected MIDI output is unavailable.');
    this.selectedId = id;
    this.emit('statechange');
    return new FakeOutput(id);
  }
}

export class FakeOutput implements StepperOutput {
  messages: StepMessage[] = [];
  constructor(public id: string) {}
  schedule(message: StepMessage): void {
    this.messages.push(message);
  }
  flush() {
    return { active: [], canceled: [] };
  }
}

export function setRange(input: Element, value: string): void {
  const target = input as HTMLInputElement;
  target.value = value;
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
}
