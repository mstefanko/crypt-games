import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { expect, it } from "vitest";
import content from "../../../examples/game-m1/definitions.json";
import { validateDefinitions } from "./index";
import {
  createWorld,
  restoreCheckpoint,
  serializeCheckpoint,
  step,
} from "../../game-simulation/src/index";

// Independent structural JSON Schema oracle. It is deliberately test-only: the
// player uses the hand-written codec, including cross-reference/geometry checks.
const obj = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const n = (max = Number.MAX_SAFE_INTEGER, min = 0) =>
  Type.Integer({ minimum: min, maximum: max });
const id = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$" });
const nullable = (schema: TSchema) => Type.Union([Type.Null(), schema]);
const direction = Type.Union([Type.Literal(-1), Type.Literal(1)]);
const held = obj(
  Object.fromEntries(
    ["left", "right", "jump", "attack", "heavy", "guard"].map((key) => [
      key,
      Type.Boolean(),
    ]),
  ),
);
const execution = obj({
  id: n(Number.MAX_SAFE_INTEGER, 1),
  abilityId: id,
  tick: n(1799),
  hits: Type.Array(
    obj({
      targetId: n(Number.MAX_SAFE_INTEGER, 1),
      count: n(8, 1),
      lastTick: n(),
    }),
    { maxItems: 256 },
  ),
});
const actor = obj({
  id: n(Number.MAX_SAFE_INTEGER, 1),
  spawnId: id,
  archetypeId: id,
  slot: nullable(n(3)),
  team: n(255),
  x: n(16777216, -16777216),
  y: n(16777216, -16777216),
  vx: n(8192, -8192),
  vy: n(8192, -8192),
  facing: direction,
  health: n(10000),
  grounded: Type.Boolean(),
  coyoteTicks: n(60),
  jumpBuffer: n(60),
  attackBuffer: n(60),
  bufferedAbility: nullable(id),
  freezeTicks: n(60),
  stunTicks: n(600),
  motionEpoch: n(Number.MAX_SAFE_INTEGER, 1),
  riderId: nullable(id),
  execution: nullable(execution),
  ai: obj({ direction, decisionTicks: n() }),
});
const snapshot = obj({
  snapshotVersion: Type.Literal(1),
  gameId: id,
  rulesBuildId: id,
  contentId: id,
  scenarioId: id,
  initialPlayerSlots: Type.Array(n(3), { maxItems: 4, uniqueItems: true }),
  tick: n(),
  levelId: id,
  status: Type.Union([
    Type.Literal("playing"),
    Type.Literal("won"),
    Type.Literal("lost"),
  ]),
  actors: Type.Array(actor, { maxItems: 256 }),
  platforms: Type.Array(
    obj({
      id,
      x: n(16777216),
      y: n(16777216),
      direction,
      blocked: Type.Boolean(),
    }),
    { maxItems: 32 },
  ),
  decoder: obj({
    slots: Type.Array(obj({ held, axes: obj({ moveX: n(127, -127) }) }), {
      minItems: 4,
      maxItems: 4,
    }),
    lastTick: n(Number.MAX_SAFE_INTEGER, -1),
  }),
  rng: n(4294967295),
  nextEntityId: n(Number.MAX_SAFE_INTEGER, 1),
  nextExecutionId: n(Number.MAX_SAFE_INTEGER, 1),
  motionEpochCounter: n(Number.MAX_SAFE_INTEGER, 1),
  campaign: obj({
    visitedLevelIds: Type.Array(id, { maxItems: 64, uniqueItems: true }),
    defeatedPlacementIds: Type.Array(Type.String({ maxLength: 520 }), {
      maxItems: 1024,
      uniqueItems: true,
    }),
  }),
});
const definitions = validateDefinitions(content);
const identity = { rulesBuildId: "schema-test", contentId: "schema-content" };
function fresh() {
  return JSON.parse(serializeCheckpoint(createWorld(definitions, identity)));
}
function set(value: Record<string, any>, path: string, replacement: unknown) {
  const keys = path.split("/");
  for (const key of keys.slice(0, -1)) value = value[key];
  value[keys.at(-1)!] = replacement;
}

it("checkpoint schema and hand-written codec accept the same live canonical snapshots", () => {
  const world = createWorld(definitions, identity);
  for (let tick = 0; tick < 240; tick++) {
    const bytes = serializeCheckpoint(world);
    expect(Value.Check(snapshot, JSON.parse(bytes))).toBe(true);
    expect(
      serializeCheckpoint(restoreCheckpoint(definitions, identity, bytes)),
    ).toBe(bytes);
    step(world);
  }
});
it.each([
  ["snapshotVersion", 2],
  ["tick", -1],
  ["tick", 1.5],
  ["actors/0/motionEpoch", 0],
  ["motionEpochCounter", 0],
  ["rng", 4294967296],
  ["actors/0/x", 16777217],
  ["actors/0/vy", -8193],
  ["actors/0/health", 10001],
  ["actors/0/freezeTicks", 61],
  ["actors/0/stunTicks", 601],
  ["actors/0/facing", 0],
  ["actors/0/grounded", 1],
  ["actors/0/ai/decisionTicks", Number.MAX_SAFE_INTEGER + 1],
  ["decoder/slots/0/axes/moveX", 128],
  ["decoder/slots/0/held/jump", "yes"],
  ["nextEntityId", 0],
  ["platforms/0/blocked", 1],
  ["surprise", true],
  ["actors/0/surprise", true],
  ["decoder/slots/0/axes/surprise", true],
])("schema and codec reject malformed checkpoint /%s", (path, replacement) => {
  const raw = fresh();
  set(raw, path as string, replacement);
  expect(Value.Check(snapshot, raw)).toBe(false);
  expect(() =>
    restoreCheckpoint(definitions, identity, JSON.stringify(raw)),
  ).toThrow();
});
it("codec additionally rejects missing references allowed structurally by JSON Schema", () => {
  const raw = fresh();
  raw.actors[0].archetypeId = "missing";
  expect(Value.Check(snapshot, raw)).toBe(true);
  expect(() =>
    restoreCheckpoint(definitions, identity, JSON.stringify(raw)),
  ).toThrow();
});
