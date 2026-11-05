import { describe, expect, it } from "vitest";
import { Texture, TextureSource } from "pixi.js";
import { GroundPlaneMesh, groundSample } from "./ground-plane";
import { projectBillboards } from "../presentation/ground-plane";
describe("native ground projection", () => {
  it("matches the retained CPU projection equations and billboard inverse", () => {
    for (const heading of [0, 0.5, Math.PI, 6.28]) {
      const camera = {
        x: 2000,
        y: 1800,
        height: 42,
        focal: 185,
        horizon: 73,
        heading,
      };
      for (const x of [0, 100, 200, 399])
        for (const y of [74, 100, 150, 224]) {
          const point = groundSample(camera, x, y, 400);
          const distance = (42 * 185) / Math.max(0.5, y - 73),
            span = distance / 185;
          expect(point.x).toBeCloseTo(
            camera.x +
              Math.cos(heading) * distance -
              Math.sin(heading) * span * (x - 200),
            8,
          );
          expect(point.y).toBeCloseTo(
            camera.y +
              Math.sin(heading) * distance +
              Math.cos(heading) * span * (x - 200),
            8,
          );
          const [projected] = projectBillboards(
            [{ id: "sample", ...point, width: 1, height: 1 }],
            camera,
            400,
            225,
          );
          expect(projected!.x).toBeCloseTo(x, 7);
          expect(projected!.y).toBeCloseTo(y, 7);
        }
    }
  });
  it("keeps the horizon finite and wraps heading frames", () => {
    const camera = {
      x: 0,
      y: 0,
      height: 42,
      focal: 185,
      horizon: 73,
      heading: 0,
    };
    expect(
      Object.values(groundSample(camera, 0, 73, 400)).every(Number.isFinite),
    ).toBe(true);
    const frames = [-0.001, 0.001, Math.PI * 2 - 0.001].map(
      (heading) =>
        projectBillboards(
          [{ id: "car", x: 100, y: 0, width: 36, height: 36, heading }],
          camera,
          400,
          225,
          32,
        )[0]!.frame,
    );
    expect(frames).toEqual([0, 0, 0]);
  });
  it("destroys all exclusively owned geometry buffers and tolerates repeated disposal", () => {
    const texture = new Texture({
      source: new TextureSource({ width: 1, height: 1 }),
    });
    const plane = new GroundPlaneMesh(texture, 400, 225, 73, 4000, 4000);
    const buffers = [...plane.geometry.buffers];
    expect(buffers).toHaveLength(3);
    expect(buffers.every((buffer) => !buffer.destroyed)).toBe(true);
    plane.dispose();
    expect(buffers.every((buffer) => buffer.destroyed)).toBe(true);
    expect(texture.destroyed).toBe(true);
    expect(() => plane.dispose()).not.toThrow();
  });
});
