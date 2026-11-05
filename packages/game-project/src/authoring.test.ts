import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  AssertionValueSchema,
  GameDefinitionsSchema,
  validateAuthoringDefinitions,
} from "./authoring";
import {
  canonicalDefinitions,
  parseDefinitions,
  validateDefinitions,
} from "./validate";

function fixture() {
  const shape = { x: -1024, y: -2048, width: 2048, height: 2048 };
  return {
    manifest: {
      schemaVersion: 1,
      gameId: "schema-parity",
      title: "Schema parity",
      rulesModule: "platform-combat-v1",
      initialLevelId: "room",
      initialScenarioId: "start",
      levelIds: ["room"],
      archetypeIds: ["hero"],
      abilityIds: ["strike"],
      scenarioIds: ["start"],
      viewport: { width: 320, height: 180 },
    },
    levels: [
      {
        id: "room",
        width: 48,
        height: 32,
        tileSize: 16,
        tiles: [0, 0, 0, 1, 1, 1],
        rectangles: [],
        platforms: [],
        spawns: [
          {
            id: "player",
            archetypeId: "hero",
            x: 2048,
            y: 4096,
            slot: 0,
            team: 0,
            facing: 1,
          },
        ],
        goal: { x: 10240, y: 0, width: 2048, height: 4096, nextLevelId: null },
        deathY: 8192,
      },
    ],
    archetypes: [
      {
        id: "hero",
        body: shape,
        hurt: shape,
        push: shape,
        health: 10,
        speed: 256,
        jumpSpeed: 512,
        gravity: 128,
        maxFallSpeed: 1024,
        coyoteTicks: 6,
        jumpBufferTicks: 6,
        attackBufferTicks: 6,
        abilities: ["strike"],
        ai: "none",
        aiRange: 0,
      },
    ],
    abilities: [
      {
        id: "strike",
        startup: 6,
        active: 4,
        recovery: 14,
        hit: { x: 1024, y: -2048, width: 2048, height: 2048 },
        damage: 1,
        knockbackX: 256,
        knockbackY: -256,
        stunTicks: 10,
        hitStopTicks: 4,
        guardDamage: 0,
        maxHits: 1,
        rehitTicks: 1,
      },
    ],
    scenarios: [
      {
        id: "start",
        levelId: "room",
        seed: 1,
        playerSlots: [0],
        ticks: 100,
        actions: [],
        assertions: [],
      },
    ],
  };
}
function assign(value: unknown, path: string, replacement: unknown) {
  const keys = path.split("/");
  let target = value as Record<string, unknown>;
  for (const key of keys.slice(0, -1))
    target = target[key] as Record<string, unknown>;
  target[keys.at(-1)!] = replacement;
}

describe("authoring schema and hand-written runtime codec parity", () => {
  it.each([
    null,
    [null, true, 7, "text"],
    { nested: { items: [null, 1] } },
    { ["x".repeat(128)]: 0 },
    { ["line\nbreak"]: false },
  ])("accepts the same recursive assertion value %#", (value) => {
    const raw = fixture();
    assign(raw, "scenarios/0/assertions", [
      { tick: 0, path: "/campaign", equals: value },
    ]);
    expect(Value.Check(AssertionValueSchema, value)).toBe(true);
    expect(canonicalDefinitions(validateAuthoringDefinitions(raw))).toBe(
      canonicalDefinitions(validateDefinitions(raw)),
    );
  });
  it.each([
    { ["x".repeat(129)]: 0 },
    JSON.parse('{"__proto__":0}'),
    { constructor: 0 },
    { prototype: 0 },
    "x".repeat(513),
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects the same recursive assertion structural defect %#", (value) => {
    const raw = fixture();
    assign(raw, "scenarios/0/assertions", [
      { tick: 0, path: "/campaign", equals: value },
    ]);
    expect(Value.Check(AssertionValueSchema, value)).toBe(false);
    expect(() => validateDefinitions(raw)).toThrow();
    expect(() => validateAuthoringDefinitions(raw)).toThrow();
  });
  it("shares aggregate node and depth limits beyond recursive schema structure", () => {
    let deep: unknown = null;
    for (let i = 0; i < 9; i++) deep = [deep];
    for (const value of [deep, Array.from({ length: 256 }, () => null)]) {
      const raw = fixture();
      assign(raw, "scenarios/0/assertions", [
        { tick: 0, path: "/campaign", equals: value },
      ]);
      expect(Value.Check(AssertionValueSchema, value)).toBe(true);
      expect(() => validateDefinitions(raw)).toThrow();
      expect(() => validateAuthoringDefinitions(raw)).toThrow();
    }
  });
  it("shares ordered in-run scenario command validation", () => {
    const valid = fixture();
    assign(valid, "scenarios/0/commands", [
      { tick: 0, type: "restart" },
      { tick: 99, type: "restart" },
    ]);
    expect(canonicalDefinitions(validateAuthoringDefinitions(valid))).toBe(
      canonicalDefinitions(validateDefinitions(valid)),
    );
    for (const commands of [
      [{ tick: 100, type: "restart" }],
      [
        { tick: 10, type: "restart" },
        { tick: 10, type: "restart" },
      ],
      [
        { tick: 20, type: "restart" },
        { tick: 10, type: "restart" },
      ],
      [{ tick: 10, type: "teleport" }],
      [{ tick: 10, type: "restart", unknown: 1 }],
    ]) {
      const raw = fixture();
      assign(raw, "scenarios/0/commands", commands);
      expect(() => validateDefinitions(raw)).toThrow();
      expect(() => validateAuthoringDefinitions(raw)).toThrow();
    }
  });
  it("validates the same immutable canonical definitions", () => {
    const raw = fixture();
    expect(Value.Check(GameDefinitionsSchema, raw)).toBe(true);
    const result = validateDefinitions(raw);
    expect(canonicalDefinitions(validateAuthoringDefinitions(raw))).toBe(
      canonicalDefinitions(result),
    );
    expect(Object.isFrozen(result.levels[0].spawns[0])).toBe(true);
    expect(parseDefinitions(JSON.stringify(raw))).toEqual(result);
  });
  it.each([
    ["manifest/schemaVersion", 2],
    ["manifest/rulesModule", "future"],
    ["manifest/viewport/width", 63],
    ["manifest/gameId", ""],
    ["manifest/title", "x".repeat(121)],
    ["levels/0/tileSize", 12],
    ["levels/0/tiles/0", 3],
    ["levels/0/width", Infinity],
    ["levels/0/spawns/0/slot", 4],
    ["levels/0/spawns/0/facing", 0],
    ["archetypes/0/speed", 8193],
    ["archetypes/0/gravity", 0],
    ["archetypes/0/health", NaN],
    ["archetypes/0/ai", "arbitrary"],
    ["abilities/0/damage", 1.5],
    ["abilities/0/active", 0],
    ["abilities/0/knockbackY", -8193],
    ["abilities/0/hit/width", 0],
    ["scenarios/0/seed", 4294967296],
    ["scenarios/0/playerSlots", [0, 0]],
    [
      "scenarios/0/actions",
      [{ tick: 1, slot: 0, sequence: 0, axesPatch: { moveX: 128 }, edges: [] }],
    ],
    [
      "scenarios/0/actions",
      [{ tick: 1, slot: 0, sequence: 0, heldPatch: { attack: 1 }, edges: [] }],
    ],
    [
      "scenarios/0/actions",
      [
        {
          tick: 1,
          slot: 0,
          sequence: 0,
          edges: [{ action: "jump", kind: "fire" }],
        },
      ],
    ],
    [
      "scenarios/0/assertions",
      [{ tick: 1, path: "tick", equals: Number.MAX_SAFE_INTEGER + 1 }],
    ],
  ])("both reject structural defect %s", (path, replacement) => {
    const raw = fixture();
    assign(raw, path as string, replacement);
    expect(Value.Check(GameDefinitionsSchema, raw)).toBe(false);
    expect(() => validateDefinitions(raw)).toThrow();
    expect(() => validateAuthoringDefinitions(raw)).toThrow();
  });
  it.each([
    "",
    "manifest",
    "manifest/viewport",
    "levels/0",
    "levels/0/spawns/0",
    "archetypes/0",
    "abilities/0",
    "scenarios/0",
  ])("rejects unknown fields at /%s", (path) => {
    const raw = fixture();
    assign(raw, path ? `${path}/surprise` : "surprise", true);
    expect(Value.Check(GameDefinitionsSchema, raw)).toBe(false);
    expect(() => validateDefinitions(raw)).toThrow();
  });
  it.each([
    ["manifest/initialLevelId", "missing"],
    ["levels/0/spawns/0/archetypeId", "missing"],
    ["archetypes/0/abilities", ["missing"]],
    ["levels/0/tiles", [0]],
    ["levels/0/spawns/0/y", 6000],
  ])("shares semantic validation for %s", (path, replacement) => {
    const raw = fixture();
    assign(raw, path as string, replacement);
    expect(Value.Check(GameDefinitionsSchema, raw)).toBe(true);
    expect(() => validateDefinitions(raw)).toThrow();
    expect(() => validateAuthoringDefinitions(raw)).toThrow();
  });
  it("bounds JSON bytes and depth before parsing, and normalizes negative zero", () => {
    expect(() => parseDefinitions(" ".repeat(2097153))).toThrow(/byte limit/);
    expect(() =>
      parseDefinitions("[".repeat(33) + "0" + "]".repeat(33)),
    ).toThrow(/nesting/);
    const raw = fixture();
    raw.scenarios[0].seed = -0;
    expect(Object.is(validateDefinitions(raw).scenarios[0].seed, -0)).toBe(
      false,
    );
  });
});
