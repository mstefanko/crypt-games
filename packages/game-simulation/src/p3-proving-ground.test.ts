import { describe, it, expect } from "vitest";
import {
  P3ProvingGround,
  P3_FIXTURE,
  stageP3ProofBatch,
  restoreP3ProofPair,
} from "./p3-proving-ground";
import { P3SlopeWorld, P3_SLOPE_FIXTURE } from "./p3-surfaces";
import type { P3Configuration } from "./p3-proving-ground";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const cmd = (throttle = 1, brake = false, steer = 0, damage = 0) => ({
  vehicles: [
    { throttle, brake, steer, damage },
    { throttle, brake, steer, damage },
  ],
});
function grade(gradient: number): P3Configuration {
  const c = clone(P3_FIXTURE);
  return {
    ...c,
    field: {
      ...c.field,
      heights: c.field.heights.map((_, i) => 2048 + (i % 9) * gradient),
    },
    vehicles: c.vehicles.map((v) => ({ ...v, height: 2048 + gradient / 2 })),
    ball: { ...c.ball, z: 4096 },
  };
}
describe("P3 grounded proving ground", () => {
  it("grade affects identical throttle and reverse runs; brakes stop", () => {
    const up = new P3ProvingGround(grade(256)),
      flat = new P3ProvingGround(grade(0)),
      down = new P3ProvingGround(grade(-256));
    for (let i = 0; i < 8; i++) {
      up.step();
      flat.step();
      down.step();
    }
    expect(up.observe().vehicles[0].forward).toBeLessThan(
      flat.observe().vehicles[0].forward,
    );
    expect(down.observe().vehicles[0].forward).toBeGreaterThan(
      flat.observe().vehicles[0].forward,
    );
    for (let i = 0; i < 8; i++) flat.step(cmd(0, true));
    expect(flat.observe().vehicles[0].forward).toBe(0);
    for (let i = 0; i < 8; i++) flat.step(cmd(-1));
    expect(flat.observe().vehicles[0].forward).toBeLessThan(0);
  });
  it("steers, loses power after damage, and retains a blocking wreck", () => {
    const a = new P3ProvingGround(),
      b = new P3ProvingGround();
    for (let i = 0; i < 8; i++) {
      a.step();
      b.step(cmd(1, false, 0, i === 0 ? 60 : 0));
    }
    expect(b.observe().vehicles[0].forward).toBeLessThan(
      a.observe().vehicles[0].forward,
    );
    const heading = a.observe().vehicles[0].heading;
    a.step(cmd(1, false, 1));
    expect(a.observe().vehicles[0].heading).not.toBe(heading);
    a.step(cmd(0, false, 0, 100));
    const wreck = a.observe().vehicles;
    a.step();
    expect(a.observe().vehicles).toEqual(wreck);
    const c = clone(P3_FIXTURE);
    const field = { ...c.field, heights: c.field.heights.map(() => 0) };
    const w = new P3ProvingGround({
      ...c,
      field,
      vehicles: [
        { ...c.vehicles[0], x: 1024, y: 1024, height: 0 },
        {
          ...c.vehicles[1],
          x: 1600,
          y: 1024,
          height: 0,
          health: 0,
          status: "wreck",
        },
      ],
      ball: { ...c.ball, z: 1024 },
    });
    for (let i = 0; i < 20; i++) w.step();
    expect(w.observe().vehicles[0].x).toBeLessThanOrEqual(1344);
    expect(w.observe().vehicles[1].x).toBe(1600);
  });
  it("prediction is detached and matches landed/caught futures", () => {
    const w = new P3ProvingGround();
    const before = w.capture(),
      predicted = w.predictThrow(40);
    expect(w.capture()).toEqual(before);
    for (let i = 0; i < 40; i++) expect(w.step().ball).toEqual(predicted[i]);
    expect(w.observe().ball.status).not.toBe("flying");
    const c = clone(P3_FIXTURE);
    const catcher = new P3ProvingGround({
      ...c,
      field: { ...c.field, heights: c.field.heights.map(() => 0) },
      vehicles: c.vehicles.map((v) => ({ ...v, height: 0 })),
      ball: { x: 1024, y: 2048, z: 128, vx: 0, vy: 0, vz: 0, status: "flying" },
      catchers: [{ x: 1024, y: 2048, radius: 128, reach: 256 }],
    });
    expect(catcher.step().ball.status).toBe("caught");
  });
  it("restores in flight, after damage, and wreck with exact continuation; rejection is atomic", () => {
    const a = new P3ProvingGround();
    for (let i = 0; i < 5; i++) a.step(cmd(1, false, 0, i === 0 ? 10 : 0));
    const b = new P3ProvingGround();
    b.restore(a.capture());
    for (let i = 0; i < 20; i++) {
      const command = cmd(1, i > 10, 0, i === 8 ? 100 : 0);
      a.step(command);
      b.step(command);
      expect(b.capture()).toEqual(a.capture());
    }
    const before = b.capture(),
      bad = clone(before);
    bad.state.vehicles[0].health = 100;
    expect(() => b.restore(bad)).toThrow();
    expect(b.capture()).toEqual(before);
    expect(() => b.restore({ ...before, extra: 1 })).toThrow();
    expect(() =>
      b.restore({
        ...before,
        state: Object.defineProperty({}, "tick", {
          get() {
            throw Error("getter executed");
          },
        }),
      }),
    ).toThrow();
    expect(b.capture()).toEqual(before);
  });
  it("bounds commands, field edges and the checkpoint horizon atomically", () => {
    const w = new P3ProvingGround();
    const before = w.capture();
    expect(() => w.step(cmd(2))).toThrow();
    expect(w.capture()).toEqual(before);
    for (let i = 0; i < 256; i++) w.step();
    expect(w.observe().ball.status).not.toBe("flying");
    expect(() => w.step()).toThrow();
    const restored = new P3ProvingGround();
    restored.restore(w.capture());
    expect(restored.capture()).toEqual(w.capture());
  });
  it("handles the upper throw bound and edge without rejecting vehicle ticks", () => {
    const c = clone(P3_FIXTURE);
    const high = new P3ProvingGround({
      ...c,
      ball: { ...c.ball, z: 16384, vz: 256 },
    });
    expect(high.step().ball).toMatchObject({
      z: 16384,
      vz: 0,
      status: "flying",
    });
    const edge = new P3ProvingGround({
      ...c,
      ball: { ...c.ball, x: 16380, z: 4096, vx: 128 },
    });
    expect(edge.step().ball.status).toBe("landed");
    expect(edge.observe().tick).toBe(1);
  });

  it("coasts downhill faster and reverses grade influence when travelling backward", () => {
    const config = (g: number, forward: number) => {
      const c = grade(g);
      return { ...c, vehicles: c.vehicles.map((v) => ({ ...v, forward })) };
    };
    const up = new P3ProvingGround(config(256, 100)),
      flat = new P3ProvingGround(config(0, 100)),
      down = new P3ProvingGround(config(-256, 100));
    up.step(cmd(0));
    flat.step(cmd(0));
    down.step(cmd(0));
    expect(up.observe().vehicles[0].forward).toBeLessThan(
      flat.observe().vehicles[0].forward,
    );
    expect(down.observe().vehicles[0].forward).toBeGreaterThan(
      flat.observe().vehicles[0].forward,
    );
    const reverseUp = new P3ProvingGround(config(256, -64)),
      reverseDown = new P3ProvingGround(config(-256, -64));
    reverseUp.step(cmd(0));
    reverseDown.step(cmd(0));
    expect(Math.abs(reverseUp.observe().vehicles[0].forward)).toBeGreaterThan(
      Math.abs(reverseDown.observe().vehicles[0].forward),
    );
  });
  it("settles tiny signed velocities to canonical zero and restores", () => {
    const c = grade(0);
    const config = {
      ...c,
      vehicles: c.vehicles.map((v) => ({ ...v, forward: -1, lateral: -1 })),
    };
    const w = new P3ProvingGround(config);
    w.step(cmd(0));
    expect(w.observe().vehicles[0].forward).toBe(0);
    expect(Object.is(w.observe().vehicles[0].lateral, -0)).toBe(false);
    const b = new P3ProvingGround(config);
    b.restore(w.capture());
    expect(b.capture()).toEqual(w.capture());
  });
  it("stages combined panel batches and pair restoration without partial publication", () => {
    const g = new P3ProvingGround(),
      s = new P3SlopeWorld(P3_SLOPE_FIXTURE, {
        x: 1024,
        y: 4096,
        vy: 0,
        grounded: "flat",
      });
    const beforeG = g.capture(),
      beforeS = s.capture();
    expect(() =>
      stageP3ProofBatch(g, s, 12, cmd(), {
        move: 257,
        jump: false,
        drop: false,
      }),
    ).toThrow();
    expect(g.capture()).toEqual(beforeG);
    expect(s.capture()).toEqual(beforeS);
    let pair = stageP3ProofBatch(g, s, 252);
    const savedG = pair.ground.capture(),
      savedS = pair.slope.capture();
    expect(() => stageP3ProofBatch(pair.ground, pair.slope, 12)).toThrow();
    expect(pair.ground.capture()).toEqual(savedG);
    expect(pair.slope.capture()).toEqual(savedS);
    expect(() =>
      restoreP3ProofPair(savedG, {
        ...savedS,
        state: { ...savedS.state, y: 9999 },
      }),
    ).toThrow();
    expect(pair.ground.capture()).toEqual(savedG);
    expect(pair.slope.capture()).toEqual(savedS);
    pair = stageP3ProofBatch(pair.ground, pair.slope, 4);
    expect(pair.ground.observe().tick).toBe(256);
    expect(pair.slope.capture().commands).toHaveLength(256);
    const fresh = new P3ProvingGround(),
      freshBefore = fresh.capture();
    expect(() => stageP3ProofBatch(fresh, pair.slope, 1)).toThrow();
    expect(fresh.capture()).toEqual(freshBefore);
    expect(pair.slope.capture().commands).toHaveLength(256);
  });
  it("validates a maximum field once, then uses four height reads per sample in ticks, prediction and restore", () => {
    const c = clone(P3_FIXTURE);
    const config = {
      ...c,
      field: {
        columns: 16,
        rows: 16,
        pitch: 2048,
        heights: Array(256).fill(0),
      },
      vehicles: c.vehicles.map((v) => ({ ...v, height: 0 })),
      ball: { ...c.ball, z: 16384, vx: 0, vy: 0 },
      catchers: Array.from({ length: 4 }, (_, i) => ({
        x: 8192 + i * 256,
        y: 8192,
        radius: 128,
        reach: 128,
      })),
    };
    const g = new P3ProvingGround(config);
    const initial = g.observeWork();
    expect(initial.validations).toBe(1);
    g.predictThrow(256);
    const predicted = g.observeWork();
    expect(predicted.validations).toBe(1);
    expect(predicted.heightReads).toBe(predicted.samples * 4);
    expect(predicted.samples - initial.samples).toBeLessThanOrEqual(1024);
    for (let i = 0; i < 256; i++) g.step();
    expect(g.observeWork().validations).toBe(1);
    expect(g.observeWork().samples - predicted.samples).toBeLessThanOrEqual(
      2048,
    );
    const restored = new P3ProvingGround(config);
    restored.restore(g.capture());
    expect(restored.capture()).toEqual(g.capture());
    expect(restored.observeWork().validations).toBe(1);
    expect(restored.observeWork().heightReads).toBe(
      restored.observeWork().samples * 4,
    );
    expect(restored.observeWork().samples).toBeLessThanOrEqual(
      initial.samples + 2048,
    );
  });
});
