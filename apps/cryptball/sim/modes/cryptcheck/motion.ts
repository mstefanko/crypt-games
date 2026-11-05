import type { CommandFrame, Player, State } from "../../contract";
import { event } from "../../actions";
import { aimHeading, FIXED as F, headingVector, length } from "../../rules";
import {
  playerSpecial,
  specialBurst,
  specialKind,
  specialVelocity,
  SPECIAL_TELL_TICKS,
} from "../../specials";
import { HOCKEY } from "./spec";
const approach = (value: number, target: number, amount: number) =>
  value < target
    ? Math.min(target, value + amount)
    : Math.max(target, value - amount);
/** Momentum and blade aim are independent. Edge grip removes lateral slip while
 * counter input spends time braking before propulsion may reverse direction. */
export function skate(s: State, p: Player, c: CommandFrame) {
  const skater = s.hockey!.skaters[p.id];
  if (skater.downTicks) {
    p.vx = Math.round(p.vx * 0.88);
    p.vy = Math.round(p.vy * 0.88);
    return;
  }
  const check = skater.check;
  if (check) c = { moveX: 0, moveY: 0, aim: check.heading };
  const oldVx = p.vx,
    oldVy = p.vy;
  if (specialVelocity(s, p, c)) {
    if (
      s.possessionId === p.id &&
      ["foxes", "bats"].includes(specialKind(s, p) ?? "")
    ) {
      const dx = p.vx - oldVx,
        dy = p.vy - oldVy,
        delta = length(dx, dy);
      const cap = (HOCKEY.burstPush * F) / 60;
      if (delta > cap) {
        p.vx = oldVx + Math.round((dx * cap) / delta);
        p.vy = oldVy + Math.round((dy * cap) / delta);
      }
    }
    return;
  }
  let moving = !!(c.moveX || c.moveY);
  let heading = moving ? aimHeading(c.moveX ?? 0, c.moveY ?? 0) : p.heading;
  const special = playerSpecial(s, p),
    kind = specialKind(s, p);
  const elapsed = special ? special.elapsedTicks - SPECIAL_TELL_TICKS : -1;
  const checking =
    !!check &&
    check.elapsed >= HOCKEY.checkTell &&
    check.elapsed < HOCKEY.checkTell + HOCKEY.checkActive;
  const burst = !!p.dashTicks || specialBurst(s, p) || checking;
  if (checking) {
    moving = true;
    heading = check!.heading;
  }
  if (p.dashTicks) {
    moving = true;
    heading = p.dashHeading;
  }
  if (kind === "rams" && specialBurst(s, p)) {
    moving = true;
    heading = special!.heading;
    p.dashHeading = heading;
  }
  if (kind === "foxes" && specialBurst(s, p)) {
    moving = true;
    heading = moving ? heading : special!.heading;
  }
  if (kind === "bats" && burst) {
    moving = true;
    heading =
      moving && (c.moveX || c.moveY)
        ? aimHeading(c.moveX ?? 0, c.moveY ?? 0)
        : special!.heading;
  }
  let authority = p.staggerTicks ? 0.25 : p.slideRecovery ? 0.4 : 1;
  if ((p.charging || p.action) && kind !== "owls")
    authority *= p.chargeTicks >= 24 ? 0.45 : 0.65;
  if (special && elapsed < 0) authority *= 0.5;
  if (p.slideTicks) authority *= 0.35;
  if (kind === "owls" && (p.charging || p.action)) authority *= 1.75;
  const oldSpeed = length(p.vx, p.vy);
  if (!moving) {
    const next = Math.max(0, oldSpeed - (HOCKEY.glide * F) / 60);
    p.vx = oldSpeed ? Math.round((p.vx * next) / oldSpeed) : 0;
    p.vy = oldSpeed ? Math.round((p.vy * next) / oldSpeed) : 0;
    p.vx ||= 0;
    p.vy ||= 0;
    return;
  }
  const d = headingVector(heading);
  let forward = Math.round((p.vx * d.x + p.vy * d.y) / 65536);
  const lateral = Math.round((-p.vx * d.y + p.vy * d.x) / 65536);
  let time = 1;
  if (forward < 0) {
    const brake = (HOCKEY.brake * F) / 60;
    time = Math.max(0, 1 - -forward / brake);
    forward = Math.min(0, forward + brake);
    if (oldSpeed >= 40 * F && forward === 0)
      event(s, "ice-stop", p, { heading });
  }
  const target = (burst ? HOCKEY.burst : HOCKEY.cruise) * F;
  if (forward < target)
    forward = approach(
      forward,
      target,
      Math.round(
        (((burst ? HOCKEY.burstPush : HOCKEY.push) * F) / 60) *
          authority *
          time,
      ),
    );
  // Extra speed from a hit/burst bleeds down; charging never erases momentum.
  else forward = approach(forward, target, (HOCKEY.glide * F) / 60);
  const side = approach(
    lateral,
    0,
    Math.round(((HOCKEY.edgeGrip * F) / 60) * authority),
  );
  p.vx = Math.round((d.x * forward - d.y * side) / 65536);
  p.vy = Math.round((d.y * forward + d.x * side) / 65536);
  const speed = length(p.vx, p.vy),
    cap = Math.max(oldSpeed, target);
  if (speed > cap) {
    p.vx = Math.round((p.vx * cap) / speed);
    p.vy = Math.round((p.vy * cap) / speed);
  }
  while (p.vx * p.vx + p.vy * p.vy > cap * cap) {
    if (Math.abs(p.vx) >= Math.abs(p.vy)) p.vx -= Math.sign(p.vx);
    else p.vy -= Math.sign(p.vy);
  }
  p.vx ||= 0;
  p.vy ||= 0;
  if (oldSpeed < F && length(p.vx, p.vy) >= F)
    event(s, "skate-push", p, { heading });
  if (c.aim === undefined && !p.action && !p.charging && !p.slideTicks)
    p.heading = heading;
}
