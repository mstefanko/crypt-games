import { describe, expect, it } from "vitest";
import adventure from "../../../examples/game-m3/adventure/definitions.json";
import level from "../../../examples/game-m1/levels/room-1.json";
import {
  deletionImpact,
  duplicateAuthoringDocuments,
  extractAuthoringResources,
  resourceKey,
  sourceForResource,
  validateLocalizationResource,
  type AuthoringDocument,
} from "./authoring-resources";
const adventureDocument: AuthoringDocument = {
  file: "adventure.json",
  kind: "adventure",
  value: adventure,
};
describe("authoring resource index", () => {
  it("extracts current adventure entrance travel and deletion impact with source mappings", () => {
    const graph = extractAuthoringResources([adventureDocument]);
    expect(graph.diagnostics).toEqual([]);
    const entrance = {
      kind: "entrance" as const,
      id: "door",
      owner: resourceKey({ kind: "map", id: "lodge" }),
    };
    expect(sourceForResource(graph, entrance)).toEqual({
      file: "adventure.json",
      jsonPointer: "/maps/1/entrances/0",
    });
    expect(
      deletionImpact(graph, [entrance]).map((r) => r.source.jsonPointer),
    ).toEqual(["/maps/0/exits/0/entranceId"]);
    expect(
      deletionImpact(graph, [{ kind: "map", id: "lodge" }]).map(
        (r) => r.source.jsonPointer,
      ),
    ).toEqual(["/maps/0/exits/0/mapId", "/maps/0/exits/0/entranceId"]);
  });
  it("copies current adventure maps, placements and internal travel without mutating source", () => {
    const result = duplicateAuthoringDocuments(
      [adventureDocument],
      (identity) => `${identity.id}-copy`,
    );
    expect(result.graph.diagnostics).toEqual([]);
    const copy = result.documents[0].value as typeof adventure;
    expect(copy.maps[0].exits[0]).toMatchObject({
      id: "to-lodge-copy",
      mapId: "lodge-copy",
      entranceId: "door-copy",
    });
    expect(copy.maps[1].dialogues[0].flag).toBe("flower-found-copy");
    expect(copy.maps[0].pickups[0].effects.flags).toEqual({
      "flower-found-copy": true,
    });
    expect(adventure.maps[0].id).toBe("meadow");
  });
  it("copies platform placements and reports explicitly retained external references", () => {
    const result = duplicateAuthoringDocuments(
      [{ file: "room.json", kind: "platform-level", value: level }],
      (identity) => `${identity.id}-copy`,
    );
    const copy = result.documents[0].value as typeof level;
    expect(copy.id).toBe(`${level.id}-copy`);
    expect(copy.spawns[0].id).toBe(`${level.spawns[0].id}-copy`);
    expect(copy.spawns[0].archetypeId).toBe(level.spawns[0].archetypeId);
    expect(
      result.retainedReferences.some((r) => r.to.kind === "archetype"),
    ).toBe(true);
    expect(() =>
      duplicateAuthoringDocuments(
        [{ file: "room.json", kind: "platform-level", value: level }],
        (i) => i.id,
      ),
    ).toThrow(/fresh/);
  });
  it("rejects ambiguous identities, duplicate files and oversized inputs", () => {
    expect(() =>
      extractAuthoringResources([adventureDocument, adventureDocument]),
    ).toThrow(/Duplicate source/);
    expect(() =>
      extractAuthoringResources(Array(513).fill(adventureDocument)),
    ).toThrow(/limit/);
    expect(() =>
      duplicateAuthoringDocuments(
        [adventureDocument, { ...adventureDocument, file: "other.json" }],
        (i) => `${i.id}-copy`,
      ),
    ).toThrow(/ambiguous/);
  });
  it("indexes locale strings independently from gameplay identifiers", () => {
    const graph = extractAuthoringResources([
      {
        file: "strings.json",
        kind: "localization",
        value: {
          strings: [
            {
              id: "greeting",
              fallbackLocale: "en",
              arguments: { name: "string" },
              locales: { en: "Hello {name}" },
            },
          ],
        },
      },
    ]);
    expect(graph.resources[0].identity.kind).toBe("localizable-string");
  });
  it("prefixes bundled sources and preserves identity through source movement", () => {
    const graph = extractAuthoringResources([
      {
        ...adventureDocument,
        file: "bundle.json",
        pointerPrefix: "/adventure",
      },
    ]);
    expect(graph.resources[0].identityPointer).toBe("/adventure/gameId");
    expect(graph.references[0].source.jsonPointer).toBe(
      "/adventure/initial/mapId",
    );
    expect(graph.resources.map((r) => resourceKey(r.identity))).toEqual(
      extractAuthoringResources([adventureDocument]).resources.map((r) =>
        resourceKey(r.identity),
      ),
    );
  });
  it("rejects malformed localization fallback and interpolation declarations", () => {
    expect(() =>
      validateLocalizationResource({
        id: "hello",
        fallbackLocale: "en",
        arguments: { name: "string" },
        locales: { fr: "Hi {name}" },
      }),
    ).toThrow(/contract/);
    expect(() =>
      validateLocalizationResource({
        id: "hello",
        fallbackLocale: "en",
        arguments: { name: "string" },
        locales: { en: "Hi {unknown}" },
      }),
    ).toThrow(/arguments/);
    expect(() =>
      extractAuthoringResources([
        { file: "bad.json", kind: "platform-level", value: { id: "bad" } },
      ]),
    ).toThrow();
  });
});

import duel from "../../../examples/game-m3/duel/definitions.json";
import { validateDefinitions } from "./validate";
import {
  validateAdventureDefinitions,
  type AdventureDefinitions,
} from "../../game-simulation/src/m3/adventure";
it("keeps runtime-valid cross-array IDs distinct and copies them independently", () => {
  const platform = structuredClone(duel);
  platform.levels[0].spawns[0].id = platform.levels[0].rectangles[0].id;
  expect(() => validateDefinitions(platform)).not.toThrow();
  const document: AuthoringDocument = {
    file: "room.json",
    kind: "platform-level",
    value: platform.levels[0],
  };
  const graph = extractAuthoringResources([document]);
  expect(
    graph.diagnostics.filter((d) => d.code === "duplicate-resource"),
  ).toEqual([]);
  const shared = platform.levels[0].spawns[0].id;
  const owner = resourceKey({ kind: "level", id: platform.levels[0].id });
  expect(
    sourceForResource(graph, { kind: "spawn", id: shared, owner })?.jsonPointer,
  ).toBe("/spawns/0");
  expect(
    sourceForResource(graph, { kind: "rectangle", id: shared, owner })
      ?.jsonPointer,
  ).toBe("/rectangles/0");
  const copied = duplicateAuthoringDocuments(
    [document],
    (i) => `${i.id}-${i.kind}-copy`,
  );
  expect(
    copied.retainedReferences.every((r) =>
      copied.graph.resources.some(
        (resource) => resourceKey(resource.identity) === resourceKey(r.from),
      ),
    ),
  ).toBe(true);
  const adventureCopy = structuredClone(adventure);
  adventureCopy.maps[0].pickups[0].id = adventureCopy.maps[0].exits[0].id;
  adventureCopy.maps[1].dialogues[0].id = adventureCopy.maps[1].exits[0].id;
  expect(() =>
    validateAdventureDefinitions({ ...adventureCopy, compatibilityVersion: 1 }),
  ).not.toThrow();
  const copiedAdventure = duplicateAuthoringDocuments(
    [{ ...adventureDocument, value: adventureCopy }],
    (i) => `${i.id}-${i.kind}-copy`,
  );
  expect(copiedAdventure.graph.diagnostics).toEqual([]);
  expect(() =>
    validateAdventureDefinitions(
      copiedAdventure.documents[0].value as AdventureDefinitions,
    ),
  ).not.toThrow();
});
it("uses locale-independent code-unit copy allocation and rejects prototype mutation", () => {
  const ids: string[] = [];
  duplicateAuthoringDocuments([adventureDocument], (i) => {
    ids.push(resourceKey(i));
    return `${i.id}-copy`;
  });
  expect(ids).toEqual([...ids].sort());
  expect(() =>
    duplicateAuthoringDocuments([adventureDocument], (i) =>
      i.kind === "flag" && i.id === "flower-found"
        ? "__proto__"
        : `${i.id}-copy`,
    ),
  ).toThrow(/Unsafe/);
  expect(Object.getPrototypeOf({})).toBe(Object.prototype);
});

it("tracks exit capability references through deletion impact and flag remapping", () => {
  const gated = structuredClone(adventure) as unknown as AdventureDefinitions;
  const value = {
    ...gated,
    maps: gated.maps.map((map, index) =>
      index
        ? map
        : {
            ...map,
            exits: map.exits.map((exit) => ({
              ...exit,
              requiresFlags: ["flower-found"],
            })),
          },
    ),
  };
  validateAdventureDefinitions(value);
  const input = [{ ...adventureDocument, value }];
  const graph = extractAuthoringResources(input);
  expect(graph.diagnostics).toEqual([]);
  expect(
    deletionImpact(graph, [{ kind: "flag", id: "flower-found" }]).some(
      (reference) =>
        reference.source.jsonPointer === "/maps/0/exits/0/requiresFlags/0",
    ),
  ).toBe(true);
  const copied = duplicateAuthoringDocuments(
    input,
    (identity) => `${identity.id}-copy`,
  );
  const remapped = copied.documents[0].value as AdventureDefinitions;
  expect(remapped.maps[0].exits[0].requiresFlags).toEqual([
    "flower-found-copy",
  ]);
  expect(() => validateAdventureDefinitions(remapped)).not.toThrow();
});

it("reports malformed exit requirements with a source diagnostic instead of throwing TypeError", () => {
  for (const requiresFlags of [
    "flower-found",
    null,
    {},
    [1],
    ["bad id"],
    ["flower-found", "flower-found"],
    Array(9).fill("flower-found"),
    new Array(1),
  ]) {
    const malformed = structuredClone(adventure) as any;
    malformed.maps[0].exits[0].requiresFlags = requiresFlags;
    const graph = extractAuthoringResources([
      { ...adventureDocument, pointerPrefix: "/adventure", value: malformed },
    ]);
    expect(graph.diagnostics).toContainEqual({
      code: "invalid-exit-requirements",
      source: {
        file: "adventure.json",
        jsonPointer: "/adventure/maps/0/exits/0/requiresFlags",
      },
      message:
        "Exit requiresFlags must be an array of at most eight distinct stable flag IDs",
    });
    expect(
      graph.references.some((reference) =>
        reference.source.jsonPointer.includes("requiresFlags"),
      ),
    ).toBe(false);
  }
});
