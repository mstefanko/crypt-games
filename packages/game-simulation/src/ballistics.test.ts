import { circleOverlapsRect } from "./circle-geometry";
import { describe, expect, it } from "vitest";
import { BALLISTIC_LIMITS, BallisticWorld, canonicalBallisticData } from "./ballistics";
import type { BallisticBodyDefinition, BallisticConfiguration, BallisticTarget } from "./ballistics";
import { BallisticFixture } from "./ballistic-fixture";
function definition(patch: Partial<BallisticBodyDefinition> = {}): BallisticBodyDefinition {
  return { id: "ball", x: 0, y: 0, radius: 4, vx: 64, vy: -32, impact: "stop", restitution: 192, maxBounces: 0, catchable: false, ...patch };
}
function config(bodies: BallisticBodyDefinition[] = [definition()], targets: BallisticTarget[] = []): BallisticConfiguration {
  return { acceleration: { x: 0, y: 16 }, bodies, targets };
}
function wall(patch: Partial<BallisticTarget> = {}): BallisticTarget {
  return { response: "solid", shape: { bodyId: "wall", shapeId: "body", owner: "world", category: "world", region: "body", sensor: false, priority: 0, kind: "rect", rect: { x: 40, y: -100, width: 1, height: 200 } }, ...patch };
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
describe("P1 deterministic ballistic production step", () => {
  it("keeps rounded-corner bounces outside cover through prediction and restore", () => {
    for (const signX of [-1, 1]) for (const signY of [-1, 1]) {
      const rect = { x: signX === 1 ? -2131 : 1938, y: signY === 1 ? -84 : -173, width: 193, height: 257 };
      const target = wall({ shape: { ...wall().shape, kind: "rect", rect } });
      const value = { ...config([definition({ x: -2360 * signX, y: 102 * signY, radius: 17, vx: 148 * signX, vy: 57 * signY, impact: "bounce", restitution: 256, maxBounces: 4 })], [target]), acceleration: { x: 0, y: 0 } };
      const world = new BallisticWorld(value);
      const prediction = world.predict(12);
      const events = [];
      for (const expected of prediction.states) {
        const state = world.step();
        expect(state).toEqual(expected);
        expect(circleOverlapsRect(state.bodies[0], rect)).toBe(false);
        expect(state.bodies[0].status).toBe("flying");
        events.push(...state.events);
        if (state.events.length) {
          const restored = new BallisticWorld(value); restored.restore(world.capture());
          expect(restored.predict(3)).toEqual(world.predict(3));
        }
      }
      expect(events.map(e => e.kind)).toEqual(["bounce"]);
    }
  });
  it("uses priority then identity for simultaneous catches and solid cover", () => {
    for (const priority of [-1, 0, 1]) {
      const solid = wall();
      const catcher = wall({ response: "catch", shape: { ...solid.shape, bodyId: "catcher", sensor: true, priority } });
      const world = new BallisticWorld({ ...config([definition({ vx: 64, vy: 0, catchable: true })], [solid, catcher]), acceleration: { x: 0, y: 0 } });
      expect(world.step().events[0].kind).toBe(priority <= 0 ? "catch" : "stop");
    }
  });
  it("integrates analytical no-drag motion with explicit semi-implicit quarter steps", () => {
    const world = new BallisticWorld(config());
    for (let tick = 1; tick <= 8; tick++) {
      const body = world.step().bodies[0];
      expect(body.x).toBe(64 * tick);
      expect(body.vy).toBe(-32 + 16 * tick);
      // Exact for divisible acceleration: y=v0*t+a*t*t/2+a*t/8.
      expect(body.y).toBe(-32 * tick + 8 * tick * tick + 2 * tick);
    }
  });
  it("persists signed division carries and bounds general quantization error", () => {
    for (const ax of [-7, 7]) for (const ay of [-5, 5]) {
      const value = { ...config([definition({ vx: 21, vy: -19 })]), acceleration: { x: ax, y: ay } };
      const world = new BallisticWorld(value);
      for (let tick = 1; tick <= 12; tick++) {
        const state = world.step(), b = state.bodies[0];
        expect(b.vx).toBe(21 + ax * tick);
        expect(b.vy).toBe(-19 + ay * tick);
        const xIdeal = 21 * tick + ax * tick * tick / 2;
        const yIdeal = -19 * tick + ay * tick * tick / 2;
        expect(Math.abs(b.x - xIdeal)).toBeLessThanOrEqual(Math.abs(ax) * tick / 8 + tick + 1);
        expect(Math.abs(b.y - yIdeal)).toBeLessThanOrEqual(Math.abs(ay) * tick / 8 + tick + 1);
      }
      const restored = new BallisticWorld(value); restored.restore(world.capture());
      expect(restored.step()).toEqual(world.step());
    }
  });
  it("uses the production step for prediction without changing the live state", () => {
    const fixture = new BallisticFixture();
    for (let i = 0; i < 5; i++) fixture.step();
    const before = fixture.capture(), prediction = fixture.predict(55);
    expect(fixture.capture()).toEqual(before);
    for (const expected of prediction.states) expect(fixture.step()).toEqual(expected);
    expect(fixture.capture().world).toEqual(prediction.checkpoint);
    expect(fixture.predict(0).states).toEqual([]);
    expect(() => fixture.predict(257)).toThrow();
  });
  it("fires over and into cover, catches a throw and terminates bounded bounce", () => {
    const fixture = new BallisticFixture();
    const events = [];
    let atEight;
    for (let i = 0; i < 60; i++) {
      const state = fixture.step(); events.push(...state.events);
      if (state.tick === 8) atEight = state;
    }
    expect(atEight!.bodies.find(b => b.id === "arrow-over")).toMatchObject({ x: 2048, y: -1520, status: "flying" });
    expect(atEight!.bodies.find(b => b.id === "arrow-into")).toMatchObject({ x: 1975, y: 1004, status: "stopped" });
    expect(events.map(e => [e.tick, e.bodyId, e.targetId, e.kind])).toEqual([
      [6, "bounce", "floor", "bounce"], [8, "arrow-into", "cover", "stop"],
      [9, "throw-catch", "catcher", "catch"], [27, "bounce", "floor", "bounce"],
      [43, "bounce", "floor", "bounce"], [44, "arrow-over", "floor", "stop"], [55, "bounce", "floor", "stop"],
    ]);
    expect(fixture.observe().bodies.map(b => b.status)).toEqual(["stopped", "stopped", "stopped", "caught"]);
  });
  it("restores exact mid-flight/contact state including carries and future receipts", () => {
    const uninterrupted = new BallisticFixture();
    const checkpoints = new Map<number, ReturnType<BallisticFixture["capture"]>>();
    const states = [];
    for (let tick = 0; tick <= 60; tick++) {
      if ([0, 5, 6, 8, 9, 26, 43, 55, 60].includes(tick)) checkpoints.set(tick, uninterrupted.capture());
      if (tick < 60) states.push(uninterrupted.step());
    }
    for (const [tick, checkpoint] of checkpoints) {
      const restored = new BallisticFixture(); restored.restore(checkpoint);
      for (let i = tick; i < 60; i++) expect(restored.step()).toEqual(states[i]);
      expect(JSON.stringify(restored.capture())).toBe(JSON.stringify(uninterrupted.capture()));
    }
  });
  it("supports eight independent bodies with stable ordering, never mutual collision", () => {
    const defs = Array.from({ length: 8 }, (_, i) => definition({ id: `ball-${i}` }));
    const left = new BallisticWorld(config(defs)), right = new BallisticWorld(config([...defs].reverse()));
    expect(left.step()).toEqual(right.step());
    expect(left.observe().bodies.every(b => b.status === "flying")).toBe(true);
    expect(() => new BallisticWorld(config([...defs, definition({ id: "overflow" })]))).toThrow(/cap/);
    expect(() => new BallisticWorld(config([definition(), definition()]))).toThrow(/Duplicate/);
  });
  it("sweeps thin cover, handles initial penetration, tangent bounce and restitution zero", () => {
    const fast = new BallisticWorld({ ...config([definition({ vx: 2048, vy: 0 })], [wall()]), acceleration: { x: 0, y: 0 } });
    expect(fast.step().bodies[0]).toMatchObject({ x: 35, status: "stopped" });
    const penetrating = new BallisticWorld(config([definition({ x: 40, impact: "bounce", maxBounces: 4 })], [wall()]));
    expect(penetrating.step().bodies[0]).toMatchObject({ x: 40, status: "stopped", bounceCount: 0 });
    const zero = new BallisticWorld(config([definition({ vx: 64, vy: 0, impact: "bounce", maxBounces: 4, restitution: 0 })], [wall()]));
    expect(zero.step().bodies[0]).toMatchObject({ status: "stopped", bounceCount: 0 });
    const circle = wall({ shape: { bodyId: "circle", shapeId: "body", owner: "world", category: "world", region: "body", sensor: false, priority: 0, kind: "circle", circle: { x: 40, y: 8, radius: 4 } } });
    const tangent = new BallisticWorld({ ...config([definition({ vx: 64, vy: 0, impact: "bounce", maxBounces: 4 })], [circle]), acceleration: { x: 0, y: 0 } });
    expect(tangent.step().bodies[0]).toMatchObject({ status: "stopped", bounceCount: 0 });
  });
  it("rejects speed/curvature/position/tick violations without publishing partial motion", () => {
    expect(() => new BallisticWorld({ ...config(), acceleration: { x: 129, y: 0 } })).toThrow();
    expect(() => new BallisticWorld(config([definition({ vx: 2048, vy: 1 })]))).toThrow(/speed/);
    const overSpeed = new BallisticWorld({ ...config([definition({ vx: 2048, vy: 0 })]), acceleration: { x: 4, y: 0 } });
    const speedBefore = overSpeed.capture(); expect(() => overSpeed.step()).toThrow(/speed/); expect(overSpeed.capture()).toEqual(speedBefore);
    expect(() => overSpeed.step()).toThrow(/speed/);
    expect(() => overSpeed.predict(1)).toThrow(/speed/);
    overSpeed.restore(speedBefore);
    expect(overSpeed.capture()).toEqual(speedBefore);
    const bounds = new BallisticWorld({ ...config([definition({ x: 262139, radius: 4, vx: 64 })]), acceleration: { x: 0, y: 0 } });
    const boundsBefore = bounds.capture(); expect(() => bounds.step()).toThrow(); expect(bounds.capture()).toEqual(boundsBefore);
    const capped = new BallisticWorld(config([]));
    for (let i = 0; i < BALLISTIC_LIMITS.ticks; i++) capped.step();
    const cappedBefore = capped.capture(); expect(() => capped.step()).toThrow(/tick cap/); expect(capped.capture()).toEqual(cappedBefore);
    expect(() => capped.predict(1)).toThrow();
  });
  it("rejects malformed/incompatible/unreachable restores atomically", () => {
    const fixture = new BallisticFixture(); for (let i = 0; i < 5; i++) fixture.step();
    const saved = fixture.capture();
    const corrupt: unknown[] = [null, [], { ...saved, extra: 1 }, { ...saved, format: "future" }];
    const badCarry = clone(saved); badCarry.world.state.bodies[0].positionRemainderX = 4; corrupt.push(badCarry);
    const badOrder = clone(saved); badOrder.world.state.bodies.reverse(); corrupt.push(badOrder);
    const unknownField = clone(saved); (unknownField.world.state as unknown as { extra: number }).extra = 1; corrupt.push(unknownField);
    const negativeZero = clone(saved); negativeZero.world.state.bodies[0].x = -0; corrupt.push(negativeZero);
    const changedRules = clone(saved); (changedRules.world.configuration.acceleration as { y: number }).y = 17; corrupt.push(changedRules);
    const missing = clone(saved); delete (missing.world.state as Partial<typeof missing.world.state>).events; corrupt.push(missing);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle; corrupt.push(cycle);
    for (const value of corrupt) { expect(() => fixture.restore(value)).toThrow(); expect(fixture.capture()).toEqual(saved); }
    const detached = fixture.observe(); detached.bodies[0].x = 9999; expect(fixture.capture()).toEqual(saved);
    const world = new BallisticWorld(config()); expect(() => world.restore(saved.world)).toThrow(/Incompatible/);
  });
  it("rejects accessors, symbols, hidden fields, sparse/exotic arrays before invoking getters", () => {
    const fixture = new BallisticFixture(); fixture.step(); const saved = fixture.capture();
    let invoked = 0;
    const top = clone(saved); Object.defineProperty(top, "world", { enumerable: true, get() { invoked++; return saved.world; } });
    const nested = clone(saved); Object.defineProperty(nested.world.state.bodies[0], "x", { enumerable: true, get() { invoked++; return 0; } });
    const array = clone(saved); Object.defineProperty(array.world.state.bodies, "0", { enumerable: true, get() { invoked++; return saved.world.state.bodies[0]; } });
    const symbol = clone(saved); Object.defineProperty(symbol, Symbol("hidden"), { value: 1 });
    const hidden = clone(saved); Object.defineProperty(hidden.world.state, "hidden", { value: 1 });
    const sparse = clone(saved); delete sparse.world.state.bodies[0];
    const exotic = clone(saved); Object.setPrototypeOf(exotic.world.state.bodies, Object.create(Array.prototype));
    for (const value of [top, nested, array, symbol, hidden, sparse, exotic]) { expect(() => fixture.restore(value)).toThrow(); expect(fixture.capture()).toEqual(saved); }
    expect(invoked).toBe(0);
    expect(() => canonicalBallisticData({ number: NaN })).toThrow();
    expect(() => canonicalBallisticData({ number: Infinity })).toThrow();
    expect(() => canonicalBallisticData({ value: undefined })).toThrow();
    expect(() => new BallisticWorld({ ...config(), targets: [{ ...wall(), velocity: { x: 1, y: 0 } } as never] })).toThrow();
  });
});
