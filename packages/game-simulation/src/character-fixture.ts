/** Spawn-boundary C1 consumer using the actual arena motor/combat/checkpoint. */
import { validateCharacterCatalog } from "@onepage/game-project/characters";
import { validateCharacterBuildDefinition } from "@onepage/game-project/character-build";
import {
  boundedJSON,
  canonical,
  integer,
  record,
} from "@onepage/game-project/runtime";
import {
  CharacterSessionOwner,
  CHARACTER_SESSION_LIMITS,
  type CharacterSessionCommand,
} from "./character-session";
import {
  createArena,
  encodeArenaCheckpoint,
  observeArena,
  restoreArenaCheckpoint,
  stepArena,
  validateArenaDefinition,
  type ArenaInput,
  type ArenaWorld,
} from "./m3/arena";
import { inspectCharacterArenaMotion } from "./character-motion";

export const CHARACTER_ARENA_CATALOG = validateCharacterCatalog(
  {
    schemaVersion: 1,
    archetypes: [
      {
        id: "arena-hero",
        controller: "arena-v1",
        definitionId: "character-arena-v1",
      },
    ],
    appearances: ["warm", "cool"].map((id) => ({
      id,
      assetId: "hero-atlas",
      partIds: ["cape", "body"],
      paletteIds: [id],
      portraitId: null,
      displayName: "Hero",
      animations: { "arena-v1": "hero-arena" },
    })),
    bindings: [
      { placementId: "hero", archetypeId: "arena-hero", appearanceId: "warm" },
    ],
  },
  {
    definitions: {
      "arena-v1": ["character-arena-v1"],
      "platform-combat-v1": [],
    },
    placements: { "arena-v1": ["hero"], "platform-combat-v1": [] },
    assets: ["hero-atlas"],
    parts: ["cape", "body"],
    palettes: ["warm", "cool"],
    portraits: [],
    animationSets: { "arena-v1": ["hero-arena"], "platform-combat-v1": [] },
  },
);
export const CHARACTER_ARENA_BUILDS = validateCharacterBuildDefinition(
  {
    schemaVersion: 1,
    id: "character-arena-builds-v1",
    stats: [
      { id: "health", min: 1, max: 20 },
      { id: "speed", min: 0, max: 8192 },
      { id: "damage", min: 1, max: 10 },
    ],
    slots: ["weapon", "boots"],
    items: [
      {
        id: "sword",
        slotId: "weapon",
        archetypeIds: ["arena-hero"],
        requirements: [],
        modifiers: [{ statId: "damage", delta: 2 }],
      },
      {
        id: "boots",
        slotId: "boots",
        archetypeIds: ["arena-hero"],
        requirements: [],
        modifiers: [{ statId: "speed", delta: 256 }],
      },
      {
        id: "heavy-sword",
        slotId: "weapon",
        archetypeIds: ["arena-hero"],
        requirements: [{ statId: "health", min: 8 }],
        modifiers: [{ statId: "damage", delta: 5 }],
      },
    ],
    builds: [
      {
        id: "scout",
        archetypeId: "arena-hero",
        appearanceIds: ["warm", "cool"],
        baseStats: [
          { statId: "health", value: 4 },
          { statId: "speed", value: 256 },
          { statId: "damage", value: 1 },
        ],
        grants: [
          { itemId: "sword", quantity: 1 },
          { itemId: "boots", quantity: 1 },
          { itemId: "heavy-sword", quantity: 1 },
        ],
        equipment: [],
      },
    ],
  },
  CHARACTER_ARENA_CATALOG,
);
function owner(): CharacterSessionOwner {
  return new CharacterSessionOwner(
    CHARACTER_ARENA_BUILDS,
    CHARACTER_ARENA_CATALOG,
  );
}
function arena(session: CharacterSessionOwner): ArenaWorld {
  const selected = session.inspect();
  if (!selected.character)
    throw Error("Create a character before starting arena");
  const stat = (id: string) =>
    selected.stats.find((s) => s.statId === id)!.value;
  const hp = stat("health"),
    moveSpeed = stat("speed"),
    projectileDamage = stat("damage");
  const definition = validateArenaDefinition({
    id: "character-arena-v1",
    width: 320 * 256,
    height: 180 * 256,
    walls: [],
    player: {
      id: "hero",
      x: 20 * 256,
      y: 80 * 256,
      width: 10 * 256,
      height: 10 * 256,
      hp,
    },
    enemies: [
      {
        id: "target",
        x: 90 * 256,
        y: 80 * 256,
        width: 10 * 256,
        height: 10 * 256,
        hp: 7,
      },
    ],
    moveSpeed,
    enemySpeed: 0,
    projectileSpeed: 2048,
    projectileSize: 512,
    projectileTicks: 90,
    projectileDamage,
    fireCooldown: 15,
    dashSpeed: 1792,
    dashTicks: 5,
    dashCooldown: 75,
    shoveRange: 2560,
    shoveDistance: 3072,
    shoveDamage: 1,
    shoveCooldown: 45,
    enemyDamage: 1,
    enemyCooldown: 40,
    hitstopTicks: 0,
    maxProjectiles: 20,
  });
  return createArena(definition, {
    gameId: "character-arena-proof",
    rulesBuildId: "c1-arena-v1",
    contentId: `loadout-${hp}-${moveSpeed}-${projectileDamage}`,
  });
}
export interface CharacterArenaCheckpoint {
  readonly format: "c1-character-arena-v2";
  readonly session: ReturnType<CharacterSessionOwner["capture"]>;
  readonly arena: string | null;
  readonly startRevision: number | null;
}
export class CharacterArenaFixture {
  private session = owner();
  private world: ArenaWorld | null = null;
  private startRevision: number | null = null;
  execute(command: CharacterSessionCommand) {
    // Consumer policy: gameplay build edits occur before the encounter. Cosmetics
    // may change during play; the character owner itself also supports later equipment.
    if (this.world) {
      const action =
        command && typeof command === "object"
          ? Object.getOwnPropertyDescriptor(command, "action")
          : undefined;
      const kind =
        action &&
        Object.hasOwn(action, "value") &&
        action.value &&
        typeof action.value === "object"
          ? Object.getOwnPropertyDescriptor(action.value, "kind")
          : undefined;
      if (!kind || !Object.hasOwn(kind, "value"))
        throw Error("Invalid character arena command");
      if (kind.value !== "customize")
        throw Error("Loadout locked during encounter");
    }
    return this.session.execute(command);
  }
  start(): void {
    if (this.world) throw Error("Arena already started");
    this.world = arena(this.session);
    this.startRevision = this.session.inspect().revision;
  }
  step(input: ArenaInput): void {
    if (!this.world) throw Error("Start arena first");
    stepArena(this.world, input);
  }
  observe() {
    return {
      character: this.session.inspect(),
      arena: this.world ? observeArena(this.world) : null,
      motion: this.world ? inspectCharacterArenaMotion(this.world, CHARACTER_ARENA_CATALOG, "hero") : null,
    };
  }
  capture(): CharacterArenaCheckpoint {
    return {
      format: "c1-character-arena-v2",
      session: this.session.capture(),
      startRevision: this.startRevision,
      arena: this.world ? encodeArenaCheckpoint(this.world) : null,
    };
  }
  restore(value: unknown): void {
    // Inspect the outer descriptors before reading; the session and arena codecs
    // stage both independent authorities before either live owner is assigned.
    const keys = ["format", "session", "arena", "startRevision"];
    if (
      !value ||
      typeof value !== "object" ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length ||
      keys.some((key) => {
        const d = Object.getOwnPropertyDescriptor(value, key);
        return !d || !Object.hasOwn(d, "value") || !d.enumerable;
      })
    )
      throw Error("Invalid character arena envelope");
    const s = record(value, keys);
    if (
      s.format !== "c1-character-arena-v2" ||
      !(
        s.arena === null ||
        (typeof s.arena === "string" && s.arena.length <= 262144)
      )
    )
      throw Error("Invalid character arena checkpoint");
    const staged = owner();
    staged.restore(s.session);
    const commands = staged.capture().commands;
    const startRevision =
      s.arena === null ? null : integer(s.startRevision, 1, commands.length);
    if (
      (s.arena === null && s.startRevision !== null) ||
      (startRevision !== null &&
        commands
          .slice(startRevision)
          .some((c) => c.action.kind !== "customize"))
    )
      throw Error("Loadout locked during encounter");
    const world = s.arena === null ? null : arena(staged);
    if (world) restoreArenaCheckpoint(world, s.arena as string);
    this.session = staged;
    this.world = world;
    this.startRevision = startRevision;
  }
  save(): string {
    const bytes = canonical(this.capture());
    boundedJSON(bytes, CHARACTER_SESSION_LIMITS.saveBytes);
    return bytes;
  }
  load(bytes: string): void {
    this.restore(
      boundedJSON(bytes, CHARACTER_SESSION_LIMITS.saveBytes, {
        rejectNegativeZero: true,
      }),
    );
  }
}
export function createCharacterArenaFixture(): CharacterArenaFixture {
  return new CharacterArenaFixture();
}
