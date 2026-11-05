import type {
  CaveDirection,
  CavePoint,
  CaveRect,
} from "@onepage/game-project/cave-types";
import {
  assertCavePlainData,
  caveRecord,
  caveId,
  caveInteger,
} from "@onepage/game-project/cave-data";
import type { TerrainField, TerrainTransaction } from "./terrain-field";
import { raycastField, compareTerrainTime } from "./terrain-query";
export interface TerrainEffect {
  readonly sourceId: string;
  readonly sequence: number;
  readonly kind: "drill" | "blast";
  readonly cells: readonly number[];
  readonly damage: number;
}
/** Gather all effects against the same committed field, independent of source order. */
export function stageTerrainEdits(
  field: TerrainField,
  effects: readonly TerrainEffect[],
): TerrainTransaction {
  assertCavePlainData(effects, 524288);
  if (!Array.isArray(effects) || effects.length > 5)
    throw Error("terrain effect cap");
  const seen = new Set<string>(),
    cells = new Map<number, { damage: number; causes: string[] }>();
  let candidates = 0,
    drills = 0,
    blasts = 0;
  for (const e of effects) {
    caveRecord(
      e,
      ["sourceId", "sequence", "kind", "cells", "damage"],
      "/effect",
    );
    caveId(e.sourceId, "/effect/sourceId");
    caveInteger(e.sequence, 0, 1073741824, "/effect/sequence");
    caveInteger(e.damage, 1, 1024, "/effect/damage");
    if (e.kind !== "drill" && e.kind !== "blast")
      throw Error("invalid terrain effect kind");
    if (e.kind === "drill") drills++;
    else blasts++;
    const key = `${e.sourceId}:${e.sequence}`;
    if (seen.has(key)) throw Error("duplicate terrain effect key");
    seen.add(key);
    if (
      !Array.isArray(e.cells) ||
      e.cells.length > 256 ||
      new Set(e.cells).size !== e.cells.length
    )
      throw Error("terrain cell candidate cap/duplicates");
    candidates += e.cells.length;
    for (const id of e.cells) {
      caveInteger(id, 0, 16383, "/effect/cell");
      const cell = field.cell(id % 128, Math.floor(id / 128));
      if (!cell.solid || cell.protected) continue;
      const m = field.content.materials[cell.material],
        damage = Math.max(
          0,
          e.damage -
            (e.kind === "drill" ? m.drillResistance : m.blastResistance),
        );
      if (!damage) continue;
      const pending = cells.get(id) ?? { damage: 0, causes: [] };
      pending.damage += damage;
      pending.causes.push(key);
      cells.set(id, pending);
    }
  }
  if (drills > 1 || blasts > 4) throw Error("terrain per-kind effect cap");
  return field.stageDamage(
    [...cells]
      .sort((a, b) => a[0] - b[0])
      .map(([id, d]) => ({ id, damage: d.damage, causes: d.causes.sort() })),
    candidates,
  );
}
export const CAVE_DIRECTION_VECTORS: Readonly<
  Record<CaveDirection, CavePoint>
> = Object.freeze({
  up: Object.freeze({ x: 0, y: -1 }),
  right: Object.freeze({ x: 1, y: 0 }),
  down: Object.freeze({ x: 0, y: 1 }),
  left: Object.freeze({ x: -1, y: 0 }),
});
/** Cardinal cutter: 16px transverse, first contact through 4px depth. Protected
 * cells stop each transverse lane, so a stroke never excavates behind bedrock. */
export function drillFootprint(
  field: TerrainField,
  actor: CaveRect,
  direction: CaveDirection,
  reach: number,
): number[] {
  if (
    typeof direction !== "string" ||
    !Object.hasOwn(CAVE_DIRECTION_VECTORS, direction)
  )
    throw Error("invalid drill direction");
  caveInteger(reach, 1024, 4096, "drill reach");
  for (const k of ["x", "y"] as const)
    caveInteger(actor[k], 0, 131072 - 2048, `actor/${k}`);
  if (actor.width !== 2048 || actor.height !== 2048)
    throw Error("drill actor must be 8px");
  const v = CAVE_DIRECTION_VECTORS[direction],
    horizontal = v.x !== 0,
    origin = { x: actor.x + 1024 + v.x * 1024, y: actor.y + 1024 + v.y * 1024 };
  // One exact ray per intersected transverse cell lane avoids grazing along a
  // grid line and makes the first contact belong to the entire cutter width.
  let first: ReturnType<typeof raycastField>["contacts"][number] | undefined;
  const transverse = horizontal ? actor.y : actor.x;
  for (
    let lane = Math.floor((transverse - 1024) / 1024);
    lane < Math.ceil((transverse + 3072) / 1024);
    lane++
  ) {
    const rayOrigin = horizontal
      ? { x: origin.x, y: lane * 1024 + 512 }
      : { x: lane * 1024 + 512, y: origin.y };
    // Closed cover rays report t0 for a face behind the muzzle as well. A cutter
    // only admits cells whose open interiors extend forward from that face.
    const hit = raycastField(field, rayOrigin, {
      x: v.x * reach,
      y: v.y * reach,
    }).contacts.find((h) =>
      horizontal
        ? v.x > 0
          ? (h.cell.x + 1) * 1024 > origin.x
          : h.cell.x * 1024 < origin.x
        : v.y > 0
          ? (h.cell.y + 1) * 1024 > origin.y
          : h.cell.y * 1024 < origin.y,
    );
    if (
      hit &&
      (!first ||
        compareTerrainTime(hit.time, first.time) < 0 ||
        (compareTerrainTime(hit.time, first.time) === 0 &&
          hit.cell.id < first.cell.id))
    )
      first = hit;
  }
  if (!first || first.cell.protected) return [];
  const contact =
    (horizontal ? origin.x : origin.y) +
    ((horizontal ? v.x : v.y) * reach * first.time.n) / first.time.d;
  const r: CaveRect = horizontal
    ? {
        x: v.x > 0 ? contact : contact - 1024,
        y: actor.y - 1024,
        width: 1024,
        height: 4096,
      }
    : {
        x: actor.x - 1024,
        y: v.y > 0 ? contact : contact - 1024,
        width: 4096,
        height: 1024,
      };
  const cells: number[] = [];
  for (
    let y = Math.floor(r.y / 1024);
    y < Math.ceil((r.y + r.height) / 1024);
    y++
  )
    for (
      let x = Math.floor(r.x / 1024);
      x < Math.ceil((r.x + r.width) / 1024);
      x++
    ) {
      const c = field.cell(x, y);
      if (c.id < 0 || c.protected) continue;
      // Inspect all intervening cell interiors in this candidate's transverse lane.
      const start = horizontal
          ? Math.floor(origin.x / 1024)
          : Math.floor(origin.y / 1024),
        end = horizontal ? x : y,
        step = horizontal ? v.x : v.y;
      let blocked = false;
      if ((end - start) * step < 0) continue;
      for (
        let axis = start;
        step > 0 ? axis <= end : axis >= end;
        axis += step
      ) {
        const a = horizontal ? field.cell(axis, y) : field.cell(x, axis);
        if (a.protected && a.solid) {
          blocked = true;
          break;
        }
      }
      if (!blocked) cells.push(c.id);
    }
  return cells.sort((a, b) => a - b);
}
/** Integer disk, cell-center inclusion, <=81 candidates at the 16px radius cap. */
export function diskTerrainCells(
  field: TerrainField,
  center: CavePoint,
  radius: number,
): number[] {
  caveInteger(center.x, 0, 131072, "blast/x");
  caveInteger(center.y, 0, 131072, "blast/y");
  caveInteger(radius, 1, 4096, "blast/radius");
  const cells: number[] = [];
  for (
    let y = Math.max(0, Math.floor((center.y - radius) / 1024));
    y <= Math.min(127, Math.floor((center.y + radius) / 1024));
    y++
  )
    for (
      let x = Math.max(0, Math.floor((center.x - radius) / 1024));
      x <= Math.min(127, Math.floor((center.x + radius) / 1024));
      x++
    ) {
      const dx = x * 1024 + 512 - center.x,
        dy = y * 1024 + 512 - center.y;
      if (dx * dx + dy * dy <= radius * radius) cells.push(y * 128 + x);
    }
  return cells;
}
