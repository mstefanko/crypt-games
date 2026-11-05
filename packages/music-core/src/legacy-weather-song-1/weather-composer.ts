import { BAR_TICKS } from "./bar-planner";
import { createTonalContext, degreePitch, MODE_INTERVALS } from "./tonality";
import {
  WEATHER_SONG_TRACKS as WEATHER_TRACKS,
  ensembleParts,
} from "./orchestration";
import { weatherMusicalIntent } from "./weather-intent";
import type { PerformanceNote } from "../performance";
import {
  WEATHER_SONG_INSTRUMENT_PALETTE,
  paletteBinding,
} from "./instrument-palette";
import {
  SONG_TEMPLATES,
  SONG_SECTIONS,
  songPosition,
  phrasePhase,
  type SongPlan,
  type SongSection,
  type PhrasePhase,
} from "./song-plan";
import { songDrumPattern } from "./song-rhythm";
import * as legacy from "../legacy-weather-chamber-6/weather-composer";
export type {
  ComposerWeatherObservation,
  WeatherSection,
  ResolutionObligation,
} from "../legacy-weather-chamber-6/weather-composer";
import type {
  ComposerWeatherObservation,
  WeatherSection,
} from "../legacy-weather-chamber-6/weather-composer";
export const WEATHER_COMPOSER_VERSION = "weather-song-1";
export const LEGACY_WEATHER_COMPOSER_VERSION = "weather-chamber-6";
export type WeatherComposerVersion =
  | typeof WEATHER_COMPOSER_VERSION
  | typeof LEGACY_WEATHER_COMPOSER_VERSION;
export type WeatherComposerPolicy = legacy.WeatherComposerPolicy & {
  /** Intentionally separate occupancy/recurrence policy. */ musicalPolicy?:
    | "song"
    | "ambience";
};
export type WeatherComposerCheckpoint = Omit<
  legacy.WeatherComposerCheckpoint,
  "version" | "featuredEpisode"
> & {
  version: WeatherComposerVersion;
  song?: SongPlan;
  featuredEpisode: null | { startBar: number; length: 4 | 8 | 12 };
};
export interface SongTrace {
  songPlanVersion: 1;
  songIndex: number;
  template: "A" | "B";
  songBar: number;
  section: SongSection;
  sectionBar: number;
  sectionLength: number;
  phraseLength: number;
  phrasePhase: PhrasePhase;
  hookId: string;
  hookReturn:
    | "exact"
    | "constant-transposition"
    | "modal-adaptation"
    | "fragment"
    | null;
  hookStatementStart: boolean;
  hookStatementComplete: boolean;
  weightTier: 0 | 1 | 2 | 3;
  feature: boolean;
  featureInterrupted: boolean;
  soloDebt: number;
  closure: "open" | "half" | "full";
  rhythmFamily: string;
}
export type WeatherComposedBar = Omit<
  legacy.WeatherComposedBar,
  "checkpoint" | "trace"
> & {
  checkpoint: WeatherComposerCheckpoint;
  trace: legacy.WeatherComposedBar["trace"] & { song?: SongTrace };
};
const clone = <T>(value: T): T => structuredClone(value);
const bound = (n: number) => Math.max(0, Math.min(1, n));
function random(seed: number, n: number): number {
  let x = Math.imul(seed ^ Math.imul(n + 1, 0x9e3779b1), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  return (x ^ (x >>> 15)) >>> 0;
}
function hook(
  seed: number,
  epoch: number,
  tonic: number,
  mode: keyof typeof MODE_INTERVALS,
): SongPlan["hook"] {
  const degrees = [0, 1 + (random(seed, epoch * 11) % 2), 4, 2, 3, 1, 4, 0];
  const context = createTonalContext(mode, tonic);
  return {
    id: `hook:${seed}:${epoch}`,
    length: 4,
    age: 0,
    lifetime: random(seed, epoch + 91) % 2 ? 3 : 2,
    tonic,
    mode,
    notes: degrees.map((degree, i) => ({
      bar: Math.floor(i / 2),
      offset: i % 2 ? 960 : 0,
      duration: i === 7 ? 720 : i % 2 ? 600 : 840,
      pitch: degreePitch(context, degree, 5),
      degree,
    })),
  };
}
function initialSong(seed: number): SongPlan {
  return {
    songPlanVersion: 1,
    template: random(seed, 1) % 2 ? "B" : "A",
    songIndex: 0,
    songBar: 0,
    hook: hook(seed, 0, 0, "ionian"),
    verse: [0, 2, 1, 4],
    soloDebt: 0,
    missedFeatureDeadlines: 0,
    debtDeadlineSong: null,
    recurrenceDeadlineBar: 30,
    pendingRequest: null,
    exit: {
      normal: [4],
      optional: [],
      maximumExtension: 0,
      destinations: ["verse"],
    },
    feature: null,
    history: [],
    featureCompleted: false,
    hookProgress: null,
    arranger: {
      weightTier: 0,
      activity: 0,
      brightness: 0.5,
      density: 0,
      tension: 0,
    },
  };
}
export function createWeatherComposerCheckpoint(
  seed: number,
  version: WeatherComposerVersion = WEATHER_COMPOSER_VERSION,
): WeatherComposerCheckpoint {
  if (
    version !== WEATHER_COMPOSER_VERSION &&
    version !== LEGACY_WEATHER_COMPOSER_VERSION
  )
    throw new RangeError("Unsupported composer version");
  const base = legacy.createWeatherComposerCheckpoint(seed);
  if (version === LEGACY_WEATHER_COMPOSER_VERSION) return base;
  return { ...base, version, song: initialSong(seed) };
}
/** Reject malformed or unbounded worker/import state before attempting realization. */
export function validateWeatherComposerCheckpoint(
  value: WeatherComposerCheckpoint,
): void {
  if (!value || JSON.stringify(value).length > 65536)
    throw new RangeError("Composer checkpoint exceeds 64 KiB");
  if (
    ![WEATHER_COMPOSER_VERSION, LEGACY_WEATHER_COMPOSER_VERSION].includes(
      value.version,
    )
  )
    throw new RangeError("Unsupported composer version");
  if (
    !Number.isSafeInteger(value.bar) ||
    value.bar < 0 ||
    !Number.isSafeInteger(value.seed)
  )
    throw new RangeError("Invalid composer position");
  if (!value.tonalContext || !MODE_INTERVALS[value.tonalContext.mode])
    throw new RangeError("Invalid composer mode");
  for (const [items, maximum] of [
    [value.tails, 128],
    [value.releaseTails, 256],
    [value.frontMotifs, 4],
    [value.motifHistory, 16],
    [value.recentChords, 8],
  ] as const)
    if (!Array.isArray(items) || items.length > maximum)
      throw new RangeError("Unbounded composer history");
  for (const n of [...value.tails, ...value.releaseTails])
    if (
      !n ||
      typeof n.id !== "string" ||
      n.id.length > 256 ||
      !Number.isInteger(n.pitch) ||
      n.pitch < 0 ||
      n.pitch > 127 ||
      !Number.isSafeInteger(n.startTick) ||
      n.startTick < 0 ||
      !Number.isFinite(n.durationTicks) ||
      n.durationTicks <= 0 ||
      n.durationTicks > 7680
    )
      throw new RangeError("Invalid composer tail");
  if (
    value.obligation &&
    (value.obligation.kind !== "dominant-to-tonic" ||
      !Number.isSafeInteger(value.obligation.deadlineBar))
  )
    throw new RangeError("Invalid harmonic obligation");
  if (value.version === LEGACY_WEATHER_COMPOSER_VERSION) return;
  if (
    !Number.isInteger(value.tonalContext.tonic) ||
    value.tonalContext.tonic < 0 ||
    value.tonalContext.tonic > 11 ||
    !["light", "reflective", "dark", "earthy"].includes(value.ensemble)
  )
    throw new RangeError("Invalid tonal or ensemble state");
  for (const tail of [...value.tails, ...value.releaseTails]) {
    const track = WEATHER_TRACKS.find((t) => t.id === tail.trackId);
    if (
      !track ||
      track.patchId !== tail.patchId ||
      !Number.isFinite(tail.velocity) ||
      tail.velocity < 0 ||
      tail.velocity > 1
    )
      throw new RangeError("Invalid tail identity");
    const binding = paletteBinding(
      WEATHER_SONG_INSTRUMENT_PALETTE,
      tail.patchId,
    );
    if (
      tail.pitch < binding.playable[0] ||
      tail.pitch > binding.playable[1] ||
      tail.durationTicks > binding.maxSustainSeconds * 960 ||
      tail.durationTicks < (binding.minSustainSeconds ?? 0) * 960 ||
      tail.startTick >= value.bar * BAR_TICKS
    )
      throw new RangeError("Unqualified or future tail");
  }
  const s = value.song;
  if (
    !s ||
    s.songPlanVersion !== 1 ||
    !["A", "B"].includes(s.template) ||
    !Number.isSafeInteger(s.songIndex) ||
    s.songIndex < 0 ||
    !Number.isSafeInteger(s.songBar) ||
    s.songBar < 0 ||
    s.songBar >= SONG_TEMPLATES[s.template].reduce<number>((a, b) => a + b, 0)
  )
    throw new RangeError("Invalid song plan");
  if (
    !s.hook ||
    s.hook.length !== 4 ||
    !Array.isArray(s.hook.notes) ||
    s.hook.notes.length !== 8 ||
    ![2, 3].includes(s.hook.lifetime) ||
    !Number.isInteger(s.hook.age) ||
    s.hook.age < 0 ||
    s.hook.age >= s.hook.lifetime ||
    !MODE_INTERVALS[s.hook.mode] ||
    typeof s.hook.id !== "string" ||
    s.hook.id.length > 128 ||
    !Number.isInteger(s.hook.tonic) ||
    s.hook.tonic < 0 ||
    s.hook.tonic > 11
  )
    throw new RangeError("Invalid hook");
  if (
    s.hook.notes.some(
      (n) =>
        !n ||
        !Number.isInteger(n.degree) ||
        n.degree < 0 ||
        n.degree > 6 ||
        !Number.isInteger(n.bar) ||
        n.bar < 0 ||
        n.bar > 3 ||
        !Number.isFinite(n.offset) ||
        n.offset < 0 ||
        n.offset >= BAR_TICKS ||
        !Number.isInteger(n.pitch) ||
        n.pitch < 0 ||
        n.pitch > 127 ||
        !Number.isFinite(n.duration) ||
        n.duration <= 0 ||
        n.offset + n.duration > BAR_TICKS,
    )
  )
    throw new RangeError("Invalid hook notes");
  for (let bar = 0; bar < 4; bar++)
    if (s.hook.notes.filter((n) => n.bar === bar).length !== 2)
      throw new RangeError("Hook must contain a complete four-bar statement");
  if (
    s.pendingRequest &&
    (typeof s.pendingRequest.reason !== "string" ||
      s.pendingRequest.reason.length > 512 ||
      typeof s.pendingRequest.destination !== "string" ||
      s.pendingRequest.destination.length > 64 ||
      !Number.isFinite(s.pendingRequest.priority) ||
      !Number.isSafeInteger(s.pendingRequest.sinceBar))
  )
    throw new RangeError("Invalid exit request");
  if (
    s.hookProgress &&
    (!Number.isSafeInteger(s.hookProgress.startBar) ||
      !Number.isInteger(s.hookProgress.bars) ||
      s.hookProgress.bars < 0 ||
      s.hookProgress.bars > 4 ||
      !Number.isInteger(s.hookProgress.tonic) ||
      s.hookProgress.tonic < 0 ||
      s.hookProgress.tonic > 11 ||
      typeof s.hookProgress.interrupted !== "boolean" ||
      (s.hookProgress.pitchDelta !== null &&
        !Number.isInteger(s.hookProgress.pitchDelta)) ||
      !WEATHER_TRACKS.some(
        (t) => t.id === s.hookProgress!.trackId && t.role === "melody",
      ))
  )
    throw new RangeError("Invalid hook progress");
  if (s.hookProgress && s.hookProgress.pitchDelta !== null) {
    const track = WEATHER_TRACKS.find((t) => t.id === s.hookProgress!.trackId)!;
    const binding = paletteBinding(
      WEATHER_SONG_INSTRUMENT_PALETTE,
      track.patchId,
    );
    if (
      s.hook.notes.some(
        (n) =>
          n.pitch + s.hookProgress!.pitchDelta! < binding.playable[0] ||
          n.pitch + s.hookProgress!.pitchDelta! > binding.playable[1],
      )
    )
      throw new RangeError(
        "Hook transposition is outside its qualified instrument",
      );
  }
  if (
    !Array.isArray(s.history) ||
    s.history.length > 3 ||
    !Array.isArray(s.verse) ||
    s.verse.length !== 4 ||
    !Number.isInteger(s.soloDebt) ||
    s.soloDebt < 0 ||
    s.soloDebt > 1 ||
    !s.arranger ||
    ![0, 1, 2, 3].includes(s.arranger.weightTier) ||
    s.verse.some((n) => !Number.isInteger(n) || n < 0 || n > 6) ||
    !Number.isSafeInteger(s.missedFeatureDeadlines) ||
    s.missedFeatureDeadlines < 0 ||
    (s.debtDeadlineSong !== null &&
      (!Number.isSafeInteger(s.debtDeadlineSong) || s.debtDeadlineSong < 0)) ||
    !Number.isSafeInteger(s.recurrenceDeadlineBar) ||
    typeof s.featureCompleted !== "boolean" ||
    [
      s.arranger.activity,
      s.arranger.brightness,
      s.arranger.density,
      s.arranger.tension,
    ].some((n) => !Number.isFinite(n) || n < 0 || n > 1)
  )
    throw new RangeError("Unbounded song state");
  if (
    s.feature &&
    (!Number.isSafeInteger(s.feature.startBar) ||
      s.feature.startBar < 0 ||
      s.feature.startBar > value.bar ||
      ![8, 12].includes(s.feature.length) ||
      !["statement", "answer", "development", "release"].includes(
        s.feature.phase,
      ) ||
      typeof s.feature.interrupted !== "boolean")
  )
    throw new RangeError("Invalid feature state");
  if (
    !s.exit ||
    s.exit.maximumExtension !== 0 ||
    !Array.isArray(s.exit.normal) ||
    s.exit.normal.length > 2 ||
    !Array.isArray(s.exit.optional) ||
    s.exit.optional.length > 2 ||
    !Array.isArray(s.exit.destinations) ||
    s.exit.destinations.length > 2 ||
    [...s.exit.normal, ...s.exit.optional].some(
      (n) => !Number.isInteger(n) || n < 1 || n > 12,
    ) ||
    s.exit.destinations.some((n) => !SONG_SECTIONS.includes(n))
  )
    throw new RangeError("Invalid prepared exits");
}
const legacySection: Record<SongSection, WeatherSection> = {
  intro: "establish",
  verse: "approach",
  "verse-prime": "develop",
  chorus: "peak",
  "verse-double-prime": "develop",
  bridge: "hold",
  solo: "develop",
  "final-chorus": "return",
  outro: "return",
};
function nextSong(s: WeatherComposerCheckpoint) {
  const plan = s.song!;
  plan.history = [
    ...plan.history,
    {
      songIndex: plan.songIndex,
      template: plan.template,
      hookId: plan.hook.id,
      featureCompleted: plan.featureCompleted,
    },
  ].slice(-3);
  plan.songIndex++;
  if (
    plan.soloDebt &&
    plan.debtDeadlineSong !== null &&
    plan.songIndex === plan.debtDeadlineSong + 1
  )
    plan.missedFeatureDeadlines++;
  plan.songBar = 0;
  plan.feature = null;
  plan.featureCompleted = false;
  plan.hookProgress = null;
  plan.template = plan.template === "A" ? "B" : "A";
  plan.hook.age++;
  if (plan.hook.age >= plan.hook.lifetime) {
    plan.hook = hook(
      s.seed,
      plan.songIndex,
      s.tonalContext.tonic,
      s.tonalContext.mode,
    );
    plan.verse = plan.verse.map((n, i) => (n + (i % 2 ? 1 : 0)) % 7);
  }
}
/** New notes only: tails and the committed prefix remain owned by the scheduler. */
export function composeWeatherBar(
  saved: WeatherComposerCheckpoint,
  weather: ComposerWeatherObservation,
  policy: WeatherComposerPolicy = {},
): WeatherComposedBar {
  validateWeatherComposerCheckpoint(saved);
  if (saved.version === LEGACY_WEATHER_COMPOSER_VERSION)
    return legacy.composeWeatherBar(
      saved as legacy.WeatherComposerCheckpoint,
      weather,
      policy,
    );
  const s = clone(saved),
    plan = s.song!,
    pos = songPosition(plan),
    start = s.bar * BAR_TICKS;
  const intent = {
    ...weatherMusicalIntent(weather, s.tonalContext.mode),
    ...policy.intent,
  };
  const section = legacySection[pos.section],
    phase = phrasePhase(pos.sectionBar, pos.sectionLength);
  const chorus = pos.section === "chorus" || pos.section === "final-chorus";
  const ambience = policy.musicalPolicy === "ambience";
  const fallback = !!policy.forceFallback;
  const interrupted =
    pos.section === "solo" &&
    !ambience &&
    (fallback || !!policy.hold || policy.featuredEpisodes === false);
  // Ordinary weather cannot cancel the guaranteed slot. Safety/explicit suspension records debt.
  if (interrupted) {
    plan.soloDebt = 1;
    plan.debtDeadlineSong ??= plan.songIndex + 1;
    if (plan.feature) plan.feature.interrupted = true;
  }
  const feature = pos.section === "solo" && !interrupted && !ambience;
  if (pos.section === "solo" && !plan.feature)
    plan.feature = {
      startBar: s.bar - pos.sectionBar,
      length: pos.sectionLength as 8 | 12,
      phase,
      interrupted: interrupted || pos.sectionBar > 0,
    };
  if (feature && plan.feature) plan.feature.phase = phase;
  // Hook tonality remains immutable until retirement; weather adapts texture first.
  const mode =
    chorus && pos.sectionBar < 4
      ? plan.hook.mode
      : (policy.lockedMode ??
        (policy.adaptiveTonality === false ? "ionian" : plan.hook.mode));
  // A statement owns a constant transposition until its fourth bar completes.
  const tonic =
    chorus && pos.sectionBar > 0 && pos.sectionBar < 4 && plan.hookProgress
      ? plan.hookProgress.tonic
      : (policy.tonic ?? plan.hook.tonic);
  s.tonalContext = createTonalContext(mode, tonic);
  const desiredEnsemble =
    policy.lockedEnsemble ??
    (policy.adaptiveInstruments === false ? "light" : intent.ensemble);
  const requestTarget = `${intent.mode}:${desiredEnsemble}`;
  if (intent.mode !== mode || desiredEnsemble !== s.ensemble) {
    const previous = plan.pendingRequest;
    plan.pendingRequest = {
      reason: intent.reason,
      priority: weather.stormStrength ?? 0,
      sinceBar:
        previous?.destination === requestTarget ? previous.sinceBar : s.bar,
      destination: requestTarget,
    };
  } else plan.pendingRequest = null;
  const settled =
    !!plan.pendingRequest && s.bar - plan.pendingRequest.sinceBar >= 2;
  if (
    pos.sectionBar === 0 &&
    (settled || policy.lockedEnsemble || policy.adaptiveInstruments === false)
  )
    s.ensemble = desiredEnsemble;
  if (
    pos.section === "outro" &&
    pos.sectionBar === 3 &&
    plan.hook.age + 1 >= plan.hook.lifetime &&
    policy.adaptiveTonality !== false &&
    !s.obligation
  ) {
    const target = createTonalContext(policy.lockedMode ?? intent.mode, tonic);
    const pcs = new Set(
      MODE_INTERVALS[target.mode].map((n) => (n + target.tonic) % 12),
    );
    if (
      s.releaseTails.every(
        (n) =>
          WEATHER_TRACKS.find((t) => t.id === n.trackId)?.role === "drums" ||
          pcs.has(n.pitch % 12),
      )
    )
      s.tonalContext = target;
  }
  let tier: 0 | 1 | 2 | 3 =
    pos.section === "intro" ||
    pos.section === "bridge" ||
    pos.section === "outro"
      ? 0
      : intent.weight > 0.68
        ? 3
        : intent.weight > 0.35
          ? 2
          : 1;
  if (pos.section === "final-chorus" && tier > 0 && tier < 3)
    tier = (tier + 1) as 2 | 3;
  // Heavy returns earn a two-bar withdrawal before the next structural entry.
  if (pos.section === "verse-double-prime" && pos.sectionBar < 2) tier = 0;
  if (feature) tier = 1;
  if (ambience) tier = 0;
  const drums = songDrumPattern(
    tier,
    pos.sectionBar,
    pos.sectionBar === pos.sectionLength - 1,
  );
  const density =
    pos.section === "intro" ||
    pos.section === "bridge" ||
    pos.section === "outro" ||
    feature
      ? 0.2
      : bound(intent.activity);
  plan.arranger = {
    weightTier: tier,
    activity: intent.activity,
    brightness: intent.brightness,
    density,
    tension: intent.tension,
  };
  const closure =
    pos.sectionBar === pos.sectionLength - 1
      ? pos.section === "outro"
        ? "full"
        : "half"
      : "open";
  // Eight/twelve-bar phrases use modal pedals and continuations; no fourth-bar reset.
  const progression = chorus
    ? [0, 0, 3, 3, 5, 3, 4, 0]
    : feature
      ? pos.sectionLength === 12
        ? [0, 0, 3, 3, 5, 5, 3, 3, 5, 5, 4, 0]
        : [0, 0, 3, 3, 5, 5, 4, 0]
      : [0, 3, 5, 0];
  const committedResolution =
    !!s.obligation && s.obligation.deadlineBar <= s.bar;
  const degree = committedResolution
    ? 0
    : !chorus && phase === "development" && intent.tension > 0.7
      ? 5
      : progression[pos.sectionBar % progression.length]!;
  s.tonalContext.harmonicFunction =
    degree === 0
      ? "tonic"
      : degree === 4
        ? "dominant"
        : degree === 3
          ? "predominant"
          : "color";
  const root = degreePitch(s.tonalContext, degree, 3);
  const parts = ensembleParts(s.ensemble),
    events: PerformanceNote[] = [];
  const emit = (
    trackId: string,
    offset: number,
    duration: number,
    pitch: number,
    velocity: number,
    optional = false,
  ) => {
    const track = WEATHER_TRACKS.find((t) => t.id === trackId);
    if (!track) throw new Error(`Missing song track ${trackId}`);
    const binding = paletteBinding(
      WEATHER_SONG_INSTRUMENT_PALETTE,
      track.patchId,
    );
    while (pitch < binding.playable[0]) pitch += 12;
    while (pitch > binding.playable[1]) pitch -= 12;
    if (pitch < binding.playable[0])
      throw new RangeError("Unplayable song note");
    events.push({
      id: `weather-song:${s.bar}:${events.length}`,
      trackId,
      patchId: track.patchId,
      startTick: start + offset,
      // A qualified natural percussion tail may outlive the two-bar onset horizon.
      durationTicks:
        trackId === "drums-timpani"
          ? duration
          : Math.min(duration, BAR_TICKS - offset - 60),
      pitch,
      velocity: bound(velocity),
      gain: track.gain,
      pan: track.pan,
      priority: track.role === "melody" ? 90 : track.role === "bass" ? 100 : 40,
      optional,
    });
  };
  const continuingHook =
    chorus && pos.sectionBar > 0 && pos.sectionBar < 4
      ? plan.hookProgress
      : null;
  const melodyTrack =
    continuingHook?.trackId ??
    (feature && (s.ensemble === "reflective" || s.ensemble === "dark")
      ? "melody-bassoon"
      : parts.melody);
  const hookBinding = paletteBinding(
    WEATHER_SONG_INSTRUMENT_PALETTE,
    WEATHER_TRACKS.find((t) => t.id === melodyTrack)!.patchId,
  );
  // Fit the entire hook using one octave displacement, never fold individual notes.
  const desiredDelta = tonic - plan.hook.tonic;
  const octave = [0, -12, 12, -24, 24, -36, 36].find((offset) =>
    plan.hook.notes.every(
      (n) =>
        n.pitch + desiredDelta + offset >= hookBinding.playable[0] &&
        n.pitch + desiredDelta + offset <= hookBinding.playable[1],
    ),
  );
  const hookPitchDelta = continuingHook
    ? continuingHook.pitchDelta
    : octave === undefined
      ? null
      : desiredDelta + octave;
  const hookStart =
    chorus &&
    pos.sectionBar === 0 &&
    !ambience &&
    !fallback &&
    !policy.hold &&
    hookPitchDelta !== null;
  let hookComplete = false;
  const hookLiteral =
    chorus && pos.sectionBar < 4 && !ambience && !fallback && !policy.hold;
  if (chorus && pos.sectionBar === 0)
    plan.hookProgress = {
      startBar: s.bar,
      bars: 0,
      interrupted: false,
      tonic,
      pitchDelta: hookPitchDelta,
      trackId: melodyTrack,
    };
  if (chorus && pos.sectionBar < 4 && plan.hookProgress) {
    if (!hookLiteral || hookPitchDelta === null)
      plan.hookProgress.interrupted = true;
    else plan.hookProgress.bars++;
    hookComplete =
      pos.sectionBar === 3 &&
      plan.hookProgress.bars === 4 &&
      !plan.hookProgress.interrupted;
  }
  if (!policy.hold) {
    if (hookLiteral) {
      for (const note of plan.hook.notes.filter(
        (n) => n.bar === pos.sectionBar,
      ))
        emit(
          melodyTrack,
          note.offset,
          note.duration,
          note.pitch + (hookPitchDelta ?? desiredDelta),
          0.71,
        );
      if (hookStart) plan.recurrenceDeadlineBar = s.bar + 30;
    } else if (pos.section === "intro" && !ambience && !fallback) {
      if (pos.sectionBar % 2 === 0) {
        const note = plan.hook.notes[pos.sectionBar === 0 ? 0 : 4]!;
        emit(
          melodyTrack,
          240,
          720,
          note.pitch + (tonic - plan.hook.tonic),
          0.5,
        );
      }
    } else if (ambience) {
      if (pos.sectionBar % 4 === 0) {
        const note = plan.hook.notes[(Math.floor(pos.sectionBar / 4) % 4) * 2]!;
        emit(
          melodyTrack,
          240,
          600,
          note.pitch + (tonic - plan.hook.tonic),
          0.4,
        );
      }
    } else {
      const offsets = feature
        ? phase === "release"
          ? [240, 1200]
          : phase === "development"
            ? [0, 720, 1440]
            : [0, 1200]
        : pos.section === "intro"
          ? [240]
          : weather.thermalBand === "hot"
            ? [0, 720, 1440]
            : weather.front === "cold"
              ? [240, 1200]
              : [0, 960];
      for (let i = 0; i < offsets.length; i++) {
        const d = feature
          ? (plan.verse[(Math.floor(pos.sectionBar / 2) + i) % 4]! +
              (phase === "development" ? 2 : 0)) %
            7
          : plan.verse[(pos.sectionBar + i) % 4]!;
        let pitch = degreePitch(s.tonalContext, d, 5);
        const melodyLow = melodyTrack === "melody-bassoon" ? 53 : 67,
          melodyHigh = melodyTrack === "melody-bassoon" ? 65 : 79;
        while (pitch > melodyHigh) pitch -= 12;
        while (pitch < melodyLow) pitch += 12;
        emit(
          melodyTrack,
          offsets[i]!,
          feature
            ? phase === "release"
              ? 540
              : 780
            : weather.front === "warm"
              ? 780
              : 540,
          pitch,
          feature ? 0.75 : 0.56,
        );
      }
    }
    // Sparse sections and features contain at most two actual instrumental parts.
    if (feature || tier === 0) {
      if (feature) emit(parts.bass, 0, 1080, root, 0.4);
      else if (pos.sectionBar % (ambience ? 4 : 2) === 0)
        emit(
          parts.harmony,
          0,
          1440,
          degreePitch(s.tonalContext, degree, 4),
          0.33,
        );
    } else {
      const chord = [0, 2, 4].map((d) =>
        degreePitch(s.tonalContext, degree + d, 4),
      );
      for (let voice = 0; voice < chord.length; voice++)
        emit(
          parts.harmony,
          0,
          1500,
          chord[voice]! + (voice === 2 && intent.brightness > 0.7 ? 12 : 0),
          0.34,
        );
      emit(parts.bass, 0, tier === 1 ? 1080 : 660, root, 0.57);
      if (tier === 3) emit(parts.bass, 0, 1200, root + 12, 0.36);
      if (tier >= 2 && pos.sectionBar % 2 === 0)
        emit(
          parts.bass,
          1200,
          540,
          root + (pos.sectionBar % 4 === 0 ? 7 : 12),
          0.48,
        );
      // Patterns do not depend on precipitation; no articulated sustain truncation.
      if (!fallback) {
        if (tier === 3 && pos.sectionBar === 0)
          emit("drums-timpani", 0, 5376, 36, 0.34, true);
        for (const offset of drums.kick)
          emit(parts.drums, offset, 120, 36, tier === 3 ? 0.56 : 0.4, true);
        for (const offset of drums.snare)
          emit("drums-snare", offset, 120, 38, 0.27, true);
        for (const [i, offset] of drums.hat.entries())
          if (intent.activity > 0.45 || i % 2 === 0)
            emit("drums-hat", offset, 90, 42, 0.19, true);
      }
    }
  }
  // A bounded pickup prepares the next normal exit while leaving sustained tails intact.
  if (
    !policy.hold &&
    !fallback &&
    !feature &&
    !ambience &&
    pos.sectionBar === pos.sectionLength - 1 &&
    events
      .filter((n) => n.trackId === melodyTrack)
      .every((n) => n.startTick + n.durationTicks <= start + 1680)
  )
    emit(melodyTrack, 1680, 180, degreePitch(s.tonalContext, 4, 5), 0.46);
  const activeRoles = [
    ...new Set(
      [
        ...s.releaseTails.filter(
          (n) =>
            n.startTick +
              n.durationTicks +
              paletteBinding(WEATHER_SONG_INSTRUMENT_PALETTE, n.patchId)
                .releaseSeconds *
                960 >
            start,
        ),
        ...events,
      ].map((n) => WEATHER_TRACKS.find((t) => t.id === n.trackId)!.role),
    ),
  ];
  const arrangement: WeatherComposedBar["arrangement"] = {
    foreground: "melody",
    harmony: "held",
    drums: tier >= 2 ? "active" : "sparse",
    activeRoles,
    headroom: 0.18,
  };
  const tension: WeatherComposedBar["tension"] = {
    harmonic: intent.tension,
    activity: intent.activity,
    slope:
      phase === "release"
        ? "release"
        : phase === "development"
          ? "rise"
          : "hold",
    arrivalBar: s.bar + pos.sectionLength - pos.sectionBar - 1,
    realized: degree === 4 ? 0.6 : 0.2,
  };
  const trace: WeatherComposedBar["trace"] = {
    observationId: weather.id,
    version: WEATHER_COMPOSER_VERSION,
    section,
    phraseGrammar: "sentence",
    phraseRole: phase,
    transformation: feature
      ? `solo-${phase}`
      : hookLiteral
        ? hookPitchDelta === null
          ? "hook-modal-adaptation"
          : hookPitchDelta === 0
            ? "hook-exact"
            : "hook-constant-transposition"
        : pos.section,
    motifIds: [chorus ? plan.hook.id : `verse:${plan.songIndex}`],
    choice: degree,
    candidateCount: 1,
    eligibleCount: 1,
    candidateScores: [{ chord: degree, register: 60, cost: 0 }],
    work: events.length + 1,
    heldFromPrevious: s.tails.map((n) => n.id),
    reason: fallback
      ? "Safety fallback; feature debt recorded"
      : "Authored song form; weather arranges texture",
    arrival: closure === "full",
    resolution: committedResolution,
    rests: Math.max(
      0,
      4 - events.filter((n) => n.trackId === melodyTrack).length,
    ),
    transition:
      pos.sectionBar === 0 && s.bar > 0
        ? {
            rule:
              pos.section === "bridge"
                ? "contrast"
                : pos.section === "outro"
                  ? "clear"
                  : "connect",
            source: s.section,
            destination: section,
            exitGrid: "phrase",
            entryTick: start,
            leadInTicks: 240,
            tailPolicy: "preserve",
            harmonyCondition: committedResolution
              ? "Resolve committed dominant before entry"
              : "Compatible modal continuation; no extension",
            priority: plan.pendingRequest?.priority ?? 0,
          }
        : null,
    song: {
      songPlanVersion: 1,
      songIndex: plan.songIndex,
      template: plan.template,
      songBar: plan.songBar,
      section: pos.section,
      sectionBar: pos.sectionBar,
      sectionLength: pos.sectionLength,
      phraseLength: pos.sectionLength,
      phrasePhase: phase,
      hookId: plan.hook.id,
      hookReturn: hookLiteral
        ? hookPitchDelta === null
          ? "modal-adaptation"
          : hookPitchDelta === 0
            ? "exact"
            : "constant-transposition"
        : !policy.hold &&
            !fallback &&
            ((ambience && pos.sectionBar % 4 === 0) ||
              (!ambience &&
                pos.section === "intro" &&
                pos.sectionBar % 2 === 0))
          ? "fragment"
          : null,
      hookStatementStart: hookStart,
      hookStatementComplete: hookComplete,
      weightTier: tier,
      feature,
      featureInterrupted: interrupted,
      soloDebt: plan.soloDebt,
      closure,
      rhythmFamily: drums.id,
    },
  };
  if (
    events.length > (policy.maxEvents ?? 128) ||
    (fallback && s.consecutiveFallbacks >= 3)
  )
    return {
      bar: saved.bar,
      events: [],
      checkpoint: clone(saved),
      status: "resync-required",
      arrangement,
      tension,
      trace: {
        ...trace,
        song: trace.song
          ? {
              ...trace.song,
              hookStatementStart: false,
              hookStatementComplete: false,
              hookReturn: null,
              feature: false,
            }
          : undefined,
        reason: "Song realization exceeds bounded event/fallback budget",
      },
    };
  s.featuredEpisode = feature
    ? { startBar: plan.feature!.startBar, length: plan.feature!.length }
    : null;
  s.lastFeaturedBar = feature ? plan.feature!.startBar : s.lastFeaturedBar;
  if (
    pos.section === "solo" &&
    pos.sectionBar === pos.sectionLength - 1 &&
    plan.feature &&
    !ambience &&
    !plan.feature.interrupted
  ) {
    plan.featureCompleted = true;
    plan.soloDebt = 0;
    plan.debtDeadlineSong = null;
  }
  plan.exit = {
    normal: [pos.sectionLength],
    optional: pos.section === "solo" ? [pos.sectionLength - 2] : [],
    maximumExtension: 0,
    destinations: [SONG_SECTIONS[(pos.index + 1) % SONG_SECTIONS.length]!],
  };
  s.bar++;
  plan.songBar++;
  s.section = section;
  s.chord = degree;
  s.previousFront = weather.front;
  s.phraseWeather = clone(weather);
  s.intensity = {
    activity: intent.activity,
    tension: intent.tension,
    precipitation: weather.precipitation,
    gustiness: weather.gustiness,
  };
  s.recentChords = [...s.recentChords, degree].slice(-8);
  if (committedResolution) s.obligation = null;
  if (degree === 4 && !s.obligation)
    s.obligation = {
      kind: "dominant-to-tonic",
      createdBar: s.bar - 1,
      deadlineBar: s.bar,
    };
  s.tails = [...s.tails, ...events].filter(
    (n) => n.startTick + n.durationTicks > s.bar * BAR_TICKS,
  );
  s.releaseTails = [...s.releaseTails, ...events]
    .filter(
      (n) =>
        n.startTick +
          n.durationTicks +
          paletteBinding(WEATHER_SONG_INSTRUMENT_PALETTE, n.patchId)
            .releaseSeconds *
            960 >
        s.bar * BAR_TICKS,
    )
    .map((n) => ({ ...n }));
  s.consecutiveFallbacks = fallback ? s.consecutiveFallbacks + 1 : 0;
  if (
    plan.songBar ===
    SONG_TEMPLATES[plan.template].reduce<number>((a, b) => a + b, 0)
  )
    nextSong(s);
  return {
    bar: saved.bar,
    events,
    checkpoint: s,
    status: fallback ? "fallback" : "planned",
    arrangement,
    tension,
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
  return { checkpoint: clone(checkpoint), bars };
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
    checkpoint: clone(prepared.checkpoint),
    bars: [...prefix, ...prepareWeatherBars(base, observations, policy).bars],
  };
}
