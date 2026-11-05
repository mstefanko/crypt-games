/** Heard musical history, independent of speculative composition/scheduler windows. */
export type NarrativeFamily = "clear" | "fog" | "rain" | "storm" | "clearing";
export type NarrativeMode = "ionian" | "lydian" | "mixolydian" | "dorian" | "aeolian" | "phrygian";
export type NarrativeClosure = "tonic" | "dominant-tonic" | "home-return" | "pedal";
export interface NarrativePhraseV1 {
  phraseId: string;
  sourceFamily: NarrativeFamily;
  signatureId: string;
  variationSeed: number;
  /** One-based scale degrees and onset gaps in quarter-note pulses. */
  motifDegrees: number[];
  motifGaps: number[];
  tonicPitchClass: number;
  mode: NarrativeMode;
  endingVoicing: number[];
  endingMelodicDegree: number;
  /** Actual heard pitch and explicit borrowing, where degree/mode alone is insufficient. */
  endingMelodicPitch?: number;
  endingAlterationSemitones?: number;
  intendedClosure: NarrativeClosure | null;
  status: "open" | "interrupted" | "resolved" | "abandoned";
  ageSeconds: number;
  agePhrases: number;
  priority: number;
  admissionRevision: number;
  epoch: number;
  heardAtSeconds: number;
}
export interface NarrativeMemoryEventV1 {
  id: string;
  epoch: number;
  revision: number;
  audibleAtSeconds: number;
  action: { type: "remember"; phrase: Omit<NarrativePhraseV1, "ageSeconds" | "agePhrases" | "heardAtSeconds"> }
    | { type: "resolve"; phraseId: string; closure: NarrativeClosure };
}
export interface NarrativeMemoryV1 {
  version: 1;
  frontierSeconds: number;
  expirySeconds: number;
  pending: NarrativePhraseV1[];
  fulfilled: NarrativePhraseV1 | null;
  admitted: NarrativeMemoryEventV1[];
  /** Bounded audit of explicit expiry/overflow abandonment. */
  abandoned: { phraseId: string; reason: "expired" | "overflow"; atSeconds: number }[];
}
const FAMILIES: NarrativeFamily[] = ["clear", "fog", "rain", "storm", "clearing"];
const MODES: NarrativeMode[] = ["ionian", "lydian", "mixolydian", "dorian", "aeolian", "phrygian"];
const CLOSURES: NarrativeClosure[] = ["tonic", "dominant-tonic", "home-return", "pedal"];
const boundedInteger = (value: number, minimum: number, maximum: number) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
function validatePhrase(p: Omit<NarrativePhraseV1, "ageSeconds" | "agePhrases" | "heardAtSeconds">, statuses = ["open", "interrupted"]) {
  if (!p || typeof p.phraseId !== "string" || !p.phraseId.length || p.phraseId.length > 1024 || typeof p.signatureId !== "string" || !p.signatureId.length || p.signatureId.length > 256 || !FAMILIES.includes(p.sourceFamily) || !MODES.includes(p.mode) || !statuses.includes(p.status) || !Number.isSafeInteger(p.variationSeed) || !boundedInteger(p.tonicPitchClass, 0, 11) || !boundedInteger(p.priority, 0, 255) || !boundedInteger(p.epoch, 0, Number.MAX_SAFE_INTEGER) || !boundedInteger(p.admissionRevision, 0, Number.MAX_SAFE_INTEGER) || !boundedInteger(p.endingMelodicDegree, -14, 21) || p.intendedClosure !== null && !CLOSURES.includes(p.intendedClosure)) throw Error("Invalid narrative phrase identity");
  if (p.endingMelodicPitch !== undefined && !boundedInteger(p.endingMelodicPitch, 0, 127) || p.endingAlterationSemitones !== undefined && !boundedInteger(p.endingAlterationSemitones, -2, 2)) throw Error("Invalid narrative ending pitch");
  if (!Array.isArray(p.motifDegrees) || p.motifDegrees.length < 2 || p.motifDegrees.length > 16 || p.motifDegrees.some((n) => !boundedInteger(n, -14, 21)) || !Array.isArray(p.motifGaps) || p.motifGaps.length !== p.motifDegrees.length - 1 || p.motifGaps.some((g) => !Number.isFinite(g) || g <= 0 || g > 16) || !Array.isArray(p.endingVoicing) || !p.endingVoicing.length || p.endingVoicing.length > 8 || p.endingVoicing.some((n) => !boundedInteger(n, 0, 127))) throw Error("Invalid narrative phrase material");
}
export function assertNarrativeMemory(value: unknown): asserts value is NarrativeMemoryV1 {
  const m = value as NarrativeMemoryV1;
  if (!m || m.version !== 1 || !Number.isFinite(m.frontierSeconds) || m.frontierSeconds < 0 || !Number.isFinite(m.expirySeconds) || m.expirySeconds <= 0 || !Array.isArray(m.pending) || m.pending.length > 4 || !Array.isArray(m.admitted) || m.admitted.length > 128 || !Array.isArray(m.abandoned) || m.abandoned.length > 16) throw Error("Invalid narrative memory checkpoint");
  const ids = new Set<string>();
  for (const p of m.pending) {
    validatePhrase(p);
    if (ids.has(p.phraseId) || !Number.isFinite(p.ageSeconds) || p.ageSeconds < 0 || !boundedInteger(p.agePhrases, 0, Number.MAX_SAFE_INTEGER) || !Number.isFinite(p.heardAtSeconds) || p.heardAtSeconds < 0 || p.heardAtSeconds > m.frontierSeconds) throw Error("Invalid heard narrative phrase");
    ids.add(p.phraseId);
  }
  if (m.fulfilled !== null) validatePhrase(m.fulfilled, ["resolved"]);
  const eventIds = new Set<string>();
  for (const e of m.admitted) {
    validateEvent(e, m.frontierSeconds);
    if (eventIds.has(e.id)) throw Error("Duplicate memory admission");
    eventIds.add(e.id);
  }
}
function validateEvent(event: NarrativeMemoryEventV1, frontier: number) {
  if (!event || typeof event.id !== "string" || !event.id.length || event.id.length > 1024 || !boundedInteger(event.epoch, 0, Number.MAX_SAFE_INTEGER) || !boundedInteger(event.revision, 0, Number.MAX_SAFE_INTEGER) || !Number.isFinite(event.audibleAtSeconds) || event.audibleAtSeconds < frontier || !event.action) throw Error("Invalid memory admission");
  if (event.action.type === "remember") {
    validatePhrase(event.action.phrase);
    if (event.action.phrase.epoch !== event.epoch || event.action.phrase.admissionRevision !== event.revision) throw Error("Narrative admission provenance mismatch");
  } else if (event.action.type !== "resolve" || typeof event.action.phraseId !== "string" || !event.action.phraseId.length || !CLOSURES.includes(event.action.closure)) throw Error("Invalid memory resolution");
}
export function createNarrativeMemory(expirySeconds = 120): NarrativeMemoryV1 {
  if (!Number.isFinite(expirySeconds) || expirySeconds <= 0) throw Error("Invalid narrative memory expiry");
  return { version: 1, frontierSeconds: 0, expirySeconds, pending: [], fulfilled: null, admitted: [], abandoned: [] };
}
export function admitNarrativeMemoryEvent(memory: NarrativeMemoryV1, event: NarrativeMemoryEventV1): NarrativeMemoryV1 {
  assertNarrativeMemory(memory);
  validateEvent(event, memory.frontierSeconds);
  if (memory.admitted.some((e) => e.id === event.id)) throw Error("Duplicate memory admission");
  if (memory.admitted.length >= 128) throw Error("Narrative memory admission limit");
  return { ...structuredClone(memory), admitted: [...structuredClone(memory.admitted), structuredClone(event)].sort((a, b) => a.audibleAtSeconds - b.audibleAtSeconds || a.id.localeCompare(b.id)) };
}
/** Cancel only future events belonging to the superseded admission, never heard history. */
export function cancelNarrativeMemoryRevision(memory: NarrativeMemoryV1, epoch: number, revision: number): NarrativeMemoryV1 {
  assertNarrativeMemory(memory);
  if (!boundedInteger(epoch, 0, Number.MAX_SAFE_INTEGER) || !boundedInteger(revision, 0, Number.MAX_SAFE_INTEGER)) throw Error("Invalid cancellation revision");
  return { ...structuredClone(memory), admitted: memory.admitted.filter((e) => e.epoch !== epoch || e.revision !== revision).map((e) => structuredClone(e)) };
}
export function advanceNarrativeMemory(memory: NarrativeMemoryV1, heardFrontierSeconds: number): NarrativeMemoryV1 {
  assertNarrativeMemory(memory);
  if (!Number.isFinite(heardFrontierSeconds) || heardFrontierSeconds < memory.frontierSeconds) throw Error("Heard frontier must advance monotonically");
  const next = structuredClone(memory);
  function age(to: number) {
    const elapsed = to - next.frontierSeconds;
    for (const p of next.pending) p.ageSeconds += elapsed;
    next.frontierSeconds = to;
    next.pending = next.pending.filter((p) => {
      if (p.ageSeconds <= next.expirySeconds) return true;
      next.abandoned.push({ phraseId: p.phraseId, reason: "expired", atSeconds: to });
      return false;
    });
  }
  const audible = next.admitted.filter((e) => e.audibleAtSeconds <= heardFrontierSeconds);
  next.admitted = next.admitted.filter((e) => e.audibleAtSeconds > heardFrontierSeconds);
  for (const event of audible) {
    age(event.audibleAtSeconds);
    const action = event.action;
    if (action.type === "remember") {
      if (next.pending.some((p) => p.phraseId === action.phrase.phraseId) || next.fulfilled?.phraseId === action.phrase.phraseId) continue;
      for (const p of next.pending) p.agePhrases++;
      next.pending.push({ ...action.phrase, ageSeconds: 0, agePhrases: 0, heardAtSeconds: event.audibleAtSeconds });
      if (next.pending.length > 4) {
        const victim = [...next.pending].sort((a, b) => a.priority - b.priority || a.heardAtSeconds - b.heardAtSeconds)[0];
        next.pending = next.pending.filter((p) => p !== victim);
        next.abandoned.push({ phraseId: victim.phraseId, reason: "overflow", atSeconds: event.audibleAtSeconds });
      }
    } else {
      const phrase = next.pending.find((p) => p.phraseId === action.phraseId);
      // A signature return does not discharge a dominant-tonic obligation.
      if (phrase && phrase.intendedClosure === action.closure) {
        next.fulfilled = { ...phrase, status: "resolved" };
        next.pending = next.pending.filter((p) => p !== phrase);
      }
    }
  }
  age(heardFrontierSeconds);
  next.abandoned = next.abandoned.slice(-16);
  return next;
}
export function selectNarrativeRecall(memory: NarrativeMemoryV1): NarrativePhraseV1 | null {
  assertNarrativeMemory(memory);
  const eligible = memory.pending.filter((p) => (p.status === "interrupted" || p.status === "open") && p.intendedClosure !== null && p.ageSeconds <= memory.expirySeconds);
  eligible.sort((a, b) => Number(b.status === "interrupted") - Number(a.status === "interrupted") || b.heardAtSeconds - a.heardAtSeconds || b.priority - a.priority);
  return eligible.length ? structuredClone(eligible[0]) : null;
}
