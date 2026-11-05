import { expect, it, describe } from "vitest";
import content from "../../../examples/game-m1/definitions.json";
import { validateDefinitions } from "../../game-project/src/index";
import { boundedJSON } from "../../game-project/src/runtime";
import type {
  GameDefinitions,
  InputRecord,
  ScenarioDefinition,
} from "../../game-project/src/runtime";
import {
  createWorld,
  step,
  serializeCheckpoint,
  restoreCheckpoint,
  createInputDecoder,
  decodeInputRecords,
  neutralHeld,
  observe,
} from "./index";
import type { World } from "./types";
const identity = { rulesBuildId: "review-build", contentId: "review-content" };
const definitions = (edit?: (r: typeof content) => void): GameDefinitions => {
  const raw = JSON.parse(JSON.stringify(content)) as typeof content;
  edit?.(raw);
  return validateDefinitions(raw);
};
const fresh = () => createWorld(definitions(), identity);
function attack(w: World, slot = 0) {
  const held = neutralHeld();
  held.attack = true;
  return {
    slots: [
      {
        slot,
        held,
        axes: { moveX: 0 },
        edges: [{ action: "attack" as const, kind: "pressed" as const }],
      },
    ],
  };
}

describe("independent review counter transactions", () => {
  it.each([
    "tick",
    "ai",
    "nextEntityId",
    "nextExecutionId",
    "motionEpochCounter",
  ])(
    "round-trips safe exhausted %s and fails a live tick without mutation",
    (field) => {
      const w = fresh();
      const set = (target: World) => {
        if (field === "ai")
          target.actors[1].ai.decisionTicks = Number.MAX_SAFE_INTEGER;
        else
          (target as unknown as Record<string, unknown>)[field] =
            Number.MAX_SAFE_INTEGER;
      };
      set(w);
      if (field === "tick") w.decoder.lastTick = w.tick - 1;
      const before = serializeCheckpoint(w);
      expect(
        serializeCheckpoint(restoreCheckpoint(w.definitions, identity, before)),
      ).toBe(before);
      expect(() =>
        step(w, { slots: [], commands: [{ type: "restart" }] }),
      ).toThrow("counter exhausted");
      expect(serializeCheckpoint(w)).toBe(before);
      expect(w.actors).toHaveLength(2);
    },
  );
  it("preflights AI exhaustion before consuming input or carrying platforms, even after a valid prior tick", () => {
    const w = fresh();
    w.actors[1].ai.decisionTicks = Number.MAX_SAFE_INTEGER - 1;
    const restored = restoreCheckpoint(
      w.definitions,
      identity,
      serializeCheckpoint(w),
    );
    step(restored);
    expect(restored.actors[1].ai.decisionTicks).toBe(Number.MAX_SAFE_INTEGER);
    const before = serializeCheckpoint(restored);
    expect(
      serializeCheckpoint(restoreCheckpoint(w.definitions, identity, before)),
    ).toBe(before);
    expect(() => step(restored, attack(restored))).toThrow();
    expect(serializeCheckpoint(restored)).toBe(before);
  });
  it("reserves a whole level allocation before restart, not merely one entity ID", () => {
    const w = fresh();
    w.nextEntityId = Number.MAX_SAFE_INTEGER - 1;
    const before = serializeCheckpoint(w);
    expect(
      serializeCheckpoint(restoreCheckpoint(w.definitions, identity, before)),
    ).toBe(before);
    expect(() =>
      step(w, { slots: [], commands: [{ type: "restart" }] }),
    ).toThrow();
    expect(serializeCheckpoint(w)).toBe(before);
  });
  it("round-trips the last committed tick then refuses its next tick atomically", () => {
    const w = fresh();
    w.tick = Number.MAX_SAFE_INTEGER - 1;
    w.decoder.lastTick = w.tick - 1;
    step(w);
    expect(w.tick).toBe(Number.MAX_SAFE_INTEGER);
    const bytes = serializeCheckpoint(w),
      r = restoreCheckpoint(w.definitions, identity, bytes);
    expect(serializeCheckpoint(r)).toBe(bytes);
    expect(() => step(r)).toThrow("counter exhausted");
    expect(serializeCheckpoint(r)).toBe(bytes);
  });
  it("round-trips final entity and motion epoch allocation after a restart", () => {
    const w = fresh();
    w.nextEntityId = Number.MAX_SAFE_INTEGER - 2;
    w.motionEpochCounter = Number.MAX_SAFE_INTEGER - 1;
    step(w, { slots: [], commands: [{ type: "restart" }] });
    expect(w.nextEntityId).toBe(Number.MAX_SAFE_INTEGER);
    expect(w.motionEpochCounter).toBe(Number.MAX_SAFE_INTEGER);
    const bytes = serializeCheckpoint(w),
      r = restoreCheckpoint(w.definitions, identity, bytes);
    expect(serializeCheckpoint(r)).toBe(bytes);
    expect(() => step(r)).toThrow();
    expect(serializeCheckpoint(r)).toBe(bytes);
  });
});

describe("interrupt, intent sampling and flow ordering", () => {
  it("interrupts startup on an unguarded hit and never retaliates during stun or after freeze", () => {
    const d = definitions((raw) => {
      raw.archetypes[1].ai = "none";
      raw.levels[0].spawns[0].x = 200 * 256;
      raw.levels[0].spawns[1].x = 220 * 256;
      raw.levels[0].spawns[1].slot = 1;
    });
    const w = createWorld(d, identity);
    step(w, attack(w));
    for (let i = 0; i < 3; i++) step(w);
    const f = attack(w, 1);
    step(w, f);
    expect(w.actors[1].execution).not.toBeNull();
    let hits = 0;
    for (let i = 0; i < 30; i++)
      hits += step(w).filter((e) => e.type === "hit").length;
    expect(hits).toBe(1);
    expect(w.actors[0].health).toBe(12);
    expect(w.actors[1].health).toBe(6);
    expect(w.actors[1].execution).toBeNull();
  });
  it("keeps simultaneous gathered trades while interrupting both executions", () => {
    const d = definitions((raw) => {
      raw.archetypes[1].ai = "none";
      raw.levels[0].spawns[0].x = 200 * 256;
      raw.levels[0].spawns[1].x = 220 * 256;
      raw.levels[0].spawns[1].slot = 1;
    });
    const w = createWorld(d, identity),
      f = attack(w);
    f.slots.push(attack(w, 1).slots[0]);
    step(w, f);
    let events = [] as ReturnType<typeof step>;
    for (let i = 0; i < 6; i++) events = step(w);
    expect(events.filter((e) => e.type === "hit")).toHaveLength(2);
    expect(w.actors.map((a) => a.health)).toEqual([10, 6]);
    expect(w.actors.every((a) => a.execution === null)).toBe(true);
  });
  it("samples every AI against the same pre-movement player pose", () => {
    const d = definitions((raw) => {
      raw.levels[0].spawns[0].x = 100 * 256;
      raw.levels[0].spawns[1].x = 133 * 256;
    });
    const w = createWorld(d, identity);
    const held = neutralHeld();
    held.right = true;
    step(w, {
      slots: [
        {
          slot: 0,
          held,
          axes: { moveX: 127 },
          edges: [{ action: "right", kind: "pressed" }],
        },
      ],
    });
    // At tick start distance33 requires approach. Reading the already moved hero
    // at102.5 would instead enter stationary attack range30.5.
    expect(w.actors[1].x).toBe(132 * 256);
    expect(w.actors[1].execution).toBeNull();
  });
  it("commits restart after the old tick's abilities, then emits only the restart transition", () => {
    const w = fresh(),
      initialCounter = w.nextExecutionId;
    const f = attack(w) as ReturnType<typeof attack> & {
      commands: { type: "restart" }[];
    };
    f.commands = [{ type: "restart" }];
    const events = step(w, f);
    expect(w.nextExecutionId).toBe(initialCounter + 1);
    expect(w.actors[0].execution).toBeNull();
    expect(events.map((e) => e.type)).toEqual(["restart"]);
    expect(w.actors[0].x).toBe(48 * 256);
  });
  it("normalizes truncated negative movement and zero knockback in live state", () => {
    const d = definitions((raw) => {
      raw.archetypes[0].speed = 1;
      raw.abilities[0].knockbackX = 0;
      raw.archetypes[1].ai = "none";
      raw.levels[0].spawns[0].x = 200 * 256;
      raw.levels[0].spawns[1].x = 180 * 256;
      raw.levels[0].spawns[0].facing = -1;
    });
    const w = createWorld(d, identity);
    step(w, {
      slots: [
        { slot: 0, held: neutralHeld(), axes: { moveX: -17 }, edges: [] },
      ],
    });
    expect(Object.is(w.actors[0].vx, -0)).toBe(false);
    step(w, attack(w));
    for (let i = 0; i < 6; i++) step(w);
    expect(Object.is(w.actors[1].vx, -0)).toBe(false);
  });
});

describe("strict checkpoint syntax and cross-field invariants", () => {
  it("rejects missing dead-actor outcomes and defeated placements in unvisited maps", () => {
    const w = fresh();
    for (let tick = 0; tick < 300 && w.status === "playing"; tick++) step(w);
    expect(w.status).toBe("lost");
    const before = serializeCheckpoint(w),
      missing = JSON.parse(before);
    missing.campaign.defeatedPlacementIds = [];
    expect(() =>
      restoreCheckpoint(w.definitions, identity, JSON.stringify(missing)),
    ).toThrow("missing its outcome");
    const unvisited = JSON.parse(before);
    unvisited.campaign.defeatedPlacementIds.push(
      JSON.stringify(["room-2", "enemy"]),
    );
    expect(() =>
      restoreCheckpoint(w.definitions, identity, JSON.stringify(unvisited)),
    ).toThrow("durable placement");
    expect(serializeCheckpoint(w)).toBe(before);
    expect(
      serializeCheckpoint(restoreCheckpoint(w.definitions, identity, before)),
    ).toBe(before);
  });
  it.each([
    '"vx":-0',
    '"vx":-0.0',
    '"vx":-0e10',
    '"vx":0,"vx":0',
    '"vx":0,"\\u0076x":0',
  ])("rejects %s without changing the caller world", (replacement) => {
    const w = fresh(),
      before = serializeCheckpoint(w),
      json = before.replace('"vx":0', replacement);
    expect(() => restoreCheckpoint(w.definitions, identity, json)).toThrow();
    expect(serializeCheckpoint(w)).toBe(before);
  });
  it("rejects duplicate keys at every JSON nesting and escaped-key equivalence", () => {
    expect(() => boundedJSON('{"x":{"a":1,"a":2}}')).toThrow("Duplicate");
    expect(() => boundedJSON('{"a":1,"\\u0061":1}')).toThrow("Duplicate");
    expect(boundedJSON('{"text":"{\\"a\\":1,\\"a\\":2}"}')).toEqual({
      text: '{"a":1,"a":2}',
    });
  });
  it.each([
    "epoch0",
    "won-outside-goal",
    "defeated-alive",
    "stun-execution",
    "excess-freeze",
    "excess-stun",
  ])("rejects forged %s state", (kind) => {
    const w = fresh(),
      raw = JSON.parse(serializeCheckpoint(w));
    if (kind === "epoch0") raw.actors[0].motionEpoch = 0;
    if (kind === "won-outside-goal") {
      raw.levelId = "room-2";
      raw.status = "won";
      raw.campaign.visitedLevelIds.push("room-2");
    }
    if (kind === "defeated-alive")
      raw.campaign.defeatedPlacementIds = [
        JSON.stringify(["room-1", "player"]),
      ];
    if (kind === "stun-execution") {
      raw.actors[0].stunTicks = 1;
      raw.actors[0].execution = {
        id: 1,
        abilityId: "quick-strike",
        tick: 1,
        hits: [],
      };
      raw.nextExecutionId = 2;
    }
    if (kind === "excess-freeze") raw.actors[0].freezeTicks = 7;
    if (kind === "excess-stun") raw.actors[0].stunTicks = 21;
    expect(() =>
      restoreCheckpoint(w.definitions, identity, JSON.stringify(raw)),
    ).toThrow();
  });
  it("allows idle interrupted/guarded actors with valid remaining freeze and stun", () => {
    const w = fresh();
    w.actors[0].freezeTicks = 3;
    w.actors[0].stunTicks = 10;
    w.actors[0].health = 10;
    const bytes = serializeCheckpoint(w);
    expect(
      serializeCheckpoint(restoreCheckpoint(w.definitions, identity, bytes)),
    ).toBe(bytes);
  });
  it("records deaths outside combat and reuses the bounded durable outcome on room entry", () => {
    const d = definitions((raw) => {
      raw.levels[1].goal.nextLevelId = "room-1";
      raw.archetypes[1].ai = "none";
    });
    const w = createWorld(d, identity);
    w.actors[1].y = d.levels[0].deathY + 1;
    step(w);
    expect(w.campaign.defeatedPlacementIds).toContain(
      JSON.stringify(["room-1", "enemy"]),
    );
    w.actors[0].x = 600 * 256;
    step(w);
    w.actors[0].x = 600 * 256;
    step(w);
    expect(w.levelId).toBe("room-1");
    expect(w.actors[1].health).toBe(0);
    expect(() =>
      restoreCheckpoint(d, identity, serializeCheckpoint(w)),
    ).not.toThrow();
  });
});

describe("authored named scenario evidence", () => {
  function run(d: GameDefinitions, scenario: ScenarioDefinition) {
    const w = createWorld(d, identity, scenario.id),
      decoder = createInputDecoder();
    let cursor = 0,
      assertions = 0;
    const assert = () => {
      const state = JSON.parse(serializeCheckpoint(w));
      for (const a of scenario.assertions.filter((a) => a.tick === w.tick)) {
        let value = state;
        for (const k of a.path.replace(/^\//, "").split("/"))
          value = value?.[k];
        expect(value, `${scenario.id}@${w.tick}${a.path}`).toEqual(a.equals);
        assertions++;
      }
    };
    assert();
    for (let tick = 0; tick < scenario.ticks; tick++) {
      const records: InputRecord[] = [];
      while (
        cursor < scenario.actions.length &&
        scenario.actions[cursor].tick === tick
      )
        records.push(scenario.actions[cursor++]);
      const f = decodeInputRecords(decoder, tick, records);
      if (scenario.commands?.some((c) => c.tick === tick))
        f.commands = [{ type: "restart" }];
      step(w, f);
      assert();
    }
    return { w, assertions };
  }
  it("executes meaningful input/assertions for both rooms, lose/retry, and active carry/freeze", () => {
    const d = definitions();
    for (const scenario of d.scenarios) {
      expect(scenario.actions.length).toBeGreaterThan(0);
      expect(scenario.assertions.length).toBeGreaterThan(3);
      const result = run(d, scenario);
      expect(result.assertions).toBe(scenario.assertions.length);
    }
    expect(d.scenarios.map((s) => s.id)).toEqual([
      "start",
      "second-room",
      "lose-and-retry",
      "active-mechanics",
    ]);
  });
  it("fails authored objectives when movement is disabled instead of passing vacuously", () => {
    const d = definitions((raw) => {
      raw.archetypes[0].speed = 1;
    });
    expect(() => run(d, d.scenarios[0])).toThrow();
  });
});
