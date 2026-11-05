import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GameDefinitions } from "../../../game-project/src/types.ts";
import type { PreparedSkin } from "../m2-assets.ts";
import { createViewportMapping } from "./viewport.ts";

vi.mock("pixi.js", () => {
  class Node {
    position = { set: vi.fn() };
    addChild = vi.fn();
    destroy = vi.fn();
    rect() {
      return this;
    }
    fill() {
      return this;
    }
  }
  return {
    Application: class {
      stage = new Node();
      screen = { width: 320, height: 180 };
      renderer = {
        resolution: 1,
        resize: vi.fn((_width: number, _height: number, resolution: number) => {
          this.renderer.resolution = resolution;
        }),
      };
      canvas = { style: {}, hidden: false, setAttribute: vi.fn() };
      init = async () => {};
      stop = vi.fn();
      render = vi.fn();
      destroy = vi.fn();
    },
    Container: Node,
    Graphics: Node,
    BitmapText: Node,
    Sprite: Node,
    Texture: class {},
    Rectangle: class {},
  };
});
vi.mock("../art.ts", () => ({
  makeArt: () => ({ fontName: "test", dispose: vi.fn() }),
}));
vi.mock("../m2-font.ts", () => ({
  makeM2Font: () => ({ fontName: "test", dispose: vi.fn() }),
}));
import { GameView } from "../view.ts";
import { M2View } from "../m2-view.ts";
const definitions = {
  manifest: { viewport: { width: 320, height: 180 } },
} as GameDefinitions;
const bounds = { left: 101, top: 53, width: 700, height: 440 };
const mapping = createViewportMapping({
  logicalWidth: 320,
  logicalHeight: 180,
  cssWidth: 700,
  cssHeight: 440,
  devicePixelRatio: 6,
  integerScale: true,
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(M2View.prototype, "setSkin").mockResolvedValue(true);
});
for (const kind of ["platform", "m2"] as const)
  describe(`${kind} viewport adoption`, () => {
    async function view() {
      const value =
        kind === "platform"
          ? new GameView(definitions)
          : new M2View(definitions, { id: "test" } as PreparedSkin & {
              atlasUrl: string;
            });
      await value.init();
      return value;
    }
    it("keeps logical dimensions, allocates bounded DPR, redraws and maps current client bounds", async () => {
      const value = await view();
      value.resizeViewport(mapping);
      expect(value.app.renderer.resize).toHaveBeenCalledWith(320, 180, 6);
      expect(value.app.render).toHaveBeenCalledOnce();
      expect(value.app.canvas.style).toMatchObject({
        position: "absolute",
        left: "30px",
        top: "40px",
        width: "640px",
        height: "360px",
      });
      expect(value.pick(451, 273, bounds)).toEqual({ x: 160, y: 90 });
      expect(value.pick(101, 53, bounds)).toBeNull();
      const shifted = { ...bounds, left: 151, top: 103 };
      expect(value.pick(501, 323, shifted)).toEqual({ x: 160, y: 90 });
      value.resizeViewport(mapping);
      expect(value.app.render).toHaveBeenCalledOnce();
      value.resizeViewport(mapping, true);
      expect(value.app.render).toHaveBeenCalledTimes(2);
      value.dispose();
      expect(value.pick(451, 273, bounds)).toBeNull();
    });
    it("invalidates picking if resize/redraw fails, and publishes only a successful mapping", async () => {
      const value = await view();
      value.resizeViewport(mapping);
      const fractional = createViewportMapping({
        logicalWidth: 320,
        logicalHeight: 180,
        cssWidth: 277,
        cssHeight: 199,
        devicePixelRatio: 1.5,
        integerScale: true,
      });
      vi.mocked(value.app.render).mockImplementationOnce(() => {
        throw Error("redraw failed");
      });
      expect(() => value.resizeViewport(fractional)).toThrow("redraw failed");
      expect(value.viewportMapping).toBeUndefined();
      expect(value.pick(451, 273, bounds)).toBeNull();
      value.resizeViewport(fractional);
      expect(value.viewportMapping).toBe(fractional);
      expect(value.app.render).toHaveBeenCalledTimes(3);
      expect(value.app.canvas.style.width).toBe("277px");
      expect(() =>
        value.resizeViewport({ ...fractional, logicalWidth: 321 }),
      ).toThrow("logical dimensions");
      value.dispose();
    });
    it("hides zero-sized surfaces without allocating a zero-resolution renderer", async () => {
      const value = await view();
      value.resizeViewport(mapping);
      const zero = createViewportMapping({
        logicalWidth: 320,
        logicalHeight: 180,
        cssWidth: 0,
        cssHeight: 0,
      });
      value.resizeViewport(zero);
      expect(value.app.renderer.resize).toHaveBeenCalledTimes(1);
      expect(value.app.canvas.style.width).toBe("0px");
      expect(value.pick(451, 273, bounds)).toBeNull();
      value.resizeViewport(mapping);
      value.app.canvas.hidden = true;
      expect(value.pick(451, 273, bounds)).toBeNull();
      value.dispose();
    });
  });
