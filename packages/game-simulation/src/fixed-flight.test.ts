import { describe, expect, it } from "vitest";
import { advanceFixedAxis, closedSegmentAabbInterval, predictFixedFlightLanding, solveFixedFlightLaunch, stepFixedFlight, type FixedFlightState } from "./fixed-flight";
const config = { frequency: 240, gravityPerStep: 256 };
const state = (patch: Partial<FixedFlightState> = {}): FixedFlightState => ({ x: 0, y: 0, z: 14 * 256, vx: 32101, vy: -3457, vz: 20000, rx: 13, ry: -17, rz: 51, ...patch });
describe("fixed flight", () => {
  it("conserves signed displacement and carry over many steps", () => {
    for (const velocity of [313, -313, 1, -1]) {
      let position = 0, remainder = 0;
      for (let i = 0; i < 1000; i++) {
        const next = advanceFixedAxis(velocity, remainder, 240);
        position += next.delta; remainder = next.remainder;
        expect(position * 240 + remainder).toBe((i + 1) * velocity);
        expect(Math.abs(remainder)).toBeLessThan(240);
      }
    }
  });
  it("preserves explicit partial-step rounding without applying acceleration", () => {
    expect(advanceFixedAxis(-1001, -17, 240, 0.25)).toEqual({ delta: -1, remainder: -27 });
    expect(advanceFixedAxis(1001, 17, 240, 0)).toEqual({ delta: 0, remainder: 17 });
  });
  it("lands on the same swept segment as production stepping with current carries", () => {
    const initial = state(), floor = 5 * 256;
    const projected = predictFixedFlightLanding(initial, { ...config, floor, maxSteps: 600 });
    let current = initial, steps = 0;
    for (;;) {
      const next = stepFixedFlight(current, config);
      if (next.z <= floor) {
        const t = (floor - current.z) / (next.z - current.z);
        expect(projected).toEqual({ x: current.x + Math.round((next.x - current.x) * t), y: current.y + Math.round((next.y - current.y) * t), z: floor, steps: steps + t, landed: true });
        break;
      }
      current = next; steps++;
    }
    expect(initial).toEqual(state());
  });
  it("solves launch against discrete gravity, including nonzero signed carries", () => {
    expect(solveFixedFlightLaunch({ frequency: 240, gravityPerStep: 0, height: 0, floor: 0, steps: 1 })).toBe(0);
    for (const steps of [144, 192, 264]) for (const remainder of [-200, 0, 200]) {
      const height = 14 * 256, floor = 5 * 256;
      const vz = solveFixedFlightLaunch({ ...config, height, floor, steps, remainder });
      let current = state({ vz, rz: remainder });
      for (let i = 0; i < steps; i++) current = stepFixedFlight(current, config);
      expect(Math.abs(current.z - floor)).toBeLessThanOrEqual(1);
    }
  });
  it("returns a bounded miss and rejects invalid configurations", () => {
    expect(predictFixedFlightLanding(state(), { ...config, floor: 0, maxSteps: 1 }).landed).toBe(false);
    expect(predictFixedFlightLanding(state({ z: 0, vz: 0 }), { ...config, floor: 0, maxSteps: 0 }).landed).toBe(true);
    for (const fn of [() => advanceFixedAxis(1, 240, 240), () => advanceFixedAxis(1, 0, 0), () => advanceFixedAxis(1, 0, 240, NaN), () => solveFixedFlightLaunch({ ...config, height: 1, floor: 0, steps: 0 }), () => predictFixedFlightLanding(state(), { ...config, floor: 0, maxSteps: 4097 })]) expect(fn).toThrow();
  });
  it("predicts the full arc when departing upward from the floor", () => {
    const projected = predictFixedFlightLanding(state({ z: 1280, vz: 20000 }), { ...config, floor: 1280, maxSteps: 600 });
    expect(projected.landed).toBe(true);
    expect(projected.steps).toBeGreaterThan(100);
    expect(projected.x).toBeGreaterThan(0);
    // Zero-step queries validate current values without calculating future overflow.
    expect(predictFixedFlightLanding(state({ x: 1_000_000_000, vx: 1_000_000_000 }), { ...config, floor: 0, maxSteps: 0 }).landed).toBe(false);
    expect(() => predictFixedFlightLanding(state({ vz: NaN }), { ...config, floor: 0, maxSteps: 0 })).toThrow();
  });
});
describe("closed segment/AABB interval", () => {
  const bounds = { minX: -3, maxX: 3, minY: 0, maxY: 27 };
  it("includes top tangency, vertical descent and a stationary boundary point", () => {
    expect(closedSegmentAabbInterval({ x: -5, y: 27 }, { x: 10, y: 0 }, bounds)).toEqual({ enter: 0.2, exit: 0.8 });
    expect(closedSegmentAabbInterval({ x: 0, y: 30 }, { x: 0, y: -6 }, bounds)).toEqual({ enter: 0.5, exit: 1 });
    expect(closedSegmentAabbInterval({ x: 3, y: 27 }, { x: 0, y: 0 }, bounds)).toEqual({ enter: 0, exit: 1 });
    expect(closedSegmentAabbInterval({ x: -5, y: 25 }, { x: 2, y: 2 }, bounds)).toEqual({ enter: 1, exit: 1 });
  });
  it("misses high clearance, outside parallel movement, and motion away", () => {
    expect(closedSegmentAabbInterval({ x: -5, y: 28 }, { x: 10, y: 0 }, bounds)).toBeNull();
    expect(closedSegmentAabbInterval({ x: 4, y: 30 }, { x: 0, y: -6 }, bounds)).toBeNull();
    expect(closedSegmentAabbInterval({ x: 5, y: 10 }, { x: 2, y: 0 }, bounds)).toBeNull();
  });
  it("rejects malformed bounds and nonfinite coordinates", () => {
    expect(() => closedSegmentAabbInterval({ x: NaN, y: 0 }, { x: 0, y: 0 }, bounds)).toThrow();
    expect(() => closedSegmentAabbInterval({ x: 0, y: 0 }, { x: 0, y: 0 }, { ...bounds, minX: 4 })).toThrow();
  });
});
