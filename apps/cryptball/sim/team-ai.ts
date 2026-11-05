import { COURT } from "./spec";
import { keeperCommand } from "./keeper-ai";
import { selectPassTarget } from "./actions";
import { length } from "./rules";
import type { CommandFrame, State, Player } from "./contract";
import {
  RULES,
  FIXED as F,
  aimHeading,
  normalized,
  headingVector,
} from "./rules";
import { predictBall, clearLane, bankHeading } from "./prediction";
import type { DeterministicRandom } from "@onepage/game-simulation/random";
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  length(a.x - b.x, a.y - b.y);
export function aiCommands(
  s: State,
  rng: DeterministicRandom,
): Map<string, CommandFrame> {
  const commands = new Map<string, CommandFrame>(),
    due = s.players.filter(
      (p) =>
        !s.controllers.some((c) => c.active && c.playerId === p.id) &&
        !(s.mode === "practice" && p.team === 1) &&
        (s.tick >= p.aiNext ||
          (p.role === "keeper" && p.roleTouch !== s.touchTick)),
    );
  const forecast = due.length ? predictBall(s.ball, 45, s.tick) : [];
  for (const team of [0, 1] as const) {
    const roster = s.players.filter((p) => p.team === team),
      direction = team === 0 ? 1 : -1;
    const estimate = (p: Player) => {
      const point =
        forecast.find(
          (f) => distance(p, f) <= (RULES.runSpeed * (f.tick - 6)) / 60,
        ) ?? s.ball;
      return distance(p, point) / RULES.runSpeed;
    };
    const challenger = roster
      .filter((p) => p.role !== "keeper")
      .sort(
        (a, b) =>
          estimate(a) - estimate(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )[0];
    for (const p of roster) {
      if (
        s.controllers.some((c) => c.active && c.playerId === p.id) ||
        (s.mode === "practice" && team === 1)
      )
        continue;
      if (p.role === "keeper") {
        commands.set(p.id, keeperCommand(s, p, forecast));
        continue;
      }
      const human =
        roster.find((q) =>
          s.controllers.some((c) => c.active && c.playerId === q.id),
        ) ?? roster[0];
      let slideTarget: { x: number; y: number } | undefined;
      if (s.tick >= p.aiNext) {
        p.aiNext = s.tick + 6;
        if (
          s.tick >= p.aiSlideUntil &&
          !p.action &&
          !p.charging &&
          !p.slideTicks &&
          !p.slideRecovery &&
          s.tick >= p.slideReady &&
          distance(p, s.ball) > RULES.reach
        ) {
          const intercept = forecast.find(
            (f) =>
              f.tick >= 6 &&
              f.tick <= 20 &&
              distance(p, f) <
                (18 + (s.config.slideLaunchSpeed * f.tick) / 60) * F,
          );
          if (intercept && length(s.ball.vx, s.ball.vy) > 100 * F) {
            slideTarget = intercept;
            p.aiSlideStart = s.tick;
            p.aiSlideUntil = s.tick + 1;
            p.aiAim = aimHeading(intercept.x - p.x, intercept.y - p.y);
          }
        }
        const supportingHuman = s.controllers.some(
          (c) =>
            c.active &&
            c.team === team &&
            distance(s.players.find((q) => q.id === c.playerId)!, s.ball) <
              38 * F,
        );
        const danger = direction * s.ball.x < -70 * F;
        if (s.tick >= p.roleUntil || p.roleTouch !== s.touchTick || danger) {
          p.aiRole =
            p.id === challenger.id && !supportingHuman
              ? "intercept"
              : direction * s.ball.x < -25 * F
                ? "defend-lane"
                : "support";
          p.roleUntil = s.tick + 18;
          p.roleTouch = s.touchTick;
        }
        let target: { x: number; y: number };
        if (p.aiRole === "intercept") {
          const point =
            forecast.find(
              (f) =>
                distance(p, f) <=
                (RULES.runSpeed * Math.max(0, f.tick - 6)) / 60,
            ) ?? s.ball;
          const goalDir = normalized(
            direction * COURT.goalLine * F - point.x,
            -point.y,
          );
          target = {
            x: point.x - goalDir.x * 12 * F,
            y: point.y - goalDir.y * 12 * F,
          };
        } else if (p.aiRole === "defend-lane")
          target = {
            x: -direction * Math.round(COURT.halfLength * 0.75) * F,
            y: Math.max(-38 * F, Math.min(38 * F, s.ball.y * 0.6)),
          };
        else
          target = {
            x: Math.max(
              -Math.round(COURT.halfLength * 0.78) * F,
              Math.min(
                Math.round(COURT.halfLength * 0.78) * F,
                s.ball.x + direction * 42 * F,
              ),
            ),
            y: s.ball.y > 0 ? -40 * F : 40 * F,
          };
        if (s.mode === "practice") {
          p.aiRole = "feed";
          if (distance(human, s.ball) < 28 * F)
            target = {
              x: Math.max(-100 * F, Math.min(100 * F, human.x + 48 * F)),
              y: human.y > 0 ? -38 * F : 38 * F,
            };
          else {
            const toward = normalized(human.x - s.ball.x, human.y - s.ball.y);
            target = {
              x: s.ball.x - toward.x * 12 * F,
              y: s.ball.y - toward.y * 12 * F,
            };
          }
        }
        p.aiX = Math.round(
          Math.max(
            -(COURT.halfLength - 9) * F,
            Math.min((COURT.halfLength - 9) * F, target.x),
          ),
        );
        p.aiY = Math.round(
          Math.max(
            -(COURT.halfWidth - 9) * F,
            Math.min((COURT.halfWidth - 9) * F, target.y),
          ),
        );
        p.aiPass = false;
        if (distance(p, s.ball) < 30 * F) {
          const goal = { x: direction * COURT.goalLine * F, y: 0 };
          const direct = clearLane(s.ball, goal, s.players, [p.id]);
          let aim = aimHeading(goal.x - s.ball.x, goal.y - s.ball.y);
          if (!direct) {
            const teammate = selectPassTarget(s, p)!;
            const teammateOpen = clearLane(s.ball, teammate, s.players, [
              p.id,
              teammate.id,
            ]);
            if (
              teammateOpen &&
              distance(teammate, s.ball) > 30 * F &&
              teammate.x * direction > p.x * direction - 12 * F
            )
              p.aiPass = true;
            else {
              const banks = ([-1, 1] as const).map((side) =>
                bankHeading(s.ball, side, team, s.tick),
              );
              const bank = banks.find((h) => h !== null);
              if (bank !== undefined && bank !== null) aim = bank;
            }
          }
          p.aiAim =
            (aim + rng.drawInteger("cryptball", "ai", 9) - 4 + 256) % 256;
        } else p.aiAim = aimHeading(direction * COURT.goalLine * F - p.x, -p.y);
      }
      let dx = p.aiX - p.x,
        dy = p.aiY - p.y;
      // Authored quarter-lane waypoints avoid cutting through an occupied lane.
      if (
        due.includes(p) &&
        distance(p, { x: p.aiX, y: p.aiY }) > 36 * F &&
        !clearLane(p, { x: p.aiX, y: p.aiY }, roster, [p.id])
      ) {
        const lanes = [-COURT.halfWidth * 0.6, 0, COURT.halfWidth * 0.6].map(
          (y) => ({
            x: Math.round((p.x + p.aiX) / 2),
            y: y * F,
          }),
        );
        const waypoint = lanes
          .filter((w) => clearLane(p, w, roster, [p.id]))
          .sort(
            (a, b) =>
              distance(p, a) +
              distance(a, { x: p.aiX, y: p.aiY }) -
              distance(p, b) -
              distance(b, { x: p.aiX, y: p.aiY }),
          )[0];
        if (waypoint) {
          dx = waypoint.x - p.x;
          dy = waypoint.y - p.y;
        }
      }
      for (const q of roster)
        if (q.id !== p.id) {
          const d = distance(p, q);
          if (d < 22 * F && d) {
            dx += ((p.x - q.x) * (22 * F - d)) / d;
            dy += ((p.y - q.y) * (22 * F - d)) / d;
          }
        }
      if (
        s.restartProtection &&
        s.restartTeam !== team &&
        direction * (p.x + dx) < 0
      )
        dx = -p.x;
      if (
        distance(p, s.ball) < 20 * F &&
        (Math.abs(s.ball.x) > (COURT.halfLength - 14) * F ||
          Math.abs(s.ball.y) > (COURT.halfWidth - 13) * F)
      ) {
        p.aiAim = aimHeading(s.ball.x - p.x, s.ball.y - p.y);
      }
      const n =
          distance(p, { x: p.aiX, y: p.aiY }) < 2 * F
            ? { x: 0, y: 0 }
            : normalized(dx, dy),
        c: CommandFrame = {
          moveX: n.x,
          moveY: n.y,
          aim: p.aiAim,
          slide: s.tick >= p.aiSlideStart && s.tick < p.aiSlideUntil,
        };
      if (c.slide && slideTarget) {
        const toward = normalized(slideTarget.x - p.x, slideTarget.y - p.y);
        c.moveX = toward.x;
        c.moveY = toward.y;
        c.aim = aimHeading(slideTarget.x - p.x, slideTarget.y - p.y);
      }
      if (
        distance(p, s.ball) < 19 * F &&
        !p.action &&
        !p.charging &&
        !p.dashTicks &&
        s.tick - s.touchTick >= 6
      ) {
        const v = headingVector(p.aiAim),
          bx = s.ball.x - p.x,
          by = s.ball.y - p.y,
          front = bx * v.x + by * v.y > length(bx, by) * 65536 * 0.65;
        if (front || s.mode === "practice") {
          if (s.mode === "practice" || p.aiPass) c.pass = true;
          else {
            const safe =
              s.players
                .filter((q) => q.team !== team)
                .every((q) => distance(p, q) > 55 * F) &&
              length(s.ball.vx, s.ball.vy) < 40 * F;
            c.strikePressed = true;
            c.strikeHeld = safe;
            c.strikeReleased = !safe;
          }
        }
      }
      if (p.charging) {
        c.strikeHeld = p.chargeTicks < RULES.chargeCap;
        c.strikeReleased = p.chargeTicks >= RULES.chargeCap;
      }
      commands.set(p.id, c);
    }
  }
  return commands;
}
