import { armDeadline, remainingTicks } from "./tick-deadline";
import { isCombatInvulnerable } from "./combat-runtime";
import {
  UNIT,
  integer,
  normalizeZero,
  string,
} from "../../game-project/src/runtime";
import type {
  AbilityDefinition,
  ArchetypeDefinition,
  CompatibilityIdentity,
  GameDefinitions,
  InputFrame,
  SlotInput,
} from "../../game-project/src/runtime";
import {
  body,
  embedded,
  makeIndex,
  moveActor,
  overlaps,
  shape,
} from "./collision";
import {
  consumeFrame,
  createInputDecoder,
  consumePlatformFrame,
  createPlatformInputDecoder,
} from "./input";
import type {
  PlatformInputFrameV2,
  PlatformSlotInputV2,
  PlatformDecoderStateV2,
} from "./platform-input-v2";
import { checkedIncrement, preflightWorldCounters } from "./counters";
import type { ActorState, Observation, TickEvent, World } from "./types";
function structuredMotion(
  m: import("./types").MotionResult,
): import("./types").MotionResult {
  return { ...m, requested: { ...m.requested }, accepted: { ...m.accepted } };
}
export const TICKS_PER_SECOND = 60;
export function advanceCounter(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0 || n === Number.MAX_SAFE_INTEGER)
    throw Error("Simulation counter exhausted");
  return n + 1;
}
function identity(v: CompatibilityIdentity): CompatibilityIdentity {
  return {
    rulesBuildId: string(v.rulesBuildId),
    contentId: string(v.contentId),
  };
}
export function createWorld(
  definitions: GameDefinitions,
  compatibility: CompatibilityIdentity,
  scenarioId = definitions.manifest.initialScenarioId,
  options?: { inputCodec: "platform-input-v2" },
): World {
  if (
    options &&
    (options.inputCodec !== "platform-input-v2" ||
      Object.keys(options).some((k) => k !== "inputCodec"))
  )
    throw Error("Unsupported platform movement options");
  const scenario = definitions.scenarios.find((s) => s.id === scenarioId);
  if (!scenario) throw Error("Unknown scenario");
  const world: World = {
    definitions,
    ...(options
      ? { inputCodec: options.inputCodec, motionResults: new Map() }
      : {}),
    identity: identity(compatibility),
    scenarioId,
    initialPlayerSlots: [...scenario.playerSlots],
    tick: 0,
    levelId: scenario.levelId,
    status: "playing",
    actors: [],
    platforms: [],
    decoder: options ? createPlatformInputDecoder() : createInputDecoder(),
    rng: scenario.seed,
    nextEntityId: 1,
    nextExecutionId: 1,
    motionEpochCounter: 0,
    campaign: { visitedLevelIds: [], defeatedPlacementIds: [] },
    index: { buckets: new Map() },
  };
  loadLevel(world, scenario.levelId);
  return world;
}
function loadLevel(w: World, levelId: string): void {
  const level = w.definitions.levels.find((l) => l.id === levelId);
  if (!level) throw Error("Unknown level");
  // Allocate the complete replacement off-world. Counter exhaustion and index
  // preparation cannot clear the current actors or partially load a room.
  integer(w.nextEntityId, 1, Number.MAX_SAFE_INTEGER - level.spawns.length);
  integer(w.motionEpochCounter, 0, Number.MAX_SAFE_INTEGER - 1);
  const nextEpoch = advanceCounter(w.motionEpochCounter);
  const nextIndex = makeIndex(level);
  const nextActors: ActorState[] = [];
  let nextEntityId = w.nextEntityId;
  for (const s of level.spawns) {
    const d = w.definitions.archetypes.find((a) => a.id === s.archetypeId)!;
    const id = nextEntityId;
    nextEntityId = advanceCounter(id);
    nextActors.push({
      id,
      ...(w.inputCodec
        ? { platformMotion: { supportId: null, ignoredSupportId: null } }
        : {}),
      spawnId: s.id,
      archetypeId: s.archetypeId,
      slot: s.slot,
      team: s.team,
      x: s.x,
      y: s.y,
      vx: 0,
      vy: 0,
      facing: s.facing,
      health: w.campaign.defeatedPlacementIds.includes(
        JSON.stringify([levelId, s.id]),
      )
        ? 0
        : d.health,
      grounded: false,
      coyoteTicks: 0,
      jumpBuffer: 0,
      attackBuffer: 0,
      bufferedAbility: null,
      freezeTicks: 0,
      stunTicks: 0,
      motionEpoch: nextEpoch,
      riderId: null,
      execution: null,
      ai: { direction: s.facing, decisionTicks: 0 },
    });
  }
  w.levelId = levelId;
  w.index = nextIndex;
  w.motionEpochCounter = nextEpoch;
  w.actors = nextActors;
  w.nextEntityId = nextEntityId;
  if (!w.campaign.visitedLevelIds.includes(levelId))
    w.campaign.visitedLevelIds.push(levelId);
  w.platforms = level.platforms.map((p) => ({
    id: p.id,
    x: p.x,
    y: p.y,
    direction: p.endX >= p.x ? 1 : -1,
    blocked: false,
  }));
  for (const a of w.actors) if (a.health > 0) moveActor(w, a, 0, 0);
}
function archetype(w: World, a: ActorState): ArchetypeDefinition {
  return w.definitions.archetypes.find((d) => d.id === a.archetypeId)!;
}
function ability(w: World, id: string): AbilityDefinition {
  return w.definitions.abilities.find((d) => d.id === id)!;
}
function startStrike(w: World, a: ActorState, events: TickEvent[]): void {
  if (!a.bufferedAbility) return;
  const state = a.combatState;
  if (state && a.bufferedAbility === "equipped")
    a.bufferedAbility = state.weapons[state.equipped]!;
  const id = w.nextExecutionId;
  w.nextExecutionId = advanceCounter(id);
  const action = ability(w, a.bufferedAbility);
  if (
    state &&
    (state.cooldownDeadlines?.[action.id] !== undefined
      ? remainingTicks(
          state.cooldownTick ?? 0,
          state.cooldownDeadlines[action.id]!,
        )
      : (state.cooldowns?.[action.id] ?? 0)) > 0
  )
    return;
  if (state && action.cooldownTicks) {
    state.cooldowns ??= {};
    state.cooldownDeadlines ??= {};
    state.cooldownDeadlines[action.id] = armDeadline(
      state.cooldownTick ?? 0,
      action.cooldownTicks,
    );
    state.cooldowns[action.id] = remainingTicks(
      state.cooldownTick ?? 0,
      state.cooldownDeadlines[action.id]!,
    );
  }
  a.execution = { id, abilityId: a.bufferedAbility, tick: 0, hits: [] };
  a.attackBuffer = 0;
  a.bufferedAbility = null;
  events.push({
    type: "strike",
    tick: w.tick,
    actorId: a.id,
    abilityId: a.execution.abilityId,
  });
}
function acceptEdges(
  w: World,
  a: ActorState,
  input: SlotInput | PlatformSlotInputV2 | undefined,
): void {
  if (!input) return;
  const d = archetype(w, a);
  const state = a.platformMotion;
  const dropped = !!(
    state &&
    a.grounded &&
    state.supportId &&
    !state.supportId.startsWith("platform:") &&
    input.edges.some((e) => e.action === "drop" && e.kind === "pressed")
  );
  if (dropped) {
    if (state!.ignoredSupportId)
      state!.ignoredSupportIds = [
        ...new Set([
          ...(state!.ignoredSupportIds ?? []),
          state!.ignoredSupportId,
        ]),
      ].sort();
    state!.ignoredSupportId = state!.supportId;
    state!.supportId = null;
    a.grounded = false;
    a.riderId = null;
    a.coyoteTicks = 0;
    a.jumpBuffer = 0;
  }
  for (const e of input.edges) {
    if (e.kind === "cancel") {
      if (e.action === "jump") a.jumpBuffer = 0;
      if (e.action === "attack" || e.action === "heavy") {
        a.attackBuffer = 0;
        a.bufferedAbility = null;
      }
      continue;
    }
    if (e.kind !== "pressed") continue;
    if (e.action === "jump" && !dropped) a.jumpBuffer = d.jumpBufferTicks;
    if (e.action === "attack" || e.action === "heavy") {
      a.attackBuffer = d.attackBufferTicks;
      a.bufferedAbility = (
        a.combatState
          ? [
              a.combatState.weapons[a.combatState.equipped]!,
              a.combatState.skill,
            ]
          : d.abilities
      )[e.action === "heavy" ? Math.min(1, d.abilities.length - 1) : 0];
    }
  }
}
function platforms(w: World, events: TickEvent[]): void {
  const level = w.definitions.levels.find((l) => l.id === w.levelId)!;
  for (const p of w.platforms) {
    const d = level.platforms.find((d) => d.id === p.id)!;
    const target =
      p.direction === 1 ? Math.max(d.x, d.endX) : Math.min(d.x, d.endX);
    const dx = p.direction * Math.min(d.speed, Math.abs(target - p.x));
    const riders = w.actors
      .filter((a) => a.health > 0 && a.grounded && a.riderId === p.id)
      .sort((a, b) => a.id - b.id);
    let blocked = false;
    for (const a of riders) {
      const b = body(a, archetype(w, a));
      const proposed = {
        ...a,
        ...(a.platformMotion
          ? {
              platformMotion: {
                ...a.platformMotion,
                ...(a.platformMotion.ignoredSupportIds
                  ? {
                      ignoredSupportIds: [
                        ...a.platformMotion.ignoredSupportIds,
                      ],
                    }
                  : {}),
              },
            }
          : {}),
      };
      moveActor(w, proposed, dx, 0);
      if (
        Math.abs(a.x + dx) > 16777216 ||
        proposed.x !== a.x + dx ||
        embedded(w, { ...b, x: b.x + dx })
      ) {
        blocked = true;
        break;
      }
    }
    p.blocked = blocked;
    if (blocked) {
      events.push({ type: "platform-blocked", tick: w.tick, platformId: p.id });
      continue;
    }
    p.x += dx;
    for (const a of riders) a.x += dx;
    if (p.x === target) p.direction = p.direction === 1 ? -1 : 1;
  }
}
function updateIntent(
  w: World,
  a: ActorState,
  input: SlotInput | PlatformSlotInputV2 | undefined,
): number {
  const d = archetype(w, a);
  let axis = 0;
  if (input) {
    axis =
      input.held.left === input.held.right
        ? input.axes.moveX
        : input.held.left
          ? -127
          : 127;
    if (input.held.left && input.held.right) axis = 0;
    if (Math.abs(axis) <= 16) axis = 0;
  }
  if (d.ai === "patrol" && a.slot === null) {
    const target = w.actors.find(
      (x) => x.slot !== null && x.health > 0 && x.team !== a.team,
    );
    a.ai.decisionTicks = advanceCounter(a.ai.decisionTicks);
    if (target && Math.abs(target.x - a.x) <= d.aiRange) {
      a.ai.direction = target.x >= a.x ? 1 : -1;
      if (!a.stunTicks) a.facing = a.ai.direction;
      axis = a.ai.direction * 127;
      if (Math.abs(target.x - a.x) < 32 * UNIT) {
        axis = 0;
        if (!a.execution && !a.stunTicks) {
          a.bufferedAbility = d.abilities[0];
          a.attackBuffer = d.attackBufferTicks;
        }
      }
    } else axis = a.ai.direction * 127;
  }
  return axis;
}
function movement(
  w: World,
  a: ActorState,
  axis: number,
  events: TickEvent[],
  start: { x: number; y: number },
): void {
  const d = archetype(w, a);
  const cs = a.combatState;
  if (cs) {
    cs.cooldownTick = checkedIncrement(cs.cooldownTick ?? 0);
    if (cs.cooldowns) cs.cooldownDeadlines ??= {};
    for (const key of Object.keys(cs.cooldowns ?? {})) {
      // Legacy world states are converted at their first update, before decrement.
      cs.cooldownDeadlines![key] ??= armDeadline(
        cs.cooldownTick,
        Math.max(0, cs.cooldowns![key]! - 1),
      );
      cs.cooldowns![key] = remainingTicks(
        cs.cooldownTick,
        cs.cooldownDeadlines![key]!,
      );
    }
    cs.invulnerableTicks = Math.max(0, cs.invulnerableTicks - 1);
    cs.rollCooldown = Math.max(0, cs.rollCooldown - 1);
    cs.skillCooldown = Math.max(0, cs.skillCooldown - 1);
    if (a.grounded) cs.jumps = 0;
    if (cs.healTicks > 0 && --cs.healTicks === 0) {
      a.health = Math.min(cs.maxHealth, a.health + 35);
      cs.healCharges--;
    }
    if (cs.rollTick >= 0 && ++cs.rollTick >= 21) cs.rollTick = -1;
  }
  if (a.grounded) a.coyoteTicks = d.coyoteTicks;
  if (!a.stunTicks) {
    if (axis) a.facing = axis < 0 ? -1 : 1;
    a.vx = normalizeZero(Math.trunc((axis * d.speed) / 127));
    if (
      a.jumpBuffer > 0 &&
      (a.grounded || a.coyoteTicks > 0 || (!!cs && cs.jumps < 2))
    ) {
      if (w.motionResults && a.platformMotion)
        w.motionResults.set(a.id, {
          requested: { x: 0, y: 0 },
          accepted: { x: 0, y: 0 },
          supportId: null,
          blockedX: false,
          blockedY: false,
          departure: "jump",
        });
      if (cs) cs.jumps++;
      a.vy = -d.jumpSpeed;
      a.grounded = false;
      a.riderId = null;
      if (a.platformMotion) a.platformMotion.supportId = null;
      a.coyoteTicks = 0;
      a.jumpBuffer = 0;
      events.push({ type: "jump", tick: w.tick, actorId: a.id });
    }
    if (a.attackBuffer > 0 && !a.execution) startStrike(w, a, events);
  } else a.stunTicks--;
  if (cs?.healTicks) a.vx = 0;
  if (cs && cs.rollTick >= 0) a.vx = a.facing * 5 * UNIT;
  if (cs && a.vy < 0 && !w.decoder.slots[a.slot ?? 0]?.held.jump)
    a.vy = Math.max(a.vy, -3 * UNIT);
  a.vy = Math.min(d.maxFallSpeed, a.vy + d.gravity);
  integer(a.vx, -8192, 8192);
  integer(a.vy, -8192, 8192);
  if (Math.abs(a.x + a.vx) > 16777216 || Math.abs(a.y + a.vy) > 16777216) {
    a.health = 0;
    a.vx = 0;
    a.vy = 0;
    events.push({ type: "death", tick: w.tick, actorId: a.id });
    return;
  }
  a.vx = Math.max(start.x - 8192 - a.x, Math.min(start.x + 8192 - a.x, a.vx));
  a.vy = Math.max(start.y - 8192 - a.y, Math.min(start.y + 8192 - a.y, a.vy));
  const previousX = a.x;
  moveActor(w, a, a.vx, a.vy);
  if (d.ai === "patrol" && a.x === previousX && axis)
    a.ai.direction = a.ai.direction === 1 ? -1 : 1;
  if (!a.grounded && a.coyoteTicks > 0) a.coyoteTicks--;
  if (a.jumpBuffer > 0) a.jumpBuffer--;
  if (a.attackBuffer > 0) {
    a.attackBuffer--;
    if (!a.attackBuffer) a.bufferedAbility = null;
  }
}
/** Push shapes stay separate from damage/body geometry. Stable IDs decide equal overlaps. */
function separate(
  w: World,
  starts: Map<number, { x: number; y: number }>,
): void {
  for (let i = 0; i < w.actors.length; i++)
    for (let j = i + 1; j < w.actors.length; j++) {
      const a = w.actors[i],
        b = w.actors[j];
      if (
        a.health <= 0 ||
        b.health <= 0 ||
        (a.combatState?.rollTick ?? -1) >= 0 ||
        (b.combatState?.rollTick ?? -1) >= 0
      )
        continue;
      const ar = shape(a, archetype(w, a).push),
        br = shape(b, archetype(w, b).push);
      if (!overlaps(ar, br)) continue;
      const left = ar.x + ar.width / 2 <= br.x + br.width / 2 ? a : b,
        right = left === a ? b : a;
      const lr = left === a ? ar : br,
        rr = left === a ? br : ar,
        amount = lr.x + lr.width - rr.x,
        first = Math.trunc(amount / 2);
      const ls = starts.get(left.id)!,
        rs = starts.get(right.id)!;
      moveActor(w, left, Math.max(-first, ls.x - 8192 - left.x), 0);
      moveActor(w, right, Math.min(amount - first, rs.x + 8192 - right.x), 0);
    }
}
function combat(
  w: World,
  frozen: Set<number>,
  inputs: SlotInput[],
  events: TickEvent[],
): void {
  const contacts: {
    attacker: ActorState;
    target: ActorState;
    ability: AbilityDefinition;
    guard: boolean;
  }[] = [];
  for (const a of w.actors) {
    if (a.health <= 0 || a.stunTicks > 0 || frozen.has(a.id) || !a.execution)
      continue;
    const d = ability(w, a.execution.abilityId);
    if (
      a.execution.tick < d.startup ||
      a.execution.tick >= d.startup + d.active
    )
      continue;
    const hit = shape(a, d.hit);
    for (const b of w.actors) {
      if (
        a.id === b.id ||
        b.health <= 0 ||
        a.team === b.team ||
        isCombatInvulnerable(b, w)
      )
        continue;
      const prior = a.execution.hits.find((h) => h.targetId === b.id);
      if (
        prior &&
        (prior.count >= d.maxHits || w.tick - prior.lastTick < d.rehitTicks)
      )
        continue;
      if (!overlaps(hit, shape(b, archetype(w, b).hurt))) continue;
      const input = b.slot === null ? undefined : inputs[b.slot];
      contacts.push({
        attacker: a,
        target: b,
        ability: d,
        guard: !!input?.held.guard && b.facing !== a.facing && !b.stunTicks,
      });
    }
  }
  // Gather first. Stun/death or execution interruption cannot erase a simultaneous contact.
  const interrupted = new Set<number>();
  for (const c of contacts) {
    const { attacker: a, target: b, ability: d, guard } = c;
    const execution = a.execution!;
    let prior = execution.hits.find((h) => h.targetId === b.id);
    if (!prior) {
      prior = { targetId: b.id, count: 0, lastTick: w.tick };
      execution.hits.push(prior);
      execution.hits.sort((a, b) => a.targetId - b.targetId);
    }
    prior.count++;
    prior.lastTick = w.tick;
    b.health = Math.max(
      0,
      b.health -
        (guard ? d.guardDamage : d.damage + (a.combatState?.damageBonus ?? 0)),
    );
    b.freezeTicks = Math.max(b.freezeTicks, d.hitStopTicks);
    a.freezeTicks = Math.max(a.freezeTicks, d.hitStopTicks);
    if (!guard) {
      if (b.combatState) {
        b.combatState.invulnerableTicks = 38;
        b.combatState.healTicks = 0;
      }
      b.vx = a.facing * d.knockbackX;
      b.vy = d.knockbackY;
      b.stunTicks = Math.max(b.stunTicks, d.stunTicks);
      interrupted.add(b.id);
    }
    events.push({
      type: guard ? "guard" : "hit",
      tick: w.tick,
      actorId: a.id,
      targetId: b.id,
      abilityId: d.id,
    });
  }
  // All gathered trades apply first. Unguarded damage interrupts even a frozen
  // participant; hit-stop suspends time and never grants attack armor.
  for (const actor of w.actors)
    if (interrupted.has(actor.id)) actor.execution = null;
  for (const a of w.actors)
    if (a.health === 0 && contacts.some((c) => c.target.id === a.id)) {
      events.push({ type: "death", tick: w.tick, actorId: a.id });
    }
}
/** Tick order is input → buffers/AI → platform proposals → motion → contacts/trades → flow. */
export interface PlatformNpcIntent {
  readonly axis: -127 | 0 | 127;
  readonly attack: boolean;
}
export function step(
  w: World,
  frame?: InputFrame | PlatformInputFrameV2,
  npcIntents: ReadonlyMap<number, PlatformNpcIntent> = new Map(),
): TickEvent[] {
  // Campaign behavior may drive only authored non-player, non-patrol actors.
  // Validate before consuming player input or publishing any tick state.
  if (npcIntents.size > 24) throw Error("Platform NPC intent cap");
  for (const [id, intent] of npcIntents) {
    const actor = w.actors.find((actor) => actor.id === id);
    if (
      !actor ||
      actor.slot !== null ||
      archetype(w, actor).ai !== "none" ||
      !intent ||
      Object.getPrototypeOf(intent) !== Object.prototype ||
      Reflect.ownKeys(intent).length !== 2 ||
      !["axis", "attack"].every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(intent, key);
        return (
          descriptor &&
          Object.hasOwn(descriptor, "value") &&
          descriptor.enumerable
        );
      }) ||
      ![-127, 0, 127].includes(intent.axis) ||
      Object.is(intent.axis, -0) ||
      typeof intent.attack !== "boolean"
    )
      throw Error("Invalid platform NPC intent");
  }
  preflightWorldCounters(w);
  const tick = advanceCounter(w.tick);
  const inputs = w.inputCodec
    ? consumePlatformFrame(
        w.decoder as PlatformDecoderStateV2,
        w.tick,
        frame as PlatformInputFrameV2 | undefined,
      )
    : consumeFrame(w.decoder, w.tick, frame as InputFrame | undefined);
  w.motionResults?.clear();
  const events: TickEvent[] = [];
  const restartRequested = !!frame?.commands?.some((c) => c.type === "restart");
  function commitRestart(): void {
    w.status = "playing";
    w.campaign = { visitedLevelIds: [], defeatedPlacementIds: [] };
    loadLevel(
      w,
      w.definitions.scenarios.find((s) => s.id === w.scenarioId)!.levelId,
    );
    events.length = 0;
    events.push({ type: "restart", tick: w.tick, levelId: w.levelId });
  }
  if (w.status !== "playing") {
    if (restartRequested) commitRestart();
    w.tick = tick;
    return events;
  }
  const starts = new Map(w.actors.map((a) => [a.id, { x: a.x, y: a.y }]));
  const frozen = new Set<number>();
  const intents = new Map<number, number>();
  for (const a of w.actors) {
    if (a.health <= 0) continue;
    acceptEdges(w, a, a.slot === null ? undefined : inputs[a.slot]);
    const npc = npcIntents.get(a.id);
    if (npc?.attack && !a.execution && !a.stunTicks && !a.freezeTicks) {
      a.bufferedAbility = archetype(w, a).abilities[0];
      a.attackBuffer = archetype(w, a).attackBufferTicks;
    }
    if (a.freezeTicks > 0) {
      frozen.add(a.id);
      a.freezeTicks--;
    } else
      intents.set(
        a.id,
        npc?.axis ??
          updateIntent(w, a, a.slot === null ? undefined : inputs[a.slot]),
      );
  }
  platforms(w, events);
  for (const a of w.actors) {
    if (a.health <= 0) continue;
    if (frozen.has(a.id)) moveActor(w, a, 0, 0);
    else movement(w, a, intents.get(a.id) ?? 0, events, starts.get(a.id)!);
  }
  separate(w, starts);
  combat(w, frozen, inputs as SlotInput[], events);
  const level = w.definitions.levels.find((l) => l.id === w.levelId)!;
  for (const a of w.actors) {
    if (a.health > 0 && a.y > level.deathY) {
      a.health = 0;
      events.push({ type: "death", tick: w.tick, actorId: a.id });
    }
    // A corpse is no longer a platform participant. Do not serialize a stale
    // rider contact after its platform continues without it.
    if (a.health === 0) {
      a.grounded = false;
      a.riderId = null;
      if (a.platformMotion) {
        a.platformMotion.supportId = null;
        a.platformMotion.ignoredSupportId = null;
        delete a.platformMotion.ignoredSupportIds;
      }
      const key = JSON.stringify([w.levelId, a.spawnId]);
      if (!w.campaign.defeatedPlacementIds.includes(key))
        w.campaign.defeatedPlacementIds.push(key);
    }
    if (a.execution && !frozen.has(a.id)) {
      const d = ability(w, a.execution.abilityId);
      a.execution.tick++;
      if (a.execution.tick >= d.startup + d.active + d.recovery)
        a.execution = null;
    }
  }
  const players = w.actors.filter(
    (a) => a.slot !== null && w.initialPlayerSlots.includes(a.slot),
  );
  if (restartRequested) commitRestart();
  else if (players.some((a) => a.health === 0)) w.status = "lost";
  else if (
    players.some((a) => overlaps(body(a, archetype(w, a)), level.goal))
  ) {
    events.push({ type: "goal", tick: w.tick, levelId: w.levelId });
    if (level.goal.nextLevelId) {
      loadLevel(w, level.goal.nextLevelId);
      events.push({ type: "level", tick: w.tick, levelId: w.levelId });
    } else w.status = "won";
  }
  w.tick = tick;
  for (const actor of w.actors) {
    actor.x = normalizeZero(actor.x);
    actor.y = normalizeZero(actor.y);
    actor.vx = normalizeZero(actor.vx);
    actor.vy = normalizeZero(actor.vy);
  }
  for (const platform of w.platforms) {
    platform.x = normalizeZero(platform.x);
    platform.y = normalizeZero(platform.y);
  }
  return events;
}
export function observe(w: World): Observation {
  const level = w.definitions.levels.find((l) => l.id === w.levelId)!;
  return {
    tick: w.tick,
    levelId: w.levelId,
    status: w.status,
    actors: w.actors.map((a) => {
      const d = archetype(w, a),
        b = body(a, d),
        attack = a.execution ? ability(w, a.execution.abilityId) : null;
      return {
        id: a.id,
        ...(a.platformMotion
          ? {
              platformMotion: {
                ...a.platformMotion,
                ...(a.platformMotion.ignoredSupportIds
                  ? {
                      ignoredSupportIds: [
                        ...a.platformMotion.ignoredSupportIds,
                      ],
                    }
                  : {}),
              },
              ...(w.motionResults?.has(a.id)
                ? { motion: structuredMotion(w.motionResults.get(a.id)!) }
                : {}),
            }
          : {}),
        spawnId: a.spawnId,
        archetypeId: a.archetypeId,
        slot: a.slot,
        team: a.team,
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        facing: a.facing,
        health: a.health,
        maxHealth: d.health,
        freezeTicks: a.freezeTicks,
        stunTicks: a.stunTicks,
        motionEpoch: a.motionEpoch,
        abilityId: a.execution?.abilityId ?? null,
        abilityTick: a.execution?.tick ?? 0,
        grounded: a.grounded,
        hurt: shape(a, d.hurt),
        push: shape(a, d.push),
        hit:
          attack &&
          a.execution!.tick >= attack.startup &&
          a.execution!.tick < attack.startup + attack.active
            ? shape(a, attack.hit)
            : null,
      };
    }),
    platforms: w.platforms.map((p) => {
      const d = level.platforms.find((x) => x.id === p.id)!;
      return { ...p, width: d.width, height: d.height };
    }),
    goal: { ...level.goal },
    campaign: {
      visitedLevelIds: [...w.campaign.visitedLevelIds],
      defeatedPlacementIds: [...w.campaign.defeatedPlacementIds],
    },
  };
}
