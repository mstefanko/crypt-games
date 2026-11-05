import { GEOMETRY_LIMITS } from "./geometry";
import { canonicalBallisticData } from "./ballistics";

/** Deliberately smaller than P0's envelope. All values are fixed units. */
export const P3_LIMITS = Object.freeze({
  coordinate: 32768,
  segments: 32,
  cells: 16,
  pitch: 2048,
  speed: 256,
  gravity: 16,
  snap: 128,
  ticks: 256,
});
export function p3Integer(v: number, min: number, max: number): number {
  if (!Number.isSafeInteger(v) || Object.is(v, -0) || v < min || v > max)
    throw Error("P3 integer outside bounds");
  return v;
}
export interface P3HeightField {
  readonly columns: number;
  readonly rows: number;
  readonly pitch: number;
  readonly heights: readonly number[];
}
export function validateP3HeightField(field: P3HeightField): void {
  canonicalBallisticData(field);
  if (Object.keys(field).sort().join() !== "columns,heights,pitch,rows")
    throw Error("Invalid P3 field");
  p3Integer(field.columns, 2, 16);
  p3Integer(field.rows, 2, 16);
  p3Integer(field.pitch, 256, 2048);
  if (field.heights.length !== field.columns * field.rows)
    throw Error("P3 height count");
  field.heights.forEach((h) => p3Integer(h, 0, 8192));
  for (let y = 0; y < field.rows; y++)
    for (let x = 0; x < field.columns; x++) {
      const h = field.heights[y * field.columns + x];
      if (
        x &&
        Math.abs(h - field.heights[y * field.columns + x - 1]) * 4 > field.pitch
      )
        throw Error("P3 grade exceeds 1:4");
      if (
        y &&
        Math.abs(h - field.heights[(y - 1) * field.columns + x]) * 4 >
          field.pitch
      )
        throw Error("P3 grade exceeds 1:4");
    }
}
/** Two authored triangles per cell: exact integer affine interpolation, rounded
 * down once. Diagonal ownership is x+y <= pitch. No overlapping levels. */
export function sampleP3Height(
  field: P3HeightField,
  x: number,
  y: number,
): { height: number; gradientX: number; gradientY: number } {
  validateP3HeightField(field);
  return sampleTrustedP3Height(field, x, y);
}
function sampleTrustedP3Height(
  field: P3HeightField,
  x: number,
  y: number,
): { height: number; gradientX: number; gradientY: number } {
  const p = field.pitch;
  p3Integer(x, 0, (field.columns - 1) * p);
  p3Integer(y, 0, (field.rows - 1) * p);
  const cx = Math.min(Math.floor(x / p), field.columns - 2),
    cy = Math.min(Math.floor(y / p), field.rows - 2);
  const u = x - cx * p,
    v = y - cy * p,
    i = cy * field.columns + cx;
  const a = field.heights[i],
    b = field.heights[i + 1],
    c = field.heights[i + field.columns],
    d = field.heights[i + field.columns + 1];
  const gx = u + v <= p ? b - a : d - c,
    gy = u + v <= p ? c - a : d - b;
  const height =
    u + v <= p
      ? a + Math.floor((gx * u + gy * v) / p)
      : d + Math.floor((gx * (u - p) + gy * (v - p)) / p);
  return {
    height,
    gradientX: Math.trunc((gx * 256) / p) || 0,
    gradientY: Math.trunc((gy * 256) / p) || 0,
  };
}
/** Immutable validated ownership boundary. Sampling touches exactly four heights,
 * without scanning/revalidating the field. Counters measure work, not elapsed time. */
export interface P3PreparedHeightField {
  readonly field: P3HeightField;
  sample(
    x: number,
    y: number,
  ): { height: number; gradientX: number; gradientY: number };
  work(): { validations: number; samples: number; heightReads: number };
}
export function prepareP3HeightField(
  field: P3HeightField,
): P3PreparedHeightField {
  validateP3HeightField(field);
  const owned = Object.freeze({
    columns: field.columns,
    rows: field.rows,
    pitch: field.pitch,
    heights: Object.freeze([...field.heights]),
  });
  let samples = 0;
  return Object.freeze({
    field: owned,
    sample(x: number, y: number) {
      const result = sampleTrustedP3Height(owned, x, y);
      samples++;
      return result;
    },
    work() {
      return { validations: 1, samples, heightReads: samples * 4 };
    },
  });
}
export interface P3Slope {
  readonly id: string;
  readonly x1: number;
  readonly x2: number;
  readonly y1: number;
  readonly y2: number;
  readonly kind: "floor" | "one-way" | "ceiling";
}
export interface P3MotorState {
  x: number;
  y: number;
  vy: number;
  grounded: string | null;
}
export interface P3MotorCommand {
  readonly move: number;
  readonly jump: boolean;
  readonly drop: boolean;
}
export function validateP3Slopes(slopes: readonly P3Slope[]): void {
  canonicalBallisticData(slopes);
  if (slopes.length > P3_LIMITS.segments) throw Error("P3 slope cap");
  const ids = new Set<string>();
  for (const s of slopes) {
    if (
      Object.keys(s).sort().join() !== "id,kind,x1,x2,y1,y2" ||
      typeof s.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,32}$/.test(s.id) ||
      ids.has(s.id)
    )
      throw Error("Invalid slope identity");
    ids.add(s.id);
    for (const v of [s.x1, s.x2]) p3Integer(v, 0, P3_LIMITS.coordinate);
    for (const v of [s.y1, s.y2])
      p3Integer(
        v,
        s.kind === "ceiling" ? 0 : 256,
        s.kind === "ceiling" ? 32512 : 32768,
      );
    if (
      s.x1 >= s.x2 ||
      Math.abs(s.y2 - s.y1) * 2 > s.x2 - s.x1 ||
      !["floor", "one-way", "ceiling"].includes(s.kind)
    )
      throw Error("Invalid slope/grade");
  }
  // A single connected non-overlapping floor graph; discontinuities are gaps.
  const floor = slopes
    .filter((s) => s.kind !== "ceiling")
    .slice()
    .sort((a, b) => a.x1 - b.x1);
  for (let i = 1; i < floor.length; i++)
    if (
      floor[i].x1 < floor[i - 1].x2 ||
      (floor[i].x1 === floor[i - 1].x2 && floor[i].y1 !== floor[i - 1].y2)
    )
      throw Error("Ambiguous slope seam");
}
function surfaceY(s: P3Slope, x: number): number {
  return s.y1 + Math.floor(((s.y2 - s.y1) * (x - s.x1)) / (s.x2 - s.x1));
}
/** Foot-point motor with a 256-unit head clearance. Positive y points down.
 * Continuous segment crossings prevent thin-floor tunneling; static surfaces only. */
export function stepP3Motor(
  slopes: readonly P3Slope[],
  state: P3MotorState,
  command: P3MotorCommand,
): P3MotorState {
  validateP3Slopes(slopes);
  canonicalBallisticData(state);
  canonicalBallisticData(command);
  if (
    Object.keys(state).sort().join() !== "grounded,vy,x,y" ||
    Object.keys(command).sort().join() !== "drop,jump,move"
  )
    throw Error("P3 motor fields");
  p3Integer(state.x, 0, 32768);
  p3Integer(state.y, 256, 32768);
  p3Integer(state.vy, -512, 512);
  p3Integer(command.move, -256, 256);
  if (typeof command.jump !== "boolean" || typeof command.drop !== "boolean")
    throw Error("P3 motor command");
  const support = slopes.find(
    (s) =>
      s.id === state.grounded &&
      s.kind !== "ceiling" &&
      state.x >= s.x1 &&
      state.x <= s.x2 &&
      state.y === surfaceY(s, state.x),
  );
  if (state.grounded !== null && (!support || state.vy !== 0))
    throw Error("Invalid motor support");
  const intendedX = Math.max(0, Math.min(32768, state.x + command.move));
  const deltaX = intendedX - state.x;
  const jumping = !!support && command.jump;
  const dropping = !!support && support.kind === "one-way" && command.drop;
  let vy = jumping ? -256 : Math.min(512, state.vy + 16);
  let intendedY = Math.max(256, Math.min(32768, state.y + vy));
  if (intendedY !== state.y + vy) vy = 0;
  let grounded: string | null = null;
  const ordered = slopes
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const next = ordered.find(
    (s) => s.kind !== "ceiling" && intendedX >= s.x1 && intendedX <= s.x2,
  );
  // The maximum supported slope changes height by <=128 at speed256.
  let covered = Math.min(state.x, intendedX);
  for (const s of slopes
    .filter((s) => s.kind !== "ceiling")
    .slice()
    .sort((a, b) => a.x1 - b.x1))
    if (s.x1 <= covered && s.x2 >= covered) covered = s.x2;
  const connected = covered >= Math.max(state.x, intendedX);
  const following = !!(
    connected &&
    support &&
    !jumping &&
    !dropping &&
    next &&
    Math.abs(surfaceY(next, intendedX) - state.y) <= P3_LIMITS.snap
  );
  if (following && next) {
    intendedY = surfaceY(next, intendedX);
    vy = 0;
    grounded = next.id;
  }
  const dy = intendedY - state.y;
  let hit: { surface: P3Slope; n: number; d: number } | null = null;
  for (const s of ordered) {
    if (
      (dropping && s.id === support?.id) ||
      (s.kind !== "ceiling" &&
        (following || (support && !following && s.id === support.id)))
    )
      continue;
    const offset = s.kind === "ceiling" ? 256 : 0,
      width = s.x2 - s.x1,
      rise = s.y2 - s.y1;
    const distance =
        (state.y - offset - s.y1) * width - rise * (state.x - s.x1),
      rate = dy * width - rise * deltaX;
    if (
      s.kind === "ceiling"
        ? !(distance >= 0 && rate < 0)
        : !(distance <= 0 && rate > 0)
    )
      continue;
    const n = Math.abs(distance),
      d = Math.abs(rate);
    if (n > d) continue;
    const contactX = state.x * d + deltaX * n;
    if (contactX < s.x1 * d || contactX > s.x2 * d) continue;
    if (!hit || n * hit.d < hit.n * d) hit = { surface: s, n, d };
  }
  let x = intendedX,
    y = intendedY;
  if (hit) {
    if (hit.surface.kind === "ceiling") {
      // Discard residual movement at first contact. A grounded uphill move
      // blocked by a ceiling remains on its original supported position.
      if (following) return { ...state };
      x = state.x + Math.trunc((deltaX * hit.n) / hit.d);
      y = surfaceY(hit.surface, x) + 256;
      vy = 0;
      grounded = null;
    } else {
      const s = hit.surface;
      x = Math.max(
        s.x1,
        Math.min(s.x2, state.x + Math.trunc((deltaX * hit.n) / hit.d)),
      );
      y = surfaceY(s, x);
      vy = 0;
      grounded = s.id;
    }
  }
  p3Integer(y, 256, 32768);
  return { x, y, vy, grounded };
}
// Keep the fixed-unit relationship explicit instead of enlarging geometry validators.
export const P3_UNITS_PER_PIXEL = GEOMETRY_LIMITS.unitsPerPixel;

export interface P3SlopeCheckpoint {
  readonly format: "p3-slopes-v1";
  readonly slopes: readonly P3Slope[];
  readonly initial: P3MotorState;
  readonly commands: readonly P3MotorCommand[];
  readonly state: P3MotorState;
}
export class P3SlopeWorld {
  private readonly slopes: readonly P3Slope[];
  private readonly initial: P3MotorState;
  private state: P3MotorState;
  private commands: P3MotorCommand[] = [];
  constructor(slopes: readonly P3Slope[], initial: P3MotorState) {
    validateP3Slopes(slopes);
    canonicalBallisticData(initial);
    // Zero movement validates initial support and all fields without publishing gravity.
    stepP3Motor(slopes, initial, { move: 0, jump: false, drop: false });
    this.slopes = JSON.parse(JSON.stringify(slopes)) as P3Slope[];
    this.initial = { ...initial };
    this.state = { ...initial };
  }
  observe(): P3MotorState {
    return { ...this.state };
  }
  step(command: P3MotorCommand): P3MotorState {
    if (this.commands.length >= 256) throw Error("P3 slope tick cap");
    const next = stepP3Motor(this.slopes, this.state, command);
    this.commands.push({ ...command });
    this.state =
      next.y === 32768 && next.grounded === null ? { ...this.initial } : next;
    return this.observe();
  }
  capture(): P3SlopeCheckpoint {
    return JSON.parse(
      JSON.stringify({
        format: "p3-slopes-v1",
        slopes: this.slopes,
        initial: this.initial,
        commands: this.commands,
        state: this.state,
      }),
    ) as P3SlopeCheckpoint;
  }
  restore(value: unknown): void {
    const canonical = canonicalBallisticData(value),
      c = value as P3SlopeCheckpoint;
    if (
      Object.keys(c).sort().join() !== "commands,format,initial,slopes,state" ||
      c.format !== "p3-slopes-v1" ||
      canonicalBallisticData(c.slopes) !==
        canonicalBallisticData(this.slopes) ||
      canonicalBallisticData(c.initial) !==
        canonicalBallisticData(this.initial) ||
      !Array.isArray(c.commands) ||
      c.commands.length > 256
    )
      throw Error("Incompatible P3 slope checkpoint");
    const candidate = new P3SlopeWorld(this.slopes, this.initial);
    for (const cmd of c.commands) candidate.step(cmd);
    if (canonicalBallisticData(candidate.capture()) !== canonical)
      throw Error("Inconsistent P3 slope checkpoint");
    this.state = candidate.state;
    this.commands = candidate.commands;
  }
}
export const P3_SLOPE_FIXTURE: readonly P3Slope[] = [
  { id: "flat", x1: 0, x2: 2048, y1: 4096, y2: 4096, kind: "floor" },
  { id: "up", x1: 2048, x2: 4096, y1: 4096, y2: 3072, kind: "floor" },
  { id: "top", x1: 4096, x2: 6144, y1: 3072, y2: 3072, kind: "floor" },
  { id: "down", x1: 6144, x2: 8192, y1: 3072, y2: 4096, kind: "floor" },
  { id: "oneway", x1: 8192, x2: 10240, y1: 4096, y2: 4096, kind: "one-way" },
];
