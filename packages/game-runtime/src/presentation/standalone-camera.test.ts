import { beforeEach, expect, it, vi } from "vitest";
import type { GameDefinitions } from "../../../game-project/src/types.ts";
import type { Observation } from "../../../game-simulation/src/types.ts";
import type { PreparedSkin } from "../m2-assets.ts";
vi.mock("pixi.js", () => {
  class Node {
    position = { set: vi.fn() };
    scale = { set: vi.fn(), x: 1 };
    anchor = { set: vi.fn() };
    addChild = vi.fn();
    setChildIndex = vi.fn();
    destroy = vi.fn();
    rect() {
      return this;
    }
    fill() {
      return this;
    }
    clear() {
      return this;
    }
  }
  return {
    Application: class {
      stage = new Node();
      canvas = { setAttribute: vi.fn() };
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
vi.mock("../m2-font.ts", () => ({
  makeM2Font: () => ({ fontName: "test", dispose: vi.fn() }),
}));
vi.mock("../m2-assets.ts", () => ({
  sampleSkin: () => ({
    frame: { id: "test", visual: { width: 16, height: 16 } },
  }),
  skinPlacement: () => ({ x: 0, y: 0, hand: { x: 0, y: 0 }, scaleX: 1 }),
  showsGuard: () => false,
  actorSkinAction: () => "idle",
}));
import { M2View } from "../m2-view.ts";
const definitions = {
  manifest: { viewport: { width: 320, height: 180 } },
  levels: [
    {
      id: "same",
      width: 1000,
      height: 500,
      tileSize: 16,
      tiles: [],
      rectangles: [],
      goal: { x: -10000, y: 0, width: 1, height: 1 },
    },
  ],
} as unknown as GameDefinitions;
function observation(x: number, tick: number, motionEpoch = 0): Observation {
  return {
    tick,
    levelId: "same",
    status: "playing",
    platforms: [],
    actors: [
      {
        id: 1,
        slot: 0,
        x: x * 256,
        y: 150 * 256,
        width: 16 * 256,
        height: 16 * 256,
        facing: 1,
        health: 5,
        maxHealth: 5,
        freezeTicks: 0,
        motionEpoch,
        abilityId: null,
        abilityTick: 0,
        hit: null,
      },
    ],
  } as unknown as Observation;
}
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(M2View.prototype, "setSkin").mockResolvedValue(true);
});
it("snaps a retained deadzone after same-level restore, motion discontinuity and backward preview seek", async () => {
  const view = new M2View(definitions, { id: "test" } as PreparedSkin & {
    atlasUrl: string;
  });
  await view.init();
  view.setPresentationOptions({ deadzone: { x: 20, y: 10 } });
  const draw = (x: number, tick: number, epoch: number, motionEpoch = 0) => {
    const frame = observation(x, tick, motionEpoch);
    // Actual M2/duel hosts pass the same epoch for both restored samples.
    view.render(frame, frame, 1, epoch, epoch);
    return view.cameraTransform();
  };
  expect(draw(200, 1, 0).x).toBe(78);
  expect(draw(219, 2, 0).x).toBe(78); // Ordinary follow retains the deadzone.
  expect(draw(219, 2, 1).x).toBe(97); // Same-tick restore must discard it.
  expect(draw(230, 3, 1).x).toBe(97);
  expect(draw(230, 3, 1, 1).x).toBe(108); // Actor teleport/discontinuity.
  expect(draw(240, 4, 1, 1).x).toBe(108);
  expect(draw(240, 2, 1, 1).x).toBe(118); // Detached backward seek without host epoch.
  expect(draw(250, 100, 1, 1).x).toBe(128); // Forward detached seek.
  expect(draw(260, 101, 1, 1).x).toBe(128);
  expect(draw(260, 101, 2, 1).x).toBe(138); // Same-tick host restore.
  const restored = view.cameraTransform();
  for (let count = 0; count < 4; count++)
    expect(draw(260, 101, 2, 1)).toEqual(restored);
  view.resetWorldPresentation();
  expect(view.cameraTransform()).toEqual({
    x: 0,
    y: 0,
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
  });
  expect(view.worldPoint({ x: 25, y: 30 })).toEqual({ x: 25, y: 30 });
  view.dispose();
});
