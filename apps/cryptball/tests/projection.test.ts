import { describe, expect, it } from "vitest";
import { COURT } from "../sim/spec";
import { projectCourt, unprojectCourt, screenVectorToWorld } from "../src/projection";
describe("registered frontal court camera", () => {
  it("registers all painted floor corners and the center", () => {
    for (const [u, v, x, y] of [
      [-COURT.halfLength, -COURT.halfWidth, 122, 132],
      [COURT.halfLength, -COURT.halfWidth, 518, 132],
      [-COURT.halfLength, COURT.halfWidth, 45, 305],
      [COURT.halfLength, COURT.halfWidth, 596, 305],
      [0, 0, 320.25, 218.5],
    ]) expect(projectCourt(u, v)).toEqual({ x, y });
  });
  it("inverts corner, post, midfield and outside-floor mouse positions", () => {
    for (const u of [-COURT.halfLength - 8, -COURT.halfLength, 0, COURT.halfLength, COURT.halfLength + 8])
      for (const v of [-COURT.halfWidth, -COURT.goalHalfMouth, 0, COURT.goalHalfMouth, COURT.halfWidth]) {
        const point = projectCourt(u, v), world = unprojectCourt(point.x, point.y);
        expect(world.x).toBeCloseTo(u, 9);
        expect(world.y).toBeCloseTo(v, 9);
      }
  });
  it("keeps horizontal attack and vertical court depth on screen axes", () => {
    expect(screenVectorToWorld(1, 0)).toEqual({ x: 1, y: 0 });
    const south = screenVectorToWorld(0, 1);
    expect(Math.abs(south.x)).toBeLessThan(0.01);
    expect(south.y).toBeGreaterThan(0.99);
  });
});
