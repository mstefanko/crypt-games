import { expect, it } from "vitest";
import { ClipPlayer, ParticlePool, Texture, type Sprite } from "./index";
import { CosmeticEffects, type CosmeticEmitter } from "../presentation/effects";
import { SettlementPresenter } from "./settlement-presenter";
import { SettlementSession } from "@onepage/game-simulation/settlement-session";
import { winterContent } from "../../../../apps/audio-arcade/src/games/winter/content";

it("keeps second-based authored velocity, tail fade, first-free admission and long snow lifetime", () => {
  const pool = new ParticlePool(1);
  pool.emit(Texture.WHITE, 10, 20, 12, 28, 26);
  const snow = pool.container.children[0] as Sprite;
  pool.emit(Texture.WHITE, 99, 99, 0, 0, 0.22);
  expect(pool.container.children).toHaveLength(1);
  expect(snow.x).toBe(10);
  pool.update(0);
  expect([snow.x, snow.y, snow.alpha, snow.visible]).toEqual([10, 20, 1, true]);
  pool.update(5);
  expect([snow.x, snow.y, snow.visible]).toEqual([70, 160, true]);
  pool.update(20.8);
  expect(snow.alpha).toBeCloseTo(0.6);
  pool.update(0.21);
  expect(snow.visible).toBe(false);
  pool.emit(Texture.WHITE, 1, 2, 120, 100, 0.22);
  expect(pool.container.children[0]).toBe(snow);
  pool.update(0.1);
  expect([snow.x, snow.y]).toEqual([13, 12]);
  expect(snow.alpha).toBeCloseTo(0.36);
  pool.reset();
  pool.reset();
  pool.update(1);
  expect(snow.visible).toBe(false);
  expect(snow.x).toBe(13);
  pool.emit(Texture.WHITE, 3, 4, 0, 0, 26);
  expect(pool.container.children[0]).toBe(snow);
  expect(snow.alpha).toBe(1);
  pool.dispose();
  expect(pool.container.destroyed).toBe(true);
});

it("rejects Winter lifetime through the bounded data owner without relaxing its cap", () => {
  const effects = new CosmeticEffects(1);
  const spec: CosmeticEmitter = { id: "snow", priority: 1, x: 0, y: 0,
    burst: 1, ratePerSecond: 0, durationMs: 0, lifetimeMs: 26000,
    speed: 28, radius: 1, color: 0xffffff };
  expect(() => effects.emit(spec)).toThrow("Invalid cosmetic emitter");
  expect(effects.inspect().particles).toEqual([]);
});

it("clears future Winter snow and pending emission credit on restore", () => {
  const presenter = new SettlementPresenter(new SettlementSession(winterContent));
  const transient = presenter as unknown as { particles: ParticlePool; weatherBudget: number };
  const saved = presenter.snapshot();
  transient.particles.emit(Texture.WHITE, 0, 0, 12, 28, 26);
  transient.weatherBudget = 0.049;
  presenter.restore(saved);
  expect(transient.weatherBudget).toBe(0);
  expect(transient.particles.container.children[0].visible).toBe(false);
  presenter.dispose();
});

it("samples crossed cosmetic markers once, including skipped frames and a fresh branch instance", () => {
  const player = new ClipPlayer();
  const clip = { frames: [
    { texture: Texture.WHITE, markers: ["start"] },
    { texture: Texture.WHITE, markers: ["step"] },
    { texture: Texture.WHITE, markers: ["flash"] },
  ] };
  expect(player.sample(clip, 0, "run:1")).toEqual(["start"]);
  expect(player.sample(clip, 0, "run:1")).toEqual([]);
  expect(player.sample(clip, 0.9, "run:1")).toEqual(["step", "flash"]);
  expect(player.sample(clip, 0.9, "run:1")).toEqual([]);
  expect(player.sample(clip, 0.9, "branch:2")).toEqual(["start", "step", "flash"]);
  player.sprite.destroy();
});
