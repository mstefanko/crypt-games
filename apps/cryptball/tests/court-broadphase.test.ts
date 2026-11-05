import { COURT } from "../sim/spec";
import { describe, it, expect } from "vitest";
import { queryCircleGeometry } from "@onepage/game-simulation/circle-geometry";
import { BALL_GEOMETRY, queryCourtSweep } from "../sim/court";
import { FIXED as F, RULES, headingVector } from "../sim/rules";
describe("immutable court conservative broadphase", () => {
  it("retains exactly the uncull engine contacts for interior, board, post and corner sweeps", () => {
    const L = COURT.halfLength,
      W = COURT.halfWidth,
      G = COURT.goalHalfMouth;
    const positions = [
      { x: 0, y: 0 },
      { x: (L - 3) * F, y: (G - 3) * F },
      { x: (L - 6) * F, y: G * F },
      { x: (L - 4) * F, y: (W - 6) * F },
      { x: -(L - 3) * F, y: -(W - 3) * F },
      { x: 0, y: (W - 3) * F },
      { x: COURT.goalLine * F, y: (G - 3) * F },
      { x: (L + COURT.netDepth) * F, y: 0 },
    ];
    for (const origin of positions)
      for (let h = 0; h < 256; h += 7)
        for (const radius of [RULES.ballRadius, RULES.playerRadius]) {
          const d = headingVector(h),
            delta = {
              x: Math.round((d.x * 1500) / 65536),
              y: Math.round((d.y * 1500) / 65536),
            },
            circle = { ...origin, radius };
          const reference = queryCircleGeometry(BALL_GEOMETRY, {
            kind: "sweep",
            circle,
            delta,
          });
          expect(queryCourtSweep(circle, delta).contacts).toEqual(
            reference.contacts,
          );
        }
  });
  it("retains closed touching boundaries and removes far shapes without changing input order", () => {
    const circle = {
        x: 0,
        y: (COURT.halfWidth - 3) * F,
        radius: RULES.ballRadius,
      },
      delta = { x: 0, y: 1 };
    expect(queryCourtSweep(circle, delta).contacts).toEqual(
      queryCircleGeometry(BALL_GEOMETRY, { kind: "sweep", circle, delta })
        .contacts,
    );
    expect(
      queryCourtSweep({ x: 0, y: 0, radius: RULES.ballRadius }, { x: 0, y: 0 })
        .candidates,
    ).toHaveLength(0);
  });
});
