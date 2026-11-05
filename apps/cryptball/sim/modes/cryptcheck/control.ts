import type { Player, State } from "../../contract";
import { event } from "../../actions";
import { capBall, touchBall } from "../../ball";
import { groundBallPhysics } from "../../sports-spec";
import { clearLane } from "../../prediction";
import { aimHeading, headingVector, FIXED as F, length } from "../../rules";
import { specialBurst, specialKind, specialBallContact } from "../../specials";
import { HOCKEY } from "./spec";
export function bladeAnchor(
  p: Player,
  offset = HOCKEY.controlOffset,
  heading = p.heading,
) {
  const d = headingVector(heading);
  return {
    x: p.x + Math.round((d.x * offset * F) / 65536),
    y: p.y + Math.round((d.y * offset * F) / 65536),
  };
}
export function releaseControl(s: State, reason: string, releaserId?: string) {
  const p = s.players.find((q) => q.id === s.possessionId);
  for (const id of new Set([p?.id, releaserId]))
    if (id)
      s.hockey!.skaters[id].recaptureUntil = s.tick + HOCKEY.reacquireTicks;
  s.possessionId = null;
  s.possessionReady = s.tick;
  if (p) event(s, "possession-lost", p, { reason });
}
function eligible(s: State, p: Player, retaining = false) {
  return (
    !(s.mode === "practice" && p.team === 1) &&
    (retaining || (!p.action && !p.charging && !p.dashTicks)) &&
    !p.slideTicks &&
    !p.slideRecovery &&
    !p.staggerTicks &&
    !s.hockey!.skaters[p.id].check &&
    !s.hockey!.skaters[p.id].downTicks &&
    (!specialBurst(s, p) ||
      ["foxes", "bats"].includes(specialKind(s, p) ?? "")) &&
    specialKind(s, p) !== "gators"
  );
}
export function bladeContains(p: Player, point: { x: number; y: number }) {
  const d = headingVector(p.heading),
    dx = point.x - p.x,
    dy = point.y - p.y;
  const along = (dx * d.x + dy * d.y) / 65536;
  const side = (-dx * d.y + dy * d.x) / 65536;
  const near = Math.max(11 * F, Math.min(17 * F, along));
  return length(along - near, side) <= 7 * F;
}
/** Aim is responsive; the physical blade pocket turns only along a clear short
 * arc. Assistance is velocity-only and the owner remains solid in the solver. */
export function controlPuck(s: State, emit: Parameters<typeof touchBall>[3]) {
  const b = s.ball,
    physics = groundBallPhysics("cryptcheck");
  let owner = s.players.find((p) => p.id === s.possessionId);
  if (
    owner &&
    (!eligible(s, owner, true) ||
      length(owner.x - b.x, owner.y - b.y) > HOCKEY.controlBreak * F ||
      length(b.vx - owner.vx, b.vy - owner.vy) > HOCKEY.receiveSpeed * F ||
      !clearLane(
        b,
        bladeAnchor(
          owner,
          HOCKEY.controlOffset,
          s.hockey!.skaters[owner.id].carryHeading,
        ),
        s.players,
        [owner.id],
        physics,
      ) ||
      !clearLane(owner, b, s.players, [owner.id], physics))
  ) {
    releaseControl(s, "unreachable");
    owner = undefined;
  }
  if (!owner && s.tick >= s.hockey!.contestUntil) {
    const candidates = s.players.filter(
      (p) =>
        eligible(s, p) &&
        length(p.x - b.x, p.y - b.y) >= 11 * F &&
        bladeContains(p, b) &&
        length(b.vx - p.vx, b.vy - p.vy) <= HOCKEY.receiveSpeed * F &&
        s.tick >= s.hockey!.skaters[p.id].recaptureUntil &&
        clearLane(p, b, s.players, [p.id], physics),
    );
    candidates.sort(
      (a, c) =>
        length(bladeAnchor(a).x - b.x, bladeAnchor(a).y - b.y) -
          length(bladeAnchor(c).x - b.x, bladeAnchor(c).y - b.y) ||
        (a.id < c.id ? -1 : 1),
    );
    const a = candidates[0],
      other = candidates.find((p) => p.team !== a?.team);
    if (
      a &&
      other &&
      a.team !== other.team &&
      Math.abs(
        length(bladeAnchor(a).x - b.x, bladeAnchor(a).y - b.y) -
          length(bladeAnchor(other).x - b.x, bladeAnchor(other).y - b.y),
      ) <=
        2 * F
    ) {
      deflectContest(s, a, other);
      event(s, "clash", a, { x: b.x, y: b.y });
      return;
    }
    if (a) {
      owner = a;
      s.possessionId = a.id;
      s.hockey!.skaters[a.id].carryHeading = aimHeading(b.x - a.x, b.y - a.y);
      s.hockey!.skaters[a.id].receiveUntil = s.tick + HOCKEY.receiveTicks;
      specialBallContact(s, a, b, length(b.vx, b.vy));
      touchBall(b, a, s.tick, emit);
      s.touchTick = s.tick;
      event(s, "trap", a, { x: b.x, y: b.y });
    }
  }
  if (!owner) return;
  const carry = s.hockey!.skaters[owner.id];
  const turn = ((owner.heading - carry.carryHeading + 384) % 256) - 128;
  const nextHeading =
    (carry.carryHeading +
      Math.max(-HOCKEY.carryTurn, Math.min(HOCKEY.carryTurn, turn)) +
      256) %
    256;
  const next = bladeAnchor(owner, HOCKEY.controlOffset, nextHeading);
  // Include the owner's solid torso for actual pocket travel. Excluding it in
  // the retention test alone must never permit a chord through the body.
  if (clearLane(b, next, s.players, [], physics))
    carry.carryHeading = nextHeading;
  const anchor = bladeAnchor(owner, HOCKEY.controlOffset, carry.carryHeading);
  if (!clearLane(b, anchor, s.players, [], physics)) return;
  const dx = (anchor.x - b.x) * 12,
    dy = (anchor.y - b.y) * 12;
  const correction = length(dx, dy),
    scale = correction
      ? Math.min(1, (HOCKEY.controlSpeed * F) / correction)
      : 0;
  const tx = owner.vx + Math.round(dx * scale),
    ty = owner.vy + Math.round(dy * scale);
  const ax = tx - b.vx,
    ay = ty - b.vy,
    delta = length(ax, ay);
  const fraction = delta
    ? Math.min(
        1,
        ((owner.dashTicks || specialBurst(s, owner)
          ? HOCKEY.burstPush
          : HOCKEY.controlAcceleration) *
          F) /
          60 /
          delta,
      )
    : 0;
  b.vx += Math.round(ax * fraction);
  b.vy += Math.round(ay * fraction);
  capBall(b, physics);
}
/** A single physical lateral contact opens a contested lane; the short receipt
 * prevents replaying the same neutral claim every tick without travel. */
export function deflectContest(s: State, a: Player, other: Player) {
  const dx = other.x - a.x,
    dy = other.y - a.y,
    n = length(dx, dy);
  let sign = (dx < 0 || (dx === 0 && dy > 0) ? -1 : 1) * s.hockey!.contestSide;
  const tangent = -s.ball.vx * dy + s.ball.vy * dx;
  // A repeated claim during the same escaping contact preserves its outgoing
  // direction; alternation must not ping-pong the puck between the same blades.
  if (Math.abs(tangent) > 20 * F * n) sign = tangent > 0 ? 1 : -1;
  // Near a board, choose the tangent pointing back into usable ice.
  if (Math.abs(s.ball.y) > 60 * F && dx) sign = Math.sign(-s.ball.y * dx);
  else if (Math.abs(s.ball.x) > 140 * F && dy) sign = Math.sign(s.ball.x * dy);
  if (n) {
    s.ball.vx = Math.round((-dy * sign * 48 * F) / n) || 0;
    s.ball.vy = Math.round((dx * sign * 48 * F) / n);
    s.ball.rx = s.ball.ry = 0;
  }
  s.hockey!.contestUntil = s.tick + 6;
  s.hockey!.contestSide = s.hockey!.contestSide === 1 ? -1 : 1;
}
