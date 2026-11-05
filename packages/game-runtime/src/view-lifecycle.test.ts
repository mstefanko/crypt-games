import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GameDefinitions } from "../../game-project/src/types.ts";

const resources = vi.hoisted(() => ({
  deferred: false,
  rejectInit: false,
  rendererDestroy: vi.fn(),
  stageDestroy: vi.fn(),
  pending: [] as (() => void)[],
  destroy: vi.fn(),
  artDispose: vi.fn(),
  artCreate: vi.fn(),
}));
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
      stage = Object.assign(new Node(), { destroy: resources.stageDestroy });
      renderer = { destroy: resources.rendererDestroy };
      canvas = { setAttribute: vi.fn() };
      init() {
        if (resources.rejectInit)
          return Promise.reject(new Error("renderer init rejected"));
        return resources.deferred
          ? new Promise<void>((resolve) => resources.pending.push(resolve))
          : Promise.resolve();
      }
      stop = vi.fn();
      destroy = resources.destroy;
    },
    Container: Node,
    Graphics: Node,
    BitmapText: Node,
    Sprite: Node,
  };
});
vi.mock("./art.ts", () => ({
  makeArt: () => {
    resources.artCreate();
    return {
      fontName: "original-test-font",
      frames: [],
      dispose: resources.artDispose,
    };
  },
}));
import { GameView } from "./view.ts";
const definitions = {
  manifest: { viewport: { width: 320, height: 180 } },
} as GameDefinitions;

beforeEach(() => {
  resources.deferred = false;
  resources.rejectInit = false;
  resources.pending = [];
  vi.clearAllMocks();
});
describe("Pixi resource lifecycle", () => {
  it("destroys late initialization exactly once without creating art or attaching a view", async () => {
    resources.deferred = true;
    const view = new GameView(definitions);
    const ready = view.init();
    view.dispose();
    view.dispose();
    resources.pending.shift()!();
    await ready;
    expect(resources.destroy).toHaveBeenCalledTimes(1);
    expect(resources.destroy).toHaveBeenCalledWith(
      { removeView: true, releaseGlobalResources: false },
      { children: true },
    );
    expect(resources.artCreate).not.toHaveBeenCalled();
  });
  it("cleans a partially initialized renderer and stage when initialization rejects", async () => {
    resources.rejectInit = true;
    const view = new GameView(definitions);
    await expect(view.init()).rejects.toThrow("renderer init rejected");
    view.dispose();
    expect(resources.stageDestroy).toHaveBeenCalledTimes(1);
    expect(resources.rendererDestroy).toHaveBeenCalledTimes(1);
    expect(resources.rendererDestroy).toHaveBeenCalledWith({
      removeView: true,
      releaseGlobalResources: false,
    });
    expect(resources.artCreate).not.toHaveBeenCalled();
  });
  it("releases every owner over twenty mounts and idempotent disposals", async () => {
    for (let i = 0; i < 20; i += 1) {
      const view = new GameView(definitions);
      await view.init();
      view.dispose();
      view.dispose();
    }
    expect(resources.destroy).toHaveBeenCalledTimes(20);
    for (const [options] of resources.destroy.mock.calls)
      expect(options).toEqual({
        removeView: true,
        releaseGlobalResources: false,
      });
    expect(resources.artCreate).toHaveBeenCalledTimes(20);
    expect(resources.artDispose).toHaveBeenCalledTimes(20);
  });
});
