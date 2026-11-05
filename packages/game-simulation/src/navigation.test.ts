import { describe, it, expect } from "vitest";
import { NavigationScheduler, NAVIGATION_LIMITS } from "./navigation";
import { NavigationFixture } from "./navigation-fixture";
import { inspectNavigationFixture } from "../../../apps/game-lab/src/navigation-proof";
const grid = (costs = Array(9).fill(1)) => ({
  width: 3,
  height: 3,
  revision: 0,
  costs,
});
function finish(n: NavigationScheduler) {
  while (
    n
      .observe()
      .searches.some((s) => s.status === "queued" || s.status === "searching")
  )
    n.step(1);
  return n.observe();
}
describe("N0 bounded navigation", () => {
  it("uses stable orthogonal BFS and integer A* finds the cheaper detour", () => {
    const bfs = new NavigationScheduler(grid());
    bfs.request({ id: 1, algorithm: "bfs", start: 0, goal: 8 });
    expect(finish(bfs).searches[0].path).toEqual([0, 1, 2, 5, 8]);
    const astar = new NavigationScheduler(grid([1, 9, 1, 1, 1, 1, 1, 1, 1]));
    astar.request({ id: 1, algorithm: "astar", start: 0, goal: 2 });
    const result = finish(astar).searches[0];
    expect(result.path).toEqual([0, 3, 4, 5, 2]);
    expect(result.distance[2]).toBe(4);
  });
  it("bounds worst backlog, expansion work and deterministic FIFO completion ticks", () => {
    const n = new NavigationScheduler(grid());
    for (let id = 1; id <= 16; id++)
      n.request({ id, algorithm: "bfs", start: 0, goal: 8 });
    expect(() =>
      n.request({ id: 17, algorithm: "bfs", start: 0, goal: 8 }),
    ).toThrow();
    expect(n.step(2).counters.expansions).toBe(2);
    const saved = n.capture(),
      restored = new NavigationScheduler(grid());
    restored.restore(saved);
    const end = finish(n);
    expect(finish(restored)).toEqual(end);
    expect(end.counters.expansions).toBe(144);
    expect(end.counters.neighborChecks).toBe(512);
    expect(end.searches.map((s) => s.completedTick)).toEqual(
      Array.from({ length: 16 }, (_, i) => 9 * (i + 1) - 1),
    );
  });
  it("handles cancellation, unreachable, stale pending and stale completed paths", () => {
    const n = new NavigationScheduler(grid([1, 0, 1, 0, 0, 0, 1, 0, 1]));
    n.request({ id: 1, algorithm: "bfs", start: 0, goal: 8 });
    expect(finish(n).searches[0].status).toBe("unreachable");
    n.request({ id: 2, algorithm: "bfs", start: 0, goal: 0 });
    n.cancel(2);
    expect(n.observe().searches[1].status).toBe("cancelled");
    n.request({ id: 3, algorithm: "bfs", start: 0, goal: 0 });
    n.step(1);
    n.request({ id: 4, algorithm: "bfs", start: 0, goal: 8 });
    n.setTerrain({ ...grid(), revision: 1 });
    expect(
      n
        .observe()
        .searches.slice(2)
        .map((s) => s.status),
    ).toEqual(["stale", "stale"]);
    expect(n.observe().searches[2].path).toEqual([]);
  });
  it("rejects malformed or forged exact frontiers without replacing live state", () => {
    const n = new NavigationScheduler(grid());
    n.request({ id: 1, algorithm: "bfs", start: 0, goal: 8 });
    n.step(1);
    const before = n.capture();
    const forged = structuredClone(before);
    forged.state.searches[0].frontier.reverse();
    expect(() => n.restore(forged)).toThrow();
    expect(n.capture()).toEqual(before);
    for (const invalid of [
      { ...before, extra: 1 },
      { ...before, operations: [{ kind: "step", quota: 65 }] },
      { ...before, state: {} },
    ]) {
      expect(() => n.restore(invalid)).toThrow();
      expect(n.capture()).toEqual(before);
    }
    expect(() => n.step(0)).toThrow();
    expect(() => new NavigationScheduler({ ...grid(), width: 257 })).toThrow();
  });
  it("courier consumes a route, stops stale work, replans and resumes exact movement", () => {
    const original = new NavigationFixture();
    for (let i = 0; i < 17; i++) original.step();
    const checkpoint = original.capture();
    const restored = new NavigationFixture();
    restored.restore(checkpoint);
    for (let i = 17; i < 150; i++) {
      expect(restored.step()).toEqual(original.step());
    }
    const state = original.observe();
    expect(state.actor).toBe(63);
    expect(state.navigation.searches[0].status).toBe("stale");
    expect(state.navigation.searches[15].status).toBe("found");
    expect(state.moves).toBe(14);
    const before = restored.capture();
    const bad = structuredClone(before);
    bad.state.actor = 0;
    expect(() => restored.restore(bad)).toThrow();
    expect(restored.capture()).toEqual(before);
    const forgedNavigation = structuredClone(before);
    forgedNavigation.navigation.operations.pop();
    expect(() => restored.restore(forgedNavigation)).toThrow();
    expect(restored.capture()).toEqual(before);
  });
});

describe("N0 validation and algorithm oracle", () => {
  it("exposes the real courier and exact pending continuation in Lab diagnostics", () => {
    const proof = inspectNavigationFixture();
    expect(proof.backlogAtSave).toBe(14);
    expect(
      proof.pending.state.navigation.searches[0].frontier.length,
    ).toBeGreaterThan(0);
    expect(proof.exactContinuation).toBe(true);
    expect(proof.state.actor).toBe(63);
    expect(proof.completionTicks[0]).toEqual({
      id: 1,
      tick: 64,
      status: "stale",
    });
    expect(proof.completionTicks[15].status).toBe("found");
  });
  it("matches an independent relaxation oracle on weighted and disconnected grids", () => {
    for (let seed = 0; seed < 40; seed++) {
      const costs = Array.from({ length: 16 }, (_, i) =>
        i === 0 || i === 15
          ? 1
          : (i * 17 + seed * 13) % 7 === 0
            ? 0
            : 1 + ((i * 7 + seed) % 9),
      );
      const distance = Array(16).fill(Infinity);
      distance[0] = 0;
      for (let pass = 0; pass < 16; pass++)
        for (let n = 0; n < 16; n++)
          for (const next of [
            n % 4 ? n - 1 : -1,
            n % 4 < 3 ? n + 1 : -1,
            n >= 4 ? n - 4 : -1,
            n < 12 ? n + 4 : -1,
          ])
            if (next >= 0 && costs[next])
              distance[next] = Math.min(
                distance[next],
                distance[n] + costs[next],
              );
      const scheduler = new NavigationScheduler({
        width: 4,
        height: 4,
        revision: 0,
        costs,
      });
      scheduler.request({ id: 1, algorithm: "astar", start: 0, goal: 15 });
      const search = finish(scheduler).searches[0];
      expect(search.status).toBe(
        Number.isFinite(distance[15]) ? "found" : "unreachable",
      );
      if (search.status === "found")
        expect(search.distance[15]).toBe(distance[15]);
    }
  });
  it("rejects exotic data and cap failures atomically", () => {
    const n = new NavigationScheduler(grid());
    n.request({ id: 1, algorithm: "bfs", start: 0, goal: 8 });
    const before = n.capture();
    const symbolic = structuredClone(before);
    Object.defineProperty(symbolic, Symbol("extra"), { value: 1 });
    const hidden = structuredClone(before);
    Object.defineProperty(hidden, "extra", { value: 1 });
    const negative = structuredClone(before);
    negative.state.tick = -0;
    const subclass = structuredClone(before);
    Object.setPrototypeOf(
      subclass.state.searches,
      class extends Array {}.prototype,
    );
    for (const invalid of [symbolic, hidden, negative, subclass]) {
      expect(() => n.restore(invalid)).toThrow();
      expect(n.capture()).toEqual(before);
    }
    for (const invalid of [
      () => n.step(65),
      () => n.cancel(99),
      () => n.setTerrain({ ...grid(), revision: 2 }),
      () => n.request({ id: 1, algorithm: "bfs", start: 0, goal: 8 }),
    ]) {
      expect(invalid).toThrow();
      expect(n.capture()).toEqual(before);
    }
  });
  it("rejects accessor and hidden terrain costs before reading them or changing live state", () => {
    const scheduler = new NavigationScheduler(grid());
    scheduler.request({ id: 1, algorithm: "bfs", start: 0, goal: 8 });
    scheduler.step(1);
    const before = scheduler.capture();
    for (const hidden of [false, true]) {
      let reads = 0;
      const costs = Array(9).fill(1);
      Object.defineProperty(
        costs,
        "0",
        hidden
          ? { value: 1, enumerable: false }
          : {
              enumerable: true,
              get() {
                return ++reads === 1 ? 1 : 999;
              },
            },
      );
      expect(() => new NavigationScheduler(grid(costs))).toThrow();
      expect(() =>
        scheduler.setTerrain({ ...grid(costs), revision: 1 }),
      ).toThrow();
      expect(reads).toBe(0);
      expect(scheduler.capture()).toEqual(before);
    }
  });
  it("restores accepted maximum terrain journal and tick/operation limits", () => {
    const initial = {
      width: 16,
      height: 16,
      revision: 0,
      costs: Array(256).fill(255),
    };
    const n = new NavigationScheduler(initial);
    for (let revision = 1; revision <= 4096; revision++) {
      n.setTerrain({ ...initial, revision });
      n.step(64);
    }
    const checkpoint = n.capture(),
      restored = new NavigationScheduler(initial);
    restored.restore(checkpoint);
    expect(restored.capture()).toEqual(checkpoint);
    expect(() => n.step(1)).toThrow();
    expect(n.capture()).toEqual(checkpoint);
  }, 20000);
});

describe("N0 courier checkpoint boundary", () => {
  it("rejects invisible properties, toJSON hooks and getters without invoking them", () => {
    const fixture = new NavigationFixture();
    fixture.step();
    const before = fixture.capture();
    const cases: unknown[] = [];
    const symbol = structuredClone(before);
    Object.defineProperty(symbol.state, Symbol("extra"), { value: 1 });
    cases.push(symbol);
    const undefinedExtra = structuredClone(before) as any;
    undefinedExtra.state.extra = undefined;
    cases.push(undefinedExtra);
    const hidden = structuredClone(before);
    Object.defineProperty(hidden.state, "extra", { value: 1 });
    cases.push(hidden);
    let invoked = false;
    const getter = structuredClone(before);
    Object.defineProperty(getter, "state", {
      enumerable: true,
      get() {
        invoked = true;
        return before.state;
      },
    });
    cases.push(getter);
    const hook = structuredClone(before) as any;
    hook.state.toJSON = () => {
      invoked = true;
      return before.state;
    };
    cases.push(hook);
    const arrayGetter = structuredClone(before);
    Object.defineProperty(arrayGetter.navigation.state.searches, "0", {
      enumerable: true,
      get() {
        invoked = true;
        return before.navigation.state.searches[0];
      },
    });
    cases.push(arrayGetter);
    for (const value of cases) {
      expect(() => fixture.restore(value)).toThrow();
      expect(fixture.capture()).toEqual(before);
    }
    expect(invoked).toBe(false);
  });
  it("accepts reordered fields and restores the maximum courier tick", () => {
    const fixture = new NavigationFixture();
    for (let tick = 0; tick < 1024; tick++) fixture.step();
    const saved = fixture.capture();
    const reordered = {
      navigation: saved.navigation,
      state: { ...saved.state },
      format: saved.format,
    };
    const restored = new NavigationFixture();
    restored.restore(reordered);
    expect(restored.capture()).toEqual(saved);
    expect(() => restored.step()).toThrow(/cap/);
    expect(restored.capture()).toEqual(saved);
    expect(Object.isFrozen(NAVIGATION_LIMITS)).toBe(true);
  }, 20000);
});
