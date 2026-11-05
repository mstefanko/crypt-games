import { describe, it, expect, vi } from "vitest";
import {
  SustainedNavigationScheduler as Service,
  SUSTAINED_NAVIGATION_LIMITS,
} from "./navigation-service";
const grid = (width = 4, height = width) => ({
  width,
  height,
  revision: 0,
  costs: Array(width * height).fill(1),
});
function finish(s: Service) {
  while (
    s
      .observe()
      .searches.some((x) => x.status === "queued" || x.status === "searching")
  )
    s.step(256);
}
describe("N0 sustained service", () => {
  it("validates and detaches live grid/request ingress without JSON serialization", () => {
    const stringify = vi.spyOn(JSON, "stringify").mockImplementation(() => {
      throw Error("live navigation serialization");
    });
    let service: Service | undefined;
    try {
      const terrain = grid(64);
      service = new Service(terrain);
      const id = service.request({ algorithm: "bfs", start: 0, goal: 4095 });
      service.advance(1);
      service.setTerrain({ ...terrain, revision: 1 });
      terrain.costs[0] = 0;
      service.release(id);
      service.request({ algorithm: "bfs", start: 0, goal: 4095 });
    } finally {
      stringify.mockRestore();
    }
    expect(service!.observeTerrain().costs[0]).toBe(1);
    expect(service!.observeSummary().pendingSearches).toBe(1);
  });

  it("advances and queries routes without full observation while preserving quota and completion ticks", () => {
    const s = new Service(grid()),
      legacy = new Service(grid());
    const a = s.request({ algorithm: "astar", start: 0, goal: 15 });
    legacy.request({ algorithm: "astar", start: 0, goal: 15 });
    const b = s.request({ algorithm: "bfs", start: 15, goal: 0 });
    legacy.request({ algorithm: "bfs", start: 15, goal: 0 });
    const observation = vi.spyOn(s, "observe");
    expect(s.nextRouteCell(a, 0)).toBeUndefined();
    for (const quota of [1, 3, 2, 7, 32]) {
      s.advance(quota);
      expect(observation).not.toHaveBeenCalled();
      legacy.step(quota);
      expect(s.capture()).toEqual(legacy.capture());
      observation.mockClear();
    }
    expect(s.status(a)).toBe("found");
    expect(s.nextRouteCell(a, 0)).toBe(1);
    expect(s.nextRouteCell(a, 6)).toBeUndefined();
    expect(s.nextRouteCell(b, 0)).toBe(11);
    expect(s.nextRouteCell(999, 0)).toBeUndefined();
    for (const cursor of [-1, 0.5, 16, Number.MAX_SAFE_INTEGER])
      expect(() => s.nextRouteCell(a, cursor)).toThrow();
    s.release(a);
    expect(s.nextRouteCell(a, 0)).toBeUndefined();
    s.setTerrain({ ...grid(), revision: 1 });
    expect(s.status(b)).toBe("stale");
    expect(s.nextRouteCell(b, 0)).toBeUndefined();
  });
  it("detaches terrain and compact summaries and resumes pending work with matching summaries", () => {
    const s = new Service(grid());
    const id = s.request({ algorithm: "astar", start: 0, goal: 15 });
    s.advance(1);
    const before = s.capture(),
      summary = s.observeSummary(),
      terrain = s.observeTerrain();
    expect(summary).toEqual({
      tick: before.state.tick,
      terrainRevision: 0,
      activeSearches: 1,
      pendingSearches: 1,
      searches: [{ id, status: "searching" }],
      counters: before.state.counters,
    });
    summary.searches[0].status = "found";
    summary.counters.expansions = 900;
    terrain.costs[0] = 0;
    terrain.revision = 5;
    expect(s.capture()).toEqual(before);
    const restored = new Service(grid());
    restored.restore(before);
    for (let i = 0; i < 10; i++) {
      s.advance(1);
      restored.advance(1);
      expect(restored.observeSummary()).toEqual(s.observeSummary());
      expect(restored.capture()).toEqual(s.capture());
    }
    s.setTerrain({
      ...grid(),
      revision: 1,
      costs: [1, 0, ...Array(14).fill(1)],
    });
    expect(s.observeTerrain().costs[1]).toBe(0);
    expect(s.observeSummary().terrainRevision).toBe(1);
    expect(s.observeSummary().pendingSearches).toBe(0);
    expect(s.observeSummary().searches).toEqual([{ id, status: "stale" }]);
    expect(terrain.costs[1]).toBe(1);
  });
  it("serves hundreds of released requests with bounded live memory and stable unique IDs", () => {
    const s = new Service(grid());
    for (let id = 1; id <= 200; id++) {
      expect(s.request({ algorithm: "astar", start: 0, goal: 15 })).toBe(id);
      finish(s);
      expect(s.observe().searches[0].path).toEqual([0, 1, 2, 3, 7, 11, 15]);
      s.release(id);
      expect(s.capture().state.searches).toEqual([]);
    }
    const c = s.capture();
    expect(Object.keys(c)).toEqual(["format", "state"]);
    expect(c.state.nextId).toBe(201);
    const restored = new Service(grid());
    restored.restore(c);
    expect(restored.capture()).toEqual(c);
    expect(JSON.stringify(c).length).toBeLessThan(500);
  });
  it("round robins the full 32 search 64x64 backlog under a strict expansion quota and resumes exactly", () => {
    const s = new Service(grid(64));
    for (let i = 0; i < 32; i++)
      s.request({ algorithm: "astar", start: i, goal: 4095 - i });
    const state = s.step(32);
    expect(state.searches.map((x) => x.expansions)).toEqual(Array(32).fill(1));
    expect(state.counters).toEqual({
      expansions: 32,
      neighborChecks: 128,
      completed: 0,
    });
    const before = s.capture();
    expect(() => s.request({ algorithm: "astar", start: 0, goal: 0 })).toThrow(
      /cap/,
    );
    expect(s.capture()).toEqual(before);
    const r = new Service(grid(64));
    r.restore(before);
    for (let i = 0; i < 8; i++) expect(r.step(128)).toEqual(s.step(128));
    expect(JSON.stringify(s.capture()).length).toBeLessThan(8 * 1024 * 1024);
    expect(Object.isFrozen(SUSTAINED_NAVIGATION_LIMITS)).toBe(true);
  });
  it("invalidates paths and pending work on revision, supports cancellation and explicit replanning", () => {
    const s = new Service(grid());
    const a = s.request({ algorithm: "astar", start: 0, goal: 15 });
    s.step(1);
    expect(() => s.release(a)).toThrow();
    s.cancel(a);
    s.release(a);
    const b = s.request({ algorithm: "astar", start: 0, goal: 15 });
    finish(s);
    const c = s.request({ algorithm: "astar", start: 0, goal: 15 });
    s.setTerrain({
      ...grid(),
      revision: 1,
      costs: [1, 0, 1, 1, ...Array(12).fill(1)],
    });
    expect(s.observe().searches.map((x) => x.status)).toEqual([
      "stale",
      "stale",
    ]);
    expect(
      s
        .observe()
        .searches.every((x) => x.path.length === 0 && x.frontier.length === 0),
    ).toBe(true);
    const r = new Service(grid());
    r.restore(s.capture());
    expect(r.capture()).toEqual(s.capture());
    s.release(b);
    s.release(c);
    const d = s.request({ algorithm: "astar", start: 0, goal: 15 });
    finish(s);
    expect(s.observe().searches[0].id).toBe(d);
    expect(s.observe().searches[0].path[1]).toBe(4);
  });
  it("matches independent weighted relaxation and explicitly finishes unreachable searches", () => {
    for (let seed = 0; seed < 16; seed++) {
      const g = grid();
      g.costs = g.costs.map((_, i) =>
        i === 0 || i === 15
          ? 1
          : (i * 7 + seed) % 5 === 0
            ? 0
            : 1 + ((i + seed) % 9),
      );
      const d = Array(16).fill(Infinity);
      d[0] = 0;
      for (let p = 0; p < 16; p++)
        for (let i = 0; i < 16; i++)
          for (const j of [
            i % 4 ? i - 1 : -1,
            i % 4 < 3 ? i + 1 : -1,
            i >= 4 ? i - 4 : -1,
            i < 12 ? i + 4 : -1,
          ])
            if (j >= 0 && g.costs[j]) d[j] = Math.min(d[j], d[i] + g.costs[j]);
      const s = new Service(g);
      s.request({ algorithm: "astar", start: 0, goal: 15 });
      finish(s);
      const search = s.observe().searches[0];
      expect(search.status).toBe(
        Number.isFinite(d[15]) ? "found" : "unreachable",
      );
      if (search.status === "found") expect(search.distance[15]).toBe(d[15]);
      const r = new Service(g);
      r.restore(s.capture());
      expect(r.capture()).toEqual(s.capture());
    }
    const g = grid(64);
    for (let i = 0; i < 64; i++) g.costs[32 * 64 + i] = 0;
    const s = new Service(g);
    s.request({ algorithm: "bfs", start: 0, goal: 4095 });
    finish(s);
    expect(s.observe().searches[0].status).toBe("unreachable");
    expect(s.observe().searches[0].expansions).toBe(2048);
    const r = new Service(g);
    r.restore(s.capture());
    expect(r.capture()).toEqual(s.capture());
  });
  it("rejects forged frontiers, cursor, counters, oversized data and accessor input atomically", () => {
    const s = new Service(grid());
    s.request({ algorithm: "bfs", start: 0, goal: 15 });
    s.step(2);
    const before = s.capture();
    const edits = [
      (c: any) => c.state.searches[0].frontier.reverse(),
      (c: any) => (c.state.cursor = 32),
      (c: any) => (c.state.searches[0].status = "found"),
      (c: any) => (c.state.counters.expansions = 0),
      (c: any) => c.state.searches[0].distance.push(0),
      (c: any) => (c.state.extra = 0),
    ];
    for (const edit of edits) {
      const c = structuredClone(before);
      edit(c);
      expect(() => s.restore(c)).toThrow();
      expect(s.capture()).toEqual(before);
    }
    let invoked = false;
    const c = structuredClone(before);
    Object.defineProperty(c.state.searches[0].frontier, "0", {
      enumerable: true,
      get() {
        invoked = true;
        return 1;
      },
    });
    expect(() => s.restore(c)).toThrow();
    expect(invoked).toBe(false);
    expect(s.capture()).toEqual(before);
    for (const op of [
      () => s.step(0),
      () => s.step(257),
      () => s.cancel(99),
      () => s.setTerrain({ ...grid(), revision: 2 }),
    ]) {
      expect(op).toThrow();
      expect(s.capture()).toEqual(before);
    }
  });
  it("retains future decisions with saturating diagnostic totals, and rejects clock/ID exhaustion before mutation", () => {
    const s = new Service(grid());
    const c = s.capture();
    c.state.counters = {
      expansions: Number.MAX_SAFE_INTEGER,
      neighborChecks: Number.MAX_SAFE_INTEGER,
      completed: Number.MAX_SAFE_INTEGER,
    };
    s.restore(c);
    s.request({ algorithm: "astar", start: 0, goal: 0 });
    s.step(1);
    expect(s.observe().searches[0].status).toBe("found");
    expect(s.observe().counters.completed).toBe(Number.MAX_SAFE_INTEGER);
    const cap = s.capture();
    cap.state.tick = Number.MAX_SAFE_INTEGER;
    cap.state.nextId = Number.MAX_SAFE_INTEGER;
    s.restore(cap);
    expect(() => s.step()).toThrow();
    expect(() =>
      s.request({ algorithm: "astar", start: 0, goal: 0 }),
    ).toThrow();
    expect(s.capture()).toEqual(cap);
  });
});

describe("N0 maximum frontier envelope", () => {
  it("restores 32 almost-exhausted 64x64 BFS searches without a lifetime journal", () => {
    const source = new Service(grid(64));
    source.request({ algorithm: "bfs", start: 0, goal: 4095 });
    for (let i = 0; i < 15; i++) source.step(256);
    source.step(255);
    const maximum = source.capture(),
      search = maximum.state.searches[0];
    expect(search.expansions).toBe(4095);
    expect(search.status).toBe("searching");
    // The same per-search state after 4095 complete round-robin passes over32 slots.
    maximum.state.searches = Array.from({ length: 32 }, (_, i) => ({
      ...structuredClone(search),
      id: i + 1,
    }));
    maximum.state.nextId = 33;
    maximum.state.tick = 512;
    maximum.state.cursor = 0;
    maximum.state.counters = {
      expansions: 4095 * 32,
      neighborChecks: 4095 * 32 * 4,
      completed: 0,
    };
    const restored = new Service(grid(64));
    restored.restore(maximum);
    expect(restored.capture()).toEqual(maximum);
    expect(JSON.stringify(maximum).length).toBeLessThan(8 * 1024 * 1024);
    const end = restored.step(32);
    expect(
      end.searches.every(
        (s) => s.status === "found" && s.completedTick === 513,
      ),
    ).toBe(true);
    expect(end.counters.expansions).toBe(4096 * 32);
  }, 20000);
});

it("restores an actual mixed 32-search workload with independent frontiers and completed slots", () => {
  const source = new Service(grid(64));
  for (let i = 0; i < 32; i++)
    source.request({
      algorithm: i % 2 ? "astar" : "bfs",
      start: i,
      goal: i % 3 === 0 ? i + 64 : 4095 - i,
    });
  for (let i = 0; i < 48; i++) source.step(128);
  const saved = source.capture();
  expect(saved.state.searches).toHaveLength(32);
  expect(new Set(saved.state.searches.map((search) => search.status))).toEqual(
    new Set(["found", "searching"]),
  );
  expect(
    new Set(
      saved.state.searches.map((search) => JSON.stringify(search.frontier)),
    ).size,
  ).toBeGreaterThan(16);
  const restored = new Service(grid(64));
  restored.restore(saved);
  expect(restored.capture()).toEqual(saved);
  for (let i = 0; i < 8; i++)
    expect(restored.step(128)).toEqual(source.step(128));
}, 20000);
