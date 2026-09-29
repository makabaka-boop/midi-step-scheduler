<script lang="ts">
  import { onMount } from 'svelte';
  import {
    MAX_BPM,
    MAX_STEPS,
    MAX_TRACKS,
    MIN_BPM,
    MIN_STEPS,
    MIN_TRACKS,
    updateStep,
    withStepCount,
    withTrackCount
  } from './lib/model';
  import type { Pattern, Step } from './lib/model';
  import { LookaheadScheduler } from './lib/scheduler';
  import type { SchedulerState, StepperOutput } from './lib/scheduler';
  import { WebMidiService } from './lib/midi-service';

  type SchedulerFactory = (source: () => Pattern) => LookaheadScheduler;
  type MidiServiceFactory = () => WebMidiService;

  export let createScheduler: SchedulerFactory = (source) => new LookaheadScheduler(source);
  export let createMidiService: MidiServiceFactory = () => new WebMidiService();

  let pattern: Pattern = {
    length: 16,
    tracks: [
      {
        name: 'Track 1',
        steps: Array.from({ length: 16 }, (_, step) => ({
          pitch: step % 4 === 0 ? 48 : 60,
          velocity: 96,
          gate: 0.8,
          enabled: step % 4 === 0
        }))
      },
      {
        name: 'Track 2',
        steps: Array.from({ length: 16 }, (_, step) => ({
          pitch: 67,
          velocity: 80,
          gate: 0.6,
          enabled: step === 6 || step === 14
        }))
      },
      {
        name: 'Track 3',
        steps: Array.from({ length: 16 }, () => ({ pitch: 60, velocity: 90, gate: 0.75, enabled: false }))
      },
      {
        name: 'Track 4',
        steps: Array.from({ length: 16 }, () => ({ pitch: 72, velocity: 88, gate: 0.5, enabled: false }))
      }
    ]
  };

  let bpm = 120;
  let trackCount = pattern.tracks.length;
  let stepCount = pattern.length;
  let selectedTrack = 0;
  let selectedStep = 0;
  let transport: SchedulerState = 'stopped';
  let currentStep = 0;
  let midi = createMidiService();
  let scheduler = createScheduler(patternSource);
  let midiError = '';
  let requesting = false;
  let midiVersion = 0;
  let canPlay = false;

  function touchMidiState(): void {
    midiVersion += 1;
  }

  function patternSource(): Pattern {
    return pattern;
  }

  scheduler.setBpm(bpm);
  const unsubscribe = scheduler.subscribe((state, step) => {
    transport = state;
    currentStep = step;
  });
  midi.on('statechange', () => {
    midiError = '';
    touchMidiState();
  });
  midi.on('error', (error) => {
    midiError = error.message;
    requesting = false;
  });
  midi.on('outputLost', (adapter) => {
    scheduler.outputLost(adapter);
    touchMidiState();
  });

  onMount(() => unsubscribe);

  $: selectedStepData = pattern.tracks[selectedTrack]?.steps[selectedStep] as Step | undefined;
  $: canEditStructure = transport === 'stopped';
  $: canPlay = midiVersion >= 0 && midi.availability === 'available' && Boolean(midi.selectedId);
  $: statusText =
    transport === 'playing'
      ? `Playing step ${currentStep + 1}`
      : transport === 'paused'
        ? `Paused at step ${currentStep + 1}`
        : midi.availability === 'unsupported'
          ? 'Web MIDI unavailable: score remains editable'
          : midi.availability === 'unauthorized'
            ? 'Authorize MIDI output to play'
            : midi.selectedId
              ? 'Ready'
              : 'Select a MIDI output to play';

  async function requestMidi(): Promise<void> {
    if (requesting || midi.availability === 'available') return;
    requesting = true;
    try {
      await midi.enable();
    } catch {
      // The service event records the human-readable reason.
    } finally {
      requesting = false;
    }
  }

  async function chooseOutput(event: Event): Promise<void> {
    const id = (event.currentTarget as HTMLSelectElement).value;
    const adapter = await midi.select(id);
    scheduler.setOutput(adapter as StepperOutput | null);
    touchMidiState();
  }

  function transportPlay(): void {
    if (!canPlay) return;
    scheduler.play();
  }

  function toggleStep(track: number, step: number): void {
    selectedTrack = track;
    selectedStep = step;
    const current = pattern.tracks[track].steps[step];
    pattern = updateStep(pattern, track, step, { enabled: !current.enabled });
  }

  function patchSelected(patch: Partial<Step>): void {
    pattern = updateStep(pattern, selectedTrack, selectedStep, patch);
  }

  function changeTrackCount(event: Event): void {
    if (!canEditStructure) return;
    trackCount = Number((event.currentTarget as HTMLInputElement).value);
    pattern = withTrackCount(pattern, trackCount);
    selectedTrack = Math.min(selectedTrack, trackCount - 1);
  }

  function changeStepCount(event: Event): void {
    if (!canEditStructure) return;
    stepCount = Number((event.currentTarget as HTMLInputElement).value);
    pattern = withStepCount(pattern, stepCount);
    selectedStep = Math.min(selectedStep, stepCount - 1);
  }

  function changeBpm(event: Event): void {
    bpm = Number((event.currentTarget as HTMLInputElement).value);
    scheduler?.setBpm(bpm);
  }

  function selectTrack(track: number): void {
    selectedTrack = track;
  }

  function clampNumber(event: Event, min: number, max: number): number {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    return Math.min(max, Math.max(min, value));
  }
</script>

<main class="app">
  <header>
    <div>
      <h1>Local MIDI Stepper</h1>
      <p>8 tracks · up to 64 sixteenth steps · lookahead scheduling</p>
    </div>
    <span class="status" data-state={transport}>{statusText}</span>
  </header>

  <section class="panel controls" aria-label="Transport and MIDI">
    <div class="group">
      <button class="primary" on:click={transportPlay} disabled={!canPlay || transport === 'playing'}>
        {transport === 'paused' ? 'Resume' : 'Play'}
      </button>
      <button on:click={() => scheduler?.pause()} disabled={transport !== 'playing'}>Pause</button>
      <button on:click={() => scheduler?.stop()} disabled={transport === 'stopped'}>Stop</button>
    </div>

    <label>
      BPM
      <input type="number" min={MIN_BPM} max={MAX_BPM} value={bpm} on:change={changeBpm} />
    </label>

    <div class="group midi">
      {#if midi.availability !== 'available'}
        <button on:click={requestMidi} disabled={requesting || midi.availability === 'unsupported'}>
          {requesting ? 'Requesting…' : 'Enable MIDI'}
        </button>
      {/if}
      <label class="output">
        Output
        <select on:change={chooseOutput} disabled={midi.availability !== 'available'}>
          <option value="">No output</option>
          {#each midi.devices as device (device.id)}
            <option value={device.id} selected={device.id === midi.selectedId}>{device.name}</option>
          {/each}
        </select>
      </label>
    </div>
  </section>

  {#if midiError}
    <p class="warning" role="alert">{midiError}. The score can still be edited.</p>
  {/if}

  <section class="panel dimensions" aria-label="Pattern dimensions">
    <label>
      Tracks
      <input type="range" min={MIN_TRACKS} max={MAX_TRACKS} step="1" value={trackCount} on:input={changeTrackCount} disabled={!canEditStructure} />
      <strong>{trackCount}</strong>
    </label>
    <label>
      Steps
      <input type="range" min={MIN_STEPS} max={MAX_STEPS} step="1" value={stepCount} on:input={changeStepCount} disabled={!canEditStructure} />
      <strong>{stepCount}</strong>
    </label>
    <p>Dimensions can be changed while stopped; note edits never alter already queued MIDI.</p>
  </section>

  <section class="panel editor" aria-label="Step grid">
    <div class="track-head">
      <span></span>
      {#each Array(stepCount) as _, step (step)}
        <span class="step-number" data-beat={step % 4 === 0}>{step + 1}</span>
      {/each}
    </div>
    {#each pattern.tracks as track, trackIndex (trackIndex)}
      <div class="track-row" class:current-row={selectedTrack === trackIndex}>
        <div class="track-meta">
          <button class="track-name" on:click={() => selectTrack(trackIndex)}>{track.name}</button>
        </div>
        <div class="steps">
          {#each track.steps as step, stepIndex (stepIndex)}
            <button
              class="cell"
              class:on={step.enabled}
              class:beat={stepIndex % 4 === 0}
              class:playing={transport === 'playing' && stepIndex === currentStep}
              class:selected={selectedTrack === trackIndex && selectedStep === stepIndex}
              title={`${track.name} step ${stepIndex + 1}: MIDI ${step.pitch}`}
              on:click={() => toggleStep(trackIndex, stepIndex)}
            ></button>
          {/each}
        </div>
      </div>
    {/each}
  </section>

  {#if selectedStepData}
    <section class="panel inspector" aria-label="Selected step">
      <h2>{pattern.tracks[selectedTrack].name} · Step {selectedStep + 1}</h2>
      <label>
        Pitch (0–127)
        <input
          type="number"
          min="0"
          max="127"
          value={selectedStepData.pitch}
          on:change={(event) => patchSelected({ pitch: clampNumber(event, 0, 127) })}
        />
      </label>
      <label>
        Velocity ({selectedStepData.velocity})
        <input
          type="range"
          min="1"
          max="127"
          value={selectedStepData.velocity}
          on:input={(event) => patchSelected({ velocity: clampNumber(event, 1, 127) })}
        />
      </label>
      <label>
        Gate ({Math.round(selectedStepData.gate * 100)}%)
        <input
          type="range"
          min="1"
          max="100"
          value={Math.round(selectedStepData.gate * 100)}
          on:input={(event) => patchSelected({ gate: clampNumber(event, 1, 100) / 100 })}
        />
      </label>
    </section>
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    background: #10141c;
    color: #e9eef8;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .app {
    width: min(1440px, calc(100vw - 32px));
    margin: 0 auto;
    padding: 24px 0 48px;
  }

  header,
  .controls,
  .dimensions,
  .inspector {
    display: flex;
    align-items: center;
    gap: 20px;
    flex-wrap: wrap;
  }

  header {
    justify-content: space-between;
    margin-bottom: 20px;
  }

  h1,
  h2,
  p {
    margin: 0;
  }

  h1 {
    font-size: 30px;
  }

  header p {
    color: #9aa8bd;
    margin-top: 4px;
  }

  .panel {
    background: #181e2a;
    border: 1px solid #2a3344;
    border-radius: 14px;
    padding: 16px;
    margin-bottom: 16px;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.24);
  }

  .group {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  button,
  select,
  input {
    font: inherit;
  }

  button {
    border: 1px solid #3a465c;
    border-radius: 9px;
    background: #222c3d;
    color: #e9eef8;
    padding: 9px 14px;
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    background: #2b374b;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  button.primary {
    background: #2f81f7;
    border-color: #2f81f7;
    font-weight: 700;
  }

  label {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #c3cede;
  }

  input[type='number'],
  select {
    color: #e9eef8;
    background: #101722;
    border: 1px solid #3a465c;
    border-radius: 8px;
    padding: 8px;
    width: 96px;
  }

  select {
    width: 220px;
  }

  .status {
    border-radius: 999px;
    background: #243044;
    padding: 8px 14px;
    color: #b9c7dc;
  }

  .status[data-state='playing'] {
    background: #123e2f;
    color: #72e7b1;
  }

  .status[data-state='paused'] {
    background: #4a3811;
    color: #ffd27a;
  }

  .warning {
    background: #4a1f24;
    border: 1px solid #7d323b;
    color: #ffc1c7;
    border-radius: 10px;
    padding: 12px 14px;
    margin-bottom: 16px;
  }

  .dimensions p {
    color: #8494ab;
    font-size: 13px;
  }

  .editor {
    overflow-x: auto;
  }

  .track-head,
  .track-row {
    display: grid;
    grid-template-columns: 104px repeat(64, minmax(22px, 1fr));
    gap: 4px;
    min-width: 1100px;
  }

  .track-head {
    margin-bottom: 6px;
  }

  .track-row {
    margin-bottom: 6px;
  }

  .step-number {
    text-align: center;
    color: #58687f;
    font-size: 10px;
  }

  .step-number[data-beat='true'] {
    color: #b9c7dc;
  }

  .track-name {
    padding: 5px;
    font-size: 12px;
    text-align: left;
  }

  .current-row .track-name {
    border-color: #55a5ff;
  }

  .steps {
    grid-column: 2 / -1;
    display: grid;
    grid-template-columns: repeat(64, minmax(22px, 1fr));
    gap: 4px;
  }

  .cell {
    height: 34px;
    padding: 0;
    border-radius: 7px;
    background: #111827;
  }

  .cell.beat {
    border-color: #505d75;
  }

  .cell.on {
    background: #2f81f7;
    border-color: #79b3ff;
  }

  .cell.playing {
    outline: 2px solid #ffd166;
    outline-offset: 1px;
  }

  .cell.selected {
    box-shadow: inset 0 0 0 2px #ffffff;
  }

  .inspector label {
    flex: 1 1 220px;
  }

  .inspector input[type='range'] {
    flex: 1;
  }

  @media (max-width: 720px) {
    .midi {
      align-items: stretch;
      flex-direction: column;
    }
  }
</style>
