import { GEOMETRY_LIMITS } from "./geometry";
import type {
  GeometryCategory, GeometryContact, GeometryFilter, GeometryRect,
  GeometryRegion, GeometryVector,
} from "./geometry";

/** P1 circles retain P0 units, but own their explicitly quantized time domain. */
export const CIRCLE_LIMITS = Object.freeze({
  coordinate: GEOMETRY_LIMITS.coordinate,
  radius: 4096,
  displacement: GEOMETRY_LIMITS.displacement,
  shapes: GEOMETRY_LIMITS.shapes,
  timeScale: 65536,
});
export interface GeometryCircle extends GeometryVector { readonly radius: number }
export type CircleGeometryShape = {
  readonly bodyId: string;
  readonly shapeId: string;
  readonly owner: string;
  readonly category: GeometryCategory;
  readonly region: GeometryRegion;
  readonly sensor: boolean;
  readonly priority: number;
} & (
  | { readonly kind: "circle"; readonly circle: GeometryCircle }
  | { readonly kind: "rect"; readonly rect: GeometryRect }
);
export interface CircleGeometryContact extends GeometryContact {
  /** Outward direction from target at quantized contact, not a unit vector. */
  readonly normal: GeometryVector;
}
export interface CircleGeometryQueryResult {
  readonly candidates: readonly CircleGeometryShape[];
  readonly contacts: readonly CircleGeometryContact[];
  readonly counters: Readonly<{ scanned: number; filtered: number; tested: number; contacts: number }>;
}
export function circleInteger(value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw Error("Circle geometry integer outside supported bounds");
}
function point(p: GeometryVector): void {
  circleInteger(p.x, -CIRCLE_LIMITS.coordinate, CIRCLE_LIMITS.coordinate);
  circleInteger(p.y, -CIRCLE_LIMITS.coordinate, CIRCLE_LIMITS.coordinate);
}
export function validateGeometryCircle(c: GeometryCircle): void {
  point(c);
  circleInteger(c.radius, 1, CIRCLE_LIMITS.radius);
  point({ x: c.x - c.radius, y: c.y - c.radius });
  point({ x: c.x + c.radius, y: c.y + c.radius });
}
function rect(r: GeometryRect): void {
  point(r);
  circleInteger(r.width, 1, CIRCLE_LIMITS.coordinate);
  circleInteger(r.height, 1, CIRCLE_LIMITS.coordinate);
  point({ x: r.x + r.width, y: r.y + r.height });
}
function motion(p: GeometryVector, d: GeometryVector): void {
  circleInteger(d.x, -CIRCLE_LIMITS.displacement, CIRCLE_LIMITS.displacement);
  circleInteger(d.y, -CIRCLE_LIMITS.displacement, CIRCLE_LIMITS.displacement);
  if (d.x * d.x + d.y * d.y > CIRCLE_LIMITS.displacement * CIRCLE_LIMITS.displacement)
    throw Error("Circle displacement cap exceeded");
  point({ x: p.x + d.x, y: p.y + d.y });
}
function nearest(p: GeometryVector, r: GeometryRect): GeometryVector {
  return {
    x: Math.max(r.x, Math.min(p.x, r.x + r.width)),
    y: Math.max(r.y, Math.min(p.y, r.y + r.height)),
  };
}
function squared(x: number, y: number): number { return x * x + y * y; }
/** Closed circles: touching boundaries overlap. P0 half-open boxes are unchanged. */
export function circleOverlapsCircle(a: GeometryCircle, b: GeometryCircle): boolean {
  validateGeometryCircle(a); validateGeometryCircle(b);
  return squared(a.x - b.x, a.y - b.y) <= (a.radius + b.radius) * (a.radius + b.radius);
}
export function circleOverlapsRect(c: GeometryCircle, r: GeometryRect): boolean {
  validateGeometryCircle(c); rect(r);
  const p = nearest(c, r);
  return squared(c.x - p.x, c.y - p.y) <= c.radius * c.radius;
}
function integerSqrt(n: bigint): bigint {
  let lo = 0n, hi = n + 1n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (mid * mid <= n) lo = mid;
    else hi = mid;
  }
  return lo;
}
function ceilDiv(n: bigint, d: bigint): bigint {
  return n >= 0n ? (n + d - 1n) / d : n / d;
}
/** Exact quadratic entry, rounded UP to one of 65537 finite contact buckets.
 * BigInt prevents discriminant overflow; no floating-point square root. */
function diskEntry(p: GeometryVector, d: GeometryVector, center: GeometryVector, radius: number): number | null {
  // Exact conservative rejection before allocating BigInts. Closed bounds keep
  // tangencies; the existing quadratic still resolves every possible contact.
  if (Math.max(p.x, p.x + d.x) < center.x - radius ||
      Math.min(p.x, p.x + d.x) > center.x + radius ||
      Math.max(p.y, p.y + d.y) < center.y - radius ||
      Math.min(p.y, p.y + d.y) > center.y + radius) return null;
  const x = BigInt(p.x - center.x), y = BigInt(p.y - center.y);
  const dx = BigInt(d.x), dy = BigInt(d.y), r = BigInt(radius);
  const a = dx * dx + dy * dy;
  const b = 2n * (x * dx + y * dy);
  const c = x * x + y * y - r * r;
  if (c <= 0n) return 0;
  if (a === 0n || b >= 0n) return null;
  const discriminant = b * b - 4n * a * c;
  if (discriminant < 0n) return null;
  // Compare the real entry with t=1 before rounding; squared test is exact.
  if (-b > 2n * a && (b + 2n * a) * (b + 2n * a) > discriminant) return null;
  const scale = BigInt(CIRCLE_LIMITS.timeScale);
  const root = integerSqrt(discriminant * scale * scale);
  const tick = Number(ceilDiv(-b * scale - root, 2n * a));
  return tick <= CIRCLE_LIMITS.timeScale ? tick : null;
}
function boxEntry(p: GeometryVector, d: GeometryVector, r: GeometryRect): number | null {
  let n = 0, den = 1, farN = 1, farD = 1;
  for (const [origin, speed, min, max] of [
    [p.x, d.x, r.x, r.x + r.width], [p.y, d.y, r.y, r.y + r.height],
  ]) {
    if (speed === 0) { if (origin < min || origin > max) return null; continue; }
    const divisor = Math.abs(speed);
    const a = speed > 0 ? min - origin : origin - max;
    const b = speed > 0 ? max - origin : origin - min;
    if (a * den > n * divisor) { n = a; den = divisor; }
    if (b * farD < farN * divisor) { farN = b; farD = divisor; }
  }
  if (n * farD > farN * den) return null;
  return Math.ceil(n * CIRCLE_LIMITS.timeScale / den);
}
function initial(p: GeometryVector, d: GeometryVector, center: GeometryVector, radius: number): number | null | undefined {
  const x = p.x - center.x, y = p.y - center.y;
  const distance = squared(x, y), r2 = radius * radius;
  if (distance < r2) return 0;
  if (distance === r2) {
    if (d.x === 0 && d.y === 0) return 0;
    return x * d.x + y * d.y < 0 ? 0 : null;
  }
  return undefined;
}
/** Static circle target only. Tangent entry hits; touching and separating misses. */
export function circleSweepCircle(c: GeometryCircle, d: GeometryVector, target: GeometryCircle): number | null {
  validateGeometryCircle(c); validateGeometryCircle(target); motion(c, d);
  validateGeometryCircle({ ...c, x: c.x + d.x, y: c.y + d.y });
  const start = initial(c, d, target, c.radius + target.radius);
  return start === undefined ? diskEntry(c, d, target, c.radius + target.radius) : start;
}
/** True rounded-box Minkowski sweep: two face strips plus four circular corners.
 * Never substitutes the expanded square for a rounded corner. */
export function circleSweepRect(c: GeometryCircle, d: GeometryVector, target: GeometryRect): number | null {
  validateGeometryCircle(c); rect(target); motion(c, d);
  validateGeometryCircle({ ...c, x: c.x + d.x, y: c.y + d.y });
  // Validate first, then reject a swept circle whose bounds cannot reach the
  // rectangle. Do not replace the rounded-corner narrowphase with this box.
  if (Math.max(c.x, c.x + d.x) + c.radius < target.x ||
      Math.min(c.x, c.x + d.x) - c.radius > target.x + target.width ||
      Math.max(c.y, c.y + d.y) + c.radius < target.y ||
      Math.min(c.y, c.y + d.y) - c.radius > target.y + target.height) return null;
  const start = initial(c, d, nearest(c, target), c.radius);
  if (start !== undefined) return start;
  const entries = [
    boxEntry(c, d, { x: target.x - c.radius, y: target.y, width: target.width + 2 * c.radius, height: target.height }),
    boxEntry(c, d, { x: target.x, y: target.y - c.radius, width: target.width, height: target.height + 2 * c.radius }),
  ];
  for (const x of [target.x, target.x + target.width])
    for (const y of [target.y, target.y + target.height])
      entries.push(diskEntry(c, d, { x, y }, c.radius));
  const times = entries.filter((v): v is number => v !== null);
  return times.length ? Math.min(...times) : null;
}
/** Segment-circle uses a radius-zero point internally; public circles need radius >=1. */
export function circleSegment(origin: GeometryVector, d: GeometryVector, target: GeometryCircle): number | null {
  point(origin); motion(origin, d); validateGeometryCircle(target);
  const start = initial(origin, d, target, target.radius);
  return start === undefined ? diskEntry(origin, d, target, target.radius) : start;
}
function circleContactNormal(c: GeometryCircle, d: GeometryVector, time: number, target: CircleGeometryShape): GeometryVector {
  // Multiplication is <= 2^34. Truncate offset toward the start of motion.
  const p = { x: c.x + Math.trunc(d.x * time / CIRCLE_LIMITS.timeScale), y: c.y + Math.trunc(d.y * time / CIRCLE_LIMITS.timeScale) };
  const q = target.kind === "circle" ? target.circle : nearest(p, target.rect);
  const normal = { x: p.x - q.x, y: p.y - q.y };
  if (normal.x !== 0 || normal.y !== 0) return normal;
  if (target.kind === "rect") {
    const faces = [
      { depth: p.x - target.rect.x, x: -1, y: 0 },
      { depth: target.rect.x + target.rect.width - p.x, x: 1, y: 0 },
      { depth: p.y - target.rect.y, x: 0, y: -1 },
      { depth: target.rect.y + target.rect.height - p.y, x: 0, y: 1 },
    ].sort((a, b) => a.depth - b.depth);
    return { x: faces[0].x, y: faces[0].y };
  }
  return d.x !== 0 || d.y !== 0 ? { x: 0 - d.x, y: 0 - d.y } : { x: 1, y: 0 };
}
const categories: readonly string[] = ["world", "actor", "projectile", "pickup", "sensor", "ghost"];
const regions: readonly string[] = ["body", "hurt", "attack", "selection"];
function identity(id: string): void {
  if (typeof id !== "string" || id.length > 96 || !/^[A-Za-z0-9][A-Za-z0-9:_.\/-]*$/.test(id)) throw Error("Invalid circle geometry identity");
}
function lexical(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
/** Validates the whole finite static snapshot before filtering. Unsupported moving
 * targets, rotating shapes and other pairs must be adapted by a separate owner. */
export function queryCircleGeometry(shapes: readonly CircleGeometryShape[], query:
  | { readonly kind: "overlap"; readonly circle: GeometryCircle }
  | { readonly kind: "sweep"; readonly circle: GeometryCircle; readonly delta: GeometryVector }
  | { readonly kind: "segment"; readonly origin: GeometryVector; readonly delta: GeometryVector }, filter: GeometryFilter = {}): CircleGeometryQueryResult {
  if (shapes.length > CIRCLE_LIMITS.shapes) throw Error("Circle shape cap exceeded");
  if (query.kind === "segment") { point(query.origin); motion(query.origin, query.delta); }
  else if (query.kind === "overlap" || query.kind === "sweep") {
    validateGeometryCircle(query.circle);
    if (query.kind === "sweep") { motion(query.circle, query.delta); validateGeometryCircle({ ...query.circle, x: query.circle.x + query.delta.x, y: query.circle.y + query.delta.y }); }
  } else throw Error("Unsupported circle query");
  for (const [values, allowed] of [[filter.categories, categories], [filter.regions, regions]] as const)
    if (values && (values.length > allowed.length || values.some(v => !allowed.includes(v)))) throw Error("Unsupported circle filter");
  if (filter.sensors !== undefined && !["include", "exclude", "only"].includes(filter.sensors)) throw Error("Unsupported circle sensor filter");
  if (filter.excludeBodyIds) {
    if (filter.excludeBodyIds.length > CIRCLE_LIMITS.shapes) throw Error("Circle exclusion cap exceeded");
    filter.excludeBodyIds.forEach(identity);
  }
  const ordered = shapes.map(s => {
    identity(s.bodyId); identity(s.shapeId); identity(s.owner);
    circleInteger(s.priority, -1024, 1024);
    if (!categories.includes(s.category) || !regions.includes(s.region) || typeof s.sensor !== "boolean" || "velocity" in s || "delta" in s) throw Error("Unsupported circle shape/static target pair");
    if (s.kind === "circle") { validateGeometryCircle(s.circle); return { ...s, circle: { ...s.circle } }; }
    if (s.kind === "rect") { rect(s.rect); return { ...s, rect: { ...s.rect } }; }
    throw Error("Unsupported circle shape");
  }).sort((a, b) => lexical(a.bodyId, b.bodyId) || lexical(a.shapeId, b.shapeId));
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1], b = ordered[i];
    if (a.bodyId === b.bodyId && a.shapeId === b.shapeId) throw Error("Duplicate circle geometry identity");
    if (a.bodyId === b.bodyId && a.owner !== b.owner) throw Error("Conflicting circle movement owners");
  }
  const candidates = ordered.filter(s => (!filter.categories || filter.categories.includes(s.category)) && (filter.regions ?? ["body"]).includes(s.region) && !(filter.excludeBodyIds ?? []).includes(s.bodyId) && (filter.sensors === "only" ? s.sensor : filter.sensors === "include" || !s.sensor));
  const contacts: CircleGeometryContact[] = [];
  for (const s of candidates) {
    if (query.kind === "segment" && s.kind !== "circle") throw Error("P1 segment query supports circle targets only; use P0 for rectangles");
    const c = query.kind === "segment" ? { ...query.origin, radius: 0 } : query.circle;
    const d = query.kind === "overlap" ? { x: 0, y: 0 } : query.delta;
    const time = query.kind === "overlap"
      ? (s.kind === "circle" ? circleOverlapsCircle(c, s.circle) : circleOverlapsRect(c, s.rect)) ? 0 : null
      : query.kind === "segment" && s.kind === "circle" ? circleSegment(query.origin, d, s.circle)
      : s.kind === "circle" ? circleSweepCircle(c, d, s.circle) : circleSweepRect(c, d, s.rect);
    if (time === null) continue;
    contacts.push({ bodyId: s.bodyId, shapeId: s.shapeId, owner: s.owner, category: s.category, region: s.region, sensor: s.sensor, priority: s.priority, time: { n: time, d: CIRCLE_LIMITS.timeScale }, normal: circleContactNormal(c, d, time, s) });
  }
  contacts.sort((a, b) => a.time.n - b.time.n || a.priority - b.priority || lexical(a.bodyId, b.bodyId) || lexical(a.shapeId, b.shapeId));
  return { candidates, contacts, counters: { scanned: shapes.length, filtered: shapes.length - candidates.length, tested: candidates.length, contacts: contacts.length } };
}
