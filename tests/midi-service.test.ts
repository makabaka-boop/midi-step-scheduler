import { describe, expect, it, vi } from 'vitest';
import { WebMidiService } from '../src/lib/midi-service';
import { QueuedMidiOutput } from '../src/lib/midi-output';

type StateHandler = (event: { port: { id: string; type: string; state: string } }) => void;

function makeAccess(outputs: Array<{ id: string; name: string; state?: string }>) {
  let stateHandler: StateHandler | null = null;
  const ports = outputs.map((item) => ({
    id: item.id,
    name: item.name,
    type: 'output' as const,
    state: item.state ?? ('connected' as const),
    send: vi.fn()
  }));

  const access = {
    outputs: {
      values: () => ports[Symbol.iterator]()
    },
    set onstatechange(handler: StateHandler) {
      stateHandler = handler;
    },
    trigger() {
      stateHandler?.({ port: { id: ports[0]?.id ?? '', type: 'output', state: 'disconnected' } });
    },
    disconnect(id: string) {
      const port = ports.find((item) => item.id === id);
      if (port) port.state = 'disconnected';
      stateHandler?.({ port: { id, type: 'output', state: 'disconnected' } });
    },
    ports
  };

  return access;
}

describe('WebMidiService', () => {
  it('remains editable but reports unsupported when Web MIDI is absent', async () => {
    const service = new WebMidiService({} as never);
    expect(service.availability).toBe('unsupported');
    await expect(service.enable()).rejects.toThrow('not supported');
    expect(service.devices).toEqual([]);
  });

  it('requests authorization once for repeated clicks and lists connected outputs', async () => {
    const access = makeAccess([
      { id: 'b', name: 'Synth B' },
      { id: 'a', name: 'Synth A' }
    ]);
    const request = vi.fn(async () => access);
    const service = new WebMidiService({ requestMIDIAccess: request } as never);

    await Promise.all([service.enable(), service.enable(), service.enable()]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(service.availability).toBe('available');
    expect(service.devices.map((device) => device.id)).toEqual(['a', 'b']);
  });

  it('records authorization failure without exposing a playback path', async () => {
    const service = new WebMidiService({
      requestMIDIAccess: vi.fn(() => Promise.reject(new DOMException('denied', 'SecurityError')))
    } as never);
    const errors: Error[] = [];
    service.on('error', (error) => errors.push(error));

    await expect(service.enable()).rejects.toThrow('denied');
    expect(service.availability).toBe('unauthorized');
    expect(errors).toHaveLength(1);
    await expect(service.select('missing')).rejects.toThrow('unavailable');
  });

  it('hot-plugs a newly connected output', async () => {
    const access = makeAccess([{ id: 'a', name: 'A' }]);
    const service = new WebMidiService({ requestMIDIAccess: vi.fn(async () => access) } as never);
    await service.enable();

    access.ports.push({ id: 'c', name: 'C', type: 'output', state: 'connected', send: vi.fn() });
    access.trigger();
    expect(service.devices.map((device) => device.id)).toEqual(['a', 'c']);
  });

  it('notifies on selected device disconnect and refuses stale output selection', async () => {
    const access = makeAccess([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' }
    ]);
    const service = new WebMidiService({ requestMIDIAccess: vi.fn(async () => access) } as never);
    await service.enable();
    const adapter = await service.select('a');
    expect(adapter).toBeInstanceOf(QueuedMidiOutput);

    const lost: QueuedMidiOutput[] = [];
    service.on('outputLost', (output) => lost.push(output));
    access.disconnect('a');
    expect(lost).toEqual([adapter]);
    expect(service.selectedId).toBe('');
    await expect(service.select('a')).rejects.toThrow('unavailable');
  });
});
