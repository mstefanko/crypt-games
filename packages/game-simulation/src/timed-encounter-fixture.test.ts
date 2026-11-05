import { describe, expect, it } from "vitest";
import {
  TimedEncounterFixture,
  TIMED_FIXTURE_LIMITS,
} from "./timed-encounter-fixture";
import type {
  TimedFixtureCheckpoint,
  TimedFixtureCommand,
  TimedFixtureOperation,
} from "./timed-encounter-fixture";
import {
  GAMEPLAY_HZ,
  TIME_POLICIES,
  TIMED_ENCOUNTER_PHASES,
  parseRulesCue,
  rulesCueId,
} from "./time-policy";

const config = {
  runId: "encounter-proof",
  runEpoch: 7,
  seeds: { encounter: 0, loot: 0 },
};
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function command(
  fixture: TimedEncounterFixture,
  fields: Record<string, unknown>,
) {
  return fixture.command({
    revision: fixture.observe().revision,
    runEpoch: config.runEpoch,
    ...fields,
  } as TimedFixtureCommand);
}
function order(
  fixture: TimedEncounterFixture,
  action: "scout" | "claim" | "retreat",
) {
  return command(fixture, { kind: "order", action });
}
function steps(fixture: TimedEncounterFixture, count: number) {
  for (let i = 0; i < count; i++) fixture.step();
}
function operation(
  fixture: TimedEncounterFixture,
  operation: TimedFixtureOperation,
) {
  if (operation.kind === "step") fixture.step();
  else fixture.command(operation.command);
}

describe("M8a bounded integer time, phases and queued orders", () => {
  it("separates 60 Hz ticks, accepted-command revision, logical run epoch and explicit calendar time", () => {
    expect(GAMEPLAY_HZ).toBe(60);
    const fixture = new TimedEncounterFixture(config);
    const initial = fixture.capture();
    for (let i = 0; i < 20; i++) fixture.observe();
    expect(fixture.capture()).toEqual(initial);
    expect(command(fixture, { kind: "advance-day" })).toMatchObject({
      tick: 0,
      revision: 1,
      calendarDay: 1,
    });
    const stepped = fixture.step();
    expect(stepped.state).toMatchObject({
      tick: 1,
      revision: 1,
      calendarDay: 1,
    });
    expect(stepped.phases).toEqual(TIMED_ENCOUNTER_PHASES);
    expect(stepped.state.counters).toMatchObject({
      ticks: 1,
      phases: 7,
      committed: 0,
      randomDraws: 0,
    });
    expect(fixture.capture().configuration.runEpoch).toBe(7);
    expect(Object.keys(TIME_POLICIES)).toEqual([
      "platform",
      "arena",
      "duel",
      "m2",
      "grid",
      "adventure",
    ]);
    for (const policy of Object.values(TIME_POLICIES))
      expect(Object.isFrozen(policy)).toBe(true);
    expect(TIME_POLICIES.grid.clock).toContain("no-idle-ticks");
    expect(TIME_POLICIES.adventure.clock).toContain("no-idle-ticks");
  });

  it("queues bounded validated tactical orders without drawing and commits one FIFO order at each delayed boundary", () => {
    const fixture = new TimedEncounterFixture(config);
    command(fixture, { kind: "tactical-pause" });
    const initialRandom = fixture.observe().loot.random;
    order(fixture, "scout");
    order(fixture, "claim");
    order(fixture, "scout");
    order(fixture, "retreat");
    const queued = fixture.capture();
    expect(queued.state.queue.map((entry) => entry.id)).toEqual([1, 2, 3, 4]);
    expect(queued.state.loot.random).toEqual(initialRandom);
    expect(() => order(fixture, "scout")).toThrow(/queue cap/);
    expect(() => command(fixture, { kind: "device", held: true })).toThrow(
      /Tactical/,
    );
    expect(fixture.step()).toMatchObject({ phases: [], emitted: [] });
    expect(fixture.capture()).toEqual(queued);
    command(fixture, { kind: "resume" });
    expect(fixture.observe().pending).toBeNull();
    expect(fixture.step().state.pending).toEqual({
      order: { id: 1, action: "scout" },
      dueTick: 3,
    });
    expect(fixture.observe().loot.random).toEqual(initialRandom);
    expect(fixture.step().emitted).toEqual([]);
    const committed = fixture.step();
    expect(committed.emitted).toEqual([
      {
        runId: config.runId,
        runEpoch: 7,
        sequence: 1,
        tick: 3,
        kind: "encounter",
      },
    ]);
    expect(committed.state.loot.encounter).toEqual({ id: 1, kind: "bandit" });
    expect(
      committed.state.loot.random.streams.map((stream) => stream.draws),
    ).toEqual([1, 0]);
    expect(committed.state.queue).toHaveLength(3);
    steps(fixture, 9);
    expect(fixture.observe()).toMatchObject({
      tick: 12,
      queue: [],
      pending: null,
      terrainRevision: 1,
      loot: { revision: 4, coins: 4, health: 21, encounter: null },
      counters: {
        ticks: 12,
        phases: 84,
        scheduled: 4,
        committed: 4,
        randomDraws: 3,
        frozenActorTicks: 2,
      },
    });
  });

  it("validates an order against pending outcomes and the entire FIFO projection before accepting it", () => {
    const fixture = new TimedEncounterFixture(config);
    const initial = fixture.capture();
    expect(() => order(fixture, "claim")).toThrow(/No active/);
    expect(fixture.capture()).toEqual(initial);
    order(fixture, "scout");
    let before = fixture.capture();
    expect(() => order(fixture, "scout")).toThrow(/Resolve/);
    expect(fixture.capture()).toEqual(before);
    fixture.step();
    before = fixture.capture();
    expect(() => order(fixture, "scout")).toThrow(/Resolve/);
    expect(fixture.capture()).toEqual(before);
    order(fixture, "claim");
    expect(fixture.observe().queue).toEqual([{ id: 2, action: "claim" }]);
    expect(
      fixture.observe().loot.random.streams.map((stream) => stream.draws),
    ).toEqual([0, 0]);
    steps(fixture, 5);
    expect(fixture.observe().loot.coins).toBe(4);
  });

  it("safety pause cancels held device motion, blocks intake/advance and preserves semantic queue and pending timers", () => {
    const fixture = new TimedEncounterFixture(config);
    order(fixture, "scout");
    order(fixture, "claim");
    command(fixture, { kind: "device", held: true });
    steps(fixture, 2);
    expect(fixture.observe()).toMatchObject({
      tick: 2,
      position: 2,
      pending: { dueTick: 3 },
    });
    command(fixture, { kind: "safety-pause" });
    const paused = fixture.capture();
    expect(paused.state).toMatchObject({
      mode: "safety",
      resumeMode: "running",
      held: false,
    });
    for (const fields of [
      { kind: "order", action: "scout" },
      { kind: "device", held: true },
      { kind: "advance-day" },
      { kind: "tactical-pause" },
      { kind: "safety-pause" },
    ]) {
      expect(() => command(fixture, fields)).toThrow();
      expect(fixture.capture()).toEqual(paused);
    }
    steps(fixture, 10);
    expect(fixture.capture()).toEqual(paused);
    command(fixture, { kind: "resume" });
    const resumed = fixture.step();
    expect(resumed.state).toMatchObject({
      tick: 3,
      position: 2,
      held: false,
      loot: { encounter: { id: 1 } },
    });
    expect(resumed.emitted).toHaveLength(1);
    steps(fixture, 3);
    expect(fixture.observe().loot.coins).toBe(4);
  });

  it("restores tactical pause after safety resume without silently executing queued orders", () => {
    const fixture = new TimedEncounterFixture(config);
    command(fixture, { kind: "tactical-pause" });
    order(fixture, "scout");
    command(fixture, { kind: "safety-pause" });
    command(fixture, { kind: "resume" });
    expect(fixture.observe().mode).toBe("tactical");
    const before = fixture.capture();
    fixture.step();
    expect(fixture.capture()).toEqual(before);
    command(fixture, { kind: "resume" });
    steps(fixture, 3);
    expect(fixture.observe().loot.encounter).not.toBeNull();
  });

  it("keeps global fuse/delayed ticks advancing through participant hit-stop and changes terrain only at reward commit", () => {
    const fixture = new TimedEncounterFixture(config);
    order(fixture, "scout");
    order(fixture, "claim");
    order(fixture, "scout");
    order(fixture, "retreat");
    command(fixture, { kind: "device", held: true });
    steps(fixture, 5);
    expect(fixture.observe()).toMatchObject({
      tick: 5,
      position: 5,
      terrainRevision: 0,
      pending: { dueTick: 6 },
    });
    fixture.step();
    expect(fixture.observe()).toMatchObject({
      tick: 6,
      position: 6,
      hitStopTicks: 2,
      terrainRevision: 1,
    });
    fixture.step();
    expect(fixture.observe()).toMatchObject({
      tick: 7,
      position: 6,
      hitStopTicks: 1,
      pending: { dueTick: 9 },
    });
    fixture.step();
    expect(fixture.observe()).toMatchObject({
      tick: 8,
      position: 6,
      hitStopTicks: 0,
      pending: { dueTick: 9 },
    });
    expect(fixture.step().state).toMatchObject({
      tick: 9,
      position: 7,
      pending: null,
      counters: { frozenActorTicks: 2, committed: 3 },
    });
  });

  it("restores mid-queue, pending, pause and before/after RNG/commit at every boundary with exact continuation", () => {
    const fixture = new TimedEncounterFixture(config);
    const checkpoints: TimedFixtureCheckpoint[] = [fixture.capture()];
    function record(fields: Record<string, unknown>) {
      command(fixture, fields);
      checkpoints.push(fixture.capture());
    }
    record({ kind: "tactical-pause" });
    for (const action of ["scout", "claim", "scout", "retreat"])
      record({ kind: "order", action });
    record({ kind: "safety-pause" });
    record({ kind: "resume" });
    record({ kind: "advance-day" });
    record({ kind: "resume" });
    record({ kind: "device", held: true });
    for (let i = 0; i < 12; i++) {
      fixture.step();
      checkpoints.push(fixture.capture());
    }
    const final = fixture.capture();
    for (const checkpoint of checkpoints) {
      const restored = new TimedEncounterFixture(config);
      restored.restore(clone(checkpoint));
      expect(restored.capture()).toEqual(checkpoint);
      for (const remaining of final.operations.slice(
        checkpoint.operations.length,
      ))
        operation(restored, remaining);
      expect(JSON.stringify(restored.capture())).toBe(JSON.stringify(final));
      expect(restored.observe().cues.map(rulesCueId)).toEqual(
        final.state.cues.map(rulesCueId),
      );
    }
  });

  it("rejects malformed, stale, wrong-run and out-of-phase commands before any state/log mutation", () => {
    const fixture = new TimedEncounterFixture(config);
    const before = fixture.capture();
    for (const value of [
      null,
      {},
      { revision: 0, runEpoch: 7, kind: "unknown" },
      { revision: 1, runEpoch: 7, kind: "order", action: "scout" },
      { revision: 0, runEpoch: 6, kind: "order", action: "scout" },
      { revision: NaN, runEpoch: 7, kind: "advance-day" },
      { revision: 0, runEpoch: 7, kind: "device", held: 1 },
      { revision: 0, runEpoch: 7, kind: "resume" },
      { revision: 0, runEpoch: 7, kind: "advance-day", wallTime: 1000 },
    ]) {
      expect(() => fixture.command(value as TimedFixtureCommand)).toThrow();
      expect(fixture.capture()).toEqual(before);
    }
    const accepted: TimedFixtureCommand = {
      revision: 0,
      runEpoch: 7,
      kind: "order",
      action: "scout",
    };
    fixture.command(accepted);
    const after = fixture.capture();
    expect(() => fixture.command(accepted)).toThrow(/Stale/);
    expect(fixture.capture()).toEqual(after);
  });

  it("rejects malformed or semantically inconsistent saved clocks, orders, due ticks, RNG, counters, cues and logs atomically", () => {
    const fixture = new TimedEncounterFixture(config);
    order(fixture, "scout");
    order(fixture, "claim");
    steps(fixture, 4);
    const before = fixture.capture();
    const bad: unknown[] = [
      null,
      [],
      { ...before, extra: 1 },
      { ...before, format: "other" },
      { ...before, configuration: { ...config, runEpoch: 8 } },
      {
        ...before,
        operations: new Array(TIMED_FIXTURE_LIMITS.operations + 1).fill({
          kind: "step",
        }),
      },
      {
        ...before,
        operations: [...before.operations, { kind: "step", extra: 1 }],
      },
      {
        ...before,
        operations: [
          {
            kind: "command",
            command: { revision: 0, runEpoch: 7, kind: "resume" },
          },
        ],
      },
    ];
    const patches: Record<string, unknown>[] = [
      { tick: 2 },
      { revision: 1 },
      { calendarDay: 1 },
      { mode: "safety" },
      { held: true },
      { position: 1 },
      { hitStopTicks: 2 },
      { nextOrderId: 100 },
      { terrainRevision: 1 },
      { pending: { order: { id: 2, action: "claim" }, dueTick: 7 } },
      { pending: { order: { id: 99, action: "claim" }, dueTick: 6 } },
      { queue: [{ id: 3, action: "scout" }] },
      { cues: [] },
      { counters: { ...before.state.counters, randomDraws: 0 } },
    ];
    for (const patch of patches)
      bad.push({ ...before, state: { ...before.state, ...patch } });
    const missingDraw = clone(before) as unknown as {
      state: { loot: { random: { streams: { state: number }[] } } };
    };
    missingDraw.state.loot.random.streams[0].state = 0;
    bad.push(missingDraw);
    for (const value of bad) {
      expect(() => fixture.restore(value)).toThrow();
      expect(fixture.capture()).toEqual(before);
    }
    const cycle: Record<string, unknown> = {};
    cycle.loop = cycle;
    expect(() => fixture.restore(cycle)).toThrow(/cap/);
    expect(fixture.capture()).toEqual(before);
  });

  it("uses exact tick/command/operation ceilings and refuses orders that cannot finish within the remaining tick budget", () => {
    const fixture = new TimedEncounterFixture(config);
    for (let i = 0; i < TIMED_FIXTURE_LIMITS.commands; i++)
      command(fixture, { kind: "device", held: i % 2 === 0 });
    steps(fixture, TIMED_FIXTURE_LIMITS.ticks);
    const full = fixture.capture();
    expect(full.operations).toHaveLength(
      TIMED_FIXTURE_LIMITS.commands + TIMED_FIXTURE_LIMITS.ticks,
    );
    expect(() => command(fixture, { kind: "advance-day" })).toThrow(/cap/);
    expect(() => fixture.step()).toThrow(/cap/);
    expect(fixture.capture()).toEqual(full);
    const restored = new TimedEncounterFixture(config);
    restored.restore(full);
    expect(restored.capture()).toEqual(full);
    const late = new TimedEncounterFixture(config);
    steps(late, 117);
    order(late, "scout");
    let before = late.capture();
    expect(() => order(late, "claim")).toThrow(/budget/);
    expect(late.capture()).toEqual(before);
    steps(late, 3);
    expect(late.observe().loot.encounter).not.toBeNull();
    before = late.capture();
    expect(() => order(late, "claim")).toThrow(/budget/);
    expect(late.capture()).toEqual(before);
  });

  it("resumes after 63 days and safety pause, then continues ticking", () => {
    const fixture = new TimedEncounterFixture(config);
    for (let i = 0; i < 63; i++) command(fixture, { kind: "advance-day" });
    command(fixture, { kind: "safety-pause" });
    command(fixture, { kind: "resume" });
    expect(fixture.step().state).toMatchObject({
      mode: "running",
      tick: 1,
      revision: 65,
    });
    const restored = new TimedEncounterFixture(config);
    restored.restore(fixture.capture());
    expect(restored.step()).toEqual(fixture.step());
  });

  it.each([false, true])(
    "resumes at the command/history ceiling, including nested tactical pause (%s)",
    (tactical) => {
      const fixture = new TimedEncounterFixture(config);
      steps(fixture, TIMED_FIXTURE_LIMITS.ticks);
      if (tactical) command(fixture, { kind: "tactical-pause" });
      while (fixture.observe().revision < TIMED_FIXTURE_LIMITS.commands - 1)
        command(fixture, { kind: "advance-day" });
      command(fixture, { kind: "safety-pause" });
      const paused = fixture.capture();
      command(fixture, { kind: "resume" });
      if (tactical) command(fixture, { kind: "resume" });
      expect(fixture.observe().mode).toBe("running");
      const resumed = fixture.capture();
      expect(resumed.operations.length).toBeLessThanOrEqual(
        TIMED_FIXTURE_LIMITS.operations,
      );
      expect(() => command(fixture, { kind: "advance-day" })).toThrow(/cap/);
      expect(fixture.capture()).toEqual(resumed);
      const restored = new TimedEncounterFixture(config);
      restored.restore(paused);
      for (const entry of resumed.operations.slice(paused.operations.length))
        operation(restored, entry);
      expect(restored.capture()).toEqual(resumed);
      restored.restore(resumed);
      expect(restored.capture()).toEqual(resumed);
    },
  );

  it("rejects projected reward capacity without consuming RNG or a queue ID/revision", () => {
    const fixture = new TimedEncounterFixture({
      ...config,
      seeds: { encounter: 0, loot: 1 },
    });
    for (let round = 0; round < 6; round++) {
      order(fixture, "scout");
      order(fixture, "claim");
      steps(fixture, 6);
    }
    expect(fixture.observe().loot.coins).toBe(20);
    order(fixture, "scout");
    const before = fixture.capture();
    expect(() => order(fixture, "claim")).toThrow(/capacity/);
    expect(fixture.capture()).toEqual(before);
    order(fixture, "retreat");
    steps(fixture, 6);
    expect(fixture.observe()).toMatchObject({
      pending: null,
      queue: [],
      loot: { coins: 20, encounter: null },
    });
  });

  it("keeps cue identity stable across render epochs and validates the complete bounded cue header", () => {
    const cue = {
      runId: config.runId,
      runEpoch: 7,
      sequence: 1,
      tick: 3,
      kind: "encounter" as const,
    };
    expect(rulesCueId(cue)).toBe("encounter-proof:7:1");
    expect(rulesCueId({ ...cue, tick: 9 })).toBe(rulesCueId(cue));
    expect(rulesCueId({ ...cue, runEpoch: 8 })).not.toBe(rulesCueId(cue));
    expect(parseRulesCue(cue)).toEqual(cue);
    expect(parseRulesCue(cue)).not.toBe(cue);
    for (const patch of [
      { runId: "bad id" },
      { runEpoch: -1 },
      { sequence: 0 },
      { tick: NaN },
      { kind: "unknown" },
      { extra: 1 },
    ])
      expect(() => parseRulesCue({ ...cue, ...patch })).toThrow();
  });
});
