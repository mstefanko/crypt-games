import { describe, expect, it } from "vitest";
import {
  CharacterSessionOwner,
  CHARACTER_SESSION_LIMITS,
  type CharacterSessionAction,
  type CharacterSessionCommand,
} from "./character-session";
import {
  CHARACTER_ARENA_BUILDS,
  CHARACTER_ARENA_CATALOG,
} from "./character-fixture";
import {
  CHARACTER_BUILD_LIMITS,
  validateCharacterBuildDefinition,
} from "@onepage/game-project/character-build";
const create: CharacterSessionAction = {
  kind: "create",
  buildId: "scout",
  appearanceId: "warm",
  displayName: "Élodie",
};
const owner = () =>
  new CharacterSessionOwner(CHARACTER_ARENA_BUILDS, CHARACTER_ARENA_CATALOG);
const submit = (
  s: CharacterSessionOwner,
  action: CharacterSessionAction,
  id = `command-${s.inspect().revision}`,
) => s.execute({ id, revision: s.inspect().revision, action });
const equip = (itemId: string | null): CharacterSessionAction => ({
  kind: "equip",
  slotId: "weapon",
  itemId,
});
const look = (appearanceId = "cool"): CharacterSessionAction => ({
  kind: "customize",
  appearanceId,
  displayName: "春香",
});
describe("C1 atomic character session", () => {
  it("rejects visually empty names atomically and counts Unicode code points", () => {
    const s = owner();
    for (const displayName of [
      "   ",
      "\u200b",
      "\u200c",
      "\u200d",
      "\u2060",
      "\ufeff",
      " \u200b\u200d ",
    ]) {
      const before = s.save();
      expect(() => submit(s, { ...create, displayName })).toThrow(
        "display name",
      );
      expect(s.save()).toBe(before);
    }
    submit(s, { ...create, displayName: "😀".repeat(64) });
    const before = s.save();
    expect(() =>
      submit(s, {
        ...look(),
        displayName: "😀".repeat(65),
      } as CharacterSessionAction),
    ).toThrow();
    expect(() =>
      submit(s, {
        ...look(),
        displayName: " \u200b ",
      } as CharacterSessionAction),
    ).toThrow("display name");
    expect(s.save()).toBe(before);
    const reopened = owner();
    reopened.load(before);
    expect(reopened.save()).toBe(before);
    submit(s, { ...look(), displayName: "👩‍🚀" } as CharacterSessionAction);
    reopened.load(s.save());
    expect(reopened.save()).toBe(s.save());
  });
  it("creates once, deduplicates identical requests, and returns detached state", () => {
    const s = owner();
    const c = { id: "create", revision: 0, action: create };
    const receipt = s.execute(c);
    const bytes = s.save();
    expect(s.execute(c)).toEqual(receipt);
    expect(s.save()).toBe(bytes);
    expect(() => submit(s, create, "again")).toThrow("already created");
    expect(() =>
      s.execute({ ...c, action: { ...create, displayName: "other" } }),
    ).toThrow("Conflicting");
    expect(s.save()).toBe(bytes);
    const inspection = s.inspect();
    (inspection.inventory[0] as any).quantity = 99;
    (inspection.character as any).equipment.push({
      slotId: "weapon",
      itemId: "sword",
    });
    expect(s.save()).toBe(bytes);
    expect(inspection.stats).toEqual([
      { statId: "damage", value: 1 },
      { statId: "health", value: 4 },
      { statId: "speed", value: 256 },
    ]);
  });
  it("atomically exchanges inventory and recomputes stats; repeat equip grants nothing", () => {
    const s = owner();
    submit(s, create);
    submit(s, equip("sword"));
    expect(s.inspect().stats[0].value).toBe(3);
    expect(
      s.inspect().inventory.find((x) => x.itemId === "sword")!.quantity,
    ).toBe(0);
    submit(s, equip("sword"));
    expect(
      s.inspect().inventory.find((x) => x.itemId === "sword")!.quantity,
    ).toBe(0);
    submit(s, equip(null));
    expect(s.inspect().stats[0].value).toBe(1);
    expect(
      s.inspect().inventory.find((x) => x.itemId === "sword")!.quantity,
    ).toBe(1);
  });
  it("rejects unavailable, wrong-slot, unknown, ineligible and stale edits with no partial return", () => {
    const s = owner();
    expect(() => submit(s, equip("sword"))).toThrow("Create character first");
    submit(s, create);
    submit(s, equip("sword"));
    const before = s.save();
    for (const action of [
      equip("boots"),
      equip("missing"),
      equip("heavy-sword"),
      { kind: "equip", slotId: "unknown", itemId: null },
      look("missing"),
    ] as CharacterSessionAction[]) {
      expect(() => submit(s, action)).toThrow();
      expect(s.save()).toBe(before);
    }
    expect(() =>
      s.execute({ id: "stale", revision: 0, action: equip(null) }),
    ).toThrow("Stale");
    expect(s.save()).toBe(before);
    const raw: any = structuredClone(CHARACTER_ARENA_BUILDS);
    raw.builds[0].grants = [];
    const empty = new CharacterSessionOwner(raw, CHARACTER_ARENA_CATALOG);
    submit(empty, create);
    const emptyBefore = empty.save();
    expect(() => submit(empty, equip("sword"))).toThrow();
    expect(empty.save()).toBe(emptyBefore);
  });
  it("preserves inventory/stats through appearance edits and multilingual names", () => {
    const s = owner();
    submit(s, create);
    submit(s, equip("sword"));
    const before = s.inspect();
    submit(s, look());
    expect(s.inspect().inventory).toEqual(before.inventory);
    expect(s.inspect().stats).toEqual(before.stats);
    expect(s.inspect().character).toMatchObject({
      appearanceId: "cool",
      displayName: "春香",
    });
    for (const displayName of ["", "a".repeat(65), "bad\u202e", "bad\u0085"])
      expect(() =>
        submit(s, { ...look(), displayName } as CharacterSessionAction),
      ).toThrow("display name");
  });
  it("reopens and continues exactly, including creation retry without duplicate grants", () => {
    const a = owner();
    const c = { id: "create", revision: 0, action: create };
    a.execute(c);
    submit(a, equip("sword"));
    submit(a, look());
    const b = owner();
    b.load(a.save());
    expect(b.save()).toBe(a.save());
    b.execute(c);
    expect(b.save()).toBe(a.save());
    for (const action of [
      equip(null),
      equip("sword"),
      look("warm"),
      { kind: "equip", slotId: "boots", itemId: "boots" },
    ] as CharacterSessionAction[]) {
      submit(a, action);
      submit(b, action);
      expect(b.save()).toBe(a.save());
    }
  });
  it.each([
    (v: any) => v.transactions.resources[0].quantity++,
    (v: any) => v.transactions.stats[0].value++,
    (v: any) => (v.transactions.outcomes = []),
    (v: any) => (v.transactions.receipts = []),
    (v: any) => (v.character.equipment = []),
    (v: any) => (v.character.appearanceId = "cool"),
    (v: any) => (v.commands[0].action.displayName = "forged"),
    (v: any) => v.commands.push(v.commands[0]),
    (v: any) => (v.catalog.appearances[0].assetId = "other"),
    (v: any) => (v.definition.items[0].modifiers = []),
    (v: any) => (v.extra = true),
    (v: any) => (v.revision = -0),
  ])(
    "rejects forged exact saves without changing current state %#",
    (mutate) => {
      const s = owner();
      submit(s, create);
      submit(s, equip("sword"));
      const before = s.save();
      const bad = s.capture();
      mutate(bad);
      expect(() => s.restore(bad)).toThrow();
      expect(s.save()).toBe(before);
    },
  );
  it("rejects duplicate JSON keys, excess bytes, getters, exotic prototypes and hidden properties", () => {
    const s = owner();
    submit(s, create);
    const before = s.save();
    expect(() =>
      s.load(before.replace('"format":', '"format":"duplicate","format":')),
    ).toThrow("Duplicate");
    expect(() =>
      s.load(" ".repeat(CHARACTER_SESSION_LIMITS.saveBytes + 1)),
    ).toThrow("byte limit");
    let reads = 0;
    const bad = s.capture();
    Object.defineProperty(bad, "character", {
      enumerable: true,
      get: () => {
        reads++;
        return null;
      },
    });
    expect(() => s.restore(bad)).toThrow();
    expect(reads).toBe(0);
    const prototype = Object.assign(Object.create({}), s.capture());
    expect(() => s.restore(prototype)).toThrow();
    const symbol = s.capture();
    (symbol as any)[Symbol("hidden")] = true;
    expect(() => s.restore(symbol)).toThrow();
    expect(s.save()).toBe(before);
  });
  it("supports the maximum authored creation and a 2m stat swing inside one M8b commit", () => {
    const raw: any = {
      schemaVersion: 1,
      id: "maximum",
      slots: Array.from({ length: 8 }, (_, i) => `slot-${i}`),
      stats: Array.from({ length: 6 }, (_, i) => ({
        id: `s-${i}`,
        min: -1_000_000,
        max: 1_000_000,
      })),
      items: [],
      builds: [],
    };
    raw.items = Array.from({ length: 8 }, (_, i) => ({
      id: `item-${i}`,
      slotId: `slot-${i}`,
      archetypeIds: ["arena-hero"],
      requirements: [],
      modifiers: [],
    }));
    raw.builds = Array.from({ length: 32 }, (_, i) => ({
      id: `build-${i}`,
      archetypeId: "arena-hero",
      appearanceIds: ["warm"],
      baseStats: raw.stats.map((x: any) => ({
        statId: x.id,
        value: 1_000_000,
      })),
      grants: raw.items.map((x: any) => ({ itemId: x.id, quantity: 99 })),
      equipment: raw.items.map((x: any) => ({
        itemId: x.id,
        slotId: x.slotId,
      })),
    }));
    const max = new CharacterSessionOwner(
      validateCharacterBuildDefinition(raw, CHARACTER_ARENA_CATALOG),
      CHARACTER_ARENA_CATALOG,
    );
    submit(max, { ...create, buildId: "build-0" });
    expect(max.inspect().inventory.every((x) => x.quantity === 98)).toBe(true);
    expect(max.capture().transactions.commands[0].operations.length).toBe(15);
    const roundtrip = new CharacterSessionOwner(raw, CHARACTER_ARENA_CATALOG);
    roundtrip.load(max.save());
    expect(roundtrip.save()).toBe(max.save());
    const swing = structuredClone(raw);
    swing.items[0].modifiers = swing.stats.map((x: any) => ({
      statId: x.id,
      delta: -1_000_000,
    }));
    swing.items[1].slotId = "slot-0";
    swing.items[1].modifiers = swing.stats.map((x: any) => ({
      statId: x.id,
      delta: 1_000_000,
    }));
    swing.builds.forEach((b: any) => {
      b.baseStats.forEach((x: any) => (x.value = 0));
      b.equipment = [{ slotId: "slot-0", itemId: "item-0" }];
    });
    const s = new CharacterSessionOwner(swing, CHARACTER_ARENA_CATALOG);
    submit(s, { ...create, buildId: "build-0" });
    submit(s, { kind: "equip", slotId: "slot-0", itemId: "item-1" });
    expect(
      s.inspect().stats.every((x) => x.value === CHARACTER_BUILD_LIMITS.stat),
    ).toBe(true);
    expect(s.capture().transactions.commands[1].operations.length).toBe(15);
    // Combine the full 256-command, 15-operation witness with long authored
    // IDs and a catalog near the independently reserved 512 KiB budget.
    const large = structuredClone(swing);
    const long = (id: string) => id.padEnd(128, "x");
    large.slots = large.slots.map(long);
    large.stats.forEach((x: any) => {
      x.id = long(x.id);
    });
    large.items.forEach((x: any) => {
      x.id = long(x.id);
      x.slotId = long(x.slotId);
      x.modifiers.forEach((m: any) => {
        m.statId = long(m.statId);
      });
    });
    large.builds.forEach((b: any) => {
      b.id = long(b.id);
      b.baseStats.forEach((x: any) => {
        x.statId = long(x.statId);
      });
      b.grants.forEach((x: any) => {
        x.itemId = long(x.itemId);
      });
      b.equipment.forEach((x: any) => {
        x.itemId = long(x.itemId);
        x.slotId = long(x.slotId);
      });
    });
    const catalog: any = structuredClone(CHARACTER_ARENA_CATALOG);
    const authoredSize = () =>
      new TextEncoder().encode(JSON.stringify({ definition: large, catalog }))
        .length;
    while (true) {
      catalog.appearances.push({
        ...catalog.appearances[0],
        id: long(`look-${catalog.appearances.length}`),
        partIds: Array.from({ length: 16 }, (_, i) => long(`part-${i}`)),
        paletteIds: Array.from({ length: 16 }, (_, i) => long(`palette-${i}`)),
      });
      if (authoredSize() > CHARACTER_SESSION_LIMITS.authoredBytes) {
        catalog.appearances.pop();
        break;
      }
    }
    expect(authoredSize()).toBeGreaterThan(
      CHARACTER_SESSION_LIMITS.authoredBytes - 5000,
    );
    const full = new CharacterSessionOwner(large, catalog);
    submit(
      full,
      { ...create, buildId: long("build-0"), displayName: "😀".repeat(64) },
      long("create"),
    );
    for (let i = 1; i < CHARACTER_SESSION_LIMITS.commits; i++)
      submit(
        full,
        {
          kind: "equip",
          slotId: long("slot-0"),
          itemId: long(`item-${i % 2}`),
        },
        long(`command-${i}`),
      );
    expect(
      full
        .capture()
        .transactions.commands.slice(1)
        .every((c) => c.operations.length === 15),
    ).toBe(true);
    const saved = full.save();
    expect(new TextEncoder().encode(saved).length).toBeLessThanOrEqual(
      CHARACTER_SESSION_LIMITS.saveBytes,
    );
    const resumed = new CharacterSessionOwner(large, catalog);
    resumed.load(saved);
    expect(resumed.save()).toBe(saved);
  });
  it("checks eligibility against base stats and preserves an equipped item on rejection", () => {
    const raw: any = structuredClone(CHARACTER_ARENA_BUILDS);
    raw.items
      .find((x: any) => x.id === "sword")
      .modifiers.push({ statId: "health", delta: 10 });
    const s = new CharacterSessionOwner(raw, CHARACTER_ARENA_CATALOG);
    submit(s, create);
    submit(s, equip("sword"));
    expect(s.inspect().stats.find((x) => x.statId === "health")!.value).toBe(
      14,
    );
    const before = s.save();
    expect(() => submit(s, equip("heavy-sword"))).toThrow("requirement");
    expect(s.save()).toBe(before);
    const catalog: any = structuredClone(CHARACTER_ARENA_CATALOG);
    catalog.archetypes.push({ ...catalog.archetypes[0], id: "other" });
    raw.items.find((x: any) => x.id === "sword").archetypeIds = ["other"];
    const other = new CharacterSessionOwner(raw, catalog);
    submit(other, create);
    const original = other.save();
    expect(() => submit(other, equip("sword"))).toThrow("Ineligible");
    expect(other.save()).toBe(original);
  });
  it("rejects authored payloads above the reserved save budget before creating an owner", () => {
    const catalog: any = structuredClone(CHARACTER_ARENA_CATALOG);
    catalog.appearances = Array.from({ length: 256 }, (_, i) => ({
      ...catalog.appearances[0],
      id: i === 0 ? "warm" : i === 1 ? "cool" : `look-${i}`,
      partIds: Array.from(
        { length: 16 },
        (_, j) => `part-${j}-${"x".repeat(119)}`,
      ),
      paletteIds: Array.from(
        { length: 16 },
        (_, j) => `palette-${j}-${"x".repeat(116)}`,
      ),
    }));
    expect(
      () => new CharacterSessionOwner(CHARACTER_ARENA_BUILDS, catalog),
    ).toThrow("byte limit");
  });
  it("reaches the finite commit boundary, permits retry and rejects further changes", () => {
    const s = owner();
    submit(s, create);
    const first: CharacterSessionCommand = {
      id: "command-0",
      revision: 0,
      action: create,
    };
    for (let i = 1; i < CHARACTER_SESSION_LIMITS.commits; i++)
      submit(s, look(i % 2 ? "cool" : "warm"));
    const before = s.save();
    expect(s.execute(first)).toEqual({ id: "command-0", revision: 1 });
    expect(() => submit(s, look())).toThrow("commit cap");
    expect(s.save()).toBe(before);
    const other = owner();
    other.load(before);
    expect(other.save()).toBe(before);
  });
});
