import { describe, expect, it } from "vitest";
import { PixiCamera } from "./index";
import type { Container } from "pixi.js";
const surface = () => {
  const value = { x: 0, y: 0, zoom: 1 };
  return {
    value,
    world: {
      position: {
        set: (x: number, y: number) => Object.assign(value, { x, y }),
      },
      scale: {
        set: (zoom: number) => {
          value.zoom = zoom;
        },
      },
    } as unknown as Container,
  };
};
describe("Pixi camera shared model compatibility", () => {
  it("preserves unbounded pan, direct coordinates and origin deadzones at zoom", () => {
    const camera = new PixiCamera();
    camera.zoom = 2;
    camera.pan(-100.25, 200.5);
    camera.follow(-80.25, 180.5, 12);
    expect(camera.x).toBe(-92.25);
    expect(camera.y).toBe(192.5);
    camera.x = -500;
    camera.y = -300;
    expect([camera.x, camera.y]).toEqual([-500, -300]);
  });
  it("preserves legacy seconds shake phase, repeated apply, and displayed inverse", () => {
    const camera = new PixiCamera(),
      { world, value } = surface();
    camera.pan(7, -3);
    camera.zoom = 1.5;
    camera.advance(0.02); // phase advances even before shake starts
    camera.shake(8, 0.1);
    camera.advance(0.025);
    camera.apply(world);
    expect(value.x).toBeCloseTo(-7 * 1.5 + Math.sin(0.045 * 67) * 8, 12);
    expect(value.y).toBeCloseTo(3 * 1.5 + Math.cos(0.045 * 67 * 1.31) * 8, 12);
    const displayed = { ...value };
    camera.apply(world);
    expect(value).toEqual(displayed);
    camera.pan(400, 500);
    camera.zoom = 2; // pending transform is not displayed yet
    const picked = camera.inverse(
      displayed.x + 20 * displayed.zoom,
      displayed.y + 30 * displayed.zoom,
    );
    expect(picked.x).toBeCloseTo(20);
    expect(picked.y).toBeCloseTo(30);
    // Match legacy subtractive expiry (a tiny residual can survive an exact split).
    camera.advance(0.075);
    camera.advance(0.001);
    camera.apply(world);
    expect(value).toEqual({ x: -800, y: -1000, zoom: 2 });
  });
  it("clamps explicit small-world limits and snaps teleports without a second owner", () => {
    const camera = new PixiCamera();
    camera.pan(0, 0);
    camera.followBounded(100, 50, 12, { x: 0, y: 0, width: 50, height: 0 });
    expect([camera.x, camera.y]).toEqual([50, 0]);
    camera.followBounded(20, 0, 12, { x: 0, y: 0, width: 50, height: 0 }, true);
    expect(camera.x).toBe(20);
    camera.pan(-100, -200);
    expect([camera.x, camera.y]).toEqual([-100, -200]);
    camera.followBounded(99, 99, 12, { x: -10, y: -5, width: 0, height: 0 });
    expect([camera.x, camera.y]).toEqual([-10, -5]);
  });
  it("clears shake for reduced motion and reset", () => {
    const camera = new PixiCamera(),
      { world, value } = surface();
    camera.shake(8, 0.1);
    camera.advance(0.01);
    camera.reducedMotion = true;
    camera.apply(world);
    expect(value).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(camera.shake(8, 0.1)).toBe(false);
    camera.reducedMotion = false;
    camera.shake(8, 0.1);
    camera.reset();
    camera.apply(world);
    expect(value).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});

it("preserves platform camera coordinates when letterbox offset and scale change", async () => {
  const { PlatformPresenter } = await import("./platform-presenter");
  const camera = new PixiCamera();
  const presenter = Object.create(PlatformPresenter.prototype);
  const graphics = {
    clear() {
      return this;
    },
    rect() {
      return this;
    },
    fill() {
      return this;
    },
  };
  Object.assign(presenter, {
    options: {
      scene: { viewport: { width: 320, height: 180 }, palette: { sky: 0 } },
    },
    offset: { x: 20, y: 90 },
    scale: 2,
    resetCamera: false,
    stage: { camera, canvas: { style: {} } },
    hud: { resize() {} },
    frame: graphics,
    sky: graphics,
    mask: graphics,
    background: { position: { set() {} }, scale: { set() {} } },
  });
  camera.pan(120 - 20 / 2, -90 / 2);
  presenter.resize(1000, 800);
  expect(camera.x + presenter.offset.x / presenter.scale).toBeCloseTo(120);
  expect(camera.y + presenter.offset.y / presenter.scale).toBeCloseTo(0);
  presenter.resize(100, 200);
  camera.zoom = presenter.scale;
  expect(camera.zoom).toBe(0.1);
  expect(camera.x + presenter.offset.x / presenter.scale).toBeCloseTo(120);
});

it("bounds finite public camera requests and ignores malformed observations without poisoning the display", () => {
  const camera = new PixiCamera(),
    { world, value } = surface();
  camera.pan(5, 6);
  camera.zoom = 2;
  camera.apply(world);
  const before = { ...value };
  for (const bad of [NaN, Infinity, -Infinity]) {
    expect(() => {
      camera.pan(bad, 0);
      camera.zoom = bad;
      camera.advance(bad);
      camera.follow(0, bad);
      camera.shake(bad, 1);
      camera.shake(1, bad);
    }).not.toThrow();
    camera.apply(world);
    expect(value).toEqual(before);
  }
  camera.zoom = 100;
  expect(camera.zoom).toBe(4);
  camera.zoom = -1;
  expect(camera.zoom).toBe(0.1);
  expect(camera.shake(64, 2)).toBe(true);
  camera.advance(0.5);
  camera.apply(world);
  expect(Number.isFinite(value.x)).toBe(true);
  expect(() => camera.advance(Number.MAX_VALUE)).not.toThrow();
  camera.apply(world);
  expect(Number.isFinite(value.x)).toBe(true);
});

it("rejects malformed Settlement presentation restores before mutation", async () => {
  const { SettlementPresenter } = await import("./settlement-presenter");
  const { SettlementSession } = await import(
    "@onepage/game-simulation/settlement-session"
  );
  const { winterContent } = await import(
    "../../../../apps/audio-arcade/src/games/winter/content"
  );
  const presenter = new SettlementPresenter(
    new SettlementSession(winterContent, 17),
  );
  const before = presenter.snapshot();
  for (const invalid of [
    { ...before, zoom: NaN },
    { ...before, zoom: 5 },
    { ...before, panX: Infinity },
    {
      ...before,
      ghostSpring: {
        ...before.ghostSpring,
        target: { ...before.ghostSpring.target, x: NaN },
      },
    },
    {
      ...before,
      queue: {
        ...before.queue,
        pending: [{ id: "bad", time: NaN, started: false }],
      },
    },
  ]) {
    expect(() => presenter.restore(invalid)).toThrow();
    expect(presenter.snapshot()).toEqual(before);
  }
  expect(() => presenter.restore(structuredClone(before))).not.toThrow();
  expect(presenter.snapshot()).toEqual(before);
  for (const zoom of [0.5, 2]) {
    const authored = new SettlementPresenter(
      new SettlementSession(winterContent, 17),
      {
        manifestUrl: "test-manifest",
        initialCamera: { x: 123, y: -45, zoom },
        buildings: {},
      },
    );
    const saved = authored.snapshot();
    expect(saved).toMatchObject({ panX: 123, panY: -45, zoom });
    authored.restore(structuredClone(saved));
    expect(authored.snapshot()).toEqual(saved);
  }
});

it("initializes Platform with a finite scale and clears a previous stage camera once", async () => {
  const { PlatformPresenter } = await import("./platform-presenter");
  const presenter = new PlatformPresenter({} as never);
  const internal = presenter as unknown as Record<string, any>;
  expect(internal.scale).toBe(1);
  const camera = new PixiCamera();
  camera.pan(90, 30);
  camera.zoom = 2;
  camera.shake(8, 0.1);
  const stage = {
    camera,
    canvas: { style: {} },
    width: 1000,
    height: 800,
    layers: { ground: { addChild() {} }, hud: { addChild() {} } },
    app: { stage: { addChildAt() {} } },
  };
  Object.assign(internal, {
    world: { addChild() {} },
    backdrop: { addChild() {} },
    hud: { root: {}, update() {}, load() {} },
    atlas: { async loadUrl() {} },
    options: { atlasUrl: "test", fontUrl: "test" },
    resize() {},
    render() {},
  });
  await presenter.init(stage as never);
  expect([camera.x, camera.y, camera.zoom]).toEqual([0, 0, 1]);
  const { world, value } = surface();
  camera.apply(world);
  expect(value).toEqual({ x: 0, y: 0, zoom: 1 });
  camera.pan(20, 30);
  await expect(presenter.init(stage as never)).rejects.toThrow(
    "already initialized",
  );
  expect([camera.x, camera.y]).toEqual([20, 30]);
});
