import { openAabbOverlaps } from "./aabb-kernel";
import {
  CAVE_LIMITS,
  type CavePoint,
  type CaveRect,
} from "@onepage/game-project/cave-types";
import type { TerrainField } from "./terrain-field";

export const caveActorRect = (p: CavePoint): CaveRect => ({
  x: p.x,
  y: p.y,
  width: CAVE_LIMITS.actorSize,
  height: CAVE_LIMITS.actorSize,
});
/** Open interiors; outside the admitted field is protected solid. */
export function caveClear(field: TerrainField, rect: CaveRect): boolean {
  if (
    rect.x < 0 ||
    rect.y < 0 ||
    rect.x + rect.width > CAVE_LIMITS.extent ||
    rect.y + rect.height > CAVE_LIMITS.extent
  )
    return false;
  for (
    let y = Math.floor(rect.y / 1024);
    y <= Math.floor((rect.y + rect.height - 1) / 1024);
    y++
  )
    for (
      let x = Math.floor(rect.x / 1024);
      x <= Math.floor((rect.x + rect.width - 1) / 1024);
      x++
    )
      if (field.cell(x, y).solid) return false;
  return true;
}
/** Axis-separated integer sweep. A <=512-unit move cannot skip a 1024-unit solid. */
export function moveCaveActor(
  field: TerrainField,
  actor: CavePoint,
  dx: number,
  dy: number,
): CavePoint {
  if (
    ![dx, dy].every((n) => Number.isSafeInteger(n) && Math.abs(n) <= 512) ||
    dx * dx + dy * dy > 512 * 512
  )
    throw Error("Cave motor speed cap");
  let x = actor.x,
    y = actor.y;
  const axis = (delta: number, horizontal: boolean) => {
    if (!delta) return;
    const clear = (n: number) =>
      caveClear(
        field,
        caveActorRect({
          x: x + (horizontal ? n : 0),
          y: y + (horizontal ? 0 : n),
        }),
      );
    if (clear(delta)) {
      if (horizontal) x += delta;
      else y += delta;
      return;
    }
    let low = 0,
      high = Math.abs(delta),
      sign = Math.sign(delta);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (clear(mid * sign)) low = mid;
      else high = mid - 1;
    }
    if (horizontal) x += low * sign;
    else y += low * sign;
  };
  axis(dx, true);
  axis(dy, false);
  return { x, y };
}
/** Bounded connector: both axis sweeps must reach their destination exactly. */
export function caveConnectorClear(
  field: TerrainField,
  a: CavePoint,
  b: CavePoint,
): boolean {
  const horizontal = {
    x: Math.min(a.x, b.x),
    y: a.y,
    width: 2048 + Math.abs(a.x - b.x),
    height: 2048,
  };
  const vertical = {
    x: b.x,
    y: Math.min(a.y, b.y),
    width: 2048,
    height: 2048 + Math.abs(a.y - b.y),
  };
  return caveClear(field, horizontal) && caveClear(field, vertical);
}
export const caveRectsOverlap = openAabbOverlaps;
