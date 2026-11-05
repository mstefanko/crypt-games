/** Sustained P2 action room. One motor owns voluntary movement and impulses;
 * every gathered hit/blast sees pre-commit terrain, then routes are invalidated. */
import {
  admitDestructionConfiguration,
  advanceDestructionState,
  canonicalDestructionData as canonical,
  destructionCollisionShapes,
  DESTRUCTION_LIMITS,
  type DamageableDefinition,
  type DestructionConfiguration,
  type DestructionHit,
  type DestructionState,
} from "./destruction";
import {
  createBehaviorActor,
  stepBehavior,
  BEHAVIOR_DESCRIPTORS,
  type BehaviorActor,
  type BehaviorRole,
} from "./behavior";
import {
  ImpulseChannel,
  type ImpulseChannelState,
  type ImpulseRequest,
} from "./impulse-channel";
import {
  geometrySegment,
  queryGeometry,
  type GeometryRect,
  type GeometryShape,
} from "./geometry";
import { arenaOverlaps, moveArenaBody } from "./m3/arena-geometry";
import type { ArenaWorld, ArenaRect } from "./m3/arena-types";
import { SustainedNavigationScheduler } from "./navigation-service";
import type { NavigationGrid } from "./navigation";

/** The historical motor reads only definition dimensions/walls. Keep its source
 * bytes and rule identities intact while narrowing its callable contract here;
 * this adapter supplies exactly those dependencies, without fabricating a world. */
const moveEncounterBody = moveArenaBody as (
  world: {
    definition: Pick<ArenaWorld["definition"], "width" | "height" | "walls">;
  },
  body: ArenaRect,
  dx: number,
  dy: number,
) => void;

export const ACTION_ENCOUNTER_LIMITS = Object.freeze({
  enemies: 8,
  modifiers: 8,
  tile: 512,
  body: 128,
  dimension: 8192,
  moveSpeed: 128,
  enemySpeed: 64,
  weaponRange: 4096,
  fireCooldown: 6,
  replayRuns: 1024,
  replayTicks: 65536,
  checkpointCharacters: 1048576,
});
export interface ActionEncounterModifier {
  readonly id: string;
  readonly damageBonus: number;
  readonly healthBonus: number;
}
export interface ActionEncounterConfiguration {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly player: {
    readonly x: number;
    readonly y: number;
    readonly hp: number;
  };
  readonly enemies: readonly {
    readonly id: string;
    readonly role: BehaviorRole;
    readonly x: number;
    readonly y: number;
    readonly hp: number;
  }[];
  readonly objects: readonly DamageableDefinition[];
  /** Author order is retained. Each bounded modifier applies once at room creation. */
  readonly modifiers: readonly ActionEncounterModifier[];
}
export interface ActionEncounterInput {
  readonly moveX: number;
  readonly moveY: number;
  readonly aimX: number;
  readonly aimY: number;
  readonly fire: boolean;
}
export interface ActionEncounterActor {
  id: string;
  role: "player" | BehaviorRole;
  x: number;
  y: number;
  width: number;
  height: number;
  hp: number;
  maxHp: number;
  freezeTicks: number;
  fireCooldown: number;
  behavior: BehaviorActor | null;
}
export interface ActionEncounterRoute {
  enemyId: string;
  revision: number;
  start: number;
  goal: number;
  path: number[];
}
export interface ActionEncounterState {
  tick: number;
  status: "playing" | "cleared" | "defeated";
  player: ActionEncounterActor;
  enemies: ActionEncounterActor[];
  world: DestructionState;
  impulse: ImpulseChannelState;
  aim: { x: number; y: number };
  routes: ActionEncounterRoute[];
  routeInvalidations: number;
}
export interface ActionEncounterObservation extends ActionEncounterState {
  rewardTotal: number;
  terrainRevision: number;
}
export interface ActionEncounterReplayRun {
  readonly ticks: number;
  readonly input: ActionEncounterInput;
}
export interface ActionEncounterCheckpoint {
  format: "p2-action-encounter-v2";
  configuration: ActionEncounterConfiguration;
  /** Bounded, canonical RLE actions verified from the authored initial state. */
  replay: ActionEncounterReplayRun[];
  state: ActionEncounterState;
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function fields(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw Error("Action encounter fields");
  return value as Record<string, unknown>;
}
function integer(
  value: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER - 1,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < min ||
    value > max
  )
    throw Error("Action encounter integer");
  return value;
}
function identity(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(value)
  )
    throw Error("Action encounter identity");
  return value;
}
function command(value: unknown): ActionEncounterInput {
  canonical(value);
  const r = fields(value, ["moveX", "moveY", "aimX", "aimY", "fire"]);
  if (typeof r.fire !== "boolean") throw Error("Action encounter fire");
  return {
    moveX: integer(r.moveX, -1, 1),
    moveY: integer(r.moveY, -1, 1),
    aimX: integer(r.aimX, -1, 1),
    aimY: integer(r.aimY, -1, 1),
    fire: r.fire,
  };
}
function admit(value: unknown): ActionEncounterConfiguration {
  canonical(value);
  const r = fields(value, [
    "id",
    "width",
    "height",
    "player",
    "enemies",
    "objects",
    "modifiers",
  ]);
  const width = integer(r.width, 1024, 8192),
    height = integer(r.height, 1024, 8192);
  if (width % 512 || height % 512)
    throw Error("Action encounter tile dimensions");
  const p = fields(r.player, ["x", "y", "hp"]);
  const player = {
    x: integer(p.x, 0, width - 128),
    y: integer(p.y, 0, height - 128),
    hp: integer(p.hp, 1, 4096),
  };
  if (
    !Array.isArray(r.enemies) ||
    r.enemies.length > 8 ||
    !Array.isArray(r.modifiers) ||
    r.modifiers.length > 8
  )
    throw Error("Action encounter capacity");
  const enemies = r.enemies
    .map((value) => {
      const e = fields(value, ["id", "role", "x", "y", "hp"]);
      if (e.role !== "bruiser" && e.role !== "ranger")
        throw Error("Action encounter role");
      return {
        id: identity(e.id),
        role: e.role,
        x: integer(e.x, 0, width - 128),
        y: integer(e.y, 0, height - 128),
        hp: integer(e.hp, 1, 4096),
      };
    })
    .sort((a, b) => order(a.id, b.id));
  const modifiers = r.modifiers.map((value) => {
    const m = fields(value, ["id", "damageBonus", "healthBonus"]);
    return {
      id: identity(m.id),
      damageBonus: integer(m.damageBonus, 0, 64),
      healthBonus: integer(m.healthBonus, 0, 64),
    };
  });
  const objects = admitDestructionConfiguration({ objects: r.objects }).objects;
  const ids = [
    "hero",
    ...enemies.map((e) => e.id),
    ...objects.map((o) => o.id),
  ];
  if (
    new Set(ids).size !== ids.length ||
    new Set(modifiers.map((m) => m.id)).size !== modifiers.length
  )
    throw Error("Duplicate action identity");
  for (const o of objects)
    if (
      o.rect.x < 0 ||
      o.rect.y < 0 ||
      o.rect.x + o.rect.width > width ||
      o.rect.y + o.rect.height > height
    )
      throw Error("Action object outside room");
  for (const actor of [player, ...enemies])
    if (
      objects.some((o) =>
        arenaOverlaps({ ...actor, width: 128, height: 128 }, { ...o.rect }),
      )
    )
      throw Error("Action spawn overlaps terrain");
  if (
    [player, ...enemies].some((a, i, all) =>
      all
        .slice(i + 1)
        .some((b) =>
          arenaOverlaps(
            { ...a, width: 128, height: 128 },
            { ...b, width: 128, height: 128 },
          ),
        ),
    )
  )
    throw Error("Overlapping action spawns");
  return {
    id: identity(r.id),
    width,
    height,
    player,
    enemies: enemies as ActionEncounterConfiguration["enemies"],
    objects,
    modifiers,
  };
}
function worldConfig(
  c: ActionEncounterConfiguration,
): DestructionConfiguration {
  return { objects: c.objects };
}
function policies(c: ActionEncounterConfiguration) {
  return [
    { targetId: "hero", resistance256: 128 },
    ...c.enemies.map((e) => ({
      targetId: e.id,
      resistance256: e.role === "bruiser" ? 128 : 0,
    })),
  ];
}
function initial(c: ActionEncounterConfiguration): ActionEncounterState {
  const actor = (
    id: string,
    role: ActionEncounterActor["role"],
    x: number,
    y: number,
    hp: number,
  ): ActionEncounterActor => ({
    id,
    role,
    x,
    y,
    width: 128,
    height: 128,
    hp,
    maxHp: hp,
    freezeTicks: 0,
    fireCooldown: 0,
    behavior:
      role === "player" ? null : { ...createBehaviorActor(role), position: 0 },
  });
  const state: ActionEncounterState = {
    tick: 0,
    status: c.enemies.length ? "playing" : "cleared",
    player: actor(
      "hero",
      "player",
      c.player.x,
      c.player.y,
      c.player.hp + c.modifiers.reduce((sum, m) => sum + m.healthBonus, 0),
    ),
    enemies: c.enemies.map((e) => actor(e.id, e.role, e.x, e.y, e.hp)),
    world: {
      tick: 0,
      terrainRevision: 0,
      objects: c.objects.map((o) => ({ id: o.id, hp: o.hp, detonated: false })),
      pending: [],
      rewarded: [],
      rewardTotal: 0,
      destroyed: [],
      receipts: [],
      counters: { candidates: 0, coverRays: 0, coverTests: 0 },
    },
    impulse: new ImpulseChannel(policies(c)).capture(),
    aim: { x: 1, y: 0 },
    routes: [],
    routeInvalidations: 0,
  };
  return state;
}
function terrain(
  c: ActionEncounterConfiguration,
  w: DestructionState,
): GeometryShape[] {
  return destructionCollisionShapes(worldConfig(c), w);
}
function grid(
  c: ActionEncounterConfiguration,
  w: DestructionState,
): NavigationGrid {
  const shapes = terrain(c, w),
    width = c.width / 512,
    height = c.height / 512;
  return {
    width,
    height,
    revision: w.terrainRevision,
    costs: Array.from({ length: width * height }, (_, cell) =>
      shapes.some((s) =>
        arenaOverlaps(
          {
            x: (cell % width) * 512,
            y: Math.floor(cell / width) * 512,
            width: 512,
            height: 512,
          },
          { ...s.rect },
        ),
      )
        ? 0
        : 1,
    ),
  };
}
function cell(c: ActionEncounterConfiguration, a: ActionEncounterActor) {
  return (
    Math.floor((a.y + 64) / 512) * (c.width / 512) +
    Math.floor((a.x + 64) / 512)
  );
}
function route(
  c: ActionEncounterConfiguration,
  w: DestructionState,
  a: ActionEncounterActor,
  target: ActionEncounterActor,
): ActionEncounterRoute {
  const g = grid(c, w),
    start = cell(c, a),
    goal = cell(c, target);
  const navigation = new SustainedNavigationScheduler(g);
  const request = navigation.request({ algorithm: "bfs", start, goal });
  navigation.step(256);
  const result = navigation.observe().searches.find((s) => s.id === request)!;
  return {
    enemyId: a.id,
    revision: w.terrainRevision,
    start,
    goal,
    path:
      g.costs[start] && g.costs[goal] && result.status === "found"
        ? result.path
        : [],
  };
}
function motor(
  c: ActionEncounterConfiguration,
  walls: GeometryShape[],
  a: ActionEncounterActor,
  x: number,
  y: number,
): { x: number; y: number } {
  const before = { x: a.x, y: a.y };
  // The existing arena motor reads only dimensions and walls. Reuse that exact
  // axis sweep; this encounter does not introduce a second contact algorithm.
  moveEncounterBody(
    {
      definition: {
        width: c.width,
        height: c.height,
        walls: walls.map((s) => ({ id: s.bodyId, ...s.rect })),
      },
    },
    a,
    x,
    y,
  );
  return { x: a.x - before.x, y: a.y - before.y };
}
const center = (r: GeometryRect) => ({
  x: r.x + Math.floor(r.width / 2),
  y: r.y + Math.floor(r.height / 2),
});
function blocked(
  walls: GeometryShape[],
  source: GeometryRect,
  target: GeometryRect,
  exclude: string[] = [],
) {
  const a = center(source),
    b = center(target);
  return walls.some(
    (s) =>
      !exclude.includes(s.bodyId) &&
      geometrySegment(a, { x: b.x - a.x, y: b.y - a.y }, s.rect),
  );
}
function outcome(s: ActionEncounterState): ActionEncounterState["status"] {
  return s.player.hp === 0
    ? "defeated"
    : s.enemies.every((e) => e.hp === 0) && !s.world.pending.length
      ? "cleared"
      : "playing";
}
function advance(
  c: ActionEncounterConfiguration,
  before: ActionEncounterState,
  input: ActionEncounterInput,
): ActionEncounterState {
  if (before.status !== "playing")
    throw Error("Action encounter is terminal; reset or travel");
  if (before.tick >= Number.MAX_SAFE_INTEGER - 2)
    throw Error("Action encounter clock exhausted");
  const s = copy(before),
    walls = terrain(c, before.world),
    hits: DestructionHit[] = [],
    impulses: ImpulseRequest[] = [];
  s.tick++;
  s.routes = [];
  s.player.fireCooldown = Math.max(0, s.player.fireCooldown - 1);
  for (const a of [s.player, ...s.enemies])
    a.freezeTicks = Math.max(0, a.freezeTicks - 1);
  if (input.aimX || input.aimY) s.aim = { x: input.aimX, y: input.aimY };
  const damage = new Map<string, number>();
  const hit = (
    target: ActionEncounterActor,
    amount: number,
    sourceId: string,
    x: number,
    y: number,
  ) => {
    if (target.hp === 0) return;
    damage.set(target.id, (damage.get(target.id) ?? 0) + amount);
    // Quantized diagonals share the same L1 budget as cardinal knockback.
    if (x && y) {
      x = Math.trunc(x / 2);
      y = Math.trunc(y / 2);
    }
    impulses.push({ sourceId, targetId: target.id, x, y });
  };
  if (!before.player.freezeTicks) {
    // Diagonal intent shares the same L1 speed budget as cardinal movement.
    const scale = input.moveX && input.moveY ? 64 : 128;
    motor(c, walls, s.player, input.moveX * scale, input.moveY * scale);
    if (input.fire && s.player.fireCooldown === 0) {
      s.player.fireCooldown = 6;
      const targets: GeometryShape[] = [
        ...walls,
        ...s.enemies
          .filter((e) => e.hp > 0)
          .map((e) => ({
            bodyId: e.id,
            shapeId: "body",
            owner: "p2-actor",
            category: "actor" as const,
            region: "body" as const,
            sensor: false,
            priority: 1,
            rect: { x: e.x, y: e.y, width: 128, height: 128 },
          })),
      ];
      const origin = center(s.player),
        target = queryGeometry(targets, {
          kind: "sweep",
          rect: { ...origin, width: 1, height: 1 },
          delta: {
            x: s.aim.x * (s.aim.x && s.aim.y ? 2048 : 4096),
            y: s.aim.y * (s.aim.x && s.aim.y ? 2048 : 4096),
          },
        }).contacts[0];
      if (target) {
        const amount =
            2 + c.modifiers.reduce((sum, m) => sum + m.damageBonus, 0),
          actor = s.enemies.find((e) => e.id === target.bodyId);
        if (actor) hit(actor, amount, "weapon", s.aim.x * 512, s.aim.y * 512);
        else
          hits.push({
            eventId: "weapon",
            sourceId: "hero",
            targetId: target.bodyId,
            damage: amount,
          });
      }
    }
  }
  for (const a of s.enemies) {
    if (a.hp === 0 || before.enemies.find((e) => e.id === a.id)!.freezeTicks)
      continue;
    const distance = Math.abs(a.x - s.player.x) + Math.abs(a.y - s.player.y);
    const decision = stepBehavior(
      { ...a.behavior!, position: Math.min(32, Math.ceil(distance / 512)) },
      { target: 0, threatened: input.fire && distance <= 512 },
    );
    a.behavior = decision.actor;
    const cached = before.routes.find((r) => r.enemyId === a.id),
      start = cell(c, a),
      goal = cell(c, s.player);
    const path =
      cached &&
      cached.revision === before.world.terrainRevision &&
      cached.start === start &&
      cached.goal === goal
        ? cached
        : route(c, before.world, a, s.player);
    s.routes.push(copy(path));
    if (decision.actor.state === "approach" && path.path.length > 1) {
      const next = path.path[1],
        x = (next % (c.width / 512)) * 512 + 192,
        y = Math.floor(next / (c.width / 512)) * 512 + 192;
      // Center in the current row before turning, so a cached orthogonal path
      // cannot cut a corner into an adjacent blocking cell.
      const dx = x - a.x,
        dy = y - a.y;
      if (Math.abs(dx) >= Math.abs(dy))
        motor(c, walls, a, Math.sign(dx) * Math.min(64, Math.abs(dx)), 0);
      else motor(c, walls, a, 0, Math.sign(dy) * Math.min(64, Math.abs(dy)));
    } else if (decision.actor.state === "retreat") {
      const dx = Math.sign(a.x - s.player.x) || 1,
        dy = Math.sign(a.y - s.player.y);
      motor(c, walls, a, dx * (dy ? 32 : 64), dy * 32);
    }
    if (
      decision.damage &&
      distance <= BEHAVIOR_DESCRIPTORS[a.role as BehaviorRole].range * 512 &&
      !blocked(walls, a, s.player)
    ) {
      hit(
        s.player,
        decision.damage,
        `enemy-${a.id}`,
        Math.sign(s.player.x - a.x) * 256,
        Math.sign(s.player.y - a.y) * 256,
      );
    }
  }
  // A destruction hit queues its explosion for the following tick. Existing
  // pending sources explode now, against the same terrain used by all motors.
  for (const pending of before.world.pending) {
    const source = c.objects.find((o) => o.id === pending.sourceId)!,
      blast = source.blast!,
      origin = center(source.rect);
    for (const a of [s.player, ...s.enemies]) {
      if (
        !a.hp ||
        (!blast.friendlyFire && source.team === (a.role === "player" ? 0 : 1))
      )
        continue;
      const point = center(a),
        dx = point.x - origin.x,
        dy = point.y - origin.y;
      const band = blast.bands.find(
        (b) => dx * dx + dy * dy <= b.radius * b.radius,
      );
      if (!band || blocked(walls, source.rect, a, [source.id])) continue;
      hit(
        a,
        band.damage,
        `blast-${c.objects.indexOf(source)}`,
        Math.sign(dx) * 512,
        Math.sign(dy) * 512,
      );
    }
  }
  s.world = advanceDestructionState(worldConfig(c), before.world, {
    hits,
    ignite: [],
  });
  for (const a of [s.player, ...s.enemies]) {
    a.hp = Math.max(0, a.hp - (damage.get(a.id) ?? 0));
    if (damage.has(a.id) && a.hp) a.freezeTicks = 2;
  }
  const channel = new ImpulseChannel(policies(c));
  channel.restore(before.impulse);
  // Bound incoming requests by the actor cap. Gather in stable phase order,
  // clamp each actor's summed L1 impulse to 2048, then apply resistance once.
  const gathered = [s.player, ...s.enemies].flatMap((a) => {
    const requests = impulses.filter((r) => r.targetId === a.id);
    if (!requests.length) return [];
    let x = requests.reduce((sum, r) => sum + r.x, 0),
      y = requests.reduce((sum, r) => sum + r.y, 0);
    const size = Math.abs(x) + Math.abs(y);
    if (size > 2048) {
      x = Math.trunc((x * 2048) / size) || 0;
      y = Math.trunc((y * 2048) / size) || 0;
    }
    return [{ sourceId: "gathered", targetId: a.id, x, y }];
  });
  channel.queue(gathered);
  channel.advance(
    [s.player, ...s.enemies].map((a) => ({
      targetId: a.id,
      alive: a.hp > 0,
      frozen:
        (a.id === "hero"
          ? before.player
          : before.enemies.find((e) => e.id === a.id)!
        ).freezeTicks > 0,
    })),
    (id, x, y) =>
      motor(c, walls, [s.player, ...s.enemies].find((a) => a.id === id)!, x, y),
  );
  s.impulse = channel.capture();
  if (s.world.terrainRevision !== before.world.terrainRevision) {
    s.routes = [];
    s.routeInvalidations = Math.min(
      Number.MAX_SAFE_INTEGER - 1,
      s.routeInvalidations + 1,
    );
  }
  s.status = outcome(s);
  return s;
}
function strings(value: unknown, ids: readonly string[]): string[] {
  if (
    !Array.isArray(value) ||
    value.length > ids.length ||
    value.some(
      (id, i) =>
        typeof id !== "string" ||
        !ids.includes(id) ||
        (i > 0 && order(value[i - 1], id) >= 0),
    )
  )
    throw Error("Action world identity order");
  return value as string[];
}
function validateWorld(
  c: ActionEncounterConfiguration,
  value: unknown,
  tick: number,
): DestructionState {
  const w = fields(value, [
    "tick",
    "terrainRevision",
    "objects",
    "pending",
    "rewarded",
    "rewardTotal",
    "destroyed",
    "receipts",
    "counters",
  ]);
  if (
    w.tick !== tick ||
    !Array.isArray(w.objects) ||
    w.objects.length !== c.objects.length
  )
    throw Error("Action world clock/object set");
  const dead: string[] = [],
    pendingIds: string[] = [];
  for (const [i, entry] of w.objects.entries()) {
    const o = fields(entry, ["id", "hp", "detonated"]),
      definition = c.objects[i];
    if (o.id !== definition.id || typeof o.detonated !== "boolean")
      throw Error("Action world object identity");
    integer(o.hp, 0, definition.hp);
    if (o.detonated && (!definition.blast || o.hp !== 0))
      throw Error("Action world detonation");
    if (o.hp === 0) {
      dead.push(definition.id);
      if (definition.blast && !o.detonated) pendingIds.push(definition.id);
    }
  }
  const rewarded = strings(
    w.rewarded,
    c.objects.map((o) => o.id),
  );
  if (canonical(rewarded) !== canonical(dead))
    throw Error("Action world once-only rewards");
  const total = c.objects.reduce(
    (sum, o) => sum + (dead.includes(o.id) ? o.reward : 0),
    0,
  );
  if (w.rewardTotal !== total) throw Error("Action world reward total");
  const removed = c.objects.filter(
    (o) => dead.includes(o.id) && !o.brokenBlocking,
  ).length;
  integer(w.terrainRevision, removed ? 1 : 0, Math.min(tick, removed));
  if (!Array.isArray(w.pending) || w.pending.length !== pendingIds.length)
    throw Error("Action world chain queue");
  for (const [i, entry] of w.pending.entries()) {
    const p = fields(entry, ["sourceId", "readyTick"]);
    if (p.sourceId !== pendingIds[i] || p.readyTick !== tick + 1)
      throw Error("Action world pending identity/clock");
  }
  strings(w.destroyed, dead);
  if (
    !Array.isArray(w.receipts) ||
    w.receipts.length > DESTRUCTION_LIMITS.receiptsPerTick
  )
    throw Error("Action world receipt cap");
  for (const entry of w.receipts) {
    const r = fields(entry, [
      "eventId",
      "sourceId",
      "targetId",
      "kind",
      "outcome",
      "damage",
    ]);
    if (
      typeof r.eventId !== "string" ||
      typeof r.sourceId !== "string" ||
      !c.objects.some((o) => o.id === r.targetId) ||
      (r.kind !== "hit" && r.kind !== "blast") ||
      !["damage", "covered", "team", "inactive"].includes(r.outcome as string)
    )
      throw Error("Action world receipt");
    integer(
      r.damage,
      r.outcome === "damage" ? 1 : 0,
      r.outcome === "damage" ? 1024 : 0,
    );
    if (
      !r.eventId.startsWith(`${r.kind}:${tick}:`) ||
      (r.kind === "blast" &&
        !c.objects.some(
          (o, i) =>
            o.id === r.sourceId &&
            o.blast &&
            (w.objects as { detonated: boolean }[])[i].detonated,
        ))
    )
      throw Error("Action world receipt phase");
  }
  const counters = fields(w.counters, [
    "candidates",
    "coverRays",
    "coverTests",
  ]);
  integer(counters.candidates, 0, 512);
  integer(counters.coverRays, 0, 512);
  integer(counters.coverTests, 0, 32768);
  const state = copy(w) as unknown as DestructionState;
  if (tick === 0 && canonical(state) !== canonical(initial(c).world))
    throw Error("Action initial world");
  return state;
}
function validateState(
  c: ActionEncounterConfiguration,
  value: unknown,
): ActionEncounterState {
  canonical(value);
  const root = fields(value, [
    "tick",
    "status",
    "player",
    "enemies",
    "world",
    "impulse",
    "aim",
    "routes",
    "routeInvalidations",
  ]);
  const tick = integer(root.tick, 0, Number.MAX_SAFE_INTEGER - 2),
    world = validateWorld(c, root.world, tick);
  if (!Array.isArray(root.enemies) || root.enemies.length !== c.enemies.length)
    throw Error("Action actor set");
  const initialActors = initial(c);
  const actors = [root.player, ...root.enemies].map((entry, i) => {
    const a = fields(entry, [
        "id",
        "role",
        "x",
        "y",
        "width",
        "height",
        "hp",
        "maxHp",
        "freezeTicks",
        "fireCooldown",
        "behavior",
      ]),
      definition = [initialActors.player, ...initialActors.enemies][i];
    if (
      a.id !== definition.id ||
      a.role !== definition.role ||
      a.width !== 128 ||
      a.height !== 128 ||
      a.maxHp !== definition.maxHp
    )
      throw Error("Action actor identity/body/maximum HP");
    integer(a.x, 0, c.width - 128);
    integer(a.y, 0, c.height - 128);
    integer(a.hp, 0, definition.maxHp);
    integer(a.freezeTicks, 0, tick ? 2 : 0);
    integer(a.fireCooldown, 0, i === 0 && tick ? 6 : 0);
    if (i === 0) {
      if (a.behavior !== null) throw Error("Action player behavior");
    } else {
      const b = fields(a.behavior, [
        "role",
        "state",
        "timer",
        "position",
        "attacks",
        "transitions",
      ]);
      if (b.role !== a.role) throw Error("Action behavior role");
      integer(b.attacks, 0, tick);
      integer(b.transitions, 0, tick);
      stepBehavior(a.behavior as BehaviorActor, {
        target: 0,
        threatened: false,
      });
    }
    if (
      terrain(c, world).some((w) =>
        arenaOverlaps(a as unknown as ActionEncounterActor, { ...w.rect }),
      )
    )
      throw Error("Action actor overlaps terrain");
    return copy(a) as unknown as ActionEncounterActor;
  });
  const aim = fields(root.aim, ["x", "y"]);
  integer(aim.x, -1, 1);
  integer(aim.y, -1, 1);
  if (aim.x === 0 && aim.y === 0) throw Error("Action aim direction");
  const channel = new ImpulseChannel(policies(c));
  channel.restore(root.impulse);
  const impulse = channel.capture();
  if (
    impulse.pending.length ||
    impulse.velocities.some(
      (v) =>
        actors.find((a) => a.id === v.targetId)!.hp === 0 &&
        (v.x || v.y || v.remainderX || v.remainderY),
    )
  )
    throw Error("Action impulse phase/dead actor");
  if (!Array.isArray(root.routes) || root.routes.length > c.enemies.length)
    throw Error("Action route cap");
  const g = grid(c, world);
  let lastId = "";
  for (const entry of root.routes) {
    const r = fields(entry, ["enemyId", "revision", "start", "goal", "path"]);
    if (
      typeof r.enemyId !== "string" ||
      !c.enemies.some((e) => e.id === r.enemyId) ||
      order(lastId, r.enemyId) >= 0 ||
      r.revision !== world.terrainRevision
    )
      throw Error("Action route identity/revision");
    lastId = r.enemyId;
    const start = integer(r.start, 0, g.costs.length - 1),
      goal = integer(r.goal, 0, g.costs.length - 1);
    const navigation = new SustainedNavigationScheduler(g),
      id = navigation.request({ algorithm: "bfs", start, goal });
    navigation.step(256);
    const found = navigation.observe().searches.find((s) => s.id === id)!;
    const path =
      g.costs[start] && g.costs[goal] && found.status === "found"
        ? found.path
        : [];
    if (canonical(r.path) !== canonical(path))
      throw Error("Action route does not match committed terrain");
  }
  integer(root.routeInvalidations, 0, world.terrainRevision);
  if (root.routeInvalidations !== world.terrainRevision)
    throw Error("Action route invalidation count");
  const state = copy(root) as unknown as ActionEncounterState;
  if (state.status !== outcome(state)) throw Error("Action encounter outcome");
  if (tick === 0 && canonical(state) !== canonical(initial(c)))
    throw Error("Action initial state");
  return state;
}
/** Reset discards all room state, including rewards, fuses, routes and velocities.
 * Durable room completion/rewards belong to the run owner. A revisit may restore
 * the exact captured room instead; inspection never advances its clock. */
function sameCommand(
  a: ActionEncounterInput,
  b: ActionEncounterInput,
): boolean {
  return (
    a.moveX === b.moveX &&
    a.moveY === b.moveY &&
    a.aimX === b.aimX &&
    a.aimY === b.aimY &&
    a.fire === b.fire
  );
}
export class DestructionEncounter {
  private readonly configuration: ActionEncounterConfiguration;
  private state: ActionEncounterState;
  private replay: ActionEncounterReplayRun[] = [];
  private admitting = false;
  constructor(value: ActionEncounterConfiguration) {
    this.configuration = admit(value);
    this.state = initial(this.configuration);
  }
  step(
    value: ActionEncounterInput,
    admitCheckpoint?: (candidate: ActionEncounterCheckpoint) => void,
  ): ActionEncounterObservation {
    if (this.admitting) throw Error("Action checkpoint admission in progress");
    if (admitCheckpoint !== undefined && typeof admitCheckpoint !== "function")
      throw Error("Invalid action checkpoint admission");
    const input = command(value),
      last = this.replay.at(-1);
    const extendsLast = last !== undefined && sameCommand(last.input, input);
    // Reject before advancing physics so every admitted live state remains
    // independently verifiable and saveable within the declared replay workload.
    if (
      this.state.tick >= ACTION_ENCOUNTER_LIMITS.replayTicks ||
      (!extendsLast && this.replay.length >= ACTION_ENCOUNTER_LIMITS.replayRuns)
    )
      throw Error(
        "Action encounter persisted replay quota exhausted; reset or travel",
      );
    const next = advance(this.configuration, this.state, input);
    const replay = extendsLast
      ? [
          ...this.replay.slice(0, -1),
          { ticks: last.ticks + 1, input: last.input },
        ]
      : [...this.replay, { ticks: 1, input }];
    if (admitCheckpoint) {
      this.admitting = true;
      try {
        const result = admitCheckpoint({
          format: "p2-action-encounter-v2",
          configuration: copy(this.configuration),
          replay: copy(replay),
          state: copy(next),
        });
        if (result !== undefined)
          throw Error(
            "Action checkpoint admission must complete synchronously",
          );
      } finally {
        this.admitting = false;
      }
    }
    this.replay = replay;
    this.state = next;
    return this.observe();
  }
  observe(): ActionEncounterObservation {
    return {
      ...copy(this.state),
      rewardTotal: this.state.world.rewardTotal,
      terrainRevision: this.state.world.terrainRevision,
    };
  }
  capture(): ActionEncounterCheckpoint {
    return {
      format: "p2-action-encounter-v2",
      configuration: copy(this.configuration),
      replay: copy(this.replay),
      state: copy(this.state),
    };
  }
  restore(value: unknown): void {
    if (this.admitting) throw Error("Action checkpoint admission in progress");
    canonical(value);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (value as Record<string, unknown>).format !== "p2-action-encounter-v2"
    )
      throw Error(
        "Incompatible action checkpoint: origin-verified v2 required",
      );
    const r = fields(value, ["format", "configuration", "replay", "state"]);
    if (
      r.format !== "p2-action-encounter-v2" ||
      canonical(r.configuration) !== canonical(this.configuration)
    )
      throw Error(
        "Incompatible action checkpoint: origin-verified v2 required",
      );
    if (
      !Array.isArray(r.replay) ||
      r.replay.length > ACTION_ENCOUNTER_LIMITS.replayRuns
    )
      throw Error("Action replay run quota");
    let ticks = 0;
    const replay: ActionEncounterReplayRun[] = [];
    // Admit the entire transcript and its total work before executing any action.
    for (const entry of r.replay) {
      const run = fields(entry, ["ticks", "input"]),
        input = command(run.input);
      const count = integer(run.ticks, 1, ACTION_ENCOUNTER_LIMITS.replayTicks);
      ticks += count;
      if (ticks > ACTION_ENCOUNTER_LIMITS.replayTicks)
        throw Error("Action replay tick quota");
      if (replay.length && sameCommand(replay.at(-1)!.input, input))
        throw Error("Noncanonical action replay runs");
      replay.push({ ticks: count, input });
    }
    const state = validateState(this.configuration, r.state);
    if (ticks !== state.tick) throw Error("Action replay clock mismatch");
    let reached = initial(this.configuration);
    for (const run of replay)
      for (let tick = 0; tick < run.ticks; tick++)
        reached = advance(this.configuration, reached, run.input);
    if (canonical(reached) !== canonical(state))
      throw Error("Action checkpoint is not reachable from authored origin");
    this.state = state;
    this.replay = replay;
  }
  save(): string {
    return canonical(this.capture());
  }
  load(bytes: string): void {
    if (
      typeof bytes !== "string" ||
      bytes.length > ACTION_ENCOUNTER_LIMITS.checkpointCharacters
    )
      throw Error("Action checkpoint byte cap");
    const value: unknown = JSON.parse(bytes);
    if (canonical(value) !== bytes)
      throw Error("Noncanonical action checkpoint");
    this.restore(value);
  }
  reset(): ActionEncounterObservation {
    if (this.admitting) throw Error("Action checkpoint admission in progress");
    this.state = initial(this.configuration);
    this.replay = [];
    return this.observe();
  }
}
