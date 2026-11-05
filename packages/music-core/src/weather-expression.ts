import type { PerformanceNote } from "./performance";
import type {
  ComposerWeatherObservation,
  WeatherComposerPolicy,
} from "./weather-composer";
import {
  composeWeatherBar,
  createWeatherComposerCheckpoint,
} from "./weather-composer";
import {
  WEATHER_SONG_V2_TRACKS,
  WEATHER_SONG_V2_PATCHES,
} from "./orchestration";
import { WEATHER_SONG_V2_INSTRUMENT_PALETTE } from "./instrument-palette";
import { weatherMusicalIntent } from "./weather-intent";
import type {
  ExpressiveControlEvent,
  PerformanceDocumentV1,
} from "./expressive-performance";

/** Additive performance policy; the song-2 note generator and its RNG remain untouched. */
export const WEATHER_EXPRESSIVE_VERSION = "weather-song-3";
export const WEATHER_EXPRESSION_PROFILE = "weather-synth-expression-v1";
export interface WeatherExpressionPolicy {
  enabled: boolean;
  amount: number;
  profile: typeof WEATHER_EXPRESSION_PROFILE;
  pitchGestures: boolean;
}
export const DEFAULT_WEATHER_EXPRESSION: Readonly<WeatherExpressionPolicy> =
  Object.freeze({
    enabled: true,
    amount: 0.55,
    profile: WEATHER_EXPRESSION_PROFILE,
    pitchGestures: true,
  });
export interface WeatherExpressionCheckpoint {
  version: typeof WEATHER_EXPRESSIVE_VERSION;
  /** Independent from the composer's note-generation state. */
  seed: number;
  lastObservationId: string | null;
  lastGestureBar: number;
  targets: Record<string, number>;
}
export function createWeatherExpressionCheckpoint(
  seed: number,
): WeatherExpressionCheckpoint {
  return {
    version: WEATHER_EXPRESSIVE_VERSION,
    seed: (seed ^ 0x65787072) >>> 0,
    lastObservationId: null,
    lastGestureBar: -2,
    targets: {},
  };
}
function choice(seed: number, bar: number) {
  let x = Math.imul(seed ^ bar, 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
}
export function validateWeatherExpressionPolicy(
  policy: WeatherExpressionPolicy,
): void {
  if (
    !policy ||
    typeof policy.enabled !== "boolean" ||
    typeof policy.pitchGestures !== "boolean" ||
    policy.profile !== WEATHER_EXPRESSION_PROFILE ||
    !Number.isFinite(policy.amount) ||
    policy.amount < 0 ||
    policy.amount > 1
  )
    throw Error("Invalid weather expression policy");
}
/** Convert an onset-owned song bar to semantic controls. Call after replacement note IDs
 * have been assigned, so every per-note control references the admitted note identity.
 * Gains are linear amplitude, with no MIDI controller curve applied to generated intent. */
export function expressWeatherNotes(
  notes: readonly PerformanceNote[],
  observation: ComposerWeatherObservation,
  bar: number,
  saved: WeatherExpressionCheckpoint,
  policy: WeatherExpressionPolicy = DEFAULT_WEATHER_EXPRESSION,
): {
  controls: ExpressiveControlEvent[];
  checkpoint: WeatherExpressionCheckpoint;
  gesture: string;
} {
  validateWeatherExpressionPolicy(policy);
  if (saved.version !== WEATHER_EXPRESSIVE_VERSION)
    throw Error("Unsupported weather expression checkpoint");
  const checkpoint = structuredClone(saved);
  checkpoint.lastObservationId = observation.id;
  const controls: ExpressiveControlEvent[] = [];
  if (!policy.enabled || policy.amount === 0)
    return {
      controls,
      checkpoint,
      gesture: "Expression bypassed; same composed notes",
    };
  const intent = weatherMusicalIntent(observation);
  const amount = policy.amount;
  const eligible = notes.filter((n) => {
    const role = WEATHER_SONG_V2_TRACKS.find((t) => t.id === n.trackId)?.role;
    return (role === "melody" || role === "harmony") && n.durationTicks >= 360;
  });
  const add = (
    n: PerformanceNote,
    parameter: ExpressiveControlEvent["parameter"],
    timeSeconds: number,
    value: number,
    rampSeconds = 0,
    suffix = "",
  ) => {
    controls.push({
      id: `${n.id}:expr:${parameter}:${suffix}`,
      partId: n.trackId,
      noteId: n.id,
      parameter,
      timeSeconds,
      value,
      rampSeconds,
    });
  };
  // Phrase-shaped envelopes, anchored to note lifetime, cannot pump at sensor rate.
  for (const n of eligible) {
    const start = n.startTick / 960,
      duration = n.durationTicks / 960;
    const entrance = 1 - amount * (intent.reason === "fog" ? 0.3 : 0.22);
    const peak = Math.min(1, entrance + amount * (0.16 + intent.tension * 0.1));
    add(n, "expression", start, entrance, 0, "entrance");
    add(
      n,
      "expression",
      start + duration * 0.16,
      peak,
      duration * 0.49,
      "swell",
    );
    add(
      n,
      "expression",
      start + duration * 0.68,
      1 - amount * 0.2,
      duration * 0.3,
      "release",
    );
    if (intent.reason === "fog") {
      add(n, "brightness", start, 1 - amount * 0.3, 0, "fog");
    }
  }
  // One chosen synth lead at most every two bars, independently seeded. Bass has
  // neither pitch nor spatial automation, including its harmonic foundation.
  const leads = eligible.filter(
    (n) => n.trackId.startsWith("melody-") && !n.patchId.includes("marimba"),
  );
  let gesture = eligible.length
    ? `Restrained ${intent.reason} phrase swell`
    : "Waiting for a held upper phrase";
  if (
    policy.pitchGestures &&
    leads.length &&
    bar - checkpoint.lastGestureBar >= 2 &&
    (observation.front === "cold" || observation.gustiness > 0.55)
  ) {
    const n = leads[choice(checkpoint.seed, bar) % leads.length]!;
    const start = n.startTick / 960,
      duration = n.durationTicks / 960;
    add(n, "pitchCents", start, -Math.min(200, 100 * amount), 0, "scoop");
    add(
      n,
      "pitchCents",
      start + Math.min(0.04, duration * 0.08),
      0,
      Math.min(0.22, duration * 0.35),
      "settle",
    );
    checkpoint.lastGestureBar = bar;
    gesture =
      "Small synth lead scoop and held phrase swell; bass stays centered";
  }
  checkpoint.targets = Object.fromEntries(
    eligible.map((n) => [n.trackId, 1 - amount * 0.2]),
  );
  return { controls, checkpoint, gesture };
}
/** Self-contained synth-only header used by live windows and frozen/offline takes. */
export function weatherExpressionDocument(
  id: string,
  lengthTicks: number,
): PerformanceDocumentV1 {
  return {
    version: 1,
    kind: "expressive-performance",
    id,
    ppq: 480,
    lengthTicks,
    tempoMap: [{ tick: 0, microsecondsPerBeat: 500000 }],
    meterMap: [{ tick: 0, numerator: 4, denominator: 4 }],
    parts: WEATHER_SONG_V2_TRACKS.map((t) => ({
      id: t.id,
      name: t.name,
      role: t.role,
      gain: t.gain,
      pan: t.role === "bass" ? 0 : t.pan,
    })),
    bindings: [...new Set(WEATHER_SONG_V2_TRACKS.map((t) => t.patchId))].map(
      (patchId) => {
        const projection = WEATHER_SONG_V2_INSTRUMENT_PALETTE.bindings.find(
          (b) => b.patchId === patchId,
        )!;
        return {
          id: patchId,
          resourceId: patchId,
          patchId,
          kind: "synth",
          ...(projection.gmProgram === undefined
            ? {}
            : { gmProgram: projection.gmProgram }),
          ...(projection.gmDrumPitch === undefined ? {} : { drum: true }),
        };
      },
    ),
    resources: WEATHER_SONG_V2_PATCHES.map((patch) => ({
      id: patch.id,
      kind: "synth",
      patch: structuredClone(patch),
    })),
    notes: [],
    controls: [],
    instruments: [],
    provenance: {
      source: WEATHER_EXPRESSIVE_VERSION,
      gainCurve: "cc-square-v1",
      diagnostics: [],
      expressionPolicy: WEATHER_EXPRESSION_PROFILE,
      noteGenerator: "weather-song-2",
      generatedGainSemantics: "linear-amplitude",
      environment: "independent; omitted from music take",
    },
  };
}
export function weatherExpressionNotes(notes: readonly PerformanceNote[]) {
  return notes.map((n) => ({
    id: n.id,
    partId: n.trackId,
    bindingId: n.patchId,
    startTick: n.startTick,
    keyReleaseTick: n.startTick + n.durationTicks,
    endTick: n.startTick + n.durationTicks,
    startSeconds: n.startTick / 960,
    keyReleaseSeconds: (n.startTick + n.durationTicks) / 960,
    endSeconds: (n.startTick + n.durationTicks) / 960,
    pitch: n.pitch,
    velocity: n.velocity,
    priority: n.priority,
    optional: n.optional,
  }));
}
/** Frozen same-notes A/B fixture. Both conditions receive the exact same notes;
 * expression never calls or consumes the composer's RNG. */
export function weatherExpressionComparison(
  seed: number,
  bars = 8,
  policy: WeatherExpressionPolicy = DEFAULT_WEATHER_EXPRESSION,
) {
  let composer = createWeatherComposerCheckpoint(seed);
  let expression = createWeatherExpressionCheckpoint(seed);
  const document = weatherExpressionDocument(
    `expression-comparison-${seed}`,
    bars * 1920,
  );
  for (let bar = 0; bar < bars; bar++) {
    const observation: ComposerWeatherObservation = {
      id: `expression-weather-${bar}`,
      front: bar < 4 ? "warm" : "cold",
      intensity: 0.5,
      precipitation: 0.35,
      gustiness: bar < 4 ? 0.3 : 0.7,
      stormStrength: 0.25,
      instability: 0.5,
    };
    const result = composeWeatherBar(composer, observation, {
      simulationTick: bar * 120,
    } as WeatherComposerPolicy);
    composer = result.checkpoint;
    const phrasing = expressWeatherNotes(
      result.events,
      observation,
      bar,
      expression,
      policy,
    );
    expression = phrasing.checkpoint;
    document.notes.push(...weatherExpressionNotes(result.events));
    document.controls.push(...phrasing.controls);
  }
  document.lengthTicks = Math.max(
    document.lengthTicks,
    ...document.notes.map((n) => n.endTick),
  );
  const bypass = structuredClone(document);
  bypass.id += "-bypass";
  bypass.controls = [];
  return {
    documents: [bypass, document] as const,
    labels: [
      "Same notes: expression off",
      "Same notes: weather phrase expression",
    ] as [string, string],
  };
}

export interface WeatherContinuousExpressionState {
  lastSampleSeconds: number;
  smoothedGain: number;
  lastAdmittedGain: number;
  sequence: number;
}
export function createWeatherContinuousExpressionState(): WeatherContinuousExpressionState {
  return {
    lastSampleSeconds: -Infinity,
    smoothedGain: 1,
    lastAdmittedGain: 1,
    sequence: 0,
  };
}
/** Observe at most 10 Hz, with a one-second smoothing constant and unchanged-lane
 * coalescing. At most four upper-part lanes are emitted per observation (40/s).
 * This is a producer bound; the shared engine owns aggregate admission/overflow. */
export function observeWeatherExpression(
  saved: WeatherContinuousExpressionState,
  observation: ComposerWeatherObservation,
  timeSeconds: number,
  policy: WeatherExpressionPolicy = DEFAULT_WEATHER_EXPRESSION,
): {
  state: WeatherContinuousExpressionState;
  controls: ExpressiveControlEvent[];
} {
  validateWeatherExpressionPolicy(policy);
  if (!Number.isFinite(timeSeconds) || timeSeconds < 0)
    throw Error("Invalid expression observation time");
  if (timeSeconds - saved.lastSampleSeconds < 0.1 - 1e-9)
    return { state: saved, controls: [] };
  const state = { ...saved, lastSampleSeconds: timeSeconds };
  const intent = weatherMusicalIntent(observation);
  const desired = policy.enabled
    ? 1 - policy.amount * (0.08 - intent.tension * 0.06)
    : 1;
  const elapsed = Number.isFinite(saved.lastSampleSeconds)
    ? Math.min(0.5, timeSeconds - saved.lastSampleSeconds)
    : 0.1;
  state.smoothedGain +=
    (desired - state.smoothedGain) * (1 - Math.exp(-elapsed));
  if (Math.abs(state.smoothedGain - saved.lastAdmittedGain) < 0.005)
    return { state, controls: [] };
  state.lastAdmittedGain = state.smoothedGain;
  state.sequence++;
  return {
    state,
    controls: [
      "melody-flute",
      "melody-violin",
      "harmony-violin",
      "harmony-piano",
    ].map((partId) => ({
      id: `weather-continuous-${state.sequence}:${partId}`,
      partId,
      parameter: "expression",
      timeSeconds,
      value: state.smoothedGain,
      rampSeconds: 1,
    })),
  };
}
