import { describe, expect, it } from "vitest";
import { CharacterValidationError } from "./character";
import {
  CHARACTER_BUILD_LIMITS,
  evaluateCharacterEquipment,
  validateCharacterBuildDefinition,
} from "./character-build";
import {
  CHARACTER_ARENA_BUILDS,
  CHARACTER_ARENA_CATALOG,
} from "../../game-simulation/src/character-fixture";
const source = (): any => JSON.parse(JSON.stringify(CHARACTER_ARENA_BUILDS));
const prepare = (s: unknown) =>
  validateCharacterBuildDefinition(s, CHARACTER_ARENA_CATALOG);
describe("C1 authorable build definitions", () => {
  it.each([
    [
      "/items/1/id",
      (s: any) => s.items.splice(1, 0, structuredClone(s.items[0])),
    ],
    [
      "/stats/1/id",
      (s: any) => s.stats.splice(1, 0, structuredClone(s.stats[0])),
    ],
    ["/slots/1", (s: any) => s.slots.splice(1, 0, s.slots[0])],
    [
      "/builds/1/id",
      (s: any) => {
        s.builds.push(structuredClone(s.builds[0]), {
          ...structuredClone(s.builds[0]),
          id: "other",
        });
      },
    ],
    [
      "/items/0/archetypeIds/1",
      (s: any) => s.items[0].archetypeIds.push(s.items[0].archetypeIds[0]),
    ],
    [
      "/items/0/requirements/1/statId",
      (s: any) => {
        s.items[0].requirements = [
          { statId: "health", min: 1 },
          { statId: "health", min: 2 },
        ];
      },
    ],
    [
      "/items/0/modifiers/1/statId",
      (s: any) =>
        s.items[0].modifiers.push(structuredClone(s.items[0].modifiers[0])),
    ],
    [
      "/builds/0/appearanceIds/1",
      (s: any) =>
        s.builds[0].appearanceIds.splice(1, 0, s.builds[0].appearanceIds[0]),
    ],
    [
      "/builds/0/baseStats/1/statId",
      (s: any) =>
        s.builds[0].baseStats.splice(
          1,
          0,
          structuredClone(s.builds[0].baseStats[0]),
        ),
    ],
    [
      "/builds/0/grants/1/itemId",
      (s: any) =>
        s.builds[0].grants.splice(1, 0, structuredClone(s.builds[0].grants[0])),
    ],
    [
      "/builds/0/equipment/1/slotId",
      (s: any) => {
        s.builds[0].equipment = [
          { slotId: "weapon", itemId: "sword" },
          { slotId: "weapon", itemId: "sword" },
        ];
      },
    ],
  ])("locates duplicate source IDs before sorting: %s", (pointer, mutate) => {
    const s = source();
    mutate(s);
    expect(() => prepare(s)).toThrow("Duplicate character ID");
    try {
      prepare(s);
    } catch (error) {
      expect(
        (error as CharacterValidationError).diagnostics[0].jsonPointer,
      ).toBe(pointer);
    }
  });
  it("references C0 choices, copies, and orders recipe sets without cosmetic authority", () => {
    const s = source();
    const a = prepare(s);
    s.items.reverse();
    s.stats.reverse();
    s.slots.reverse();
    s.builds[0].baseStats.reverse();
    s.builds[0].appearanceIds.reverse();
    expect(prepare(s)).toEqual(a);
    s.items[0].modifiers.length = 0;
    expect(a.items.find((x) => x.id === "sword")!.modifiers).toEqual([
      { statId: "damage", delta: 2 },
    ]);
    expect(
      evaluateCharacterEquipment(a, "scout", [
        { slotId: "weapon", itemId: "sword" },
      ]),
    ).toEqual([
      { statId: "damage", value: 3 },
      { statId: "health", value: 4 },
      { statId: "speed", value: 256 },
    ]);
  });
  it.each([
    [
      "/builds/0/archetypeId",
      (s: any) => (s.builds[0].archetypeId = "missing"),
    ],
    [
      "/builds/0/appearanceIds/0",
      (s: any) => (s.builds[0].appearanceIds = ["missing"]),
    ],
    ["/items/0/slotId", (s: any) => (s.items[0].slotId = "missing")],
    [
      "/items/0/modifiers/0/statId",
      (s: any) => (s.items[0].modifiers[0].statId = "missing"),
    ],
    [
      "/items/0/requirements/0/min",
      (s: any) => (s.items[0].requirements = [{ statId: "health", min: 100 }]),
    ],
    ["/builds/0/baseStats", (s: any) => s.builds[0].baseStats.pop()],
    [
      "/builds/0/equipment",
      (s: any) =>
        (s.builds[0].equipment = [{ slotId: "weapon", itemId: "heavy-sword" }]),
    ],
    [
      "/builds/0/equipment",
      (s: any) => {
        s.builds[0].equipment = [{ slotId: "weapon", itemId: "sword" }];
        s.builds[0].grants = [];
      },
    ],
    ["/builds/0", (s: any) => (s.builds[0].appearanceDamage = 5)],
    ["/items/0", (s: any) => (s.items[0].bodyWidth = 100)],
  ])("rejects invalid authoring at source %s", (pointer, mutate) => {
    const s = source();
    mutate(s);
    try {
      validateCharacterBuildDefinition(
        s,
        CHARACTER_ARENA_CATALOG,
        "hero/builds.json",
      );
      throw Error("expected rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(CharacterValidationError);
      expect((e as CharacterValidationError).diagnostics[0]).toMatchObject({
        file: "hero/builds.json",
        jsonPointer: pointer,
        code: "character.build.invalid",
      });
    }
  });
  it("keeps source indices through sorted build IDs and checks final combined bounds", () => {
    const s = source();
    s.builds[0].id = "z";
    s.builds.push({ ...structuredClone(s.builds[0]), id: "a" });
    s.builds[0].equipment = [{ slotId: "weapon", itemId: "heavy-sword" }];
    try {
      prepare(s);
      throw Error("expected rejection");
    } catch (e) {
      expect((e as CharacterValidationError).diagnostics[0].jsonPointer).toBe(
        "/builds/0/equipment",
      );
    }
    const t = source();
    t.items.find((i: any) => i.id === "sword").modifiers[0].delta = 10;
    t.builds[0].equipment = [{ slotId: "weapon", itemId: "sword" }];
    expect(() => prepare(t)).toThrow("Invalid character integer");
  });
  it("rejects controller-incompatible appearance and item eligibility", () => {
    const c: any = structuredClone(CHARACTER_ARENA_CATALOG);
    c.appearances[0].animations = { "platform-combat-v1": "other" };
    expect(() => validateCharacterBuildDefinition(source(), c)).toThrow(
      "Unknown reference",
    );
    const s = source();
    s.items[0].archetypeIds = [];
    expect(() => prepare(s)).toThrow("eligible archetypes");
  });
  it.each(["builds", "items", "stats", "slots", "appearances"] as const)(
    "accepts max and rejects max+1 %s",
    (key) => {
      const make = (count: number) => {
        const s = source();
        const catalog: any = structuredClone(CHARACTER_ARENA_CATALOG);
        if (key === "builds")
          s.builds = Array.from({ length: count }, (_, i) => ({
            ...s.builds[0],
            id: `build-${i}`,
          }));
        if (key === "items")
          ((s.items = Array.from({ length: count }, (_, i) => ({
            ...s.items[0],
            id: `item-${i}`,
          }))),
            (s.builds[0].grants = []));
        if (key === "stats") {
          const extra = Array.from(
            { length: count - s.stats.length },
            (_, i) => ({ id: `extra-${i}`, min: -1_000_000, max: 1_000_000 }),
          );
          s.stats.push(...extra);
          s.builds[0].baseStats.push(
            ...extra.map((x) => ({ statId: x.id, value: 0 })),
          );
        }
        if (key === "slots")
          s.slots = [
            "weapon",
            "boots",
            ...Array.from({ length: count - 2 }, (_, i) => `slot-${i}`),
          ];
        if (key === "appearances") {
          catalog.appearances = Array.from({ length: count }, (_, i) => ({
            ...catalog.appearances[0],
            id: `look-${i}`,
          }));
          s.builds[0].appearanceIds = catalog.appearances.map((x: any) => x.id);
        }
        return { s, catalog };
      };
      const valid = make(CHARACTER_BUILD_LIMITS[key]);
      expect(() =>
        validateCharacterBuildDefinition(valid.s, valid.catalog),
      ).not.toThrow();
      const invalid = make(CHARACTER_BUILD_LIMITS[key] + 1);
      expect(() =>
        validateCharacterBuildDefinition(invalid.s, invalid.catalog),
      ).toThrow();
    },
  );
  it("rejects exotic data without invoking getters or accepting negative zero", () => {
    let reads = 0;
    const s = source();
    Object.defineProperty(s, "id", {
      enumerable: true,
      get: () => {
        reads++;
        return "evil";
      },
    });
    expect(() => prepare(s)).toThrow("accessor");
    expect(reads).toBe(0);
    const t = source();
    t.items[0].modifiers[0].delta = -0;
    expect(() => prepare(t)).toThrow("plain data");
    const u = source();
    u.items = new Array(2);
    expect(() => prepare(u)).toThrow("array");
    const v = source();
    v.items[0][Symbol("hidden")] = true;
    expect(() => prepare(v)).toThrow("Invalid character object");
  });
});
