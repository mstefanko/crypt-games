import { openAabbOverlaps, openAabbSweep } from "./aabb-kernel";
/** P0 integer queries. Facts only: callers own motion, effects and persistence. */
export const GEOMETRY_LIMITS = Object.freeze({
  unitsPerPixel: 256,
  coordinate: 262144,
  terrainCellPixels: 16,
  terrainCellUnits: 4096,
  terrainCellsPerAxis: 64,
  displacement: 8192,
  shapes: 256,
  identityLength: 96,
  priority: 1024,
});
export const GEOMETRY_PHASES = Object.freeze([
  "commands",
  "controller-intent",
  "movement-queries",
  "gather-effects",
  "commit",
  "observations",
] as const);
export type GeometryPhase = (typeof GEOMETRY_PHASES)[number];
export type GeometryCategory =
  | "world"
  | "actor"
  | "projectile"
  | "pickup"
  | "sensor"
  | "ghost";
export type GeometryRegion = "body" | "hurt" | "attack" | "selection";
export interface GeometryRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface GeometryVector {
  readonly x: number;
  readonly y: number;
}
export interface GeometryFraction {
  readonly n: number;
  readonly d: number;
}
export interface GeometryShape {
  readonly bodyId: string;
  readonly shapeId: string;
  readonly owner: string;
  readonly category: GeometryCategory;
  readonly region: GeometryRegion;
  readonly sensor: boolean;
  /** Smaller priorities sort first at equal time. */
  readonly priority: number;
  readonly rect: GeometryRect;
}
export interface GeometryFilter {
  /** Omitted means all categories. An empty array means none. */
  readonly categories?: readonly GeometryCategory[];
  /** Omitted means body regions only; hurt/attack must be selected explicitly. */
  readonly regions?: readonly GeometryRegion[];
  readonly sensors?: "include" | "exclude" | "only";
  readonly excludeBodyIds?: readonly string[];
}
export interface GeometryContact {
  readonly bodyId: string;
  readonly shapeId: string;
  readonly owner: string;
  readonly category: GeometryCategory;
  readonly region: GeometryRegion;
  readonly sensor: boolean;
  readonly priority: number;
  readonly time: GeometryFraction;
}
export interface GeometryQueryResult {
  readonly candidates: readonly GeometryShape[];
  readonly contacts: readonly GeometryContact[];
  readonly counters: Readonly<{
    scanned: number;
    filtered: number;
    tested: number;
    contacts: number;
  }>;
}
const categories: readonly string[] = [
  "world",
  "actor",
  "projectile",
  "pickup",
  "sensor",
  "ghost",
];
const regions: readonly string[] = ["body", "hurt", "attack", "selection"];
function bounded(value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw Error("Geometry integer outside supported bounds");
}
function identity(value: string): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9:_.\/-]*$/.test(value) ||
    value.length > GEOMETRY_LIMITS.identityLength
  )
    throw Error("Invalid geometry identity");
}
function point(p: GeometryVector): void {
  bounded(p.x, -GEOMETRY_LIMITS.coordinate, GEOMETRY_LIMITS.coordinate);
  bounded(p.y, -GEOMETRY_LIMITS.coordinate, GEOMETRY_LIMITS.coordinate);
}
function rect(r: GeometryRect): void {
  point(r);
  bounded(r.width, 1, GEOMETRY_LIMITS.coordinate);
  bounded(r.height, 1, GEOMETRY_LIMITS.coordinate);
  point({ x: r.x + r.width, y: r.y + r.height });
}
function motion(origin: GeometryVector, delta: GeometryVector): void {
  bounded(delta.x, -8192, 8192);
  bounded(delta.y, -8192, 8192);
  if (delta.x * delta.x + delta.y * delta.y > 8192 * 8192)
    throw Error("Geometry displacement exceeds cap");
  point({ x: origin.x + delta.x, y: origin.y + delta.y });
}
function cross(a: GeometryFraction, b: GeometryFraction): number {
  return a.n * b.d - b.n * a.d;
}
/** Bounded rational comparison; no rounding or epsilon. Each product <= 2^33;
 * their difference <= 2^34, safely below the exact-integer limit 2^53. */
export function compareGeometryTime(
  a: GeometryFraction,
  b: GeometryFraction,
): number {
  for (const f of [a, b]) {
    bounded(f.n, -1048576, 1048576);
    bounded(f.d, 1, 8192);
  }
  return Math.sign(cross(a, b));
}
const intersects = openAabbOverlaps;
/** Half-open rectangles: shared edges/corners do not overlap. */
export function geometryOverlaps(a: GeometryRect, b: GeometryRect): boolean {
  rect(a);
  rect(b);
  return intersects(a, b);
}
const slab = openAabbSweep;
/** Static-target sweep. Initial penetration is t=0; face entry at t=1 hits.
 * Parallel tangency, moving away from a touching face, and corner-only grazing miss. */
export function geometrySweep(
  body: GeometryRect,
  delta: GeometryVector,
  target: GeometryRect,
): GeometryFraction | null {
  rect(body);
  rect(target);
  motion(body, delta);
  point({
    x: body.x + body.width + delta.x,
    y: body.y + body.height + delta.y,
  });
  return slab(body, delta, target);
}
/** Bounded segment, parameterized by origin + delta*t, 0 <= t <= 1.
 * An open-interior point at zero motion reports t=0. No infinite rays. */
export function geometrySegment(
  origin: GeometryVector,
  delta: GeometryVector,
  target: GeometryRect,
): GeometryFraction | null {
  point(origin);
  motion(origin, delta);
  rect(target);
  return slab({ ...origin, width: 0, height: 0 }, delta, target);
}
function lexical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function shapeOrder(a: GeometryShape, b: GeometryShape): number {
  return lexical(a.bodyId, b.bodyId) || lexical(a.shapeId, b.shapeId);
}
function validateFilter(filter: GeometryFilter): void {
  for (const [values, allowed] of [
    [filter.categories, categories],
    [filter.regions, regions],
  ] as const) {
    if (
      values &&
      (values.length > allowed.length ||
        values.some((value) => !allowed.includes(value)))
    )
      throw Error("Unsupported geometry filter");
  }
  if (
    filter.sensors !== undefined &&
    !["include", "exclude", "only"].includes(filter.sensors)
  )
    throw Error("Unsupported sensor filter");
  if (filter.excludeBodyIds) {
    if (filter.excludeBodyIds.length > GEOMETRY_LIMITS.shapes)
      throw Error("Geometry exclusion cap exceeded");
    for (const id of filter.excludeBodyIds) identity(id);
  }
}
/** Finite brute-force reference query. Never truncates candidates/contacts.
 * Call only in movement-queries against a stable snapshot; commit responses later. */
export function queryGeometry(
  shapes: readonly GeometryShape[],
  query:
    | { readonly kind: "overlap"; readonly rect: GeometryRect }
    | {
        readonly kind: "sweep";
        readonly rect: GeometryRect;
        readonly delta: GeometryVector;
      }
    | {
        readonly kind: "segment";
        readonly origin: GeometryVector;
        readonly delta: GeometryVector;
      },
  filter: GeometryFilter = {},
): GeometryQueryResult {
  if (shapes.length > GEOMETRY_LIMITS.shapes)
    throw Error("Geometry shape cap exceeded");
  validateFilter(filter);
  // Validate query even when there are no candidates.
  if (query.kind === "overlap") rect(query.rect);
  else if (query.kind === "sweep")
    geometrySweep(query.rect, query.delta, query.rect);
  else if (query.kind === "segment")
    geometrySegment(query.origin, query.delta, {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  else throw Error("Unsupported geometry query");
  const ordered = shapes
    .map((s) => {
      identity(s.bodyId);
      identity(s.shapeId);
      identity(s.owner);
      rect(s.rect);
      bounded(s.priority, -1024, 1024);
      if (
        !categories.includes(s.category) ||
        !regions.includes(s.region) ||
        typeof s.sensor !== "boolean"
      )
        throw Error("Unsupported geometry shape");
      return { ...s, rect: { ...s.rect } };
    })
    .sort(shapeOrder);
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1],
      current = ordered[i];
    if (shapeOrder(previous, current) === 0)
      throw Error("Duplicate geometry shape identity");
    if (previous.bodyId === current.bodyId && previous.owner !== current.owner)
      throw Error("Geometry body has conflicting movement owners");
  }
  const candidates = ordered.filter(
    (s) =>
      (!filter.categories || filter.categories.includes(s.category)) &&
      (filter.regions ?? ["body"]).includes(s.region) &&
      !(filter.excludeBodyIds ?? []).includes(s.bodyId) &&
      (filter.sensors === "only"
        ? s.sensor
        : filter.sensors === "include" || !s.sensor),
  );
  const contacts: GeometryContact[] = [];
  for (const s of candidates) {
    const time =
      query.kind === "overlap"
        ? intersects(query.rect, s.rect)
          ? { n: 0, d: 1 }
          : null
        : query.kind === "sweep"
          ? slab(query.rect, query.delta, s.rect)
          : slab({ ...query.origin, width: 0, height: 0 }, query.delta, s.rect);
    if (time) {
      const { rect: ignored, ...contact } = s;
      contacts.push({ ...contact, time });
    }
  }
  contacts.sort(
    (a, b) =>
      cross(a.time, b.time) ||
      a.priority - b.priority ||
      lexical(a.bodyId, b.bodyId) ||
      lexical(a.shapeId, b.shapeId),
  );
  return {
    candidates,
    contacts,
    counters: {
      scanned: shapes.length,
      filtered: shapes.length - candidates.length,
      tested: candidates.length,
      contacts: contacts.length,
    },
  };
}
