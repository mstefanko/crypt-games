import { describe, it, expect } from "vitest";
import {
  authoringFields,
  AUTHORING_CAPABILITIES,
} from "./authoring-descriptors";
import { LevelSchema } from "./authoring";
describe("bounded authoring metadata", () => {
  it("derives field bounds from authoritative authoring schemas", () => {
    const fields = authoringFields("level");
    expect(fields.find((f) => f.path === "/width")?.limits.maximum).toBe(
      LevelSchema.properties.width.maximum,
    );
    expect(
      fields.find((f) => f.path === "/goal/nextLevelId")?.referenceKind,
    ).toBe("level");
    expect(fields.find((f) => f.path === "/spawns/*/x")?.transforms).toEqual([
      "translate-integer",
    ]);
    expect(Object.isFrozen(fields[0].limits)).toBe(true);
    expect(fields.every((f) => f.default.kind === "none")).toBe(true);
  });
  it("declares localization and mutation applicability without runtime resolver", () => {
    expect(AUTHORING_CAPABILITIES.localization.status).toContain(
      "authoring-only",
    );
    expect(AUTHORING_CAPABILITIES.platform.liveMutation).toBe(
      "restart-preview",
    );
  });
});

import duel from "../../../examples/game-m3/duel/definitions.json";
import { validateDefinitions } from "./validate";
import { validateAuthoringDefinitions } from "./authoring";
describe("descriptor validator agreement", () => {
  it("publishes selectable literals accepted by both validators and rejects other values", () => {
    const tile = authoringFields("level").find((f) => f.path === "/tileSize")!;
    expect(tile.allowedValues).toEqual([8, 16, 32]);
    const valid = validateDefinitions(duel);
    for (const value of tile.allowedValues!) {
      const candidate = structuredClone(valid);
      // Tile size changes need a correspondingly sized logical tile array.
      const level = candidate.levels[0] as unknown as {
        tileSize: number;
        tiles: number[];
        width: number;
        height: number;
      };
      level.tileSize = value as number;
      level.tiles = Array(
        (level.width / level.tileSize) * (level.height / level.tileSize),
      ).fill(0);
      expect(() => validateDefinitions(candidate)).not.toThrow();
      expect(() => validateAuthoringDefinitions(candidate)).not.toThrow();
    }
    const invalid = structuredClone(valid) as any;
    invalid.levels[0].tileSize = 12;
    expect(() => validateDefinitions(invalid)).toThrow();
    expect(() => validateAuthoringDefinitions(invalid)).toThrow();
    expect(
      authoringFields("scenario").find(
        (f) => f.path === "/actions/*/edges/*/action",
      )?.allowedValues,
    ).toContain("jump");
    expect(
      authoringFields("scenario").find(
        (f) => f.path === "/actions/*/edges/*/kind",
      )?.allowedValues,
    ).toEqual(["pressed", "released", "cancel"]);
  });
  it("distinguishes spatial distance, velocity, acceleration and time", () => {
    const fields = authoringFields("archetype");
    expect(fields.find((f) => f.path === "/speed")?.units).toContain("/tick (");
    expect(fields.find((f) => f.path === "/gravity")?.units).toContain(
      "/tick²",
    );
    expect(fields.find((f) => f.path === "/aiRange")?.units).toBe(
      "fixed point (256 units/pixel)",
    );
    expect(fields.find((f) => f.path === "/coyoteTicks")?.units).toBe(
      "60Hz ticks",
    );
  });
});

import { resolveAuthoringFieldLimits } from "./authoring-descriptors";
it("resolves semantic geometry bounds and nullable numeric metadata against validators", () => {
  const fields = authoringFields("level");
  const x = fields.find((f) => f.path === "/rectangles/*/x")!;
  const valid = validateDefinitions(duel);
  const rectangle = valid.levels[0].rectangles[0];
  const bounds = resolveAuthoringFieldLimits(x, {
    level: valid.levels[0],
    object: rectangle,
  });
  expect(bounds.minimum).toBe(0);
  expect(bounds.maximum).toBe(valid.levels[0].width * 256 - rectangle.width);
  for (const value of [-1, bounds.maximum! + 1]) {
    const invalid = structuredClone(duel);
    invalid.levels[0].rectangles[0].x = value;
    expect(() => validateDefinitions(invalid)).toThrow();
  }
  const slot = fields.find((f) => f.path === "/spawns/*/slot")!;
  expect(slot.nullable).toBe(true);
  expect(slot.limits).toEqual({ minimum: 0, maximum: 3 });
  const spawn = valid.levels[0].spawns[0];
  const archetype = valid.archetypes.find((a) => a.id === spawn.archetypeId)!;
  const spawnBounds = resolveAuthoringFieldLimits(
    fields.find((f) => f.path === "/spawns/*/x")!,
    { level: valid.levels[0], object: spawn, archetype },
  );
  expect(spawnBounds.minimum).toBe(Math.max(0, -archetype.body.x));
  expect(spawnBounds.maximum).toBe(
    valid.levels[0].width * 256 - archetype.body.x - archetype.body.width,
  );
  expect(fields.find((f) => f.path === "/deathY")?.transforms).toEqual([
    "translate-integer",
  ]);
  expect(
    authoringFields("archetype").find((f) => f.path === "/body/x")?.transforms,
  ).toEqual([]);
  expect(
    authoringFields("ability").find((f) => f.path === "/hit/x")?.transforms,
  ).toEqual([]);
});
