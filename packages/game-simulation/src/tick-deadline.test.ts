import { checkedIncrement } from "./counters";
import { describe, it, expect } from "vitest";
import {
  armDeadline,
  cancelDeadline,
  deadlineReady,
  remainingTicks,
  secondsToTicks,
} from "@onepage/game-simulation/tick-deadline";
import { DefenseSession } from "./defense-session";
import { bowDefinitions } from "../../../apps/audio-arcade/src/games/bow/content";
import { CombatRunSession, type CombatRunConfig } from "./combat-run-session";
import { cinderDefinitions } from "../../../apps/audio-arcade/src/games/cinder/content";
import combatGolden from "../../../tests/engine/fixtures/combat-fixed-stream.json";
import defenseGolden from "../../../tests/engine/fixtures/defense-fixed-stream.json";
const config: CombatRunConfig = {
  seed: 17,
  contentId: "f1-combat",
  floor: 224,
  roomWidth: 960,
  rooms: [{ id: 0, name: "combat", definitions: cinderDefinitions(17, 1) }],
};
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
describe("tick deadline contract", () => {
  it("converts every authored centisecond through 60 seconds without floating overshoot", () => {
    for (let cents = 1; cents <= 6000; cents++) {
      // Rational integer oracle avoids repeating the floating implementation.
      expect(secondsToTicks(cents / 100, 60), `centiseconds=${cents}`).toBe(
        Math.ceil((cents * 3) / 5),
      );
    }
    expect(secondsToTicks(4.15, 60)).toBe(249);
    expect(secondsToTicks(1 / 60 + 1e-12, 60)).toBe(2);
    expect(secondsToTicks(1 / 60 - 1e-12, 60)).toBe(1);
    expect(secondsToTicks(Number.MIN_VALUE, 60)).toBe(1);
    expect(secondsToTicks(2 ** 50 + 0.25, 1)).toBe(2 ** 50 + 1);
    expect(secondsToTicks(2 ** 40 + 0.25, 1)).toBe(2 ** 40 + 1);
    expect(() => secondsToTicks(Number.MAX_SAFE_INTEGER, 2)).toThrow();
  });
  it("increments counters independently of scheduling and rejects overflow", () => {
    expect(checkedIncrement(0)).toBe(1);
    expect(checkedIncrement(Number.MAX_SAFE_INTEGER - 1)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    for (const value of [
      -1,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(() => checkedIncrement(value)).toThrow();
  });

  it("inclusive expiry, cancellation and ceiling conversion", () => {
    const d = armDeadline(10, 3);
    expect([12, 13, 14].map((t) => deadlineReady(t, d))).toEqual([
      false,
      true,
      true,
    ]);
    expect(remainingTicks(12, d)).toBe(1);
    expect(deadlineReady(4, armDeadline(4, 0))).toBe(true);
    expect(deadlineReady(20, cancelDeadline())).toBe(false);
    expect(remainingTicks(20, null)).toBe(0);
    expect(secondsToTicks(0.021, 60)).toBe(2);
  });
  it("rejects invalid ticks, rates and arithmetic overflow", () => {
    for (const n of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() => armDeadline(n, 1)).toThrow();
    expect(() => armDeadline(Number.MAX_SAFE_INTEGER, 1)).toThrow();
    for (const [s, r] of [
      [-1, 60],
      [1, 0],
      [1, 1.5],
      [Infinity, 60],
      [Number.MAX_VALUE, 60],
    ])
      expect(() => secondsToTicks(s!, r!)).toThrow();
  });
});
describe("Defense fixed clock and intermission", () => {
  it("continues fractional spawn and enemy attack timers under split host steps", () => {
    const definitions = {
      ...bowDefinitions,
      intermission: 0,
      spawnX: bowDefinitions.contactX,
      budgets: [100],
      activeCap: 1,
      waveDuration: 0.55,
      spawnGap: 0.55,
      waveKinds: [[0]],
      enemyKinds: bowDefinitions.enemyKinds.map((kind) => ({
        ...kind,
        damage: 1,
        attackCadence: 0.55,
      })),
    };
    const owner = new DefenseSession(definitions, 17);
    for (let i = 0; i < 5; i++) owner.step(1 / 60);
    const saved = clone(owner.snapshot());
    expect(saved.spawn).toBeGreaterThan(0);
    expect(saved.enemies[0]!.attack).toBeGreaterThan(0);
    const resumed = new DefenseSession(definitions, 17);
    resumed.restore(saved);
    for (let i = 0; i < 120; i++) {
      owner.step(1 / 60);
      resumed.step(1 / 120);
      resumed.step(1 / 120);
      expect(resumed.snapshot()).toEqual(owner.snapshot());
      expect(resumed.drainEvents()).toEqual(owner.drainEvents());
    }
  });

  it("matches legacy subtraction spawn and attack expiry before, at and after boundaries", () => {
    for (const duration of [0, 1 / 60, 0.55, 1, 4.15]) {
      const definitions = {
        ...bowDefinitions,
        intermission: 0,
        budgets: [1000],
        activeCap: 100,
        spawnGap: duration,
        waveDuration: 0,
        waveKinds: [[0]],
        buildings: bowDefinitions.buildings.map((b) => ({
          ...b,
          hp: 100000,
          maxHp: 100000,
        })),
        enemyKinds: bowDefinitions.enemyKinds.map((kind) => ({
          ...kind,
          speed: 0.001,
          attackCadence: duration,
          damage: 1,
        })),
      };
      const spawns = new DefenseSession(definitions, 17);
      spawns.step(1 / 60); // prepare transitions; spawning starts next tick
      let spawn = 0,
        count = 0;
      for (let i = 0; i < 520; i++) {
        spawn -= 1 / 60;
        if (spawn <= 0 && count < 100) {
          count++;
          spawn = duration;
        }
        spawns.step(1 / 60);
        expect(
          spawns.observe().enemies.length,
          `spawn ${duration} tick ${i}`,
        ).toBe(count);
      }
      const attacks = new DefenseSession(
        {
          ...definitions,
          activeCap: 1,
          spawnX: definitions.contactX,
        },
        17,
      );
      attacks.step(1 / 60);
      attacks.step(1 / 60); // first spawn attacks in its creation tick
      const legacy: any = clone(attacks.snapshot());
      legacy.version = 2;
      delete legacy.spawnDeadline;
      delete legacy.attackTimers;
      legacy.spawn = duration;
      legacy.enemies[0].attack = duration;
      attacks.restore(legacy);
      let remaining = duration,
        hits = 0;
      const hp = () =>
        attacks.observe().buildings.reduce((n, b) => n + b.hp, 0);
      const initialHp = hp();
      for (let i = 0; i < 270; i++) {
        remaining -= 1 / 60;
        if (remaining <= 0) {
          hits++;
          remaining = duration;
        }
        attacks.step(1 / 60);
        expect(hp(), `attack ${duration} tick ${i}`).toBe(initialHp - hits);
      }
    }
  });

  it("pauses contact clocks during lane retargeting and validates deadline continuation atomically", () => {
    const owner = new DefenseSession(
      {
        ...bowDefinitions,
        intermission: 0,
        budgets: [100],
        activeCap: 1,
        spawnX: bowDefinitions.contactX,
        spawnGap: 100,
        waveKinds: [[0]],
      },
      17,
    );
    owner.step(1 / 60);
    owner.step(1 / 60);
    const saved = clone(owner.snapshot());
    const enemy = saved.enemies[0]!;
    saved.health[enemy.lane]!.hp = 0;
    owner.restore(saved);
    owner.step(0);
    expect(owner.snapshot()).toEqual(saved);
    owner.step(0.05);
    expect(owner.snapshot().attackTimers[0]!.clock).toBe(
      saved.attackTimers[0]!.clock,
    );
    const before = clone(owner.snapshot());
    for (const mutate of [
      (v: any) => v.attackTimers.pop(),
      (v: any) => (v.attackTimers[0].clock = -1),
      (v: any) => (v.attackTimers[0].clock = v.tick + 1),
      (v: any) => (v.attackTimers[0].deadline = Number.MAX_SAFE_INTEGER),
      (v: any) => (v.attackTimers[0].deadline = 0.5),
      (v: any) => (v.attackTimers[0].id = "enemy-missing"),
      (v: any) => (v.spawnDeadline = -1),
      (v: any) => (v.spawn = 999),
      (v: any) => (v.enemies[0].attack = 999),
      (v: any) => {
        v.version = 2;
        v.spawn = 3601;
      },
      (v: any) => {
        v.version = 2;
        v.tick = Number.MAX_SAFE_INTEGER;
        v.timer = 0;
        v.spawn = 1;
      },
    ]) {
      const broken = clone(before);
      mutate(broken);
      expect(() => owner.restore(broken)).toThrow();
      expect(clone(owner.snapshot())).toEqual(before);
    }
  });

  it("retains zero authored-budget rejection and accepts depleted legacy wave continuation", () => {
    expect(
      () => new DefenseSession({ ...bowDefinitions, budgets: [0] }, 17),
    ).toThrow("Invalid defense definitions");
    const owner = new DefenseSession(
      { ...bowDefinitions, intermission: 0, budgets: [1, 1] },
      17,
    );
    owner.step(1 / 60);
    const legacy: any = clone(owner.snapshot());
    legacy.version = 2;
    delete legacy.spawnDeadline;
    delete legacy.attackTimers;
    legacy.budget = 0;
    legacy.enemies = [];
    owner.restore(legacy);
    const resumed = new DefenseSession(
      { ...bowDefinitions, intermission: 0, budgets: [1, 1] },
      17,
    );
    resumed.restore(clone(owner.snapshot()));
    owner.step(1 / 60);
    resumed.step(1 / 60);
    expect(owner.observe()).toMatchObject({
      wave: 1,
      budget: 1,
      phase: "prepare",
    });
    expect(resumed.snapshot()).toEqual(owner.snapshot());
  });

  it("reports restart-required diagnostics for malformed timer records before dereferencing them", () => {
    const owner = new DefenseSession(
      { ...bowDefinitions, intermission: 0 },
      17,
    );
    owner.step(1 / 60);
    owner.step(1 / 60);
    const before = clone(owner.snapshot());
    for (const malformed of [null, 1, "timer", [], true]) {
      const broken: any = clone(before);
      broken.attackTimers[0] = malformed;
      expect(() => owner.restore(broken)).toThrow(
        "Invalid defense checkpoint; restart required",
      );
      expect(clone(owner.snapshot())).toEqual(before);
    }
    const broken: any = clone(before);
    broken.enemies = null;
    expect(() => owner.restore(broken)).toThrow(
      "Invalid defense checkpoint; restart required",
    );
    expect(clone(owner.snapshot())).toEqual(before);
  });

  it("zero intermission waits for a tick and exhausted ticks reject before mutation", () => {
    const owner = new DefenseSession(
      { ...bowDefinitions, intermission: 0 },
      17,
    );
    owner.step(0);
    expect(owner.observe().phase).toBe("prepare");
    owner.step(1 / 60);
    expect(owner.observe().phase).toBe("defense");
    const exhausted = owner.snapshot();
    exhausted.tick = Number.MAX_SAFE_INTEGER;
    exhausted.timer = 0;
    owner.restore(exhausted);
    const before = owner.snapshot();
    expect(() => owner.step(1 / 60)).toThrow();
    expect(owner.snapshot()).toEqual(before);
  });

  it("preserves characterized production gameplay and ordered events for 1500 ticks", () => {
    const now = new DefenseSession(bowDefinitions, 17);
    let first = 0;
    const trace: unknown[] = [];
    for (let i = 0; i < 1500; i++) {
      if (i === 3) now.command({ type: "upgrade" });
      if (i > 500 && i % 29 === 0) now.command({ type: "fire" });
      now.step(1 / 60);
      const b = now.observe();
      if (!first && b.phase === "defense") first = i + 1;
      if ([0, 479, 480, 899, 1499].includes(i)) {
        const { droppedEvents, ...characterized } = b;
        trace.push({ ...characterized, timer: 0 });
      }
      now.drainEvents();
    }
    expect(first).toBe(481);
    expect(trace).toEqual(defenseGolden);
  });
  it("preserves remainder, pending events and split schedules; rejects malformed restore atomically", () => {
    const a = new DefenseSession(bowDefinitions, 17);
    a.command({ type: "upgrade" });
    a.step(1 / 120);
    expect(a.observe().tick).toBe(0);
    const checkpoint = clone(a.snapshot());
    const b = new DefenseSession(bowDefinitions, 17);
    b.restore(checkpoint);
    a.step(1 / 120);
    b.step(1 / 120);
    expect(b.snapshot()).toEqual(a.snapshot());
    expect(b.drainEvents()).toEqual(a.drainEvents());
    for (let i = 0; i < 500; i++) {
      a.step(1 / 60);
      b.step(1 / 120);
      b.step(1 / 120);
    }
    expect(b.snapshot()).toEqual(a.snapshot());
    const before = b.snapshot();
    for (const mutate of [
      (v: any) => (v.bank = NaN),
      (v: any) => (v.intermissionDeadline = -1),
      (v: any) => (v.serial = 0),
      (v: any) => (v.health[0].hp = -1),
      (v: any) => (v.rng.streams = []),
      (v: any) =>
        (v.events = [
          { sequence: 999, tick: 0, kind: "win", sourceId: "defense" },
        ]),
    ]) {
      const v = structuredClone(before);
      mutate(v);
      expect(() => b.restore(v)).toThrow();
      expect(b.snapshot()).toEqual(before);
    }
    b.step(0);
    expect(b.snapshot()).toEqual(before);
  });
});
describe("CombatRun authoritative cooldown continuation", () => {
  it("preserves the 1000-tick production combat characterization including freezes", () => {
    const owner = new CombatRunSession(config);
    const trace: unknown[] = [];
    for (let i = 0; i < 1000; i++) {
      if (i === 0)
        owner.command({
          type: "input",
          right: true,
          actions: ["swap", "attack"],
        });
      if (i % 29 === 0)
        owner.command({ type: "input", right: i < 350, actions: ["attack"] });
      if (i % 113 === 0) owner.command({ type: "input", actions: ["roll"] });
      owner.step(1 / 60);
      owner.drainEvents();
      if ([0, 33, 34, 100, 350, 999].includes(i)) {
        const o = owner.observe();
        for (const a of o.world.actors) {
          if (a.combatState) {
            delete a.combatState.cooldownTick;
            delete a.combatState.cooldownDeadlines;
          }
        }
        trace.push({
          tick: o.world.tick,
          actors: o.world.actors,
          bolts: o.bolts,
          minds: o.minds,
          lost: o.lost,
          embers: o.embers,
        });
      }
    }
    expect(trace).toEqual(combatGolden);
  });
  it("retains the arming tick, decrements next actor update and pauses during freeze", () => {
    const owner = new CombatRunSession(config);
    owner.command({ type: "input", actions: ["swap", "attack"] });
    owner.step(1 / 60);
    const first = owner.snapshot();
    const state = first.current.worldState!.actors[0]!.combatState!;
    expect(state.cooldowns!.caster).toBe(34);
    expect(state.cooldownDeadlines!.caster! - state.cooldownTick!).toBe(34);
    // A supported full checkpoint fixture pins the actor freeze policy.
    first.current.worldState!.actors[0]!.freezeTicks = 2;
    first.current.actors[0]!.freezeTicks = 2;
    owner.restore(clone(first));
    owner.step(1 / 60);
    owner.step(1 / 60);
    expect(
      owner.observe().world.actors[0]!.combatState!.cooldowns!.caster,
    ).toBe(34);
    owner.step(1 / 60);
    expect(
      owner.observe().world.actors[0]!.combatState!.cooldowns!.caster,
    ).toBe(33);
    for (let i = 0; i < 33; i++) owner.step(1 / 60);
    expect(
      owner.observe().world.actors[0]!.combatState!.cooldowns!.caster,
    ).toBe(0);
  });

  it("continues a JSON checkpoint with pending events, input and armed cooldown", () => {
    const a = new CombatRunSession(config);
    a.command({ type: "input", actions: ["swap", "attack"] });
    a.step(1 / 60);
    a.step(1 / 120);
    expect(
      a.observe().world.actors[0]!.combatState!.cooldownDeadlines?.caster,
    ).toBeDefined();
    const checkpoint = clone(a.snapshot());
    const b = new CombatRunSession(config);
    b.restore(checkpoint);
    expect(b.snapshot()).toEqual(checkpoint);
    expect(b.drainEvents()).toEqual(a.drainEvents());
    for (let i = 0; i < 80; i++) {
      if (i % 20 === 0) {
        a.command({ type: "input", actions: ["attack"] });
        b.command({ type: "input", actions: ["attack"] });
      }
      a.step(1 / 60);
      b.step(1 / 60);
      expect(b.snapshot()).toEqual(a.snapshot());
      expect(b.drainEvents()).toEqual(a.drainEvents());
    }
  });
  it("rejects malformed checkpoints without mutation", () => {
    const a = new CombatRunSession(config);
    a.command({ type: "input", actions: ["attack"] });
    a.step(1 / 60);
    const before = a.snapshot();
    for (const mutate of [
      (v: any) => (v.bank = -1),
      (v: any) => (v.current.worldState.index = {}),
      (v: any) => (v.current.worldState.motionResults = "bad"),
      (v: any) => (v.current.worldState.actors[0].health = NaN),
      (v: any) => (v.current.worldState.nextEntityId = 0),
      (v: any) => (v.current.worldState.identity.contentId = "other"),
      (v: any) => (v.current.bolts = [{}]),
      (v: any) => (v.events[0].sequence = 999),
    ]) {
      const v = structuredClone(before);
      mutate(v);
      expect(() => a.restore(v)).toThrow();
      expect(a.snapshot()).toEqual(before);
    }
  });
});

describe("bounded owner event retention", () => {
  it("Defense evicts oldest events and restores overflow continuation", () => {
    const owner = new DefenseSession(bowDefinitions, 17);
    const checkpoint = owner.snapshot();
    checkpoint.eventSequence = 512;
    checkpoint.events = Array.from({ length: 512 }, (_, i) => ({
      sequence: i + 1,
      tick: 0,
      sourceId: "defense",
      kind: "delivery" as const,
    }));
    owner.restore(clone(checkpoint));
    owner.command({ type: "upgrade" });
    owner.step(1 / 60);
    const overflow = owner.snapshot();
    expect(overflow.events).toHaveLength(512);
    expect(overflow.events[0]!.sequence).toBe(2);
    expect(overflow.events[511]!.sequence).toBe(513);
    expect(overflow.droppedEvents).toBe(1);
    expect(owner.observe().droppedEvents).toBe(1);
    const resumed = new DefenseSession(bowDefinitions, 17);
    resumed.restore(clone(overflow));
    expect(resumed.drainEvents()).toEqual(owner.drainEvents());
    expect(resumed.snapshot()).toEqual(owner.snapshot());
    owner.step(1 / 60);
    resumed.step(1 / 60);
    expect(resumed.snapshot()).toEqual(owner.snapshot());
    for (const value of [-1, NaN, 514]) {
      const invalid = structuredClone(overflow);
      invalid.droppedEvents = value;
      const before = resumed.snapshot();
      expect(() => resumed.restore(invalid)).toThrow();
      expect(resumed.snapshot()).toEqual(before);
    }
    const oversized = structuredClone(overflow);
    oversized.events.push(overflow.events[511]!);
    expect(() => resumed.restore(oversized)).toThrow();
  });
  it("CombatRun evicts oldest events and retains counters through drain/retry/restore", () => {
    const owner = new CombatRunSession(config);
    const checkpoint = owner.snapshot();
    checkpoint.sequence = 512;
    checkpoint.events = Array.from({ length: 512 }, (_, i) => ({
      sequence: i + 1,
      tick: 0,
      sourceId: "heart",
      kind: "swap",
      payload: { pan: 0 },
    }));
    owner.restore(clone(checkpoint));
    owner.command({ type: "input", actions: ["swap"] });
    owner.step(1 / 60);
    const overflow = owner.snapshot();
    expect(overflow.events).toHaveLength(512);
    expect(overflow.events[0]!.sequence).toBe(2);
    expect(overflow.events[511]!.sequence).toBe(513);
    expect(overflow.droppedEvents).toBe(1);
    expect(owner.observe().droppedEvents).toBe(1);
    const resumed = new CombatRunSession(config);
    resumed.restore(clone(overflow));
    expect(resumed.drainEvents()).toEqual(owner.drainEvents());
    owner.step(1 / 60);
    resumed.step(1 / 60);
    expect(resumed.snapshot()).toEqual(owner.snapshot());
    for (const value of [-1, NaN, 514]) {
      const invalid = structuredClone(overflow);
      invalid.droppedEvents = value;
      const before = resumed.snapshot();
      expect(() => resumed.restore(invalid)).toThrow();
      expect(resumed.snapshot()).toEqual(before);
    }
    const oversized = structuredClone(overflow);
    oversized.events.push(overflow.events[511]!);
    expect(() => resumed.restore(oversized)).toThrow();
    owner.command({ type: "retry" });
    expect(owner.snapshot().droppedEvents).toBe(1);
    expect(owner.drainEvents()).toEqual([]);
  });
});
