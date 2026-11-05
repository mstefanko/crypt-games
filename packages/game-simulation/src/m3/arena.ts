import {
  array,
  boolean,
  boundedJSON,
  canonical,
  integer,
  record,
  string,
} from "../../../game-project/src/runtime";
import { arenaAimVelocity, quantizeArenaAim } from "./aim";
import {
  arenaOverlaps,
  compareArenaFraction,
  moveArenaBody,
  sweepArenaContact,
} from "./arena-geometry";
import type { ArenaFraction } from "./arena-geometry";
import type {
  ArenaActor,
  ArenaDefinition,
  ArenaEdge,
  ArenaHeld,
  ArenaIdentity,
  ArenaInput,
  ArenaObservation,
  ArenaProjectile,
  ArenaRect,
  ArenaSpawn,
  ArenaWorld,
} from "./arena-types";
export * from "./arena-types";
export { arenaAimVelocity, quantizeArenaAim, AIM_DIRECTIONS } from "./aim";

const MAX = Number.MAX_SAFE_INTEGER;
const U = 256;
const BUFFER_TICKS = 6;
const definitionKeys = [
  "id",
  "width",
  "height",
  "walls",
  "player",
  "enemies",
  "moveSpeed",
  "enemySpeed",
  "projectileSpeed",
  "projectileSize",
  "projectileTicks",
  "projectileDamage",
  "fireCooldown",
  "dashSpeed",
  "dashTicks",
  "dashCooldown",
  "shoveRange",
  "shoveDistance",
  "shoveDamage",
  "shoveCooldown",
  "enemyDamage",
  "enemyCooldown",
  "hitstopTicks",
  "maxProjectiles",
] as const;
const actorKeys = [
  "id",
  "spawnId",
  "kind",
  "x",
  "y",
  "width",
  "height",
  "hp",
  "freezeTicks",
  "motionEpoch",
  "aim",
  "aiTicks",
  "attackCooldown",
  "dashCooldown",
  "shoveCooldown",
  "dashTicks",
  "dashAim",
  "fireBuffer",
  "dashBuffer",
  "shoveBuffer",
] as const;
const projectileKeys = [
  "id",
  "ownerId",
  "x",
  "y",
  "width",
  "height",
  "vx",
  "vy",
  "remainingTicks",
] as const;

function rect(
  value: Record<string, unknown>,
  width: number,
  height: number,
): ArenaRect {
  const w = integer(value.width, 1, width),
    h = integer(value.height, 1, height);
  return {
    x: integer(value.x, 0, width - w),
    y: integer(value.y, 0, height - h),
    width: w,
    height: h,
  };
}
function clearRect(
  r: ArenaRect,
  definition: Pick<ArenaDefinition, "walls">,
): void {
  if (definition.walls.some((w) => arenaOverlaps(w, r)))
    throw Error("Arena body embedded in wall");
}
function unique(values: readonly (string | number)[]): void {
  if (new Set(values).size !== values.length)
    throw Error("Duplicate arena identity");
}

/** Validate and copy authored gameplay content. Caller-owned records never become rules. */
export function validateArenaDefinition(value: unknown): ArenaDefinition {
  const o = record(value, definitionKeys);
  const width = integer(o.width, U, 16777216),
    height = integer(o.height, U, 16777216);
  const walls = array(o.walls, 1024)
    .map((v) => {
      const w = record(v, ["id", "x", "y", "width", "height"]);
      return Object.freeze({ id: string(w.id), ...rect(w, width, height) });
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  unique(walls.map((w) => w.id));
  const spawn = (value: unknown): ArenaSpawn => {
    const s = record(value, ["id", "x", "y", "width", "height", "hp"]);
    const result = {
      id: string(s.id),
      ...rect(s, width, height),
      hp: integer(s.hp, 1, 1000000),
    };
    clearRect(result, { walls });
    return Object.freeze(result);
  };
  const player = spawn(o.player),
    enemies = array(o.enemies, 255)
      .map(spawn)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!enemies.length) throw Error("Arena requires at least one enemy");
  unique([player.id, ...enemies.map((e) => e.id)]);
  const d: ArenaDefinition = {
    id: string(o.id),
    width,
    height,
    walls: Object.freeze(walls),
    player,
    enemies: Object.freeze(enemies),
    moveSpeed: integer(o.moveSpeed, 0, 8192),
    enemySpeed: integer(o.enemySpeed, 0, 8192),
    projectileSpeed: integer(o.projectileSpeed, 1, 32768),
    projectileSize: integer(
      o.projectileSize,
      1,
      Math.min(player.width, player.height),
    ),
    projectileTicks: integer(o.projectileTicks, 1, 3600),
    projectileDamage: integer(o.projectileDamage, 1, 1000000),
    fireCooldown: integer(o.fireCooldown, 1, 3600),
    dashSpeed: integer(o.dashSpeed, 0, 8192),
    dashTicks: integer(o.dashTicks, 1, 60),
    dashCooldown: integer(o.dashCooldown, 1, 3600),
    shoveRange: integer(o.shoveRange, 0, 8192),
    shoveDistance: integer(o.shoveDistance, 0, 8192),
    shoveDamage: integer(o.shoveDamage, 1, 1000000),
    shoveCooldown: integer(o.shoveCooldown, 1, 3600),
    enemyDamage: integer(o.enemyDamage, 1, 1000000),
    enemyCooldown: integer(o.enemyCooldown, 1, 3600),
    hitstopTicks: integer(o.hitstopTicks, 0, 60),
    maxProjectiles: integer(o.maxProjectiles, 1, 256),
  };
  if (d.dashCooldown < d.dashTicks)
    throw Error("Dash cooldown shorter than dash execution");
  if (d.enemySpeed + d.shoveDistance > 8192)
    throw Error("Combined AI and shove displacement exceeds actor cap");
  return Object.freeze(d);
}


function identity(value: ArenaIdentity): ArenaIdentity {
  const o = record(value, ["gameId", "rulesBuildId", "contentId"]);
  return Object.freeze({
    gameId: string(o.gameId),
    rulesBuildId: string(o.rulesBuildId),
    contentId: string(o.contentId),
  });
}
function makeActors(
  definition: ArenaDefinition,
  firstId: number,
  epoch: number,
): ArenaActor[] {
  return [definition.player, ...definition.enemies].map((s, index) => ({
    id: firstId + index,
    spawnId: s.id,
    kind: index === 0 ? "player" : "enemy",
    x: s.x,
    y: s.y,
    width: s.width,
    height: s.height,
    hp: s.hp,
    freezeTicks: 0,
    motionEpoch: epoch,
    aim: 0,
    aiTicks: 0,
    attackCooldown: 0,
    dashCooldown: 0,
    shoveCooldown: 0,
    dashTicks: 0,
    dashAim: 0,
    fireBuffer: 0,
    dashBuffer: 0,
    shoveBuffer: 0,
  }));
}
export function createArena(
  definition: ArenaDefinition,
  suppliedIdentity: ArenaIdentity,
  seed = 1,
): ArenaWorld {
  const d = validateArenaDefinition(definition),
    id = identity(suppliedIdentity);
  seed = integer(seed, 0, 4294967295);
  const actors = makeActors(d, 1, 0);
  return {
    definition: d,
    identity: id,
    seed,
    tick: 0,
    result: "playing",
    actors,
    projectiles: [],
    nextEntityId: actors.length + 1,
    restartCount: 0,
    held: { fire: false, dash: false, shove: false },
  };
}
export function observeArena(w: ArenaWorld): ArenaObservation {
  return {
    tick: w.tick,
    result: w.result,
    width: w.definition.width,
    height: w.definition.height,
    walls: w.definition.walls.map((a) => ({ ...a })),
    actors: w.actors.map((a) => ({ ...a })),
    projectiles: w.projectiles.map((p) => ({ ...p })),
  };
}
/** Retry allocates fresh local identities and a new discontinuity epoch. */
export function restartArena(w: ArenaWorld): void {
  integer(w.nextEntityId, 1, MAX - w.actors.length);
  integer(w.restartCount, 0, MAX - 1);
  const count = w.restartCount + 1,
    actors = makeActors(w.definition, w.nextEntityId, count);
  w.actors = actors;
  w.projectiles = [];
  w.nextEntityId += actors.length;
  w.tick = 0;
  w.result = "playing";
  w.restartCount = count;
  w.held = { fire: false, dash: false, shove: false };
}
function input(value: ArenaInput, previous: ArenaHeld): ArenaInput {
  const o = record(value, [
    "moveX",
    "moveY",
    "aim",
    "fire",
    "dash",
    "shove",
    ...(Object.hasOwn(value, "cancel") ? ["cancel"] : []),
    ...(Object.hasOwn(value, "edges") ? ["edges"] : []),
  ]);
  const result: ArenaInput = {
    moveX: integer(o.moveX, -127, 127),
    moveY: integer(o.moveY, -127, 127),
    aim: integer(o.aim, 0, 255),
    fire: boolean(o.fire),
    dash: boolean(o.dash),
    shove: boolean(o.shove),
    cancel: value.cancel === undefined ? false : boolean(o.cancel),
  };
  if (Object.hasOwn(value, "edges")) {
    const held = result.cancel
      ? { fire: false, dash: false, shove: false }
      : { ...previous };
    result.edges = array(o.edges, 32).map((value): ArenaEdge => {
      const e = record(value, ["action", "kind"]);
      if (
        !["fire", "dash", "shove"].includes(e.action as string) ||
        !["pressed", "released", "cancel"].includes(e.kind as string)
      )
        throw Error("Invalid arena input edge");
      const action = e.action as keyof ArenaHeld,
        kind = e.kind as ArenaEdge["kind"];
      if (
        (kind === "pressed" && held[action]) ||
        (kind === "released" && !held[action])
      )
        throw Error("Arena edge must agree with previous held state");
      held[action] = kind === "pressed";
      return { action, kind };
    });
    if (
      held.fire !== result.fire ||
      held.dash !== result.dash ||
      held.shove !== result.shove
    )
      throw Error("Arena final held state disagrees with ordered edges");
  }
  return result;
}
function axesMotion(
  x: number,
  y: number,
  speed: number,
): readonly [number, number] {
  // L1 normalization deliberately favors predictable wall routes and never
  // exceeds the configured displacement at diagonals or partial analog input.
  const denominator = Math.max(127, Math.abs(x) + Math.abs(y));
  return [
    Math.trunc((x * speed) / denominator) || 0,
    Math.trunc((y * speed) / denominator) || 0,
  ];
}
function validateMotion(dx: number, dy: number, cap: number): void {
  integer(dx, -cap, cap);
  integer(dy, -cap, cap);
  if (dx * dx + dy * dy > cap * cap)
    throw Error("Arena displacement exceeds cap");
}
interface Hit {
  attacker: ArenaActor;
  victim: ArenaActor;
  damage: number;
  shove: boolean;
}

/** Tick order: validate/preflight -> inputs -> eligible AI/timers/movement ->
 * gather projectile/melee contacts -> apply trades/shoves -> deaths/result.
 * Participant freeze is sampled at tick start: hit tick finishes, next N ticks
 * freeze only participants. Inputs enter six-tick buffers even while frozen. */
export function stepArena(
  w: ArenaWorld,
  suppliedInput: ArenaInput,
): ArenaObservation {
  advanceArena(w, suppliedInput);
  return observeArena(w);
}

/** Pure step without observation allocation, for the host's catch-up loop and
 * stepping-only measurements. Read detached presentation once per RAF. */
export function advanceArena(w: ArenaWorld, suppliedInput: ArenaInput): void {
  if (w.result !== "playing") return;
  const controls = input(suppliedInput, w.held),
    d = w.definition;
  integer(w.tick, 0, MAX - 1);
  integer(w.nextEntityId, 1, MAX - 1);
  for (const a of w.actors) integer(a.aiTicks, 0, MAX - 1);
  const player = w.actors[0];
  // Reserve every allocation before consuming a command or mutating a timer.
  if (
    player.hp > 0 &&
    (controls.fire || player.fireBuffer > 0) &&
    w.projectiles.length < d.maxProjectiles
  )
    integer(w.nextEntityId, 1, MAX - 1);
  const frozen = new Set(
    w.actors.filter((a) => a.freezeTicks > 0).map((a) => a.id),
  );
  const hits: Hit[] = [];
  const shoves: ArenaActor[] = [];
  const enemyTouches = new Set<number>();
  player.aim = controls.aim;
  if (controls.cancel)
    player.fireBuffer = player.dashBuffer = player.shoveBuffer = 0;
  if (controls.edges !== undefined) {
    for (const edge of controls.edges) {
      const key =
        edge.action === "fire"
          ? "fireBuffer"
          : edge.action === "dash"
            ? "dashBuffer"
            : "shoveBuffer";
      if (edge.kind === "pressed") player[key] = BUFFER_TICKS;
      if (edge.kind === "cancel") player[key] = 0;
    }
    // Fire is deliberately repeatable while held; dash/shove require a press.
    if (controls.fire) player.fireBuffer = BUFFER_TICKS;
  } else {
    if (controls.fire) player.fireBuffer = BUFFER_TICKS;
    if (controls.dash) player.dashBuffer = BUFFER_TICKS;
    if (controls.shove) player.shoveBuffer = BUFFER_TICKS;
  }
  w.held = { fire: controls.fire, dash: controls.dash, shove: controls.shove };
  for (const a of w.actors) {
    if (a.hp <= 0) continue;
    if (frozen.has(a.id)) {
      a.freezeTicks--;
      continue;
    }
    a.attackCooldown = Math.max(0, a.attackCooldown - 1);
    a.dashCooldown = Math.max(0, a.dashCooldown - 1);
    a.shoveCooldown = Math.max(0, a.shoveCooldown - 1);
    if (a.kind === "enemy") {
      a.aiTicks++;
      const dx = player.x - a.x,
        dy = player.y - a.y;
      if (dx || dy) a.aim = quantizeArenaAim(dx, dy);
      const motion = axesMotion(
        Math.sign(dx) * 127,
        Math.sign(dy) * 127,
        d.enemySpeed,
      );
      validateMotion(motion[0], motion[1], 8192);
      const before = { x: a.x, y: a.y, width: a.width, height: a.height };
      moveArenaBody(w, a, ...motion);
      // Movement follows the resolved X segment, then the resolved Y segment.
      // Test those actual segments so a thin player cannot be skipped and a
      // wall-clamped route cannot initiate a contact beyond its wall.
      if (
        sweepArenaContact(before, a.x - before.x, 0, player) ||
        sweepArenaContact({ ...before, x: a.x }, 0, a.y - before.y, player)
      )
        enemyTouches.add(a.id);
      continue;
    }
    if (a.dashBuffer && !a.dashCooldown && !a.dashTicks) {
      a.dashTicks = d.dashTicks;
      a.dashAim = a.aim;
      a.dashCooldown = d.dashCooldown;
      a.dashBuffer = 0;
    }
    const motion = a.dashTicks
      ? arenaAimVelocity(a.dashAim, d.dashSpeed)
      : axesMotion(
          controls.cancel ? 0 : controls.moveX,
          controls.cancel ? 0 : controls.moveY,
          d.moveSpeed,
        );
    validateMotion(motion[0], motion[1], 8192);
    moveArenaBody(w, a, ...motion);
    if (a.dashTicks) a.dashTicks--;
    if (
      a.fireBuffer &&
      !a.attackCooldown &&
      w.projectiles.length < d.maxProjectiles
    ) {
      const velocity = arenaAimVelocity(a.aim, d.projectileSpeed);
      validateMotion(velocity[0], velocity[1], 32768);
      w.projectiles.push({
        id: w.nextEntityId++,
        ownerId: a.id,
        x: a.x + Math.trunc((a.width - d.projectileSize) / 2),
        y: a.y + Math.trunc((a.height - d.projectileSize) / 2),
        width: d.projectileSize,
        height: d.projectileSize,
        vx: velocity[0],
        vy: velocity[1],
        remainingTicks: d.projectileTicks,
      });
      a.attackCooldown = d.fireCooldown;
      a.fireBuffer = 0;
    }
    if (a.shoveBuffer && !a.shoveCooldown) {
      a.shoveCooldown = d.shoveCooldown;
      a.shoveBuffer = 0;
      shoves.push(a);
    }
    a.fireBuffer = Math.max(0, a.fireBuffer - 1);
    a.dashBuffer = Math.max(0, a.dashBuffer - 1);
    a.shoveBuffer = Math.max(0, a.shoveBuffer - 1);
  }
  for (const a of shoves) {
    const reach = arenaAimVelocity(a.aim, d.shoveRange);
    let wallTime: ArenaFraction | null = null;
    for (const wall of d.walls) {
      const time = sweepArenaContact(a, reach[0], reach[1], wall);
      if (time && (!wallTime || compareArenaFraction(time, wallTime) < 0))
        wallTime = time;
    }
    for (const enemy of w.actors) {
      if (enemy.kind !== "enemy" || enemy.hp <= 0) continue;
      const time = sweepArenaContact(a, reach[0], reach[1], enemy);
      if (time && (!wallTime || compareArenaFraction(time, wallTime) < 0))
        hits.push({
          attacker: a,
          victim: enemy,
          damage: d.shoveDamage,
          shove: true,
        });
    }
  }
  // Gather all eligible melee contacts before applying any victim interruption.
  for (const a of w.actors)
    if (
      a.kind === "enemy" &&
      a.hp > 0 &&
      !frozen.has(a.id) &&
      !a.attackCooldown &&
      (enemyTouches.has(a.id) || arenaOverlaps(a, player))
    ) {
      hits.push({
        attacker: a,
        victim: player,
        damage: d.enemyDamage,
        shove: false,
      });
      a.attackCooldown = d.enemyCooldown;
    }
  const remaining: ArenaProjectile[] = [];
  for (const p of w.projectiles) {
    validateMotion(p.vx, p.vy, 32768);
    let contact: { time: ArenaFraction; victim: ArenaActor | null } | null =
      null;
    // Walls first, then actors in entity order: ties consistently hit terrain.
    for (const wall of d.walls) {
      const time = sweepArenaContact(p, p.vx, p.vy, wall);
      if (time && (!contact || compareArenaFraction(time, contact.time) < 0))
        contact = { time, victim: null };
    }
    for (const a of w.actors) {
      if (a.kind !== "enemy" || a.hp <= 0) continue;
      const time = sweepArenaContact(p, p.vx, p.vy, a);
      if (time && (!contact || compareArenaFraction(time, contact.time) < 0))
        contact = { time, victim: a };
    }
    if (contact) {
      if (contact.victim)
        hits.push({
          attacker: player,
          victim: contact.victim,
          damage: d.projectileDamage,
          shove: false,
        });
      continue;
    }
    const x = p.x + p.vx,
      y = p.y + p.vy;
    p.remainingTicks--;
    if (
      x < 0 ||
      y < 0 ||
      x + p.width > d.width ||
      y + p.height > d.height ||
      p.remainingTicks <= 0
    )
      continue;
    p.x = integer(x, 0, d.width - p.width);
    p.y = integer(y, 0, d.height - p.height);
    remaining.push(p);
  }
  w.projectiles = remaining;
  // Stable gather order is authoritative. Multiple simultaneous projectiles can
  // trade with enemy touch; frozen owners' already flying projectiles continue.
  for (const h of hits) {
    h.victim.hp = Math.max(0, h.victim.hp - h.damage);
    h.attacker.freezeTicks = Math.max(h.attacker.freezeTicks, d.hitstopTicks);
    h.victim.freezeTicks = Math.max(h.victim.freezeTicks, d.hitstopTicks);
    if (h.shove) {
      const displacement = arenaAimVelocity(h.attacker.aim, d.shoveDistance);
      moveArenaBody(w, h.victim, ...displacement);
    }
  }
  // Dead actors no longer participate in hit-stop and are skipped by timers.
  // Clear their freeze immediately rather than retaining an immortal timer.
  for (const actor of w.actors) if (actor.hp === 0) actor.freezeTicks = 0;
  w.tick++;
  // Player death takes priority over a simultaneous final-enemy defeat.
  w.result =
    player.hp <= 0
      ? "lost"
      : w.actors.every((a) => a.kind === "player" || a.hp <= 0)
        ? "won"
        : "playing";
}

export function encodeArenaCheckpoint(w: ArenaWorld): string {
  return canonical({
    snapshotVersion: 1,
    profile: "arena",
    ...w.identity,
    definitionId: w.definition.id,
    seed: w.seed,
    tick: w.tick,
    result: w.result,
    nextEntityId: w.nextEntityId,
    restartCount: w.restartCount,
    actors: w.actors,
    projectiles: w.projectiles,
    held: w.held,
  });
}

/** Strict bounded staging codec. No assignment happens until every reference,
 * counter, geometry, timer and compatibility field has been checked. */
export function restoreArenaCheckpoint(w: ArenaWorld, bytes: string): void {
  const o = record(boundedJSON(bytes, 2097152, { rejectNegativeZero: true }), [
    "snapshotVersion",
    "profile",
    "gameId",
    "rulesBuildId",
    "contentId",
    "definitionId",
    "seed",
    "tick",
    "result",
    "nextEntityId",
    "restartCount",
    "actors",
    "projectiles",
    "held",
  ]);
  if (
    o.snapshotVersion !== 1 ||
    o.profile !== "arena" ||
    o.gameId !== w.identity.gameId ||
    o.rulesBuildId !== w.identity.rulesBuildId ||
    o.contentId !== w.identity.contentId ||
    o.definitionId !== w.definition.id ||
    o.seed !== w.seed
  )
    throw Error("Arena checkpoint compatibility mismatch");
  const tick = integer(o.tick, 0, MAX),
    nextEntityId = integer(o.nextEntityId, 1, MAX),
    restartCount = integer(o.restartCount, 0, MAX);
  const inputHeld = record(o.held, ["fire", "dash", "shove"]);
  const held = {
    fire: boolean(inputHeld.fire),
    dash: boolean(inputHeld.dash),
    shove: boolean(inputHeld.shove),
  };
  const d = w.definition,
    spawns = [d.player, ...d.enemies];
  const actors = array(o.actors, 256).map((value, index): ArenaActor => {
    const a = record(value, actorKeys),
      s = spawns[index];
    if (
      !s ||
      a.spawnId !== s.id ||
      a.kind !== (index === 0 ? "player" : "enemy")
    )
      throw Error("Arena actor placement/order mismatch");
    const r = rect(a, d.width, d.height);
    if (r.width !== s.width || r.height !== s.height)
      throw Error("Arena actor geometry mismatch");
    clearRect(r, d);
    const actor: ArenaActor = {
      id: integer(a.id, 1, nextEntityId - 1),
      spawnId: s.id,
      kind: index === 0 ? "player" : "enemy",
      ...r,
      hp: integer(a.hp, 0, s.hp),
      freezeTicks: integer(a.freezeTicks, 0, d.hitstopTicks),
      motionEpoch: integer(a.motionEpoch, 0, MAX),
      aim: integer(a.aim, 0, 255),
      aiTicks: integer(a.aiTicks, 0, tick),
      attackCooldown: integer(
        a.attackCooldown,
        0,
        index === 0 ? d.fireCooldown : d.enemyCooldown,
      ),
      dashCooldown: integer(a.dashCooldown, 0, d.dashCooldown),
      shoveCooldown: integer(a.shoveCooldown, 0, d.shoveCooldown),
      dashTicks: integer(a.dashTicks, 0, d.dashTicks),
      dashAim: integer(a.dashAim, 0, 255),
      fireBuffer: integer(a.fireBuffer, 0, BUFFER_TICKS),
      dashBuffer: integer(a.dashBuffer, 0, BUFFER_TICKS),
      shoveBuffer: integer(a.shoveBuffer, 0, BUFFER_TICKS),
    };
    if (
      actor.motionEpoch !== restartCount ||
      actor.dashTicks > actor.dashCooldown ||
      (actor.hp === 0 && actor.freezeTicks !== 0) ||
      (index === 0 && actor.aiTicks !== 0) ||
      (index > 0 &&
        (actor.dashCooldown ||
          actor.shoveCooldown ||
          actor.dashTicks ||
          actor.dashAim ||
          actor.fireBuffer ||
          actor.dashBuffer ||
          actor.shoveBuffer))
    )
      throw Error("Arena actor timer/epoch inconsistency");
    return actor;
  });
  if (actors.length !== spawns.length)
    throw Error("Arena checkpoint actor set incomplete");
  const allowedVelocities = Array.from({ length: 256 }, (_, aim) =>
    arenaAimVelocity(aim, d.projectileSpeed),
  );
  const projectiles = array(o.projectiles, d.maxProjectiles).map(
    (value): ArenaProjectile => {
      const p = record(value, projectileKeys),
        r = rect(p, d.width, d.height);
      const vx = integer(p.vx, -32768, 32768),
        vy = integer(p.vy, -32768, 32768);
      validateMotion(vx, vy, 32768);
      if (
        r.width !== d.projectileSize ||
        r.height !== d.projectileSize ||
        p.ownerId !== actors[0].id
      )
        throw Error("Arena projectile geometry/owner mismatch");
      clearRect(r, d);
      // Every projectile velocity must be produced by this exact content table.
      if (!allowedVelocities.some((v) => v[0] === vx && v[1] === vy))
        throw Error("Arena projectile velocity not authored");
      return {
        id: integer(p.id, 1, nextEntityId - 1),
        ownerId: actors[0].id,
        ...r,
        vx,
        vy,
        remainingTicks: integer(p.remainingTicks, 1, d.projectileTicks),
      };
    },
  );
  unique([...actors.map((a) => a.id), ...projectiles.map((p) => p.id)]);
  if (
    actors.some((a, i) => a.id - actors[0].id !== i) ||
    (restartCount === 0 && actors[0].id !== 1) ||
    restartCount > Math.floor((actors[0].id - 1) / actors.length) ||
    projectiles.some(
      (p, i) =>
        p.id <= actors[actors.length - 1].id ||
        (i > 0 && p.id <= projectiles[i - 1].id),
    )
  )
    throw Error("Arena entity order inconsistent");
  const result =
    actors[0].hp <= 0
      ? "lost"
      : actors.every((a) => a.kind === "player" || a.hp <= 0)
        ? "won"
        : "playing";
  if (o.result !== result) throw Error("Arena checkpoint result inconsistent");
  w.tick = tick;
  w.result = result;
  w.nextEntityId = nextEntityId;
  w.restartCount = restartCount;
  w.actors = actors;
  w.projectiles = projectiles;
  w.held = held;
}
