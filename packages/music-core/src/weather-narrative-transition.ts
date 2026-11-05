import type { NarrativeFamily } from "./weather-narrative-memory";

export type NarrativeExitClass = "phrase" | "open" | "pedal" | "beat";
export interface NarrativeSeamProfile {
  meter: "continuous" | "declared-break";
  timbre: "continuous" | "change";
  pitch: "cadential" | "common-tone" | "released";
  volume: "continuous" | "breath" | "accent";
  abruptness: "prepared" | "designed-cutoff";
}
export interface NarrativeTransitionEdgeV1 {
  id: string;
  source: NarrativeFamily;
  destination: NarrativeFamily;
  allowedExits: NarrativeExitClass[];
  maxWaitSeconds: number;
  maxSourceBars: number;
  tempoMeterPolicy: "preserve" | "boundary-reset";
  tailPolicy: "compatible-only" | "release-before-entry";
  memoryAction: "preserve" | "interrupt" | "recall";
}
const FAMILIES: NarrativeFamily[] = ["clear", "fog", "rain", "storm", "clearing"];
export const NARRATIVE_TRANSITION_GRAPH: readonly NarrativeTransitionEdgeV1[] = FAMILIES.flatMap((source) => FAMILIES.map((destination) => ({
  id: `${source}->${destination}`, source, destination,
  allowedExits: source === destination ? ["phrase", "open", "pedal", "beat"] as NarrativeExitClass[] : ["phrase", "open", "pedal"] as NarrativeExitClass[],
  maxWaitSeconds: 8, maxSourceBars: 4,
  tempoMeterPolicy: source === destination ? "preserve" as const : "boundary-reset" as const,
  tailPolicy: source === destination ? "compatible-only" as const : "release-before-entry" as const,
  memoryAction: destination === "clearing" ? "recall" as const : destination === "storm" ? "interrupt" as const : "preserve" as const,
})));
for (const edge of NARRATIVE_TRANSITION_GRAPH) {
  Object.freeze(edge.allowedExits);
  Object.freeze(edge);
}
Object.freeze(NARRATIVE_TRANSITION_GRAPH);
export interface NarrativeTransitionExit {
  atSeconds: number;
  sourceBarsFromRequest: number;
  exitClass: NarrativeExitClass;
  sourceVoicing: number[];
  destinationVoicing: number[];
  /** Author approval of this exact voicing; common tones alone are insufficient. */
  approvedOverlap: boolean;
  /** Phrase-to-entry cadence is authored for these actual voicings. */
  approvedCadence?: boolean;
  bridgeSeconds?: number;
}
export interface NarrativeTransitionRequest {
  source: NarrativeFamily;
  destination: NarrativeFamily;
  observedAtSeconds: number;
  stableAtSeconds: number;
  nowSeconds: number;
  committedThroughSeconds: number;
  lastEntrySeconds: number;
  sourceBarSeconds: number;
  nextUncommittedBeatSeconds: number;
  /** Needed if the supplied beat falls behind the admission/dwell frontier. */
  beatSeconds?: number;
  meterChanges: boolean;
  urgent?: boolean;
  exits: NarrativeTransitionExit[];
}
export interface NarrativeTransitionPlanV1 {
  version: 1;
  edgeId: string;
  strategy: "role-change" | "cadence-pickup" | "pedal-bridge" | "breath-pickup" | "urgent-accent";
  observedAtSeconds: number;
  stableAtSeconds: number;
  exitSeconds: number;
  entrySeconds: number;
  responseSeconds: number;
  budgetMet: boolean;
  reason: string;
  tailPolicy: NarrativeTransitionEdgeV1["tailPolicy"];
  memoryAction: NarrativeTransitionEdgeV1["memoryAction"];
  seam: NarrativeSeamProfile;
}
/** Pure planner: callers must cancel superseded future revisions and preserve committed attacks. */
export function planNarrativeTransition(r: NarrativeTransitionRequest): NarrativeTransitionPlanV1 {
  const times = [r.observedAtSeconds, r.stableAtSeconds, r.nowSeconds, r.committedThroughSeconds, r.lastEntrySeconds, r.nextUncommittedBeatSeconds];
  if (times.some((t) => !Number.isFinite(t) || t < 0) || r.sourceBarSeconds <= 0 || !Number.isFinite(r.sourceBarSeconds) || r.stableAtSeconds < r.observedAtSeconds)
    throw Error("Invalid narrative transition timing");
  const edge = NARRATIVE_TRANSITION_GRAPH.find((e) => e.source === r.source && e.destination === r.destination);
  if (!edge) throw Error("Unknown narrative transition edge");
  const earliest = Math.max(r.nowSeconds, r.committedThroughSeconds, r.stableAtSeconds, r.urgent ? 0 : r.lastEntrySeconds + 8);
  const deadline = r.stableAtSeconds + Math.min(edge.maxWaitSeconds, edge.maxSourceBars * r.sourceBarSeconds);
  let strategy: NarrativeTransitionPlanV1["strategy"] = "breath-pickup";
  let exitSeconds = earliest;
  let entrySeconds = earliest + 0.25;
  let reason = "No approved exit meets both deadlines; authored release and breath";
  let pitch: NarrativeSeamProfile["pitch"] = "released";
  if (r.urgent) {
    strategy = "urgent-accent";
    // Preparation horizons can make the one-second target impossible; report it honestly.
    if (r.nextUncommittedBeatSeconds < earliest && (!r.beatSeconds || !Number.isFinite(r.beatSeconds) || r.beatSeconds <= 0)) throw Error("Urgent transition needs a beat at/after admission frontier or a beat period");
    exitSeconds = r.nextUncommittedBeatSeconds >= earliest ? r.nextUncommittedBeatSeconds : r.nextUncommittedBeatSeconds + Math.ceil((earliest - r.nextUncommittedBeatSeconds) / r.beatSeconds!) * r.beatSeconds!;
    entrySeconds = exitSeconds + 0.025;
    reason = "Explicit urgent event: click-safe release into destination accent";
  } else {
    const candidates = [...r.exits].sort((a, b) => a.atSeconds - b.atSeconds);
    for (const e of candidates) {
      if (!Number.isFinite(e.atSeconds) || !Number.isFinite(e.sourceBarsFromRequest) || e.sourceBarsFromRequest < 0 || (e.bridgeSeconds !== undefined && (!Number.isFinite(e.bridgeSeconds) || e.bridgeSeconds < 0))) throw Error("Invalid narrative exit");
      const bridge = e.bridgeSeconds ?? 0.5;
      const sharedTone = e.approvedOverlap && harmonicTransitionFeatures(e.sourceVoicing, e.destinationVoicing).commonPitchClasses > 0;
      const cadential = e.exitClass === "phrase" && e.approvedCadence;
      const duration = r.source === r.destination ? 0 : cadential ? 0 : sharedTone && !r.meterChanges ? bridge : 0.25;
      if (e.atSeconds < earliest || e.atSeconds + duration > deadline || e.sourceBarsFromRequest > edge.maxSourceBars || !edge.allowedExits.includes(e.exitClass)) continue;
      exitSeconds = e.atSeconds;
      entrySeconds = e.atSeconds + duration;
      if (r.source === r.destination) { strategy = "role-change"; pitch = "common-tone"; }
      else if (cadential) { strategy = "cadence-pickup"; pitch = "cadential"; }
      else if (sharedTone && !r.meterChanges) { strategy = "pedal-bridge"; pitch = "common-tone"; }
      else strategy = "breath-pickup";
      reason = "First authored exit meeting admission, dwell, time and source-bar budgets";
      break;
    }
  }
  const responseSeconds = entrySeconds - r.stableAtSeconds;
  return { version: 1, edgeId: edge.id, strategy, observedAtSeconds: r.observedAtSeconds, stableAtSeconds: r.stableAtSeconds, exitSeconds, entrySeconds, responseSeconds,
    budgetMet: r.urgent ? responseSeconds <= 1 : entrySeconds <= deadline,
    reason, tailPolicy: strategy === "role-change" || strategy === "pedal-bridge" ? "compatible-only" : "release-before-entry", memoryAction: edge.memoryAction,
    seam: { meter: r.meterChanges || strategy === "breath-pickup" || strategy === "urgent-accent" ? "declared-break" : "continuous", timbre: r.source === r.destination ? "continuous" : "change", pitch, volume: strategy === "breath-pickup" ? "breath" : strategy === "urgent-accent" ? "accent" : "continuous", abruptness: r.urgent ? "designed-cutoff" : "prepared" } };
}
/** Separate pitch-class similarity, actual-register movement and bass motion. */
export function harmonicTransitionFeatures(source: readonly number[], destination: readonly number[]) {
  if (!source.length || source.length !== destination.length || source.length > 6 || [...source, ...destination].some((n) => !Number.isInteger(n) || n < 0 || n > 127)) throw Error("Expected equal bounded MIDI voicings");
  const pc = (n: number) => n % 12;
  const commonPitchClasses = new Set(source.map(pc).filter((p) => destination.some((n) => pc(n) === p))).size;
  function minimum(remaining: number[], index = 0): number {
    if (!remaining.length) return 0;
    return Math.min(...remaining.map((n, i) => Math.abs(source[index] - n) + minimum(remaining.filter((_, j) => i !== j), index + 1)));
  }
  return { commonPitchClasses, minimumSemitoneMovement: minimum([...destination]), bassMovement: Math.min(...destination) - Math.min(...source), sourceVoicing: [...source], destinationVoicing: [...destination] };
}
