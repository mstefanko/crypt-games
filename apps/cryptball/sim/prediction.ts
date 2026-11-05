import { LEGACY_BALL_PHYSICS, type GroundBallPhysics } from "./sports-spec";
import { COURT } from "./spec";
import { length } from "./rules";
import type { Ball } from "./contract";
import { moveBall, dragBall } from "./ball";
/** Shared static-ball rollout. No alternate bounce equations or whole-court rays. */
export function predictBall(ball: Ball, ticks = 45, startTick = 0, physics: GroundBallPhysics = LEGACY_BALL_PHYSICS) {
  const b = { ...ball },
    points: { x: number; y: number; tick: number }[] = [];
  for (let t = 1; t <= Math.min(45, ticks); t++) {
    for (let i = 0; i < 4; i++)
      if (moveBall(b, [], startTick + t, () => {}, undefined, physics) !== null) {
        points.push({ x: b.x, y: b.y, tick: t });
        return points;
      }
    dragBall(b, physics);
    if (t % 3 === 0) points.push({ x: b.x, y: b.y, tick: t });
    // A resting free orb cannot move without actor input. Preserve every sample
    // and timestamp while avoiding identical static geometry queries in its tail.
    if (!b.vx && !b.vy && !b.rx && !b.ry) {
      for (let next = t + 1; next <= Math.min(45, ticks); next++)
        if (next % 3 === 0) points.push({ x: b.x, y: b.y, tick: next });
      break;
    }
  }
  return points;
}

import {
  queryCircleGeometry,
  type CircleGeometryShape,
} from "@onepage/game-simulation/circle-geometry";
import { BALL_GEOMETRY } from "./court";
import { FIXED as F, RULES, headingVector, aimHeading } from "./rules";
import type { Player } from "./contract";
/** Bounded 32-pixel clearance segments using the physical orb radius. */
export function clearLane(
  from: { x: number; y: number },
  to: { x: number; y: number },
  players: Player[],
  exclude: string[] = [],
  physics: GroundBallPhysics = LEGACY_BALL_PHYSICS,
) {
  const targets: CircleGeometryShape[] = [
    ...BALL_GEOMETRY,
    ...players
      .filter((p) => !exclude.includes(p.id))
      .map((p) => ({
        bodyId: p.id,
        shapeId: "body",
        owner: "players",
        category: "actor" as const,
        region: "body" as const,
        sensor: false,
        priority: 1,
        kind: "circle" as const,
        circle: { x: p.x, y: p.y, radius: RULES.playerRadius },
      })),
  ];
  const dx = to.x - from.x,
    dy = to.y - from.y,
    steps = Math.max(1, Math.ceil(length(dx, dy) / (31 * F)));
  for (let i = 0; i < steps; i++) {
    const x = Math.round(from.x + (dx * i) / steps),
      y = Math.round(from.y + (dy * i) / steps),
      delta = {
        x: Math.round(from.x + (dx * (i + 1)) / steps) - x,
        y: Math.round(from.y + (dy * (i + 1)) / steps) - y,
      };
    if (
      queryCircleGeometry(targets, {
        kind: "sweep",
        circle: { x, y, radius: physics.radius },
        delta,
      }).contacts.some((h) => h.normal.x * delta.x + h.normal.y * delta.y < 0)
    )
      return false;
  }
  return true;
}
/** Mirror-goal bank construction, then verification through the shared rollout. */
export function bankHeading(
  ball: Ball,
  side: -1 | 1,
  team: 0 | 1,
  startTick = 0,
  physics: GroundBallPhysics = LEGACY_BALL_PHYSICS,
) {
  const goalX = (team === 0 ? COURT.goalLine : -COURT.goalLine) * F,
    mirrorY = side * 2 * (COURT.halfWidth - physics.radius / F) * F,
    heading = aimHeading(goalX - ball.x, mirrorY - ball.y),
    v = headingVector(heading),
    copy = {
      ...ball,
      vx: Math.round((v.x * RULES.shotSpeed) / 65536),
      vy: Math.round((v.y * RULES.shotSpeed) / 65536),
    };
  let bank = false;
  for (let t = 0; t < 90; t++) {
    for (let i = 0; i < 4; i++) {
      let goal = moveBall(copy, [], startTick + t, (e) => {
        if (e.type === "board") bank = true;
      }, undefined, physics);
      if (goal !== null) return goal === team && bank ? heading : null;
    }
    dragBall(copy, physics);
    if (!copy.vx && !copy.vy && !copy.rx && !copy.ry) return null;
  }
  return null;
}
