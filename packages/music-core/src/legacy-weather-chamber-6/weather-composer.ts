import { BAR_TICKS, type WeatherObservation } from "./bar-planner";
import {
  createTonalContext,
  degreePitch,
  MODE_INTERVALS,
  MODE_CHARACTERISTIC_DEGREE,
  type ModeId,
  type TonalContext,
} from "./tonality";
import { harmonicChords } from "./harmonic-grammar";
import {
  WEATHER_TRACKS,
  ensembleParts,
  type EnsembleId,
} from "./orchestration";
import { weatherMusicalIntent, type MusicalIntent } from "./weather-intent";
import type { PerformanceNote } from "../performance";

/** Original C-major chamber grammar, versioned independently from playback. */
export const WEATHER_COMPOSER_VERSION = "weather-chamber-6";
export interface ComposerWeatherObservation extends WeatherObservation {
  temperature?: number;
  thermalBand?: "cold" | "chilly" | "temperate" | "hot";
  fog?: number;
  stormStrength?: number;
  frontId?: string;
  activeFrontIds?: readonly string[];
  moisture?: number;
  instability?: number;
  cloudCover?: number;
  clearingDuration?: number;
  precipitationPattern?: "dry" | "steady" | "showers";
  frontPassage?: boolean;
  interaction?: boolean | number;
  windDirection?: number;
}
export type WeatherSection =
  | "establish"
  | "approach"
  | "develop"
  | "peak"
  | "return"
  | "hold";
export interface ResolutionObligation {
  kind: "dominant-to-tonic";
  createdBar: number;
  deadlineBar: number;
}
export interface WeatherComposerCheckpoint {
  version: typeof WEATHER_COMPOSER_VERSION;
  seed: number;
  tonalContext: TonalContext;
  ensemble: EnsembleId;
  lastTonalChangeBar: number;
  pendingMode: null | {
    mode: ModeId;
    ensemble: EnsembleId;
    sinceTick: number;
    boundaryTick: number;
  };
  tonalTransition: null | {
    source: TonalContext;
    target: TonalContext;
    transitionTick: number;
    commonTones: number[];
    protectedNotes: PerformanceNote[];
    pendingObligation: ResolutionObligation | null;
  };
  releaseTails: PerformanceNote[];
  intensity: {
    activity: number;
    tension: number;
    precipitation: number;
    gustiness: number;
  };
  stormBars: number;
  featuredEpisode: null | { startBar: number; length: 4 };
  lastFeaturedBar: number;
  bar: number;
  motif: number[];
  answerMotif: number[];
  frontMotifs: { frontId: string; degrees: number[]; lastUsedBar: number }[];
  motifHistory: { frontId: string; retiredBar: number }[];
  pickupReady: boolean;
  chord: number;
  voices: number[];
  lastMelody: number;
  section: WeatherSection;
  phraseWeather: ComposerWeatherObservation;
  previousFront: WeatherObservation["front"];
  obligation: ResolutionObligation | null;
  tails: PerformanceNote[];
  recentChords: number[];
  consecutiveFallbacks: number;
  lastArrivalBar: number;
}
export interface WeatherComposerPolicy {
  seed?: number;
  forceFallback?: boolean;
  maxEvents?: number;
  hold?: boolean;
  /** Disable equally on paired fixtures when comparing only tonality or orchestration. */
  featuredEpisodes?: boolean;
  adaptiveTonality?: boolean;
  adaptiveInstruments?: boolean;
  lockedMode?: ModeId;
  lockedEnsemble?: EnsembleId;
  tonic?: number;
  /** Simulation time in weather ticks (60 ticks/second), never wall time. */
  simulationTick?: number;
  intent?: Partial<
    Pick<
      MusicalIntent,
      "brightness" | "tension" | "activity" | "weight" | "continuity"
    >
  >;
}
export interface WeatherComposedBar {
  bar: number;
  events: PerformanceNote[];
  checkpoint: WeatherComposerCheckpoint;
  status: "planned" | "fallback" | "resync-required";
  tension: {
    harmonic: number;
    activity: number;
    slope: "rise" | "hold" | "release";
    arrivalBar: number;
    realized: number;
  };
  arrangement: {
    foreground: "melody" | "harmony" | "bass";
    harmony: "held" | "pulse";
    drums: "sparse" | "active";
    activeRoles: string[];
    headroom: number;
  };
  trace: {
    observationId: string;
    version: string;
    section: WeatherSection;
    phraseGrammar: "sentence" | "period" | "extension";
    phraseRole: string;
    transformation: string;
    motifIds: string[];
    choice: number;
    candidateCount: number;
    eligibleCount: number;
    candidateScores: { chord: number; register: number; cost: number }[];
    /** Count of evaluated voicings/harmonic candidates, pitch candidates and emitted notes. */
    work: number;
    heldFromPrevious: string[];
    reason: string;
    arrival: boolean;
    resolution: boolean;
    rests: number;
    transition: null | {
      rule: "connect" | "contrast" | "clear" | "hold";
      source: WeatherSection;
      destination: WeatherSection;
      exitGrid: "phrase";
      entryTick: number;
      leadInTicks: number;
      tailPolicy: "preserve";
      harmonyCondition: string;
      priority: number;
    };
  };
}
const clamp = (v: number) => Math.max(0, Math.min(1, v));
function random(seed: number, bar: number, kind: number): number {
  let x =
    (seed ^
      Math.imul(bar + 1, 0x9e3779b1) ^
      Math.imul(kind + 1, 0x85ebca6b)) >>>
    0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  return (x ^ (x >>> 15)) >>> 0;
}
const clear: ComposerWeatherObservation = {
  id: "initial",
  front: "clear",
  intensity: 0,
  precipitation: 0,
  gustiness: 0,
};
export function createWeatherComposerCheckpoint(
  seed: number,
): WeatherComposerCheckpoint {
  if (!Number.isSafeInteger(seed))
    throw new RangeError("Invalid composer seed");
  const motif = [
    0,
    1 + (random(seed, 0, 0) % 2),
    3 + (random(seed, 0, 1) % 2),
    2,
  ];
  return {
    version: WEATHER_COMPOSER_VERSION,
    seed,
    tonalContext: createTonalContext(),
    ensemble: "light",
    lastTonalChangeBar: -4,
    pendingMode: null,
    tonalTransition: null,
    releaseTails: [],
    intensity: { activity: 0, tension: 0, precipitation: 0, gustiness: 0 },
    stormBars: 0,
    featuredEpisode: null,
    lastFeaturedBar: -32,
    bar: 0,
    motif,
    answerMotif: motif.map((n) => 6 - n),
    frontMotifs: [],
    motifHistory: [],
    pickupReady: false,
    chord: 0,
    voices: [60, 64, 67],
    lastMelody: 72,
    section: "establish",
    phraseWeather: { ...clear },
    previousFront: "clear",
    obligation: null,
    tails: [],
    recentChords: [],
    consecutiveFallbacks: 0,
    lastArrivalBar: -1,
  };
}
function cloneWeather(
  w: ComposerWeatherObservation,
): ComposerWeatherObservation {
  return {
    ...w,
    ...(w.activeFrontIds ? { activeFrontIds: [...w.activeFrontIds] } : {}),
  };
}
function frontIds(w: ComposerWeatherObservation): string[] {
  return [
    ...new Set([
      ...(w.frontId ? [w.frontId] : []),
      ...(w.activeFrontIds ?? []),
    ]),
  ].sort();
}
function retainFrontMotifs(
  s: WeatherComposerCheckpoint,
  w: ComposerWeatherObservation,
): void {
  const active = frontIds(w);
  for (const frontId of active) {
    let entry = s.frontMotifs.find((m) => m.frontId === frontId);
    if (!entry) {
      if (s.frontMotifs.length === 4) {
        const retired = s.frontMotifs
          .filter((m) => !active.includes(m.frontId))
          .sort(
            (a, b) =>
              a.lastUsedBar - b.lastUsedBar ||
              (a.frontId < b.frontId ? -1 : a.frontId > b.frontId ? 1 : 0),
          )[0];
        if (!retired) continue;
        s.frontMotifs = s.frontMotifs.filter((m) => m !== retired);
        s.motifHistory = [
          ...s.motifHistory,
          { frontId: retired.frontId, retiredBar: s.bar },
        ].slice(-8);
      }
      let identity = 2166136261;
      for (const c of frontId)
        identity = Math.imul(identity ^ c.charCodeAt(0), 16777619) >>> 0;
      entry = {
        frontId,
        degrees: s.motif.map(
          (n, i) => (n + (random(s.seed ^ identity, i, 13) % 7)) % 7,
        ),
        lastUsedBar: s.bar,
      };
      s.frontMotifs.push(entry);
    }
    entry.lastUsedBar = s.bar;
  }
}
function copy(s: WeatherComposerCheckpoint): WeatherComposerCheckpoint {
  return {
    ...s,
    intensity: { ...s.intensity },
    featuredEpisode: s.featuredEpisode && { ...s.featuredEpisode },
    tonalContext: structuredClone(s.tonalContext),
    pendingMode: s.pendingMode && { ...s.pendingMode },
    tonalTransition: s.tonalTransition && structuredClone(s.tonalTransition),
    releaseTails: s.releaseTails.map((n) => ({ ...n })),
    motif: [...s.motif],
    answerMotif: [...s.answerMotif],
    voices: [...s.voices],
    phraseWeather: cloneWeather(s.phraseWeather),
    frontMotifs: s.frontMotifs.map((m) => ({ ...m, degrees: [...m.degrees] })),
    motifHistory: s.motifHistory.map((m) => ({ ...m })),
    obligation: s.obligation && { ...s.obligation },
    tails: s.tails.map((n) => ({ ...n })),
    recentChords: [...s.recentChords],
  };
}
function validate(
  s: WeatherComposerCheckpoint,
  w: ComposerWeatherObservation,
  p: WeatherComposerPolicy,
): void {
  const context = s.tonalContext;
  if (
    !context ||
    !MODE_INTERVALS[context.mode] ||
    !Number.isInteger(context.tonic) ||
    context.tonic < 0 ||
    context.tonic > 11 ||
    !["light", "reflective", "dark", "earthy"].includes(s.ensemble) ||
    !Array.isArray(s.releaseTails) ||
    (p.lockedMode !== undefined && !MODE_INTERVALS[p.lockedMode]) ||
    (p.lockedEnsemble !== undefined &&
      !["light", "reflective", "dark", "earthy"].includes(p.lockedEnsemble)) ||
    (p.tonic !== undefined &&
      (!Number.isInteger(p.tonic) || p.tonic < 0 || p.tonic > 11)) ||
    (p.simulationTick !== undefined &&
      (!Number.isSafeInteger(p.simulationTick) || p.simulationTick < 0)) ||
    (p.intent &&
      !Object.values(p.intent).every(
        (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1,
      ))
  )
    throw new RangeError("Invalid tonal policy or checkpoint");
  if (
    !Number.isSafeInteger(s.lastTonalChangeBar) ||
    s.lastTonalChangeBar < -4 ||
    s.lastTonalChangeBar > s.bar ||
    (p.tonic !== undefined && s.bar > 0 && p.tonic !== context.tonic) ||
    (s.pendingMode &&
      (!MODE_INTERVALS[s.pendingMode.mode] ||
        !["light", "reflective", "dark", "earthy"].includes(
          s.pendingMode.ensemble,
        ) ||
        !Number.isFinite(s.pendingMode.sinceTick) ||
        s.pendingMode.sinceTick < 0 ||
        !Number.isSafeInteger(s.pendingMode.boundaryTick))) ||
    s.releaseTails.length > 128 ||
    !s.releaseTails.every(
      (n) =>
        Number.isInteger(n.pitch) &&
        n.pitch >= 0 &&
        n.pitch <= 127 &&
        Number.isInteger(n.startTick) &&
        Number.isInteger(n.durationTicks) &&
        n.durationTicks > 0 &&
        WEATHER_TRACKS.some(
          (t) => t.id === n.trackId && t.patchId === n.patchId,
        ),
    ) ||
    (s.tonalTransition &&
      (!MODE_INTERVALS[s.tonalTransition.target.mode] ||
        s.tonalTransition.target.tonic !== context.tonic ||
        !Number.isSafeInteger(s.tonalTransition.transitionTick)))
  )
    throw new RangeError("Invalid tonal transition checkpoint");
  if (
    !s.intensity ||
    !Object.values(s.intensity).every(
      (n) => Number.isFinite(n) && n >= 0 && n <= 1,
    ) ||
    !Number.isSafeInteger(s.stormBars) ||
    s.stormBars < 0 ||
    !Number.isSafeInteger(s.lastFeaturedBar) ||
    s.lastFeaturedBar < -32 ||
    s.lastFeaturedBar > s.bar ||
    (s.featuredEpisode &&
      (s.featuredEpisode.length !== 4 ||
        !Number.isSafeInteger(s.featuredEpisode.startBar) ||
        s.featuredEpisode.startBar < 0 ||
        s.featuredEpisode.startBar > s.bar)) ||
    s.version !== WEATHER_COMPOSER_VERSION ||
    !Number.isSafeInteger(s.seed) ||
    !Number.isSafeInteger(s.bar) ||
    s.bar < 0 ||
    s.bar > 100000 ||
    !Number.isInteger(s.chord) ||
    s.chord < 0 ||
    s.chord >= 4 ||
    !Array.isArray(s.frontMotifs) ||
    s.frontMotifs.length > 4 ||
    new Set(s.frontMotifs.map((m) => m.frontId)).size !==
      s.frontMotifs.length ||
    !s.frontMotifs.every(
      (m) =>
        typeof m.frontId === "string" &&
        m.frontId.length > 0 &&
        m.frontId.length <= 128 &&
        m.degrees.length === 4 &&
        m.degrees.every((n) => Number.isInteger(n) && n >= 0 && n < 7) &&
        Number.isInteger(m.lastUsedBar) &&
        m.lastUsedBar >= 0 &&
        m.lastUsedBar <= s.bar,
    ) ||
    !Array.isArray(s.motifHistory) ||
    s.motifHistory.length > 8 ||
    !s.motifHistory.every(
      (m) =>
        typeof m.frontId === "string" &&
        m.frontId.length > 0 &&
        m.frontId.length <= 128 &&
        Number.isInteger(m.retiredBar) &&
        m.retiredBar >= 0 &&
        m.retiredBar <= s.bar,
    ) ||
    typeof s.pickupReady !== "boolean" ||
    !Number.isInteger(s.lastMelody) ||
    s.lastMelody < 60 ||
    s.lastMelody > 88 ||
    !["establish", "approach", "develop", "peak", "return", "hold"].includes(
      s.section,
    ) ||
    !s.recentChords.every((n) => Number.isInteger(n) && n >= 0 && n < 4) ||
    s.motif.length !== 4 ||
    s.answerMotif.length !== 4 ||
    ![...s.motif, ...s.answerMotif].every(
      (n) => Number.isInteger(n) && n >= 0 && n < 7,
    ) ||
    s.voices.length !== 3 ||
    !s.voices.every((n) => Number.isInteger(n) && n >= 48 && n <= 79) ||
    s.tails.length > 3 ||
    s.recentChords.length > 8 ||
    (w.frontId !== undefined &&
      (typeof w.frontId !== "string" ||
        !w.frontId.length ||
        w.frontId.length > 128)) ||
    (w.activeFrontIds !== undefined &&
      (!Array.isArray(w.activeFrontIds) ||
        w.activeFrontIds.length > 4 ||
        !w.activeFrontIds.every(
          (id) => typeof id === "string" && id.length > 0 && id.length <= 128,
        ))) ||
    frontIds(w).length > 4 ||
    (w.precipitationPattern !== undefined &&
      !["dry", "steady", "showers"].includes(w.precipitationPattern)) ||
    (w.frontPassage !== undefined && typeof w.frontPassage !== "boolean") ||
    (w.interaction !== undefined &&
      typeof w.interaction !== "boolean" &&
      (typeof w.interaction !== "number" ||
        !Number.isFinite(w.interaction) ||
        w.interaction < 0 ||
        w.interaction > 1)) ||
    (w.thermalBand !== undefined &&
      !["cold", "chilly", "temperate", "hot"].includes(w.thermalBand)) ||
    !w.id ||
    w.id.length > 128 ||
    !["cold", "warm", "clear"].includes(w.front) ||
    ![
      w.intensity,
      w.precipitation,
      w.gustiness,
      w.moisture ?? 0,
      w.instability ?? 0,
      w.cloudCover ?? 0,
      w.temperature ?? 0.5,
      w.fog ?? 0,
      w.stormStrength ?? 0,
    ].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) ||
    (w.clearingDuration !== undefined &&
      (!Number.isFinite(w.clearingDuration) || w.clearingDuration < 0)) ||
    (w.windDirection !== undefined && !Number.isFinite(w.windDirection)) ||
    (p.maxEvents !== undefined &&
      (!Number.isInteger(p.maxEvents) ||
        p.maxEvents < 0 ||
        p.maxEvents > 128)) ||
    !Number.isInteger(s.consecutiveFallbacks) ||
    s.consecutiveFallbacks < 0 ||
    s.consecutiveFallbacks > 2
  )
    throw new RangeError("Invalid weather composer input");
  for (const n of s.tails)
    if (
      !Number.isInteger(n.pitch) ||
      !Number.isInteger(n.startTick) ||
      !Number.isInteger(n.durationTicks) ||
      n.durationTicks <= 0 ||
      n.durationTicks > 2 * BAR_TICKS ||
      !WEATHER_TRACKS.some((t) => t.id === n.trackId && t.role === "harmony") ||
      !harmonicChords(s.tonalContext)[s.chord]!.includes(n.pitch % 12) ||
      n.startTick >= s.bar * BAR_TICKS ||
      n.startTick + n.durationTicks <= s.bar * BAR_TICKS ||
      n.startTick + n.durationTicks > (s.bar + 1) * BAR_TICKS
    )
      throw new RangeError("Invalid carried onset");
  if (
    s.obligation &&
    (s.obligation.kind !== "dominant-to-tonic" ||
      !Number.isInteger(s.obligation.createdBar) ||
      s.obligation.createdBar < 0 ||
      s.obligation.createdBar >= s.bar ||
      !Number.isInteger(s.obligation.deadlineBar) ||
      s.obligation.deadlineBar < s.bar ||
      s.obligation.deadlineBar - s.obligation.createdBar > 16)
  )
    throw new RangeError("Expired resolution obligation");
}
const CHORD_TENSION = [0, 0.35, 0.85, 0.65];
function voice(
  chord: number,
  previous: number[],
  register: number,
  chords: number[][],
): { pitches: number[]; work: number; cost: number } {
  let pitches: number[] = [],
    cost = Infinity,
    work = 0;
  const candidates = Array.from({ length: 25 }, (_, i) => i + 55).filter((n) =>
    chords[chord]!.includes(n % 12),
  );
  for (const a of candidates.filter((n) => n <= 67))
    for (const b of candidates)
      for (const c of candidates) {
        work++;
        if (
          b < a + 3 ||
          c < b + 3 ||
          b - a > 12 ||
          c - b > 12 ||
          new Set([a % 12, b % 12, c % 12]).size !== 3
        )
          continue;
        const score =
          [a, b, c].reduce(
            (sum, n, i) =>
              sum +
              Math.abs(n - previous[i]!) * 2 -
              (n === previous[i] ? 3 : 0),
            0,
          ) + Math.abs(a + b + c - register * 3);
        if (score < cost) {
          cost = score;
          pitches = [a, b, c];
        }
      }
  return { pitches, work, cost };
}
function transitionRule(source: WeatherSection, destination: WeatherSection) {
  const rule: "connect" | "contrast" | "clear" | "hold" =
    destination === "hold"
      ? "hold"
      : destination === "return" || destination === "establish"
        ? "clear"
        : destination === "peak" || destination === "develop"
          ? "contrast"
          : "connect";
  return {
    rule,
    source,
    destination,
    exitGrid: "phrase" as const,
    leadInTicks: 480,
    tailPolicy: "preserve" as const,
    harmonyCondition: "tonic pickup and entry; preserve carried chord",
    priority:
      rule === "clear"
        ? 100
        : rule === "hold"
          ? 90
          : rule === "contrast"
            ? 70
            : 50,
  };
}
/** One immutable, onset-owned bar. Weather is revealed only at invocation; no clock or shared RNG. */
export function composeWeatherBar(
  saved: WeatherComposerCheckpoint,
  w: ComposerWeatherObservation,
  p: WeatherComposerPolicy = {},
): WeatherComposedBar {
  validate(saved, w, p);
  const s = copy(saved),
    start = s.bar * BAR_TICKS,
    end = start + BAR_TICKS,
    pos = s.bar % 16,
    phrase = s.bar % 4;
  const now = p.simulationTick ?? start / 16;
  const intent = {
    ...weatherMusicalIntent(w, s.tonalContext.mode),
    ...p.intent,
  };
  const desiredMode =
    p.lockedMode ??
    (p.intent?.brightness !== undefined
      ? intent.brightness >= 0.9
        ? "lydian"
        : intent.brightness >= 0.65
          ? "ionian"
          : intent.brightness >= 0.35
            ? "dorian"
            : "aeolian"
      : undefined) ??
    (p.adaptiveTonality === false ? s.tonalContext.mode : intent.mode);
  const desiredEnsemble =
    p.lockedEnsemble ??
    (p.adaptiveInstruments === false ? s.ensemble : intent.ensemble);
  const desiredTonic = p.tonic ?? s.tonalContext.tonic;
  // A locked fixture starts directly in its requested context, preserving rhythm and RNG.
  if (s.bar === 0 && (p.lockedMode || p.tonic !== undefined))
    s.tonalContext = createTonalContext(desiredMode, desiredTonic);
  if (s.bar === 0 && p.lockedEnsemble) s.ensemble = p.lockedEnsemble;
  let bridge = false;
  if (s.tonalTransition && start > s.tonalTransition.transitionTick) {
    s.tonalContext = structuredClone(s.tonalTransition.target);
    s.ensemble = s.pendingMode?.ensemble ?? s.ensemble;
    s.lastTonalChangeBar = s.bar;
    s.tonalTransition = null;
    s.pendingMode = null;
  }
  if (desiredMode !== s.tonalContext.mode || desiredEnsemble !== s.ensemble) {
    if (
      !s.pendingMode ||
      s.pendingMode.mode !== desiredMode ||
      s.pendingMode.ensemble !== desiredEnsemble
    )
      s.pendingMode = {
        mode: desiredMode,
        ensemble: desiredEnsemble,
        sinceTick: now,
        boundaryTick: (Math.ceil((s.bar + 1) / 4) * 4 + 1) * BAR_TICKS,
      };
    if (
      !p.hold &&
      !p.forceFallback &&
      (p.maxEvents ?? 128) >= 24 &&
      phrase === 0 &&
      now - s.pendingMode.sinceTick >= 120 &&
      s.bar - s.lastTonalChangeBar >= 4 &&
      !s.obligation
    ) {
      const targetContext = createTonalContext(desiredMode, desiredTonic);
      s.tonalTransition = {
        source: structuredClone(s.tonalContext),
        target: targetContext,
        transitionTick: start,
        commonTones: [desiredTonic, (desiredTonic + 7) % 12],
        protectedNotes: s.releaseTails.map((n) => ({ ...n })),
        pendingObligation: s.obligation,
      };
      s.pendingMode.boundaryTick = start + BAR_TICKS;
      bridge = true;
    }
  } else if (!s.tonalTransition) s.pendingMode = null;
  if (s.pendingMode && !s.tonalTransition)
    s.pendingMode.boundaryTick =
      (Math.ceil((s.bar + 1) / 4) * 4 + 1) * BAR_TICKS;
  const CHORDS = harmonicChords(s.tonalContext);
  const SCALE = MODE_INTERVALS[s.tonalContext.mode];
  const parts = ensembleParts(s.ensemble);
  // Bind the incoming accompaniment on the common-tone bridge; the lead follows next bar.
  if (bridge && s.pendingMode)
    parts.harmony = ensembleParts(s.pendingMode.ensemble).harmony;
  const requestedIntensity = {
    activity: intent.activity,
    tension: intent.tension,
    precipitation: w.precipitation,
    gustiness: w.gustiness,
  };
  const pendingBuild = !!s.pendingMode && !bridge;
  for (const key of Object.keys(
    requestedIntensity,
  ) as (keyof typeof requestedIntensity)[]) {
    const desired = requestedIntensity[key];
    const previous = s.intensity[key];
    // The already-required wait becomes a bounded buildup. Clearing sheds percussion first.
    const step =
      desired < previous
        ? key === "precipitation" || key === "gustiness"
          ? 0.5
          : 0.22
        : pendingBuild
          ? 0.1
          : 0.25;
    s.intensity[key] =
      previous + Math.max(-step, Math.min(step, desired - previous));
  }
  intent.activity = s.intensity.activity;
  intent.tension = s.intensity.tension;
  const fallback = p.forceFallback === true || (p.maxEvents ?? 128) < 24;
  const status = fallback
    ? s.consecutiveFallbacks === 2
      ? "resync-required"
      : "fallback"
    : "planned";
  if (phrase === 0) {
    s.phraseWeather = cloneWeather(w);
    retainFrontMotifs(s, w);
  }
  const weather = s.phraseWeather,
    arrival = phrase === 3;
  const foggy = (weather.fog ?? 0) > 0.25;
  const chilly =
    weather.thermalBand === "cold" || weather.thermalBand === "chilly";
  const hot = weather.thermalBand === "hot";
  const stormy = (weather.stormStrength ?? 0) > 0.12;
  const target = arrival
    ? 0
    : clamp(
        (pendingBuild
          ? Math.min(w.instability ?? 0, intent.tension)
          : (w.instability ?? 0)) *
          0.6 +
          intent.tension * 0.25 +
          (w.frontPassage ? 0.2 : 0) +
          (w.front === "cold" ? 0.2 : 0.05),
      );
  const tension: WeatherComposedBar["tension"] = {
    harmonic: target,
    activity: intent.activity,
    slope: arrival ? "release" : phrase === 0 ? "rise" : "hold",
    arrivalBar: s.bar + (3 - phrase),
    realized: 0,
  };
  let section: WeatherSection =
    pos < 4
      ? "establish"
      : pos < 8
        ? "approach"
        : pos < 12
          ? "develop"
          : "return";
  if (phrase === 0 && pos >= 4 && pos < 12) {
    if (p.hold) section = "hold";
    else if ((weather.instability ?? 0) > 0.65) section = "peak";
    else if (weather.front === "clear" && (weather.clearingDuration ?? 0) > 4)
      section = "return";
  }
  if (phrase !== 0) section = s.section;
  // A committed fallback bar has no pickup: defer entry for a full phrase.
  if (section !== s.section && !s.pickupReady) section = s.section;
  const transition =
    section !== s.section
      ? { ...transitionRule(s.section, section), entryTick: start }
      : null;
  const foreground =
    section === "hold"
      ? "bass"
      : weather.front === "warm" && pos >= 4 && pos < 8
        ? "harmony"
        : "melody";
  const clearingEntry = transition?.rule === "clear";
  const activeDrums =
    s.intensity.precipitation > 0.05 && !clearingEntry && section !== "hold";
  const arrangement: WeatherComposedBar["arrangement"] = {
    foreground,
    harmony:
      intent.continuity > 0.65 ||
      foggy ||
      weather.front === "warm" ||
      section === "hold"
        ? "held"
        : "pulse",
    drums:
      !pendingBuild &&
      (s.intensity.tension > 0.55 ||
        s.intensity.precipitation + s.intensity.gustiness > 0.8)
        ? "active"
        : "sparse",
    activeRoles: [
      "melody",
      "bass",
      "harmony",
      ...(activeDrums ? ["drums"] : []),
    ],
    headroom: activeDrums ? 0.3 : foreground === "harmony" ? 0.22 : 0.16,
  };
  const phraseGrammar =
    pos >= 8 && pos < 12
      ? "extension"
      : pos >= 4 && pos < 8
        ? "period"
        : "sentence";
  const trace: WeatherComposedBar["trace"] = {
    observationId: w.id,
    version: WEATHER_COMPOSER_VERSION,
    section,
    phraseGrammar,
    phraseRole: (phraseGrammar === "period"
      ? ["question", "question-ending", "answer", "arrival"]
      : phraseGrammar === "extension"
        ? ["fragment", "extension", "continuation", "arrival"]
        : ["idea", "repetition", "continuation", "arrival"])[phrase]!,
    transformation:
      phrase === 3
        ? "answer"
        : section === "return"
          ? "recall"
          : weather.front === "cold"
            ? "fragment"
            : weather.front === "warm"
              ? "augment"
              : "sequence",
    motifIds: [],
    choice: s.chord,
    candidateCount: 0,
    eligibleCount: 0,
    candidateScores: [],
    work: 0,
    heldFromPrevious: s.tails.map((n) => n.id),
    reason:
      status === "resync-required"
        ? "Two fallback bars exhausted; pause and resynchronize"
        : fallback
          ? "Constructive obligation-first continuation"
          : `Weather-conditioned phrase grammar; ${foggy ? "fog: spaced sustained texture" : stormy ? "storm: accented pulse and harmonic pressure" : chilly ? "chill: light detached upper contour" : hot ? "heat: animated answering contour" : "temperate: balanced motif"}`,
    arrival,
    resolution: false,
    rests: 0,
    transition,
  };
  if (status === "resync-required")
    return {
      bar: s.bar,
      events: [],
      checkpoint: s,
      status,
      tension,
      arrangement,
      trace,
    };
  // Obligations and immutable tails constrain enumeration before quality ranking.
  const forcedChord = s.tails.length
    ? s.chord
    : s.obligation && s.obligation.deadlineBar <= s.bar
      ? 0
      : arrival
        ? 0
        : fallback || section === "hold"
          ? s.obligation
            ? 0
            : s.chord
          : phrase === 2
            ? 2
            : phrase === 0
              ? 0
              : undefined;
  const candidates: {
    chord: number;
    register: number;
    cost: number;
    pitches: number[];
  }[] = [];
  let work = 0;
  for (const chord of forcedChord === undefined ? [0, 1, 3] : [forcedChord]) {
    for (const register of [61, 67]) {
      const v = voice(chord, s.voices, register, CHORDS);
      work += v.work + 1;
      const targetRegister = 67 - Math.round(intent.weight * 6);
      const cost =
        Math.round(Math.abs(CHORD_TENSION[chord]! - target) * 1000) +
        Math.abs(register - targetRegister) * 14 +
        v.cost +
        (forcedChord === undefined
          ? s.recentChords.filter((n) => n === chord).length * 25
          : 0);
      candidates.push({ chord, register, cost, pitches: v.pitches });
    }
  }
  candidates.sort(
    (a, b) => a.cost - b.cost || a.chord - b.chord || a.register - b.register,
  );
  const eligible = candidates
    .filter((c) => c.cost <= candidates[0]!.cost + 90)
    .slice(0, 3);
  const weightTotal = eligible.reduce((n, _, i) => n + 3 - i, 0);
  let pick = random(s.seed, s.bar, 21) % weightTotal,
    selected = eligible[0]!;
  for (let i = 0; i < eligible.length; i++) {
    if (pick < 3 - i) {
      selected = eligible[i]!;
      break;
    }
    pick -= 3 - i;
  }
  const chord = selected.chord;
  trace.candidateCount = candidates.length;
  trace.eligibleCount = eligible.length;
  trace.candidateScores = candidates.map(({ chord, register, cost }) => ({
    chord,
    register,
    cost,
  }));
  if (s.obligation && chord === 0) {
    trace.resolution = true;
    s.obligation = null;
  }
  if (chord === 2 && !s.obligation)
    s.obligation = {
      kind: "dominant-to-tonic",
      createdBar: s.bar,
      deadlineBar: s.bar + 1,
    };
  let featured = false;
  const voices = selected.pitches,
    events: PerformanceNote[] = [];
  const emit = (
    trackId: string,
    offset: number,
    duration: number,
    pitch: number,
    optional = false,
  ) => {
    const role = trackId as keyof typeof parts;
    const t = WEATHER_TRACKS.find((t) => t.id === parts[role])!;
    events.push({
      id: `weather-composer:${s.bar}:${trackId}:${events.length}`,
      trackId: t.id,
      patchId: t.patchId,
      startTick: start + offset,
      durationTicks: duration,
      pitch,
      velocity:
        clamp(
          (trackId === "drums" ? 0.25 : 0.48) +
            intent.activity * 0.2 +
            (offset === 0 ? 0.07 : 0),
        ) *
        (role === "drums"
          ? Math.min(1, s.intensity.precipitation + s.intensity.tension * 0.25)
          : 1) *
        (featured
          ? role === "melody"
            ? [0.9, 1, 1.12, 0.85][s.bar - s.featuredEpisode!.startBar]!
            : 0.65
          : 1) *
        (1 - arrangement.headroom) *
        (trackId === foreground ? 1.3 : trackId === "melody" ? 0.8 : 0.7),
      /* bounded final velocity is validated by the performance boundary */
      gain: t.gain,
      pan: t.pan,
      priority: trackId === "bass" ? 100 : trackId === "melody" ? 90 : 40,
      optional,
    });
    work++;
  };
  const stormEstablished = (w.stormStrength ?? 0) > 0.12;
  s.stormBars = stormEstablished && !s.pendingMode ? s.stormBars + 1 : 0;
  if (
    s.featuredEpisode &&
    (s.bar >= s.featuredEpisode.startBar + 4 ||
      s.pendingMode ||
      !stormEstablished ||
      fallback ||
      p.hold ||
      p.featuredEpisodes === false)
  )
    s.featuredEpisode = null;
  if (
    !s.featuredEpisode &&
    s.stormBars >= 8 &&
    phrase === 0 &&
    (section === "develop" || section === "peak") &&
    !s.pendingMode &&
    s.bar - s.lastFeaturedBar >= 32 &&
    !fallback &&
    !p.hold &&
    p.featuredEpisodes !== false
  ) {
    s.featuredEpisode = { startBar: s.bar, length: 4 };
    s.lastFeaturedBar = s.bar;
  }
  featured = !!s.featuredEpisode;
  if (featured) {
    parts.melody = "melody-violin";
    arrangement.harmony = "held";
    trace.transformation = [
      "solo-statement",
      "solo-answer",
      "solo-climax",
      "solo-resolution",
    ][s.bar - s.featuredEpisode!.startBar]!;
  }
  const heldUntil = Math.max(
    0,
    ...s.tails.map((n) => n.startTick + n.durationTicks - start),
  );
  // Only tonic idea bars carry notes; the following tonic bar is compatible.
  const sustain =
    !bridge && !fallback && phrase === 0 && weather.front === "warm"
      ? BAR_TICKS + 240
      : BAR_TICKS - 60;
  if (bridge) {
    // A written common-tone bar keeps every role audible without deleting composed notes.
    const tonic = s.tonalContext.tonic;
    const common = [tonic, (tonic + 7) % 12];
    const near = (pc: number, low: number) =>
      low + ((pc - (low % 12) + 12) % 12);
    for (const pc of common)
      emit(
        "harmony",
        heldUntil,
        Math.max(1, BAR_TICKS - 60 - heldUntil),
        near(pc, 55),
      );
    emit("bass", 0, 900, near(tonic, 36));
    emit("bass", 960, 720, near(common[1]!, 36));
    emit("melody", 0, 1140, near(common[1]!, 67));
    emit("melody", 1440, 420, near(tonic, 67));
  }
  if (!bridge) {
    for (const pitch of voices) {
      if (heldUntil >= BAR_TICKS - 60) continue;
      if (arrangement.harmony === "pulse" && !fallback) {
        emit("harmony", heldUntil, Math.max(1, 840 - heldUntil), pitch);
        emit("harmony", 960, 840, pitch);
      } else emit("harmony", heldUntil, sustain - heldUntil, pitch);
    }
    const pedal =
      pendingBuild && chord === 0 && !s.tails.length && !s.obligation;
    emit("bass", 0, pedal ? 1800 : 840, 36 + CHORDS[chord]![0]!);
    if (!arrival && !pedal) emit("bass", 960, 720, 36 + CHORDS[chord]![0]!);
    const rhythm =
      pendingBuild &&
      (s.intensity.activity < 0.35 ||
        (requestedIntensity.activity < s.intensity.activity &&
          s.intensity.activity < 0.6))
        ? [0, 960]
        : foggy
          ? [240, 1200]
          : section === "hold"
            ? [240, 1200]
            : fallback
              ? [240, 1200]
              : transition?.rule === "contrast"
                ? [0, 240, 480, 1200]
                : transition?.rule === "connect"
                  ? [0, 720, 1440]
                  : transition?.rule === "clear"
                    ? [0, 960]
                    : arrival
                      ? [0, 960]
                      : phraseGrammar === "period" && phrase === 1
                        ? [0, 960]
                        : phraseGrammar === "extension" && phrase === 1
                          ? [0, 240, 720, 960, 1440]
                          : weather.front === "warm"
                            ? [0, 720, 1440]
                            : weather.front === "cold"
                              ? [0, 240, 720, 1200]
                              : [0, 480, 1200];
    const identities = frontIds(weather)
      .map((id) => s.frontMotifs.find((m) => m.frontId === id))
      .filter(
        (m): m is WeatherComposerCheckpoint["frontMotifs"][number] => !!m,
      );
    const thematicReturn = section === "return" || section === "establish";
    trace.motifIds =
      thematicReturn || !identities.length
        ? ["theme"]
        : identities
            .slice(0, weather.interaction ? 2 : 1)
            .map((m) => m.frontId);
    const motif =
      thematicReturn || !identities.length ? s.motif : identities[0]!.degrees;
    let colorResolution: number | null = null;
    const soloPhase = featured ? s.bar - s.featuredEpisode!.startBar : 0;
    const soloRhythms = [
      [0, 1200],
      [0, 720, 1320],
      [0, 600, 1200],
      [0, 720],
    ];
    const soloDegrees = [
      [s.motif[0]!, s.motif[1]!],
      [s.motif[1]!, s.motif[0]!, s.motif[2]!],
      [s.motif[2]!, s.motif[3]!, s.motif[1]!],
      [s.motif[1]!, 0],
    ];
    const melodyRhythm = featured ? soloRhythms[soloPhase]! : rhythm;
    for (let i = 0; i < melodyRhythm.length; i++) {
      const offset = melodyRhythm[i]!;
      if (!fallback && weather.precipitationPattern === "showers" && i === 1) {
        trace.rests++;
        continue;
      }
      const selectedMotif =
        phraseGrammar === "period" && phrase >= 2
          ? motif.map((n) => 6 - n)
          : !thematicReturn &&
              weather.interaction &&
              phrase === 2 &&
              i % 2 &&
              identities[1]
            ? identities[1].degrees
            : motif;
      const degree = selectedMotif[(i + (phrase === 2 ? 2 : 0)) % 4]!;
      const soloDegree = soloDegrees[soloPhase]![i] ?? 0;
      const soloDesired = degreePitch(
        s.tonalContext,
        soloDegree,
        soloPhase === 2 ? 6 : 5,
      );
      const desired: number =
        (featured
          ? (colorResolution ??
            (soloPhase === 1 && i === 0 ? s.lastMelody : soloDesired))
          : null) ??
        colorResolution ??
        72 +
          s.tonalContext.tonic +
          SCALE[
            (degree +
              (section === "develop" ? 1 : 0) +
              (hot && i % 2 ? 2 : 0)) %
              7
          ]! +
          (chilly ? 3 : 0);
      // One unaccented modal color resolves to the nearest supported chord tone on the next onset.
      const color =
        s.tonalContext.mode !== "ionian" &&
        !arrival &&
        i === 1 &&
        i < melodyRhythm.length - 1 &&
        !featured &&
        !fallback &&
        !bridge;
      // Weak-beat passing note resolves into a chord tone at the next onset.
      const soloPassing = featured && soloPhase < 3 && i === 1;
      const soloResolution =
        featured && soloPhase === 3 && i === melodyRhythm.length - 1;
      const melodicCollection = soloResolution
        ? [s.tonalContext.tonic]
        : soloPassing
          ? [degreePitch(s.tonalContext, soloDegree) % 12]
          : color
            ? [
                degreePitch(
                  s.tonalContext,
                  MODE_CHARACTERISTIC_DEGREE[s.tonalContext.mode],
                ) % 12,
              ]
            : CHORDS[chord]!;
      const options = melodicCollection
        .flatMap((pc) => [60 + pc, 72 + pc, 84 + pc])
        .filter((n) => n >= 67 && n <= 79);
      work += options.length;
      const pitch: number = options.sort(
        (a, b) =>
          Math.abs(a - desired) - Math.abs(b - desired) ||
          Math.abs(a - s.lastMelody) - Math.abs(b - s.lastMelody) ||
          a - b,
      )[0]!;
      emit(
        "melody",
        offset,
        Math.min(
          featured
            ? (melodyRhythm[i + 1] ?? BAR_TICKS) - offset - 60
            : foggy
              ? 900
              : chilly
                ? 120
                : weather.front === "warm"
                  ? 600
                  : arrival
                    ? 720
                    : 180,
          BAR_TICKS - offset - 60,
        ),
        pitch,
      );
      colorResolution = color || soloPassing ? pitch : null;
      s.lastMelody = pitch;
    }
  }
  if (activeDrums)
    for (const offset of arrangement.drums === "active" && !fallback
      ? [0, 480, 960, 1440]
      : [0, 960])
      emit("drums", offset, 90, 36, true);
  // Phrase exits generate their pickup before the destination's onset deadline.
  if (arrival && !fallback && !bridge && !featured) {
    const root = CHORDS[chord]![0]!;
    emit("melody", 1440, 240, (root > 7 ? 60 : 72) + root);
  }
  trace.work = work;
  if (events.length > (p.maxEvents ?? 128)) {
    return {
      bar: saved.bar,
      events: [],
      checkpoint: copy(saved),
      status: "resync-required",
      tension,
      arrangement,
      trace: {
        ...trace,
        reason: "Mandatory continuation exceeds event budget",
      },
    };
  }
  s.pickupReady = arrival && !fallback;
  trace.rests += arrival ? 2 : 1;
  trace.choice = chord;
  trace.work = work;
  tension.realized = CHORD_TENSION[chord]!;
  if (arrival && chord === 0) s.lastArrivalBar = s.bar;
  s.bar++;
  s.section = section;
  s.chord = chord;
  s.voices = voices;
  s.previousFront = w.front;
  s.recentChords = [...s.recentChords, chord].slice(-8);
  s.consecutiveFallbacks = fallback ? s.consecutiveFallbacks + 1 : 0;
  s.tonalContext.harmonicFunction =
    chord === 0
      ? "tonic"
      : chord === 2
        ? "dominant"
        : chord === 1
          ? "predominant"
          : "color";
  s.tonalContext.permittedAlterations =
    chord === 2 && ["aeolian", "phrygian"].includes(s.tonalContext.mode)
      ? [(s.tonalContext.tonic + 11) % 12]
      : [];
  s.tonalContext.pendingResolution =
    s.obligation && s.tonalContext.permittedAlterations.length
      ? {
          pitchClass: (s.tonalContext.tonic + 11) % 12,
          targetPitchClass: s.tonalContext.tonic,
          deadlineTick: s.obligation.deadlineBar * BAR_TICKS,
        }
      : null;
  s.releaseTails = [...s.releaseTails, ...events]
    .filter((n) => n.startTick + n.durationTicks + 960 > end)
    .map((n) => ({ ...n }));
  s.tails = [...s.tails, ...events]
    .filter((n) => n.startTick + n.durationTicks > end)
    .map((n) => ({ ...n }));
  return {
    bar: saved.bar,
    events,
    checkpoint: s,
    status,
    tension,
    arrangement,
    trace,
  };
}
export interface PreparedWeatherBars {
  checkpoint: WeatherComposerCheckpoint;
  bars: WeatherComposedBar[];
}
export function prepareWeatherBars(
  checkpoint: WeatherComposerCheckpoint,
  observations: readonly ComposerWeatherObservation[],
  policy: WeatherComposerPolicy = {},
): PreparedWeatherBars {
  if (observations.length > 2)
    throw new RangeError("At most two prepared bars");
  let next = checkpoint;
  const bars: WeatherComposedBar[] = [];
  for (const w of observations) {
    const b = composeWeatherBar(next, w, policy);
    bars.push(b);
    next = b.checkpoint;
    if (b.status === "resync-required") break;
  }
  return { checkpoint: copy(checkpoint), bars };
}
export function reviseWeatherBars(
  prepared: PreparedWeatherBars,
  firstUncommittedBar: number,
  observations: readonly ComposerWeatherObservation[],
  policy: WeatherComposerPolicy = {},
): PreparedWeatherBars {
  const offset = firstUncommittedBar - prepared.checkpoint.bar;
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > prepared.bars.length ||
    offset + observations.length > 2
  )
    throw new RangeError("Revision outside two-bar horizon");
  const prefix = prepared.bars.slice(0, offset),
    base = prefix.at(-1)?.checkpoint ?? prepared.checkpoint;
  return {
    checkpoint: copy(prepared.checkpoint),
    bars: [...prefix, ...prepareWeatherBars(base, observations, policy).bars],
  };
}
