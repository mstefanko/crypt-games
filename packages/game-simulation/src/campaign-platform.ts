import { validateBehaviorParameters } from "./behavior";
/** Bounded authored-room composition. Platform motion/combat and transactions retain
 * their existing owners; this owner publishes them together at semantic boundaries. */
import {
  array,
  boundedJSON,
  canonical,
  integer,
  record,
  string,
} from "@onepage/game-project/runtime";
import type {
  CompatibilityIdentity,
  GameDefinitions,
  InputFrame,
  Rect,
} from "@onepage/game-project/runtime";
import { createWorld, observe, step } from "./simulation";
import {
  copyValidatedWorld,
  restoreCheckpoint,
  serializeCheckpoint,
} from "./checkpoint";
import type { PlatformInputFrameV2 } from "./platform-input-v2";
import { cancelFrame } from "./input";
import { cancelPlatformFrame } from "./platform-input-v2";
import { overlaps, moveActor, body, candidates } from "./collision";
import {
  TransactionOwner,
  type TransactionDefinition,
  type TransactionOperation,
} from "./transactions";
import type { World } from "./types";
import {
  createCampaignBehaviors,
  validateCampaignBehaviors,
  campaignBehaviorIntents,
  type CampaignBehaviorPlacement,
  type CampaignBehaviorState,
} from "./campaign-behavior";

export const CAMPAIGN_PLATFORM_LIMITS = Object.freeze({
  rooms: 8,
  exits: 8,
  pickups: 8,
  assets: 16,
  commands: 4096,
  bytes: 8 * 1024 * 1024,
  historyBytes: 1024 * 1024,
  progressBytes: 2 * 1024 * 1024,
  progressEvents: 72,
  definitionBytes: 256 * 1024,
});
export interface CampaignOutcome {
  readonly id: string;
  readonly operations: readonly TransactionOperation[];
}
export interface CampaignIngressAnchor {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly facing: -1 | 1;
  /** 1–120 neutral production ticks; named arrivals must finish safely grounded. */
  readonly settleTicks: number;
}
export interface CampaignExit {
  readonly destinationAnchor?: string;
  readonly id: string;
  readonly area: Rect;
  readonly to: string;
  readonly requires: string | null;
  readonly outcome: CampaignOutcome | null;
}
export interface CampaignPickup {
  readonly requires?: string;
  readonly id: string;
  readonly area: Rect;
  readonly outcome: CampaignOutcome;
  readonly requiresDefeated?: readonly string[];
}
export interface CampaignRoom {
  readonly anchors?: readonly CampaignIngressAnchor[];
  readonly defaultAnchor?: string;
  readonly id: string;
  readonly scenarioId: string;
  readonly assets: readonly string[];
  readonly exits: readonly CampaignExit[];
  readonly pickups: readonly CampaignPickup[];
  readonly checkpoint: Rect | null;
  /** Only these enemy placements persist as defeated; ordinary enemies reset on entry. */
  readonly permanentEnemies: readonly string[];
  /** Opt-in M9 consumer; at most two existing non-player placements per room. */
  readonly behaviors?: readonly CampaignBehaviorPlacement[];
}
export interface CampaignPlatformDefinition {
  readonly initialAnchor?: string;
  readonly inputCodec?: "platform-input-v2";
  readonly id: string;
  readonly initialRoom: string;
  readonly rooms: readonly CampaignRoom[];
  readonly transactions: TransactionDefinition;
  /** An acquired, collision-constrained burst on the platform heavy input edge. */
  readonly traversal?: {
    readonly flag: string;
    readonly distance: number;
    /** Explicit opt-in to a bounded equipment-derived distance on frame commands. */
    readonly maxBonus?: number;
  };
}
export type CampaignPlatformCommand =
  | {
      readonly kind: "frame";
      readonly input: InputFrame | PlatformInputFrameV2;
      readonly traversalBonus?: number;
    }
  | { readonly kind: "pickup"; readonly id: string }
  | { readonly kind: "exit"; readonly id: string }
  | { readonly kind: "checkpoint" | "recover" | "reset" };
export interface CampaignEntryPlan {
  readonly anchorId?: string | null;
  readonly revision: number;
  readonly from: string;
  readonly roomId: string;
  readonly exitId: string | null;
  readonly assets: readonly string[];
  readonly kind: "exit" | "recover" | "reset";
}

/** Reject accessors, exotic objects, sparse/augmented arrays and unbounded input
 * before serialization. This also makes all imports and retained commands detached. */
export function copyCampaignPlainData<T>(value: T, maxString = 128): T {
  let nodes = 0;
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > 300_000 || depth > 24) throw Error("Campaign data work cap");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v) || Object.is(v, -0))
        throw Error("Invalid campaign number");
      return v;
    }
    if (typeof v === "string" && v.length <= maxString) return v;
    if (!v || typeof v !== "object")
      throw Error("Campaign plain data required");
    const list = Array.isArray(v);
    if (
      Object.getPrototypeOf(v) !== (list ? Array.prototype : Object.prototype)
    )
      throw Error("Campaign plain data required");
    const keys = Reflect.ownKeys(v);
    if (
      list &&
      ((v as unknown[]).length > 65536 ||
        keys.length !== (v as unknown[]).length + 1)
    )
      throw Error("Campaign array cap/shape");
    if (!list && keys.length > 64) throw Error("Campaign object cap");
    const result: Record<string, unknown> | unknown[] = list ? [] : {};
    for (const key of keys) {
      if (list && key === "length") continue;
      if (typeof key !== "string" || key === "__proto__" || key.length > 128)
        throw Error("Invalid campaign key");
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (!Object.hasOwn(d, "value") || !d.enumerable)
        throw Error("Campaign accessor/hidden data rejected");
      if (list && !/^(0|[1-9][0-9]*)$/.test(key))
        throw Error("Campaign array property");
      (result as Record<string, unknown>)[key] = visit(d.value, depth + 1);
    }
    return result;
  };
  return visit(value, 0) as T;
}
const plain = copyCampaignPlainData;
/** Only detached prepared data reaches here; no mutable definition reference
 * can leave this owner or be changed by a staged platform world. */
function freezeData<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}
function byteLength(value: unknown): number {
  let bytes = 0;
  for (const char of canonical(value)) {
    const code = char.codePointAt(0)!;
    bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
  }
  return bytes;
}
/** Exact UTF-8 sizes of canonical JSON and that JSON embedded as a string. */
export interface CampaignJSONByteSize {
  readonly bytes: number;
  readonly quotedBytes: number;
}
export function campaignJSONByteSize(value: unknown): CampaignJSONByteSize {
  const source = canonical(value);
  let bytes = 0,
    escapes = 0;
  for (const char of source) {
    const code = char.codePointAt(0)!;
    bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
    if (char === '"' || char === "\\") escapes++;
  }
  return { bytes, quotedBytes: bytes + escapes + 2 };
}
function objectByteSize(
  fields: readonly (readonly [string, CampaignJSONByteSize])[],
): CampaignJSONByteSize {
  let bytes = 2 + Math.max(0, fields.length - 1),
    escaped = bytes;
  for (const [key, value] of fields) {
    const k = campaignJSONByteSize(key);
    bytes += k.bytes + 1 + value.bytes;
    escaped += k.quotedBytes - 2 + 1 + value.quotedBytes - 2;
  }
  return { bytes, quotedBytes: escaped + 2 };
}
function rect(value: unknown): Rect {
  const r = record(value, ["x", "y", "width", "height"]);
  return {
    x: integer(r.x, -16777216, 16777216),
    y: integer(r.y, -16777216, 16777216),
    width: integer(r.width, 1, 16777216),
    height: integer(r.height, 1, 16777216),
  };
}
function unique(ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length)
    throw Error("Duplicate campaign identity");
}
function definition(
  value: CampaignPlatformDefinition,
  platform: GameDefinitions,
): CampaignPlatformDefinition {
  const copy = plain(value);
  if (byteLength(copy) > CAMPAIGN_PLATFORM_LIMITS.definitionBytes)
    throw Error("Campaign definition byte cap");
  record(copy, [
    "id",
    "initialRoom",
    "rooms",
    "transactions",
    ...(Object.hasOwn(copy, "initialAnchor") ? ["initialAnchor"] : []),
    ...(Object.hasOwn(copy, "inputCodec") ? ["inputCodec"] : []),
    ...(Object.hasOwn(copy, "traversal") ? ["traversal"] : []),
  ]);
  if (copy.inputCodec !== undefined && copy.inputCodec !== "platform-input-v2")
    throw Error("Unsupported campaign input codec");
  if (copy.initialAnchor !== undefined) string(copy.initialAnchor);
  string(copy.id);
  string(copy.initialRoom);
  const tx = new TransactionOwner(copy.transactions).capture().definition;
  if (Object.hasOwn(copy, "traversal")) {
    if (!copy.traversal) throw Error("Invalid campaign traversal");
    record(copy.traversal, [
      "flag",
      "distance",
      ...(Object.hasOwn(copy.traversal, "maxBonus") ? ["maxBonus"] : []),
    ]);
    if (Object.hasOwn(copy.traversal, "maxBonus"))
      integer(copy.traversal.maxBonus, 1, 2048);
    if (!tx.flags.includes(copy.traversal.flag))
      throw Error("Unknown traversal flag");
    integer(copy.traversal.distance, 256, 8192);
    // Campaign uses its own rectangular moveActor sweep (not the P0 query API).
    // This bounds the combined distance, including the optional equipment bonus.
    integer(
      copy.traversal.distance + (copy.traversal.maxBonus ?? 0),
      256,
      10240,
    );
  }
  const outcomes = new Set<string>();
  const outcome = (value: CampaignOutcome): CampaignOutcome => {
    record(value, ["id", "operations"]);
    if (outcomes.has(value.id))
      throw Error("Campaign outcomes must have one authored source");
    outcomes.add(value.id);
    if (!tx.outcomes.includes(value.id))
      throw Error("Unknown campaign outcome");
    // Use the transaction parser and reference validation on a generous temporary
    // balance? Actual costs/capacity are intentionally checked at execution time.
    array(value.operations, 16);
    if (value.operations.length === 0) throw Error("Empty campaign outcome");
    for (const op of value.operations) {
      if (op.kind === "flag") {
        record(op, ["kind", "flag", "value"]);
        if (!tx.flags.includes(op.flag) || typeof op.value !== "boolean")
          throw Error("Unknown campaign flag");
      } else if (op.kind === "stat") {
        record(op, ["kind", "stat", "delta"]);
        if (!tx.stats.some((s) => s.id === op.stat))
          throw Error("Unknown campaign stat");
        integer(op.delta, -1_000_000, 1_000_000);
      } else if (op.kind === "consume" || op.kind === "grant") {
        record(op, ["kind", "resource", "amount"]);
        if (!tx.resources.some((r) => r.id === op.resource))
          throw Error("Unknown campaign resource");
        integer(op.amount, 1, 1_000_000);
      } else if (op.kind === "reward") {
        record(op, ["kind", "resource", "min", "max"]);
        if (!tx.resources.some((r) => r.id === op.resource))
          throw Error("Unknown campaign reward");
        integer(op.max, integer(op.min, 1, 1_000_000), 1_000_000);
      } else throw Error("Unknown campaign operation");
    }
    return value;
  };
  const rooms = array(copy.rooms, CAMPAIGN_PLATFORM_LIMITS.rooms).map((v) => {
    const r = v as CampaignRoom;
    record(r, [
      "id",
      "scenarioId",
      "assets",
      "exits",
      "pickups",
      "checkpoint",
      "permanentEnemies",
      ...(Object.hasOwn(r, "anchors") ? ["anchors"] : []),
      ...(Object.hasOwn(r, "defaultAnchor") ? ["defaultAnchor"] : []),
      ...(Object.hasOwn(r, "behaviors") ? ["behaviors"] : []),
    ]);
    string(r.id);
    string(r.scenarioId);
    if (r.anchors !== undefined) {
      const anchors = array(r.anchors, 16) as CampaignIngressAnchor[];
      for (const a of anchors) {
        record(a, ["id", "x", "y", "facing", "settleTicks"]);
        string(a.id);
        integer(a.x, -16777216, 16777216);
        integer(a.y, -16777216, 16777216);
        if (a.facing !== -1 && a.facing !== 1)
          throw Error("Invalid ingress facing");
        integer(a.settleTicks, 1, 120);
      }
      unique(anchors.map((a) => a.id));
    }
    if (
      r.defaultAnchor !== undefined &&
      !r.anchors?.some((a) => a.id === r.defaultAnchor)
    )
      throw Error("Unknown default ingress anchor");
    const scenario = platform.scenarios.find((s) => s.id === r.scenarioId);
    const level = platform.levels.find((l) => l.id === scenario?.levelId);
    if (
      !scenario ||
      !level ||
      level.goal.nextLevelId !== null ||
      scenario.playerSlots.length !== 1 ||
      scenario.playerSlots[0] !== 0
    )
      throw Error(
        "Campaign room requires an isolated single-player platform scenario",
      );
    const assets = array(r.assets, CAMPAIGN_PLATFORM_LIMITS.assets).map((v) =>
      string(v),
    );
    unique(assets);
    const exits = array(r.exits, CAMPAIGN_PLATFORM_LIMITS.exits).map((v) => {
      const e = v as CampaignExit;
      record(e, [
        "id",
        "area",
        "to",
        "requires",
        "outcome",
        ...(Object.hasOwn(e, "destinationAnchor") ? ["destinationAnchor"] : []),
      ]);
      if (e.destinationAnchor !== undefined) string(e.destinationAnchor);
      string(e.id);
      string(e.to);
      if (e.requires !== null && !tx.flags.includes(e.requires))
        throw Error("Unknown campaign gate flag");
      return {
        ...e,
        area: rect(e.area),
        outcome: e.outcome === null ? null : outcome(e.outcome),
      };
    });
    unique(exits.map((e) => e.id));
    const pickups = array(r.pickups, CAMPAIGN_PLATFORM_LIMITS.pickups).map(
      (v) => {
        const p = v as CampaignPickup;
        record(p, [
          "id",
          "area",
          "outcome",
          ...(Object.hasOwn(p, "requires") ? ["requires"] : []),
          ...(Object.hasOwn(p, "requiresDefeated") ? ["requiresDefeated"] : []),
        ]);
        string(p.id);
        if (p.requires !== undefined && !tx.flags.includes(p.requires))
          throw Error("Unknown campaign pickup gate flag");
        if (Object.hasOwn(p, "requiresDefeated")) {
          const enemies = array(p.requiresDefeated, 2).map((id) => string(id));
          unique(enemies);
          if (enemies.some((id) => !r.permanentEnemies.includes(id)))
            throw Error("Pickup defeat requirement must be permanent");
        }
        return { ...p, area: rect(p.area), outcome: outcome(p.outcome) };
      },
    );
    unique(pickups.map((p) => p.id));
    const permanentEnemies = array(r.permanentEnemies, 256).map((v) =>
      string(v),
    );
    unique(permanentEnemies);
    if (
      permanentEnemies.some(
        (id) => !level.spawns.some((s) => s.id === id && s.slot === null),
      )
    )
      throw Error("Unknown permanent enemy placement");
    if (Object.hasOwn(r, "behaviors")) {
      const behaviors = array(r.behaviors, 2) as CampaignBehaviorPlacement[];
      unique(behaviors.map((b) => b.spawnId));
      for (const b of behaviors) {
        record(b, [
          "spawnId",
          "role",
          ...(Object.hasOwn(b, "parameters") ? ["parameters"] : []),
        ]);
        if (Object.hasOwn(b, "parameters"))
          validateBehaviorParameters(b.parameters);
        const spawn = level.spawns.find(
          (spawn) => spawn.id === b.spawnId && spawn.slot === null,
        );
        const actor = platform.archetypes.find(
          (actor) => actor.id === spawn?.archetypeId,
        );
        if (
          !actor ||
          actor.ai !== "none" ||
          !actor.abilities.length ||
          (b.role !== "bruiser" && b.role !== "ranger")
        )
          throw Error("Invalid campaign behavior placement");
      }
    }
    return {
      ...r,
      assets,
      exits,
      pickups,
      permanentEnemies,
      checkpoint: r.checkpoint === null ? null : rect(r.checkpoint),
    };
  });
  // Preserve authored v3 definitions byte-for-byte. Only behavior-free v2
  // campaigns normalize redundant empty lists to the historical definition.
  if (!rooms.some((room) => (room.behaviors?.length ?? 0) > 0))
    for (const room of rooms) delete room.behaviors;
  unique(rooms.map((r) => r.id));
  unique(rooms.map((r) => r.scenarioId));
  if (
    !rooms.some((r) => r.id === copy.initialRoom) ||
    rooms.some((r) => r.exits.some((e) => !rooms.some((t) => t.id === e.to)))
  )
    throw Error("Campaign room graph reference missing");
  for (const room of rooms)
    for (const exit of room.exits) {
      if (
        exit.destinationAnchor !== undefined &&
        !rooms
          .find((r) => r.id === exit.to)
          ?.anchors?.some((a) => a.id === exit.destinationAnchor)
      )
        throw Error("Unknown destination ingress anchor");
    }
  if (
    copy.initialAnchor !== undefined &&
    !rooms
      .find((r) => r.id === copy.initialRoom)
      ?.anchors?.some((a) => a.id === copy.initialAnchor)
  )
    throw Error("Unknown initial ingress anchor");
  return { ...copy, rooms, transactions: tx };
}

type ProgressEvent =
  | {
      readonly kind: "visit";
      readonly id: string;
      readonly from: string;
      readonly exit: string;
    }
  | { readonly kind: "outcome"; readonly id: string };
interface CompactState {
  readonly anchorId?: string | null;
  readonly checkpointAnchorId?: string | null;
  readonly behaviors?: readonly CampaignBehaviorState[];
  readonly roomId: string;
  readonly checkpointRoomId: string;
  readonly visited: readonly string[];
  readonly defeated: readonly string[];
  readonly events: readonly ProgressEvent[];
  readonly transactions: ReturnType<TransactionOwner["capture"]>;
  readonly platform: string;
}

export class CampaignPlatformOwner {
  private readonly definitions: GameDefinitions;
  private readonly identity: CompatibilityIdentity;
  private readonly definition: CampaignPlatformDefinition;
  private world: World;
  private readonly behaviorEnabled: boolean;
  private behaviors: CampaignBehaviorState[] = [];
  private transactions: TransactionOwner;
  private roomId: string;
  private anchorId: string | null = null;
  private checkpointAnchorId: string | null = null;
  private readonly anchorEnabled: boolean;
  private checkpointRoomId: string;
  private visited: string[];
  private defeated: string[] = [];
  private history: CampaignPlatformCommand[] = [];
  private historyBytes = 0;
  private historyQuotedBodyBytes = 0;
  private persistenceHeader?: readonly (readonly [
    string,
    CampaignJSONByteSize,
  ])[];
  private persistenceContent?: string;
  private readonly persistenceBaseSizes = new WeakMap<
    object,
    CampaignJSONByteSize
  >();
  private events: ProgressEvent[] = [];
  private base: CompactState | null = null;
  private legacy = false;
  // Separate from resettable replay history so old staged plans never become current.
  private revision = 0;
  private persistenceGuard?: (owner: CampaignPlatformOwner) => void;
  /** A portable content wrapper can reject a prospective aggregate save atomically. */
  setPersistenceGuard(guard: (owner: CampaignPlatformOwner) => void): void {
    guard(this);
    this.persistenceGuard = guard;
  }
  private guarded(operation: () => void): void {
    if (!this.persistenceGuard) {
      operation();
      return;
    }
    const saved = {
      world: this.world,
      behaviors: this.behaviors,
      transactions: this.transactions,
      roomId: this.roomId,
      checkpointRoomId: this.checkpointRoomId,
      anchorId: this.anchorId,
      checkpointAnchorId: this.checkpointAnchorId,
      visited: [...this.visited],
      defeated: [...this.defeated],
      history: [...this.history],
      historyBytes: this.historyBytes,
      historyQuotedBodyBytes: this.historyQuotedBodyBytes,
      events: [...this.events],
      base: this.base,
      legacy: this.legacy,
      revision: this.revision,
    };
    try {
      operation();
      this.persistenceGuard(this);
    } catch (error) {
      Object.assign(this, saved);
      throw error;
    }
  }
  constructor(
    platform: GameDefinitions,
    identity: CompatibilityIdentity,
    authored: CampaignPlatformDefinition,
    private readonly simulationOptions: { onSimulationTick?: () => void } = {},
  ) {
    this.definitions = freezeData(plain(platform));
    this.identity = freezeData(plain(identity));
    record(this.identity, ["rulesBuildId", "contentId"]);
    string(identity.rulesBuildId);
    string(identity.contentId);
    this.definition = freezeData(definition(authored, this.definitions));
    this.behaviorEnabled = this.definition.rooms.some(
      (room) => (room.behaviors?.length ?? 0) > 0,
    );
    this.anchorEnabled =
      this.definition.rooms.some((r) => r.anchors !== undefined) ||
      this.definition.initialAnchor !== undefined;
    this.roomId = this.definition.initialRoom;
    this.anchorId =
      this.definition.initialAnchor ?? this.room().defaultAnchor ?? null;
    this.checkpointAnchorId = this.anchorId;
    this.checkpointRoomId = this.roomId;
    this.visited = [this.roomId];
    this.transactions = new TransactionOwner(this.definition.transactions);
    this.world = this.enter(this.roomId, [], this.anchorId);
    // Validate every authored ingress before admitting the campaign.
    for (const room of this.definition.rooms)
      for (const anchor of room.anchors ?? [])
        this.enter(room.id, [], anchor.id);
    this.behaviors = createCampaignBehaviors(this.room().behaviors ?? []);
  }
  private room(id = this.roomId): CampaignRoom {
    const r = this.definition.rooms.find((r) => r.id === id);
    if (!r) throw Error("Unknown campaign room");
    return r;
  }
  private enter(
    roomId: string,
    defeated = this.defeated,
    anchorId: string | null = this.room(roomId).defaultAnchor ?? null,
  ): World {
    const room = this.room(roomId);
    const world = createWorld(
      this.definitions,
      this.identity,
      room.scenarioId,
      this.definition.inputCodec
        ? { inputCodec: this.definition.inputCodec }
        : undefined,
    );
    if (anchorId !== null) {
      const anchor = room.anchors?.find((a) => a.id === anchorId);
      if (!anchor) throw Error("Unknown ingress anchor");
      const hero = world.actors.find((a) => a.slot === 0)!;
      Object.assign(hero, {
        x: anchor.x,
        y: anchor.y,
        facing: anchor.facing,
        vx: 0,
        vy: 0,
        grounded: false,
        riderId: null,
        coyoteTicks: 0,
        jumpBuffer: 0,
      });
      if (hero.platformMotion)
        hero.platformMotion = { supportId: null, ignoredSupportId: null };
      const shape = body(
        hero,
        this.definitions.archetypes.find((a) => a.id === hero.archetypeId)!,
      );
      if (candidates(world, shape).some((c) => overlaps(shape, c)))
        throw Error("Ingress anchor overlaps collision");
      copyValidatedWorld(world);
      for (let tick = 0; tick < anchor.settleTicks; tick++) {
        this.simulationOptions.onSimulationTick?.();
        step(
          world,
          tick === 0
            ? this.definition.inputCodec
              ? cancelPlatformFrame(world.decoder)
              : cancelFrame(world.decoder)
            : { slots: [] },
        );
      }
      const pose = observe(world).actors.find((a) => a.slot === 0)!;
      if (
        world.status !== "playing" ||
        pose.health <= 0 ||
        !pose.grounded ||
        room.exits.some((e) => overlaps(pose, e.area))
      )
        throw Error("Unsafe ingress anchor");
    }
    for (const actor of world.actors)
      if (defeated.includes(JSON.stringify([roomId, actor.spawnId]))) {
        actor.health = 0;
        actor.grounded = false;
        actor.riderId = null;
        if (actor.platformMotion)
          actor.platformMotion = { supportId: null, ignoredSupportId: null };
        world.campaign.defeatedPlacementIds.push(
          JSON.stringify([world.levelId, actor.spawnId]),
        );
      }
    // Validate full prepared authority, collision contacts and decoder before publication.
    return copyValidatedWorld(world);
  }
  private near(area: Rect): void {
    if (
      this.world.status !== "playing" ||
      !observe(this.world).actors.some(
        (a) => a.slot === 0 && a.health > 0 && overlaps(a, area),
      )
    )
      throw Error("Campaign interaction out of reach");
  }
  private budget(command: CampaignPlatformCommand): void {
    if (byteLength(command) > CAMPAIGN_PLATFORM_LIMITS.historyBytes)
      throw Error("Campaign command byte cap exceeded");
    if (this.revision === Number.MAX_SAFE_INTEGER)
      throw Error("Campaign authority revision exhausted");
  }
  private retain(command: CampaignPlatformCommand): void {
    const size = campaignJSONByteSize(command);
    this.historyBytes += size.bytes;
    this.historyQuotedBodyBytes += size.quotedBytes - 2;
    this.history.push(command);
    this.revision++;
    // Compact only successfully published authority. No lifetime motion journal.
    if (
      !this.legacy &&
      (this.history.length >= CAMPAIGN_PLATFORM_LIMITS.commands ||
        this.historyBytes >= CAMPAIGN_PLATFORM_LIMITS.historyBytes)
    ) {
      this.base = this.captureState();
      this.history = [];
      this.historyBytes = 0;
      this.historyQuotedBodyBytes = 0;
    }
  }
  /** A host gesture either publishes every frame or leaves authority untouched. */
  executeFrames(input: InputFrame | PlatformInputFrameV2, ticks = 1): void {
    integer(ticks, 1, 256);
    const previous = {
      world: this.world,
      behaviors: this.behaviors,
      defeated: this.defeated,
      history: this.history,
      historyLength: this.history.length,
      historyBytes: this.historyBytes,
      historyQuotedBodyBytes: this.historyQuotedBodyBytes,
      revision: this.revision,
      base: this.base,
    };
    try {
      for (let i = 0; i < ticks; i++) this.execute({ kind: "frame", input });
    } catch (error) {
      this.world = previous.world;
      this.behaviors = previous.behaviors;
      this.defeated = previous.defeated;
      this.history = previous.history;
      this.history.length = previous.historyLength;
      this.historyBytes = previous.historyBytes;
      this.historyQuotedBodyBytes = previous.historyQuotedBodyBytes;
      this.revision = previous.revision;
      this.base = previous.base;
      throw error;
    }
  }
  private copyTransactions(): TransactionOwner {
    const tx = new TransactionOwner(this.definition.transactions);
    tx.restore(this.transactions.capture());
    return tx;
  }
  private applyOutcome(tx: TransactionOwner, outcome: CampaignOutcome): void {
    const saved = tx.capture();
    tx.execute({
      id: this.legacy
        ? `campaign-${this.history.length}`
        : `campaign-outcome-${saved.revision}`,
      revision: saved.revision,
      outcome: outcome.id,
      operations: outcome.operations,
    });
  }
  observation() {
    return {
      revision: this.revision,
      roomId: this.roomId,
      ...(this.anchorEnabled
        ? {
            anchorId: this.anchorId,
            checkpointAnchorId: this.checkpointAnchorId,
          }
        : {}),
      checkpointRoomId: this.checkpointRoomId,
      visited: [...this.visited],
      defeated: [...this.defeated],
      platform: observe(this.world),
      behaviors: plain(this.behaviors),
      transactions: this.transactions.capture(),
      room: plain(this.room()),
    };
  }
  /** Extensions stage against validated authority before publication. The returned
   * closure must only publish already prepared state and must not throw. Worlds
   * are borrowed for this call only; extensions must neither mutate nor retain them. */
  protected prepareFrameExtension(
    _command: Extract<CampaignPlatformCommand, { kind: "frame" }>,
    _before: Readonly<World>,
    _after: Readonly<World>,
    _roomId: string,
  ): (() => void) | undefined {
    return undefined;
  }
  execute(value: CampaignPlatformCommand): void {
    this.guarded(() => this.executeUnchecked(value));
  }
  private executeUnchecked(value: CampaignPlatformCommand): void {
    const c = plain(value);
    this.budget(c);
    let publishExtension: (() => void) | undefined;
    if (c.kind === "exit" || c.kind === "recover" || c.kind === "reset") {
      record(c, c.kind === "exit" ? ["kind", "id"] : ["kind"]);
      const plan = this.stageEntry(c.kind, c.kind === "exit" ? c.id : null);
      this.commitEntry(plan);
      return;
    }
    if (c.kind === "frame") {
      record(c, [
        "kind",
        "input",
        ...(Object.hasOwn(c, "traversalBonus") ? ["traversalBonus"] : []),
      ]);
      let traversalBonus = 0;
      if (Object.hasOwn(c, "traversalBonus")) {
        if (!this.definition.traversal?.maxBonus)
          throw Error("Campaign equipment traversal is not enabled");
        traversalBonus = integer(
          c.traversalBonus,
          1,
          this.definition.traversal.maxBonus,
        );
      }
      // Embedded platform restart would bypass the campaign policy.
      record(
        c.input,
        Object.hasOwn(c.input ?? {}, "commands")
          ? ["slots", "commands"]
          : ["slots"],
      );
      array(c.input.slots, 4);
      if (Object.hasOwn(c.input, "commands")) array(c.input.commands, 0);
      const next = copyValidatedWorld(this.world);
      const traversal = this.definition.traversal;
      const hero = next.actors.find((actor) => actor.slot === 0);
      if (
        traversal &&
        hero &&
        hero.health > 0 &&
        !hero.freezeTicks &&
        !hero.stunTicks &&
        !hero.execution &&
        next.status === "playing" &&
        c.input.slots.some(
          (slot) =>
            slot?.slot === 0 &&
            Array.isArray(slot.edges) &&
            slot.edges.some(
              (edge) => edge?.action === "heavy" && edge.kind === "pressed",
            ),
        ) &&
        this.transactions
          .capture()
          .flags.some((flag) => flag.id === traversal.flag && flag.value)
      )
        moveActor(
          next,
          hero,
          hero.facing * (traversal.distance + traversalBonus),
          0,
        );
      const decisions = campaignBehaviorIntents(next, this.behaviors);
      this.simulationOptions.onSimulationTick?.();
      step(next, c.input, decisions.intents);
      // Do not publish a platform state that its bounded importer cannot restore.
      const validated = copyValidatedWorld(next);
      const defeated = [...this.defeated];
      for (const a of next.actors)
        if (
          a.health === 0 &&
          this.room().permanentEnemies.includes(a.spawnId)
        ) {
          const key = JSON.stringify([this.roomId, a.spawnId]);
          if (!defeated.includes(key)) defeated.push(key);
        }
      publishExtension = this.prepareFrameExtension(
        c,
        this.world,
        validated,
        this.roomId,
      );
      this.world = validated;
      this.behaviors = decisions.states;
      this.defeated = defeated.sort();
    } else if (c.kind === "pickup") {
      record(c, ["kind", "id"]);
      const pickup = this.room().pickups.find((p) => p.id === c.id);
      if (!pickup) throw Error("Unknown campaign pickup");
      this.near(pickup.area);
      if (
        pickup.requires &&
        !this.transactions
          .capture()
          .flags.some((f) => f.id === pickup.requires && f.value)
      )
        throw Error("Campaign pickup ability gate closed");
      if (
        pickup.requiresDefeated?.some(
          (id) => !this.defeated.includes(JSON.stringify([this.roomId, id])),
        )
      )
        throw Error("Campaign guardian remains");
      const next = this.copyTransactions();
      this.applyOutcome(next, pickup.outcome);
      this.transactions = next;
      this.events = [
        ...this.events,
        { kind: "outcome", id: pickup.outcome.id },
      ];
    } else if (c.kind === "checkpoint") {
      record(c, ["kind"]);
      const area = this.room().checkpoint;
      if (!area) throw Error("No campaign checkpoint");
      this.near(area);
      this.checkpointRoomId = this.roomId;
      this.checkpointAnchorId = this.anchorId;
    } else throw Error("Unknown campaign command");
    this.retain(c);
    publishExtension?.();
  }
  /** Staging validates the exit, transaction and complete destination world without
   * publishing any authority. A revision check is repeated when loading completes. */
  stageEntry(
    kind: "exit" | "recover" | "reset",
    exitId: string | null = null,
  ): CampaignEntryPlan {
    this.budget(kind === "exit" ? { kind, id: exitId! } : { kind });
    let target: string;
    let anchorId: string | null = null;
    if (kind === "exit") {
      const exit = this.room().exits.find((e) => e.id === exitId);
      if (!exit) throw Error("Unknown campaign exit");
      this.near(exit.area);
      if (
        exit.requires &&
        !this.transactions
          .capture()
          .flags.some((f) => f.id === exit.requires && f.value)
      )
        throw Error("Campaign ability gate closed");
      target = exit.to;
      anchorId =
        exit.destinationAnchor ?? this.room(target).defaultAnchor ?? null;
      if (
        exit.outcome &&
        !this.transactions.capture().outcomes.includes(exit.outcome.id)
      )
        this.applyOutcome(this.copyTransactions(), exit.outcome);
    } else if (kind === "recover") {
      if (this.world.status !== "lost")
        throw Error("Campaign recovery requires death");
      target = this.checkpointRoomId;
      anchorId = this.checkpointAnchorId;
    } else if (kind === "reset") {
      target = this.definition.initialRoom;
      anchorId =
        this.definition.initialAnchor ??
        this.room(target).defaultAnchor ??
        null;
    } else throw Error("Unknown campaign entry kind");
    this.enter(target, kind === "reset" ? [] : this.defeated, anchorId);
    return {
      ...(this.anchorEnabled ? { anchorId } : {}),
      revision: this.revision,
      from: this.roomId,
      roomId: target,
      exitId,
      assets: [...this.room(target).assets],
      kind,
    };
  }
  commitEntry(value: CampaignEntryPlan): void {
    this.guarded(() => this.commitEntryUnchecked(value));
  }
  private commitEntryUnchecked(value: CampaignEntryPlan): void {
    const plan = plain(value);
    record(plan, [
      "revision",
      "from",
      "roomId",
      "exitId",
      "assets",
      "kind",
      ...(this.anchorEnabled ? ["anchorId"] : []),
    ]);
    if (plan.revision !== this.revision || plan.from !== this.roomId)
      throw Error("Stale campaign entry");
    const expected = this.stageEntry(plan.kind, plan.exitId);
    if (canonical(expected) !== canonical(plan))
      throw Error("Invalid campaign entry plan");
    const reset = plan.kind === "reset";
    const next = this.enter(
      plan.roomId,
      reset ? [] : this.defeated,
      plan.anchorId ?? null,
    );
    const tx = reset
      ? new TransactionOwner(this.definition.transactions)
      : this.copyTransactions();
    if (plan.kind === "exit") {
      const outcome = this.room().exits.find(
        (e) => e.id === plan.exitId,
      )!.outcome;
      if (outcome && !tx.capture().outcomes.includes(outcome.id))
        this.applyOutcome(tx, outcome);
    }
    const sourceRoom = this.roomId;
    const outcome =
      plan.kind === "exit"
        ? this.room().exits.find((e) => e.id === plan.exitId)!.outcome
        : null;
    const granted =
      outcome && !this.transactions.capture().outcomes.includes(outcome.id);
    if (!reset && !this.visited.includes(plan.roomId))
      this.events = [
        ...this.events,
        {
          kind: "visit",
          id: plan.roomId,
          from: sourceRoom,
          exit: plan.exitId!,
        },
      ];
    if (granted)
      this.events = [...this.events, { kind: "outcome", id: outcome.id }];
    this.world = next;
    this.behaviors = createCampaignBehaviors(
      this.room(plan.roomId).behaviors ?? [],
    );
    this.transactions = tx;
    this.roomId = plan.roomId;
    this.anchorId = plan.anchorId ?? null;
    if (reset) {
      this.defeated = [];
      this.events = [];
      this.base = null;
      this.visited = [this.roomId];
      this.checkpointRoomId = this.roomId;
      this.checkpointAnchorId = this.anchorId;
    } else if (!this.visited.includes(this.roomId))
      this.visited.push(this.roomId);
    if (reset) {
      this.history = [];
      this.historyBytes = 0;
      this.historyQuotedBodyBytes = 0;
      this.revision++;
      return;
    }
    this.retain(
      plan.kind === "exit"
        ? { kind: "exit", id: plan.exitId! }
        : { kind: plan.kind },
    );
  }
  /** Extension consumers may bind their own finite witness to the retained tail. */
  protected get campaignHistoryLength(): number {
    return this.history.length;
  }
  /** Explicit semantic boundary: retain current authority as a structural compact
   * base and retire the replay tail before replacing an external witness epoch. */
  protected rebaseCampaignHistory(): void {
    this.budget({ kind: "checkpoint" });
    this.base = this.captureState();
    this.history = [];
    this.historyBytes = 0;
    this.historyQuotedBodyBytes = 0;
    this.revision++;
  }
  private captureState(): CompactState {
    return {
      ...(this.behaviorEnabled ? { behaviors: plain(this.behaviors) } : {}),
      roomId: this.roomId,
      ...(this.anchorEnabled
        ? {
            anchorId: this.anchorId,
            checkpointAnchorId: this.checkpointAnchorId,
          }
        : {}),
      checkpointRoomId: this.checkpointRoomId,
      visited: [...this.visited],
      defeated: [...this.defeated],
      events: plain(this.events),
      transactions: this.transactions.capture(),
      platform: serializeCheckpoint(this.world),
    };
  }
  /** Immutable normalized content key; cached once, never part of saved schemas. */
  persistenceContentKey(): string {
    return (this.persistenceContent ??= canonical({
      definitions: this.definitions,
      campaign: this.definition,
      identity: this.identity,
    }));
  }
  /** Exact prospective sizes without traversing retained history or immutable content.
   * quotedBytes includes the two quotes required by an enclosing JSON string. */
  persistenceByteSizes(): {
    checkpoint: CampaignJSONByteSize;
    progress: CampaignJSONByteSize;
  } {
    const size = campaignJSONByteSize;
    const state = this.captureState();
    const dynamic = Object.entries(state).map(
      ([key, value]) => [key, size(value)] as const,
    );
    const format = this.behaviorEnabled
      ? "campaign-platform-v3"
      : "campaign-platform-v2";
    const header = (this.persistenceHeader ??= [
      ["identity", size(this.identity)],
      ["definition", size(this.definition)],
    ] as const);
    let base = size(null);
    if (this.base) {
      base = this.persistenceBaseSizes.get(this.base) ?? size(this.base);
      this.persistenceBaseSizes.set(this.base, base);
    }
    const commas = Math.max(0, this.history.length - 1);
    const history = {
      bytes: 2 + this.historyBytes + commas,
      quotedBytes: 4 + this.historyQuotedBodyBytes + commas,
    };
    const checkpoint = objectByteSize([
      ...header,
      ["format", size(format)],
      ["revision", size(this.history.length)],
      ...dynamic,
      ["base", base],
      ["history", history],
    ]);
    const progress = objectByteSize([
      ...header,
      ["kind", size("campaign-platform-progress")],
      ["version", size(1)],
      ["compatibility", size(1)],
      ...dynamic.filter(
        ([key]) =>
          !["platform", "behaviors", "roomId", "anchorId"].includes(key),
      ),
    ]);
    return { checkpoint, progress };
  }
  checkpoint(): string {
    return canonical({
      format: this.behaviorEnabled
        ? "campaign-platform-v3"
        : "campaign-platform-v2",
      identity: this.identity,
      definition: this.definition,
      revision: this.history.length,
      ...this.captureState(),
      base: this.base,
      history: this.history,
    });
  }
  /** Portable durable progress deliberately omits active platform state and replay tail. */
  progress(): string {
    const {
      platform: _platform,
      behaviors: _behaviors,
      roomId: _roomId,
      anchorId: _anchorId,
      ...durable
    } = this.captureState();
    return canonical({
      kind: "campaign-platform-progress",
      version: 1,
      compatibility: 1,
      identity: this.identity,
      definition: this.definition,
      ...durable,
    });
  }
  private parse(bytes: string, limit: number): Record<string, unknown> {
    if (typeof bytes !== "string")
      throw Error("Campaign checkpoint bytes required");
    return plain(
      boundedJSON(bytes, limit, { rejectNegativeZero: true }),
      2 * 1024 * 1024,
    ) as Record<string, unknown>;
  }
  /** Validate bounded monotonic discoveries and authored transaction sources. This
   * is progression consistency, not proof of historical movement or anti-cheat. */
  private durable(value: Record<string, unknown>): void {
    const events = array(
      value.events,
      CAMPAIGN_PLATFORM_LIMITS.progressEvents,
    ) as ProgressEvent[];
    const tx = new TransactionOwner(this.definition.transactions);
    const commands = array(
      (value.transactions as Record<string, unknown>)?.commands,
      64,
    );
    const visited = [this.definition.initialRoom];
    let applied = 0;
    const gate = (exit: CampaignExit) =>
      !exit.requires ||
      tx.capture().flags.some((f) => f.id === exit.requires && f.value);
    for (const [eventIndex, event] of events.entries()) {
      if (event.kind === "visit") {
        record(event, ["kind", "id", "from", "exit"]);
        if (!visited.includes(event.from) || visited.includes(event.id))
          throw Error("Invalid campaign discovery order");
        const exit = this.room(event.from).exits.find(
          (e) => e.id === event.exit,
        );
        if (!exit || exit.to !== event.id || !gate(exit))
          throw Error("Unreachable campaign discovery");
        if (exit.outcome && !tx.capture().outcomes.includes(exit.outcome.id)) {
          const nextEvent = events[eventIndex + 1];
          if (nextEvent?.kind !== "outcome" || nextEvent.id !== exit.outcome.id)
            throw Error("Campaign discovery missing authored exit outcome");
        }
        visited.push(event.id);
      } else if (event.kind === "outcome") {
        record(event, ["kind", "id"]);
        const source = this.definition.rooms.find(
          (room) =>
            room.pickups.some((p) => p.outcome.id === event.id) ||
            room.exits.some((e) => e.outcome?.id === event.id),
        );
        const exit = source?.exits.find((e) => e.outcome?.id === event.id);
        const pickup = source?.pickups.find((p) => p.outcome.id === event.id);
        const outcome =
          exit?.outcome ??
          source?.pickups.find((p) => p.outcome.id === event.id)?.outcome;
        if (
          !source ||
          !outcome ||
          !visited.includes(source.id) ||
          (pickup?.requires &&
            !tx
              .capture()
              .flags.some((f) => f.id === pickup.requires && f.value)) ||
          (exit && (!gate(exit) || !visited.includes(exit.to)))
        )
          throw Error("Unreachable campaign outcome");
        const command = commands[applied++] as ReturnType<
          TransactionOwner["capture"]
        >["commands"][number];
        if (
          !command ||
          command.outcome !== outcome.id ||
          canonical(command.operations) !== canonical(outcome.operations)
        )
          throw Error("Invalid campaign authored transaction");
        tx.execute(command);
      } else throw Error("Unknown campaign progress event");
    }
    if (
      applied !== commands.length ||
      canonical(tx.capture()) !== canonical(value.transactions) ||
      canonical(visited) !== canonical(value.visited)
    )
      throw Error("Inconsistent campaign durable progress");
    const checkpointRoom = this.room(string(value.checkpointRoomId));
    if (this.anchorEnabled) {
      const id = value.checkpointAnchorId;
      if (
        id !== null &&
        (typeof id !== "string" ||
          !checkpointRoom.anchors?.some((a) => a.id === id))
      )
        throw Error("Invalid recovery ingress anchor");
      this.checkpointAnchorId = id as string | null;
    }
    if (
      !visited.includes(checkpointRoom.id) ||
      (checkpointRoom.id !== this.definition.initialRoom &&
        !checkpointRoom.checkpoint)
    )
      throw Error("Invalid campaign checkpoint entrance");
    const defeated = array(
      value.defeated,
      this.definition.rooms.length * 256,
    ).map((v) => {
      if (typeof v !== "string")
        throw Error("Invalid campaign permanent death");
      const placement = JSON.parse(v);
      if (
        !Array.isArray(placement) ||
        placement.length !== 2 ||
        !visited.includes(placement[0]) ||
        !this.room(placement[0]).permanentEnemies.includes(placement[1]) ||
        JSON.stringify(placement) !== v
      )
        throw Error("Invalid campaign permanent death");
      return v;
    });
    if (canonical([...new Set(defeated)].sort()) !== canonical(defeated))
      throw Error("Invalid campaign permanent death order");
    for (const room of this.definition.rooms)
      for (const pickup of room.pickups)
        if (
          tx.capture().outcomes.includes(pickup.outcome.id) &&
          pickup.requiresDefeated?.some(
            (id) => !defeated.includes(JSON.stringify([room.id, id])),
          )
        )
          throw Error("Campaign completion missing permanent defeat");
    this.transactions = tx;
    this.visited = visited;
    this.events = plain(events);
    this.checkpointRoomId = checkpointRoom.id;
    this.defeated = defeated;
  }
  private compact(value: unknown): void {
    const state = record(value, [
      ...(this.behaviorEnabled ? ["behaviors"] : []),
      ...(this.anchorEnabled ? ["anchorId", "checkpointAnchorId"] : []),
      "roomId",
      "checkpointRoomId",
      "visited",
      "defeated",
      "events",
      "transactions",
      "platform",
    ]);
    this.durable(state);
    this.roomId = string(state.roomId);
    if (this.anchorEnabled) {
      this.anchorId = state.anchorId as string | null;
      if (
        this.anchorId !== null &&
        !this.room().anchors?.some((a) => a.id === this.anchorId)
      )
        throw Error("Invalid active ingress anchor");
    }
    if (!this.visited.includes(this.roomId))
      throw Error("Invalid active campaign room");
    if (typeof state.platform !== "string")
      throw Error("Invalid compact platform");
    const world = restoreCheckpoint(
      this.definitions,
      this.identity,
      state.platform,
    );
    if (world.inputCodec !== this.definition.inputCodec)
      throw Error("Compact platform input codec mismatch");
    if (
      world.scenarioId !== this.room().scenarioId ||
      world.levelId !==
        this.definitions.scenarios.find(
          (scenario) => scenario.id === this.room().scenarioId,
        )!.levelId ||
      canonical(world.campaign.visitedLevelIds) !== canonical([world.levelId])
    )
      throw Error("Compact platform room mismatch");
    const localDeaths = world.actors
      .filter((actor) => actor.health === 0)
      .map((actor) => JSON.stringify([world.levelId, actor.spawnId]))
      .sort();
    if (
      canonical([...world.campaign.defeatedPlacementIds].sort()) !==
      canonical(localDeaths)
    )
      throw Error("Compact platform death ledger mismatch");
    for (const actor of world.actors) {
      const permanent = this.room().permanentEnemies.includes(actor.spawnId);
      if (
        permanent &&
        (actor.health === 0) !==
          this.defeated.includes(JSON.stringify([this.roomId, actor.spawnId]))
      )
        throw Error("Compact permanent enemy mismatch");
    }
    this.behaviors = this.behaviorEnabled
      ? validateCampaignBehaviors(state.behaviors, this.room().behaviors ?? [])
      : [];
    this.world = world;
  }
  private adopt(next: CampaignPlatformOwner): void {
    this.persistenceGuard?.(next);
    this.anchorId = next.anchorId;
    this.checkpointAnchorId = next.checkpointAnchorId;
    this.world = next.world;
    this.behaviors = next.behaviors;
    this.transactions = next.transactions;
    this.roomId = next.roomId;
    this.checkpointRoomId = next.checkpointRoomId;
    this.visited = next.visited;
    this.defeated = next.defeated;
    this.events = next.events;
    this.base = next.base;
    this.history = next.history;
    this.historyBytes = next.historyBytes;
    this.historyQuotedBodyBytes = next.historyQuotedBodyBytes;
    this.revision++;
  }
  /** Fully validate external bytes once, then let a composite validate its own
   * witness before adopting. The staged owner stays inaccessible: only detached
   * metadata and a single-use publication capability leave this method. */
  protected prepareCampaignRestore(
    bytes: string,
    portable: boolean,
    authored: CampaignPlatformDefinition = this.definition,
  ) {
    const next = new CampaignPlatformOwner(
      this.definitions,
      this.identity,
      authored,
      this.simulationOptions,
    );
    if (portable) next.restoreProgress(bytes);
    else next.restore(bytes);
    const revision = this.revision;
    let available = true;
    return {
      roomId: next.roomId,
      checkpoint: next.checkpoint(),
      progress: next.progress(),
      // Keep the command-local work cap and detached metadata; an aggregate copy
      // must not impose a tighter limit than the reader that admitted each command.
      history: next.history.map((command) =>
        plain(command),
      ) as readonly CampaignPlatformCommand[],
      adopt: () => {
        if (!available || revision !== this.revision)
          throw Error("Stale prepared campaign restore");
        if (canonical(next.definition) !== canonical(this.definition))
          throw Error("Prepared campaign definition mismatch");
        available = false;
        this.adopt(next);
      },
    };
  }
  restoreProgress(bytes: string): void {
    const value = this.parse(bytes, CAMPAIGN_PLATFORM_LIMITS.progressBytes);
    record(value, [
      "kind",
      "version",
      "compatibility",
      "identity",
      "definition",
      "checkpointRoomId",
      ...(this.anchorEnabled ? ["checkpointAnchorId"] : []),
      "visited",
      "defeated",
      "events",
      "transactions",
    ]);
    if (
      value.kind !== "campaign-platform-progress" ||
      value.version !== 1 ||
      value.compatibility !== 1 ||
      canonical(value.identity) !== canonical(this.identity) ||
      canonical(value.definition) !== canonical(this.definition)
    )
      throw Error(
        "Portable campaign version/compatibility mismatch; no migration is registered",
      );
    const next = new CampaignPlatformOwner(
      this.definitions,
      this.identity,
      this.definition,
      this.simulationOptions,
    );
    next.durable(value);
    next.roomId = next.checkpointRoomId;
    next.anchorId = next.checkpointAnchorId;
    next.world = next.enter(next.roomId, next.defeated, next.anchorId);
    next.behaviors = createCampaignBehaviors(next.room().behaviors ?? []);
    next.base = next.captureState();
    this.adopt(next);
  }
  /** v1 exact history is explicitly replayed. v2 validates a compact base then
   * replays a bounded exact tail; compact bases provide structural validation. */
  restore(bytes: string): void {
    const value = this.parse(bytes, CAMPAIGN_PLATFORM_LIMITS.bytes);
    const legacy = value.format === "campaign-platform-v1";
    record(
      value,
      legacy
        ? [
            "format",
            "identity",
            "definition",
            "revision",
            "roomId",
            "checkpointRoomId",
            "visited",
            "defeated",
            "transactions",
            "platform",
            "history",
          ]
        : [
            "format",
            "identity",
            "definition",
            "revision",
            "roomId",
            "checkpointRoomId",
            "visited",
            "defeated",
            "events",
            "transactions",
            "platform",
            "base",
            "history",
            ...(this.behaviorEnabled ? ["behaviors"] : []),
            ...(this.anchorEnabled ? ["anchorId", "checkpointAnchorId"] : []),
          ],
    );
    if (
      (legacy
        ? this.behaviorEnabled
        : value.format !==
          (this.behaviorEnabled
            ? "campaign-platform-v3"
            : "campaign-platform-v2")) ||
      canonical(value.identity) !== canonical(this.identity) ||
      canonical(value.definition) !== canonical(this.definition)
    )
      throw Error("Campaign checkpoint compatibility mismatch");
    const revision = integer(
      value.revision,
      0,
      CAMPAIGN_PLATFORM_LIMITS.commands,
    );
    const history = array(value.history, CAMPAIGN_PLATFORM_LIMITS.commands);
    if (history.length !== revision)
      throw Error("Campaign checkpoint history mismatch");
    const next = new CampaignPlatformOwner(
      this.definitions,
      this.identity,
      this.definition,
      this.simulationOptions,
    );
    next.legacy = legacy;
    if (!legacy && value.base !== null) {
      next.compact(value.base);
      next.base = next.captureState();
    }
    for (const command of history)
      next.execute(command as CampaignPlatformCommand);
    if (next.historyBytes > CAMPAIGN_PLATFORM_LIMITS.historyBytes)
      throw Error("Campaign history byte cap");
    if (legacy) {
      const { events: _events, ...state } = next.captureState();
      if (
        canonical(value) !==
        canonical({
          format: "campaign-platform-v1",
          identity: this.identity,
          definition: this.definition,
          revision: next.history.length,
          ...state,
          history: next.history,
        })
      )
        throw Error("Inconsistent campaign checkpoint");
      next.legacy = false;
      next.base = next.captureState();
      next.history = [];
      next.historyBytes = 0;
      next.historyQuotedBodyBytes = 0;
    } else if (canonical(value) !== next.checkpoint())
      throw Error("Inconsistent campaign checkpoint");
    this.adopt(next);
  }
}
