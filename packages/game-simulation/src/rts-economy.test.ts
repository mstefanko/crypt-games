import { describe, expect, it } from "vitest";
import {
  RtsTacticalSimulation as Rts,
  RTS_LIMITS,
  type RtsCheckpoint,
} from "./rts";

const resume = (s: Rts) => s.command({ kind: "pause", paused: false });
const ticks = (s: Rts, count: number) => {
  for (let i = 0; i < count; i++) s.advance();
};
function withoutOpponents(): Rts {
  const s = new Rts(),
    saved = s.capture();
  for (const u of saved.state.units.slice(16)) u.health = 0;
  saved.state.counters.deaths = 16;
  s.restore(saved);
  return s;
}
function exactContinue(s: Rts, count: number): Rts {
  const r = new Rts();
  r.restore(s.capture());
  expect(r.capture()).toEqual(s.capture());
  for (let i = 0; i < count; i++) expect(r.step()).toEqual(s.step());
  return r;
}

describe("bounded RTS resource and replacement loop", () => {
  it("buys/refunds atomically during pause while all world work remains frozen", () => {
    const s = new Rts();
    s.command({ kind: "gather", unitIds: [1, 2], nodeId: 1 });
    s.command({ kind: "train", producerId: 1 });
    s.command({ kind: "train", producerId: 2 });
    expect(s.observe().economy.credits).toBe(0);
    const paused = s.capture();
    ticks(s, 20);
    expect(s.capture()).toEqual(paused);
    expect(() => s.command({ kind: "train", producerId: 1 })).toThrow(
      /insufficient credits/,
    );
    expect(s.capture()).toEqual(paused);
    expect(() => s.command({ kind: "cancel-production", jobId: 3 })).toThrow(
      /unknown production job/,
    );
    expect(s.capture()).toEqual(paused);
    s.command({ kind: "cancel-production", jobId: 1 });
    expect(s.observe().economy).toMatchObject({
      credits: 20,
      cancelled: 1,
      refunded: 20,
    });
    expect(s.observe().pendingCommands).toEqual([
      { kind: "gather", unitIds: [1, 2], nodeId: 1 },
    ]);
    exactContinue(s, 2);
    resume(s);
    ticks(s, 3);
    expect(s.observe().economy.jobs[0].remaining).toBe(9);
    expect(s.observe().economy.harvested).toBeGreaterThan(0);
    expect(s.observe().units[0].order.kind).toBe("gather");
    exactContinue(s, 20);
  });

  it("harvests only with living adjacent workers, depletes finite nodes and idles after exhaustion", () => {
    const s = withoutOpponents(),
      saved = s.capture();
    saved.state.units[0].cell = 0;
    saved.state.units[1].cell = 1;
    s.restore(saved);
    s.command({ kind: "gather", unitIds: [1, 2], nodeId: 1 });
    resume(s);
    s.advance();
    expect(s.observe().economy.harvested).toBe(0);
    // Authored diagnostic arrangement at the resource: actual gather commands do all extraction.
    const adjacent = withoutOpponents(),
      setup = adjacent.capture();
    setup.state.units[0].cell = setup.state.economy.nodes[0].cell - 1;
    setup.state.units[1].cell = setup.state.economy.nodes[0].cell - 64;
    adjacent.restore(setup);
    adjacent.command({ kind: "gather", unitIds: [1, 2], nodeId: 1 });
    resume(adjacent);
    ticks(adjacent, 128);
    expect(adjacent.observe().economy).toMatchObject({
      credits: 296,
      harvested: 256,
    });
    expect(adjacent.observe().economy.nodes.map((n) => n.remaining)).toEqual([
      0, 256,
    ]);
    adjacent.advance();
    expect(
      adjacent
        .observe()
        .units.slice(0, 2)
        .every((u) => u.order.kind === "idle"),
    ).toBe(true);
    expect(adjacent.observe().navigation.searches).toEqual([]);
    const e = adjacent.observe().economy;
    ticks(adjacent, 8);
    expect(adjacent.observe().economy).toEqual(e);
    exactContinue(adjacent, 3);
  });

  it("runs two producers in parallel, enforces FIFO capacity and retains ready jobs at the mobile cap", () => {
    const s = withoutOpponents(),
      saved = s.capture();
    saved.state.units[0].cell = saved.state.economy.nodes[0].cell - 1;
    s.restore(saved);
    s.command({ kind: "gather", unitIds: [1], nodeId: 1 });
    resume(s);
    ticks(s, 80);
    s.command({ kind: "pause", paused: true });
    for (const producerId of [1, 1, 2, 2])
      s.command({ kind: "train", producerId });
    const full = s.capture();
    expect(() => s.command({ kind: "train", producerId: 1 })).toThrow(
      /production queue cap/,
    );
    expect(s.capture()).toEqual(full);
    resume(s);
    ticks(s, RTS_LIMITS.productionTicks);
    const jobs = s.observe().economy.jobs;
    expect(jobs.map((j) => j.remaining)).toEqual([0, 12, 0, 12]);
    expect(jobs.map((j) => j.status)).toEqual([
      "population",
      "training",
      "population",
      "training",
    ]);
    expect(s.observe().units.filter((u) => u.health).length).toBe(16);
    exactContinue(s, 5);
    s.command({ kind: "cancel-production", jobId: jobs[0].id });
    s.advance();
    expect(s.observe().economy.jobs[0].remaining).toBe(11);
  });

  it("waits at blocked exits, then replaces the lowest dead slot through the first free exit exactly once", () => {
    const s = withoutOpponents(),
      setup = s.capture(),
      base = setup.state.economy.producers[0].cell;
    setup.state.units[0].health = 0;
    setup.state.counters.deaths++;
    [base - 64, base + 1, base + 64, base - 1].forEach(
      (cell, i) => (setup.state.units[i + 1].cell = cell),
    );
    s.restore(setup);
    s.command({ kind: "train", producerId: 1 });
    resume(s);
    ticks(s, 12);
    expect(s.observe().economy.jobs[0]).toMatchObject({
      remaining: 0,
      status: "exit-blocked",
    });
    exactContinue(s, 4);
    s.command({ kind: "move", unitIds: [2], destination: base - 65 });
    s.advance();
    const state = s.observe();
    expect(state.economy.jobs).toEqual([]);
    expect(state.economy.produced).toBe(1);
    expect(state.units[0]).toMatchObject({
      id: 1,
      cell: base - 64,
      health: 12,
      order: { kind: "idle" },
    });
    expect(
      new Set(state.units.filter((u) => u.health).map((u) => u.cell)).size,
    ).toBe(16);
    expect(state.counters.deaths).toBe(
      state.units.filter((u) => !u.health).length + state.economy.produced,
    );
    exactContinue(s, 12);
    expect(s.observe().economy.produced).toBe(1);
  });

  it("discards old-life enemy windups when production reuses a dead player slot", () => {
    const s = withoutOpponents(),
      setup = s.capture();
    setup.state.units[0].health = 0;
    setup.state.counters.deaths++;
    const enemy = setup.state.units[16];
    enemy.health = 12;
    setup.state.counters.deaths--;
    enemy.targetId = 1;
    enemy.behavior = { ...enemy.behavior!, state: "windup", timer: 2 };
    const e = setup.state.economy;
    e.credits = 20;
    e.spent = 20;
    e.nextJobId = 2;
    e.jobs = [{ id: 1, producerId: 1, remaining: 0, status: "exit-blocked" }];
    s.restore(setup);
    resume(s);
    s.advance();
    const state = s.observe();
    expect(state.economy.produced).toBe(1);
    expect(state.units[0].health).toBe(12);
    expect(state.units[16]).toMatchObject({
      targetId: null,
      requestId: null,
      goal: null,
      behavior: { state: "recover", timer: 3 },
    });
    expect(state.counters.attacks).toBe(0);
    s.advance();
    expect(s.observe().units[0].health).toBe(12);
    exactContinue(s, 3);
  });

  it("replays unmodified combat deaths, resource work, pending paths and actual replacements", () => {
    const a = new Rts(),
      b = new Rts();
    for (const s of [a, b]) {
      s.command({ kind: "gather", unitIds: [1, 2], nodeId: 1 });
      s.command({ kind: "train", producerId: 1 });
      s.command({ kind: "train", producerId: 2 });
      resume(s);
    }
    for (let i = 0; i < 3; i++) expect(a.step()).toEqual(b.step());
    expect(a.observe().economy.jobs[0].remaining).toBe(9);
    expect(a.observe().navigation.searches.length).toBeGreaterThan(0);
    const r = new Rts();
    r.restore(a.capture());
    for (let i = 0; i < 60; i++) {
      expect(a.step()).toEqual(b.step());
      expect(r.step()).toEqual(a.observe());
    }
    expect(a.observe().economy.produced).toBe(2);
    expect(a.observe().economy.harvested).toBeGreaterThan(0);
    expect(a.observe().units).toHaveLength(32);
    for (const enemy of a.observe().units.filter((u) => u.team === 1))
      expect(enemy.behavior?.position).toBe(0);
  });

  it("rejects malformed economy, forged conservation, hidden hooks and pending economy commands atomically", () => {
    const s = new Rts();
    s.command({ kind: "train", producerId: 1 });
    s.command({ kind: "gather", unitIds: [1], nodeId: 1 });
    const before = s.capture();
    const edits: ((c: RtsCheckpoint) => void)[] = [
      (c) => c.state.economy.credits++,
      (c) => c.state.economy.nodes[0].remaining++,
      (c) => c.state.economy.producers[0].cell++,
      (c) => (c.state.economy.jobs[0].remaining = 13),
      (c) => c.state.economy.jobs[0].id++,
      (c) => (c.state.economy.jobs[0].status = "population"),
      (c) => c.state.economy.harvested++,
      (c) => c.state.economy.produced++,
      (c) => c.state.economy.nextJobId++,
      (c) =>
        (c.state.pendingCommands as unknown[]).push({
          kind: "train",
          producerId: 1,
        }),
      (c) => (c.state.units[0].order = { kind: "gather", nodeId: 3 }),
    ];
    for (const edit of edits) {
      const invalid = structuredClone(before);
      edit(invalid);
      expect(() => s.restore(invalid)).toThrow();
      expect(s.capture()).toEqual(before);
    }
    let invoked = false;
    const hook = structuredClone(before);
    Object.defineProperty(hook.state.economy, "credits", {
      enumerable: true,
      get: () => {
        invoked = true;
        return 20;
      },
    });
    expect(() => s.restore(hook)).toThrow();
    expect(invoked).toBe(false);
    expect(s.capture()).toEqual(before);
    for (const command of [
      { kind: "gather", unitIds: [1], nodeId: 0 },
      { kind: "train", producerId: 3 },
      { kind: "train", producerId: 1, cost: 0 },
      { kind: "cancel-production", jobId: -1 },
    ]) {
      expect(() => s.command(command as any)).toThrow();
      expect(s.capture()).toEqual(before);
    }
  });

  it("preserves v1 combat continuation through explicit fresh-economy migration", () => {
    const s = new Rts();
    s.command({ kind: "move", unitIds: [1], destination: 0 });
    resume(s);
    ticks(s, 3);
    const legacy: any = s.capture();
    legacy.format = "rts-tactical-v1";
    delete legacy.state.economy;
    const r = new Rts();
    r.restore(legacy);
    expect(r.capture()).toEqual(s.capture());
    for (let i = 0; i < 12; i++) expect(r.step()).toEqual(s.step());
  });
});

it("rejects unsorted gather selections and impossible v1 gather saves atomically", () => {
  const s = new Rts(), before = s.capture();
  expect(() => s.command({ kind: "gather", unitIds: [3, 1, 2], nodeId: 1 })).toThrow(/sorted/);
  expect(s.capture()).toEqual(before);
  for (const queued of [false, true]) {
    const saved = structuredClone(before) as any;
    saved.format = "rts-tactical-v1";
    delete saved.state.economy;
    if (queued) saved.state.pendingCommands = [{ kind: "gather", unitIds: [1], nodeId: 1 }];
    else saved.state.units[0].order = { kind: "gather", nodeId: 1 };
    expect(() => s.restore(saved)).toThrow(/Legacy.*gather/);
    expect(s.capture()).toEqual(before);
  }
});
