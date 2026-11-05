import { openAabbOverlaps, openAabbSweep } from "./aabb-kernel";
import type { CavePoint, CaveRect } from "@onepage/game-project/cave-types";
import { caveInteger } from "@onepage/game-project/cave-data";
import type { TerrainCell, TerrainField } from "./terrain-field";
export interface TerrainFraction {
  readonly n: number;
  readonly d: number;
}
export interface TerrainContact {
  readonly cell: TerrainCell;
  readonly time: TerrainFraction;
}
export interface TerrainQueryResult {
  readonly contacts: readonly TerrainContact[];
  readonly counters: Readonly<{ candidates: number; tested: number }>;
}
const cross = (a: TerrainFraction, b: TerrainFraction) => a.n * b.d - b.n * a.d;
/** Query coordinates <=2^18, displacement <=2^13. Rational products <=2^32;
 * differences <=2^33. Circle distance sums <=2^35. All below 2^53. */
export function compareTerrainTime(
  a: TerrainFraction,
  b: TerrainFraction,
): number {
  for (const f of [a, b]) {
    caveInteger(f.n, -524288, 524288, "time/n");
    caveInteger(f.d, 1, 8192, "time/d");
  }
  return Math.sign(cross(a, b));
}
function point(p: CavePoint): void {
  caveInteger(p.x, -131072, 262144, "query/x");
  caveInteger(p.y, -131072, 262144, "query/y");
}
function rect(r: CaveRect): void {
  point(r);
  caveInteger(r.width, 1, 131072, "query/width");
  caveInteger(r.height, 1, 131072, "query/height");
  point({ x: r.x + r.width, y: r.y + r.height });
}
function motion(p: CavePoint, d: CavePoint): void {
  caveInteger(d.x, -8192, 8192, "delta/x");
  caveInteger(d.y, -8192, 8192, "delta/y");
  point({ x: p.x + d.x, y: p.y + d.y });
}
/** Cell and actor open interiors. Entry at t=1 hits; pure corner grazing misses. */
function slab(
  body: CaveRect,
  delta: CavePoint,
  target: CaveRect,
  closed = false,
): TerrainFraction | null {
  if (!closed) return openAabbSweep(body, delta, target);
  let enter: TerrainFraction = { n: 0, d: 1 },
    leave: TerrainFraction | null = null;
  for (const [origin, v, min, max] of [
    [body.x, delta.x, target.x - body.width, target.x + target.width],
    [body.y, delta.y, target.y - body.height, target.y + target.height],
  ]) {
    if (v === 0) {
      if (
        closed ? origin < min || origin > max : origin <= min || origin >= max
      )
        return null;
      continue;
    }
    const d = Math.abs(v),
      near = { n: v > 0 ? min - origin : origin - max, d },
      far = { n: v > 0 ? max - origin : origin - min, d };
    if (cross(near, enter) > 0) enter = near;
    if (!leave || cross(far, leave) < 0) leave = far;
    if (closed ? cross(enter, leave) > 0 : cross(enter, leave) >= 0)
      return null;
  }
  return cross(enter, { n: 1, d: 1 }) > 0 ? null : enter;
}
const order = (a: TerrainContact, b: TerrainContact) =>
  cross(a.time, b.time) || a.cell.y - b.cell.y || a.cell.x - b.cell.x;
function scan(
  field: TerrainField,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  test: (r: CaveRect) => TerrainFraction | null,
): TerrainQueryResult {
  const contacts: TerrainContact[] = [];
  let candidates = 0,
    tested = 0;
  for (let y = minY; y <= maxY; y++)
    for (let x = minX; x <= maxX; x++) {
      candidates++;
      const cell = field.cell(x, y);
      if (!cell.solid) continue;
      tested++;
      const time = test({
        x: x * 1024,
        y: y * 1024,
        width: 1024,
        height: 1024,
      });
      if (time) contacts.push({ cell, time });
    }
  contacts.sort(order);
  return { contacts, counters: { candidates, tested } };
}
export function overlapFieldAabb(
  field: TerrainField,
  body: CaveRect,
): TerrainQueryResult {
  rect(body);
  return scan(
    field,
    Math.floor(body.x / 1024),
    Math.floor(body.y / 1024),
    Math.ceil((body.x + body.width) / 1024) - 1,
    Math.ceil((body.y + body.height) / 1024) - 1,
    (r) => openAabbOverlaps(body, r) ? { n: 0, d: 1 } : null,
  );
}
export function sweepFieldAabb(
  field: TerrainField,
  body: CaveRect,
  delta: CavePoint,
): TerrainQueryResult {
  rect(body);
  motion(body, delta);
  point({
    x: body.x + body.width + delta.x,
    y: body.y + body.height + delta.y,
  });
  return scan(
    field,
    Math.floor(Math.min(body.x, body.x + delta.x) / 1024) - 1,
    Math.floor(Math.min(body.y, body.y + delta.y) / 1024) - 1,
    Math.floor(
      Math.max(body.x + body.width, body.x + body.width + delta.x) / 1024,
    ),
    Math.floor(
      Math.max(body.y + body.height, body.y + body.height + delta.y) / 1024,
    ),
    (r) => slab(body, delta, r),
  );
}
/** Rays include closed cell faces/corners, with row-major ties. This prevents
 * cover leaking through zero-width seams. A stationary point on solid hits0. */
export function raycastField(
  field: TerrainField,
  origin: CavePoint,
  delta: CavePoint,
): TerrainQueryResult {
  point(origin);
  motion(origin, delta);
  return scan(
    field,
    Math.floor(Math.min(origin.x, origin.x + delta.x) / 1024) - 1,
    Math.floor(Math.min(origin.y, origin.y + delta.y) / 1024) - 1,
    Math.floor(Math.max(origin.x, origin.x + delta.x) / 1024),
    Math.floor(Math.max(origin.y, origin.y + delta.y) / 1024),
    (r) => slab({ ...origin, width: 0, height: 0 }, delta, r, true),
  );
}
