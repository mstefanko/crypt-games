import { describe, expect, it } from "vitest";
import {
  applyViewportStyle,
  clientToLogical,
  createViewportMapping,
  logicalToClient,
  MAX_BACKBUFFER_EDGE,
} from "./viewport.ts";
const defaults = {
  logicalWidth: 320,
  logicalHeight: 180,
  cssWidth: 900,
  cssHeight: 600,
};
describe("presentation viewport", () => {
  it("separates logical, letterboxed CSS and bounded backing pixels", () => {
    const mapping = createViewportMapping({
      ...defaults,
      integerScale: true,
      devicePixelRatio: 2,
    });
    expect(mapping.content).toEqual({
      x: 130,
      y: 120,
      width: 640,
      height: 360,
    });
    expect(mapping.scale).toBe(2);
    expect(mapping.resolution).toBe(4);
    expect(mapping.backbuffer).toEqual({ width: 1280, height: 720 });
    expect(mapping.logicalWidth).toBe(320);
    expect(Object.isFrozen(mapping.content)).toBe(true);
  });
  it("keeps integer-scale offsets integral on odd surfaces and uses renderer rounding order", () => {
    const mapping = createViewportMapping({
      ...defaults,
      cssWidth: 901,
      cssHeight: 601,
      integerScale: true,
    });
    expect(mapping.content.x).toBe(130);
    expect(mapping.content.y).toBe(120);
    for (const cssWidth of [333.5, 481.25, 703.75]) {
      const fractional = createViewportMapping({
        ...defaults,
        cssWidth,
        devicePixelRatio: 1.3,
      });
      expect(fractional.backbuffer.width).toBe(
        Math.round(fractional.logicalWidth * fractional.resolution),
      );
      expect(fractional.backbuffer.height).toBe(
        Math.round(fractional.logicalHeight * fractional.resolution),
      );
    }
  });
  it("uses fractional contain by default and below one for integer mode", () => {
    expect(createViewportMapping(defaults).scale).toBe(900 / 320);
    expect(
      createViewportMapping({ ...defaults, cssWidth: 160, integerScale: true })
        .content,
    ).toEqual({ x: 0, y: 255, width: 160, height: 90 });
  });
  it("inverts points after offset, scrolling and axis-aligned CSS scaling without DPR", () => {
    const mapping = createViewportMapping({
      ...defaults,
      integerScale: true,
      devicePixelRatio: 3,
    });
    for (const bounds of [
      { left: 10, top: -50, width: 900, height: 600 },
      { left: -20, top: 25, width: 450, height: 300 },
    ])
      for (const point of [
        { x: 0, y: 0 },
        { x: 120.5, y: 75.25 },
        { x: 319.5, y: 179.5 },
      ]) {
        const client = logicalToClient(mapping, bounds, point)!;
        const inverse = clientToLogical(mapping, bounds, client)!;
        expect(inverse.x).toBeCloseTo(point.x, 10);
        expect(inverse.y).toBeCloseTo(point.y, 10);
      }
  });
  it("rejects letterbox and the half-open right/bottom edge", () => {
    const mapping = createViewportMapping({ ...defaults, integerScale: true });
    const bounds = { left: 0, top: 0, width: 900, height: 600 };
    for (const point of [
      { x: 129, y: 200 },
      { x: 200, y: 119 },
      { x: 770, y: 200 },
      { x: 200, y: 480 },
    ])
      expect(clientToLogical(mapping, bounds, point)).toBeNull();
    expect(clientToLogical(mapping, bounds, { x: 130, y: 120 })).toEqual({
      x: 0,
      y: 0,
    });
  });
  it("consumes asymmetric local insets once and keeps every content edge safe", () => {
    const mapping = createViewportMapping({
      ...defaults,
      safeArea: { left: 30, right: 70, top: 20, bottom: 40 },
    });
    expect(mapping.content.x).toBe(30);
    expect(mapping.content.width).toBe(800);
    expect(mapping.content.y).toBe(65);
    expect(mapping.content.height).toBe(450);
    const bounds = { left: 0, top: 0, width: 900, height: 600 };
    expect(clientToLogical(mapping, bounds, { x: 29, y: 100 })).toBeNull();
    expect(clientToLogical(mapping, bounds, { x: 30, y: 65 })).toEqual({
      x: 0,
      y: 0,
    });
  });
  it("caps DPR and total backing edge independently", () => {
    expect(
      createViewportMapping({ ...defaults, devicePixelRatio: 100 }).pixelRatio,
    ).toBe(3);
    const huge = createViewportMapping({
      ...defaults,
      cssWidth: 32768,
      cssHeight: 32768,
      devicePixelRatio: 3,
    });
    expect(huge.backbuffer.width).toBe(MAX_BACKBUFFER_EDGE);
    expect(huge.backbuffer.height).toBeLessThanOrEqual(MAX_BACKBUFFER_EDGE);
    expect(
      createViewportMapping({ ...defaults, devicePixelRatio: 0.75 }).pixelRatio,
    ).toBe(0.75);
  });
  it("handles hidden and fully inset surfaces without NaN or picking", () => {
    for (const mapping of [
      createViewportMapping({ ...defaults, cssWidth: 0 }),
      createViewportMapping({
        ...defaults,
        safeArea: { left: 900, right: 900 },
      }),
    ]) {
      expect(mapping.scale).toBe(0);
      expect(mapping.backbuffer).toEqual({ width: 0, height: 0 });
      expect(
        clientToLogical(
          mapping,
          { left: 0, top: 0, width: 900, height: 600 },
          { x: 500, y: 300 },
        ),
      ).toBeNull();
    }
  });
  it.each([
    { logicalWidth: 0 },
    { logicalHeight: Infinity },
    { cssWidth: -1 },
    { cssHeight: NaN },
    { cssWidth: 32769 },
    { devicePixelRatio: 0 },
    { devicePixelRatio: NaN },
    { safeArea: { top: -1 } },
  ])("rejects malformed/beyond-budget dimensions %o", (invalid) => {
    expect(() => createViewportMapping({ ...defaults, ...invalid })).toThrow(
      RangeError,
    );
  });
  it("rejects invalid client bounds/points and applies only the CSS content rect", () => {
    const mapping = createViewportMapping({ ...defaults, integerScale: true });
    expect(
      clientToLogical(
        mapping,
        { left: 0, top: 0, width: 0, height: 600 },
        { x: 200, y: 200 },
      ),
    ).toBeNull();
    expect(
      clientToLogical(
        mapping,
        { left: 0, top: 0, width: 900, height: 600 },
        { x: NaN, y: 200 },
      ),
    ).toBeNull();
    const canvas = { style: {} } as HTMLCanvasElement;
    applyViewportStyle(canvas, mapping);
    expect(canvas.style).toEqual({
      position: "absolute",
      left: "130px",
      top: "120px",
      width: "640px",
      height: "360px",
    });
  });
});
