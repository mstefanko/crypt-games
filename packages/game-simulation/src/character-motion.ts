/** Bounded character adapter for the arena authority. No second motor or velocity owner. */
import { validateCharacterCatalog, type CharacterCatalog } from "@onepage/game-project/characters";
import { boundedJSON, canonical, record } from "@onepage/game-project/runtime";
import {
  createArena, encodeArenaCheckpoint, observeArena, restoreArenaCheckpoint,
  stepArena, validateArenaDefinition, type ArenaInput, type ArenaWorld,
} from "./m3/arena";

/** Prepared catalog + live profile world are trusted owner inputs, never visual bounds. */
export function inspectCharacterArenaMotion(world: ArenaWorld, catalog: CharacterCatalog, placementId: string) {
  const binding = catalog.bindings.find(b => b.placementId === placementId &&
    catalog.archetypes.some(a => a.id === b.archetypeId && a.controller === "arena-v1"));
  const archetype = catalog.archetypes.find(a => a.id === binding?.archetypeId);
  const actor = world.actors.find(a => a.spawnId === placementId);
  const spawn = [world.definition.player, ...world.definition.enemies].find(s => s.id === placementId);
  if (!archetype || archetype.definitionId !== world.definition.id || !actor || !spawn ||
      actor.width !== spawn.width || actor.height !== spawn.height)
    throw Error("Character arena controller/body mismatch");
  return {
    controller: "arena-v1" as const, definitionId: archetype.definitionId,
    placementId, entityId: actor.id,
    owners: { motion: "arena-v1", body: "profile-definition", hurt: "profile-definition", damage: "arena-v1" } as const,
    // Arena body and hurt region intentionally coincide. Appearance cannot supply either.
    body: { x: actor.x, y: actor.y, width: spawn.width, height: spawn.height },
    hurt: { x: actor.x, y: actor.y, width: spawn.width, height: spawn.height },
    policy: {
      unitsPerPixel: 256, motor: "axis-sweep-x-then-y", impulse: "instant-shove-after-contact-gather",
      maxDisplacement: 8192, impulseDistance: world.definition.shoveDistance,
      impulseDamage: world.definition.shoveDamage, hitstopTicks: world.definition.hitstopTicks,
      // Already gathered trades finish; freeze affects the following ticks.
      simultaneousHits: "gather-order-trades", terrain: "clip-through-arena-motor",
    } as const,
    state: { hp: actor.hp, freezeTicks: actor.freezeTicks, dashTicks: actor.dashTicks, motionEpoch: actor.motionEpoch },
  };
}

const definition = validateArenaDefinition({
  id: "character-motion-arena-v1", width: 96 * 256, height: 64 * 256,
  walls: [{ id: "backstop", x: 50 * 256, y: 0, width: 4 * 256, height: 64 * 256 }],
  player: { id: "hero", x: 20 * 256, y: 24 * 256, width: 10 * 256, height: 10 * 256, hp: 4 },
  enemies: [{ id: "target", x: 30 * 256, y: 24 * 256, width: 10 * 256, height: 10 * 256, hp: 8 }],
  moveSpeed: 256, enemySpeed: 256, projectileSpeed: 2048, projectileSize: 512,
  projectileTicks: 90, projectileDamage: 2, fireCooldown: 15,
  dashSpeed: 1792, dashTicks: 5, dashCooldown: 75,
  shoveRange: 2560, shoveDistance: 3072, shoveDamage: 1, shoveCooldown: 45,
  enemyDamage: 1, enemyCooldown: 40, hitstopTicks: 3, maxProjectiles: 20,
});
/** Fresh prepared values prevent exported mutable catalog data from changing the fixture. */
function catalog() {
  return validateCharacterCatalog({
    schemaVersion: 1,
    archetypes: [{ id: "motion-character", controller: "arena-v1", definitionId: definition.id }],
    appearances: [{ id: "proof", assetId: "hero-atlas", partIds: ["body"], paletteIds: ["warm"], portraitId: null, displayName: null, animations: { "arena-v1": "hero-arena" } }],
    bindings: ["hero", "target"].map(placementId => ({ placementId, archetypeId: "motion-character", appearanceId: "proof" })),
  }, {
    definitions: { "arena-v1": [definition.id], "platform-combat-v1": [] },
    placements: { "arena-v1": ["hero", "target"], "platform-combat-v1": [] },
    assets: ["hero-atlas"], parts: ["body"], palettes: ["warm"], portraits: [],
    animationSets: { "arena-v1": ["hero-arena"], "platform-combat-v1": [] },
  });
}
function world() {
  return createArena(definition, { gameId: "character-motion-proof", rulesBuildId: "arena-motion-seam-v1", contentId: "shove-backstop-v1" });
}
/** Finite plain-data admission used before calling the legacy profile's typed input seam. */
function plain(value: unknown, depth = 0): unknown {
  if (depth > 4) throw Error("Character motion data depth");
  if (value === null || typeof value === "boolean" || typeof value === "string" && value.length <= 262144) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) return value;
  if (!value || typeof value !== "object") throw Error("Character motion plain data required");
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 32 || keys.length !== value.length + 1) throw Error("Character motion array cap");
    return Array.from({ length: value.length }, (_, i) => {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (!d || !Object.hasOwn(d, "value") || !d.enumerable) throw Error("Character motion array accessor");
      return plain(d.value, depth + 1);
    });
  }
  if (Object.getPrototypeOf(value) !== Object.prototype || keys.length > 10) throw Error("Character motion object required");
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string" || key === "__proto__") throw Error("Character motion key required");
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    if (!Object.hasOwn(d, "value") || !d.enumerable) throw Error("Character motion accessor");
    result[key] = plain(d.value, depth + 1);
  }
  return result;
}
export interface CharacterMotionCheckpoint {
  readonly format: "character-arena-motion-v1";
  readonly arena: string;
}
/** Existing input/shove/damage processing is the sole authority, including wall clipping.
 * Steps stage a whole world so malformed inputs and profile preflight failures are atomic. */
export class CharacterMotionFixture {
  private world = world();
  private readonly catalog = catalog();
  step(input: ArenaInput) {
    const admitted = plain(input) as ArenaInput;
    const staged = world();
    restoreArenaCheckpoint(staged, encodeArenaCheckpoint(this.world));
    stepArena(staged, admitted);
    this.world = staged;
    return this.observe();
  }
  observe() {
    return {
      arena: observeArena(this.world),
      characters: ["hero", "target"].map(id => inspectCharacterArenaMotion(this.world, this.catalog, id)),
    };
  }
  capture(): CharacterMotionCheckpoint { return { format: "character-arena-motion-v1", arena: encodeArenaCheckpoint(this.world) }; }
  restore(value: unknown): void {
    const source = record(plain(value), ["format", "arena"]);
    if (source.format !== "character-arena-motion-v1" || typeof source.arena !== "string") throw Error("Character motion checkpoint mismatch");
    const staged = world();
    restoreArenaCheckpoint(staged, source.arena);
    if (encodeArenaCheckpoint(staged) !== source.arena) throw Error("Noncanonical character motion arena");
    this.world = staged;
  }
  save(): string { return canonical(this.capture()); }
  load(bytes: string): void { this.restore(boundedJSON(bytes, 262144, { rejectNegativeZero: true })); }
}
