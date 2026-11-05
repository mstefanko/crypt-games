/** Fixed release workload data; uses the existing validated arena rules only. */
import {
  validateArenaDefinition,
  createArena,
  advanceArena,
  encodeArenaCheckpoint,
} from "../../../game-simulation/src/m3/arena.ts";
import type {
  ArenaDefinition,
  ArenaIdentity,
} from "../../../game-simulation/src/m3/arena-types.ts";
export const PHONE_WORKLOAD = "arena-40-20" as const;
export const WORKLOAD_SEGMENT_TICKS = 1000;
export const WORKLOAD_CONTROLS = Object.freeze({
  moveX: 0,
  moveY: 0,
  aim: 0,
  fire: false,
  dash: false,
  shove: false,
});
export function phoneWorkloadDefinition(base: ArenaDefinition) {
  const unit = 256;
  return validateArenaDefinition({
    ...base,
    id: "phone-visible-40-20-v1",
    width: 320 * unit,
    height: 180 * unit,
    player: {
      ...base.player,
      x: 20 * unit,
      y: 20 * unit,
      width: 8 * unit,
      height: 8 * unit,
    },
    enemies: base.enemies.map((enemy, index) => ({
      ...enemy,
      x: (50 + (index % 13) * 18) * unit,
      y: (90 + Math.floor(index / 13) * 22) * unit,
      width: 8 * unit,
      height: 8 * unit,
    })),
    // Small positive velocities retain actual diagonal AI motion and swept shots.
    // Enemy and projectile bands stay separate for the entire 1,000-tick segment.
    enemySpeed: 2,
    moveSpeed: 0,
    projectileSpeed: 32,
    projectileSize: 2 * unit,
    maxProjectiles: 20,
  });
}
export function createPhoneWorkload(
  definition: ArenaDefinition,
  identity: ArenaIdentity,
) {
  const world = createArena(definition, identity, 1);
  for (let index = 0; index < 20; index++)
    advanceArena(world, { ...WORKLOAD_CONTROLS, aim: index, fire: true });
  return { world, checkpoint: encodeArenaCheckpoint(world) };
}
