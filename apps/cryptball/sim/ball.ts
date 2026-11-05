import { playerSpecial, specialKind, specialBallContact } from "./specials";
import type { State } from "./contract";
import { LEGACY_BALL_PHYSICS, type GroundBallPhysics } from "./sports-spec";
import { COURT } from "./spec";
import { clampActor } from "./court";
import { length } from "./rules";
import {
  queryCircleGeometry,
  type CircleGeometryShape,
} from "@onepage/game-simulation/circle-geometry";
import type { Ball, Team, CryptballEvent } from "./contract";
import { queryCourtSweep } from "./court";
import { RULES, FIXED as F, normalized, headingVector } from "./rules";
import type { Trajectory } from "./motion";
/** Game-owned contact surfaces participate in the same clock as bodies, boards and goals. */
export interface GroundContact {
  t: number;
  player: Trajectory["player"];
  actionId: number;
  heading: number;
  kind: "pass" | "wrist" | "slap" | "poke";
}
export interface GroundContactProvider {
  query(
    ball: Ball,
    paths: Trajectory[],
    delta: { x: number; y: number },
    elapsed: number,
    remaining: number,
  ): GroundContact[];
  resolve(ball: Ball, contacts: GroundContact[]): void;
}
/** One physical touch owns pass completion/interception and powered-shot removal. */
export function touchBall(
  b: Ball,
  player: Trajectory["player"],
  tick: number,
  emit: (event: CryptballEvent) => void,
) {
  b.bankBonusRemaining = 0;
  b.powerTeam = null;
  b.powerActionKey = null;
  b.lastTouch = player.id;
  if (b.passFrom && player.id === b.passTarget) {
    emit({
      type: "pass-complete",
      tick,
      playerId: player.id,
      team: player.team,
      passerId: b.passFrom,
      x: b.x,
      y: b.y,
    });
    b.passFrom = b.passTarget = null;
    b.passTeam = null;
  } else if (b.passFrom && player.team !== b.passTeam) {
    b.passFrom = b.passTarget = null;
    b.passTeam = null;
  }
}
export function capBall(
  b: Ball,
  physics: GroundBallPhysics = LEGACY_BALL_PHYSICS,
) {
  const n = length(b.vx, b.vy);
  if (n > physics.maxSpeed) {
    b.vx = Math.round((b.vx * physics.maxSpeed) / n);
    b.vy = Math.round((b.vy * physics.maxSpeed) / n);
  }
}
function moveInterval(
  b: Ball,
  paths: Trajectory[],
  tick: number,
  emit: (e: CryptballEvent) => void,
  interval: number,
  budget: { contacts: number; stopped: boolean },
  skipPlayer?: (player: Trajectory["player"]) => boolean,
  physics: GroundBallPhysics = LEGACY_BALL_PHYSICS,
  contactProvider?: GroundContactProvider,
  state?: State,
): Team | null {
  b.rx += Math.round(b.vx * interval);
  b.ry += Math.round(b.vy * interval);
  let dx = Math.trunc(b.rx / 240),
    dy = Math.trunc(b.ry / 240);
  b.rx -= dx * 240;
  b.ry -= dy * 240;
  let elapsed = 0,
    remaining = 1;
  const manifold: {
    x: number;
    y: number;
    nx: number;
    ny: number;
    vx: number;
    vy: number;
  }[] = [];
  for (;;) {
    const count = budget.contacts;
    const staticHit = queryCourtSweep(
      { x: b.x, y: b.y, radius: physics.radius },
      { x: dx, y: dy },
    ).contacts.find((h) => h.normal.x * dx + h.normal.y * dy < 0);
    let candidate = staticHit
      ? {
          hit: staticHit,
          t: staticHit.time.n / staticHit.time.d,
          vx: 0,
          vy: 0,
          player: null as Trajectory["player"] | null,
          guard: false,
        }
      : null;
    for (const path of paths) {
      if (skipPlayer?.(path.player)) continue;
      const target: CircleGeometryShape = {
        bodyId: path.player.id,
        shapeId: "body",
        owner: "players",
        category: "actor",
        region: "body",
        sensor: false,
        priority: 1,
        kind: "circle",
        circle: {
          x: Math.round(path.x + path.dx * elapsed),
          y: Math.round(path.y + path.dy * elapsed),
          radius:
            path.player.slideTicks && physics.slideContacts
              ? 5 * F
              : RULES.playerRadius,
        },
      };
      const relative = {
        x: Math.round(dx - path.dx * remaining),
        y: Math.round(dy - path.dy * remaining),
      };
      if (path.player.slideTicks && physics.slideContacts) {
        const facing = headingVector(path.player.slideHeading);
        const extended =
          specialKind(state, path.player) === "gators" &&
          !path.player.slideBallHit;
        const scale = extended ? 1.5 : 1;
        const offsets = (
          path.player.role === "keeper" ? [-12, -4, 4, 12] : [-6, 0, 8]
        ).map((n) => n * scale);
        const chain: CircleGeometryShape[] = offsets.map((offset, i) => ({
          ...target,
          shapeId: `slide-${i}`,
          circle: {
            x: Math.round(target.circle.x + (facing.x * offset * F) / 65536),
            y: Math.round(target.circle.y + (facing.y * offset * F) / 65536),
            radius: Math.round(5 * F * (extended ? 1.35 : 1)),
          },
        }));
        const hit = queryCircleGeometry(chain, {
          kind: "sweep",
          circle: { x: b.x, y: b.y, radius: physics.radius },
          delta: relative,
        }).contacts.find(
          (h) => h.normal.x * relative.x + h.normal.y * relative.y < 0,
        );
        if (hit) {
          const t = hit.time.n / hit.time.d;
          if (!candidate || t < candidate.t)
            candidate = {
              hit,
              t,
              vx: path.player.vx,
              vy: path.player.vy,
              player: path.player,
              guard: true,
            };
        }
      }
      const hit = queryCircleGeometry([target], {
        kind: "sweep",
        circle: { x: b.x, y: b.y, radius: physics.radius },
        delta: relative,
      }).contacts.find(
        (h) => h.normal.x * relative.x + h.normal.y * relative.y < 0,
      );
      if (hit) {
        const t = hit.time.n / hit.time.d;
        if (!candidate || t < candidate.t)
          candidate = {
            hit,
            t,
            vx: (path.dx * 240) / interval,
            vy: (path.dy * 240) / interval,
            player: path.player,
            guard: !!path.player.slideTicks && physics.slideContacts,
          };
      }
    }
    const sticks =
      contactProvider?.query(b, paths, { x: dx, y: dy }, elapsed, remaining) ??
      [];
    sticks.sort(
      (a, c) =>
        a.t - c.t ||
        a.actionId - c.actionId ||
        (a.player.id < c.player.id ? -1 : 1),
    );
    const stick = sticks[0];
    const stickFirst = !!stick && (!candidate || stick.t < candidate.t);
    let goal: Team | null = null,
      goalT = Infinity;
    for (const side of [-1, 1])
      if (side * dx > 0) {
        const t =
          (side *
            (COURT.goalLine * F +
              (physics.wholeObjectGoal ? physics.radius : 0)) -
            b.x) /
          dx;
        if (
          t >= 0 &&
          t <= 1 &&
          Math.abs(b.y + dy * t) <=
            (COURT.goalHalfMouth - physics.radius / F) * F &&
          t < goalT
        ) {
          goalT = t;
          goal = side === 1 ? 0 : 1;
        }
      }
    if (
      goal !== null &&
      (!candidate || goalT < candidate.t) &&
      (!stickFirst || goalT < stick.t)
    ) {
      b.x += Math.round(dx * goalT);
      b.y += Math.round(dy * goalT);
      return goal;
    }
    if (stickFirst) {
      if (budget.contacts >= 4) {
        emit({
          type: "diagnostic",
          tick,
          reason: "ball-contact-budget",
          x: b.x,
          y: b.y,
        });
        budget.stopped = true;
        return null;
      }
      budget.contacts++;
      b.x += Math.round(dx * stick.t);
      b.y += Math.round(dy * stick.t);
      contactProvider!.resolve(
        b,
        sticks.filter((h) => h.t === stick.t),
      );
      capBall(b, physics);
      elapsed += remaining * stick.t;
      remaining *= 1 - stick.t;
      dx = Math.round((b.vx / 240) * remaining * interval);
      dy = Math.round((b.vy / 240) * remaining * interval);
      if (!dx && !dy) return null;
      continue;
    }
    if (!candidate) {
      b.x += dx;
      b.y += dy;
      return null;
    }
    if (budget.contacts >= 4) {
      emit({
        type: "diagnostic",
        tick,
        reason: "ball-contact-budget",
        x: b.x,
        y: b.y,
      });
      budget.stopped = true;
      return null;
    }
    budget.contacts++;
    const { hit, t, player, guard } = candidate;
    let { vx, vy } = candidate;
    let n = normalized(hit.normal.x, hit.normal.y);
    if (!n.x && !n.y) n = normalized(-dx, -dy);
    b.x += Math.round(dx * t + n.x);
    b.y += Math.round(dy * t + n.y);
    if (player && !guard) {
      const path = paths.find((p) => p.player.id === player.id)!;
      const px = path.x + path.dx * (elapsed + remaining * t),
        py = path.y + path.dy * (elapsed + remaining * t);
      const penetration =
        physics.radius + RULES.playerRadius - length(b.x - px, b.y - py);
      if (penetration > -4) {
        const correction = {
          x: Math.round(n.x * (Math.max(0, penetration) + 2 * F)),
          y: Math.round(n.y * (Math.max(0, penetration) + 2 * F)),
        };
        const blocked = queryCourtSweep(
          { x: b.x, y: b.y, radius: physics.radius },
          correction,
        ).contacts.some(
          (h) => h.normal.x * correction.x + h.normal.y * correction.y < 0,
        );
        if (blocked || penetration > 0 || t < 0.01 || count > 0) {
          // An embedded player cannot act as an infinite motor against a board.
          // Apply the constraint correction to that body, then keep its collider at
          // the corrected pose for the unconsumed interval (no hidden ghost period).
          const push = penetration + 2 * F;
          player.x = Math.round(px - n.x * push);
          player.y = Math.round(py - n.y * push);
          clampActor(player);
          player.vx = player.vy = 0;
          path.x = player.x;
          path.y = player.y;
          path.dx = path.dy = 0;
          candidate.vx = candidate.vy = 0;
          vx = vy = 0;
        }
      }
    }
    const incomingSpeed = length(b.vx, b.vy);
    const dot = (b.vx - vx) * n.x + (b.vy - vy) * n.y;
    const enhancedBank =
      physics.poweredBanks &&
      !player &&
      (hit.bodyId === "north" || hit.bodyId === "south") &&
      b.bankBonusRemaining > 0 &&
      tick < b.powerExpires;
    const restitution = enhancedBank
      ? 0.98
      : player
        ? physics.bodyRestitution
        : hit.bodyId.startsWith("post")
          ? physics.postRestitution
          : physics.boardRestitution;
    if (guard && player && dot < 0) {
      const incoming = length(b.vx, b.vy),
        speed = Math.min(
          incoming,
          160 * F,
          Math.max(40 * F, Math.round(incoming / 2)),
        );
      const reflected = normalized(
        b.vx - 2 * (b.vx * n.x + b.vy * n.y) * n.x,
        b.vy - 2 * (b.vx * n.x + b.vy * n.y) * n.y,
      );
      b.vx = Math.round(reflected.x * speed);
      b.vy = Math.round(reflected.y * speed);
      while (b.vx * b.vx + b.vy * b.vy > incoming * incoming) {
        if (Math.abs(b.vx) >= Math.abs(b.vy)) b.vx -= Math.sign(b.vx);
        else b.vy -= Math.sign(b.vy);
      }
      emit({
        type: player.role === "keeper" ? "save" : "slide-contact",
        tick,
        playerId: player.id,
        team: player.team,
        x: b.x,
        y: b.y,
      });
      b.bankBonusRemaining = 0;
      b.powerTeam = null;
      b.powerActionKey = null;
      // Slides deflect existing energy; their moving frame must not motor a
      // pinched orb during the simultaneous-contact manifold projection.
      vx = vy = 0;
    } else if (dot < 0) {
      b.vx = Math.round(b.vx - (1 + restitution) * dot * n.x);
      b.vy = Math.round(b.vy - (1 + restitution) * dot * n.y);
      capBall(b, physics);
    }
    if (enhancedBank) {
      b.bankBonusRemaining = 0;
      b.powerTeam = null;
      b.powerActionKey = null;
      emit({ type: "power-bank", tick, x: b.x, y: b.y });
    }
    // Persistent pinches are simultaneous constraints, not independent infinite
    // rebounds. Retain only contact planes still within one separation unit;
    // project the outgoing velocity onto their common free tangent directions.
    for (let k = manifold.length - 1; k >= 0; k--)
      if (
        Math.abs(
          (b.x - manifold[k].x) * manifold[k].nx +
            (b.y - manifold[k].y) * manifold[k].ny,
        ) >
        2 * F
      )
        manifold.splice(k, 1);
    manifold.push({ x: b.x, y: b.y, nx: n.x, ny: n.y, vx, vy });
    if (manifold.length > 1)
      for (let pass = 0; pass < 4; pass++)
        for (const plane of manifold) {
          const inward =
            (b.vx - plane.vx) * plane.nx + (b.vy - plane.vy) * plane.ny;
          if (inward < 0) {
            b.vx = Math.round(b.vx - inward * plane.nx);
            b.vy = Math.round(b.vy - inward * plane.ny);
          }
        }
    if (player) {
      if (state) specialBallContact(state, player, b, incomingSpeed);
      touchBall(b, player, tick, emit);
    } else
      emit({
        type: hit.bodyId.startsWith("post") ? "post" : "board",
        tick,
        x: b.x,
        y: b.y,
      });
    elapsed += remaining * t;
    remaining *= 1 - t;
    dx = Math.round((b.vx / 240) * remaining * interval);
    dy = Math.round((b.vy / 240) * remaining * interval);
    if (!dx && !dy) return null;
  }
}
export function dragBall(
  b: Ball,
  physics: GroundBallPhysics = LEGACY_BALL_PHYSICS,
) {
  const speed = length(b.vx, b.vy);
  b.dragCarry += physics.rollingDeceleration;
  const drag = Math.trunc(b.dragCarry / 60);
  b.dragCarry -= drag * 60;
  const next = Math.max(0, speed - drag);
  if (next < physics.restSpeed) {
    b.vx = b.vy = b.rx = b.ry = 0;
    if (physics.clearDragAtRest) b.dragCarry = 0;
  } else {
    b.vx = Math.round((b.vx * next) / speed);
    b.vy = Math.round((b.vy * next) / speed);
  }
}

/** Piecewise actor paths share a common substep clock; wall slides are never
 * approximated by their chord. Pair separation is an instantaneous end correction. */
export function moveBall(
  b: Ball,
  paths: Trajectory[],
  tick: number,
  emit: (e: CryptballEvent) => void,
  skipPlayer?: (player: Trajectory["player"]) => boolean,
  physics: GroundBallPhysics = LEGACY_BALL_PHYSICS,
  contactProvider?: GroundContactProvider,
  state?: State,
): Team | null {
  const budget = { contacts: 0, stopped: false };
  const times = [
    ...new Set([
      0,
      1,
      ...paths.flatMap((p) =>
        (p.segments ?? []).flatMap((s) => [s.start, s.end]),
      ),
    ]),
  ].sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++) {
    const start = times[i - 1],
      end = times[i];
    if (end <= start) continue;
    const pieces = paths.map((p) => {
      const segment = p.segments?.find(
        (s) => s.start <= start && s.end >= end && s.end > s.start,
      );
      if (!segment)
        return {
          ...p,
          x: Math.trunc(p.x + p.dx * start),
          y: Math.trunc(p.y + p.dy * start),
          dx: Math.round(p.dx * (end - start)),
          dy: Math.round(p.dy * (end - start)),
        };
      const duration = segment.end - segment.start,
        f = (start - segment.start) / duration;
      return {
        ...p,
        x: Math.round(segment.x + segment.dx * f),
        y: Math.round(segment.y + segment.dy * f),
        dx: Math.round((segment.dx * (end - start)) / duration),
        dy: Math.round((segment.dy * (end - start)) / duration),
      };
    });
    const goal = moveInterval(
      b,
      pieces,
      tick,
      emit,
      end - start,
      budget,
      skipPlayer,
      physics,
      contactProvider,
      state,
    );
    if (goal !== null) return goal;
    if (budget.stopped) return null;
    for (const path of paths)
      if (
        path.player.vx === 0 &&
        path.player.vy === 0 &&
        (path.dx || path.dy)
      ) {
        path.x = path.player.x;
        path.y = path.player.y;
        path.dx = path.dy = 0;
        path.segments = [
          { x: path.x, y: path.y, dx: 0, dy: 0, start: 0, end: 1 },
        ];
      }
  }
  return null;
}
