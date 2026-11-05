import { PLATFORM_ACTIONS_V2 } from "./platform-input-v2";
import { checkpointSize } from "./checkpoint-size";
import {
  ACTIONS,
  SNAPSHOT_VERSION,
  array,
  boolean,
  boundedJSON,
  canonical,
  integer,
  record,
  string,
} from "../../game-project/src/runtime";
import type {
  CompatibilityIdentity,
  GameDefinitions,
} from "../../game-project/src/runtime";
import {
  body,
  embedded,
  makeIndex,
  moveActor,
  overlaps,
  staticOneWay,
} from "./collision";
import type { ActorState, CombatRuntimeState, World } from "./types";
import { MAX_DEFEATED_PLACEMENTS } from "./counters";
/** Admit the record shape before optional-key inspection; malformed null/array
 * payloads must produce a codec error, not a native Object.keys/hasOwn error. */
function checkpointObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Checkpoint expected object");
  return value as Record<string, unknown>;
}
const counter = (v: unknown) => integer(v, 0, Number.MAX_SAFE_INTEGER);
const position = (v: unknown) => integer(v, -16777216, 16777216);
/** Contact identities include the namespace in addition to an authored ID. */
const colliderIdentity = (v: unknown): string => {
  if (
    typeof v !== "string" ||
    v.length > 137 ||
    !/^(rect:|tile:|platform:)[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(v)
  )
    throw Error("Invalid checkpoint contact identity");
  return v;
};
const direction = (v: unknown): -1 | 1 => {
  const n = integer(v, -1, 1);
  if (!n) throw Error("Direction must be -1 or 1");
  return n as -1 | 1;
};
function unique(values: readonly (string | number)[]): void {
  if (new Set(values).size !== values.length)
    throw Error("Duplicate checkpoint identity");
}
function state(w: World): unknown {
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    ...(w.inputCodec ? { inputCodec: w.inputCodec } : {}),
    gameId: w.definitions.manifest.gameId,
    rulesBuildId: w.identity.rulesBuildId,
    contentId: w.identity.contentId,
    scenarioId: w.scenarioId,
    initialPlayerSlots: w.initialPlayerSlots,
    tick: w.tick,
    levelId: w.levelId,
    status: w.status,
    actors: [...w.actors].sort((a, b) => a.id - b.id),
    platforms: [...w.platforms].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    ),
    decoder: w.decoder,
    rng: w.rng,
    nextEntityId: w.nextEntityId,
    nextExecutionId: w.nextExecutionId,
    motionEpochCounter: w.motionEpochCounter,
    campaign: w.campaign,
  };
}
export function serializeCheckpoint(w: World): string {
  return canonical(state(w));
}
/** Decode a new owned world. The caller replaces its world only after this succeeds. */
export function restoreCheckpoint(
  definitions: GameDefinitions,
  identity: CompatibilityIdentity,
  json: string,
): World {
  return restoreState(
    definitions,
    identity,
    boundedJSON(json, 2097152, { rejectNegativeZero: true }),
  );
}
/** Internal staging shares the external reader's complete semantic validator,
 * without serializing or parsing trusted live authority. This module is not a
 * public package entry point; external bytes must use restoreCheckpoint. */
export function copyValidatedWorld(world: World): World {
  const owned = restoreState(world.definitions, world.identity, state(world));
  // Trusted object validation must keep the external reader's canonical byte cap.
  // Count without producing a checkpoint string or invoking the JSON decoder.
  checkpointSize(state(owned));
  return owned;
}
function restoreState(
  definitions: GameDefinitions,
  identity: CompatibilityIdentity,
  value: unknown,
): World {
  const o = record(value, [
    "snapshotVersion",
    ...(Object.hasOwn(checkpointObject(value), "inputCodec") ? ["inputCodec"] : []),
    "gameId",
    "rulesBuildId",
    "contentId",
    "scenarioId",
    "initialPlayerSlots",
    "tick",
    "levelId",
    "status",
    "actors",
    "platforms",
    "decoder",
    "rng",
    "nextEntityId",
    "nextExecutionId",
    "motionEpochCounter",
    "campaign",
  ]);
  if (o.inputCodec !== undefined && o.inputCodec !== "platform-input-v2")
    throw Error("Unsupported platform input codec");
  const selected = o.inputCodec === "platform-input-v2";
  if (
    o.snapshotVersion !== SNAPSHOT_VERSION ||
    o.gameId !== definitions.manifest.gameId ||
    o.rulesBuildId !== identity.rulesBuildId ||
    o.contentId !== identity.contentId
  )
    throw Error("Checkpoint version/game/rules/content mismatch");
  const scenarioId = string(o.scenarioId),
    scenario = definitions.scenarios.find((s) => s.id === scenarioId);
  if (!scenario) throw Error("Checkpoint scenario missing");
  const initialPlayerSlots = array(o.initialPlayerSlots, 4).map((v) =>
    integer(v, 0, 3),
  );
  if (canonical(initialPlayerSlots) !== canonical(scenario.playerSlots))
    throw Error("Checkpoint player identity mismatch");
  const tick = counter(o.tick),
    levelId = string(o.levelId),
    level = definitions.levels.find((l) => l.id === levelId);
  if (!level) throw Error("Checkpoint level missing");
  if (!["playing", "won", "lost"].includes(o.status as string))
    throw Error("Checkpoint status invalid");
  const actors: ActorState[] = array(o.actors, 256).map((v) => {
    const a = record(v, [
        "id",
        ...(Object.hasOwn(checkpointObject(v), "combatState") ? ["combatState"] : []),
        ...(selected ? ["platformMotion"] : []),
        "spawnId",
        "archetypeId",
        "slot",
        "team",
        "x",
        "y",
        "vx",
        "vy",
        "facing",
        "health",
        "grounded",
        "coyoteTicks",
        "jumpBuffer",
        "attackBuffer",
        "bufferedAbility",
        "freezeTicks",
        "stunTicks",
        "motionEpoch",
        "riderId",
        "execution",
        "ai",
      ]),
      spawnId = string(a.spawnId),
      spawn = level.spawns.find((s) => s.id === spawnId),
      archetypeId = string(a.archetypeId),
      d = definitions.archetypes.find((d) => d.id === archetypeId);
    if (
      !spawn ||
      !d ||
      spawn.archetypeId !== archetypeId ||
      a.slot !== spawn.slot ||
      a.team !== spawn.team
    )
      throw Error("Checkpoint actor placement mismatch");
    let combatState: CombatRuntimeState | undefined;
    if (Object.hasOwn(a, "combatState")) {
      const raw = a.combatState;
      const c = record(raw, [
        "weapons",
        "equipped",
        "skill",
        "damageBonus",
        "maxHealth",
        "healCharges",
        "healTicks",
        "invulnerableTicks",
        "rollTick",
        "rollCooldown",
        "skillCooldown",
        "jumps",
        "combo",
        ...(Object.hasOwn(checkpointObject(raw), "cooldowns") ? ["cooldowns"] : []),
        ...(Object.hasOwn(checkpointObject(raw), "cooldownDeadlines")
          ? ["cooldownDeadlines"]
          : []),
        ...(Object.hasOwn(checkpointObject(raw), "cooldownTick")
          ? ["cooldownTick"]
          : []),
      ]);
      const abilityId = (value: unknown): string => {
        const id = string(value);
        if (!definitions.abilities.some((d) => d.id === id))
          throw Error("Checkpoint equipped ability missing");
        return id;
      };
      const weapons = array(c.weapons, 8).map(abilityId);
      if (!weapons.length) throw Error("Checkpoint weapon loadout empty");
      let cooldowns: Record<string, number> | undefined;
      if (c.cooldowns !== undefined) {
        if (
          typeof c.cooldowns !== "object" ||
          c.cooldowns === null ||
          Array.isArray(c.cooldowns)
        )
          throw Error("Checkpoint cooldowns invalid");
        const keys = Object.keys(c.cooldowns);
        if (keys.length > definitions.abilities.length)
          throw Error("Checkpoint cooldown count invalid");
        const values = record(c.cooldowns, keys);
        cooldowns = Object.fromEntries(
          keys.map((key) => [abilityId(key), integer(values[key], 0, 36000)]),
        );
      }
      if (
        c.cooldownTick !== undefined &&
        counter(c.cooldownTick) > counter(o.tick)
      )
        throw Error("Checkpoint actor clock exceeds world clock");
      let cooldownDeadlines: Record<string, number> | undefined;
      if (c.cooldownDeadlines !== undefined) {
        const keys = Object.keys(
          record(
            c.cooldownDeadlines,
            Object.keys(checkpointObject(c.cooldownDeadlines)),
          ),
        );
        if (
          keys.length > definitions.abilities.length ||
          !cooldowns ||
          keys.some((k) => !(k in cooldowns!)) ||
          Object.keys(cooldowns).some((k) => !keys.includes(k))
        )
          throw Error("Checkpoint cooldown deadline keys mismatch");
        cooldownDeadlines = Object.fromEntries(
          keys.map((k) => [
            abilityId(k),
            counter((c.cooldownDeadlines as Record<string, unknown>)[k]),
          ]),
        );
        for (const key of keys)
          if (
            cooldowns[key] !==
            Math.max(0, cooldownDeadlines[key]! - counter(c.cooldownTick))
          )
            throw Error("Checkpoint cooldown deadline view mismatch");
      }
      combatState = {
        weapons,
        equipped: integer(c.equipped, 0, weapons.length - 1),
        skill: abilityId(c.skill),
        damageBonus: integer(c.damageBonus, 0, 1000000),
        maxHealth: integer(c.maxHealth, 1, 1000000),
        healCharges: integer(c.healCharges, 0, 1000),
        healTicks: integer(c.healTicks, 0, 36000),
        invulnerableTicks: integer(c.invulnerableTicks, 0, 36000),
        rollTick: integer(c.rollTick, -1, 36000),
        rollCooldown: integer(c.rollCooldown, 0, 36000),
        skillCooldown: integer(c.skillCooldown, 0, 36000),
        jumps: integer(c.jumps, 0, 2),
        combo: integer(c.combo, 0, 2),
        ...(cooldowns ? { cooldowns } : {}),
        ...(cooldownDeadlines ? { cooldownDeadlines } : {}),
        ...(c.cooldownTick !== undefined
          ? { cooldownTick: counter(c.cooldownTick) }
          : {}),
      };
    }
    const ai = record(a.ai, ["direction", "decisionTicks"]),
      attackBuffer = integer(a.attackBuffer, 0, d.attackBufferTicks),
      bufferedAbility =
        a.bufferedAbility === null ? null : string(a.bufferedAbility);
    if (
      (attackBuffer === 0) !== (bufferedAbility === null) ||
      (bufferedAbility !== null &&
        !(combatState
          ? definitions.abilities.some((d) => d.id === bufferedAbility)
          : d.abilities.includes(bufferedAbility)))
    )
      throw Error("Checkpoint attack buffer invalid");
    let execution: ActorState["execution"] = null;
    if (a.execution !== null) {
      const e = record(a.execution, ["id", "abilityId", "tick", "hits"]),
        abilityId = string(e.abilityId),
        ability = definitions.abilities.find((b) => b.id === abilityId);
      if (!ability || (!combatState && !d.abilities.includes(abilityId)))
        throw Error("Checkpoint execution ability invalid");
      execution = {
        id: integer(e.id, 1, Number.MAX_SAFE_INTEGER),
        abilityId,
        tick: integer(
          e.tick,
          0,
          ability.startup + ability.active + ability.recovery - 1,
        ),
        hits: array(e.hits, 256).map((v) => {
          const h = record(v, ["targetId", "count", "lastTick"]);
          return {
            targetId: integer(h.targetId, 1, Number.MAX_SAFE_INTEGER),
            count: integer(h.count, 1, ability.maxHits),
            lastTick: integer(h.lastTick, 0, Math.max(0, tick - 1)),
          };
        }),
      };
      unique(execution.hits.map((h) => h.targetId));
      if (
        execution.hits.some(
          (h, i, items) => i > 0 && items[i - 1].targetId >= h.targetId,
        )
      )
        throw Error("Hit ledger ordering invalid");
      if (tick === 0 && execution.hits.length)
        throw Error("Hit ledger predates world");
    }
    let platformMotion;
    if (selected) {
      const m = record(a.platformMotion, [
        "supportId",
        "ignoredSupportId",
        ...(Object.hasOwn(checkpointObject(a.platformMotion), "ignoredSupportIds")
          ? ["ignoredSupportIds"]
          : []),
      ]);
      platformMotion = {
        ...(m.ignoredSupportIds === undefined
          ? {}
          : {
              ignoredSupportIds: array(
                m.ignoredSupportIds,
                level.rectangles.length + level.tiles.length,
              ).map((v) => colliderIdentity(v)),
            }),
        supportId: m.supportId === null ? null : colliderIdentity(m.supportId),
        ignoredSupportId:
          m.ignoredSupportId === null
            ? null
            : colliderIdentity(m.ignoredSupportId),
      };
    }
    return {
      ...(selected ? { platformMotion } : {}),
      ...(combatState ? { combatState } : {}),
      id: integer(a.id, 1, Number.MAX_SAFE_INTEGER),
      spawnId,
      archetypeId,
      slot: spawn.slot,
      team: spawn.team,
      x: position(a.x),
      y: position(a.y),
      vx: integer(a.vx, -8192, 8192),
      vy: integer(a.vy, -8192, 8192),
      facing: direction(a.facing),
      health: integer(a.health, 0, combatState?.maxHealth ?? d.health),
      grounded: boolean(a.grounded),
      coyoteTicks: integer(a.coyoteTicks, 0, d.coyoteTicks),
      jumpBuffer: integer(a.jumpBuffer, 0, d.jumpBufferTicks),
      attackBuffer,
      bufferedAbility,
      freezeTicks: integer(
        a.freezeTicks,
        0,
        Math.max(...definitions.abilities.map((a) => a.hitStopTicks)),
      ),
      stunTicks: integer(
        a.stunTicks,
        0,
        Math.max(...definitions.abilities.map((a) => a.stunTicks)),
      ),
      motionEpoch: integer(a.motionEpoch, 1, Number.MAX_SAFE_INTEGER),
      riderId: a.riderId === null ? null : string(a.riderId),
      execution,
      ai: {
        direction: direction(ai.direction),
        decisionTicks: counter(ai.decisionTicks),
      },
    };
  });
  unique(actors.map((a) => a.id));
  unique(actors.map((a) => a.spawnId));
  unique(actors.flatMap((a) => (a.execution ? [a.execution.id] : [])));
  if (actors.length !== level.spawns.length)
    throw Error("Checkpoint actor collection incomplete");
  if (actors.some((a, i) => i > 0 && actors[i - 1].id >= a.id))
    throw Error("Actor ordering invalid");
  for (const a of actors)
    if (
      a.execution?.hits.some(
        (h) =>
          h.targetId === a.id ||
          !actors.some((b) => b.id === h.targetId && b.team !== a.team),
      )
    )
      throw Error("Checkpoint hit target missing or invalid");
  const platforms = array(o.platforms, 32).map((v) => {
    const p = record(v, ["id", "x", "y", "direction", "blocked"]),
      id = string(p.id),
      d = level.platforms.find((p) => p.id === id);
    if (!d || p.y !== d.y) throw Error("Checkpoint platform missing");
    return {
      id,
      x: integer(p.x, Math.min(d.x, d.endX), Math.max(d.x, d.endX)),
      y: d.y,
      direction: direction(p.direction),
      blocked: boolean(p.blocked),
    };
  });
  unique(platforms.map((p) => p.id));
  if (platforms.length !== level.platforms.length)
    throw Error("Checkpoint platform collection incomplete");
  if (platforms.some((p, i) => i > 0 && platforms[i - 1].id >= p.id))
    throw Error("Platform ordering invalid");
  for (const a of actors)
    if (a.riderId !== null) {
      const p = platforms.find((p) => p.id === a.riderId),
        d = p && level.platforms.find((d) => d.id === p.id),
        b = body(
          a,
          definitions.archetypes.find((d) => d.id === a.archetypeId)!,
        );
      if (
        !p ||
        !d ||
        !a.grounded ||
        b.y + b.height !== p.y ||
        b.x >= p.x + d.width ||
        b.x + b.width <= p.x
      )
        throw Error("Checkpoint rider contact invalid");
    }
  const d = record(o.decoder, ["slots", "lastTick"]),
    slots = array(d.slots, 4).map((v) => {
      const s = record(v, ["held", "axes"]),
        h = record(s.held, selected ? PLATFORM_ACTIONS_V2 : ACTIONS),
        axes = record(s.axes, ["moveX"]);
      return {
        held: {
          left: boolean(h.left),
          right: boolean(h.right),
          jump: boolean(h.jump),
          attack: boolean(h.attack),
          heavy: boolean(h.heavy),
          guard: boolean(h.guard),
          ...(selected ? { drop: boolean(h.drop) } : {}),
        },
        axes: { moveX: integer(axes.moveX, -127, 127) },
      };
    });
  if (slots.length !== 4 || d.lastTick !== tick - 1)
    throw Error("Checkpoint decoder tick/slots invalid");
  const c = record(o.campaign, ["visitedLevelIds", "defeatedPlacementIds"]),
    visitedLevelIds = array(c.visitedLevelIds, 64).map((v) => string(v)),
    defeatedPlacementIds = array(
      c.defeatedPlacementIds,
      MAX_DEFEATED_PLACEMENTS,
    ).map((v) => {
      if (typeof v !== "string" || v.length > 520)
        throw Error("Invalid durable placement tuple");
      return v;
    });
  unique(visitedLevelIds);
  unique(defeatedPlacementIds);
  if (
    !visitedLevelIds.includes(levelId) ||
    visitedLevelIds.some((id) => !definitions.levels.some((l) => l.id === id))
  )
    throw Error("Checkpoint campaign map invalid");
  if (
    defeatedPlacementIds.some(
      (id) =>
        !definitions.levels.some(
          (l) =>
            visitedLevelIds.includes(l.id) &&
            l.spawns.some((s) => JSON.stringify([l.id, s.id]) === id),
        ),
    )
  )
    throw Error("Checkpoint durable placement invalid");
  const nextEntityId = integer(o.nextEntityId, 1, Number.MAX_SAFE_INTEGER),
    nextExecutionId = integer(o.nextExecutionId, 1, Number.MAX_SAFE_INTEGER),
    motionEpochCounter = counter(o.motionEpochCounter);
  if (
    actors.some(
      (a) =>
        a.id >= nextEntityId ||
        a.motionEpoch > motionEpochCounter ||
        (a.execution && a.execution.id >= nextExecutionId),
    )
  )
    throw Error("Checkpoint monotonic counter invalid");
  const status = o.status as World["status"];
  const players = actors.filter(
    (a) => a.slot !== null && initialPlayerSlots.includes(a.slot),
  );
  if (
    (status === "playing" && players.some((a) => a.health === 0)) ||
    (status === "lost" && !players.some((a) => a.health === 0)) ||
    (status === "won" &&
      (level.goal.nextLevelId !== null ||
        !players.some(
          (a) =>
            a.health > 0 &&
            overlaps(
              body(
                a,
                definitions.archetypes.find((d) => d.id === a.archetypeId)!,
              ),
              level.goal,
            ),
        )))
  )
    throw Error("Checkpoint flow state invalid");
  const restored: World = {
    definitions,
    ...(selected
      ? { inputCodec: "platform-input-v2" as const, motionResults: new Map() }
      : {}),
    identity: { ...identity },
    scenarioId,
    initialPlayerSlots,
    tick,
    levelId,
    status,
    actors,
    platforms,
    decoder: { slots, lastTick: tick - 1 },
    rng: integer(o.rng, 0, 4294967295),
    nextEntityId,
    nextExecutionId,
    motionEpochCounter,
    campaign: { visitedLevelIds, defeatedPlacementIds },
    index: makeIndex(level),
  };
  for (const a of actors) {
    if (a.platformMotion) {
      const m = a.platformMotion;
      const b = body(
        a,
        definitions.archetypes.find((d) => d.id === a.archetypeId)!,
      );
      if (
        m.ignoredSupportIds &&
        (m.ignoredSupportIds.length === 0 ||
          canonical(m.ignoredSupportIds) !==
            canonical([...new Set(m.ignoredSupportIds)].sort()) ||
          m.ignoredSupportIds.includes(m.ignoredSupportId ?? ""))
      )
        throw Error("Checkpoint ignored support ordering invalid");
      for (const id of [
        m.supportId,
        m.ignoredSupportId,
        ...(m.ignoredSupportIds ?? []),
      ])
        if (id !== null) {
          const r = id.startsWith("platform:")
            ? (() => {
                const p = platforms.find((p) => `platform:${p.id}` === id);
                const d = p && level.platforms.find((d) => d.id === p.id);
                return p && d
                  ? { id, oneWay: true, y: p.y, height: d.height }
                  : undefined;
              })()
            : staticOneWay(restored, id);
          if (
            !r ||
            !r.oneWay ||
            r.id !== id ||
            ((id === m.ignoredSupportId || m.ignoredSupportIds?.includes(id)) &&
              (id.startsWith("platform:") ||
                b.y >= r.y + r.height ||
                b.y + b.height < r.y))
          )
            throw Error("Checkpoint one-way identity invalid");
        }
      if (
        (!a.grounded && m.supportId !== null) ||
        (m.supportId !== null &&
          (m.supportId === m.ignoredSupportId ||
            m.ignoredSupportIds?.includes(m.supportId))) ||
        (a.health === 0 &&
          (m.supportId || m.ignoredSupportId || m.ignoredSupportIds?.length))
      )
        throw Error("Checkpoint one-way state invalid");
    }
    const d = definitions.archetypes.find((d) => d.id === a.archetypeId)!;
    if (a.health > 0 && embedded(restored, body(a, d)))
      throw Error("Checkpoint actor embedded in terrain");
    if (a.grounded) {
      const probe = {
        ...a,
        ...(a.platformMotion
          ? { platformMotion: { ...a.platformMotion } }
          : {}),
      };
      moveActor(restored, probe, 0, 0);
      if (
        !probe.grounded ||
        probe.riderId !== a.riderId ||
        probe.platformMotion?.supportId !== a.platformMotion?.supportId
      )
        throw Error("Checkpoint grounded contact invalid");
    }
    if (
      a.health > 0 &&
      defeatedPlacementIds.includes(JSON.stringify([levelId, a.spawnId]))
    )
      throw Error("Checkpoint defeated placement is alive");
    if (
      a.health === 0 &&
      !defeatedPlacementIds.includes(JSON.stringify([levelId, a.spawnId]))
    )
      throw Error("Checkpoint dead placement is missing its outcome");
    if (a.health === 0 && (a.grounded || a.riderId !== null))
      throw Error("Checkpoint dead actor retains contact");
    if (a.stunTicks > 0 && a.execution !== null)
      throw Error("Checkpoint stunned actor retains execution");
  }
  // Safe exhausted states remain importable so every committed checkpoint can
  // round-trip. A later step rejects exhaustion before consuming input/state.
  return restored;
}
/** First structural difference, used only for exact-byte mismatch diagnostics. */
export function firstDifference(left: string, right: string): string | null {
  if (left === right) return null;
  const a = boundedJSON(left),
    b = boundedJSON(right);
  function visit(x: unknown, y: unknown, path: string): string | null {
    if (x === y) return null;
    if (
      x === null ||
      y === null ||
      typeof x !== "object" ||
      typeof y !== "object" ||
      Array.isArray(x) !== Array.isArray(y)
    )
      return path || "/";
    const xo = x as Record<string, unknown>,
      yo = y as Record<string, unknown>;
    for (const k of [
      ...new Set([...Object.keys(xo), ...Object.keys(yo)]),
    ].sort()) {
      if (!Object.hasOwn(xo, k) || !Object.hasOwn(yo, k)) return `${path}/${k}`;
      const result = visit(xo[k], yo[k], `${path}/${k}`);
      if (result) return result;
    }
    return null;
  }
  return visit(a, b, "") ?? "/canonical-order";
}
