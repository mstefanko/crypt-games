import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { validateDefinitions, ValidationError } from "./validate";
import type { GameDefinitions } from "./types";

// Authoring-only JSON Schemas. Never imported by the production player or rules.
// Cross-document references and geometric invariants are checked by the codec
// after structural validation; JSON Schema cannot express those relationships.
const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const int = (maximum = 16777216, minimum = 0) =>
  Type.Integer({ minimum, maximum });
const id = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$" });
const list = (items: TSchema, maxItems: number, uniqueItems = false) =>
  Type.Array(items, { maxItems, uniqueItems });
const ids = (cap: number) => list(id, cap, true);
const action = Type.Union(
  ["left", "right", "jump", "attack", "heavy", "guard"].map((value) =>
    Type.Literal(value),
  ),
);
const rectFields = {
  x: int(16777216, -16777216),
  y: int(16777216, -16777216),
  width: int(65536, 1),
  height: int(65536, 1),
};
export const RectSchema = object(rectFields);
export const InputRecordSchema = object({
  tick: int(Number.MAX_SAFE_INTEGER),
  slot: int(3),
  sequence: int(Number.MAX_SAFE_INTEGER),
  heldPatch: Type.Optional(
    object(
      Object.fromEntries(
        ["left", "right", "jump", "attack", "heavy", "guard"].map((key) => [
          key,
          Type.Optional(Type.Boolean()),
        ]),
      ),
    ),
  ),
  axesPatch: Type.Optional(object({ moveX: Type.Optional(int(127, -127)) })),
  edges: list(
    object({
      action,
      kind: Type.Union([
        Type.Literal("pressed"),
        Type.Literal("released"),
        Type.Literal("cancel"),
      ]),
    }),
    32,
  ),
});
export const ManifestSchema = object({
  schemaVersion: Type.Literal(1),
  gameId: id,
  title: Type.String({ maxLength: 120 }),
  rulesModule: Type.Literal("platform-combat-v1"),
  initialLevelId: id,
  initialScenarioId: id,
  levelIds: ids(64),
  archetypeIds: ids(256),
  abilityIds: ids(256),
  scenarioIds: ids(128),
  viewport: object({ width: int(1024, 64), height: int(1024, 64) }),
});
export const LevelSchema = object({
  id,
  width: int(65536, 8),
  height: int(65536, 8),
  tileSize: Type.Union([Type.Literal(8), Type.Literal(16), Type.Literal(32)]),
  tiles: list(int(2), 1048576),
  rectangles: list(object({ id, ...rectFields, oneWay: Type.Boolean() }), 1024),
  platforms: list(
    object({ id, ...rectFields, endX: int(), speed: int(1024, 1) }),
    32,
  ),
  spawns: list(
    object({
      id,
      archetypeId: id,
      x: int(),
      y: int(),
      slot: Type.Union([Type.Null(), int(3)]),
      team: int(255),
      facing: Type.Union([Type.Literal(-1), Type.Literal(1)]),
    }),
    256,
  ),
  goal: object({ ...rectFields, nextLevelId: Type.Union([Type.Null(), id]) }),
  deathY: int(),
});
export const ArchetypeSchema = object({
  id,
  body: RectSchema,
  hurt: RectSchema,
  push: RectSchema,
  health: int(10000, 1),
  speed: int(8192, 1),
  jumpSpeed: int(8192, 1),
  gravity: int(8192, 1),
  maxFallSpeed: int(8192, 1),
  coyoteTicks: int(60),
  jumpBufferTicks: int(60, 1),
  attackBufferTicks: int(60, 1),
  abilities: ids(2),
  ai: Type.Union([Type.Literal("none"), Type.Literal("patrol")]),
  aiRange: int(),
});
export const AbilitySchema = object({
  id,
  startup: int(600),
  active: int(600, 1),
  recovery: int(600),
  hit: RectSchema,
  damage: int(1000, 1),
  knockbackX: int(8192),
  knockbackY: int(8192, -8192),
  stunTicks: int(600),
  hitStopTicks: int(60),
  guardDamage: int(1000),
  maxHits: int(8, 1),
  rehitTicks: int(600, 1),
});
// Depth/aggregate node limits are enforced by the shared semantic validator.
export const AssertionValueSchema = Type.Recursive((Self) =>
  Type.Union([
    Type.Null(),
    Type.String({ maxLength: 512 }),
    Type.Boolean(),
    int(Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER),
    Type.Array(Self, { maxItems: 256 }),
    Type.Record(
      Type.String({
        maxLength: 128,
        pattern: "^(?!(?:__proto__|constructor|prototype)$)[\\s\\S]{0,128}$",
      }),
      Self,
      { maxProperties: 256, additionalProperties: false },
    ),
  ]),
);
export const ScenarioSchema = object({
  id,
  levelId: id,
  seed: int(4294967295),
  playerSlots: list(int(3), 4, true),
  ticks: int(200000),
  actions: list(InputRecordSchema, 200000),
  commands: Type.Optional(
    list(object({ tick: int(199999), type: Type.Literal("restart") }), 1024),
  ),
  assertions: list(
    object({
      tick: int(200000),
      path: Type.String({ maxLength: 256, pattern: "^[a-zA-Z0-9./_-]+$" }),
      equals: AssertionValueSchema,
    }),
    1024,
  ),
});
export const GameDefinitionsSchema = object({
  manifest: ManifestSchema,
  levels: list(LevelSchema, 64),
  archetypes: list(ArchetypeSchema, 256),
  abilities: list(AbilitySchema, 256),
  scenarios: list(ScenarioSchema, 128),
});
export const GAME_DOCUMENT_KINDS = [
  "manifest",
  "level",
  "archetype",
  "ability",
  "scenario",
] as const;

/** Interpreter-based authoring validation with structured pointer diagnostics. */
export function validateAuthoringDefinitions(raw: unknown): GameDefinitions {
  const errors = [...Value.Errors(GameDefinitionsSchema, raw)];
  if (errors.length) {
    const error = new ValidationError(
      `${errors[0].path}: ${errors[0].message}`,
    );
    throw error;
  }
  return validateDefinitions(raw);
}
