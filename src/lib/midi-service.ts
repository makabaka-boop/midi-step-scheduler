import { QueuedMidiOutput } from './midi-output';

export type MidiAvailability = 'unsupported' | 'unauthorized' | 'available';
export type MidiDeviceInfo = { id: string; name: string };

type MIDIPortType = 'input' | 'output';
type MIDIPortState = 'connected' | 'disconnected';

type MIDIPortLike = {
  id: string;
  name?: string | null;
  type: MIDIPortType;
  state: MIDIPortState;
};

type MIDIOutputLike = MIDIPortLike & {
  send(data: [number, number, number] | number[], timestamp?: number): void;
};

type PortStateEvent = {
  port: MIDIPortLike;
};

type MIDIAccessLike = {
  outputs: {
    values(): Iterable<MIDIOutputLike>;
  };
  onstatechange: ((event: PortStateEvent) => void) | null;
};

type NavigatorWithMidi = Navigator & {
  requestMIDIAccess?: (options?: { sysex: boolean }) => Promise<MIDIAccessLike>;
};

type MidiEventMap = {
  statechange: [];
  outputLost: [output: QueuedMidiOutput, device: MidiDeviceInfo];
  error: [error: Error];
};

type Listener<T extends unknown[]> = (...args: T) => void;

export class WebMidiService {
  private navigatorRef: NavigatorWithMidi;
  private access: MIDIAccessLike | null = null;
  private availabilityValue: MidiAvailability;
  private devicesValue: MidiDeviceInfo[] = [];
  private ports = new Map<string, MIDIOutputLike>();
  private adapters = new Map<string, QueuedMidiOutput>();
  private selectedIdValue = '';
  private pendingEnable: Promise<void> | null = null;
  private listeners: { [K in keyof MidiEventMap]: Set<Listener<MidiEventMap[K]>> } = {
    statechange: new Set(),
    outputLost: new Set(),
    error: new Set()
  };

  constructor(navigatorRef: NavigatorWithMidi = navigator as unknown as NavigatorWithMidi) {
    this.navigatorRef = navigatorRef;
    this.availabilityValue = typeof navigatorRef.requestMIDIAccess === 'function' ? 'unauthorized' : 'unsupported';
  }

  get availability(): MidiAvailability {
    return this.availabilityValue;
  }

  get devices(): MidiDeviceInfo[] {
    return this.devicesValue;
  }

  get selectedId(): string {
    return this.selectedIdValue;
  }

  on<K extends keyof MidiEventMap>(event: K, listener: Listener<MidiEventMap[K]>): () => void {
    const set = this.listeners[event] as Set<Listener<MidiEventMap[K]>>;
    set.add(listener);
    return () => set.delete(listener);
  }

  private emit<K extends keyof MidiEventMap>(event: K, ...args: MidiEventMap[K]): void {
    (this.listeners[event] as Set<(...args: MidiEventMap[K]) => void>).forEach((listener) => listener(...args));
  }

  /** Request permission. Concurrent clicks share one Web MIDI request. */
  enable(): Promise<void> {
    if (this.availabilityValue === 'available') return Promise.resolve();
    if (this.pendingEnable) return this.pendingEnable;

    if (typeof this.navigatorRef.requestMIDIAccess !== 'function') {
      this.availabilityValue = 'unsupported';
      return Promise.reject(new Error('Web MIDI is not supported by this browser.'));
    }

    this.pendingEnable = this.navigatorRef
      .requestMIDIAccess({ sysex: false })
      .then((access) => {
        this.access = access as unknown as MIDIAccessLike;
        this.availabilityValue = 'available';
        access.onstatechange = () => this.handleStateChange();
        this.refreshDevices();
        this.emit('statechange');
      })
      .catch((error: unknown) => {
        this.availabilityValue = 'unauthorized';
        this.access = null;
        const normalized = error instanceof Error ? error : new Error('MIDI permission was denied.');
        this.emit('error', normalized);
        throw normalized;
      })
      .finally(() => {
        this.pendingEnable = null;
      });

    return this.pendingEnable;
  }

  async select(id: string): Promise<QueuedMidiOutput | null> {
    if (!id) {
      this.selectedIdValue = '';
      this.emit('statechange');
      return null;
    }

    const port = this.ports.get(id);
    if (!port || port.state !== 'connected') {
      const error = new Error('The selected MIDI output is unavailable.');
      this.emit('error', error);
      throw error;
    }

    this.selectedIdValue = id;
    this.emit('statechange');
    return this.adapterFor(id, port);
  }

  private adapterFor(id: string, port: MIDIOutputLike): QueuedMidiOutput {
    let adapter = this.adapters.get(id);
    if (!adapter) {
      adapter = new QueuedMidiOutput({
        send: (status, data1, data2, timestamp) => port.send([status, data1, data2], timestamp)
      });
      this.adapters.set(id, adapter);
    }
    return adapter;
  }

  private handleStateChange(): void {
    const before = this.selectedIdValue;
    this.refreshDevices();

    const selectedPort = before ? this.ports.get(before) : undefined;
    if (before && (!selectedPort || selectedPort.state !== 'connected')) {
      const adapter = this.adapters.get(before);
      const device = this.devicesValue.find((item) => item.id === before) ?? { id: before, name: before };
      // The port object itself is gone. Its adapter reports disconnect and the
      // scheduler turns sound off and returns transport to a clean stopped state.
      adapter?.flush('disconnect');
      this.adapters.delete(before);
      this.selectedIdValue = '';
      if (adapter) this.emit('outputLost', adapter, device);
    }

    this.emit('statechange');
  }

  private refreshDevices(): void {
    this.ports.clear();
    const values = this.access?.outputs.values() ?? [];
    const devices: MidiDeviceInfo[] = [];

    for (const port of values) {
      if (port.type !== 'output' || port.state !== 'connected') continue;
      this.ports.set(port.id, port);
      devices.push({ id: port.id, name: port.name || port.id });
    }

    devices.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    this.devicesValue = devices;

    if (this.selectedIdValue && !this.ports.has(this.selectedIdValue)) {
      this.selectedIdValue = '';
    }
  }
}
