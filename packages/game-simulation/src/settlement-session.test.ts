import { describe, expect, it } from "vitest";
import { SettlementSession } from "./settlement-session";
import { winterContent } from "../../../apps/audio-arcade/src/games/winter/content";

function staff(session: SettlementSession) {
  for (const building of session.state.buildings.filter((b) =>
    ["gatherer", "logging"].includes(b.type),
  )) {
    session.command(`select:${building.id}`);
    session.command("staff:1");
  }
}
function advance(session: SettlementSession, ticks: number) {
  for (let i = 0; i < ticks; i++) session.step(0.1);
}

describe("SettlementSession authority", () => {
  it("detaches nested observations, definitions and checkpoints", () => {
    const definition = structuredClone(winterContent);
    const session = new SettlementSession(definition, 17);
    staff(session);
    advance(session, 30);
    const before = session.snapshot();
    definition.buildings[0].cost.logs = 999;
    definition.terrain[0] = 1;
    const observed = session.state as any;
    observed.people[0].cargo.food = 999;
    observed.people[0].queue.length = 0;
    observed.buildings[0].inventory.food = 999;
    observed.terrain[0] = 1;
    observed.chunkRevisions[0] = 999;
    const observedDefinition = session.definition as any;
    observedDefinition.buildings[0].cost.logs = 999;
    observedDefinition.buildings[2].recipe.output.food = 999;
    const checkpoint = session.snapshot() as any;
    checkpoint.people[0].health = 0;
    checkpoint.reservations.length = 0;
    expect(session.snapshot()).toEqual(before);
    expect(session.definition).toEqual(winterContent);
    expect((session as any).navigation?.setCell).toBeUndefined();
    expect((session as any).navigation?.request).toBeUndefined();
  });

  it("rejects malformed nested state atomically and can still continue", () => {
    const session = new SettlementSession(winterContent, 17);
    staff(session);
    advance(session, 30);
    const before = session.snapshot();
    const corruptions = [
      (s: any) => {
        delete s.chunkRevisions[0];
      },
      (s: any) => {
        delete s.terrain[0];
      },
      (s: any) => {
        delete s.people[0];
      },
      (s: any) => {
        delete s.buildings[0];
      },
      (s: any) => {
        delete s.checkpoint.navigation.cells[0];
      },
      (s: any) => {
        delete s.checkpoint.navigation.costs[0];
      },
      (s: any) => {
        s.time = NaN;
      },
      (s: any) => {
        s.accumulator = Infinity;
      },
      (s: any) => {
        s.sequence = -1;
      },
      (s: any) => {
        s.terrain.pop();
      },
      (s: any) => {
        s.chunkRevisions[0] = -1;
      },
      (s: any) => {
        s.people[0].x = Infinity;
      },
      (s: any) => {
        s.people[0].house = "missing";
      },
      (s: any) => {
        s.people[0].queue = [{ kind: "move", target: -1 }];
      },
      (s: any) => {
        s.people[0].queue = [
          {
            kind: "pickup",
            endpoint: "missing",
            resource: "food",
            amount: 1,
            token: -1,
          },
        ];
      },
      (s: any) => {
        s.buildings[0].type = "missing";
      },
      (s: any) => {
        s.buildings[0].inventory.food = -1;
      },
      (s: any) => {
        s.buildings[1].id = s.buildings[0].id;
      },
      (s: any) => {
        s.nextId = 1;
      },
      (s: any) => {
        s.checkpoint.seed++;
      },
      (s: any) => {
        s.checkpoint.definition = "different";
      },
      (s: any) => {
        s.checkpoint.events = [
          {
            sequence: s.sequence + 1,
            tick: s.tick,
            sourceId: "settlement",
            kind: "delivery",
          },
        ];
      },
      (s: any) => {
        s.checkpoint.navigation.cells[0] = !s.checkpoint.navigation.cells[0];
      },
      (s: any) => {
        s.checkpoint.navigation.costs[0] = NaN;
      },
      (s: any) => {
        s.tick++;
      },
    ];
    for (const corrupt of corruptions) {
      const candidate = structuredClone(before);
      corrupt(candidate);
      expect(() => session.restore(candidate)).toThrow();
      expect(session.snapshot()).toEqual(before);
    }
    const resumed = new SettlementSession(winterContent, 17);
    resumed.restore(before);
    advance(session, 100);
    advance(resumed, 100);
    expect(resumed.snapshot()).toEqual(session.snapshot());
  });

  it("rejects discontinuous completed navigation paths without changing the owner", () => {
    const session = new SettlementSession(winterContent, 17);
    staff(session);
    let before = session.snapshot();
    let search = before.checkpoint.navigation.searches.find(
      (s) => s.status === "complete" && s.path.length > 3,
    );
    for (let i = 0; i < 100 && !search; i++) {
      session.step(0.1);
      before = session.snapshot();
      search = before.checkpoint.navigation.searches.find(
        (s) => s.status === "complete" && s.path.length > 3,
      );
    }
    expect(search).toBeDefined();
    const sparse = structuredClone(before);
    const sparseSearch = sparse.checkpoint.navigation.searches.find(
      (s) => s.id === search!.id,
    )!;
    delete sparseSearch.path[1];
    expect(() => session.restore(sparse)).toThrow();
    expect(session.snapshot()).toEqual(before);
    const sparseCitizen = structuredClone(before);
    const move = sparseCitizen.people
      .flatMap((p) => p.queue)
      .find((a) => a.kind === "move" && a.request === search!.id);
    expect(move?.kind).toBe("move");
    if (move?.kind === "move") {
      move.path = [search!.goal];
      delete move.path[0];
      expect(() => session.restore(sparseCitizen)).toThrow();
      expect(session.snapshot()).toEqual(before);
    }
    const candidate = structuredClone(before);
    const corrupt = candidate.checkpoint.navigation.searches.find(
      (s) => s.id === search!.id,
    )!;
    // Keep valid cell indices and endpoints while skipping the intervening route.
    corrupt.path = [corrupt.start, corrupt.goal];
    for (const citizen of candidate.people)
      for (const action of citizen.queue)
        if (action.kind === "move" && action.request === corrupt.id)
          action.path = [corrupt.goal];
    expect(() => session.restore(candidate)).toThrow();
    expect(session.snapshot()).toEqual(before);
  });

  it("accepts legacy state checkpoints and upgrades identity metadata", () => {
    const session = new SettlementSession(winterContent, 17);
    staff(session);
    advance(session, 30);
    const priorVersion = session.snapshot() as any;
    delete priorVersion.checkpoint.droppedEvents;
    const priorResumed = new SettlementSession(winterContent, 17);
    priorResumed.restore(priorVersion);
    expect(priorResumed.droppedEvents).toBe(0);
    expect(priorResumed.snapshot()).toEqual(session.snapshot());
    const legacy = session.snapshot() as any;
    delete legacy.checkpoint;
    const resumed = new SettlementSession(winterContent, 17);
    const initial = resumed.snapshot();
    const malformedLegacy = structuredClone(legacy);
    malformedLegacy.people[0].health = NaN;
    expect(() => resumed.restoreLegacy(malformedLegacy)).toThrow();
    expect(resumed.snapshot()).toEqual(initial);
    expect(() => resumed.restore(legacy)).toThrow(/identity required/);
    resumed.restoreLegacy(legacy);
    expect(resumed.snapshot().checkpoint.version).toBe(1);
    const upgraded = resumed.snapshot();
    expect(() => resumed.restoreLegacy(upgraded)).toThrow();
    resumed.restore(upgraded);
    expect(resumed.snapshot()).toEqual(upgraded);
    advance(resumed, 40);
    expect(resumed.state.tick).toBe(70);
  });

  it("rejects stripped modern identity and raised navigation limits atomically", () => {
    const session = new SettlementSession(winterContent, 17);
    const before = session.snapshot();
    for (const corrupt of [
      (s: any) => {
        delete s.checkpoint;
        delete s.snapshotFormat;
      },
      (s: any) => {
        s.checkpoint.navigation.max++;
      },
      (s: any) => {
        s.checkpoint.navigation.budget++;
      },
      (s: any) => {
        s.checkpoint.droppedEvents = -1;
      },
    ]) {
      const candidate = structuredClone(before);
      corrupt(candidate);
      expect(() => session.restore(candidate)).toThrow();
      expect(session.snapshot()).toEqual(before);
    }
    const differentSeed = new SettlementSession(winterContent, 18);
    expect(() => differentSeed.restore(before)).toThrow();
    const definition = structuredClone(winterContent);
    definition.opening += " changed";
    expect(() =>
      new SettlementSession(definition, 17).restore(before),
    ).toThrow();
  });

  it("retains the latest 64 events with advancing sequence and persisted loss", () => {
    const definition = structuredClone(winterContent);
    definition.seasonSeconds = 0.1;
    const session = new SettlementSession(definition, 17);
    const saved = session.snapshot();
    saved.sequence = 64;
    saved.checkpoint.events = Array.from({ length: 64 }, (_, i) => ({
      sequence: i + 1,
      tick: 0,
      sourceId: "settlement",
      kind: "delivery",
    }));
    session.restore(saved);
    session.step(0.1);
    expect(session.state.sequence).toBe(65);
    expect(session.droppedEvents).toBe(1);
    const resumed = new SettlementSession(definition, 17);
    resumed.restore(session.snapshot());
    expect(resumed.droppedEvents).toBe(1);
    const events = session.drainEvents();
    expect(events).toHaveLength(64);
    expect(events[0].sequence).toBe(2);
    expect(events.at(-1)).toMatchObject({ sequence: 65, kind: "discovery" });
    expect(resumed.drainEvents()).toEqual(events);
    expect(session.drainEvents()).toEqual([]);
    expect(session.droppedEvents).toBe(1);
  });

  it("continues valid movement, construction, clock, events and demolition checkpoints", () => {
    const definition = structuredClone(winterContent);
    definition.seasonSeconds = 8;
    const session = new SettlementSession(definition, 23);
    staff(session);
    session.command("build:woodcutter");
    session.place(25, 23);
    session.step(0.15);
    advance(session, 35);
    expect(session.state.people.some((p) => p.queue.length)).toBe(true);
    const saved = session.snapshot();
    const resumed = new SettlementSession(definition, 23);
    resumed.restore(saved);
    expect(resumed.snapshot()).toEqual(saved);
    (saved as any).people[0].cargo.logs = 999;
    for (let i = 0; i < 150; i++) {
      session.step(i % 2 ? 0.15 : 0.05);
      resumed.step(i % 2 ? 0.15 : 0.05);
      if (i % 15 === 0) {
        expect(resumed.snapshot()).toEqual(session.snapshot());
        resumed.restore(resumed.snapshot());
      }
    }
    const events = session.drainEvents();
    expect(events).toEqual(resumed.drainEvents());
    expect(events.some((event) => event.kind === "discovery")).toBe(true);
    (events as any)[0].kind = "corrupted";
    const selected = session.state.buildings.find(
      (b) => b.type === "logging",
    )!.id;
    for (const owner of [session, resumed]) {
      owner.command(`select:${selected}`);
      owner.command("demolish");
      owner.restore(owner.snapshot());
      advance(owner, 20);
    }
    expect(resumed.snapshot()).toEqual(session.snapshot());
  });
});
