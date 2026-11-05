import { describe, expect, it } from "vitest";
import {
  LootEncounterFixture,
  LOOT_FIXTURE_LIMITS,
  replayLootFixture,
} from "./loot-encounter-fixture";
import type {
  LootFixtureCheckpoint,
  LootFixtureCommand,
} from "./loot-encounter-fixture";
import { DeterministicRandom } from "./rng";

const seeds = { encounter: 0, loot: 0 };
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function run(
  fixture: LootEncounterFixture,
  kind: LootFixtureCommand["kind"],
): LootFixtureCheckpoint {
  return fixture.execute({ revision: fixture.capture().revision, kind });
}

describe("M8a bounded headless loot/encounter consumer", () => {
  it("selects encounters, commits damage/rewards and replays the accepted commands exactly", () => {
    const fixture = new LootEncounterFixture(seeds);
    const encounters: string[] = [];
    for (let round = 0; round < 8; round++) {
      const active = run(fixture, "scout");
      encounters.push(active.encounter!.kind);
      expect(active.encounter!.id).toBe(round + 1);
      run(fixture, "claim");
    }
    const final = fixture.capture();
    expect(encounters).toEqual([
      "bandit",
      "wisp",
      "slime",
      "slime",
      "wisp",
      "wisp",
      "bandit",
      "slime",
    ]);
    expect(final).toMatchObject({
      revision: 16,
      rounds: 8,
      coins: 19,
      health: 9,
      encounter: null,
    });
    expect(
      final.random.streams.map((stream) => [
        stream.name,
        stream.owner,
        stream.draws,
      ]),
    ).toEqual([
      ["encounter", "fixture.encounter", 8],
      ["loot", "fixture.loot", 8],
    ]);
    expect(replayLootFixture(seeds, final.commands)).toEqual(final);
    const before = fixture.capture();
    expect(() => run(fixture, "scout")).toThrow(/cap/);
    expect(fixture.capture()).toEqual(before);
  });

  it("restores every before/after-draw boundary and continues with identical exact bytes", () => {
    const fixture = new LootEncounterFixture(seeds);
    const checkpoints = [fixture.capture()];
    for (let round = 0; round < 8; round++) {
      checkpoints.push(run(fixture, "scout"));
      checkpoints.push(run(fixture, "claim"));
    }
    const final = fixture.capture();
    for (const checkpoint of checkpoints) {
      const restored = new LootEncounterFixture(seeds);
      restored.restore(JSON.parse(JSON.stringify(checkpoint)));
      expect(restored.capture()).toEqual(checkpoint);
      for (const entry of final.commands.slice(checkpoint.revision))
        restored.execute(entry);
      expect(JSON.stringify(restored.capture())).toBe(JSON.stringify(final));
    }
  });

  it("keeps gameplay unchanged across zero, irregular and heavy render/cosmetic schedules", () => {
    function rendered(
      schedule: readonly number[],
      cosmeticSeed: number,
    ): LootFixtureCheckpoint {
      const fixture = new LootEncounterFixture(seeds);
      const cosmetic = new DeterministicRandom([
        { name: "particles", owner: "presentation", seed: cosmeticSeed },
      ]);
      const paint = (commandIndex: number) => {
        for (let i = 0; i < schedule[commandIndex % schedule.length]; i++) {
          cosmetic.drawInteger("presentation", "particles", 360);
          // Repeated observation copies cannot advance either rules stream.
          fixture.capture();
        }
      };
      for (let round = 0; round < 8; round++) {
        paint(round * 2);
        run(fixture, "scout");
        paint(round * 2 + 1);
        run(fixture, "claim");
      }
      return fixture.capture();
    }
    const headless = rendered([0], 0);
    expect(rendered([1], 1)).toEqual(headless);
    expect(rendered([0, 7, 1, 25, 0], 0xffffffff)).toEqual(headless);
    expect(rendered([100], 12345)).toEqual(headless);
  });

  it("rolls back random draws, rewards, damage and history when capacity rejects a claim", () => {
    const fixture = new LootEncounterFixture({ encounter: 0, loot: 1 });
    for (let round = 0; round < 6; round++) {
      run(fixture, "scout");
      run(fixture, "claim");
    }
    expect(fixture.capture().coins).toBe(20);
    run(fixture, "scout");
    const before = fixture.capture();
    expect(() => run(fixture, "claim")).toThrow(/capacity/);
    expect(() => run(fixture, "claim")).toThrow(/capacity/);
    expect(fixture.capture()).toEqual(before);
    const resumed = new LootEncounterFixture({ encounter: 0, loot: 1 });
    resumed.restore(before);
    expect(() => run(resumed, "claim")).toThrow(/capacity/);
    expect(resumed.capture()).toEqual(before);
    // Retreat remains legal; it commits no loot draw and does not duplicate the
    // rejected command's revision. Final round is still bounded and playable.
    expect(run(fixture, "retreat").random.streams[1].draws).toBe(6);
    run(fixture, "scout");
    const complete = run(fixture, "retreat");
    expect(complete).toMatchObject({ coins: 20, revision: 16, rounds: 8 });
    expect(
      replayLootFixture({ encounter: 0, loot: 1 }, complete.commands),
    ).toEqual(complete);
  });

  it("rejects stale, invalid and out-of-phase commands atomically, including duplicate claims", () => {
    const fixture = new LootEncounterFixture(seeds);
    for (const value of [
      { revision: 0, kind: "claim" },
      { revision: 0, kind: "retreat" },
      { revision: 1, kind: "scout" },
      { revision: 0, kind: "unknown" },
      { revision: 0, kind: "scout", extra: true },
    ]) {
      const before = fixture.capture();
      expect(() => fixture.execute(value as LootFixtureCommand)).toThrow();
      expect(fixture.capture()).toEqual(before);
    }
    run(fixture, "scout");
    const active = fixture.capture();
    expect(() => run(fixture, "scout")).toThrow(/Resolve/);
    expect(fixture.capture()).toEqual(active);
    const claim: LootFixtureCommand = { revision: 1, kind: "claim" };
    fixture.execute(claim);
    const after = fixture.capture();
    expect(() => fixture.execute(claim)).toThrow(/Stale/);
    expect(() => run(fixture, "claim")).toThrow(/No active/);
    expect(fixture.capture()).toEqual(after);
  });

  it("validates complete restore structure, stream compatibility and semantic history before mutation", () => {
    const fixture = new LootEncounterFixture(seeds);
    run(fixture, "scout");
    run(fixture, "claim");
    run(fixture, "scout");
    const before = fixture.capture();
    const malformed: unknown[] = [
      null,
      [],
      { ...before, extra: 0 },
      { ...before, format: "other" },
      { ...before, seeds: { encounter: 1, loot: 0 } },
      { ...before, coins: 19 },
      { ...before, health: 0 },
      { ...before, rounds: 7 },
      { ...before, revision: 4 },
      { ...before, encounter: null },
      { ...before, encounter: { id: 2, kind: "slime" } },
      { ...before, commands: before.commands.slice(1) },
      {
        ...before,
        commands: Array.from(
          { length: LOOT_FIXTURE_LIMITS.commands + 1 },
          () => before.commands[0],
        ),
      },
      { ...before, commands: [{ revision: 0, kind: "claim" }] },
    ];
    for (const patch of [
      { owner: "presentation" },
      { name: "cosmetic" },
      { seed: 1 },
      { state: 0 },
      { draws: 0 },
    ]) {
      const changed = clone(before) as unknown as {
        random: { streams: Record<string, unknown>[] };
      };
      Object.assign(changed.random.streams[1], patch);
      malformed.push(changed);
    }
    // A separately valid RNG snapshot is still invalid when it omits the
    // authoritative loot draw implied by the accepted command history.
    const missingDraw = clone(before);
    const initial = new LootEncounterFixture(seeds).capture();
    (missingDraw.random.streams as unknown as unknown[])[1] =
      initial.random.streams[1];
    malformed.push(missingDraw);
    for (const value of malformed) {
      expect(() => fixture.restore(value)).toThrow();
      expect(fixture.capture()).toEqual(before);
    }
  });

  it("detaches checkpoint data and enforces the independent encounter/loot stream ownership", () => {
    const fixture = new LootEncounterFixture(seeds);
    const before = fixture.capture();
    run(fixture, "scout");
    run(fixture, "retreat");
    expect(fixture.capture().random.streams[1]).toEqual(
      before.random.streams[1],
    );
    const detached = fixture.capture() as unknown as {
      commands: { kind: string }[];
      seeds: { encounter: number };
    };
    detached.commands[0].kind = "claim";
    detached.seeds.encounter = 1;
    expect(fixture.capture().commands[0].kind).toBe("scout");
    expect(fixture.capture().seeds).toEqual(seeds);
    expect(() => replayLootFixture(seeds, new Array(17))).toThrow(/cap/);
  });
});
