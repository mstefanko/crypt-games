/** Restricted optional corridor: a physical gap, with no gate tag substituting for motion. */
import type {
  ArchetypeDefinition,
  LevelDefinition,
} from "@onepage/game-project/runtime";
import type {
  CampaignRoom,
  CampaignPlatformCommand,
} from "./campaign-platform";
import { neutralPlatformHeld } from "./platform-input-v2";
const U = 256;
export const BURST_RETURN_GATE = Object.freeze({
  floor: 208,
  leftEnd: 128,
  rightStart: 240,
  width: 384,
  gap: 112,
  burstDistance: 8192,
});
/** Conservative bound includes coyote departure and body overlap on both ledges.
 * Scope excludes aerial ingress, variable body/controller, one-ways, movers and foes. */
export function validateBurstReturnGate(
  level: LevelDefinition,
  hero: ArchetypeDefinition,
  room: CampaignRoom,
): { maximumUnassistedGap: number; gap: number } {
  if (
    hero.speed !== 512 ||
    hero.jumpSpeed !== 1792 ||
    hero.gravity !== 96 ||
    hero.maxFallSpeed !== 2048 ||
    hero.coyoteTicks !== 6 ||
    hero.body.width !== 12 * U ||
    hero.body.height !== 24 * U
  )
    throw Error("Burst gate controller outside pinned envelope");
  const bound =
    (2 * Math.ceil(hero.jumpSpeed / hero.gravity) + hero.coyoteTicks + 2) *
      hero.speed +
    hero.body.width;
  if (BURST_RETURN_GATE.gap * U <= bound)
    throw Error("Burst gate gap below conservative no-burst bound");
  if (
    level.platforms.length ||
    level.rectangles.length ||
    level.spawns.length !== 1 ||
    room.anchors?.some((a) => a.x >= BURST_RETURN_GATE.leftEnd * U) ||
    room.anchors?.some((a) => a.y !== BURST_RETURN_GATE.floor * U)
  )
    throw Error("Burst gate bypass geometry or ingress");
  if (
    level.spawns[0].x >= BURST_RETURN_GATE.leftEnd * U ||
    level.spawns[0].y !== BURST_RETURN_GATE.floor * U ||
    level.spawns[0].slot !== 0
  )
    throw Error("Burst gate unsafe default ingress");
  const expected = compileBurstReturnGateLevel(level.id, hero.id);
  if (
    JSON.stringify(level.tiles) !== JSON.stringify(expected.tiles) ||
    level.width !== expected.width ||
    level.height !== expected.height ||
    level.deathY !== expected.deathY
  )
    throw Error("Burst gate corridor geometry changed");
  return { maximumUnassistedGap: bound, gap: BURST_RETURN_GATE.gap * U };
}
export function compileBurstReturnGateLevel(
  id: string,
  archetypeId = "courier",
): LevelDefinition {
  const { width, floor, leftEnd, rightStart } = BURST_RETURN_GATE;
  // Eight-pixel tiles pin the conservative landing/takeoff boundaries.
  const tileSize = 8,
    height = 256,
    cols = width / tileSize;
  return {
    id,
    width,
    height,
    tileSize,
    tiles: Array.from({ length: (cols * height) / tileSize }, (_, i) => {
      const x = (i % cols) * tileSize,
        y = Math.floor(i / cols) * tileSize;
      return y >= floor && (x < leftEnd || x >= rightStart) ? 1 : 0;
    }),
    rectangles: [],
    platforms: [],
    spawns: [
      {
        id: "courier",
        archetypeId,
        x: 64 * U,
        y: floor * U,
        slot: 0,
        team: 0,
        facing: 1,
      },
    ],
    goal: { x: 380 * U, y: 0, width: 4 * U, height: 4 * U, nextLevelId: null },
    deathY: height * U,
  };
}
export function compileBurstReturnGateRoom(
  id: string,
  destination = "depot",
): CampaignRoom {
  return {
    id,
    scenarioId: `${id}-start`,
    assets: [],
    permanentEnemies: [],
    anchors: [
      { id: "approach", x: 64 * U, y: 208 * U, facing: 1, settleTicks: 1 },
    ],
    defaultAnchor: "approach",
    checkpoint: { x: 48 * U, y: 176 * U, width: 32 * U, height: 32 * U },
    pickups: [],
    exits: [
      {
        id: "shortcut",
        area: { x: 280 * U, y: 176 * U, width: 32 * U, height: 32 * U },
        to: destination,
        destinationAnchor: "east",
        requires: null,
        outcome: null,
      },
    ],
  };
}

/** Ordinary authored witness; caller must acquire burst and enter approach first. */
export function burstReturnGateCrossingCommands(): CampaignPlatformCommand[] {
  const commands: CampaignPlatformCommand[] = [];
  let previous = neutralPlatformHeld();
  const frame = (action?: "jump" | "heavy") => {
    const held = neutralPlatformHeld();
    if (action) held[action] = true;
    const edges = (["jump", "heavy"] as const)
      .filter((a) => held[a] !== previous[a])
      .map((action) => ({
        action,
        kind: held[action] ? ("pressed" as const) : ("released" as const),
      }));
    commands.push({
      kind: "frame",
      input: { slots: [{ slot: 0, held, axes: { moveX: 127 }, edges }] },
    });
    previous = held;
  };
  for (let i = 0; i < 35; i++) frame();
  frame("jump");
  for (let i = 0; i < 14; i++) frame();
  frame("heavy");
  for (let i = 0; i < 35; i++) frame();
  return commands;
}
