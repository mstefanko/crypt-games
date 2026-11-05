import { describe, expect, it } from "vitest";
import content from "../../../examples/game-m1/definitions.json";
import {
  canonicalDefinitions,
  parseDefinitions,
  validateDefinitions,
  ValidationError,
} from "./index";
const raw = () => JSON.parse(JSON.stringify(content)) as typeof content;
describe("bounded gameplay definitions", () => {
  it("validates bounded recursive scenario assertions and typed restart commands", () => {
    const source = raw();
    source.scenarios[0].assertions = [
      {
        tick: 0,
        path: "/campaign",
        equals: { visitedLevelIds: ["room-1"], defeatedPlacementIds: [] },
      },
    ] as never;
    source.scenarios[0].commands = [{ tick: 10, type: "restart" }];
    expect(() => validateDefinitions(source)).not.toThrow();
    for (const bad of [
      undefined,
      NaN,
      1.5,
      "x".repeat(513),
      Array.from({ length: 256 }, () => 0),
      { constructor: 0 },
    ]) {
      const candidate = raw();
      candidate.scenarios[0].assertions = [
        { tick: 0, path: "/campaign", equals: bad },
      ] as never;
      expect(() => validateDefinitions(candidate)).toThrow();
    }
    let deep: unknown = 0;
    for (let i = 0; i < 9; i++) deep = [deep];
    const candidate = raw();
    candidate.scenarios[0].assertions = [
      { tick: 0, path: "/campaign", equals: deep },
    ] as never;
    expect(() => validateDefinitions(candidate)).toThrow();
    for (const commands of [
      [{ tick: 10, type: "teleport" }],
      [{ tick: 480, type: "restart" }],
      [
        { tick: 10, type: "restart" },
        { tick: 10, type: "restart" },
      ],
    ]) {
      const candidate = raw();
      candidate.scenarios[0].commands = commands as never;
      expect(() => validateDefinitions(candidate)).toThrow();
    }
  });
  it("copies definitions into deeply frozen values without freezing caller objects", () => {
    const source = raw(),
      d = validateDefinitions(source),
      bytes = canonicalDefinitions(d);
    source.archetypes[0].body.width = 1;
    expect(canonicalDefinitions(d)).toBe(bytes);
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.levels[0].tiles)).toBe(true);
    expect(Object.isFrozen(d.archetypes[0].body)).toBe(true);
    expect(Object.isFrozen(source)).toBe(false);
  });
  it("returns the exact numeric field JSON pointer for developer diagnostics", () => {
    const source = raw();
    source.levels[0].platforms[0].speed = 1025;
    try {
      validateDefinitions(source);
      throw Error("expected invalid definition");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).diagnostics[0].jsonPointer).toBe(
        "/levels/0/platforms/0/speed",
      );
    }
  });
  it("accepts finite noncyclic shared source objects but rejects cycles before copying", () => {
    const source = raw();
    source.archetypes[0].hurt = source.archetypes[0].body;
    expect(() => validateDefinitions(source)).not.toThrow();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => validateDefinitions(cycle)).toThrow("nesting limit");
  });
  it("normalizes integer negative zero in validated definitions", () => {
    const source = raw();
    source.abilities[0].guardDamage = -0;
    const d = validateDefinitions(source);
    expect(Object.is(d.abilities[0].guardDamage, -0)).toBe(false);
  });
  it.each([1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, -1, 8193])(
    "rejects invalid configured actor speed %s",
    (speed) => {
      const source = raw();
      source.archetypes[0].speed = speed;
      expect(() => validateDefinitions(source)).toThrow();
    },
  );
  it("rejects unsupported document fields, tile codes/counts, and missing references", () => {
    for (const edit of [
      (v: typeof content) => {
        (v.manifest as unknown as Record<string, unknown>).futureSystem = {};
      },
      (v: typeof content) => {
        v.levels[0].tiles[0] = 3;
      },
      (v: typeof content) => {
        v.levels[0].tiles.pop();
      },
      (v: typeof content) => {
        v.archetypes[0].abilities[0] = "missing";
      },
      (v: typeof content) => {
        v.levels[0].spawns[0].archetypeId = "missing";
      },
    ]) {
      const source = raw();
      edit(source);
      expect(() => validateDefinitions(source)).toThrow();
    }
  });
  it("rejects a horizontal platform's swept solid path and static rider obstruction", () => {
    const source = raw(),
      p = source.levels[0].platforms[0];
    source.levels[0].rectangles.push({
      id: "platform-wall",
      x: p.x + 100 * 256,
      y: p.y,
      width: 256,
      height: 256,
      oneWay: false,
    });
    expect(() => validateDefinitions(source)).toThrow("swept path");
    const ceiling = raw(),
      q = ceiling.levels[0].platforms[0];
    ceiling.levels[0].rectangles.push({
      id: "rider-wall",
      x: q.x + 100 * 256,
      y: q.y - 24 * 256,
      width: 256,
      height: 256,
      oneWay: false,
    });
    expect(() => validateDefinitions(ceiling)).toThrow("rider path");
  });
  it("rejects scenario transition disagreement, invalid ordering and out-of-run ticks", () => {
    for (const actions of [
      [
        {
          tick: 0,
          slot: 0,
          sequence: 0,
          heldPatch: { attack: true },
          edges: [],
        },
      ],
      [{ tick: 600, slot: 0, sequence: 0, edges: [] }],
      [
        { tick: 0, slot: 0, sequence: 2, edges: [] },
        { tick: 0, slot: 0, sequence: 1, edges: [] },
      ],
      [
        {
          tick: 0,
          slot: 0,
          sequence: 0,
          edges: [{ action: "attack", kind: "released" }],
        },
      ],
    ]) {
      const source = raw();
      source.scenarios[0].actions = actions as never;
      expect(() => validateDefinitions(source)).toThrow();
    }
  });
  it("rejects more than 32 total transitions across records for one slot/tick", () => {
    const source = raw();
    source.scenarios[0].actions = Array.from({ length: 2 }, (_, sequence) => ({
      tick: 0,
      slot: 0,
      sequence,
      edges: Array.from({ length: 17 }, () => ({
        action: "attack",
        kind: "cancel",
      })),
    })) as never;
    expect(() => validateDefinitions(source)).toThrow("transition limit");
  });
  it("bounds UTF-8 bytes and nesting before JSON parsing", () => {
    expect(() => parseDefinitions(" ".repeat(2097153))).toThrow("byte limit");
    expect(() =>
      parseDefinitions("[".repeat(33) + "0" + "]".repeat(33)),
    ).toThrow("nesting limit");
  });
});
