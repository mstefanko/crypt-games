import { describe, it, expect, vi } from "vitest";
import { RtsTacticalSimulation as Rts, createRtsGrid } from "./rts";
import { SustainedNavigationScheduler } from "./navigation-service";
function resume(s: Rts) {
  s.command({ kind: "pause", paused: false });
}
describe("bounded RTS tactical consumer", () => {
  it("throws when a live unit references a missing navigation request", () => {
    const owner = new Rts();
    owner.applyCommand({ kind: "move", unitIds: [1], destination: 0 });
    owner.applyCommand({ kind: "pause", paused: false });
    owner.advance();
    const state = owner as any;
    const unit = state.state.units.find((unit: any) => unit.id === 1);
    expect(unit.requestId).not.toBeNull();
    state.navigation.cancel(unit.requestId);
    state.navigation.release(unit.requestId);
    expect(() => owner.advance()).toThrow("RTS navigation request missing");
  });
  it("advances, accepts commands and presents pending work without copying full navigation arrays", () => {
    const s = new Rts();
    const observe = vi.spyOn(SustainedNavigationScheduler.prototype, "observe");
    const fullRts = vi.spyOn(s, "observe");
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      s.applyCommand({ kind: "move", unitIds: [1, 2], destination: 0 });
      s.applyCommand({ kind: "train", producerId: 1 });
      s.applyCommand({ kind: "pause", paused: false });
      let pendingSearches = 0;
      for (let i = 0; i < 4; i++) {
        s.advance();
        const compact = s.observePresentation();
        pendingSearches = Math.max(
          pendingSearches,
          compact.navigation.pendingSearches,
        );
        expect(
          compact.navigation.searches.every(
            (search) => Object.keys(search).join(",") === "id,status",
          ),
        ).toBe(true);
      }
      expect(pendingSearches).toBeGreaterThan(0);
      expect(observe).not.toHaveBeenCalled();
      expect(fullRts).not.toHaveBeenCalled();
      // JSON copying remains bounded to RTS state and command validation, never search work.
      expect(
        stringify.mock.calls.some(
          ([value]) =>
            value &&
            typeof value === "object" &&
            ("searches" in value || "frontier" in value),
        ),
      ).toBe(false);
    } finally {
      observe.mockRestore();
      fullRts.mockRestore();
      stringify.mockRestore();
    }
  });
  it("detaches compact state and terrain, tracks revisions and agrees with full observations after pending restore", () => {
    const s = new Rts();
    s.applyCommand({ kind: "move", unitIds: [1, 2], destination: 0 });
    s.applyCommand({ kind: "pause", paused: false });
    s.advance();
    const before = s.capture(),
      view = s.observePresentation();
    expect(view.navigation.pendingSearches).toBeGreaterThan(0);
    view.grid.costs[0] = 0;
    view.units[0].order = { kind: "idle" };
    // Deliberately bypass readonly typing to verify runtime detachment.
    (view.units[16].behavior as { timer: number }).timer = 999;
    view.economy.nodes[0].remaining = 0;
    view.counters.moves = 999;
    view.navigation.counters.expansions = 999;
    view.navigation.searches[0].status = "cancelled";
    expect(s.capture()).toEqual(before);
    const restored = new Rts();
    restored.restore(before);
    for (let tick = 0; tick < 12; tick++) {
      s.advance();
      restored.advance();
      const full = s.observe(),
        compact = s.observePresentation();
      const { grid, navigation, ...state } = full;
      expect(compact).toEqual({
        ...state,
        grid,
        navigation: {
          tick: navigation.tick,
          terrainRevision: grid.revision,
          activeSearches: navigation.searches.length,
          pendingSearches: navigation.searches.filter(
            (search) =>
              search.status === "queued" || search.status === "searching",
          ).length,
          searches: navigation.searches.map(({ id, status }) => ({
            id,
            status,
          })),
          counters: navigation.counters,
        },
      });
      expect(restored.observePresentation()).toEqual(compact);
      expect(restored.capture()).toEqual(s.capture());
    }
    const oldView = s.observePresentation(),
      terrain = createRtsGrid();
    terrain.revision = 1;
    terrain.costs[0] = 0;
    s.setTerrain(terrain);
    terrain.costs[1] = 0;
    const next = s.observePresentation();
    expect(next.grid.revision).toBe(1);
    expect(next.grid.costs[0]).toBe(0);
    expect(next.grid.costs[1]).toBe(1);
    expect(next.navigation.terrainRevision).toBe(1);
    expect(next.navigation.activeSearches).toBe(0);
    expect(oldView.grid.revision).toBe(0);
    expect(oldView.grid.costs[0]).toBe(1);
    expect(next.grid).toEqual(s.observe().grid);
  });
  it("keeps full command return values and paused command queues detached", () => {
    const s = new Rts(),
      direct = new Rts();
    const command = { kind: "move" as const, unitIds: [2, 1], destination: 0 };
    const full = s.command(command);
    direct.applyCommand(command);
    expect(full).toEqual(direct.observe());
    const before = s.capture(),
      compact = s.observePresentation();
    compact.pendingCommands[0].unitIds[0] = 16;
    full.pendingCommands[0].unitIds[0] = 15;
    full.navigation.grid.costs[0] = 0;
    expect(s.capture()).toEqual(before);
  });
  it("queues deterministic selected orders during tactical pause and always allows resume with a full queue", () => {
    const s = new Rts();
    const initial = s.capture();
    expect(s.step()).toEqual(s.observe());
    expect(s.capture()).toEqual(initial);
    for (let i = 0; i < 8; i++)
      s.command({
        kind: "move",
        unitIds: [2, 1],
        destination: 30 * 64 + 29 + i,
      });
    const before = s.capture();
    expect(() => s.command({ kind: "stop", unitIds: [1] })).toThrow(
      /paused queue cap/,
    );
    expect(s.capture()).toEqual(before);
    const r = new Rts();
    r.restore(before);
    expect(r.capture()).toEqual(before);
    resume(s);
    resume(r);
    expect(s.observe().pendingCommands).toEqual([]);
    expect(s.observe().units[0].order).toEqual({
      kind: "move",
      destination: 30 * 64 + 36,
    });
    expect(r.step()).toEqual(s.step());
    expect(s.observe().tick).toBe(1);
  });
  it("continues exact pending frontiers, crowd movement, B0 windups, combat and target deaths", () => {
    const s = new Rts();
    s.command({
      kind: "attack",
      unitIds: Array.from({ length: 16 }, (_, i) => i + 1),
      targetId: 17,
    });
    resume(s);
    const states = new Set<string>();
    let saves = 0;
    for (let tick = 0; tick < 160; tick++) {
      s.step();
      const current = s.observe();
      for (const u of current.units)
        if (u.behavior) states.add(u.behavior.state);
      const cells = current.units.filter((u) => u.health).map((u) => u.cell);
      expect(new Set(cells).size).toBe(cells.length);
      expect(current.navigation.searches.length).toBeLessThanOrEqual(32);
      if (tick % 13 === 0) {
        const r = new Rts();
        r.restore(s.capture());
        expect(r.capture()).toEqual(s.capture());
        expect(r.step()).toEqual(s.step());
        saves++;
      }
    }
    expect(saves).toBe(13);
    expect(states.has("windup")).toBe(true);
    expect(states.has("recover")).toBe(true);
    expect(s.observe().counters.moves).toBeGreaterThan(0);
    expect(s.observe().counters.attacks).toBeGreaterThan(0);
    expect(s.observe().counters.deaths).toBeGreaterThan(0);
    const r = new Rts();
    r.restore(s.capture());
    for (let i = 0; i < 20; i++) expect(r.step()).toEqual(s.step());
  }, 20000);
  it("invalid commands reject without mutation, pause freezes authoritative timers and stop cancels a live route", () => {
    const s = new Rts();
    resume(s);
    s.command({ kind: "move", unitIds: [1], destination: 0 });
    s.step();
    const before = s.capture();
    const invalid: unknown[] = [
      { kind: "move", unitIds: [1, 1], destination: 0 },
      { kind: "move", unitIds: [17], destination: 0 },
      { kind: "move", unitIds: [1], destination: 32 },
      { kind: "attack", unitIds: [1], targetId: 1 },
      { kind: "stop", unitIds: [] },
      { kind: "pause", paused: 1 },
      { kind: "stop", unitIds: [1], extra: 0 },
    ];
    for (const c of invalid) {
      expect(() => s.command(c as any)).toThrow();
      expect(s.capture()).toEqual(before);
    }
    s.command({ kind: "stop", unitIds: [1] });
    expect(
      s
        .observe()
        .navigation.searches.some(
          (search) => search.id === before.state.units[0].requestId,
        ),
    ).toBe(false);
    expect(s.observe().units[0].requestId).toBeNull();
    expect(s.observe().units[0].order.kind).toBe("idle");
    s.command({ kind: "pause", paused: true });
    const paused = s.capture();
    for (let i = 0; i < 10; i++) s.step();
    expect(s.capture()).toEqual(paused);
  });
  it("revision changes cancel all stale ownership and occupied-cell edits reject atomically", () => {
    const s = new Rts();
    resume(s);
    s.command({ kind: "move", unitIds: [1], destination: 0 });
    s.step();
    const before = s.capture(),
      g = createRtsGrid();
    g.revision = 1;
    g.costs[s.observe().units[0].cell] = 0;
    expect(() => s.setTerrain(g)).toThrow();
    expect(s.capture()).toEqual(before);
    const resized = {
      width: 63,
      height: 64,
      revision: 1,
      costs: Array(63 * 64).fill(1),
    };
    expect(() => s.setTerrain(resized)).toThrow(/dimensions/);
    expect(s.capture()).toEqual(before);
    const badGrid = new Rts().capture();
    badGrid.navigation.state.grid = { ...resized, revision: 0 };
    expect(() => s.restore(badGrid)).toThrow(/dimensions/);
    expect(s.capture()).toEqual(before);
    const next = createRtsGrid();
    next.revision = 1;
    next.costs[0] = 0;
    s.setTerrain(next);
    expect(s.observe().units.every((u) => u.requestId === null)).toBe(true);
    expect(s.observe().navigation.searches).toEqual([]);
    const r = new Rts();
    r.restore(s.capture());
    for (let i = 0; i < 4; i++) expect(r.step()).toEqual(s.step());
  });
  it("rejects inconsistent unit/path ownership, B0 timers, health, clock and hidden hooks atomically", () => {
    const s = new Rts();
    resume(s);
    s.command({ kind: "move", unitIds: [1], destination: 0 });
    s.step();
    const before = s.capture();
    const edits = [
      (c: any) => (c.state.units[0].health = 13),
      (c: any) => (c.state.units[1].cell = c.state.units[0].cell),
      (c: any) => (c.state.units[0].requestId = 999),
      (c: any) => (c.state.units[16].behavior.timer = 999),
      (c: any) => (c.state.units[0].routeCursor = 3),
      (c: any) => c.state.tick++,
      (c: any) => c.navigation.state.searches[0].frontier.reverse(),
    ];
    for (const edit of edits) {
      const c = structuredClone(before);
      edit(c);
      expect(() => s.restore(c)).toThrow();
      expect(s.capture()).toEqual(before);
    }
    let invoked = false;
    const c = structuredClone(before);
    Object.defineProperty(c.state.units[0], "health", {
      enumerable: true,
      get() {
        invoked = true;
        return 12;
      },
    });
    expect(() => s.restore(c)).toThrow();
    expect(invoked).toBe(false);
    expect(s.capture()).toEqual(before);
  });
  it("captures detached snapshots, canonicalizes selection ordering, and uses deterministic replay commands", () => {
    const a = new Rts(),
      b = new Rts();
    a.command({ kind: "move", unitIds: [3, 1, 2], destination: 28 * 64 + 31 });
    b.command({ kind: "move", unitIds: [1, 2, 3], destination: 28 * 64 + 31 });
    expect(a.capture()).toEqual(b.capture());
    resume(a);
    resume(b);
    for (let i = 0; i < 20; i++) expect(a.step()).toEqual(b.step());
    const detached = a.capture();
    detached.state.units[0].health = 0;
    detached.navigation.state.grid.costs[0] = 0;
    expect(a.capture()).toEqual(b.capture());
  });
});

describe("RTS continuation boundary cases", () => {
  it("preserves a paused accepted destination that a later terrain edit blocks", () => {
    const s = new Rts();
    s.command({ kind: "move", unitIds: [1], destination: 0 });
    const g = createRtsGrid();
    g.revision = 1;
    g.costs[0] = 0;
    s.setTerrain(g);
    const restored = new Rts();
    restored.restore(s.capture());
    expect(restored.capture()).toEqual(s.capture());
    resume(s);
    resume(restored);
    for (let i = 0; i < 4; i++) expect(restored.step()).toEqual(s.step());
  });
  it("rejects clock and request identity exhaustion before any world mutation", () => {
    for (const identity of [true, false]) {
      const s = new Rts();
      resume(s);
      const cap = s.capture();
      if (identity) cap.navigation.state.nextId = Number.MAX_SAFE_INTEGER;
      else {
        cap.state.tick = Number.MAX_SAFE_INTEGER;
        cap.navigation.state.tick = Number.MAX_SAFE_INTEGER;
      }
      s.restore(cap);
      const before = s.capture();
      expect(() => s.step()).toThrow(/cap/);
      expect(s.capture()).toEqual(before);
    }
  });
});

describe("RTS committed B0 target intent", () => {
  it("discards an expiring windup against a dead target before retargeting on the following tick", () => {
    const s = new Rts(),
      saved = s.capture();
    saved.state.units[0].health = 0;
    saved.state.counters.deaths = 1;
    const opponent = saved.state.units[16];
    opponent.targetId = 1;
    opponent.behavior = {
      role: "bruiser",
      state: "windup",
      timer: 1,
      position: 0,
      attacks: 0,
      transitions: 1,
    };
    s.restore(saved);
    resume(s);
    s.step();
    expect(s.observe().units[16].targetId).toBe(1);
    expect(s.observe().units[16].behavior!.state).toBe("recover");
    expect(
      s
        .observe()
        .units.slice(1, 16)
        .map((u) => u.health),
    ).toEqual(Array(15).fill(12));
    expect(s.observe().counters.attacks).toBe(0);
    s.step();
    expect(s.observe().units[16].targetId).not.toBe(1);
  });
});

describe("RTS reviewed regressions", () => {
  it("separates paused queue capacity from running tick acceptance", () => {
    const s = new Rts();
    resume(s);
    s.command({ kind: "stop", unitIds: [1] });
    s.command({ kind: "pause", paused: true });
    for (let i = 0; i < 8; i++) s.command({ kind: "stop", unitIds: [1] });
    expect(() => s.command({ kind: "stop", unitIds: [1] })).toThrow(
      /paused queue cap/,
    );
    resume(s);
    for (let i = 0; i < 7; i++) s.command({ kind: "stop", unitIds: [1] });
    expect(() => s.command({ kind: "stop", unitIds: [1] })).toThrow(
      /command rate cap/,
    );
    s.step();
    s.command({ kind: "stop", unitIds: [1] });
  });
  it("finishes own-cell moves and reports crowded orders as blocked instead of retrying forever", () => {
    const s = new Rts();
    const cap = s.capture();
    for (const u of cap.state.units.slice(16)) u.health = 0;
    cap.state.counters.deaths = 16;
    s.restore(cap);
    resume(s);
    s.command({
      kind: "move",
      unitIds: [1],
      destination: cap.state.units[0].cell,
    });
    s.step();
    expect(s.observe().units[0].moveStatus).toBe("arrived");
    expect(s.observe().units[0].order.kind).toBe("idle");
    s.command({
      kind: "move",
      unitIds: Array.from({ length: 16 }, (_, i) => i + 1),
      destination: 32 * 64 + 32,
    });
    for (let i = 0; i < 180; i++) s.step();
    expect(
      s
        .observe()
        .units.slice(0, 16)
        .every((u) => u.order.kind === "idle"),
    ).toBe(true);
    expect(s.observe().units.some((u) => u.moveStatus === "blocked")).toBe(
      true,
    );
    expect(s.observe().navigation.searches).toEqual([]);
    const restored = new Rts();
    restored.restore(s.capture());
    expect(restored.capture()).toEqual(s.capture());
  });
  it("honors collision backoff as a chased target changes cells", () => {
    const s = new Rts(),
      cap = s.capture();
    for (const u of cap.state.units)
      if (![1, 2, 17].includes(u.id)) u.health = 0;
    cap.state.counters.deaths = 29;
    cap.state.units[0].cell = 0;
    cap.state.units[1].cell = 1;
    cap.state.units[16].cell = 10;
    cap.navigation.state.grid.costs[64] = 0; // Only exit is occupied by unit 2.
    s.restore(cap);
    s.command({ kind: "attack", unitIds: [1], targetId: 17 });
    resume(s);
    for (let i = 0; i < 3; i++) s.step();
    const deadline = s.observe().units[0].retryAt;
    expect(deadline).toBe(s.observe().tick + 8);
    const targetCells = new Set<number>();
    for (let i = 0; i < 7; i++) {
      const state = s.step();
      targetCells.add(state.units[16].cell);
      expect(state.units[0].retryAt).toBe(deadline);
      expect(state.units[0].requestId).toBeNull();
    }
    expect(targetCells.size).toBeGreaterThan(1);
    s.step();
    expect(s.observe().units[0].requestId).not.toBeNull();
  });
  it("keeps a real pending frontier alive while its target retreats", () => {
    const s = new Rts(),
      cap = s.capture();
    cap.state.units[0].cell = 0;
    cap.state.units[16].health = 3;
    s.restore(cap);
    s.command({ kind: "attack", unitIds: [1], targetId: 17 });
    resume(s);
    s.step();
    const request = s.observe().units[0].requestId;
    expect(request).not.toBeNull();
    let pendingTicks = 0;
    const cells = new Set<number>();
    for (let i = 0; i < 8; i++) {
      const before = s.observe();
      const pending = before.navigation.searches.find(
        (search) => search.id === request,
      );
      const after = s.step();
      cells.add(after.units[16].cell);
      if (pending?.status === "searching" || pending?.status === "queued") {
        pendingTicks++;
        expect(after.units[0].requestId).toBe(request);
      }
    }
    expect(pendingTicks).toBeGreaterThan(1);
    expect(cells.size).toBeGreaterThan(1);
  });
  it("rejects forged backoff, inconsistent goals and unsorted queued selections atomically", () => {
    const s = new Rts();
    s.command({ kind: "stop", unitIds: [1, 2] });
    const before = s.capture();
    for (const change of [
      (c: any) => (c.state.units[0].retryAt = 99999),
      (c: any) => (c.state.units[0].goal = 10),
      (c: any) => c.state.pendingCommands[0].unitIds.reverse(),
    ]) {
      const bad = structuredClone(before);
      change(bad);
      expect(() => s.restore(bad)).toThrow();
      expect(s.capture()).toEqual(before);
    }
  });
  it("continues opponent timers when every player is dead", () => {
    const s = new Rts(),
      cap = s.capture();
    for (const u of cap.state.units.slice(0, 16)) u.health = 0;
    cap.state.counters.deaths = 16;
    cap.state.units[16].behavior = {
      ...cap.state.units[16].behavior!,
      state: "recover",
      timer: 2,
    };
    s.restore(cap);
    resume(s);
    s.step();
    expect(s.observe().units[16].behavior!.timer).toBe(1);
    s.step();
    expect(s.observe().units[16].behavior!.state).toBe("approach");
  });
  it("releases a dying unit's search and clears player attacks after target death", () => {
    const s = new Rts(),
      cap = s.capture();
    cap.state.units[0].cell = 0;
    cap.state.units[16].cell = 1;
    cap.state.units[16].health = 2;
    s.restore(cap);
    resume(s);
    s.step(); // Enemy owns a search toward a different player or is in windup.
    const enemyRequest = s.observe().units[16].requestId;
    expect(enemyRequest).not.toBeNull();
    const adjacent = s.capture();
    adjacent.state.units[0].cell = 3;
    s.restore(adjacent);
    s.command({ kind: "attack", unitIds: [1, 2], targetId: 17 });
    s.step();
    expect(s.observe().units[16].health).toBe(0);
    expect(s.observe().units[16].requestId).toBeNull();
    expect(
      s
        .observe()
        .navigation.searches.some((search) => search.id === enemyRequest),
    ).toBe(false);
    expect(s.observe().units[1].order.kind).toBe("idle");
    s.step();
    expect(s.observe().units[0].order.kind).toBe("idle");
  });
});
