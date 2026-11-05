import { createWorld, step } from "../../game-simulation/src/simulation";
import { serializeCheckpoint } from "../../game-simulation/src/checkpoint";
import {
  createArena,
  stepArena,
  encodeArenaCheckpoint,
} from "../../game-simulation/src/m3/arena";
import { validateDefinitions } from "./validate";
import { describe, expect, it } from "vitest";
import content from "../../../examples/game-m1/definitions.json";
import { DEFAULT_ARENA_DEFINITION as arena } from "../../../examples/game-m3/project";
import {
  validateCharacterCatalog,
  characterAuthority,
  inspectCharacter,
  CharacterValidationError,
  CHARACTER_LIMITS,
  type CharacterReferences,
} from "./character";
import { canonical } from "./runtime";

const refs: CharacterReferences = {
  definitions: {
    "platform-combat-v1": content.archetypes.map((x) => x.id),
    "arena-v1": [arena.id],
  },
  placements: {
    "platform-combat-v1": content.levels[0].spawns.map((x) => x.id),
    "arena-v1": ["arena-player"],
  },
  assets: ["lantern-atlas"],
  parts: ["body"],
  palettes: ["warm", "cool"],
  portraits: [],
  animationSets: {
    "platform-combat-v1": ["lantern-platform"],
    "arena-v1": ["lantern-arena"],
  },
};
const raw = () => ({
  schemaVersion: 1,
  archetypes: [
    {
      id: "platform-hero",
      controller: "platform-combat-v1",
      definitionId: content.archetypes[0].id,
    },
    { id: "arena-hero", controller: "arena-v1", definitionId: arena.id },
  ],
  appearances: ["warm", "cool"].map((palette) => ({
    id: palette,
    assetId: "lantern-atlas",
    partIds: ["body"],
    paletteIds: [palette],
    portraitId: null,
    displayName: "Hero",
    animations: {
      "platform-combat-v1": "lantern-platform",
      "arena-v1": "lantern-arena",
    },
  })),
  bindings: [
    {
      placementId: content.levels[0].spawns[0].id,
      archetypeId: "platform-hero",
      appearanceId: "warm",
    },
    {
      placementId: "arena-player",
      archetypeId: "arena-hero",
      appearanceId: "warm",
    },
  ],
});

describe("C0 character ownership", () => {
  it("binds real platform/arena definitions and shares appearance with distinct animation sets", () => {
    const catalog = validateCharacterCatalog(raw(), refs);
    expect(inspectCharacter(catalog, "arena-v1", "arena-player")).toMatchObject(
      {
        controller: "arena-v1",
        definitionId: arena.id,
        animationSetId: "lantern-arena",
        owners: { body: "profile-definition", motion: "exact-checkpoint" },
      },
    );
    expect(
      inspectCharacter(
        catalog,
        "platform-combat-v1",
        catalog.bindings[0].placementId,
      ).animationSetId,
    ).toBe("lantern-platform");
    const before = canonical(characterAuthority(catalog));
    const swapped = raw();
    swapped.bindings.forEach((x) => (x.appearanceId = "cool"));
    swapped.appearances[1].displayName = "Different name";
    expect(
      canonical(characterAuthority(validateCharacterCatalog(swapped, refs))),
    ).toBe(before);
    expect(content.archetypes[0].body).toBeDefined();
    expect(arena.player.width).toBeGreaterThan(0);
  });
  it("keeps exact platform and arena gameplay bytes through per-placement cosmetic swaps", () => {
    const definitions = validateDefinitions(content);
    const identity = { rulesBuildId: "source:test", contentId: "content:test" };
    const platform = [
      createWorld(definitions, identity),
      createWorld(definitions, identity),
    ];
    const arenas = [
      createArena(arena, { ...identity, gameId: "test" }),
      createArena(arena, { ...identity, gameId: "test" }),
    ];
    let selection = validateCharacterCatalog(raw(), refs);
    for (let tick = 0; tick < 120; tick++) {
      if (tick === 30) {
        const swapped = raw();
        swapped.bindings.forEach((x) => (x.appearanceId = "cool"));
        selection = validateCharacterCatalog(swapped, refs);
      }
      // A presenter reads selection; authoritative motors receive their existing definitions/inputs only.
      inspectCharacter(selection, "arena-v1", "arena-player");
      platform.forEach((world) => step(world));
      arenas.forEach((world) =>
        stepArena(world, {
          moveX: 0,
          moveY: 0,
          aim: 0,
          fire: tick % 5 === 0,
          dash: false,
          shove: false,
        }),
      );
      expect(serializeCheckpoint(platform[1])).toBe(
        serializeCheckpoint(platform[0]),
      );
      expect(encodeArenaCheckpoint(arenas[1])).toBe(
        encodeArenaCheckpoint(arenas[0]),
      );
    }
  });
  it.each(["platform-combat-v1", "arena-v1"] as const)(
    "accepts a %s only appearance",
    (controller) => {
      const source = raw();
      source.archetypes = source.archetypes.filter(
        (x) => x.controller === controller,
      );
      source.bindings = source.bindings.filter(
        (x) => x.archetypeId === source.archetypes[0].id,
      );
      source.appearances.forEach((x) => {
        x.animations = {
          [controller]: x.animations[controller],
        } as typeof x.animations;
      });
      expect(() => validateCharacterCatalog(source, refs)).not.toThrow();
    },
  );
  it("addresses missing required animation at the appearance mapping", () => {
    const source = raw();
    delete (
      source.appearances[0].animations as Partial<Record<string, string>>
    )["arena-v1"];
    expect(() => validateCharacterCatalog(source, refs)).toThrow(
      CharacterValidationError,
    );
    try {
      validateCharacterCatalog(source, refs);
    } catch (error) {
      expect(
        (error as CharacterValidationError).diagnostics[0].jsonPointer,
      ).toBe("/appearances/0/animations/arena-v1");
    }
  });
  it("scopes equal placement names by controller in validation, projection and inspection", () => {
    const source = raw();
    source.bindings.forEach((x) => (x.placementId = "player"));
    const scopedRefs = {
      ...refs,
      placements: { "platform-combat-v1": ["player"], "arena-v1": ["player"] },
    };
    const catalog = validateCharacterCatalog(source, scopedRefs);
    expect(
      inspectCharacter(catalog, "platform-combat-v1", "player").definitionId,
    ).toBe(content.archetypes[0].id);
    expect(inspectCharacter(catalog, "arena-v1", "player").definitionId).toBe(
      arena.id,
    );
    expect(
      characterAuthority(catalog).bindings.map((x) => x.controller),
    ).toEqual(["arena-v1", "platform-combat-v1"]);
    expect(() => inspectCharacter(catalog, "arena-v1", "missing")).toThrow(
      "Unknown character placement arena-v1:missing",
    );
  });
  it("rejects two owners of the same placement within a controller", () => {
    const source = raw();
    source.bindings.push({ ...source.bindings[0], appearanceId: "cool" });
    try {
      validateCharacterCatalog(source, refs);
      throw Error("Expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CharacterValidationError);
      expect(
        (error as CharacterValidationError).diagnostics[0].jsonPointer,
      ).toBe("/bindings/2/placementId");
    }
  });
  it.each([
    "archetypes",
    "appearances",
    "bindings",
    "parts",
    "palettes",
    "displayName",
  ] as const)("accepts maximum and rejects maximum+1 for %s", (cap) => {
    const make = (size: number) => {
      const source = raw();
      const available = { ...refs, placements: { ...refs.placements } };
      let pointer = `/${cap}`;
      if (cap === "archetypes") {
        source.archetypes = Array.from({ length: size }, (_, i) => ({
          ...source.archetypes[0],
          id: `archetype-${i}`,
        }));
        source.bindings = [];
      } else if (cap === "appearances") {
        source.appearances = Array.from({ length: size }, (_, i) => ({
          ...source.appearances[0],
          id: `appearance-${i}`,
        }));
        source.bindings.forEach((x) => (x.appearanceId = "appearance-0"));
      } else if (cap === "bindings") {
        source.bindings = Array.from({ length: size }, (_, i) => ({
          ...source.bindings[0],
          placementId: `placement-${i}`,
        }));
        available.placements["platform-combat-v1"] = source.bindings.map(
          (x) => x.placementId,
        );
      } else if (cap === "parts" || cap === "palettes") {
        const ids = Array.from({ length: size }, (_, i) => `selection-${i}`);
        if (cap === "parts") {
          source.appearances[0].partIds = ids;
          available.parts = [...refs.parts, ...ids];
          pointer = "/appearances/0/partIds";
        } else {
          source.appearances[0].paletteIds = ids;
          available.palettes = [...refs.palettes, ...ids];
          pointer = "/appearances/0/paletteIds";
        }
      } else {
        source.appearances[0].displayName = "é".repeat(size);
        pointer = "/appearances/0/displayName";
      }
      return { source, available, pointer };
    };
    const valid = make(CHARACTER_LIMITS[cap]);
    expect(() =>
      validateCharacterCatalog(valid.source, valid.available),
    ).not.toThrow();
    const invalid = make(CHARACTER_LIMITS[cap] + 1);
    try {
      validateCharacterCatalog(invalid.source, invalid.available);
      throw Error("Expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CharacterValidationError);
      expect(
        (error as CharacterValidationError).diagnostics[0].jsonPointer,
      ).toBe(invalid.pointer);
    }
  });
  it("rejects a placement belonging only to the other controller", () => {
    const source = raw();
    source.bindings[0].placementId = "arena-player";
    try {
      validateCharacterCatalog(source, refs);
      throw Error("Expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CharacterValidationError);
      expect(
        (error as CharacterValidationError).diagnostics[0].jsonPointer,
      ).toBe("/bindings/0/placementId");
    }
  });
  it("projects source permutations identically using code-unit controller and placement ordering", () => {
    const source = raw();
    const available = {
      ...refs,
      placements: { ...refs.placements, "arena-v1": ["z", "A", "a"] },
    };
    source.bindings = source.bindings
      .filter((x) => x.archetypeId === "platform-hero")
      .concat(
        ["z", "A", "a"].map((placementId) => ({
          placementId,
          archetypeId: "arena-hero",
          appearanceId: "warm",
        })),
      );
    const catalog = validateCharacterCatalog(source, available);
    const before = canonical(characterAuthority(catalog));
    source.archetypes.reverse();
    source.bindings.reverse();
    source.appearances.reverse();
    expect(
      canonical(
        characterAuthority(validateCharacterCatalog(source, available)),
      ),
    ).toBe(before);
    expect(characterAuthority(catalog).archetypes.map((x) => x.id)).toEqual([
      "arena-hero",
      "platform-hero",
    ]);
    expect(
      characterAuthority(catalog)
        .bindings.slice(0, 3)
        .map((x) => x.placementId),
    ).toEqual(["A", "a", "z"]);
    expect(catalog.bindings.map((x) => x.placementId)).toEqual([
      source.bindings[source.bindings.length - 1].placementId,
      "z",
      "A",
      "a",
    ]);
  });
  it("preserves selected cosmetic part order", () => {
    const source = raw();
    source.appearances[0].partIds = ["top", "base"];
    expect(
      validateCharacterCatalog(source, {
        ...refs,
        parts: ["body", "base", "top"],
      }).appearances[0].partIds,
    ).toEqual(["top", "base"]);
  });
  it.each([
    "\u0080",
    "\u0085",
    "\u009f",
    "\u061c",
    "\u200e",
    "\u200f",
    "\u202a",
    "\u202b",
    "\u202c",
    "\u202d",
    "\u202e",
    "\u2066",
    "\u2067",
    "\u2068",
    "\u2069",
  ])("rejects display-name control %j", (control) => {
    const source = raw();
    source.appearances[0].displayName = `Hero${control}`;
    try {
      validateCharacterCatalog(source, refs);
      throw Error("Expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CharacterValidationError);
      expect(
        (error as CharacterValidationError).diagnostics[0].jsonPointer,
      ).toBe("/appearances/0/displayName");
    }
  });
  it.each(["Élodie", "مريم", "דנה", "春香", "नंदिनी", "🦊 Hero"])(
    "preserves legitimate multilingual display name %s",
    (displayName) => {
      const source = raw();
      source.appearances[0].displayName = displayName;
      expect(
        validateCharacterCatalog(source, refs).appearances[0].displayName,
      ).toBe(displayName);
    },
  );
  it("copies selections without aliasing source arrays", () => {
    const source = raw();
    const prepared = validateCharacterCatalog(source, refs);
    source.appearances[0].partIds.length = 0;
    expect(prepared.appearances[0].partIds).toEqual(["body"]);
  });
  it.each([
    [
      "/archetypes/0/definitionId",
      (x: any) => (x.archetypes[0].definitionId = "missing"),
    ],
    [
      "/archetypes/0/controller",
      (x: any) => (x.archetypes[0].controller = "flying"),
    ],
    ["/appearances/0", (x: any) => (x.appearances[0].health = 999)],
    [
      "/appearances/0/partIds",
      (x: any) => (x.appearances[0].partIds = ["body", "body"]),
    ],
    [
      "/appearances/0/paletteIds/0",
      (x: any) => (x.appearances[0].paletteIds = ["missing"]),
    ],
    [
      "/appearances/0/animations/arena-v1",
      (x: any) => (x.appearances[0].animations["arena-v1"] = "missing"),
    ],
    [
      "/appearances/0/displayName",
      (x: any) => (x.appearances[0].displayName = "a".repeat(65)),
    ],
    [
      "/bindings/0/archetypeId",
      (x: any) => (x.bindings[0].archetypeId = "missing"),
    ],
    [
      "/bindings/1/placementId",
      (x: any) => (x.bindings[1].placementId = x.bindings[0].placementId),
    ],
    ["/archetypes/1/id", (x: any) => (x.archetypes[1].id = x.archetypes[0].id)],
    [
      "/appearances",
      (x: any) => (x.appearances = Array(257).fill(x.appearances[0])),
    ],
  ])("rejects invalid ownership at %s", (pointer, mutate) => {
    const source = raw();
    mutate(source);
    try {
      validateCharacterCatalog(source, refs, "characters/hero.json");
      throw Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CharacterValidationError);
      expect((error as CharacterValidationError).diagnostics[0]).toMatchObject({
        file: "characters/hero.json",
        jsonPointer: pointer,
        severity: "error",
      });
    }
  });
});
