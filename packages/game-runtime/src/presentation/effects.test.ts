import { describe, expect, it } from "vitest";
import {
  CosmeticEffects,
  CosmeticRandom,
  COSMETIC_LIMITS,
  type CosmeticEmitter,
} from "./effects.ts";
import { TimedEncounterFixture } from "@onepage/game-simulation/timed-fixture";
const emitter = (id = "spark", priority = 1): CosmeticEmitter => ({
  id,
  priority,
  x: 10,
  y: 20,
  burst: 2,
  ratePerSecond: 0,
  durationMs: 0,
  lifetimeMs: 200,
  speed: 20,
  radius: 2,
  color: 0xffcc00,
});
describe("V0b bounded cosmetic effects", () => {
  it("owns detached particles and tweens, advances only explicit samples and tears down", () => {
    const effects = new CosmeticEffects(0),
      spec = emitter();
    expect(effects.emit(spec)).toBe("accepted");
    spec.x = 999;
    expect(
      effects.tween({
        id: "fade",
        priority: 1,
        from: 1,
        to: 0,
        durationMs: 100,
      }),
    ).toBe("accepted");
    const before = effects.inspect();
    effects.advance(0);
    expect(effects.inspect()).toEqual(before);
    effects.advance(50);
    expect(effects.inspect().particles[0].x).not.toBe(10);
    expect(effects.inspect().particles[0].alpha).toBe(0.75);
    expect(effects.inspect().tweens).toEqual([{ id: "fade", value: 0.5 }]);
    effects.advance(50);
    expect(effects.inspect().tweens).toEqual([{ id: "fade", value: 0 }]);
    effects.advance(100);
    expect(effects.inspect().tweens).toEqual([]);
    expect(effects.inspect().particles).toEqual([]);
    effects.emit(emitter());
    effects.dispose();
    effects.dispose();
    expect(effects.inspect()).toMatchObject({
      disposed: true,
      emitters: [],
      particles: [],
      tweens: [],
    });
    expect(effects.emit(emitter())).toBe("disposed");
    expect(() => effects.beginSession("live")).toThrow("disposed");
  });
  it("enforces all three caps with stable priority and equal-priority oldest retention", () => {
    const effects = new CosmeticEffects(3);
    for (let i = 0; i < COSMETIC_LIMITS.emitters; i++)
      expect(
        effects.emit({ ...emitter(`e${i}`), burst: 32, durationMs: 5000 }),
      ).toBe("accepted");
    expect(effects.inspect().particles).toHaveLength(512);
    expect(effects.emit({ ...emitter("equal"), burst: 0 })).toBe("capacity");
    expect(effects.emit({ ...emitter("higher", 2), burst: 3 })).toBe(
      "accepted",
    );
    const snapshot = effects.inspect();
    expect(snapshot.emitters).toHaveLength(16);
    expect(snapshot.emitters.some((e) => e.id === "e15")).toBe(false);
    expect(snapshot.particles).toHaveLength(512);
    expect(
      snapshot.particles.filter((p) => p.emitterId === "higher"),
    ).toHaveLength(3);
    expect(snapshot.particles.some((p) => p.id === 2)).toBe(true);
    expect(snapshot.dropped).toEqual({ emitters: 2, particles: 3, tweens: 0 });
    for (let i = 0; i < 64; i++)
      effects.tween({
        id: `t${i}`,
        priority: 1,
        from: 0,
        to: 1,
        durationMs: 5,
      });
    expect(
      effects.tween({ id: "same", priority: 1, from: 0, to: 1, durationMs: 5 }),
    ).toBe("capacity");
    expect(
      effects.tween({
        id: "higher",
        priority: 2,
        from: 0,
        to: 1,
        durationMs: 5,
      }),
    ).toBe("accepted");
    expect(effects.inspect().tweens.some((t) => t.id === "t63")).toBe(false);
    effects.advance(5);
    effects.advance(1);
    expect(effects.inspect().tweens).toEqual([]);
    expect(
      effects.tween({
        id: "reused",
        priority: 1,
        from: 0,
        to: 1,
        durationMs: 5,
      }),
    ).toBe("accepted");
  });
  it("bounds emission rate/lifetimes and does not catch up a long delta", () => {
    const effects = new CosmeticEffects(5);
    effects.emit({
      ...emitter(),
      burst: 0,
      ratePerSecond: 100,
      durationMs: 125,
      lifetimeMs: 50,
    });
    effects.advance(100);
    expect(effects.inspect().particles).toHaveLength(10);
    effects.advance(100);
    expect(effects.inspect().particles).toHaveLength(2);
    expect(effects.inspect().emitters).toEqual([]);
    effects.advance(100);
    expect(effects.inspect().particles).toEqual([]);
    const before = effects.inspect();
    expect(() => effects.advance(5000)).toThrow();
    expect(effects.inspect()).toEqual(before);
  });
  it("rejects invalid requests atomically without consuming private randomness", () => {
    const effects = new CosmeticEffects(7),
      reference = new CosmeticEffects(7);
    const before = effects.inspect();
    for (const bad of [
      { ...emitter(), burst: 513 },
      { ...emitter(), durationMs: Infinity },
      { ...emitter(), ratePerSecond: 129 },
      { ...emitter(), id: "bad id" },
      { ...emitter(), lifetimeMs: 0 },
    ]) {
      expect(() => effects.emit(bad)).toThrow();
      expect(effects.inspect()).toEqual(before);
    }
    expect(() =>
      effects.tween({
        id: "bad",
        priority: 1,
        from: NaN,
        to: 1,
        durationMs: 10,
      }),
    ).toThrow();
    effects.emit(emitter());
    reference.emit(emitter());
    effects.advance(10);
    reference.advance(10);
    expect(effects.inspect()).toEqual(reference.inspect());
    const snapshot = effects.inspect();
    snapshot.particles[0].x = 999;
    expect(effects.inspect().particles[0].x).not.toBe(999);
    expect(() => effects.reset(-1)).toThrow();
    expect(effects.inspect()).toEqual(reference.inspect());
  });
  it("isolates seeds and allows reproducible pose snapshot resampling", () => {
    const effects = new CosmeticEffects(0),
      other = new CosmeticEffects(1);
    effects.emit(emitter());
    other.emit(emitter());
    effects.advance(50);
    other.advance(50);
    expect(effects.inspect().particles).not.toEqual(other.inspect().particles);
    const first = effects.inspect().particles;
    effects.reset(0);
    effects.emit(emitter());
    effects.advance(50);
    expect(effects.inspect().particles).toEqual(first);
    expect(new CosmeticRandom(0).next()).toBe(new CosmeticRandom(0).next());
    expect(() => new CosmeticRandom(0x100000000)).toThrow();
  });
  it("clears and suppresses motion/flash work for reduced motion without later replay", () => {
    const effects = new CosmeticEffects(0);
    effects.emit(emitter());
    effects.tween({ id: "flash", priority: 1, from: 0, to: 1, durationMs: 20 });
    effects.setReducedMotion(true);
    expect(effects.inspect()).toMatchObject({
      particles: [],
      tweens: [],
      emitters: [],
    });
    expect(effects.emit(emitter())).toBe("reduced-motion");
    expect(
      effects.tween({
        id: "flash",
        priority: 1,
        from: 0,
        to: 1,
        durationMs: 20,
      }),
    ).toBe("reduced-motion");
    effects.setReducedMotion(false);
    effects.advance(100);
    expect(effects.inspect().particles).toEqual([]);
  });
  it("consumes real committed cues once, suppresses replay/epochs, and leaves authority exact", () => {
    const fixture = new TimedEncounterFixture({
      runId: "cosmetic-proof",
      runEpoch: 0,
      seeds: { encounter: 0, loot: 0 },
    });
    fixture.command({
      revision: 0,
      runEpoch: 0,
      kind: "order",
      action: "scout",
    });
    fixture.step();
    fixture.step();
    const cue = fixture.step().emitted[0],
      checkpoint = fixture.capture();
    const effects = new CosmeticEffects(99),
      replay = effects.beginSession("replay");
    expect(effects.deliver(cue, replay, emitter())).toBe("suppressed");
    expect(effects.inspect().particles).toEqual([]);
    const live = effects.beginSession("live");
    expect(effects.deliver(cue, replay, emitter())).toBe("stale");
    expect(effects.deliver(cue, live, emitter())).toBe("delivered");
    expect(effects.inspect().particles).toHaveLength(2);
    const restored = effects.beginSession("live");
    fixture.restore(checkpoint);
    expect(effects.deliver(cue, restored, emitter())).toBe("duplicate");
    expect(effects.inspect().particles).toEqual([]);
    expect(fixture.capture()).toEqual(checkpoint);
  });
  it("consumes a valid cue attempt when cosmetic work is suppressed or full", () => {
    const effects = new CosmeticEffects(0, true);
    const cue = {
      runId: "reduced",
      runEpoch: 0,
      sequence: 1,
      tick: 1,
      kind: "reward",
    } as const;
    expect(effects.deliver(cue, 0, emitter())).toBe("delivered");
    effects.setReducedMotion(false);
    expect(effects.deliver(cue, 0, emitter())).toBe("duplicate");
    for (let i = 0; i < 16; i++)
      effects.emit({ ...emitter(`full${i}`), burst: 0, durationMs: 5000 });
    expect(effects.deliver({ ...cue, sequence: 2 }, 0, emitter())).toBe(
      "delivered",
    );
    expect(effects.inspect().particles).toEqual([]);
    expect(effects.deliver({ ...cue, sequence: 2 }, 0, emitter())).toBe(
      "duplicate",
    );
  });
});
