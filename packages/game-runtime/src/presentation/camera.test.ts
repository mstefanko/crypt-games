import { describe, expect, it } from "vitest";
import { Camera2D, type CameraOptions } from "./camera.ts";
const options: CameraOptions = {
  width: 320,
  height: 180,
  bounds: { x: 0, y: 0, width: 1000, height: 500 },
  anchor: { x: 0.38, y: 0.55 },
};
describe("V0b one-world camera", () => {
  it("preserves the legacy follow anchor and clamps both edges", () => {
    const camera = new Camera2D(options);
    expect(camera.follow({ x: 200, y: 150 })).toEqual({
      x: 78,
      y: 51,
      zoom: 1,
      offsetX: 0,
      offsetY: 0,
    });
    expect(camera.follow({ x: -100, y: -100 })).toMatchObject({ x: 0, y: 0 });
    expect(camera.follow({ x: 2000, y: 2000 })).toMatchObject({
      x: 680,
      y: 320,
    });
  });
  it("keeps a deadzone in logical screen units and snaps on a discontinuity", () => {
    const camera = new Camera2D({
      ...options,
      anchor: { x: 0.5, y: 0.5 },
      deadzone: { x: 20, y: 10 },
    });
    expect(camera.follow({ x: 200, y: 150 })).toMatchObject({ x: 40, y: 60 });
    expect(camera.follow({ x: 219, y: 159 })).toMatchObject({ x: 40, y: 60 });
    expect(camera.follow({ x: 240, y: 180 })).toMatchObject({ x: 60, y: 80 });
    expect(camera.follow({ x: 240, y: 180 }, true)).toMatchObject({
      x: 80,
      y: 90,
    });
    camera.reset();
    expect(camera.follow({ x: 200, y: 150 })).toMatchObject({ x: 40, y: 60 });
  });
  it("bounds zoomed/fractional origins and inverses world mapping including shake", () => {
    const camera = new Camera2D({
      ...options,
      zoom: 1.5,
      bounds: { x: 0.4, y: 0.6, width: 500.2, height: 250.3 },
    });
    expect(camera.follow({ x: -100, y: -100 })).toMatchObject({
      x: 0.4,
      y: 0.6,
    });
    const interior = camera.follow({ x: 250, y: 150 }, true);
    expect(interior.x * interior.zoom).toBe(
      Math.round(interior.x * interior.zoom),
    );
    expect(interior.y * interior.zoom).toBe(
      Math.round(interior.y * interior.zoom),
    );
    const end = camera.follow({ x: 9999, y: 9999 });
    expect(end.x).toBeLessThanOrEqual(0.4 + 500.2 - 320 / 1.5);
    expect(end.y).toBeLessThanOrEqual(0.6 + 250.3 - 180 / 1.5);
    camera.shake(8, 200);
    const t = camera.advance(25),
      world = { x: 333, y: 185 };
    expect(
      camera.toWorld({
        x: (world.x - t.x) * t.zoom + t.offsetX,
        y: (world.y - t.y) * t.zoom + t.offsetY,
      }),
    ).toEqual(world);
    camera.advance(100);
    camera.advance(75);
    expect(camera.inspect()).toMatchObject({ offsetX: 0, offsetY: 0 });
  });
  it("clears shake for reduced motion and cannot reenable it accidentally", () => {
    const camera = new Camera2D(options);
    camera.shake(10, 100);
    expect(camera.inspect().offsetX).toBe(10);
    camera.configure({ ...options, reducedMotion: true });
    expect(camera.inspect().offsetX).toBe(0);
    expect(camera.shake(8, 100)).toBe(false);
    camera.configure(options);
    expect(camera.inspect().offsetX).toBe(0);
  });
  it("rejects malformed options, targets and deltas before changing retained state", () => {
    const camera = new Camera2D(options);
    camera.follow({ x: 200, y: 150 });
    const before = camera.inspect();
    for (const bad of [
      { ...options, zoom: 0 },
      { ...options, deadzone: { x: NaN, y: 0 } },
      { ...options, bounds: { x: 0, y: 0, width: -1, height: 4 } },
    ]) {
      expect(() => camera.configure(bad)).toThrow();
      expect(camera.inspect()).toEqual(before);
    }
    expect(() => camera.follow({ x: Infinity, y: 0 })).toThrow();
    expect(() => camera.advance(101)).toThrow();
    expect(() => camera.shake(33, 100)).toThrow();
    expect(camera.inspect()).toEqual(before);
  });
});
