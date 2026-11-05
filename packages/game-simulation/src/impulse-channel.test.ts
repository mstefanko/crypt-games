import { describe, expect, it } from "vitest";
import { ArenaImpulseFixture } from "./impulse-channel";
const input = (extra = {}) => ({ moveX: 0, moveY: 0, aim: 0, fire: false, dash: false, shove: false, ...extra });
const request = (sourceId: string, x: number, targetId = "target", y = 0) => ({ sourceId, targetId, x, y });
describe("bounded arena impulse channel", () => {
  it("sorts sources, sums opposing impulses before one clamp and consumes once", () => {
    const a = new ArenaImpulseFixture(), b = new ArenaImpulseFixture();
    const values = [request("z", 2048), request("a", -2048), request("m", 800)];
    a.queue(values); b.queue([...values].reverse());
    expect(a.save()).toBe(b.save());
    expect(a.step(input())).toEqual(b.step(input()));
    expect(a.observe().velocities[1].x).toBe(736);
    expect(a.observe().pending).toEqual([]);
    a.step(input());
    expect(a.observe().velocities[1].x).toBe(736); // contact hit-stop retains the already consumed velocity
  });
  it("applies resistance, clamps L1 speed, and clips via existing swept arena motor", () => {
    const f = new ArenaImpulseFixture();
    f.queue([request("push", 800, "hero")]);
    expect(f.step(input()).velocities[0].x).toBe(336);
    const diagonal = new ArenaImpulseFixture();
    diagonal.queue([request("push", 2048, "target", 2048)]);
    expect(diagonal.step(input()).velocities[1]).toMatchObject({ x: 448, y: 448 });
    const blocked = new ArenaImpulseFixture();
    blocked.queue([request("push", 2048)]);
    const first = blocked.step(input({ shove: true }));
    expect(first.arena.actors[1].x + first.arena.actors[1].width).toBe(first.arena.walls[0].x);
    expect(first.velocities[1].x).toBe(0);
  });
  it("accumulates during tick-start freeze, releases once, and restores pending mid-freeze exactly", () => {
    const f = new ArenaImpulseFixture();
    f.step(input({ shove: true }));
    f.queue([request("back", -800)]);
    const x = f.observe().arena.actors[1].x;
    expect(f.step(input()).arena.actors[1].x).toBe(x);
    expect(f.observe().velocities[1].x).toBe(-800);
    f.queue([request("opposed", 200)]);
    const g = new ArenaImpulseFixture(); g.load(f.save());
    for (let i = 0; i < 12; i++) {
      expect(g.step(input())).toEqual(f.step(input()));
      expect(g.save()).toBe(f.save());
    }
    expect(f.observe().arena.actors[1].x).toBeLessThan(x);
  });
  it("rejects capacity, duplicate source, malformed input and forged continuation atomically", () => {
    const f = new ArenaImpulseFixture();
    f.queue([request("saved", 100)]);
    const before = f.save();
    for (const invalid of [[request("saved", 100)], [request("bad", 2049)], [request("bad", -0)], [request("bad", 1, "missing")], Array.from({ length: 33 }, (_, i) => request(String(i), 1))]) {
      expect(() => f.queue(invalid)).toThrow(); expect(f.save()).toBe(before);
    }
    expect(() => f.step(input({ moveX: 128 }))).toThrow(); expect(f.save()).toBe(before);
    let reads = 0;
    const bad = request("getter", 1);
    Object.defineProperty(bad, "x", { enumerable: true, get() { reads++; return 1; } });
    expect(() => f.queue([bad])).toThrow(); expect(reads).toBe(0);
    for (const alter of [
      (v: any) => { v.velocities[0].x = 1025; },
      (v: any) => { v.velocities[0].x = 700; v.velocities[0].y = 700; },
      (v: any) => { v.velocities.reverse(); },
      (v: any) => { v.pending.push(v.pending[0]); },
      (v: any) => { v.format = "future"; },
      (v: any) => { v.arena = v.arena.replace('"rulesBuildId":"arena-impulse-v1"', '"rulesBuildId":"other"'); },
    ]) {
      const forged = f.capture(); alter(forged); expect(() => f.restore(forged)).toThrow(); expect(f.save()).toBe(before);
    }
    expect(() => f.load("{" )).toThrow(); expect(f.save()).toBe(before);
    const detached = f.observe(); detached.pending[0].x = 900; detached.velocities[0].x = 999;
    expect(f.save()).toBe(before);
  });
});

import { ImpulseChannel } from "./impulse-channel";
it("supports caller-defined actors/resistance, bounds actor count and pins exact policy", () => {
  const policies = [{ targetId: "custom", resistance256: 256 }, { targetId: "other", resistance256: 0 }];
  const channel = new ImpulseChannel(policies);
  policies[0].resistance256 = 0;
  channel.queue([request("blast", 2048, "custom"), request("blast", 2048, "other")]);
  const checkpoint = channel.capture();
  const copy = new ImpulseChannel([{ targetId: "other", resistance256: 0 }, { targetId: "custom", resistance256: 256 }]);
  copy.restore(checkpoint);
  const moves: unknown[] = [];
  copy.advance([{ targetId: "other", frozen: false, alive: true }, { targetId: "custom", frozen: false, alive: true }], (targetId, x, y) => { moves.push({ targetId, x, y }); return { x, y }; });
  expect(moves).toEqual([{ targetId: "custom", x: 0, y: 0 }, { targetId: "other", x: 1024, y: 0 }]);
  expect(copy.capture().pending).toEqual([]);
  expect(() => new ImpulseChannel(policies).restore(checkpoint)).toThrow("policy");
  expect(() => new ImpulseChannel(Array.from({ length: 33 }, (_, i) => ({ targetId: String(i), resistance256: 0 })))).toThrow();
  expect(() => new ImpulseChannel([{ targetId: "a", resistance256: 257 }])).toThrow();
});

it("bounds a full phase, clears dead recipients, and leaves channel state intact on motor failure", () => {
  const channel = new ImpulseChannel([{ targetId: "a", resistance256: 0 }]);
  channel.queue(Array.from({ length: 32 }, (_, i) => request(`source${i}`, 2048, "a", -2048)));
  const before = channel.capture();
  expect(() => channel.queue([request("overflow", 1, "a")])).toThrow();
  expect(channel.capture()).toEqual(before);
  const status = [{ targetId: "a", frozen: false, alive: true }];
  expect(() => channel.advance(status, () => { throw Error("motor failed"); })).toThrow("motor failed");
  expect(channel.capture()).toEqual(before);
  channel.advance(status, (_id, x, y) => { expect({ x, y }).toEqual({ x: 512, y: -512 }); return { x, y }; });
  channel.queue([request("late", 500, "a")]);
  channel.advance([{ targetId: "a", frozen: true, alive: false }], () => { throw Error("dead motor called"); });
  expect(channel.capture().velocities[0]).toEqual({ targetId: "a", x: 0, y: 0, remainderX: 0, remainderY: 0 });
  expect(channel.capture().pending).toEqual([]);
});

it("preserves signed weak impulses across ticks and exact restore", () => {
  const policy = [{ targetId: "weak", resistance256: 128 }];
  const a = new ImpulseChannel(policy), b = new ImpulseChannel(policy);
  const status = [{ targetId: "weak", alive: true, frozen: false }];
  const motor = (_id: string, x: number, y: number) => ({ x, y });
  a.queue([request("tiny", 1, "weak", -1)]);
  a.advance(status, motor);
  expect(a.capture().velocities[0]).toMatchObject({ x: 0, y: 0, remainderX: 128, remainderY: -128 });
  b.restore(a.capture());
  for (let tick = 0; tick < 10; tick++) {
    const moves: unknown[] = [];
    for (const c of [a, b]) {
      c.queue([request("tiny", 1, "weak", -1)]);
      c.advance(status, (_id, x, y) => { moves.push({ x, y }); return { x, y }; });
    }
    expect(moves[0]).toEqual(moves[1]);
    expect(moves[0]).toEqual(tick % 2 === 0 ? { x: 1, y: -1 } : { x: 0, y: 0 });
    expect(a.capture()).toEqual(b.capture());
  }
  const before = a.capture();
  for (const invalid of [256, -256, -0, 1.5]) {
    const forged = a.capture(); forged.velocities[0].remainderX = invalid;
    expect(() => a.restore(forged)).toThrow(); expect(a.capture()).toEqual(before);
  }
  a.queue([request("tiny", 1, "weak")]);
  const pending = a.capture();
  expect(() => a.advance(status, () => { throw Error("motor failed"); })).toThrow();
  expect(a.capture()).toEqual(pending);
});

it("rejects reentrant channel mutation while permitting captures and clears guard after failures", () => {
  const channel = new ImpulseChannel([{ targetId: "a", resistance256: 0 }]);
  const status = [{ targetId: "a", frozen: false, alive: true }];
  const motor = (_id: string, x: number, y: number) => ({ x, y });
  channel.queue([request("pending", 100, "a")]);
  const before = channel.capture();
  for (const mutate of [
    () => channel.queue([request("reentrant", 100, "a")]),
    () => channel.restore(before),
    () => channel.advance(status, motor),
  ]) {
    expect(() => channel.advance(status, () => {
      expect(channel.capture()).toEqual(before);
      mutate();
      throw Error("unreachable");
    })).toThrow("advance in progress");
    expect(channel.capture()).toEqual(before);
    // Guard clears after failure, and ordinary queue/restore still work.
    channel.queue([]);
    channel.restore(before);
  }
  channel.advance(status, motor);
  expect(channel.capture().pending).toEqual([]);
  expect(channel.capture().velocities[0].x).toBe(36);
  // Guard also clears following a successful callback that catches a rejection.
  channel.advance(status, (_id, x, y) => {
    expect(() => channel.queue([])).toThrow("advance in progress");
    return { x, y };
  });
  channel.queue([request("after", 10, "a")]);
  channel.advance(status, motor);
  expect(channel.capture().pending).toEqual([]);
});

it("restores and advances the reusable 32-actor endpoint", () => {
  const policies = Array.from({ length: 32 }, (_, i) => ({ targetId: `actor${String(i).padStart(2, "0")}`, resistance256: i * 8 }));
  const a = new ImpulseChannel(policies), b = new ImpulseChannel([...policies].reverse());
  a.queue(policies.map(p => request("blast", 256, p.targetId, -256)));
  b.restore(a.capture());
  const statuses = policies.map(p => ({ targetId: p.targetId, frozen: false, alive: true }));
  const motors: unknown[][] = [[], []];
  for (const [i, channel] of [a, b].entries()) channel.advance(statuses, (targetId, x, y) => { motors[i].push({ targetId, x, y }); return { x, y }; });
  expect(motors[0]).toHaveLength(32);
  expect(motors[1]).toEqual(motors[0]);
  expect(b.capture()).toEqual(a.capture());
  expect(a.capture().pending).toEqual([]);
});
