export type Step = {
  /** MIDI note number, 0-127. */
  pitch: number;
  /** MIDI velocity, 1-127. */
  velocity: number;
  /** Gate length as a fraction of one sixteenth-note step, in the range (0, 1]. */
  gate: number;
  /** When false the step still advances, but sends no note. */
  enabled: boolean;
};

export type Track = {
  name: string;
  steps: Step[];
};

export type Pattern = {
  tracks: Track[];
  /** Global pattern length in sixteenth notes. */
  length: number;
};

export const MIN_TRACKS = 1;
export const MAX_TRACKS = 8;
export const MIN_STEPS = 1;
export const MAX_STEPS = 64;
export const MIN_BPM = 40;
export const MAX_BPM = 240;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function makeStep(pitch = 60, velocity = 96, gate = 0.8, enabled = false): Step {
  return { pitch, velocity, gate, enabled };
}

export function makeTrack(name: string, length: number, pitches: number[] = []): Track {
  const steps = Array.from({ length }, (_, index) => makeStep(pitches[index] ?? 60, 96, 0.8, index in pitches));
  return { name, steps };
}

export function makePattern(trackCount = 4, length = 16): Pattern {
  const count = clamp(Math.round(trackCount), MIN_TRACKS, MAX_TRACKS);
  const steps = clamp(Math.round(length), MIN_STEPS, MAX_STEPS);
  return {
    length: steps,
    tracks: Array.from({ length: count }, (_, index) => makeTrack(`Track ${index + 1}`, steps))
  };
}

export function withTrackCount(pattern: Pattern, count: number): Pattern {
  const nextCount = clamp(Math.round(count), MIN_TRACKS, MAX_TRACKS);
  const tracks = [...pattern.tracks];
  tracks.length = Math.min(tracks.length, nextCount);
  while (tracks.length < nextCount) {
    tracks.push(makeTrack(`Track ${tracks.length + 1}`, pattern.length));
  }
  return { ...pattern, tracks };
}

export function withStepCount(pattern: Pattern, count: number): Pattern {
  const length = clamp(Math.round(count), MIN_STEPS, MAX_STEPS);
  return {
    ...pattern,
    length,
    tracks: pattern.tracks.map((track) => ({
      ...track,
      steps: Array.from({ length }, (_, index) => track.steps[index] ?? makeStep())
    }))
  };
}

export function updateStep(pattern: Pattern, trackIndex: number, stepIndex: number, patch: Partial<Step>): Pattern {
  return {
    ...pattern,
    tracks: pattern.tracks.map((track, ti) => {
      if (ti !== trackIndex) return track;
      return {
        ...track,
        steps: track.steps.map((step, si) => (si === stepIndex ? { ...step, ...patch } : step))
      };
    })
  };
}
