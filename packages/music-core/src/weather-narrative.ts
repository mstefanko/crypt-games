import type { Patch } from "@onepage/project";
import { assertPerformanceDocument, createTempoMap, type ExpressiveNote, type PerformanceDocumentV1 } from "./expressive-performance";
import { MODE_INTERVALS } from "./tonality";
import { createNarrativeMemory, admitNarrativeMemoryEvent, advanceNarrativeMemory, selectNarrativeRecall, type NarrativeFamily, type NarrativeMemoryV1, type NarrativeMode, type NarrativePhraseV1 } from "./weather-narrative-memory";
export type { NarrativeFamily, NarrativeMode } from "./weather-narrative-memory";

function freezeCatalog<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeCatalog(child);
    Object.freeze(value);
  }
  return value;
}
export const WEATHER_NARRATIVE_FAMILIES = Object.freeze(["clear", "fog", "rain", "storm", "clearing"] as const);
export interface WorldSignatureV1 {
  version: 1;
  id: string;
  tonicPitchClass: number;
  motif: { degrees: readonly number[]; onsetGaps: readonly number[]; pulse: "quarter"; contour: readonly string[]; allowedRhythmScales: readonly number[]; minimumFragmentNotes: number };
  travelerPatchId: string;
  cadence: { homeReturn: readonly string[]; open: readonly string[] };
  tonicDepartureEnabled: false;
}
export const WORLD_SIGNATURE_V1: Readonly<WorldSignatureV1> = freezeCatalog<WorldSignatureV1>({
  version: 1, id: "weather-traveler-world-v1", tonicPitchClass: 0,
  motif: { degrees: [1, 2, 5, 3], onsetGaps: [1, 1, 2], pulse: "quarter", contour: ["up", "up", "down"], allowedRhythmScales: [0.5, 1, 2], minimumFragmentNotes: 2 },
  travelerPatchId: "weather-traveler-air-v1", cadence: { homeReturn: ["bVI", "bVII", "I"], open: ["bVII", "V"] }, tonicDepartureEnabled: false,
});
export interface NarrativeCueBundleV1 {
  version: 1;
  family: NarrativeFamily;
  mode: NarrativeMode;
  modes: readonly NarrativeMode[];
  tempoBpm: number;
  meter: { numerator: number; denominator: number };
  phraseBars: number;
  harmonicBars: number;
  melodyGrammar: string;
  ending: "tonic" | "pedal" | "modal" | "interrupted-dominant" | "home-return";
}
export const NARRATIVE_CUE_BUNDLES: Readonly<Record<NarrativeFamily, NarrativeCueBundleV1>> = freezeCatalog({
  clear: { version: 1, family: "clear", mode: "ionian", modes: ["ionian", "lydian"], tempoBpm: 108, meter: { numerator: 4, denominator: 4 }, phraseBars: 4, harmonicBars: 1, melodyGrammar: "rising-call-answer", ending: "tonic" },
  fog: { version: 1, family: "fog", mode: "mixolydian", modes: ["mixolydian"], tempoBpm: 72, meter: { numerator: 3, denominator: 4 }, phraseBars: 4, harmonicBars: 4, melodyGrammar: "separated-fragments-and-space", ending: "pedal" },
  rain: { version: 1, family: "rain", mode: "dorian", modes: ["dorian", "aeolian"], tempoBpm: 81, meter: { numerator: 4, denominator: 4 }, phraseBars: 4, harmonicBars: 2, melodyGrammar: "descending-lyrical-answers", ending: "modal" },
  storm: { version: 1, family: "storm", mode: "aeolian", modes: ["aeolian", "phrygian"], tempoBpm: 144, meter: { numerator: 4, denominator: 4 }, phraseBars: 4, harmonicBars: 0.5, melodyGrammar: "angular-ostinato-and-breaks", ending: "interrupted-dominant" },
  clearing: { version: 1, family: "clearing", mode: "ionian", modes: ["ionian"], tempoBpm: 108, meter: { numerator: 4, denominator: 4 }, phraseBars: 4, harmonicBars: 1, melodyGrammar: "recollection-and-growing-answer", ending: "home-return" },
});
export interface SignatureTransformationV1 {
  signatureId: string;
  degrees: number[];
  onsetPulses: number[];
  rhythmScale: 0.5 | 1 | 2;
  octave: number;
  mode: NarrativeMode;
  fragment: [number, number];
  pitches: number[];
}
/** Only contiguous fragments, whole-cell scaling and octave/modal reinterpretation are permitted. */
export function transformNarrativeSignature(options: { mode: NarrativeMode; rhythmScale?: 0.5 | 1 | 2; octave?: number; fragment?: [number, number]; signature?: "world" | "foil" }): SignatureTransformationV1 {
  const scale = options.rhythmScale ?? 1, octave = options.octave ?? 5, fragment = options.fragment ?? [0, 4];
  if (!MODE_INTERVALS[options.mode] || ![0.5, 1, 2].includes(scale) || !Number.isInteger(octave) || octave < 3 || octave > 7 || !Number.isInteger(fragment[0]) || !Number.isInteger(fragment[1]) || fragment[0] < 0 || fragment[1] > 4 || fragment[1] - fragment[0] < 2) throw Error("Unpermitted narrative signature transformation");
  const degrees = options.signature === "foil" ? [1, 4, 6, 2] : [...WORLD_SIGNATURE_V1.motif.degrees];
  const gaps = options.signature === "foil" ? [2, 1, 1] : [...WORLD_SIGNATURE_V1.motif.onsetGaps];
  const onsets = [0];
  for (const gap of gaps) onsets.push(onsets[onsets.length - 1] + gap * scale);
  const first = onsets[fragment[0]];
  const selected = degrees.slice(...fragment);
  return { signatureId: options.signature === "foil" ? "weather-foil-world-v1" : WORLD_SIGNATURE_V1.id, degrees: selected, onsetPulses: onsets.slice(...fragment).map((n) => n - first), rhythmScale: scale, octave, mode: options.mode, fragment: [...fragment], pitches: selected.map((d) => narrativeDegreePitch(d, options.mode, octave)) };
}
export function narrativeDegreePitch(degree: number, mode: NarrativeMode, octave = 5): number {
  const zero = degree - 1;
  return octave * 12 + MODE_INTERVALS[mode][((zero % 7) + 7) % 7] + Math.floor(zero / 7) * 12;
}
export interface NarrativeModeStateV1 { version: 1; family: NarrativeFamily; requested: NarrativeMode; committed: NarrativeMode; matchingBoundaries: number }
export function createNarrativeModeState(family: NarrativeFamily): NarrativeModeStateV1 {
  const mode = NARRATIVE_CUE_BUNDLES[family].mode;
  return { version: 1, family, requested: mode, committed: mode, matchingBoundaries: 0 };
}
/** Caller supplies held pitch classes; rejected tails retain their original pitches. No implicit retuning. */
export function observeNarrativeModeBoundary(saved: NarrativeModeStateV1, requested: NarrativeMode, heldPitchClasses: readonly number[] = []): NarrativeModeStateV1 {
  if (!NARRATIVE_CUE_BUNDLES[saved.family].modes.includes(requested) || heldPitchClasses.some((p) => !Number.isInteger(p) || p < 0 || p > 11)) throw Error("Unpermitted family mode");
  const matchingBoundaries = saved.requested === requested ? saved.matchingBoundaries + 1 : 1;
  const safeTails = heldPitchClasses.every((p) => (MODE_INTERVALS[requested] as readonly number[]).includes(p));
  return { ...saved, requested, matchingBoundaries, committed: matchingBoundaries >= 2 && safeTails ? requested : saved.committed };
}

export interface WeatherNarrativeOptions {
  family: NarrativeFamily;
  seed?: number;
  bars?: number;
  intensity?: number;
  mode?: NarrativeMode;
  palette?: "intended" | "neutral";
  composition?: "family" | "shared-melody";
  signature?: "world" | "foil";
  memory?: NarrativeMemoryV1;
}
interface MelodyCell { at: number; degree: number; duration: number }
export interface NarrativeSignatureOccurrenceV1 extends SignatureTransformationV1 { startTick: number; noteIds: string[] }
export interface NarrativeDocumentMetadataV1 {
  version: 1;
  profile: "weather-narrative-v1";
  family: NarrativeFamily;
  seed: number;
  bars: number;
  mode: NarrativeMode;
  requestedMode: NarrativeMode;
  committedMode: NarrativeMode;
  tonicPitchClass: 0;
  tempoBpm: number;
  meter: { numerator: number; denominator: number };
  palette: "intended" | "neutral";
  composition: "family" | "shared-melody";
  signatureId: string;
  signatureOccurrences: NarrativeSignatureOccurrenceV1[];
  cadence: { recipe: string; startTick: number; voicings: number[][]; borrowed: boolean };
  recall: { phraseId: string; intendedClosure: string; resolutionTick: number; reinterpretation: string } | null;
  memoryCandidate: Omit<NarrativePhraseV1, "ageSeconds" | "agePhrases" | "heardAtSeconds"> | null;
  memoryCandidateAudibleTick: number;
  listeningApproved: false;
}
const ROLES = ["traveler", "lead", "harmony", "bass", "percussion"] as const;
type Role = typeof ROLES[number];
function hash(seed: number, salt: number) {
  let x = Math.imul(seed ^ salt, 0x45d9f3b); x = Math.imul(x ^ (x >>> 16), 0x45d9f3b); return (x ^ (x >>> 16)) >>> 0;
}
function patch(id: string, name: string, waveform: Patch["waveform"], attack: number, release: number, brightness: number, duty = 0.5): Patch {
  return { id, name, waveform, attack, release, brightness, duty };
}
function narrativePatch(family: NarrativeFamily, role: Role, neutral: boolean): Patch {
  if (neutral) return patch("narrative-neutral-v1", "Neutral triangle study", "triangle", 0.012, 0.12, 0.35);
  if (role === "traveler") return patch(WORLD_SIGNATURE_V1.travelerPatchId, "Traveler airy reed", "triangle", 0.045, 0.28, 0.44);
  if (role === "percussion") return patch("narrative-drum-v1", "Soft dry weather drum", "noise", 0.002, 0.045, 0.16);
  if (role === "bass") return patch("narrative-bass-v1", "Round plucked bass", "sine", 0.008, 0.18, 0.18);
  if (role === "harmony") return family === "storm" ? patch("narrative-strings-v1", "Low bowed strings", "sawtooth", 0.09, 0.2, 0.2) : family === "fog" ? patch("narrative-distance-v1", "Distant hollow fifth", "sine", 0.25, 0.55, 0.1) : patch("narrative-soft-keys-v1", "Soft wooden keys", "triangle", 0.008, 0.22, 0.28);
  if (family === "clear") return patch("narrative-clear-pluck-v1", "Bright short pluck", "pulse", 0.006, 0.09, 0.52, 0.25);
  if (family === "fog") return patch("narrative-fog-reed-v1", "Low distant reed", "triangle", 0.18, 0.48, 0.17);
  if (family === "rain") return patch("narrative-rain-keys-v1", "Reflective soft keys", "sine", 0.012, 0.35, 0.32);
  if (family === "storm") return patch("narrative-storm-reed-v1", "Pressed low reed", "sawtooth", 0.018, 0.11, 0.3);
  return patch("narrative-return-reed-v1", "Open returning reed", "triangle", 0.045, 0.3, 0.46);
}
/** Original four-bar cells. Family material is independent of the shared signature. */
function melodyCell(family: NarrativeFamily, variant: number): MelodyCell[] {
  const rows: Record<NarrativeFamily, [number, number, number][][]> = {
    clear: [
      [[0,3,.75],[1,5,.5],[1.5,6,.5],[2.5,5,1],[4,2,.5],[4.5,3,.5],[5,5,1],[7,3,.5],[8,4,1],[9,6,.5],[9.5,8,.5],[10.5,7,.5],[12,5,1],[13,2,.5],[14,1,1]],
      [[0,1,.5],[.5,3,.5],[1.5,6,1],[3,5,.5],[4,3,.5],[5,4,.5],[6,5,1],[8,8,1],[9.5,6,.5],[10,5,1],[12,3,.75],[13,2,.5],[14,1,1]],
      [[0,5,.5],[1,6,.5],[2,8,1],[4,7,.5],[5,5,1],[7,3,.5],[8,4,.5],[8.5,6,.5],[10,5,1],[12,2,.5],[13,3,.5],[14,1,1]],
    ],
    fog: [
      [[3,5,2.7],[9,2,2.5]],
      [[0,7,2.8],[6,5,2.7],[10.5,4,1.3]],
      [[3,2,2.8],[9,1,2.8]],
    ],
    rain: [
      [[0,8,2.5],[3,6,.75],[4,5,2.5],[7,4,.75],[8,3,3],[12,2,2],[14.5,1,1]],
      [[0,6,2],[2.5,5,1],[4,3,2.5],[7,2,.75],[8,5,2],[10.5,4,1],[12,3,2.5]],
      [[0,5,3],[4,4,2],[6.5,3,1],[8,6,2.5],[11,5,.75],[12,2,2],[14.5,1,1]],
    ],
    storm: [
      [[0,1,.4],[.5,5,.4],[1.5,2,.4],[2,6,.7],[3.5,3,.4],[4,1,.4],[5,7,.4],[6,4,.8],[8,2,.4],[8.5,6,.4],[10,3,.7],[12,5,.4],[13,2,.4],[14,7,.8]],
      [[0,5,.4],[.5,1,.4],[1.5,6,.4],[2.5,2,.4],[4,7,.7],[5.5,3,.4],[6,1,.8],[8,6,.4],[9,2,.4],[10,5,.7],[12,4,.4],[13,2,.8]],
      [[0,1,.4],[1,6,.4],[2,2,.7],[3.5,5,.4],[4,3,.7],[6,7,.7],[8,5,.4],[8.5,2,.4],[10,6,.7],[12,1,.7],[13.5,4,.4]],
    ],
    clearing: [
      [[4,3,2.5],[8,5,1.5],[10,6,1],[12,5,1],[14,3,1.5]],
      [[0,1,2],[4,3,1.5],[6,5,1.5],[8,6,2],[11,5,.75],[12,3,1],[14,1,1.5]],
      [[0,5,1.5],[2,6,1],[4,8,2],[7,6,.75],[8,5,2],[12,2,1],[14,1,1.5]],
    ],
  };
  return rows[family][variant % 3].map(([at, degree, duration]) => ({ at, degree, duration }));
}

export function createWeatherNarrativeDocument(options: WeatherNarrativeOptions): PerformanceDocumentV1 {
  const family = options.family, bundle = NARRATIVE_CUE_BUNDLES[family];
  if (!bundle) throw Error("Unknown weather narrative family");
  const seed = options.seed ?? 1, bars = options.bars ?? 16, intensity = options.intensity ?? 0.55, mode = options.mode ?? bundle.mode;
  if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(bars) || bars < 4 || bars > 32 || !Number.isFinite(intensity) || intensity < 0 || intensity > 1 || !bundle.modes.includes(mode)) throw Error("Invalid narrative cue options");
  if (options.palette !== undefined && !["intended", "neutral"].includes(options.palette) || options.composition !== undefined && !["family", "shared-melody"].includes(options.composition) || options.signature !== undefined && !["world", "foil"].includes(options.signature)) throw Error("Invalid narrative comparison options");
  const palette = options.palette ?? "intended", composition = options.composition ?? "family", ppq = 480, beats = bundle.meter.numerator * 4 / bundle.meter.denominator;
  const barTicks = ppq * beats, lengthTicks = bars * barTicks;
  const binding = (role: Role) => `narrative-${family}-${role}`;
  const d: PerformanceDocumentV1 = {
    version: 1, kind: "expressive-performance", id: `weather-narrative-v1:${family}:${seed}:${mode}:${palette}:${composition}:${options.signature ?? "world"}:${bars}:${intensity}`,
    ppq, lengthTicks, tempoMap: [{ tick: 0, microsecondsPerBeat: 60000000 / bundle.tempoBpm }], meterMap: [{ tick: 0, ...bundle.meter }],
    parts: ROLES.map((role) => ({ id: role, name: role === "traveler" ? "Traveler world anchor" : `${family} ${role}`, role: role === "traveler" || role === "lead" ? "melody" : role === "percussion" ? "drums" : role, gain: role === "traveler" ? .24 : role === "lead" ? .22 : role === "bass" ? .26 : role === "percussion" ? .07 : .13, pan: role === "harmony" ? -.2 : role === "lead" ? .12 : 0 })),
    bindings: ROLES.map((role) => ({ id: binding(role), kind: "synth", resourceId: binding(role), patchId: narrativePatch(family, role, palette === "neutral").id })),
    resources: ROLES.map((role) => ({ id: binding(role), kind: "synth", patch: narrativePatch(family, role, palette === "neutral") })),
    notes: [], controls: [], instruments: ROLES.map((role) => ({ id: `entry:${family}:${role}`, partId: role, bindingId: binding(role), tick: 0 })), provenance: { source: "Original proposed weather narrative grammar v1", gainCurve: "cc-square-v1", diagnostics: [] },
  };
  function emit(role: Role, pulse: number, duration: number, pitch: number, velocity: number, label = "cell"): string {
    const releaseTicks = Math.ceil(narrativePatch(family, role, palette === "neutral").release * bundle.tempoBpm / 60 * ppq);
    // endTick owns the held/sustain end; the renderer adds its acoustic release once.
    // Reserve an authored breath so this synth profile releases before the next cue.
    const startTick = Math.round(pulse * ppq), keyReleaseTick = Math.min(lengthTicks - releaseTicks - ppq / 10, Math.round((pulse + duration) * ppq));
    if (startTick >= lengthTicks || keyReleaseTick <= startTick) return "";
    const id = `${family}:${seed}:${role}:${label}:${d.notes.length}`;
    d.notes.push({ id, partId: role, bindingId: binding(role), startTick, keyReleaseTick, endTick: keyReleaseTick, pitch, velocity: Math.max(.05, Math.min(.95, velocity)), priority: role === "traveler" ? 220 : role === "lead" ? 180 : role === "bass" ? 160 : 80, optional: role === "percussion" });
    return id;
  }
  const recall = family === "clearing" && bars >= 8 && options.memory ? selectNarrativeRecall(options.memory) : null;
  const occurrences: NarrativeSignatureOccurrenceV1[] = [];
  function signatureAt(pulse: number, fragment: [number, number], rhythmScale: 0.5 | 1 | 2 = 1) {
    const t = transformNarrativeSignature({ mode, fragment, rhythmScale, signature: options.signature, octave: 5 });
    occurrences.push({ ...t, startTick: Math.round(pulse * ppq), noteIds: t.pitches.map((pitch, i) => emit("traveler", pulse + t.onsetPulses[i], i === t.pitches.length - 1 ? rhythmScale * 1.5 : rhythmScale * .8, pitch, .65, "signature")).filter(Boolean) });
  }
  if (recall) {
    if (recall.intendedClosure === "dominant-tonic") {
      emit("traveler", 0, beats * .8, 71, .63, "dominant-obligation");
      emit("traveler", beats, .45, 72, .65, "tonic-resolution");
    }
    let at = recall.intendedClosure === "dominant-tonic" ? beats + .5 : 0;
    recall.motifDegrees.forEach((degree, i) => {
      emit("traveler", at, i === recall.motifDegrees.length - 1 ? 1.7 : Math.min(.9, recall.motifGaps[i] ?? 1), narrativeDegreePitch(degree, mode), .67, "recalled");
      at += recall.motifGaps[i] ?? 1;
    });
    signatureAt(beats * 2, [0, 4], .5);
  } else if (family === "fog") { signatureAt(0, [0, 2]); signatureAt(beats * 2, [2, 4]); }
  else signatureAt(0, [0, 4], family === "clearing" ? 2 : 1);
  // Repeat the world fragment only after 16 bars; most foreground material remains independent.
  if (bars > 16) signatureAt(16 * beats, [0, 2]);
  const cellFamily = composition === "shared-melody" ? "clear" : family;
  for (let phrase = 0; phrase * 4 < bars; phrase++) {
    const variant = hash(seed, phrase + 71) % 3;
    for (const cell of melodyCell(cellFamily, variant)) {
      const at = phrase * 4 * beats + cell.at * (cellFamily === "clear" && family === "fog" ? .75 : 1);
      // Let the traveler be heard at entry, and preserve complete deliberate breathing bars in fog.
      if (at < (recall ? beats * 2 : family === "fog" ? beats : 5)) continue;
      if (family === "clearing" && at >= (bars - 3) * beats || family === "storm" && at >= (bars - 2) * beats) continue;
      const octave = family === "fog" || family === "storm" ? 4 : 5;
      const duration = cell.duration * (family === "fog" && cellFamily === "clear" ? .75 : 1);
      emit("lead", at, duration, narrativeDegreePitch(cell.degree, mode, octave), .5 + intensity * .2 + (hash(seed, Math.floor(at * 16)) % 7) / 100);
    }
  }
  if (family === "storm") [1,6,2,5].forEach((degree, i) => emit("lead", (bars - 2) * beats + [0,.5,1,2][i], .4, narrativeDegreePitch(degree, mode, 4), .65, "remembered-angular-cell"));
  const roots: Record<NarrativeFamily, number[]> = { clear: [1,4,6,5], fog: [1,1,7,1], rain: [1,4,7,4], storm: [1,6,2,5,1,7,4,5], clearing: [1,4,6,5] };
  const cadenceVoicings: number[][] = [];
  let cadenceStart = (bars - (family === "clearing" ? 3 : 1)) * barTicks;
  for (let bar = 0; bar < bars; bar++) {
    const pulse = bar * beats;
    let root = roots[family][Math.floor(bar / Math.max(1, bundle.harmonicBars)) % roots[family].length];
    let voicing = [root, root + 2, root + 4].map((n) => narrativeDegreePitch(n, mode, 4));
    let bass = narrativeDegreePitch(root, mode, 3);
    let borrowed = false;
    if (family === "fog") { voicing = [48,55]; bass = 36; }
    if (family === "clear" && bar === bars - 1) { voicing = [48,52,55]; bass = 36; }
    if (family === "storm" && bar === bars - 1) { voicing = mode === "phrygian" ? [48,55] : [47,50,55]; bass = mode === "phrygian" ? 36 : 43; borrowed = mode !== "phrygian"; }
    if (family === "clearing" && bar >= bars - 3) {
      const index = bar - (bars - 3);
      voicing = options.signature === "foil" ? [[48,53,57],[50,53,57],[48,52,55]][index] : [[48,51,56],[50,53,58],[48,52,55]][index];
      bass = options.signature === "foil" ? [41,38,36][index] : [44,46,36][index]; borrowed = index < 2;
      cadenceVoicings.push([...voicing]);
      emit("traveler", pulse, beats * .8, [68,70,72][index], .55 + index * .06, "home-return");
    }
    if (recall?.intendedClosure === "dominant-tonic" && bar < 2) {
      voicing = bar === 0 ? [47,50,55] : [48,52,55]; bass = bar === 0 ? 43 : 36; borrowed = bar === 0;
    }
    const bassFifth = (MODE_INTERVALS[mode] as readonly number[]).includes((bass + 7) % 12) ? bass + 7 : bass + 6;
    if (family === "fog") {
      if (bar % 4 === 0) voicing.forEach((pitch) => emit("harmony", pulse, beats * Math.min(3.7, bars - bar), pitch, .35, "pedal"));
      if (bar % 4 === 0) emit("bass", pulse, beats * 3.6, bass, .42);
      if (bar % 4 === 2) emit("harmony", pulse + 2, .35, narrativeDegreePitch(5, mode, 6), .3, "distant-bell");
    } else if (family === "rain") {
      // Repeating eighth accompaniment under slow, independent descending phrases.
      for (let step = 0; step < beats * 2; step++) emit("harmony", pulse + step * .5, .42, voicing[step % voicing.length] + (step % 4 === 3 ? 12 : 0), .34 + intensity * .1);
      if (bar % 2 === 0) emit("bass", pulse, beats * 1.8, bass, .5);
    } else if (family === "storm" && bar !== bars - 1) {
      const halfRoot = roots.storm[(bar * 2 + 1) % roots.storm.length];
      const secondVoicing = [halfRoot, halfRoot + 2, halfRoot + 4].map((n) => narrativeDegreePitch(n, mode, 4));
      for (let half = 0; half < 2; half++) (half ? secondVoicing : voicing).forEach((pitch) => emit("harmony", pulse + half * 2, 1.45, pitch, .42 + intensity * .13));
      for (let step = 0; step < 8; step++) {
        if (bar % 4 === 3 && step >= 4) continue;
        emit("bass", pulse + step * .5, .37, (step % 2 ? bassFifth : bass), .58 + intensity * .12);
        if (step % 2 === 0 || intensity > .7) emit("percussion", pulse + step * .5, .09, step % 4 === 0 ? 36 : 42, .4 + intensity * .18);
      }
    } else {
      const sparse = family === "clearing" && bar < bars / 2;
      voicing.forEach((pitch) => emit("harmony", pulse, sparse ? beats * .9 : 1.4, pitch, .38 + intensity * .1, borrowed ? "borrowed-cadence" : "chord"));
      if (!sparse && family !== "storm") voicing.forEach((pitch) => emit("harmony", pulse + 2, 1.1, pitch, .32));
      emit("bass", pulse, sparse ? 2.8 : 1.2, bass, .57);
      if (!sparse && family !== "storm") emit("bass", pulse + 2, .9, bassFifth, .46);
    }
    if (family === "clear" && bar === bars - 1) emit("lead", pulse, 3.4, 72, .6, "tonic-ending");
    if (family === "storm" && bar === bars - 1) emit("lead", pulse, 2.8, mode === "phrygian" ? 70 : 71, .66, mode === "phrygian" ? "modal-open-ending" : "leading-tone-expectation");
  }
  const map = createTempoMap(ppq, d.tempoMap);
  for (let phrase = 0; phrase * 4 < bars; phrase++) {
    const tick = phrase * 4 * barTicks;
    for (const role of ["lead", "harmony", "traveler"] as const) d.controls.push({ id: `${family}:phrase:${phrase}:${role}`, partId: role, parameter: "expression", timeSeconds: map.tickToSeconds(tick), value: family === "clearing" ? .65 + .3 * phrase / Math.max(1, Math.ceil(bars / 4) - 1) : family === "storm" ? .8 + intensity * .18 : .88, rampSeconds: Math.min(1.1, map.tickToSeconds(lengthTicks) - map.tickToSeconds(tick)) });
  }
  d.notes.sort((a,b) => a.startTick - b.startTick || a.id.localeCompare(b.id));
  const lastMelody = d.notes.filter((n) => n.partId === "lead" || n.partId === "traveler").sort((a,b) => b.startTick - a.startTick)[0];
  const finalScaleIndex = (MODE_INTERVALS[mode] as readonly number[]).indexOf(lastMelody.pitch % 12);
  const memoryCandidateAudibleTick = Math.max(lengthTicks - barTicks, lastMelody.keyReleaseTick);
  const memoryCandidate = family === "storm" || family === "fog" ? {
    phraseId: `${d.id}:ending-phrase`, sourceFamily: family, signatureId: options.signature === "foil" ? "weather-foil-world-v1" : WORLD_SIGNATURE_V1.id, variationSeed: seed,
    motifDegrees: family === "storm" ? [1,6,2,5] : [1,2], motifGaps: family === "storm" ? [.5,.5,1] : [1], tonicPitchClass: 0, mode,
    endingVoicing: family === "storm" && mode !== "phrygian" ? [47,50,55] : [48,55], endingMelodicDegree: finalScaleIndex < 0 ? 7 : finalScaleIndex + 1,
    endingMelodicPitch: lastMelody.pitch, endingAlterationSemitones: finalScaleIndex < 0 ? 1 : 0,
    intendedClosure: family === "storm" && mode !== "phrygian" ? "dominant-tonic" as const : "pedal" as const,
    status: family === "storm" ? "interrupted" as const : "open" as const, priority: family === "storm" ? 2 : 1, admissionRevision: 1, epoch: 1,
  } : null;
  const metadata: NarrativeDocumentMetadataV1 = {
    version: 1, profile: "weather-narrative-v1", family, seed, bars, mode, requestedMode: mode, committedMode: mode, tonicPitchClass: 0, tempoBpm: bundle.tempoBpm, meter: { ...bundle.meter }, palette, composition,
    signatureId: options.signature === "foil" ? "weather-foil-world-v1" : WORLD_SIGNATURE_V1.id, signatureOccurrences: occurrences,
    cadence: { recipe: family === "storm" && mode === "phrygian" ? "modal-open-fifth" : family === "clearing" ? options.signature === "foil" ? "IV-ii-I" : "bVI-bVII-I" : bundle.ending, startTick: cadenceStart, voicings: cadenceVoicings, borrowed: family === "clearing" || family === "storm" && mode !== "phrygian" },
    recall: recall ? { phraseId: recall.phraseId, intendedClosure: recall.intendedClosure!, resolutionTick: recall.intendedClosure === "dominant-tonic" ? barTicks : lengthTicks - barTicks, reinterpretation: "Stored degrees and pulse gaps replayed in entry mode; sounding source voices are released" } : null,
    memoryCandidate, memoryCandidateAudibleTick, listeningApproved: false,
  };
  if (recall) d.id += `:recall:${hash(seed, [...JSON.stringify(recall)].reduce((n,c) => Math.imul(n,31) + c.charCodeAt(0), 0))}`;
  d.provenance.weatherNarrative = metadata;
  assertPerformanceDocument(d);
  return d;
}

export interface WeatherNarrativeJourneyOptions { seed?: number; families?: NarrativeFamily[]; barsPerCue?: number; palette?: "intended" | "neutral"; composition?: "family" | "shared-melody"; signature?: "world" | "foil"; recall?: boolean }
/** Frozen symbolic journey with explicit phrase exits. Memory is simulated at known passage
 * frontiers for this offline exemplar; live callers must use actual heard-frontier callbacks. */
export function createWeatherNarrativeJourney(options: WeatherNarrativeJourneyOptions = {}): PerformanceDocumentV1 {
  const families = options.families ?? ["clear", "fog", "rain", "storm", "clearing"];
  if (!families.length || families.length > 8) throw Error("Narrative journey requires 1–8 cues");
  let memory = createNarrativeMemory(), tickOffset = 0, secondsOffset = 0;
  const docs: PerformanceDocumentV1[] = [];
  const segments: (NarrativeDocumentMetadataV1 & { startTick: number; endTick: number; startSeconds: number; endSeconds: number })[] = [];
  for (let index = 0; index < families.length; index++) {
    const doc = createWeatherNarrativeDocument({ family: families[index], seed: (options.seed ?? 1) + index * 101, bars: options.barsPerCue, palette: options.palette, composition: options.composition, signature: options.signature, memory: options.recall === false ? undefined : memory });
    const meta = doc.provenance.weatherNarrative as NarrativeDocumentMetadataV1;
    const duration = createTempoMap(doc.ppq, doc.tempoMap).tickToSeconds(doc.lengthTicks);
    segments.push({ ...structuredClone(meta), startTick: tickOffset, endTick: tickOffset + doc.lengthTicks, startSeconds: secondsOffset, endSeconds: secondsOffset + duration });
    if (meta.memoryCandidate) {
      const at = secondsOffset + createTempoMap(doc.ppq, doc.tempoMap).tickToSeconds(meta.memoryCandidateAudibleTick);
      memory = admitNarrativeMemoryEvent(memory, { id: `journey:remember:${index}`, epoch: 1, revision: 1, audibleAtSeconds: at, action: { type: "remember", phrase: meta.memoryCandidate } });
    }
    if (meta.recall) memory = admitNarrativeMemoryEvent(memory, { id: `journey:resolve:${index}`, epoch: 1, revision: 1, audibleAtSeconds: secondsOffset + createTempoMap(doc.ppq, doc.tempoMap).tickToSeconds(meta.recall.resolutionTick), action: { type: "resolve", phraseId: meta.recall.phraseId, closure: meta.recall.intendedClosure as "tonic" | "dominant-tonic" | "home-return" | "pedal" } });
    memory = advanceNarrativeMemory(memory, secondsOffset + duration);
    // Prefix identities so repeated families/seeds remain unambiguous.
    const noteIds = new Map(doc.notes.map((n) => [n.id, `cue${index}:${n.id}`]));
    doc.notes = doc.notes.map((n) => ({ ...n, id: noteIds.get(n.id)!, startTick: n.startTick + tickOffset, keyReleaseTick: n.keyReleaseTick + tickOffset, endTick: n.endTick + tickOffset }));
    doc.controls = doc.controls.map((c) => ({ ...c, id: `cue${index}:${c.id}`, noteId: c.noteId ? noteIds.get(c.noteId) : undefined, timeSeconds: c.timeSeconds + secondsOffset, ...(c.sourceTick === undefined ? {} : { sourceTick: c.sourceTick + tickOffset }) }));
    doc.instruments = doc.instruments.map((i) => ({ ...i, id: `cue${index}:${i.id}`, tick: i.tick + tickOffset }));
    doc.tempoMap = doc.tempoMap.map((t) => ({ ...t, tick: t.tick + tickOffset }));
    doc.meterMap = doc.meterMap.map((m) => ({ ...m, tick: m.tick + tickOffset }));
    tickOffset += doc.lengthTicks; secondsOffset += duration; docs.push(doc);
  }
  const unique = <T extends {id: string}>(items: T[]): T[] => [...new Map(items.map((i) => [i.id,i])).values()];
  const d: PerformanceDocumentV1 = { ...docs[0], id: `weather-narrative-journey-v1:${options.seed ?? 1}:${families.join("-")}:${options.barsPerCue ?? 16}:${options.palette ?? "intended"}:${options.signature ?? "world"}:${options.composition ?? "family"}:${options.recall !== false}`, lengthTicks: tickOffset,
    parts: docs[0].parts.map((p) => ({ ...p, name: `Narrative ${p.id}` })), bindings: unique(docs.flatMap((d) => d.bindings)), resources: unique(docs.flatMap((d) => d.resources)), notes: docs.flatMap((d) => d.notes), controls: docs.flatMap((d) => d.controls), instruments: docs.flatMap((d) => d.instruments), tempoMap: docs.flatMap((d) => d.tempoMap), meterMap: docs.flatMap((d) => d.meterMap), provenance: { source: "Original frozen weather narrative journey v1", gainCurve: "cc-square-v1", diagnostics: [], weatherNarrative: { version: 1, profile: "weather-narrative-v1", segments, memorySimulation: memory, memoryEvidence: "offline-symbolic-frontiers-only", transitions: segments.slice(1).map((s, i) => ({ source: segments[i].family, destination: s.family, tick: s.startTick, tailPolicy: "synth-profile-release-before-entry", tempoMeterPolicy: "boundary-reset", breathQuarterPulses: .1 })), listeningApproved: false } } };
  assertPerformanceDocument(d);
  return d;
}
