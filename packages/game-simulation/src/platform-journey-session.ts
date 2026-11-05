import { createWorld, step as stepWorld } from "./simulation";
import { launchPlatformSpring } from "./platform-spring";
import { cancelFrame } from "./input";
import { serializeCheckpoint, restoreCheckpoint } from "./checkpoint";
import { CAMPAIGN_PLATFORM_FIXTURE_DEFINITIONS } from "./campaign-platform-fixture";

export interface PlatformJourneyRoom {
  name: string;
  hint: string;
  rectangles: readonly {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    oneWay: boolean;
  }[];
  platforms: readonly {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    endX: number;
    speed: number;
  }[];
  gapOverride?: { index: number; x: number; width: number };
  spring?: {
    x: number;
    y: number;
    minX: number;
    maxX: number;
    velocity: number;
  };
  signal?: { x: number; y: number; minX: number; maxX: number; speed: number };
}
export interface PlatformJourneyDefinition {
  id: string;
  title: string;
  contentId: string;
  rulesBuildId: string;
  completionMessage: string;
  layout: {
    width: number;
    height: number;
    floor: number;
    tileSize: 8 | 16 | 32;
    unitsPerPixel: number;
    spawnX: number;
    checkpoint: { threshold: number; x: number };
    goal: { x: number; width: number; height: number };
    deathY: number;
    recoverY: number;
    gaps: readonly number[];
    gapWidth: number;
    gapWidthVariation: number;
    seedShiftSteps: number;
    collectibleHeight: number;
    alternateCollectibleHeight: number;
  };
  rooms: readonly PlatformJourneyRoom[];
  collectibleXs: readonly number[];
}
export type PlatformJourneyCommand =
  | {
      kind: "input";
      left: boolean;
      right: boolean;
      jump: boolean;
      /** A completed input pulse waits for the next simulation tick. */
      jumpPressed?: boolean;
      interact?: boolean;
      sequence?: number;
      revision?: number;
    }
  | { kind: "recover"; sequence?: number; revision?: number }
  | { kind: "cancel" };
export interface PlatformJourneyEvent {
  sequence: number;
  tick: number;
  sourceId: string;
  kind: "jump" | "discovery" | "delivery" | "damage" | "win";
}
type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K];
};

/** Seeded bounded roof gaps preserve the fixture motor; authored overrides support ferry traversal. */
function content(
  definition: PlatformJourneyDefinition,
  seed: number,
  room: number,
) {
  const {
    unitsPerPixel: U,
    width: W,
    floor: FLOOR,
    height,
    tileSize,
  } = definition.layout;
  const d = structuredClone(CAMPAIGN_PLATFORM_FIXTURE_DEFINITIONS) as Mutable<
    typeof CAMPAIGN_PLATFORM_FIXTURE_DEFINITIONS
  >;
  const level = d.levels[0]!;
  level.id = "journey-room";
  level.width = W;
  level.height = height;
  level.tileSize = tileSize;
  const shift =
    (Math.floor(seed / 2 ** ((room * 3) % 32)) %
      definition.layout.seedShiftSteps) *
    tileSize;
  const gaps = definition.layout.gaps.map((x, i) => ({
    x: x + (i % 2 === 0 ? shift : 0),
    width:
      definition.layout.gapWidth +
      ((seed + room + i) % 2) * definition.layout.gapWidthVariation,
  }));
  level.rectangles = [];
  level.platforms = [];
  const region = definition.rooms[room]!;
  level.rectangles = region.rectangles.map((r) => ({
    ...r,
    x: r.x * U,
    y: r.y * U,
    width: r.width * U,
    height: r.height * U,
  }));
  level.platforms = region.platforms.map((p) => ({
    ...p,
    x: p.x * U,
    y: p.y * U,
    width: p.width * U,
    height: p.height * U,
    endX: p.endX * U,
    speed: p.speed * U,
  }));
  if (region.gapOverride) {
    gaps[region.gapOverride.index] = {
      x: region.gapOverride.x,
      width: region.gapOverride.width,
    };
  }
  const columns = W / tileSize,
    rows = height / tileSize;
  level.tiles = Array.from({ length: columns * rows }, (_, i) => {
    const x = (i % columns) * tileSize,
      y = Math.floor(i / columns) * tileSize;
    return y >= FLOOR && !gaps.some((g) => x >= g.x && x < g.x + g.width)
      ? 1
      : 0;
  });
  // Same discrete gravity integration as the preserved platform motor. This is
  // a conservative flat-gap envelope; tall ledges and ferry timing remain
  // authored traversal obligations rather than claims of full reachability.
  const motor = d.archetypes[0]!;
  let vertical = 0,
    velocity = -motor.jumpSpeed,
    flightTicks = 0;
  do {
    velocity = Math.min(motor.maxFallSpeed, velocity + motor.gravity);
    vertical += velocity;
    flightTicks++;
  } while (vertical < 0 && flightTicks < 600);
  const jumpSpan = (flightTicks * motor.speed) / U;
  for (const gap of gaps) {
    const ferry = region.platforms.some(
      (p) =>
        p.x <= gap.x && Math.max(p.x, p.endX) + p.width >= gap.x + gap.width,
    );
    if (gap.width > jumpSpan && !ferry)
      throw new Error("Journey gap exceeds motor envelope without a ferry");
  }
  level.spawns = [
    {
      id: "player",
      archetypeId: "hero",
      x: definition.layout.spawnX * U,
      y: FLOOR * U,
      slot: 0,
      team: 0,
      facing: 1,
    },
  ];
  level.goal = {
    x: definition.layout.goal.x * U,
    y: 0,
    width: definition.layout.goal.width * U,
    height: definition.layout.goal.height * U,
    nextLevelId: null,
  };
  level.deathY = definition.layout.deathY * U;
  d.levels = [level];
  d.archetypes = [d.archetypes[0]!];
  d.archetypes[0]!.health = 1;
  d.scenarios = [
    {
      id: "start",
      levelId: "journey-room",
      seed: ((Math.trunc(seed) % 4294967296) + 4294967296) % 4294967296,
      playerSlots: [0],
      ticks: 30000,
      actions: [],
      assertions: [],
    },
  ];
  d.manifest = {
    ...d.manifest,
    gameId: definition.id,
    title: definition.title,
    initialLevelId: "journey-room",
    initialScenarioId: "start",
    levelIds: ["journey-room"],
    archetypeIds: ["hero"],
    scenarioIds: ["start"],
  };
  return { d, gaps };
}
function createJourney(definition: PlatformJourneyDefinition, seed: number) {
  const {
    unitsPerPixel: U,
    width: W,
    floor: FLOOR,
    spawnX,
  } = definition.layout;
  let room = 0,
    elapsed = 0,
    deaths = 0,
    tokens = 0,
    flow = 0,
    checkpoint = spawnX,
    bank = 0,
    won = false,
    best = spawnX,
    air = 0,
    landings = 0,
    lever = false,
    lastLandingX = spawnX;
  let c = content(definition, seed, room),
    world = createWorld(c.d, {
      rulesBuildId: definition.rulesBuildId,
      contentId: `${definition.contentId}-${seed}-${room}`,
    });
  let checkpointBytes = serializeCheckpoint(world);
  const collected = new Set<string>();
  function resetRoom() {
    c = content(definition, seed, room);
    world = createWorld(c.d, {
      rulesBuildId: definition.rulesBuildId,
      contentId: `${definition.contentId}-${seed}-${room}`,
    });
    checkpoint = spawnX;
    best = spawnX;
    lever = false;
    lastLandingX = spawnX;
    checkpointBytes = serializeCheckpoint(world);
  }
  function tick() {
    const a = world.actors[0]!;
    const wasGrounded = a.grounded;
    const frame = cancelFrame(world.decoder),
      slot = frame.slots[0]!;
    const { left, right } = held;
    const jump = held.jump || pendingJump;
    const region = definition.rooms[room]!;
    // Preserve decoder ownership: derive genuine transitions for held actions.
    slot.edges = [];
    for (const action of ["left", "right", "jump"] as const) {
      const next = action === "left" ? left : action === "right" ? right : jump;
      slot.held[action] = next;
      // A new pulse can follow a release between ticks while the decoder is held.
      if (action === "jump" && pendingJump && world.decoder.slots[0]!.held.jump)
        slot.edges.push({ action, kind: "released" }, { action, kind: "pressed" });
      else if (next !== world.decoder.slots[0]!.held[action])
        slot.edges.push({ action, kind: next ? "pressed" : "released" });
    }
    slot.axes.moveX = right === left ? 0 : right ? 127 : -127;
    if (
      region.signal &&
      !lever &&
      a.x / U > region.signal.minX &&
      a.x / U < region.signal.maxX &&
      interact
    ) {
      lever = true;
      const levels = world.definitions.levels.map((l) => ({
        ...l,
        platforms: l.platforms.map((p) => ({
          ...p,
          speed: region.signal!.speed * U,
        })),
      }));
      world.definitions = { ...world.definitions, levels };
      emit("discovery");
    }
    if (
      region.spring &&
      a.x / U > region.spring.minX &&
      a.x / U < region.spring.maxX &&
      a.grounded &&
      launchPlatformSpring(world, a.id, region.spring.velocity * U)
    )
      emit("jump");
    const events = stepWorld(world, frame);
    elapsed += 1 / 60;
    ticks++;
    revision++;
    if (events.some((e) => e.type === "jump")) emit("jump");
    const player = world.actors[0]!;
    const x = player.x / U,
      y = player.y / U;
    if (!player.grounded) air = Math.min(2, air + 1 / 60);
    else {
      if (!wasGrounded && air > 0.2 && x > lastLandingX + 32) {
        landings++;
        flow = Math.min(1, flow + 0.08);
        lastLandingX = x;
      }
      air = 0;
    }
    flow = Math.max(0, Math.min(1, flow + (x > best ? 0.0018 : -0.0008)));
    best = Math.max(best, x);
    for (let i = 0; i < definition.collectibleXs.length; i++) {
      const tx = definition.collectibleXs[i]!,
        ty =
          FLOOR -
          definition.layout.collectibleHeight -
          (room % 2) * definition.layout.alternateCollectibleHeight,
        key = `${room}-${i}`;
      if (
        !collected.has(key) &&
        Math.abs(x - tx) < 18 &&
        Math.abs(y - ty) < 26
      ) {
        collected.add(key);
        tokens++;
        emit("delivery");
      }
    }
    if (
      x > definition.layout.checkpoint.threshold &&
      checkpoint < definition.layout.checkpoint.threshold &&
      player.grounded
    ) {
      checkpoint = definition.layout.checkpoint.x;
      checkpointBytes = serializeCheckpoint(world);
      emit("discovery");
    }
    if (world.status === "lost" || y > definition.layout.recoverY) {
      deaths++;
      flow *= 0.4;
      world = restoreCheckpoint(
        world.definitions,
        world.identity,
        checkpointBytes,
      );
      emit("damage");
      air = 0;
    }
    if (world.status === "won" || x > definition.layout.goal.x - 6) {
      if (room === definition.rooms.length - 1) {
        won = true;
        emit("win");
      } else {
        room++;
        emit("delivery");
        resetRoom();
      }
    }
  }
  let held = { left: false, right: false, jump: false },
    interact = false,
    pendingJump = false;
  let ticks = 0,
    revision = 0,
    eventSequence = 0,
    lastCommandSequence = -1;
  let events: PlatformJourneyEvent[] = [];
  function emit(kind: PlatformJourneyEvent["kind"]) {
    events.push({
      sequence: ++eventSequence,
      tick: ticks,
      sourceId: definition.id,
      kind,
    });
    if (events.length > 128) events.shift();
  }
  function restoreWorld(bytes: string) {
    world = restoreCheckpoint(world.definitions, world.identity, bytes);
  }
  function state() {
    return {
      room,
      elapsed,
      deaths,
      tokens,
      flow,
      checkpoint,
      best,
      air,
      landings,
      lever,
      lastLandingX,
      won,
      collected: [...collected],
      world: serializeCheckpoint(world),
      checkpointBytes,
    };
  }
  return {
    command(command: PlatformJourneyCommand) {
      if (command.kind === "cancel") {
        held = { left: false, right: false, jump: false };
        interact = false;
        pendingJump = false;
        return true;
      }
      if (command.revision !== undefined && command.revision !== revision)
        return false;
      if (
        command.sequence !== undefined &&
        command.sequence <= lastCommandSequence
      )
        return false;
      if (won) return false;
      if (command.sequence !== undefined)
        lastCommandSequence = command.sequence;
      if (command.kind === "recover") {
        restoreWorld(checkpointBytes);
        deaths++;
        emit("damage");
        revision++;
      } else {
        held = { left: command.left, right: command.right, jump: command.jump };
        interact ||= !!command.interact;
        pendingJump ||= !!command.jumpPressed;
      }
      return true;
    },
    step(dt: number) {
      if (!Number.isFinite(dt) || dt < 0)
        throw new Error("Invalid platform journey step");
      bank += Math.min(dt, 0.1);
      while (bank >= 1 / 60 && !won) {
        tick();
        bank -= 1 / 60;
        interact = false;
        pendingJump = false;
      }
    },
    observe() {
      const a = world.actors[0]!,
        level = c.d.levels[0]!,
        region = definition.rooms[room]!;
      return {
        room,
        roomName: region.name,
        roomCount: definition.rooms.length,
        status: won
          ? definition.completionMessage
          : region.name + " · " + region.hint,
        elapsed,
        deaths,
        tokens,
        flow,
        checkpoint,
        best,
        air,
        landings,
        lever,
        won,
        tick: ticks,
        revision,
        floor: FLOOR,
        player: {
          x: a.x / U,
          y: a.y / U,
          vx: a.vx / U,
          vy: a.vy / U,
          grounded: a.grounded,
          facing: a.facing,
        },
        level: {
          width: level.width,
          height: level.height,
          tileSize: level.tileSize,
          tiles: [...level.tiles],
          rectangles: level.rectangles.map((r) => ({
            ...r,
            x: r.x / U,
            y: r.y / U,
            width: r.width / U,
            height: r.height / U,
          })),
        },
        platforms: world.platforms.map((p) => {
          const d = level.platforms.find((d) => d.id === p.id)!;
          return {
            ...p,
            x: p.x / U,
            y: p.y / U,
            width: d.width / U,
            height: d.height / U,
          };
        }),
        collectibles: definition.collectibleXs.map((x, i) => ({
          id: `${room}-${i}`,
          x,
          y:
            FLOOR -
            definition.layout.collectibleHeight -
            (room % 2) * definition.layout.alternateCollectibleHeight,
          collected: collected.has(`${room}-${i}`),
        })),
        spring: region.spring
          ? { x: region.spring.x, y: region.spring.y }
          : undefined,
        signal: region.signal
          ? { x: region.signal.x, y: region.signal.y, active: lever }
          : undefined,
      };
    },
    drainEvents() {
      const result = events;
      events = [];
      return result;
    },
    snapshot() {
      return {
        kind: "platform-journey" as const,
        version: 1 as const,
        contentId: definition.contentId,
        rulesBuildId: definition.rulesBuildId,
        seed,
        state: state(),
        bank,
        ticks,
        revision,
        eventSequence,
        lastCommandSequence,
        events: structuredClone(events),
        held: { ...held },
        interact,
        ...(pendingJump ? { pendingJump: true } : {}),
      };
    },
    restore(value: unknown) {
      const v = value as ReturnType<typeof this.snapshot>;
      if (
        !v ||
        v.kind !== "platform-journey" ||
        v.version !== 1 ||
        v.contentId !== definition.contentId ||
        v.rulesBuildId !== definition.rulesBuildId ||
        v.seed !== seed ||
        (v.pendingJump !== undefined && typeof v.pendingJump !== "boolean") ||
        !v.state ||
        !Number.isInteger(v.state.room) ||
        v.state.room < 0 ||
        v.state.room >= definition.rooms.length
      )
        throw new Error("Incompatible platform journey checkpoint");
      const saved = v.state;
      room = saved.room;
      resetRoom();
      elapsed = saved.elapsed;
      deaths = saved.deaths;
      tokens = saved.tokens;
      flow = saved.flow;
      checkpoint = saved.checkpoint;
      best = saved.best;
      air = saved.air;
      landings = saved.landings;
      won = saved.won;
      lever = saved.lever;
      lastLandingX = saved.lastLandingX;
      if (lever)
        world.definitions = {
          ...world.definitions,
          levels: world.definitions.levels.map((l) => ({
            ...l,
            platforms: l.platforms.map((p) => ({
              ...p,
              speed: definition.rooms[room]!.signal!.speed * U,
            })),
          })),
        };
      checkpointBytes = saved.checkpointBytes;
      collected.clear();
      for (const key of saved.collected) collected.add(key);
      restoreWorld(saved.world);
      bank = v.bank;
      ticks = v.ticks;
      revision = v.revision;
      eventSequence = v.eventSequence;
      lastCommandSequence = v.lastCommandSequence;
      events = structuredClone(v.events);
      held = { ...v.held };
      interact = v.interact;
      pendingJump = v.pendingJump ?? false;
    },
  };
}
export type PlatformJourneyObservation = ReturnType<
  ReturnType<typeof createJourney>["observe"]
>;
/** Bounded side-view journey orchestration over the existing platform physics owner. */
export class PlatformJourneySession {
  private owner: ReturnType<typeof createJourney>;
  private readonly definition: PlatformJourneyDefinition;
  private readonly seed: number;
  constructor(definition: PlatformJourneyDefinition, seed: number) {
    const l = definition.layout;
    if (
      l.unitsPerPixel !== 256 ||
      !Number.isFinite(l.width) ||
      !Number.isFinite(l.height) ||
      l.width <= 0 ||
      l.height <= 0 ||
      (l.width / l.tileSize) % 1 !== 0 ||
      (l.height / l.tileSize) % 1 !== 0 ||
      ((l.width / l.tileSize) * l.height) / l.tileSize > 65536 ||
      l.seedShiftSteps < 1 ||
      l.seedShiftSteps > 16 ||
      l.gaps.length > 32 ||
      definition.collectibleXs.length > 128
    )
      throw new Error("Invalid platform journey layout budget");
    if (!definition.rooms.length || definition.rooms.length > 32)
      throw new Error("Invalid journey room budget");
    this.definition = structuredClone(definition);
    this.seed = ((Math.trunc(seed) % 4294967296) + 4294967296) % 4294967296;
    this.owner = createJourney(this.definition, this.seed);
  }
  command(command: PlatformJourneyCommand) {
    return this.owner.command(command);
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
    // Publish only a completely restored owner; nested world validation may throw.
    const candidate = createJourney(this.definition, this.seed);
    candidate.restore(value);
    this.owner = candidate;
  }
  drainEvents() {
    return this.owner.drainEvents();
  }
}
