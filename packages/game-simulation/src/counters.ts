import { integer } from "../../game-project/src/runtime";
import type { World } from "./types";
export const MAX_DEFEATED_PLACEMENTS = 1024;

/** Reserve every counter a tick or a same-tick level transaction can consume.
 * Run before input is consumed, so exhaustion cannot partly advance the world.
 */
export function preflightWorldCounters(world: World): void {
  try {
    integer(world.tick, 0, Number.MAX_SAFE_INTEGER - 1);
    const spawnCapacity = Math.max(
      ...world.definitions.levels.map((l) => l.spawns.length),
    );
    integer(world.nextEntityId, 1, Number.MAX_SAFE_INTEGER - spawnCapacity);
    integer(
      world.nextExecutionId,
      1,
      Number.MAX_SAFE_INTEGER - world.actors.length,
    );
    integer(world.motionEpochCounter, 1, Number.MAX_SAFE_INTEGER - 1);
    for (const actor of world.actors)
      integer(actor.ai.decisionTicks, 0, Number.MAX_SAFE_INTEGER - 1);
    integer(
      world.campaign.defeatedPlacementIds.length,
      0,
      MAX_DEFEATED_PLACEMENTS - world.actors.length,
    );
  } catch {
    throw Error("Simulation counter exhausted before tick transaction");
  }
}

/** Increment a nonnegative safe integer counter. This is scalar arithmetic, not
 * deadline scheduling: callers preflight it before committing owner mutations. */
export function checkedIncrement(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value === Number.MAX_SAFE_INTEGER
  )
    throw Error("Counter exhausted or invalid");
  return value + 1;
}
