import { specialBallContact } from "./specials";
import type { State } from "./contract";
import { LEGACY_BALL_PHYSICS, type GroundBallPhysics } from "./sports-spec";
import { touchBall } from "./ball";
import { length } from "./rules";
import { queryCircleGeometry } from "@onepage/game-simulation/circle-geometry";
import type { Player, Ball, CryptballEvent } from "./contract";
import { PLAYER_GEOMETRY, clampActor } from "./court";
import { RULES, normalized } from "./rules";
export interface PathSegment {
  x: number;
  y: number;
  dx: number;
  dy: number;
  start: number;
  end: number;
}
export interface Trajectory {
  player: Player;
  x: number;
  y: number;
  dx: number;
  dy: number;
  segments?: PathSegment[];
}
function correctActor(
  p: Player,
  dx: number,
  dy: number,
  ball?: Ball,
  physics: GroundBallPhysics = LEGACY_BALL_PHYSICS,
) {
  const shapes = ball
    ? [
        ...PLAYER_GEOMETRY,
        {
          bodyId: "orb",
          shapeId: "body",
          owner: "orb",
          category: "projectile" as const,
          region: "body" as const,
          sensor: false,
          priority: 1,
          kind: "circle" as const,
          circle: { x: ball.x, y: ball.y, radius: physics.radius },
        },
      ]
    : PLAYER_GEOMETRY;
  const hit = queryCircleGeometry(shapes, {
    kind: "sweep",
    circle: { x: p.x, y: p.y, radius: RULES.playerRadius },
    delta: { x: dx, y: dy },
  }).contacts.find((h) => h.normal.x * dx + h.normal.y * dy < 0);
  const t = hit ? hit.time.n / hit.time.d : 1;
  p.x += Math.trunc(dx * t);
  p.y += Math.trunc(dy * t);
  clampActor(p);
}
export function movePlayers(
  players: Player[],
  ball?: Ball,
  tick = 0,
  emit: (event: CryptballEvent) => void = () => {},
  physics: GroundBallPhysics = LEGACY_BALL_PHYSICS,
  state?: State,
): Trajectory[] {
  const paths = players.map((p) => {
    clampActor(p);
    const x = p.x,
      y = p.y,
      segments: PathSegment[] = [];
    p.rx += p.vx;
    p.ry += p.vy;
    let dx = Math.trunc(p.rx / 240),
      dy = Math.trunc(p.ry / 240);
    p.rx -= dx * 240;
    p.ry -= dy * 240;
    // Project the intended endpoint before constructing the swept path. The
    // convex crease then contains every interpolated pose, not only the final one.
    if (p.role === "keeper") {
      const endpoint = { x: p.x + dx, y: p.y + dy, role: p.role, team: p.team };
      clampActor(endpoint);
      dx = endpoint.x - p.x;
      dy = endpoint.y - p.y;
    }
    let elapsed = 0;
    for (let i = 0; i < 2 && (dx || dy); i++) {
      const geometry = ball
        ? [
            ...PLAYER_GEOMETRY,
            {
              bodyId: "orb",
              shapeId: "body",
              owner: "orb",
              category: "projectile" as const,
              region: "body" as const,
              sensor: false,
              priority: 1,
              kind: "circle" as const,
              circle: { x: ball.x, y: ball.y, radius: physics.radius },
            },
          ]
        : PLAYER_GEOMETRY;
      const hit = queryCircleGeometry(geometry, {
        kind: "sweep",
        circle: { x: p.x, y: p.y, radius: RULES.playerRadius },
        delta: { x: dx, y: dy },
      }).contacts.find((h) => dx * h.normal.x + dy * h.normal.y < 0);
      const t = hit ? hit.time.n / hit.time.d : 1,
        n = hit ? normalized(hit.normal.x, hit.normal.y) : { x: 0, y: 0 };
      const mx = Math.round(dx * t),
        my = Math.round(dy * t),
        end = elapsed + (1 - elapsed) * t;
      segments.push({ x: p.x, y: p.y, dx: mx, dy: my, start: elapsed, end });
      p.x += mx;
      p.y += my;
      elapsed = end;
      if (!hit) break;
      if (
        physics.actorBallNudge &&
        hit.bodyId === "orb" &&
        ball &&
        !p.slideTicks &&
        length(ball.vx - p.vx, ball.vy - p.vy) < 100 * 256
      ) {
        const incomingSpeed = length(ball.vx, ball.vy);
        const speed = Math.min(
          90 * 256,
          Math.max(24 * 256, length(p.vx, p.vy)),
        );
        ball.vx = Math.round(-n.x * speed);
        ball.vy = Math.round(-n.y * speed);
        if (state) specialBallContact(state, p, ball, incomingSpeed);
        touchBall(ball, p, tick, emit);
      }
      if (physics.projectActorVelocity && hit.bodyId !== "orb") {
        const inward = p.vx * n.x + p.vy * n.y;
        if (inward < 0) {
          p.vx = Math.round(p.vx - inward * n.x);
          p.vy = Math.round(p.vy - inward * n.y);
        }
      }
      p.x += Math.round(n.x);
      p.y += Math.round(n.y);
      dx = Math.round(dx * (1 - t));
      dy = Math.round(dy * (1 - t));
      const dot = dx * n.x + dy * n.y;
      dx = Math.round(dx - dot * n.x);
      dy = Math.round(dy - dot * n.y);
    }
    if (elapsed < 1)
      segments.push({ x: p.x, y: p.y, dx: 0, dy: 0, start: elapsed, end: 1 });
    clampActor(p);
    return { player: p, x, y, dx: p.x - x, dy: p.y - y, segments };
  });
  for (let k = 0; k < 2; k++)
    for (let i = 0; i < players.length; i++)
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i],
          b = players[j],
          dx = b.x - a.x,
          dy = b.y - a.y,
          d = length(dx, dy),
          overlap = 2 * RULES.playerRadius - d;
        if (overlap > 0) {
          const n = d ? { x: dx / d, y: dy / d } : { x: 1, y: 0 };
          const push = Math.ceil(overlap / 2);
          correctActor(
            a,
            -Math.round(n.x * push),
            -Math.round(n.y * push),
            ball,
            physics,
          );
          correctActor(
            b,
            Math.round(n.x * push),
            Math.round(n.y * push),
            ball,
            physics,
          );
        }
      }
  // A body cannot squeeze the orb into a board: put penetration correction on
  // the body where the ball's separating direction is blocked by static court.
  if (ball)
    for (const p of players) {
      const dx = p.x - ball.x,
        dy = p.y - ball.y,
        d = length(dx, dy),
        overlap = RULES.playerRadius + physics.radius - d;
      if (overlap <= 0 || !d) continue;
      const n = normalized(dx, dy),
        push = {
          x: Math.round(-n.x * (overlap + 2)),
          y: Math.round(-n.y * (overlap + 2)),
        };
      const blocked = queryCircleGeometry(PLAYER_GEOMETRY, {
        kind: "sweep",
        circle: { x: ball.x, y: ball.y, radius: physics.radius },
        delta: push,
      }).contacts.some((h) => push.x * h.normal.x + push.y * h.normal.y < 0);
      if (blocked || overlap > 1) {
        p.x += Math.round(n.x * (overlap + 2));
        p.y += Math.round(n.y * (overlap + 2));
        clampActor(p);
      }
    }
  for (const path of paths) {
    const p = path.player,
      ex = path.x + path.dx,
      ey = path.y + path.dy;
    if (ex !== p.x || ey !== p.y)
      path.segments!.push({
        x: ex,
        y: ey,
        dx: p.x - ex,
        dy: p.y - ey,
        start: 1,
        end: 1,
      });
    p.distance += Math.round(length(p.x - path.x, p.y - path.y));
  }
  return paths;
}
