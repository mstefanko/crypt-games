import type { Patch, Score, Track } from "@onepage/project";
import type { PerformanceNote } from "../performance";

export const BAR_TICKS = 1920;
export const BAR_BPM = 120;
export interface WeatherObservation {
  id: string;
  front: "cold" | "warm" | "clear";
  intensity: number;
  precipitation: number;
  gustiness: number;
}
export interface TensionPlan {
  harmonic: number;
  activity: number;
  slope: "rise" | "release" | "hold";
  arrivalBar: number;
}
export interface ArrangementPlan {
  foreground: "melody";
  harmony: "held" | "pulse";
  drums: "sparse" | "active";
}
export interface BarCheckpoint {
  version: 1;
  bar: number;
  motif: number[];
  chord: number;
  voices: number[];
  lastMelody: number;
  recentChoices: number[];
  lastFront: WeatherObservation["front"];
  consumedObservations: string[];
  tails: PerformanceNote[];
  consecutiveFallbacks: number;
}
export interface BarPolicy {
  seed: number;
  topK?: number;
  /** Normal grammar budget; a tiny budget invokes the independent cheap fallback. */
  maxEvents?: number;
  forceFallback?: boolean;
}
export interface PlannedBar {
  bar: number;
  events: PerformanceNote[];
  checkpoint: BarCheckpoint;
  tension: TensionPlan;
  arrangement: ArrangementPlan;
  status: "planned" | "fallback" | "resync-required";
  trace: {
    observationId: string;
    choice: number;
    candidateCount: number;
    work: number;
    reason: string;
    heldFromPrevious: string[];
  };
}

export const BAR_TRACKS: Track[] = [
  {
    id: "melody",
    name: "Front theme",
    role: "melody",
    patchId: "weather-lead",
    gain: 0.3,
    pan: 0.1,
    minEnergy: 1,
  },
  {
    id: "bass",
    name: "Foundation",
    role: "bass",
    patchId: "weather-bass",
    gain: 0.35,
    pan: 0,
    minEnergy: 1,
  },
  {
    id: "harmony",
    name: "Connected voices",
    role: "harmony",
    patchId: "weather-harmony",
    gain: 0.16,
    pan: -0.2,
    minEnergy: 1,
  },
  {
    id: "drums",
    name: "Weather pulse",
    role: "drums",
    patchId: "weather-drums",
    gain: 0.12,
    pan: 0,
    minEnergy: 1,
  },
];
export const BAR_PATCHES: Patch[] = [
  {
    id: "weather-lead",
    name: "Soft triangle",
    waveform: "triangle",
    attack: 0.01,
    release: 0.12,
    brightness: 0.5,
    duty: 0.5,
  },
  {
    id: "weather-bass",
    name: "Sine bass",
    waveform: "sine",
    attack: 0.01,
    release: 0.1,
    brightness: 0.3,
    duty: 0.5,
  },
  {
    id: "weather-harmony",
    name: "Triangle support",
    waveform: "triangle",
    attack: 0.04,
    release: 0.2,
    brightness: 0.35,
    duty: 0.5,
  },
  {
    id: "weather-drums",
    name: "Dry noise",
    waveform: "noise",
    attack: 0.001,
    release: 0.035,
    brightness: 0.4,
    duty: 0.5,
  },
];
/** Empty original fixture; runtime bars supply the music, never a phrase catalog. */
export function createBarFixtureScore(): Score {
  return {
    schemaVersion: 1,
    id: "weather-bar-spike",
    title: "Live weather bar spike",
    ppq: 480,
    bpm: BAR_BPM,
    meter: [4, 4],
    scale: { root: 0, mode: "major" },
    playback: "one-shot",
    lengthTicks: BAR_TICKS * 16,
    loop: null,
    tracks: BAR_TRACKS.map((t) => ({ ...t })),
    patches: BAR_PATCHES.map((p) => ({ ...p })),
    patterns: [],
    clips: [],
    sections: [],
  };
}
function keyed(seed: number, bar: number, kind: number): number {
  let n =
    (seed ^
      Math.imul(bar + 1, 0x9e3779b1) ^
      Math.imul(kind + 1, 0x85ebca6b)) >>>
    0;
  n ^= n >>> 16;
  n = Math.imul(n, 0x7feb352d);
  n ^= n >>> 15;
  return (n ^ (n >>> 16)) >>> 0;
}
export function createBarCheckpoint(seed: number): BarCheckpoint {
  if (!Number.isSafeInteger(seed))
    throw new RangeError("Seed must be a safe integer");
  const variant = keyed(seed, 0, 0) % 2;
  return {
    version: 1,
    bar: 0,
    motif: variant ? [0, 2, 1, 4] : [0, 1, 3, 2],
    chord: 0,
    voices: [60, 64, 67],
    lastMelody: 72,
    recentChoices: [],
    lastFront: "clear",
    consumedObservations: [],
    tails: [],
    consecutiveFallbacks: 0,
  };
}
const CHORDS = [
  [0, 4, 7],
  [5, 9, 0],
  [7, 11, 2],
  [9, 0, 4],
];
const SCALE = [0, 2, 4, 5, 7, 9, 11];
function cloneState(s: BarCheckpoint): BarCheckpoint {
  return {
    ...s,
    motif: [...s.motif],
    voices: [...s.voices],
    recentChoices: [...s.recentChoices],
    consumedObservations: [...s.consumedObservations],
    tails: s.tails.map((n) => ({ ...n })),
  };
}
function validate(s: BarCheckpoint, w: WeatherObservation, p: BarPolicy): void {
  if (
    s.version !== 1 ||
    !Number.isSafeInteger(s.bar) ||
    s.bar < 0 ||
    s.bar > 5000 ||
    !Number.isSafeInteger(p.seed) ||
    !Number.isInteger(s.chord) ||
    !CHORDS[s.chord] ||
    s.motif.length !== 4 ||
    !s.motif.every((n) => Number.isInteger(n) && n >= 0 && n < 7) ||
    s.voices.length !== 3 ||
    !s.voices.every((n) => Number.isInteger(n) && n >= 48 && n <= 84) ||
    !Number.isInteger(s.lastMelody) ||
    !Number.isInteger(s.consecutiveFallbacks) ||
    s.consecutiveFallbacks < 0 ||
    s.tails.length > 3 ||
    s.recentChoices.length > 8 ||
    !s.recentChoices.every(
      (n) => Number.isInteger(n) && n >= 0 && n < CHORDS.length,
    ) ||
    s.consumedObservations.length > 8 ||
    !w.id ||
    w.id.length > 128 ||
    !["cold", "warm", "clear"].includes(w.front) ||
    ![w.intensity, w.precipitation, w.gustiness].every(
      (n) => Number.isFinite(n) && n >= 0 && n <= 1,
    ) ||
    (p.topK !== undefined &&
      (!Number.isInteger(p.topK) || p.topK < 1 || p.topK > 4)) ||
    (p.maxEvents !== undefined &&
      (!Number.isInteger(p.maxEvents) || p.maxEvents < 0 || p.maxEvents > 256))
  )
    throw new RangeError("Invalid bar checkpoint, observation or policy");
  for (const n of s.tails)
    if (
      n.trackId !== "harmony" ||
      !Number.isInteger(n.pitch) ||
      n.pitch < 0 ||
      n.pitch > 127 ||
      !CHORDS[s.chord]!.includes(n.pitch % 12) ||
      !Number.isSafeInteger(n.startTick) ||
      !Number.isSafeInteger(n.durationTicks) ||
      n.startTick >= s.bar * BAR_TICKS ||
      n.startTick + n.durationTicks <= s.bar * BAR_TICKS ||
      n.startTick + n.durationTicks > (s.bar + 1) * BAR_TICKS
    )
      throw new RangeError("Invalid carried note tail");
}
function voiced(chord: number, previous: number[]): number[] {
  const classes = CHORDS[chord]!;
  const choices: number[][] = [];
  for (let inversion = 0; inversion < 3; inversion++) {
    const pitches = classes
      .map((_, i) => classes[(i + inversion) % 3]! + 60)
      .sort((a, b) => a - b);
    for (let i = 0; i < inversion; i++) pitches[i]! += 12;
    choices.push(pitches.sort((a, b) => a - b));
  }
  return choices.sort(
    (a, b) =>
      a.reduce((sum, n, i) => sum + Math.abs(n - previous[i]!), 0) -
      b.reduce((sum, n, i) => sum + Math.abs(n - previous[i]!), 0),
  )[0]!;
}
/** One bounded musical decision. No clock, device, mutable global RNG or precomposed phrase. */
export function planBar(
  saved: BarCheckpoint,
  weather: WeatherObservation,
  policy: BarPolicy,
): PlannedBar {
  validate(saved, weather, policy);
  const s = cloneState(saved),
    start = s.bar * BAR_TICKS,
    end = start + BAR_TICKS;
  const arrival = s.bar % 8 === 7;
  const tension: TensionPlan = {
    harmonic:
      arrival || weather.front === "clear"
        ? 0
        : weather.front === "cold"
          ? 0.8
          : 0.35,
    activity: weather.intensity,
    slope:
      arrival || weather.front === "clear"
        ? "release"
        : weather.front === s.lastFront
          ? "hold"
          : "rise",
    arrivalBar: s.bar + (7 - (s.bar % 8)),
  };
  const arrangement: ArrangementPlan = {
    foreground: "melody",
    harmony: weather.front === "warm" ? "held" : "pulse",
    drums:
      weather.precipitation + weather.gustiness > 0.8 ? "active" : "sparse",
  };
  const held = s.tails.map((n) => n.id);
  const fallback =
    policy.forceFallback === true || (policy.maxEvents ?? 256) < 20;
  const status = fallback
    ? s.consecutiveFallbacks >= 2
      ? "resync-required"
      : "fallback"
    : "planned";
  const baseTrace = {
    observationId: weather.id,
    choice: -1,
    candidateCount: 0,
    work: 0,
    reason:
      status === "resync-required"
        ? "Two fallback bars exhausted; pause and resynchronize"
        : fallback
          ? "Restricted pedal/ostinato continuation"
          : "Seeded top-k under harmony, history and tail constraints",
    heldFromPrevious: held,
  };
  if (status === "resync-required")
    return {
      bar: s.bar,
      events: [],
      checkpoint: s,
      tension,
      arrangement,
      status,
      trace: baseTrace,
    };
  const candidates = (
    s.tails.length || fallback
      ? [s.chord]
      : arrival
        ? [0]
        : s.bar % 8 === 6
          ? [2]
          : [0, 1, 2, 3]
  )
    .map((chord) => ({
      chord,
      cost:
        (chord === s.chord ? 1 : 0) +
        s.recentChoices.filter((n) => n === chord).length * 0.4 +
        Math.abs(
          (chord === 2 ? 0.8 : chord === 0 ? 0 : 0.35) - tension.harmonic,
        ) *
          2,
    }))
    .sort((a, b) => a.cost - b.cost || a.chord - b.chord);
  const eligible = candidates.slice(0, policy.topK ?? 2);
  const chord = eligible[keyed(policy.seed, s.bar, 1) % eligible.length]!.chord;
  const voices = voiced(chord, s.voices);
  const events: PerformanceNote[] = [];
  function emit(
    trackId: string,
    offset: number,
    duration: number,
    pitch: number,
    optional = false,
  ): void {
    const track = BAR_TRACKS.find((t) => t.id === trackId)!;
    events.push({
      id: `weather:${s.bar}:${trackId}:${events.length}`,
      trackId,
      patchId: track.patchId,
      startTick: start + offset,
      durationTicks: duration,
      pitch,
      // Activity owns note dynamics in this spike; front identity owns motif/rhythm.
      velocity: (trackId === "drums" ? 0.3 : 0.5) + 0.3 * tension.activity,
      gain: track.gain,
      pan: track.pan,
      priority: trackId === "bass" ? 100 : trackId === "melody" ? 90 : 40,
      optional,
    });
  }
  // Continue after carried harmony ends, without retriggering its held onset.
  const harmonyStart = Math.max(
    0,
    ...s.tails
      .filter((n) => n.trackId === "harmony")
      .map((n) => n.startTick + n.durationTicks - start),
  );
  if (harmonyStart < BAR_TICKS - 60)
    for (const pitch of voices)
      emit(
        "harmony",
        harmonyStart,
        (!fallback && s.bar % 4 === 0 ? BAR_TICKS + 240 : BAR_TICKS - 60) -
          harmonyStart,
        pitch,
      );
  const bass = 36 + CHORDS[chord]![0]!;
  emit("bass", 0, 840, bass);
  emit("bass", 960, 840, bass);
  if (fallback) {
    emit("melody", 240, 240, voices[0]! + 12);
    emit("melody", 1200, 240, voices[0]! + 12);
  } else {
    const rhythm =
      weather.front === "cold"
        ? [0, 240, 720, 1200]
        : weather.front === "warm"
          ? [0, 720, 1200]
          : [0, 960];
    for (let i = 0; i < rhythm.length; i++) {
      const degree = s.motif[(i + (s.bar % 4)) % 4]!;
      const desired =
        72 + SCALE[weather.front === "cold" ? 6 - degree : degree]!;
      const pitch =
        i === 0 || arrival
          ? voices
              .map((n) => n + 12)
              .sort((a, b) => Math.abs(a - desired) - Math.abs(b - desired))[0]!
          : desired;
      emit("melody", rhythm[i]!, weather.front === "warm" ? 600 : 180, pitch);
      s.lastMelody = pitch;
    }
  }
  for (const offset of fallback || arrangement.drums === "sparse"
    ? [0, 960]
    : [0, 480, 960, 1440])
    emit("drums", offset, 90, 36, true);
  s.bar++;
  s.chord = chord;
  s.voices = voices;
  s.lastFront = weather.front;
  s.recentChoices = [...s.recentChoices, chord].slice(-8);
  s.consumedObservations = [
    ...s.consumedObservations.filter((id) => id !== weather.id),
    weather.id,
  ].slice(-8);
  s.tails = [...s.tails, ...events]
    .filter((n) => n.startTick + n.durationTicks > end)
    .map((n) => ({ ...n }));
  s.consecutiveFallbacks = fallback ? s.consecutiveFallbacks + 1 : 0;
  return {
    bar: saved.bar,
    events,
    checkpoint: s,
    tension,
    arrangement,
    status,
    trace: {
      ...baseTrace,
      choice: chord,
      candidateCount: candidates.length,
      work: candidates.length * 3 + events.length,
    },
  };
}

export interface PreparedBars {
  checkpoint: BarCheckpoint;
  bars: PlannedBar[];
}
export function prepareTwoBars(
  checkpoint: BarCheckpoint,
  observations: readonly WeatherObservation[],
  policy: BarPolicy,
): PreparedBars {
  if (observations.length > 2)
    throw new RangeError("At most two prepared bars");
  let next = checkpoint;
  const bars: PlannedBar[] = [];
  for (const observation of observations) {
    const bar = planBar(next, observation, policy);
    bars.push(bar);
    next = bar.checkpoint;
    if (bar.status === "resync-required") break;
  }
  return { checkpoint: cloneState(checkpoint), bars };
}
/** Caller supplies the first whole bar with no audio-committed onsets. Prefix/tails remain untouched. */
export function revisePreparedBars(
  prepared: PreparedBars,
  firstUncommittedBar: number,
  observations: readonly WeatherObservation[],
  policy: BarPolicy,
): PreparedBars {
  const offset = firstUncommittedBar - prepared.checkpoint.bar;
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > prepared.bars.length ||
    offset + observations.length > 2
  )
    throw new RangeError("Revision outside the two-bar prepared horizon");
  const prefix = prepared.bars.slice(0, offset);
  const checkpoint = prefix.at(-1)?.checkpoint ?? prepared.checkpoint;
  const replacement = prepareTwoBars(checkpoint, observations, policy);
  return {
    checkpoint: cloneState(prepared.checkpoint),
    bars: [...prefix, ...replacement.bars],
  };
}
