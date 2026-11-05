import { assertScore, type Patch, type Score } from "@onepage/project";
import { compileScore } from "./runtime";
import { assertPerformanceTake, type PerformanceTake } from "./performance";
/** Renderer-independent expression. Semantic gains are linear; raw MIDI CC7/11 use cc-square-v1. */
export type ExpressionParameter =
  | "pitchCents"
  | "volume"
  | "expression"
  | "pan"
  | "brightness"
  | "modulation";
export interface ExpressionState {
  pitchCents: number;
  volume: number;
  expression: number;
  pan: number;
  brightness: number;
  modulation: number;
}
export interface ExpressiveControlEvent {
  id: string;
  partId: string;
  noteId?: string;
  parameter: ExpressionParameter;
  timeSeconds: number;
  value: number;
  rampSeconds: number;
  /** Exact source tick/order is provenance, never a reason to quantize effective audio times. */
  sourceTick?: number;
  order?: number;
}
export interface ExpressivePart {
  id: string;
  name: string;
  role: "melody" | "bass" | "harmony" | "drums";
  gain: number;
  pan: number;
  initialState?: Partial<ExpressionState>;
  sourceChannel?: number;
  sourcePort?: number;
}
export interface ExpressiveBinding {
  id: string;
  kind: "synth" | "soundfont" | "sample";
  resourceId?: string;
  patchId?: string;
  gmProgram?: number;
  bankMsb?: number;
  bankLsb?: number;
  drum?: boolean;
}
export interface ExpressiveResource {
  id: string;
  kind: "soundfont" | "sample" | "synth";
  uri?: string;
  sha256?: string;
  license?: string;
  patch?: Patch;
  sample?: {
    rootPitch: number;
    loop?: { startSeconds: number; endSeconds: number };
  };
}
export interface ExpressiveNote {
  id: string;
  partId: string;
  bindingId: string;
  startTick: number;
  keyReleaseTick: number;
  endTick: number;
  pitch: number;
  velocity: number;
  priority: number;
  optional: boolean;
  sourceOrder?: number;
  releaseOrder?: number;
  termination?: "kill";
}
export interface CompiledExpressiveNote extends ExpressiveNote {
  startSeconds: number;
  keyReleaseSeconds: number;
  endSeconds: number;
}
export interface TempoPoint {
  tick: number;
  microsecondsPerBeat: number;
}
export interface MeterPoint {
  tick: number;
  numerator: number;
  denominator: number;
}
export interface ExpressiveInstrumentEvent {
  id: string;
  partId: string;
  bindingId: string;
  tick: number;
  order?: number;
}
export interface ExpressiveDiagnostic {
  code: string;
  message: string;
  severity: "warning" | "unsupported";
  tick?: number;
  track?: number;
  channel?: number;
}
export interface ExpressiveProvenance {
  source?: string;
  sourceHash?: string;
  gainCurve: "cc-square-v1";
  diagnostics: ExpressiveDiagnostic[];
  [key: string]: unknown;
}
export interface PerformanceDocumentV1 {
  version: 1;
  kind: "expressive-performance";
  id: string;
  ppq: number;
  lengthTicks: number;
  tempoMap: TempoPoint[];
  meterMap: MeterPoint[];
  parts: ExpressivePart[];
  bindings: ExpressiveBinding[];
  resources: ExpressiveResource[];
  notes: ExpressiveNote[];
  controls: ExpressiveControlEvent[];
  instruments: ExpressiveInstrumentEvent[];
  provenance: ExpressiveProvenance;
}
export interface PerformanceTakeV3 {
  version: 3;
  id: string;
  ppq: number;
  lengthTicks: number;
  durationSeconds: number;
  tempoMap: TempoPoint[];
  meterMap: MeterPoint[];
  parts: ExpressivePart[];
  bindings: ExpressiveBinding[];
  resources: ExpressiveResource[];
  notes: CompiledExpressiveNote[];
  controls: ExpressiveControlEvent[];
  instruments: ExpressiveInstrumentEvent[];
  provenance: ExpressiveProvenance;
  renderingProfile: string;
  deviations: {
    kind: string;
    timeSeconds: number;
    noteId?: string;
    reason: string;
  }[];
}
export interface ExpressiveWindow {
  epoch: number;
  revision: number;
  startSeconds: number;
  endSeconds: number;
  notes: CompiledExpressiveNote[];
  controls: ExpressiveControlEvent[];
}

export const EXPRESSIVE_LIMITS = {
  ppq: 32767,
  notes: 8192,
  controls: 65536,
  bindings: 256,
  parts: 32,
  resources: 128,
  seconds: 600,
  bytes: 16 * 1024 * 1024,
} as const;
export const NEUTRAL_EXPRESSION: Readonly<ExpressionState> = Object.freeze({
  pitchCents: 0,
  volume: 1,
  expression: 1,
  pan: 0,
  brightness: 1,
  modulation: 0,
});
export function midiControllerGain(value: number): number {
  range(value, 0, 127, "MIDI gain");
  return (value / 127) ** 2;
}
function range(value: number, min: number, max: number, label: string): void {
  if (!Number.isFinite(value) || value < min || value > max)
    throw Error(`Invalid expressive ${label}`);
}
function integer(value: number, min: number, max: number, label: string): void {
  range(value, min, max, label);
  if (!Number.isSafeInteger(value))
    throw Error(`Noninteger expressive ${label}`);
}
function label(value: string, name: string): void {
  if (typeof value !== "string" || !value.length || value.length > 256)
    throw Error(`Invalid expressive ${name}`);
}
function identities(items: { id: string }[], name: string): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (!item) throw Error(`Invalid ${name}`);
    label(item.id, name);
    if (ids.has(item.id)) throw Error(`Duplicate ${name} id`);
    ids.add(item.id);
  }
  return ids;
}
/** Piecewise constant tempo, continuous at boundaries. Fractional inverse ticks are intentional. */
export function createTempoMap(ppq: number, points: readonly TempoPoint[]) {
  integer(ppq, 1, EXPRESSIVE_LIMITS.ppq, "PPQ");
  if (!points.length || points.length > 10000 || points[0].tick !== 0)
    throw Error("Tempo map must begin at tick zero");
  let previous = -1,
    seconds = 0;
  const segments = points.map((p, i) => {
    integer(p.tick, 0, 1e10, "tempo tick");
    range(p.microsecondsPerBeat, 1, 0xffffff, "tempo");
    if (p.tick <= previous) throw Error("Tempo ticks must increase");
    if (i)
      seconds +=
        ((p.tick - points[i - 1].tick) * points[i - 1].microsecondsPerBeat) /
        (ppq * 1e6);
    previous = p.tick;
    return { ...p, seconds };
  });
  function by(key: "tick" | "seconds", value: number) {
    let low = 0,
      high = segments.length;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (segments[mid][key] <= value) low = mid;
      else high = mid;
    }
    return segments[low];
  }
  return {
    tickToSeconds(tick: number) {
      range(tick, 0, 1e10, "tick");
      const s = by("tick", tick);
      return (
        s.seconds + ((tick - s.tick) * s.microsecondsPerBeat) / (ppq * 1e6)
      );
    },
    secondsToTick(time: number) {
      range(time, 0, EXPRESSIVE_LIMITS.seconds + 60, "time");
      const s = by("seconds", time);
      return s.tick + ((time - s.seconds) * ppq * 1e6) / s.microsecondsPerBeat;
    },
  };
}
export function compareExpressiveControls(
  a: ExpressiveControlEvent,
  b: ExpressiveControlEvent,
): number {
  return (
    a.timeSeconds - b.timeSeconds ||
    (a.order ?? 0) - (b.order ?? 0) ||
    a.id.localeCompare(b.id)
  );
}
function parameterValue(parameter: ExpressionParameter, value: number): void {
  if (!Object.prototype.hasOwnProperty.call(NEUTRAL_EXPRESSION, parameter))
    throw Error("Unknown expression parameter");
  if (parameter === "pitchCents") range(value, -12800, 12800, "pitch cents");
  else if (parameter === "pan") range(value, -1, 1, "pan");
  else
    range(
      value,
      0,
      parameter === "volume" || parameter === "expression" ? 4 : 1,
      parameter,
    );
}
/** Validate closure and resource budgets before accepting external documents. */
export function assertPerformanceDocument(
  value: unknown,
): asserts value is PerformanceDocumentV1 {
  if (!value || typeof value !== "object")
    throw Error("Invalid expressive document");
  const d = value as PerformanceDocumentV1;
  if (d.version !== 1 || d.kind !== "expressive-performance")
    throw Error("Invalid expressive document version");
  validateBody(d);
}
function validateBody(
  d: Omit<PerformanceDocumentV1, "version" | "kind">,
): void {
  label(d.id, "id");
  integer(d.lengthTicks, 1, 1e10, "length");
  for (const [key, limit] of [
    ["notes", EXPRESSIVE_LIMITS.notes],
    ["controls", EXPRESSIVE_LIMITS.controls],
    ["parts", EXPRESSIVE_LIMITS.parts],
    ["bindings", EXPRESSIVE_LIMITS.bindings],
    ["resources", EXPRESSIVE_LIMITS.resources],
    ["instruments", EXPRESSIVE_LIMITS.controls],
    ["meterMap", 10000],
  ] as const)
    if (!Array.isArray(d[key]) || d[key].length > limit)
      throw Error(`Expressive ${key} limit`);
  if (!Array.isArray(d.tempoMap)) throw Error("Invalid tempo map");
  if (d.tempoMap.some((p) => !p || p.tick > d.lengthTicks))
    throw Error("Tempo point beyond document length");
  const map = createTempoMap(d.ppq, d.tempoMap),
    duration = map.tickToSeconds(d.lengthTicks);
  range(duration, 0, EXPRESSIVE_LIMITS.seconds, "duration");
  const parts = identities(d.parts, "part"),
    bindings = identities(d.bindings, "binding"),
    resources = identities(d.resources, "resource"),
    notes = identities(d.notes, "note");
  identities(d.controls, "control");
  identities(d.instruments, "instrument event");
  for (const p of d.parts) {
    if (!["melody", "bass", "harmony", "drums"].includes(p.role))
      throw Error("Unknown expressive role");
    label(p.name, "part name");
    range(p.gain, 0, 4, "part gain");
    range(p.pan, -1, 1, "part pan");
    if (p.sourceChannel !== undefined)
      integer(p.sourceChannel, 0, 15, "channel");
    if (p.sourcePort !== undefined) integer(p.sourcePort, 0, 0, "MIDI port");
    if (p.initialState)
      for (const [k, v] of Object.entries(p.initialState))
        parameterValue(k as ExpressionParameter, v);
  }
  for (const r of d.resources) {
    if (!["synth", "soundfont", "sample"].includes(r.kind))
      throw Error("Unknown resource kind");
    if (
      r.uri !== undefined &&
      (typeof r.uri !== "string" || r.uri.length > 2048)
    )
      throw Error("Invalid resource URI");
    if (r.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(r.sha256))
      throw Error("Invalid resource hash");
    if (r.patch && (r.kind !== "synth" || typeof r.patch !== "object"))
      throw Error("Invalid synth patch");
    if (r.patch) {
      const p = r.patch;
      label(p.id, "synth patch id");
      if (
        typeof p.name !== "string" ||
        p.name.length > 200 ||
        ![
          "pulse",
          "triangle",
          "sine",
          "sawtooth",
          "noise",
          "harmonic-bass",
        ].includes(p.waveform)
      )
        throw Error("Invalid synth patch identity");
      range(p.attack, 0, 5, "synth attack");
      range(p.release, 0, 10, "synth release");
      range(p.brightness, 0, 1, "synth brightness");
      range(p.duty, 0.05, 0.95, "synth duty");
      if (p.decaySeconds !== undefined)
        range(p.decaySeconds, 0.02, 10, "synth decay");
    }

    if (r.sample !== undefined) {
      if (r.kind !== "sample" || !r.sample || typeof r.sample !== "object")
        throw Error("Invalid native sample descriptor");
      integer(r.sample.rootPitch, 0, 127, "sample root");
      if (r.sample.loop) {
        range(
          r.sample.loop.startSeconds,
          0,
          EXPRESSIVE_LIMITS.seconds,
          "loop start",
        );
        range(
          r.sample.loop.endSeconds,
          0,
          EXPRESSIVE_LIMITS.seconds,
          "loop end",
        );
        if (r.sample.loop.endSeconds <= r.sample.loop.startSeconds)
          throw Error("Invalid sample loop");
      }
    }
  }
  for (const b of d.bindings) {
    if (
      !["synth", "soundfont", "sample"].includes(b.kind) ||
      (b.resourceId && !resources.has(b.resourceId))
    )
      throw Error("Invalid binding resource");
    for (const v of [b.gmProgram, b.bankMsb, b.bankLsb])
      if (v !== undefined) integer(v, 0, 127, "GM binding");
    if (b.drum !== undefined && typeof b.drum !== "boolean")
      throw Error("Invalid drum binding");
  }
  const noteParts = new Map(d.notes.map((n) => [n.id, n.partId]));
  for (const n of d.notes) {
    if (!parts.has(n.partId) || !bindings.has(n.bindingId))
      throw Error("Unresolved expressive note");
    integer(n.startTick, 0, d.lengthTicks, "note onset");
    integer(n.keyReleaseTick, n.startTick, d.lengthTicks, "key release");
    integer(n.endTick, n.keyReleaseTick, d.lengthTicks, "note end");
    integer(n.pitch, 0, 127, "note pitch");
    range(n.velocity, 0, 1, "velocity");
    integer(n.priority, 0, 255, "priority");
    if (typeof n.optional !== "boolean") throw Error("Invalid optional note");
    if (n.sourceOrder !== undefined)
      integer(n.sourceOrder, 0, 1e9, "note source order");
    if (n.releaseOrder !== undefined)
      integer(n.releaseOrder, 0, 1e9, "note release order");
    if (n.termination !== undefined && n.termination !== "kill")
      throw Error("Invalid termination mode");
  }
  for (const c of d.controls) {
    if (
      !parts.has(c.partId) ||
      (c.noteId !== undefined &&
        (!notes.has(c.noteId) || noteParts.get(c.noteId) !== c.partId))
    )
      throw Error("Unresolved control scope");
    parameterValue(c.parameter, c.value);
    range(c.timeSeconds, 0, duration, "control time");
    range(c.rampSeconds, 0, duration + 60, "ramp");
    if (c.sourceTick !== undefined)
      integer(c.sourceTick, 0, d.lengthTicks, "source tick");
    if (c.order !== undefined) integer(c.order, 0, 1e9, "event order");
  }
  for (const i of d.instruments) {
    if (!parts.has(i.partId) || !bindings.has(i.bindingId))
      throw Error("Unresolved instrument event");
    integer(i.tick, 0, d.lengthTicks, "instrument tick");
  }
  let previous = -1;
  for (const m of d.meterMap) {
    integer(m.tick, 0, d.lengthTicks, "meter tick");
    integer(m.numerator, 1, 255, "meter numerator");
    if (
      m.tick <= previous ||
      ![1, 2, 4, 8, 16, 32, 64, 128].includes(m.denominator)
    )
      throw Error("Invalid meter map");
    previous = m.tick;
  }
  if (
    !d.provenance ||
    d.provenance.gainCurve !== "cc-square-v1" ||
    !Array.isArray(d.provenance.diagnostics) ||
    d.provenance.diagnostics.length > 10000
  )
    throw Error("Invalid expressive provenance");
  if (
    d.provenance.sourceHash !== undefined &&
    !/^[a-f0-9]{64}$/i.test(d.provenance.sourceHash)
  )
    throw Error("Invalid provenance hash");
  for (const diagnostic of d.provenance.diagnostics) {
    if (
      !diagnostic ||
      typeof diagnostic !== "object" ||
      !["warning", "unsupported"].includes(diagnostic.severity) ||
      typeof diagnostic.message !== "string" ||
      diagnostic.message.length > 4096
    )
      throw Error("Invalid expressive diagnostic");
    label(diagnostic.code, "diagnostic code");
  }
}
export function compileExpressivePerformance(
  document: PerformanceDocumentV1,
  renderingProfile = "expressive-v1",
): PerformanceTakeV3 {
  assertPerformanceDocument(document);
  const d = structuredClone(document),
    map = createTempoMap(d.ppq, d.tempoMap);
  const { kind: _kind, version: _version, ...body } = d;
  return {
    ...body,
    version: 3,
    renderingProfile,
    durationSeconds: map.tickToSeconds(d.lengthTicks),
    notes: d.notes
      .map((n) => ({
        ...n,
        startSeconds: map.tickToSeconds(n.startTick),
        keyReleaseSeconds: map.tickToSeconds(n.keyReleaseTick),
        endSeconds: map.tickToSeconds(n.endTick),
      }))
      .sort(
        (a, b) => a.startSeconds - b.startSeconds || a.id.localeCompare(b.id),
      ),
    controls: d.controls.sort(compareExpressiveControls),
    deviations: [],
  };
}
export function assertPerformanceTakeV3(
  value: unknown,
): asserts value is PerformanceTakeV3 {
  if (
    !value ||
    typeof value !== "object" ||
    (value as PerformanceTakeV3).version !== 3
  )
    throw Error("Invalid expressive take version");
  const t = value as PerformanceTakeV3;
  validateBody(t);
  label(t.renderingProfile, "rendering profile");
  range(t.durationSeconds, 0, EXPRESSIVE_LIMITS.seconds, "take duration");
  const map = createTempoMap(t.ppq, t.tempoMap);
  if (Math.abs(t.durationSeconds - map.tickToSeconds(t.lengthTicks)) > 1e-9)
    throw Error("Inconsistent take duration");
  for (const n of t.notes)
    for (const [seconds, tick] of [
      [n.startSeconds, n.startTick],
      [n.keyReleaseSeconds, n.keyReleaseTick],
      [n.endSeconds, n.endTick],
    ])
      if (
        !Number.isFinite(seconds) ||
        Math.abs(seconds - map.tickToSeconds(tick)) > 1e-9
      )
        throw Error("Inconsistent compiled note time");
  if (!Array.isArray(t.deviations) || t.deviations.length > 10000)
    throw Error("Invalid take deviations");
  for (const deviation of t.deviations) {
    if (
      !deviation ||
      typeof deviation !== "object" ||
      typeof deviation.reason !== "string" ||
      deviation.reason.length > 1024
    )
      throw Error("Invalid take deviation");
    label(deviation.kind, "deviation kind");
    range(deviation.timeSeconds, 0, t.durationSeconds + 60, "deviation time");
    if (deviation.noteId !== undefined)
      label(deviation.noteId, "deviation note");
  }
}
export function evaluateExpressionLane(
  events: readonly ExpressiveControlEvent[],
  parameter: ExpressionParameter,
  time: number,
  initial: number,
): { value: number; present: boolean } {
  let from = initial,
    target = initial,
    start = 0,
    end = 0,
    present = false;
  const read = (at: number) =>
    end <= start || at >= end
      ? target
      : from + (target - from) * Math.max(0, (at - start) / (end - start));
  for (const c of events) {
    if (c.timeSeconds > time) break;
    if (c.parameter !== parameter) continue;
    from = read(c.timeSeconds);
    target = c.value;
    start = c.timeSeconds;
    end = start + c.rampSeconds;
    present = true;
  }
  return { value: read(time), present };
}
/** Part and note pitch add, gains multiply, and authored note pan overrides part pan. Velocity remains a separate excitation parameter. */
export function createExpressionEvaluator(
  take: Pick<PerformanceTakeV3, "parts" | "controls">,
  note: Pick<CompiledExpressiveNote, "id" | "partId">,
): (timeSeconds: number, output?: ExpressionState & { gain: number }) => ExpressionState & { gain: number } {
  const part = take.parts.find((p) => p.id === note.partId);
  if (!part) throw Error("Unknown expression part");
  const ordered = take.controls
    .filter(
      (c) =>
        c.partId === part.id &&
        (c.noteId === undefined || c.noteId === note.id),
    )
    .sort(compareExpressiveControls);
  const parameters = Object.keys(NEUTRAL_EXPRESSION) as ExpressionParameter[];
  const prepare = (
    parameter: ExpressionParameter,
    noteScope: boolean,
    initial: number,
  ) => {
    let from = initial,
      target = initial,
      start = 0,
      end = 0;
    const segments = ordered
      .filter(
        (c) =>
          c.parameter === parameter &&
          (noteScope ? c.noteId === note.id : c.noteId === undefined),
      )
      .map((c) => {
        from =
          end <= start || c.timeSeconds >= end
            ? target
            : from +
              (target - from) *
                Math.max(0, (c.timeSeconds - start) / (end - start));
        target = c.value;
        start = c.timeSeconds;
        end = start + c.rampSeconds;
        return { from, target, start, end };
      });
    const result = { value: initial, present: false };
    return (at: number) => {
      let lo = -1,
        hi = segments.length;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >>> 1;
        if (segments[mid].start <= at) lo = mid;
        else hi = mid;
      }
      if (lo < 0) { result.value = initial; result.present = false; return result; }
      const s = segments[lo];
      result.value =
          s.end <= s.start || at >= s.end
            ? s.target
            : s.from +
              (s.target - s.from) *
                Math.max(0, (at - s.start) / (s.end - s.start));
      result.present = true;
      return result;
    };
  };
  const lanes = parameters.map((k) => ({
    k,
    p: prepare(
      k,
      false,
      part.initialState?.[k] ??
        (k === "pan" ? part.pan : NEUTRAL_EXPRESSION[k]),
    ),
    n: prepare(k, true, NEUTRAL_EXPRESSION[k]),
  }));
  return (timeSeconds, output) => {
    const state = output ?? { ...NEUTRAL_EXPRESSION, gain: 1 };
    for (const { k, p, n } of lanes) {
      const a = p(timeSeconds),
        b = n(timeSeconds);
      state[k] =
        k === "pitchCents"
          ? a.value + b.value
          : k === "pan"
            ? b.present
              ? b.value
              : a.value
            : k === "modulation"
              ? Math.max(a.value, b.value)
              : a.value * b.value;
    }
    state.gain = part.gain * state.volume * state.expression;
    return state;
  };
}
export function evaluateExpression(
  take: Pick<PerformanceTakeV3, "parts" | "controls">,
  note: Pick<CompiledExpressiveNote, "id" | "partId">,
  timeSeconds: number,
): ExpressionState & { gain: number } {
  return createExpressionEvaluator(take, note)(timeSeconds);
}

export function serializePerformanceDocument(d: PerformanceDocumentV1): string {
  assertPerformanceDocument(d);
  return boundedJson(d);
}
export function parsePerformanceDocument(json: string): PerformanceDocumentV1 {
  checkJsonBytes(json);
  const d: unknown = JSON.parse(json);
  assertPerformanceDocument(d);
  return d;
}
export function serializePerformanceTakeV3(t: PerformanceTakeV3): string {
  assertPerformanceTakeV3(t);
  return boundedJson(t);
}
export function parsePerformanceTakeV3(json: string): PerformanceTakeV3 {
  checkJsonBytes(json);
  const t: unknown = JSON.parse(json);
  assertPerformanceTakeV3(t);
  return t;
}
function checkJsonBytes(json: string): void {
  if (new TextEncoder().encode(json).length > EXPRESSIVE_LIMITS.bytes)
    throw Error("Expressive byte limit");
}
function boundedJson(value: unknown): string {
  const json = JSON.stringify(value);
  checkJsonBytes(json);
  return json;
}
export function scoreToExpressiveDocument(score: Score): PerformanceDocumentV1 {
  assertScore(score);
  const notes = compileScore(score),
    bindings = score.patches.map((p) => ({
      id: p.id,
      kind: "synth" as const,
      resourceId: p.id,
      patchId: p.id,
    }));
  const d: PerformanceDocumentV1 = {
    version: 1,
    kind: "expressive-performance",
    id: score.id,
    ppq: 480,
    lengthTicks: score.lengthTicks,
    tempoMap: [{ tick: 0, microsecondsPerBeat: 60e6 / score.bpm }],
    meterMap: [
      { tick: 0, numerator: score.meter[0], denominator: score.meter[1] },
    ],
    parts: score.tracks.map((t) => ({
      id: t.id,
      name: t.name,
      role: t.role,
      gain: t.gain,
      pan: t.pan,
    })),
    bindings,
    resources: score.patches.map((p) => ({
      id: p.id,
      kind: "synth",
      patch: structuredClone(p),
    })),
    notes: notes.map((n) => ({
      id: n.id,
      partId: n.trackId,
      bindingId: n.patchId,
      startTick: n.startTick,
      keyReleaseTick: n.startTick + n.durationTicks,
      endTick: n.startTick + n.durationTicks,
      pitch: n.pitch,
      velocity: n.velocity,
      priority: 128,
      optional: false,
    })),
    controls: [],
    instruments: [],
    provenance: {
      gainCurve: "cc-square-v1",
      diagnostics: [],
      scoreV1: structuredClone(score),
      scoreProjection:
        "one finite pass; original loop/sections/scale/energy metadata retained in scoreV1",
    },
  };
  assertPerformanceDocument(d);
  return d;
}
export function legacyTakeToExpressive(
  take: PerformanceTake,
): PerformanceTakeV3 {
  assertPerformanceTake(take);
  const d = scoreToExpressiveDocument({
    schemaVersion: 1,
    id: take.id,
    title: "Legacy take",
    ppq: 480,
    bpm: take.bpm,
    meter: [4, 4],
    scale: { root: 0, mode: "chromatic" },
    playback: "one-shot",
    lengthTicks: take.lengthTicks,
    loop: null,
    tracks: take.tracks,
    patches: take.patches,
    sections: [],
    patterns: [],
    clips: [],
  });
  d.notes = take.notes.map((n) => ({
    id: n.id,
    partId: n.trackId,
    bindingId: n.patchId,
    startTick: n.startTick,
    keyReleaseTick: n.startTick + n.durationTicks,
    endTick: n.startTick + n.durationTicks,
    pitch: n.pitch,
    velocity: n.velocity,
    priority: n.priority,
    optional: n.optional,
  }));
  d.controls = take.automation.flatMap((e) =>
    d.parts
      .filter((p) => p.role === e.role)
      .map((p) => ({
        id: `${e.id}:${p.id}`,
        partId: p.id,
        parameter: "expression" as const,
        timeSeconds: e.timeSeconds,
        value: e.value,
        rampSeconds: e.rampSeconds,
      })),
  );
  if (take.version === 2) {
    d.provenance.legacyAcoustic = structuredClone(take.acoustic);
    d.provenance.diagnostics.push({
      code: "legacy-acoustic-profile",
      severity: "unsupported",
      message:
        "Legacy acoustic palette retained as provenance; this adapter renders the source synth patches. Use the legacy renderer for original acoustic playback.",
    });
  }
  const t = compileExpressivePerformance(d);
  t.deviations = structuredClone(take.deviations);
  return t;
}

/** Takes remain editable/exportable without an external document. Effective audio times stay intact. */
export function expressiveTakeToDocument(
  take: PerformanceTakeV3,
): PerformanceDocumentV1 {
  assertPerformanceTakeV3(take);
  const {
    version: _version,
    durationSeconds: _duration,
    renderingProfile: _profile,
    deviations: _deviations,
    ...body
  } = structuredClone(take);
  const document: PerformanceDocumentV1 = {
    ...body,
    version: 1,
    kind: "expressive-performance",
    notes: body.notes.map(
      ({
        startSeconds: _start,
        keyReleaseSeconds: _key,
        endSeconds: _end,
        ...note
      }) => note,
    ),
  };
  assertPerformanceDocument(document);
  return document;
}
/** Choose a single exact PPQ before combining documents. Failure requires the caller to choose quantization explicitly. */
export function commonExpressivePpq(
  ppqs: readonly number[],
  maximum = EXPRESSIVE_LIMITS.ppq,
): number {
  integer(maximum, 1, EXPRESSIVE_LIMITS.ppq, "PPQ maximum");
  if (!ppqs.length) throw Error("No source PPQs");
  let result = 1;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  for (const ppq of ppqs) {
    integer(ppq, 1, EXPRESSIVE_LIMITS.ppq, "source PPQ");
    result = (result / gcd(result, ppq)) * ppq;
    if (result > maximum)
      throw Error(
        "Exact combined PPQ exceeds bounded domain; choose explicit quantization",
      );
  }
  return result;
}
export function rescaleExpressiveDocument(
  document: PerformanceDocumentV1,
  ppq: number,
  policy: "exact" | "nearest" = "exact",
): { document: PerformanceDocumentV1; warnings: string[] } {
  assertPerformanceDocument(document);
  integer(ppq, 1, EXPRESSIVE_LIMITS.ppq, "target PPQ");
  const d = structuredClone(document),
    warnings: string[] = [];
  const scale = (tick: number) => {
    const target = (tick * ppq) / d.ppq;
    if (!Number.isInteger(target)) {
      if (policy === "exact")
        throw Error("PPQ conversion requires explicit quantization");
      warnings.push(
        "Ticks quantized to nearest target tick; timing may change",
      );
    }
    return Math.round(target);
  };
  d.lengthTicks = Math.max(1, scale(d.lengthTicks));
  d.notes = d.notes.map((n) => ({
    ...n,
    startTick: scale(n.startTick),
    keyReleaseTick: scale(n.keyReleaseTick),
    endTick: scale(n.endTick),
  }));
  d.tempoMap = d.tempoMap.map((t) => ({ ...t, tick: scale(t.tick) }));
  d.meterMap = d.meterMap.map((t) => ({ ...t, tick: scale(t.tick) }));
  d.instruments = d.instruments.map((i) => ({ ...i, tick: scale(i.tick) }));
  // Quantization can merge map boundaries. Last source event wins, matching MIDI same-tick ordering.
  d.tempoMap = [...new Map(d.tempoMap.map((t) => [t.tick, t])).values()];
  d.meterMap = [...new Map(d.meterMap.map((t) => [t.tick, t])).values()];
  d.ppq = ppq;
  const clock = createTempoMap(ppq, d.tempoMap);
  d.controls = d.controls.map((c) =>
    c.sourceTick === undefined
      ? c
      : {
          ...c,
          sourceTick: scale(c.sourceTick),
          timeSeconds:
            policy === "nearest"
              ? clock.tickToSeconds(scale(c.sourceTick))
              : c.timeSeconds,
        },
  );
  assertPerformanceDocument(d);
  return { document: d, warnings: [...new Set(warnings)] };
}
