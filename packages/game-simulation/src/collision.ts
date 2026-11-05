import { openAabbOverlaps } from "./aabb-kernel";
import { resolveAabbAxis } from "./aabb-mover";
import { UNIT } from "../../game-project/src/runtime";
import type {
  ArchetypeDefinition,
  LevelDefinition,
  Rect,
} from "../../game-project/src/runtime";
import type { ActorState, Collider, SpatialIndex, World } from "./types";
const BUCKET = 32 * UNIT;
export const overlaps = openAabbOverlaps;
export function body(a: ActorState, d: ArchetypeDefinition): Rect {
  return {
    x: a.x + d.body.x,
    y: a.y + d.body.y,
    width: d.body.width,
    height: d.body.height,
  };
}
export function shape(a: ActorState, r: Rect): Rect {
  return {
    x: a.x + (a.facing === 1 ? r.x : -r.x - r.width),
    y: a.y + r.y,
    width: r.width,
    height: r.height,
  };
}
export function makeIndex(level: LevelDefinition): SpatialIndex {
  const buckets = new Map<string, Collider[]>();
  for (const r of level.rectangles) {
    for (
      let y = Math.floor(r.y / BUCKET);
      y <= Math.floor((r.y + r.height - 1) / BUCKET);
      y++
    )
      for (
        let x = Math.floor(r.x / BUCKET);
        x <= Math.floor((r.x + r.width - 1) / BUCKET);
        x++
      ) {
        const key = `${x},${y}`,
          items = buckets.get(key) ?? [];
        items.push({ ...r });
        buckets.set(key, items);
      }
  }
  return { buckets };
}
/** Only swept cells and rectangle buckets are visited. Exact edges use half-open AABBs. */
export function candidates(
  world: World,
  sweep: Rect,
  includePlatforms = true,
): Collider[] {
  const level = world.definitions.levels.find((l) => l.id === world.levelId)!;
  const size = level.tileSize * UNIT,
    cols = level.width / level.tileSize,
    rows = level.height / level.tileSize;
  const found = new Map<string, Collider>();
  const minX = Math.max(0, Math.floor(sweep.x / size)),
    maxX = Math.min(cols - 1, Math.floor((sweep.x + sweep.width) / size)),
    minY = Math.max(0, Math.floor(sweep.y / size)),
    maxY = Math.min(rows - 1, Math.floor((sweep.y + sweep.height) / size));
  for (let row = minY; row <= maxY; row++)
    for (let col = minX; col <= maxX; col++) {
      const tile = level.tiles[row * cols + col];
      if (tile) {
        const id = `tile:${String(row * cols + col).padStart(8, "0")}`;
        found.set(id, {
          id,
          x: col * size,
          y: row * size,
          width: size,
          height: size,
          oneWay: tile === 2,
        });
      }
    }
  for (
    let y = Math.floor(sweep.y / BUCKET);
    y <= Math.floor((sweep.y + sweep.height) / BUCKET);
    y++
  )
    for (
      let x = Math.floor(sweep.x / BUCKET);
      x <= Math.floor((sweep.x + sweep.width) / BUCKET);
      x++
    )
      for (const r of world.index.buckets.get(`${x},${y}`) ?? [])
        found.set(`rect:${r.id}`, { ...r, id: `rect:${r.id}` });
  if (includePlatforms)
    for (const p of world.platforms) {
      const def = level.platforms.find((x) => x.id === p.id)!;
      const r = {
        id: `platform:${p.id}`,
        x: p.x,
        y: p.y,
        width: def.width,
        height: def.height,
        oneWay: true,
      };
      if (
        r.x <= sweep.x + sweep.width &&
        r.x + r.width >= sweep.x &&
        r.y <= sweep.y + sweep.height &&
        r.y + r.height >= sweep.y
      )
        found.set(r.id, r);
    }
  return [...found.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}
export function embedded(world: World, b: Rect): boolean {
  return candidates(world, b, false).some((r) => !r.oneWay && overlaps(b, r));
}
export function staticOneWay(world: World, id: string): Collider | undefined {
  const level = world.definitions.levels.find((l) => l.id === world.levelId)!;
  if (id.startsWith("rect:")) {
    const r = level.rectangles.find((r) => `rect:${r.id}` === id);
    return r?.oneWay ? { ...r, id } : undefined;
  }
  if (id.startsWith("tile:")) {
    const i = Number(id.slice(5)),
      size = level.tileSize * UNIT,
      cols = level.width / level.tileSize;
    if (level.tiles[i] === 2 && id === `tile:${String(i).padStart(8, "0")}`) {
      const row = Math.floor(i / cols);
      let left = i % cols,
        right = left;
      while (left > 0 && level.tiles[row * cols + left - 1] === 2) left--;
      while (right + 1 < cols && level.tiles[row * cols + right + 1] === 2)
        right++;
      return {
        id: `tile:${String(row * cols + left).padStart(8, "0")}`,
        x: left * size,
        y: row * size,
        width: (right - left + 1) * size,
        height: size,
        oneWay: true,
      };
    }
  }
  return undefined;
}
/** Candidate enumeration remains bounded by the admitted level: <=1,048,576
 * tiles, 1,024 rectangles and 32 platforms. Batch the public kernel's 4,096
 * query limit without rejecting previously admitted long/large-body sweeps.
 * Fold closest distance and retain all equal-distance contacts across batches. */
function resolvePlatformAxis(
  b: Rect, requested: number, axis: "x" | "y", colliders: readonly Collider[],
  eligible: (r: Collider) => boolean = () => true,
) {
  let displacement = requested;
  let contacts: Collider[] = [];
  // Validate even when enumeration returned no colliders.
  resolveAabbAxis(b, requested, axis, () => []);
  for (let start = 0; start < colliders.length; start += 4096) {
    const next = resolveAabbAxis(b, requested, axis,
      () => colliders.slice(start, start + 4096), eligible, displacement);
    if (next.displacement !== displacement) contacts = [];
    displacement = next.displacement;
    contacts.push(...next.contacts);
  }
  contacts.sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { displacement, contacts };
}
export function moveActor(
  world: World,
  actor: ActorState,
  dx: number,
  dy: number,
): void {
  const d = world.definitions.archetypes.find(
    (d) => d.id === actor.archetypeId,
  )!;
  const initial = { x: actor.x, y: actor.y };
  const previousSupport = actor.platformMotion?.supportId ?? null;
  let b = body(actor, d);
  const motion = actor.platformMotion;
  // Reject invalid arithmetic before broad-phase loops or owner mutation.
  resolveAabbAxis(b, dx, "x", () => []);
  resolveAabbAxis(b, dy, "y", () => []);
  function clearIgnoredSupports() {
    if (!motion) return;
    const cleared = (id: string) => {
      const r = staticOneWay(world, id);
      return !r || body(actor, d).y >= r.y + r.height;
    };
    if (motion.ignoredSupportId && cleared(motion.ignoredSupportId))
      motion.ignoredSupportId = null;
    if (motion.ignoredSupportIds) {
      motion.ignoredSupportIds = motion.ignoredSupportIds.filter(
        (id) => !cleared(id),
      );
      if (!motion.ignoredSupportIds.length) delete motion.ignoredSupportIds;
    }
  }
  function ignored(r: Collider) {
    if (
      !motion ||
      (!motion.ignoredSupportId && !motion.ignoredSupportIds?.length)
    )
      return false;
    const ids = [
      motion?.ignoredSupportId,
      ...(motion?.ignoredSupportIds ?? []),
    ];
    return (
      ids.includes(r.id) ||
      (r.oneWay &&
        r.id.startsWith("tile:") &&
        !!staticOneWay(world, r.id) &&
        ids.includes(staticOneWay(world, r.id)!.id))
    );
  }
  const sweep = {
    x: Math.min(b.x, b.x + dx),
    y: Math.min(b.y, b.y + dy),
    width: b.width + Math.abs(dx),
    height: b.height + Math.abs(dy),
  };
  const colliders = candidates(world, sweep);
  // Validate both axes and candidate budget before touching owner state.
  resolvePlatformAxis(b, dy, "y", colliders);
  const mx = resolvePlatformAxis(b, dx, "x", colliders, r => !r.oneWay).displacement;
  clearIgnoredSupports();
  actor.x += mx;
  if (mx !== dx) actor.vx = 0;
  b = body(actor, d);
  const vertical = resolvePlatformAxis(b, dy, "y", colliders,
    r => !ignored(r) && (dy >= 0 || !r.oneWay));
  const my = vertical.displacement;
  actor.grounded = false;
  actor.riderId = null;
  if (motion) motion.supportId = null;
  const support = dy >= 0
    ? vertical.contacts.find(r => b.y + b.height + my === r.y)
    : undefined;
  if (support) {
    actor.grounded = true;
    actor.riderId = support.id.startsWith("platform:") ? support.id.slice(9) : null;
    if (motion) motion.supportId = support.oneWay
      ? (staticOneWay(world, support.id)?.id ?? support.id) : null;
  }
  actor.y += my;
  clearIgnoredSupports();
  if (my !== dy || actor.grounded) actor.vy = 0;
  if (world.motionResults && motion && world.actors.includes(actor)) {
    const previous = world.motionResults.get(actor.id);
    world.motionResults.set(actor.id, {
      requested: {
        x: dx + (previous?.requested.x ?? 0),
        y: dy + (previous?.requested.y ?? 0),
      },
      accepted: {
        x: actor.x - initial.x + (previous?.accepted.x ?? 0),
        y: actor.y - initial.y + (previous?.accepted.y ?? 0),
      },
      supportId: motion.supportId,
      blockedX: mx !== dx || !!previous?.blockedX,
      blockedY: my !== dy || !!previous?.blockedY,
      departure:
        previous?.departure ??
        (motion.ignoredSupportId || motion.ignoredSupportIds?.length
          ? "drop"
          : previousSupport && !motion.supportId
            ? dy < 0
              ? "jump"
              : "walk-off"
            : null),
    });
  }
}
