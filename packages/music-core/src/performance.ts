import type { Patch, Score, Track } from "@onepage/project";
import { assertPlayableScore } from "./score-validation";
import {
  validateInstrumentPalette,
  type InstrumentPalette,
} from "./instrument-palette";
import type { CompiledNote } from "./runtime";

/** Absolute onset-owned note. Its duration is never clipped to a scheduling window. */
export interface PerformanceNote extends CompiledNote {
  priority: number;
  optional: boolean;
}
export interface RoleGainEvent {
  id: string;
  role: Track["role"];
  timeSeconds: number;
  value: number;
  rampSeconds: number;
}
export interface PerformanceDeviation {
  kind: "skipped" | "stolen" | "interrupted" | "underrun" | "capture-overflow";
  timeSeconds: number;
  noteId?: string;
  reason: string;
}
export interface PerformanceTakeBase {
  id: string;
  bpm: number;
  ppq: 480;
  lengthTicks: number;
  tracks: Track[];
  patches: Patch[];
  notes: PerformanceNote[];
  automation: RoleGainEvent[];
  deviations: PerformanceDeviation[];
}
export interface EffectivePerformanceEvent {
  tick: number;
  tonic: number;
  mode: "ionian" | "lydian" | "mixolydian" | "dorian" | "aeolian" | "phrygian";
  ensemble: string;
  partIds: string[];
}
export interface PerformanceTakeV1 extends PerformanceTakeBase {
  version: 1;
}
export interface PerformanceTakeV2 extends PerformanceTakeBase {
  version: 2;
  acoustic: PerformanceAcousticProfile;
  timeline: EffectivePerformanceEvent[];
}
export interface PerformanceAcousticProfile {
  palette: InstrumentPalette;
  renderingProfile: string;
}
export type PerformanceTake = PerformanceTakeV1 | PerformanceTakeV2;
export const PERFORMANCE_LIMITS = {
  notes: 8192,
  automation: 2048,
  deviations: 2048,
  seconds: 600,
  bytes: 4 * 1024 * 1024,
} as const;
const roles = ["melody", "bass", "harmony", "drums"] as const;
function finiteRange(n: number, lo: number, hi: number, label: string): void {
  if (!Number.isFinite(n) || n < lo || n > hi) throw Error(`Invalid ${label}`);
}
function unique(items: { id: string }[], label: string): void {
  const ids = new Set<string>();
  for (const { id } of items) {
    if (typeof id !== "string" || !id.length || id.length > 128 || ids.has(id))
      throw Error(`Invalid/duplicate ${label} id`);
    ids.add(id);
  }
}
/** Plain Score intentionally excludes bus automation and execution deviations. */
function symbolicScore(take: PerformanceTake): Score {
  return {
    schemaVersion: 1,
    id: take.id,
    title: "Captured symbolic performance",
    ppq: 480,
    bpm: take.bpm,
    meter: [4, 4],
    scale: { root: 0, mode: "chromatic" },
    playback: "one-shot",
    lengthTicks: take.lengthTicks,
    loop: null,
    tracks: structuredClone(take.tracks),
    patches: structuredClone(take.patches),
    sections: [],
    patterns: take.tracks.map((track, i) => ({
      id: `take-pattern-${i}`,
      name: track.name,
      lengthTicks: take.lengthTicks,
      notes: take.notes
        .filter((n) => n.trackId === track.id)
        .map((n) => ({
          id: n.id,
          startTick: n.startTick,
          durationTicks: n.durationTicks,
          pitch: n.pitch,
          velocity: n.velocity,
        })),
    })),
    clips: take.tracks.map((track, i) => ({
      id: `take-clip-${i}`,
      trackId: track.id,
      patternId: `take-pattern-${i}`,
      startTick: 0,
      repeats: 1,
      transpose: 0,
    })),
  };
}
export function assertPerformanceTake(
  value: unknown,
): asserts value is PerformanceTake {
  if (!value || typeof value !== "object")
    throw Error("Invalid performance take");
  const t = value as PerformanceTake;
  if (
    (t.version !== 1 && t.version !== 2) ||
    t.ppq !== 480 ||
    !Array.isArray(t.notes) ||
    !Array.isArray(t.tracks) ||
    !Array.isArray(t.patches) ||
    !Array.isArray(t.automation) ||
    !Array.isArray(t.deviations)
  )
    throw Error("Invalid performance take format");
  if (
    t.notes.length > PERFORMANCE_LIMITS.notes ||
    t.automation.length > PERFORMANCE_LIMITS.automation ||
    t.deviations.length > PERFORMANCE_LIMITS.deviations ||
    t.tracks.length > 32 ||
    t.patches.length > 64
  )
    throw Error("Performance take limit exceeded");
  finiteRange(t.bpm, 20, 400, "tempo");
  finiteRange(t.lengthTicks, 1, 10_000_000, "length");
  if (!Number.isInteger(t.lengthTicks)) throw Error("Noninteger length");
  const duration = (t.lengthTicks * 60) / (480 * t.bpm);
  if (duration > PERFORMANCE_LIMITS.seconds)
    throw Error("Performance duration limit");
  unique(t.notes, "note");
  unique(t.automation, "automation");
  const tracks = new Map(t.tracks.map((track) => [track.id, track]));
  for (const n of t.notes) {
    const track = tracks.get(n.trackId);
    if (
      !track ||
      n.patchId !== track.patchId ||
      n.gain !== track.gain ||
      n.pan !== track.pan
    )
      throw Error("Note properties must resolve from its fixed track");
    finiteRange(n.priority, 0, 255, "priority");
    if (!Number.isInteger(n.priority) || typeof n.optional !== "boolean")
      throw Error("Invalid admission metadata");
  }
  if (t.version === 2) {
    const a = t.acoustic;
    const label = (v: unknown) =>
      typeof v === "string" && v.length > 0 && v.length <= 256;
    if (
      !a ||
      !label(a.renderingProfile) ||
      !a.palette ||
      !Array.isArray(a.palette.bindings) ||
      a.palette.bindings.length > 64 ||
      !Array.isArray(a.palette.resources) ||
      a.palette.resources.length > 128
    )
      throw Error("Invalid acoustic profile");
    validateInstrumentPalette(a.palette);
    for (const binding of a.palette.bindings)
      for (const program of [binding.gmProgram, binding.gmDrumPitch])
        if (
          program !== undefined &&
          (!Number.isInteger(program) || program < 0 || program > 127)
        )
          throw Error("Invalid GM binding");
    const bound = new Set(a.palette.bindings.map((b) => b.patchId));
    if (t.tracks.some((track) => !bound.has(track.patchId)))
      throw Error("Missing acoustic binding");
    if (
      !Array.isArray(t.timeline) ||
      t.timeline.length < 1 ||
      t.timeline.length > 2048 ||
      t.timeline[0].tick !== 0
    )
      throw Error("Invalid effective timeline");
    let previousTick = -1;
    for (const event of t.timeline) {
      if (
        !event ||
        !Number.isSafeInteger(event.tick) ||
        event.tick <= previousTick ||
        event.tick >= t.lengthTicks ||
        !Number.isInteger(event.tonic) ||
        event.tonic < 0 ||
        event.tonic > 11 ||
        ![
          "ionian",
          "lydian",
          "mixolydian",
          "dorian",
          "aeolian",
          "phrygian",
        ].includes(event.mode) ||
        !label(event.ensemble) ||
        !Array.isArray(event.partIds) ||
        event.partIds.length > 32 ||
        new Set(event.partIds).size !== event.partIds.length ||
        event.partIds.some((id) => !tracks.has(id))
      )
        throw Error("Invalid effective timeline event");
      previousTick = event.tick;
    }
  }
  // Independent project validation checks integer ticks, note bounds, IDs and patch closure.
  assertPlayableScore(symbolicScore(t));
  let previous = -1;
  for (const e of t.automation) {
    if (
      !roles.includes(e.role) ||
      !t.tracks.some((track) => track.role === e.role)
    )
      throw Error("Unknown automation role");
    finiteRange(e.timeSeconds, 0, duration, "automation time");
    finiteRange(e.value, 0, 1, "role gain");
    finiteRange(e.rampSeconds, 0, 10, "ramp");
    if (e.timeSeconds < previous)
      throw Error("Automation must be chronologically ordered");
    previous = e.timeSeconds;
  }
  for (const e of t.deviations) {
    if (
      ![
        "skipped",
        "stolen",
        "interrupted",
        "underrun",
        "capture-overflow",
      ].includes(e.kind) ||
      typeof e.reason !== "string" ||
      e.reason.length > 1024
    )
      throw Error("Invalid deviation");
    finiteRange(e.timeSeconds, 0, duration + 10, "deviation time");
    if (
      e.noteId !== undefined &&
      (typeof e.noteId !== "string" || e.noteId.length > 128)
    )
      throw Error("Invalid deviation note id");
  }
}
export function performanceToScore(take: PerformanceTake): {
  score: Score;
  warnings: string[];
} {
  assertPerformanceTake(take);
  return {
    score: symbolicScore(take),
    warnings: [
      ...(take.version === 2
        ? [
            "Symbolic-only export: acoustic palette, rendering profile and effective tonal/orchestration timeline are omitted; pitches remain chromatic. GM programs approximate instrument identity only.",
          ]
        : []),
      ...(take.automation.length
        ? [
            "Symbolic-only export: role-gain automation is retained in the PerformanceTake, not Score/MIDI.",
          ]
        : []),
      ...(take.deviations.length
        ? [
            "Planned symbolic export: execution deviations are retained separately.",
          ]
        : []),
    ],
  };
}
export function serializePerformanceTake(take: PerformanceTake): string {
  assertPerformanceTake(take);
  const result = JSON.stringify(take);
  if (new TextEncoder().encode(result).length > PERFORMANCE_LIMITS.bytes)
    throw Error("Performance byte limit");
  return result;
}
export function parsePerformanceTake(json: string): PerformanceTake {
  if (new TextEncoder().encode(json).length > PERFORMANCE_LIMITS.bytes)
    throw Error("Performance byte limit");
  const take: unknown = JSON.parse(json);
  assertPerformanceTake(take);
  return take;
}

/** Deterministic value during a ramp, used by live and offline renderers when retargeting. */
export function roleGainAt(
  events: RoleGainEvent[],
  role: Track["role"],
  at: number,
): number {
  let from = 1,
    target = 1,
    start = 0,
    end = 0;
  const read = (time: number) =>
    end <= start || time >= end
      ? target
      : from + (target - from) * Math.max(0, (time - start) / (end - start));
  for (const event of events) {
    if (event.timeSeconds > at) break;
    if (event.role !== role) continue;
    from = read(event.timeSeconds);
    target = event.value;
    start = event.timeSeconds;
    end = start + event.rampSeconds;
  }
  return read(at);
}
