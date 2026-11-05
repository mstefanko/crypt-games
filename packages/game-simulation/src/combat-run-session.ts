import { checkedIncrement } from "./counters";
import { copyValidatedWorld } from "./checkpoint";
import { validateTick } from "./tick-deadline";
import {
  createCombatRoomDefinitions,
  type CombatRoomTemplate,
} from "./combat-room-definitions";
import type { GameDefinitions } from "@onepage/game-project/runtime";
import { createWorld, step } from "./simulation";
import { cancelPlatformFrame } from "./platform-input-v2";
import type { World } from "./types";
import {
  combatAction,
  equipCombatActor,
  applyCombatImpact,
} from "./combat-runtime";
import {
  roomEncounterIntents,
  type EncounterMind,
  type EncounterTuning,
} from "./room-encounter";
import {
  ProjectileOwnerV1,
  type DynamicProjectile,
} from "./dynamic-projectiles";
export interface CombatRunRoomDefinition {
  id: number;
  name: string;
  definitions: GameDefinitions;
  nextRoom?: number;
  branchRoom?: number;
  returnRoom?: number;
  seal?: boolean;
  peaceful?: boolean;
  exit?: boolean;
  shop?: boolean;
}
export interface CombatRunLoadout {
  weapons?: readonly string[];
  skill?: string;
  unlock?: { currency: number; weapon: string };
}
export interface CombatRunProjectiles {
  capacity?: number;
  targets?: number;
  maxLifetime?: number;
  life?: number;
  playerSpeed?: number;
  enemySpeed?: number;
  playerDamage?: number;
  enemyDamage?: number;
}
export interface CombatRunRewards {
  kill?: number;
  exit?: number;
  shopCost?: number;
  healthCapacity?: number;
  healthRestore?: number;
  damage?: number;
  skillDamage?: number;
  skills?: readonly string[];
}
export interface CombatRunConfig {
  loadout?: CombatRunLoadout;
  projectiles?: CombatRunProjectiles;
  rewards?: CombatRunRewards;
  seed: number;
  roomTemplate?: CombatRoomTemplate;
  contentId: string;
  rooms: readonly CombatRunRoomDefinition[];
  units?: number;
  floor: number;
  roomWidth: number;
  initialRoom?: number;
  requiredSeals?: number;
  doorX?: number;
  encounter?: EncounterTuning;
}
export interface CombatRunInput {
  left?: boolean;
  right?: boolean;
  jump?: boolean;
  drop?: boolean;
  actions?: readonly string[];
}
export type CombatRunCommand =
  | ({ type: "input" } & CombatRunInput)
  | { type: "retry" | "new-seed" | "cancel-input" };
export interface CombatRunEvent {
  sequence: number;
  tick: number;
  sourceId: string;
  kind: string;
  payload: { pan: number };
}
type Bolt = DynamicProjectile;
interface RoomSave {
  actors: World["actors"];
  decoder: World["decoder"];
  tick: number;
  nextEntityId: number;
  nextExecutionId: number;
  minds: EncounterMind[];
  bolts: Bolt[];
  cleared: boolean;
  claimed: boolean;
  worldState?: Omit<World, "index" | "motionResults">;
}
function createCombatRun(config: CombatRunConfig) {
  const units = config.units ?? 256;
  const bounded = (
    value: number | undefined,
    fallback: number,
    max: number,
  ) => {
    const n = value ?? fallback;
    if (!Number.isFinite(n) || n < 0 || n > max)
      throw new Error("Combat run tuning outside supported bounds");
    return n;
  };
  const integer = (
    value: number | undefined,
    fallback: number,
    max: number,
  ) => {
    const n = bounded(value, fallback, max);
    if (!Number.isInteger(n) || n < 1)
      throw new Error("Combat run capacity must be a positive integer");
    return n;
  };
  const projectile = {
    capacity: integer(config.projectiles?.capacity, 24, 256),
    targets: integer(config.projectiles?.targets, 24, 256),
    maxLifetime: bounded(config.projectiles?.maxLifetime, 3, 30),
    life: bounded(config.projectiles?.life, 2, 30),
    playerSpeed: bounded(config.projectiles?.playerSpeed, 7, 64),
    enemySpeed: bounded(config.projectiles?.enemySpeed, 3.4, 64),
    playerDamage: bounded(config.projectiles?.playerDamage, 13, 10000),
    enemyDamage: bounded(config.projectiles?.enemyDamage, 8, 10000),
  };
  if (projectile.life > projectile.maxLifetime)
    throw new Error("Projectile life exceeds configured lifetime");
  const rewards = {
    kill: bounded(config.rewards?.kill, 1, 10000),
    exit: bounded(config.rewards?.exit, 8, 10000),
    shopCost: bounded(config.rewards?.shopCost, 3, 10000),
    healthCapacity: bounded(config.rewards?.healthCapacity, 20, 10000),
    healthRestore: bounded(config.rewards?.healthRestore, 35, 10000),
    damage: bounded(config.rewards?.damage, 4, 10000),
    skillDamage: bounded(config.rewards?.skillDamage, 1, 10000),
  };
  const weapons = [...(config.loadout?.weapons ?? ["sword", "caster"])],
    skill = config.loadout?.skill ?? "burst",
    unlock = config.loadout?.unlock ?? { currency: 12, weapon: "hammer" },
    skills = config.rewards?.skills ?? ["burst", "trap"];
  if (
    !weapons.length ||
    weapons.length > 8 ||
    !skills.length ||
    skills.length > 8
  )
    throw new Error("Combat loadout requires between one and eight entries");
  bounded(unlock.currency, 12, 1000000);
  const initialWeapons = () => {
    const list = [...weapons];
    if (embers >= unlock.currency) list[0] = unlock.weapon;
    return list;
  };
  const roomDefinition = (id: number) => {
    const definition = config.rooms.find((r) => r.id === id);
    if (!definition) throw new Error(`Unknown combat run room ${id}`);
    return definition;
  };
  if (!Number.isFinite(config.seed)) throw Error("Invalid combat seed");
  const originSeed = ((Math.trunc(config.seed) % 4294967296) + 4294967296) % 4294967296;
  let seedGeneration = 0, effectiveSeed = originSeed,
    room = config.initialRoom ?? 0,
    bank = 0,
    elapsed = 0,
    embers = 0,
    seals = 0,
    deaths = 0,
    won = false,
    lost = false,
    sequence = 0,
    droppedEvents = 0,
    notice = "The heart is cold. Enter the foundry.",
    messageTicks = 240;
  let world: World,
    minds: EncounterMind[] = [],
    bolts: Bolt[] = [],
    cleared = false,
    claimed = false;
  const playerBolts = new ProjectileOwnerV1({
      projectiles: projectile.capacity,
      targets: projectile.targets,
      maxLifetime: projectile.maxLifetime,
    }),
    enemyBolts = new ProjectileOwnerV1({
      projectiles: projectile.capacity,
      targets: projectile.targets,
      maxLifetime: projectile.maxLifetime,
    });
  const rooms = new Map<number, RoomSave>(),
    events: CombatRunEvent[] = [];
  let choices = ["health", "damage", "skill"];
  function sound(kind: string, sourceId = "heart", pan = 0) {
    events.push({
      sequence: (sequence = checkedIncrement(sequence)),
      tick: world?.tick ?? 0,
      sourceId,
      kind,
      payload: { pan },
    });
    if (events.length > 512) {
      events.shift();
      droppedEvents = checkedIncrement(droppedEvents);
    }
  }
  function saveRoom(): RoomSave {
    return structuredClone({
      actors: world.actors,
      decoder: world.decoder,
      tick: world.tick,
      nextEntityId: world.nextEntityId,
      nextExecutionId: world.nextExecutionId,
      minds,
      bolts,
      cleared,
      claimed,
      worldState: (() => {
        const { index, motionResults, ...state } = world;
        return structuredClone(state);
      })(),
    });
  }
  function loadRoom(next: number, carry = true) {
    const previous = world?.actors[0],
      state =
        carry && previous ? structuredClone(previous.combatState) : undefined,
      health = previous?.health;
    if (world) rooms.set(room, saveRoom());
    room = next;
    world = createWorld(
      config.roomTemplate
        ? createCombatRoomDefinitions(effectiveSeed, room, config.roomTemplate)
        : roomDefinition(room).definitions,
      {
        rulesBuildId: "combat-run-v1",
        contentId: `${config.contentId}-${effectiveSeed}-${room}`,
      },
      "start",
      { inputCodec: "platform-input-v2" },
    );
    const old = rooms.get(room);
    bolts = [];
    claimed = !!roomDefinition(room).peaceful && !roomDefinition(room).shop;
    cleared = !!roomDefinition(room).peaceful;
    minds = world.actors
      .filter((a) => a.slot === null)
      .map((a) => ({
        actorId: a.id,
        role: (a.archetypeId === "boss"
          ? "boss"
          : a.archetypeId) as EncounterMind["role"],
        state: "approach",
        ticks: 0,
        phase: 1,
      }));
    if (old) {
      if (old.worldState) Object.assign(world, structuredClone(old.worldState));
      world.actors = structuredClone(old.actors);
      world.decoder = structuredClone(old.decoder);
      world.tick = old.tick;
      world.nextEntityId = old.nextEntityId;
      world.nextExecutionId = old.nextExecutionId;
      minds = structuredClone(old.minds);
      bolts = structuredClone(old.bolts);
      cleared = old.cleared;
      claimed = old.claimed;
    }
    playerBolts.restore(bolts.filter((b) => b.id.startsWith("0:")));
    enemyBolts.restore(bolts.filter((b) => b.id.startsWith("1:")));
    const p = world.actors[0]!;
    equipCombatActor(p, initialWeapons(), skill);
    if (state) {
      p.combatState = state;
      p.health = health!;
      p.combatState.rollTick = -1;
      p.combatState.healTicks = 0;
    }
    p.x = 40 * units;
    p.y = config.floor * units;
    p.execution = null;
    p.vx = 0;
    p.vy = 0;
    choices = ["health", "damage", "skill"].sort(
      (a, b) =>
        ((a.charCodeAt(0) + effectiveSeed + room) % 7) -
        ((b.charCodeAt(0) + effectiveSeed + room) % 7),
    );
    notice = roomDefinition(room).shop
      ? `Ember forge: 1 / 2 / 3 buys a blessing for ${rewards.shopCost} embers. E at the right door to begin.`
      : roomDefinition(room).name;
    messageTicks = 180;
  }
  loadRoom(config.initialRoom ?? 0, false);
  function restart(newSeed = false) {
    if (newSeed) {
      seedGeneration = (seedGeneration + 1) % 4294967296;
      effectiveSeed = (effectiveSeed + 0x9e3779b9) % 4294967296;
    }
    rooms.clear();
    bank = 0;
    room = config.initialRoom ?? 0;
    world = undefined as unknown as World;
    seals = 0;
    won = false;
    lost = false;
    elapsed = 0;
    bolts = [];
    events.length = 0;
    loadRoom(config.initialRoom ?? 0, false);
  }
  function upgrade(index: number) {
    if (
      !cleared ||
      claimed ||
      !Number.isInteger(index) ||
      index < 0 ||
      index > 2
    )
      return;
    if (roomDefinition(room).shop) {
      if (embers < rewards.shopCost) {
        notice = `A blessing costs ${rewards.shopCost} embers. Earn embers in combat; E at the door begins the run.`;
        messageTicks = 240;
        return;
      }
      embers -= rewards.shopCost;
    }
    const p = world.actors[0]!,
      s = p.combatState!,
      choice = choices[index]!;
    if (choice === "health") {
      s.maxHealth += rewards.healthCapacity;
      p.health = Math.min(s.maxHealth, p.health + rewards.healthRestore);
    } else if (choice === "damage") s.damageBonus += rewards.damage;
    else {
      s.skill = skills[(skills.indexOf(s.skill) + 1) % skills.length]!;
      s.skillCooldown = 0;
      s.damageBonus += rewards.skillDamage;
    }
    claimed = true;
    notice = `${choice === "health" ? `Tempered heart +${rewards.healthCapacity}` : choice === "damage" ? `Honed weapon +${rewards.damage}` : "Skill attuned: " + s.skill}`;
    messageTicks = 180;
    sound("upgrade");
  }
  function transition(branch = false) {
    if (!cleared) {
      notice = "The door is sealed by this encounter.";
      messageTicks = 120;
      return;
    }
    if (!claimed && !roomDefinition(room).shop) {
      notice = "Choose a blessing: 1 / 2 / 3";
      messageTicks = 120;
      return;
    }
    const definition = roomDefinition(room);
    const destination = branch
      ? definition.branchRoom
      : (definition.returnRoom ?? definition.nextRoom);
    if (definition.exit && !branch) {
      if (seals < (config.requiredSeals ?? 0)) {
        notice = "More ignition seals are required.";
        return;
      }
      won = true;
      embers += rewards.exit;
      sound("win");
      return;
    }
    if (destination === undefined) return;
    loadRoom(destination);
    input = {};
    pending = [];
    sound("door");
  }
  function tick(input: CombatRunInput, edges: boolean) {
    const p = world.actors[0]!,
      s = p.combatState!;
    if (edges) {
      for (const action of input.actions ?? []) {
        if (["attack", "roll", "skill", "swap", "heal"].includes(action)) {
          if (
            combatAction(
              world,
              p.id,
              action as "attack" | "roll" | "skill" | "swap" | "heal",
            )
          ) {
            const kind =
              action === "attack"
                ? "swing"
                : action === "skill"
                  ? "cast"
                  : action;
            sound(kind);
          }
        } else if (action.startsWith("upgrade-"))
          upgrade(Number(action.slice(8)));
        else if (action === "interact" && p.x / units > (config.doorX ?? 875)) {
          transition();
          return;
        } else if (action === "branch" && p.x / units > 700) {
          transition(true);
          return;
        }
      }
    }
    const frame = cancelPlatformFrame(
        world.decoder as Parameters<typeof cancelPlatformFrame>[0],
      ),
      slot = frame.slots[0]!;
    slot.edges = [];
    const keys = {
      left: !!input.left,
      right: !!input.right,
      jump: !!input.jump,
      drop: !!input.drop,
    };
    for (const action of ["left", "right", "jump", "drop"] as const) {
      slot.held[action] = !!keys[action];
      if (
        slot.held[action] !==
        world.decoder.slots[0]!.held[action as "left" | "right" | "jump"]
      )
        slot.edges.push({
          action,
          kind: slot.held[action] ? "pressed" : "released",
        });
    }
    slot.axes.moveX = keys.left === keys.right ? 0 : keys.right ? 127 : -127;
    world.actors = world.actors.filter(
      (a) => a.archetypeId !== "spark-trap" || a.execution !== null,
    );
    const previous = new Map(world.actors.map((a) => [a.id, a.execution?.id]));
    const intents = roomEncounterIntents(world, minds, config.encounter);
    const simEvents = step(world, frame, intents);
    for (const a of world.actors) {
      if (a.x < 12 * units) a.x = 12 * units;
      if (a.x > (config.roomWidth - 12) * units)
        a.x = (config.roomWidth - 12) * units;
      if (
        a.execution &&
        previous.get(a.id) !== a.execution.id &&
        ["caster", "shot"].includes(a.execution.abilityId)
      ) {
        const owner = a.team ? enemyBolts : playerBolts;
        owner.spawn({
          id: `${a.team}:${a.id}:${world.tick}`,
          x: a.x + a.facing * 12 * units,
          y: a.y - 18 * units,
          vx:
            a.facing *
            (a.team ? projectile.enemySpeed : projectile.playerSpeed) *
            units *
            60,
          vy: 0,
          gravity: 0,
          radius: 3 * units,
          originX: a.x,
          life: projectile.life,
          damage: a.team
            ? projectile.enemyDamage
            : projectile.playerDamage + s.damageBonus,
        });
      }
    }
    for (const team of [0, 1]) {
      const targets = world.actors
        .filter((a) => a.team !== team && a.health > 0)
        .map((a) => ({
          id: String(a.id),
          x: a.x,
          y: a.y - 17 * units,
          nextX: a.x,
          nextY: a.y - 17 * units,
          radius: 13 * units,
        }));
      for (const hit of (team ? enemyBolts : playerBolts).step(1 / 60, targets))
        simEvents.push(
          ...applyCombatImpact(
            world,
            Number(hit.projectile.id.split(":")[1]),
            Number(hit.targetId),
            hit.projectile.damage,
          ),
        );
    }
    bolts = [...playerBolts.capture(), ...enemyBolts.capture()];
    for (const e of simEvents) {
      if (e.type === "hit") {
        sound(e.targetId === p.id ? "hurt" : "metal", String(e.targetId));
      }
      if (e.type === "jump" && e.actorId === p.id) sound("jump");
      if (e.type === "death" && e.actorId !== p.id) {
        embers += rewards.kill;
        sound("shatter");
      }
    }
    if (
      !cleared &&
      world.actors.filter((a) => a.team === 1).every((a) => a.health <= 0)
    ) {
      cleared = true;
      if (roomDefinition(room).seal) seals++;
      sound("clear");
      notice = roomDefinition(room).exit
        ? "The bell is silent. Claim your blessing and leave."
        : "Seal kindled. Choose a blessing: 1 / 2 / 3";
      messageTicks = 300;
    }
    if (p.health <= 0) {
      lost = true;
      deaths++;
      sound("lose");
    }
    elapsed += 1 / 60;
    messageTicks = Math.max(0, messageTicks - 1);
  }
  let input: CombatRunInput = {},
    pending: string[] = [];
  return {
    command(command: CombatRunCommand) {
      if (command.type === "retry" || command.type === "new-seed") {
        restart(command.type === "new-seed");
        input = {};
        pending = [];
        return;
      }
      if (command.type === "cancel-input") {
        input = {};
        pending = [];
        for (const slot of world.decoder.slots) {
          for (const key of Object.keys(slot.held))
            slot.held[key as keyof typeof slot.held] = false;
          slot.axes = { moveX: 0 };
        }

        return;
      }
      if (command.type !== "input") return;
      input = {
        left: command.left,
        right: command.right,
        jump: command.jump,
        drop: command.drop,
      };
      pending.push(...(command.actions ?? []));
    },
    step(dt: number) {
      if (won || lost || !Number.isFinite(dt) || dt <= 0) return;
      bank += Math.min(0.1, dt);
      let edges = true;
      while (bank >= 1 / 60 && !won && !lost) {
        tick({ ...input, actions: pending }, edges);
        if (edges) pending = [];
        edges = false;
        bank -= 1 / 60;
      }
    },
    observe() {
      return structuredClone({
        world,
        minds,
        bolts,
        room,
        roomName: roomDefinition(room).name,
        effectiveSeed,
        elapsed,
        embers,
        seals,
        deaths,
        won,
        lost,
        cleared,
        claimed,
        choices,
        notice,
        messageTicks,
        droppedEvents,
      });
    },
    drainEvents() {
      return events.splice(0);
    },
    carryover() {
      return { embers, deaths };
    },
    restoreCarryover(value: unknown) {
      const v = value as { embers?: number; deaths?: number };
      embers = Math.max(0, v?.embers ?? 0);
      deaths = Math.max(0, v?.deaths ?? 0);
      world.actors[0]!.combatState!.weapons = initialWeapons();
    },
    snapshot() {
      return {
        version: 3 as const,
        originSeed,
        seedGeneration,
        events: structuredClone(events),
        contentId: config.contentId,
        input: structuredClone(input),
        pending: [...pending],
        effectiveSeed,
        room,
        bank,
        elapsed,
        embers,
        seals,
        deaths,
        won,
        lost,
        sequence,
        droppedEvents,
        notice,
        messageTicks,
        current: saveRoom(),
        rooms: [...rooms],
      };
    },
    restore(value: unknown) {
      let v = value as CombatRunSnapshot;
      // v2 lacks origin provenance: only the configured initial seed is provable.
      if ((v as { version?: number })?.version === 2 && v.effectiveSeed === originSeed)
        v = { ...v, version: 3, originSeed, seedGeneration: 0 };
      if (
        !v ||
        v.version !== 3 ||
        v.originSeed !== originSeed ||
        !Number.isSafeInteger(v.seedGeneration) || v.seedGeneration < 0 || v.seedGeneration > 0xffffffff ||
        v.effectiveSeed !== seedAtGeneration(originSeed, v.seedGeneration) ||
        v.contentId !== config.contentId ||
        !config.rooms.some((r) => r.id === v.room)
      )
        throw new Error(
          "Incompatible combat run checkpoint; restart required.",
        );
      validateCombatRunCheckpoint(v);
      effectiveSeed = v.effectiveSeed;
      seedGeneration = v.seedGeneration;
      room = v.room;
      rooms.clear();
      for (const [id, r] of v.rooms) rooms.set(id, structuredClone(r));
      const validateRoom = (id: number, r: RoomSave) => {
        roomDefinition(id);
        if (!r || !r.worldState)
          throw Error("Incomplete combat room checkpoint");
        const expected = createWorld(
          config.roomTemplate
            ? createCombatRoomDefinitions(
                v.effectiveSeed,
                id,
                config.roomTemplate,
              )
            : roomDefinition(id).definitions,
          {
            rulesBuildId: "combat-run-v1",
            contentId: `${config.contentId}-${v.effectiveSeed}-${id}`,
          },
          "start",
          { inputCodec: "platform-input-v2" },
        );
        const expectedKeys = Object.keys(expected).filter(
          (key) => key !== "index" && key !== "motionResults",
        );
        if (
          Object.keys(r.worldState).some(
            (key) => !expectedKeys.includes(key),
          ) ||
          expectedKeys.some((key) => !(key in r.worldState!))
        )
          throw Error("Unknown or missing combat world field");
        const candidate = {
          ...structuredClone(r.worldState),
          definitions: expected.definitions,
          identity: expected.identity,
        } as World;
        if (
          JSON.stringify(r.worldState.definitions) !==
            JSON.stringify(expected.definitions) ||
          JSON.stringify(r.worldState.identity) !==
            JSON.stringify(expected.identity)
        )
          throw Error("Combat room content mismatch");
        const validated = copyValidatedWorld(candidate);
        if (
          JSON.stringify(r.actors) !== JSON.stringify(r.worldState.actors) ||
          JSON.stringify(r.decoder) !== JSON.stringify(r.worldState.decoder) ||
          r.tick !== validated.tick ||
          r.nextEntityId !== validated.nextEntityId ||
          r.nextExecutionId !== validated.nextExecutionId
        )
          throw Error("Conflicting combat room state");
        if (
          typeof r.cleared !== "boolean" ||
          typeof r.claimed !== "boolean" ||
          !Array.isArray(r.minds) ||
          r.minds.length > 256 ||
          r.minds.length !== validated.actors.filter(a => a.slot === null).length ||
          !Array.isArray(r.bolts)
        )
          throw Error("Invalid combat room state");
        const minds = new Set<number>();
        for (const mind of r.minds) {
          validateTick(mind.actorId);
          validateTick(mind.ticks);
          validateTick(mind.phase);
          const actor = validated.actors.find(a => a.id === mind.actorId);
          const maxPhase = mind.role === "boss" ? Math.max(2, config.encounter?.bossPhases?.length ?? 0) : 1;
          if (
            minds.has(mind.actorId) ||
            !actor || actor.slot !== null || mind.role !== actor.archetypeId ||
            !["lunger", "shooter", "hover", "boss"].includes(mind.role) ||
            !["approach", "telegraph", "commit", "recover"].includes(mind.state) ||
            mind.phase < 1 || mind.phase > maxPhase || mind.ticks > validated.tick ||
            !validated.actors.some((a) => a.id === mind.actorId) ||
            typeof mind.state !== "string" ||
            typeof mind.role !== "string"
          )
            throw Error("Invalid encounter checkpoint");
          minds.add(mind.actorId);
        }
        const p = new ProjectileOwnerV1({
          projectiles: projectile.capacity,
          targets: projectile.targets,
          maxLifetime: projectile.maxLifetime,
        });
        const q = new ProjectileOwnerV1({
          projectiles: projectile.capacity,
          targets: projectile.targets,
          maxLifetime: projectile.maxLifetime,
        });
        if (
          r.bolts.some((b) => !b.id.startsWith("0:") && !b.id.startsWith("1:"))
        )
          throw Error("Invalid projectile team");
        p.restore(r.bolts.filter((b) => b.id.startsWith("0:")));
        q.restore(r.bolts.filter((b) => b.id.startsWith("1:")));
      };
      validateRoom(v.room, v.current);
      const roomIds = new Set<number>();
      for (const [id, state] of v.rooms) {
        if (roomIds.has(id)) throw Error("Duplicate combat room");
        roomIds.add(id);
        validateRoom(id, state);
      }
      const r = v.current;
      world = undefined as unknown as World;
      loadRoom(v.room, false);
      Object.assign(world, structuredClone(r.worldState!));
      minds = structuredClone(r.minds);
      bolts = structuredClone(r.bolts);
      cleared = r.cleared;
      claimed = r.claimed;
      bank = v.bank;
      elapsed = v.elapsed;
      embers = v.embers;
      seals = v.seals;
      deaths = v.deaths;
      won = v.won;
      lost = v.lost;
      sequence = v.sequence;
      droppedEvents = v.droppedEvents;
      notice = v.notice;
      messageTicks = v.messageTicks;
      playerBolts.restore(bolts.filter((b) => b.id.startsWith("0:")));
      enemyBolts.restore(bolts.filter((b) => b.id.startsWith("1:")));
      events.splice(0, events.length, ...structuredClone(v.events));
      input = structuredClone(v.input);
      pending = [...v.pending];
    },
  };
}
export type CombatRunSnapshot = ReturnType<
  ReturnType<typeof createCombatRun>["snapshot"]
>;
/** Events have one destructive drain consumer. Retain newest 512; droppedEvents
 * counts cumulative evictions across drain, retry and checkpoint continuation. */
export class CombatRunSession {
  private owner: ReturnType<typeof createCombatRun>;
  private readonly config: CombatRunConfig;
  constructor(config: CombatRunConfig) {
    this.config = structuredClone(config);
    this.owner = createCombatRun(this.config);
  }
  command(command: CombatRunCommand) {
    this.owner.command(command);
  }
  step(dt: number) {
    this.owner.step(dt);
  }
  observe() {
    return this.owner.observe();
  }
  snapshot() {
    return this.owner.snapshot();
  }
  restore(value: unknown) {
    const candidate = createCombatRun(this.config);
    candidate.restore(value);
    this.owner = candidate;
  }
  drainEvents() {
    return this.owner.drainEvents();
  }
  carryover() {
    return this.owner.carryover();
  }
  restoreCarryover(value: unknown) {
    this.owner.restoreCarryover(value);
  }
}

function validateCombatRunCheckpoint(v: CombatRunSnapshot): void {
  const fail = () => {
    throw Error("Invalid combat run checkpoint; restart required");
  };
  let nodes = 0;
  const visit = (x: unknown, seen = new Set<object>(), depth = 0) => {
    if (
      ++nodes > 100000 ||
      depth > 64 ||
      (typeof x === "string" && x.length > 1000000)
    )
      fail();
    if (
      x === null ||
      x === undefined ||
      typeof x === "string" ||
      typeof x === "boolean"
    )
      return;
    if (typeof x === "number") {
      if (!Number.isFinite(x)) fail();
      return;
    }
    if (typeof x !== "object" || seen.has(x)) fail();
    if (
      Array.isArray(x)
        ? x.length > 10000
        : Object.getPrototypeOf(x) !== Object.prototype
    )
      fail();
    seen.add(x as object);
    for (const child of Object.values(x as object))
      visit(child, seen, depth + 1);
    seen.delete(x as object);
  };
  visit(v);
  for (const key of [
    "effectiveSeed",
    "room",
    "seals",
    "deaths",
    "sequence",
    "droppedEvents",
    "messageTicks",
  ] as const)
    validateTick(v[key]);
  if (
    typeof v.bank !== "number" ||
    typeof v.elapsed !== "number" ||
    typeof v.embers !== "number" ||
    v.embers < 0 ||
    v.embers > Number.MAX_SAFE_INTEGER ||
    v.effectiveSeed > 0xffffffff ||
    !(v.bank >= 0 && v.bank < (v.won || v.lost ? 0.1 + 1 / 60 : 1 / 60)) ||
    !(v.elapsed >= 0) ||
    typeof v.notice !== "string" ||
    typeof v.won !== "boolean" ||
    typeof v.lost !== "boolean" ||
    !Array.isArray(v.rooms) ||
    v.rooms.length > 256 ||
    !Array.isArray(v.events) ||
    v.events.length > 512 ||
    v.droppedEvents > v.sequence ||
    !Array.isArray(v.pending) ||
    !v.pending.every((x) => typeof x === "string") ||
    !v.input ||
    typeof v.input !== "object"
  )
    fail();
  for (const key of Object.keys(v.input))
    if (
      !["left", "right", "jump", "drop"].includes(key) ||
      (v.input[key as keyof CombatRunInput] !== undefined &&
        typeof v.input[key as keyof CombatRunInput] !== "boolean")
    )
      fail();
  let previous = 0;
  for (const e of v.events) {
    validateTick(e.sequence);
    validateTick(e.tick);
    if (
      e.sequence <= previous ||
      e.sequence > v.sequence ||
      typeof e.sourceId !== "string" ||
      typeof e.kind !== "string" ||
      !e.payload ||
      typeof e.payload.pan !== "number"
    )
      fail();
    previous = e.sequence;
  }
}

/** Exact uint32 Weyl continuation using bounded additions, never an unsafe product. */
function seedAtGeneration(origin: number, generation: number): number {
  let result = origin, increment = 0x9e3779b9;
  for (let remaining = generation; remaining > 0; remaining = Math.floor(remaining / 2)) {
    if (remaining % 2 === 1) result = (result + increment) % 4294967296;
    increment = (increment + increment) % 4294967296;
  }
  return result;
}
