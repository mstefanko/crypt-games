import type { World } from "./types";
/** A bounded authored spring impulse; ordinary platform stepping remains the sole motor. */
export function launchPlatformSpring(
  world: World,
  actorId: number,
  speed: number,
): boolean {
  if (!Number.isSafeInteger(speed) || speed < 256 || speed > 4096)
    throw Error("Spring speed must be 256–4096 simulation units");
  const actor = world.actors.find((a) => a.id === actorId);
  if (!actor || !actor.grounded || world.status !== "playing") return false;
  actor.vy = -speed;
  actor.grounded = false;
  actor.coyoteTicks = 0;
  actor.jumpBuffer = 0;
  actor.riderId = null;
  if (actor.platformMotion) actor.platformMotion.supportId = null;
  return true;
}
