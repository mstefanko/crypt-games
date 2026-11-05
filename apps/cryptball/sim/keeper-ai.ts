import type { State, Player, CommandFrame } from "./contract";
import { COURT } from "./spec";
import { FIXED as F, RULES, aimHeading, length, normalized } from "./rules";
import { selectPassTarget } from "./actions";
/** Angle narrowing stays inside the same enforced crease as human movement. */
export function keeperCommand(
  s: State,
  p: Player,
  forecast: { x: number; y: number; tick: number }[],
): CommandFrame {
  const replanning = s.tick >= p.aiNext || p.roleTouch !== s.touchTick;
  if (replanning) {
    const side = p.team === 0 ? -1 : 1;
    const ownGoal = side * COURT.halfLength * F;
    const advance = Math.max(
      12 * F,
      Math.min(
        (COURT.creaseDepth - 10) * F,
        (COURT.halfLength * F + side * s.ball.x) / 8,
      ),
    );
    const x = ownGoal - side * advance;
    const denominator = Math.max(1, Math.abs(s.ball.x - ownGoal));
    const y = Math.round(
      Math.max(
        -(COURT.creaseHalfWidth - 10) * F,
        Math.min(
          (COURT.creaseHalfWidth - 10) * F,
          (s.ball.y * advance) / denominator,
        ),
      ),
    );
    p.aiRole = "keeper";
    p.aiX = Math.round(x);
    p.aiY = y;
    p.aiNext = s.tick + 3;
    p.roleTouch = s.touchTick;
    const close = length(s.ball.x - p.x, s.ball.y - p.y) <= RULES.reach;
    const target = close
      ? selectPassTarget(s, p, p.team === 0 ? 0 : 128)
      : undefined;
    p.aiAim = target ? aimHeading(target.x - p.x, target.y - p.y) : p.heading;
    p.aiPass = close && s.tick - s.touchTick >= 6;
    p.aiSlideStart = p.aiSlideUntil = 0;
    const danger = forecast.find(
      (f) =>
        f.tick >= 6 &&
        f.tick <= 20 &&
        side * f.x >= side * p.x - 8 * F &&
        Math.abs(f.y - p.y) < 40 * F,
    );
    if (
      !p.aiPass &&
      danger &&
      side * s.ball.vx > 0 &&
      !p.slideTicks &&
      !p.slideRecovery &&
      s.tick >= p.slideReady &&
      s.tick >= p.actionReady
    ) {
      p.aiSlideStart = s.tick;
      p.aiSlideUntil = s.tick + 1;
      p.aiAim = danger.y < p.y ? 192 : 64;
    }
  }
  const move = normalized(p.aiX - p.x, p.aiY - p.y);
  const c: CommandFrame = {
    moveX: Math.abs(p.aiX - p.x) < F ? 0 : move.x,
    moveY: Math.abs(p.aiY - p.y) < F ? 0 : move.y,
    aim: p.aiAim,
  };
  // Planned actions are edges. Movement is steered afresh on every authority tick.
  if (replanning && p.aiPass) c.pass = true;
  if (s.tick >= p.aiSlideStart && s.tick < p.aiSlideUntil) {
    c.slide = true;
    c.moveX = 0;
    c.moveY = p.aiAim === 192 ? -1 : 1;
  }
  return c;
}
