import { openAabbOverlaps, openAabbSweep } from "../aabb-kernel";
import { resolveAabbAxis } from "../aabb-mover";
import { integer } from "../../../game-project/src/runtime";
import type { ArenaRect, ArenaWorld } from "./arena-types";

export const arenaOverlaps = openAabbOverlaps;

/** Fixed X then Y resolution; closest blocker wins, ID order resolves ties.
 * Each axis sweep tests the entire displacement, never samples per pixel. */
export function moveArenaBody(
  world: ArenaWorld,
  body: ArenaRect,
  dx: number,
  dy: number,
): void {
  integer(dx, -8192, 8192);
  integer(dy, -8192, 8192);
  if (dx * dx + dy * dy > 8192 * 8192)
    throw Error("Arena body displacement exceeds cap");
  let x = Math.max(
    0,
    Math.min(world.definition.width - body.width, body.x + dx),
  );
  x = body.x + resolveAabbAxis(body, dx, "x", () => world.definition.walls,
    undefined, x - body.x).displacement;
  body.x = integer(x, 0, world.definition.width - body.width);
  let y = Math.max(
    0,
    Math.min(world.definition.height - body.height, body.y + dy),
  );
  y = body.y + resolveAabbAxis(body, dy, "y", () => world.definition.walls,
    undefined, y - body.y).displacement;
  body.y = integer(y, 0, world.definition.height - body.height);
}

export interface ArenaFraction {
  n: number;
  d: number;
}
export function compareArenaFraction(
  a: ArenaFraction,
  b: ArenaFraction,
): number {
  // Absolute numerator <= 2^25, denominator <= 2^15; products <= 2^40.
  return a.n * b.d - b.n * a.d;
}

/** Slab sweep against the Minkowski-expanded target. Rational comparisons
 * preserve exact wall/enemy ties without floating-point epsilon policies. */
export function sweepArenaContact(
  body: ArenaRect,
  dx: number,
  dy: number,
  target: ArenaRect,
): ArenaFraction | null {
  return openAabbSweep(body, { x: dx, y: dy }, target);
}
