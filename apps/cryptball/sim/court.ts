import { COURT } from "./spec";
import {
  queryCircleGeometry,
  type CircleGeometryShape,
} from "@onepage/game-simulation/circle-geometry";
import { FIXED as F, length } from "./rules";
const base = {
  owner: "court",
  category: "world" as const,
  region: "body" as const,
  sensor: false,
  priority: 0,
};
export const rect = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): CircleGeometryShape => ({
  ...base,
  bodyId: id,
  shapeId: id,
  kind: "rect",
  rect: { x: x * F, y: y * F, width: width * F, height: height * F },
});
const L = COURT.halfLength,
  W = COURT.halfWidth,
  G = COURT.goalHalfMouth,
  B = COURT.boardThickness;
export const POSTS: CircleGeometryShape[] = [-L, L].flatMap((x) =>
  [-G, G].map((y) => ({
    ...base,
    bodyId: `post:${x}:${y}`,
    shapeId: "body",
    kind: "circle" as const,
    circle: { x: x * F, y: y * F, radius: COURT.postRadius * F },
  })),
);
export const BALL_GEOMETRY: CircleGeometryShape[] = [
  rect("north", -L - B, -W - B, 2 * (L + B), B),
  rect("south", -L - B, W, 2 * (L + B), B),
  ...[-1, 1].flatMap((side) => [
    rect(`end:${side}:n`, side < 0 ? -L - B : L, -W - B, B, W + B - G),
    rect(`end:${side}:s`, side < 0 ? -L - B : L, G, B, W + B - G),
    rect(
      `net:${side}`,
      side < 0 ? -L - COURT.netDepth - B : L + COURT.netDepth,
      -G,
      B,
      2 * G,
    ),
  ]),
  ...POSTS,
];
export const PLAYER_GEOMETRY = [
  rect("actor:north", -L - B, -W - B, 2 * (L + B), B),
  rect("actor:south", -L - B, W, 2 * (L + B), B),
  rect("actor:west", -L - B, -W - B, B, 2 * (W + B)),
  rect("actor:east", L, -W - B, B, 2 * (W + B)),
];
export function clampActor(p: {
  x: number;
  y: number;
  role?: string;
  team?: number;
}) {
  p.x = Math.max(-(L - 7) * F, Math.min((L - 7) * F, p.x));
  p.y = Math.max(-(W - 7) * F, Math.min((W - 7) * F, p.y));
  if (p.role === "keeper") {
    const side = p.team === 0 ? -1 : 1;
    const depth = Math.max(
      L - COURT.creaseDepth + 7,
      Math.min(L - 7, (side * p.x) / F),
    );
    p.x = side * depth * F;
    const half = (COURT.creaseHalfWidth - 7) * F;
    p.y = Math.max(-half, Math.min(half, p.y));
    const radius = 8 * F,
      cx = (L - COURT.creaseDepth + 15) * F,
      cy = Math.sign(p.y) * (half - radius);
    const inward = side * p.x;
    if (inward < cx && Math.abs(p.y) > half - radius) {
      const dx = inward - cx,
        dy = p.y - cy,
        d = length(dx, dy);
      if (d > radius) {
        p.x = side * (cx + Math.trunc((dx * radius) / d));
        p.y = cy + Math.trunc((dy * radius) / d);
      }
    }
  }
}

// Authored court shapes never move. Cache conservative bounds in authored order.
const ballBounds = BALL_GEOMETRY.map((shape) =>
  shape.kind === "rect"
    ? {
        minX: shape.rect.x,
        minY: shape.rect.y,
        maxX: shape.rect.x + shape.rect.width,
        maxY: shape.rect.y + shape.rect.height,
      }
    : {
        minX: shape.circle.x - shape.circle.radius,
        minY: shape.circle.y - shape.circle.radius,
        maxX: shape.circle.x + shape.circle.radius,
        maxY: shape.circle.y + shape.circle.radius,
      },
);
/** Conservative broadphase only: the engine still owns exact contacts, normals,
 * quantized times and ordering. Closed comparisons retain all touching edges. */
export function queryCourtSweep(
  circle: { x: number; y: number; radius: number },
  delta: { x: number; y: number },
) {
  const minX = Math.min(circle.x, circle.x + delta.x) - circle.radius;
  const maxX = Math.max(circle.x, circle.x + delta.x) + circle.radius;
  const minY = Math.min(circle.y, circle.y + delta.y) - circle.radius;
  const maxY = Math.max(circle.y, circle.y + delta.y) + circle.radius;
  const candidates = BALL_GEOMETRY.filter((_, i) => {
    const bounds = ballBounds[i];
    return (
      minX <= bounds.maxX &&
      maxX >= bounds.minX &&
      minY <= bounds.maxY &&
      maxY >= bounds.minY
    );
  });
  return queryCircleGeometry(candidates, { kind: "sweep", circle, delta });
}
