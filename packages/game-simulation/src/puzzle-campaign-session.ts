import {
  applyGridCommand,
  createGrid,
  gridWon,
  restoreGridCheckpoint,
  serializeGridCheckpoint,
  type GridDefinition,
  type GridDirection,
  type GridState,
  type ProfileIdentity,
} from "./m3/grid";
import { solveGrid, type GridSolution } from "./grid-solver";

export interface PuzzleSeedOffset {
  shift: number;
  /** Number of possible offsets, starting at zero. */
  values: number;
}
export interface PuzzleGridPoint {
  x: number;
  y: number;
  seedX?: PuzzleSeedOffset;
  seedY?: PuzzleSeedOffset;
}
export interface PuzzleGridRecipe {
  width: number;
  height: number;
  walls: readonly { x: number; y: number; width: number; height: number }[];
  player: PuzzleGridPoint;
  crates: readonly PuzzleGridPoint[];
  goals: readonly PuzzleGridPoint[];
  mirrorXSeedBit?: number;
  undoLimit?: number;
}
export interface PuzzleCampaignRoomDefinition {
  id: string;
  grid: PuzzleGridRecipe;
  /** Uses the room's position in the seeded clue order when omitted. */
  clueIndex?: number;
}
export interface PuzzleCampaignClue {
  id: string;
  name: string;
  symbol: string;
  text: string;
}
export interface PuzzleCampaignDefinition {
  identity: ProfileIdentity;
  rooms: readonly PuzzleCampaignRoomDefinition[];
  clues: readonly PuzzleCampaignClue[];
  clueOrder?: { seedShiftStride: number; values: number };
  moveInterval: number;
  discoveryDistance: number;
  solver: { minPushes: number; maxPushes: number; maxVisited?: number };
  fallback?: {
    seed: number;
    /** Last resort after both requested and fallback seed recipes fail. */
    rooms?: readonly PuzzleCampaignRoomDefinition[];
  };
}
export type PuzzleCampaignStatus =
  | "ready"
  | "tutorial"
  | "return-to-hub"
  | "hub"
  | "entered-room"
  | "choose-room"
  | "hub-locked"
  | "won"
  | "reset"
  | "room-locked"
  | "approach-plaque"
  | "clue"
  | "activated"
  | "solve-room";
export type PuzzleCampaignCommand =
  | { kind: "cancel"; sequence?: never; revision?: never }
  | ((
      | { kind: "enter-room"; room: number }
      | { kind: "move"; direction: GridDirection }
      | {
          kind: "hub" | "interact" | "clue" | "activate-hub" | "undo" | "reset";
        }
    ) & { sequence?: number; revision?: number });
export interface PuzzleCampaignEvent {
  sequence: number;
  tick: number;
  sourceId: string;
  kind:
    | "room-entered"
    | "hub-entered"
    | "clue"
    | "activated"
    | "reset"
    | "undo"
    | "move"
    | "win";
  room: number;
  clueIndex?: number;
  direction?: GridDirection;
  from?: number;
  to?: number;
  cratesBefore?: readonly number[];
  cratesAfter?: readonly number[];
}
export interface PuzzleCampaignRoomObservation {
  id: string;
  grid: GridState;
  discovered: boolean;
  active: boolean;
  clueIndex: number;
  solution: GridSolution;
}
export interface PuzzleCampaignObservation {
  requestedSeed: number;
  effectiveSeed: number;
  room: number;
  rooms: readonly PuzzleCampaignRoomObservation[];
  won: boolean;
  clock: number;
  cooldown: number;
  status: PuzzleCampaignStatus;
  revision: number;
  sequence: number;
  tick: number;
}
export interface PuzzleCampaignSnapshot {
  version: 2;
  kind: "puzzle-campaign";
  identity: ProfileIdentity;
  requestedSeed: number;
  effectiveSeed: number;
  room: number;
  discovered: boolean[];
  active: boolean[];
  won: boolean;
  clock: number;
  cooldown: number;
  status: PuzzleCampaignStatus;
  revision: number;
  sequence: number;
  tick: number;
  eventSequence: number;
  pendingEvents: PuzzleCampaignEvent[];
  rooms: string[];
}

function integer(
  value: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    throw Error("Invalid puzzle campaign integer");
}
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function seedValue(seed: number, offset: PuzzleSeedOffset): number {
  integer(offset.shift, 0, 31);
  integer(offset.values, 1, 256);
  const unsigned = ((seed % 4294967296) + 4294967296) % 4294967296;
  return Math.floor(unsigned / 2 ** offset.shift) % offset.values;
}
/** Rectangles, seeded offsets and mirroring are evaluated inside the simulation. */
function generateGrid(
  room: PuzzleCampaignRoomDefinition,
  seed: number,
): GridDefinition {
  const recipe = room.grid;
  const mirror =
    recipe.mirrorXSeedBit !== undefined &&
    seedValue(seed, { shift: recipe.mirrorXSeedBit, values: 2 }) !== 0;
  const cell = (x: number, y: number) =>
    y * recipe.width + (mirror ? recipe.width - 1 - x : x);
  const point = (p: PuzzleGridPoint) => {
    const x = p.x + (p.seedX ? seedValue(seed, p.seedX) : 0);
    const y = p.y + (p.seedY ? seedValue(seed, p.seedY) : 0);
    integer(x, 0, recipe.width - 1);
    integer(y, 0, recipe.height - 1);
    return cell(x, y);
  };
  integer(recipe.width, 2, 64);
  integer(recipe.height, 2, 64);
  const walls = new Set<number>();
  for (const rect of recipe.walls) {
    integer(rect.x, 0, recipe.width - 1);
    integer(rect.y, 0, recipe.height - 1);
    integer(rect.width, 1, recipe.width - rect.x);
    integer(rect.height, 1, recipe.height - rect.y);
    for (let y = rect.y; y < rect.y + rect.height; y++)
      for (let x = rect.x; x < rect.x + rect.width; x++) walls.add(cell(x, y));
  }
  return {
    id: room.id,
    width: recipe.width,
    height: recipe.height,
    walls: [...walls].sort((a, b) => a - b),
    start: point(recipe.player),
    crates: recipe.crates.map(point),
    goals: recipe.goals.map(point),
    undoLimit: recipe.undoLimit,
  };
}

/** A bounded, renderer-independent campaign over the exact grid command owner. */
export class PuzzleCampaignSession {
  readonly requestedSeed: number;
  readonly effectiveSeed: number;
  private readonly definition: PuzzleCampaignDefinition;
  private readonly roomDefinitions: readonly PuzzleCampaignRoomDefinition[];
  private readonly grids: GridDefinition[];
  private readonly solutions: GridSolution[];
  private readonly clueIndices: number[];
  private rooms: GridState[];
  private room = -1;
  private discovered: boolean[];
  private active: boolean[];
  private won = false;
  private clock = 0;
  private cooldown = 0;
  private status: PuzzleCampaignStatus;
  private revision = 0;
  private sequence = 0;
  private tick = 0;
  private eventSequence = 0;
  private events: PuzzleCampaignEvent[] = [];

  constructor(definition: PuzzleCampaignDefinition, requestedSeed: number) {
    integer(requestedSeed, -2147483648, 4294967295);
    if (
      definition.rooms.length < 1 ||
      definition.rooms.length > 32 ||
      definition.clues.length < definition.rooms.length ||
      definition.clues.length > 32 ||
      new Set(definition.rooms.map((r) => r.id)).size !==
        definition.rooms.length ||
      !Number.isFinite(definition.moveInterval) ||
      definition.moveInterval < 0 ||
      definition.moveInterval > 10
    )
      throw Error("Invalid puzzle campaign definition");
    integer(definition.discoveryDistance, 0, 128);
    integer(definition.solver.minPushes, 0);
    integer(definition.solver.maxPushes, definition.solver.minPushes);
    if (definition.solver.maxVisited !== undefined)
      integer(definition.solver.maxVisited, 1, 50000);
    if (definition.fallback)
      integer(definition.fallback.seed, -2147483648, 4294967295);
    this.definition = freeze(copy(definition));
    this.requestedSeed = requestedSeed;
    const generate = (
      seed: number,
      definitions: readonly PuzzleCampaignRoomDefinition[],
    ) => {
      if (
        definitions.length !== definition.rooms.length ||
        definitions.some((r, i) => r.id !== definition.rooms[i].id)
      )
        throw Error("Puzzle fallback room identity mismatch");
      try {
        const grids = definitions.map((r) => generateGrid(r, seed));
        const solutions = grids.map((g) =>
          solveGrid(g, definition.solver.maxVisited),
        );
        const valid = solutions.every(
          (s) =>
            s.status === "solved" &&
            s.pushes >= definition.solver.minPushes &&
            s.pushes <= definition.solver.maxPushes,
        );
        return { grids, solutions, valid, definitions, seed };
      } catch {
        // A seed may place an otherwise valid recipe on a wall or outside bounds.
        // Such a generated layout follows the same bounded fallback as no solution.
        return {
          grids: [] as GridDefinition[],
          solutions: [] as GridSolution[],
          valid: false,
          definitions,
          seed,
        };
      }
    };
    let generated = generate(requestedSeed, this.definition.rooms);
    if (!generated.valid && this.definition.fallback) {
      const fallback = this.definition.fallback;
      if (requestedSeed !== fallback.seed)
        generated = generate(fallback.seed, this.definition.rooms);
      if (!generated.valid && fallback.rooms)
        generated = generate(fallback.seed, fallback.rooms);
    }
    if (!generated.valid)
      throw Error(
        "Puzzle campaign has no valid layout within its solver budget",
      );
    this.effectiveSeed = generated.seed;
    this.roomDefinitions = generated.definitions;
    this.grids = generated.grids;
    this.solutions = generated.solutions;
    const order = this.definition.clues.map((_, i) => i);
    const orderRecipe = this.definition.clueOrder;
    if (orderRecipe) {
      integer(orderRecipe.seedShiftStride, 0, 31);
      order.sort(
        (a, b) =>
          seedValue(this.effectiveSeed, {
            shift: a * orderRecipe.seedShiftStride,
            values: orderRecipe.values,
          }) -
            seedValue(this.effectiveSeed, {
              shift: b * orderRecipe.seedShiftStride,
              values: orderRecipe.values,
            }) || a - b,
      );
    }
    this.clueIndices = this.roomDefinitions.map(
      (r, i) => r.clueIndex ?? order[i],
    );
    for (const index of this.clueIndices)
      integer(index, 0, definition.clues.length - 1);
    this.rooms = this.grids.map(createGrid);
    this.discovered = this.rooms.map(() => false);
    this.active = this.rooms.map(() => false);
    this.status =
      this.effectiveSeed === this.definition.fallback?.seed
        ? "tutorial"
        : "ready";
  }

  private identity(index: number): ProfileIdentity {
    return {
      ...this.definition.identity,
      contentId: `${this.definition.identity.contentId}:${this.effectiveSeed}:${index}`,
    };
  }
  private emit(
    kind: PuzzleCampaignEvent["kind"],
    extra: Partial<PuzzleCampaignEvent> = {},
  ): void {
    this.events.push({
      ...extra,
      kind,
      sequence: ++this.eventSequence,
      tick: this.tick,
      sourceId:
        this.room < 0
          ? this.definition.identity.contentId
          : this.rooms[this.room].definition.id,
      room: this.room,
    });
  }
  command(command: PuzzleCampaignCommand): { ok: boolean; error?: string } {
    // Cancellation is out of band: it never consumes an ordered command or time.
    if (command.kind === "cancel") {
      if (command.sequence !== undefined || command.revision !== undefined)
        return {
          ok: false,
          error: "Cancellation cannot carry command counters",
        };
      this.cooldown = 0;
      return { ok: true };
    }
    if (
      (command.sequence !== undefined &&
        command.sequence !== this.sequence + 1) ||
      (command.revision !== undefined && command.revision !== this.revision)
    )
      return { ok: false, error: "Stale or unordered puzzle command" };
    if (this.won) return { ok: false, error: "Campaign complete" };
    if (this.events.length >= 256)
      return {
        ok: false,
        error: "Drain campaign events before sending more commands",
      };
    if (command.kind === "enter-room") {
      if (
        !Number.isInteger(command.room) ||
        command.room < 0 ||
        command.room >= this.rooms.length
      )
        return { ok: false, error: "Unknown room" };
      this.room = command.room;
      this.status = "entered-room";
      this.emit("room-entered");
    } else if (command.kind === "hub") {
      this.room = -1;
      this.status = "hub";
      this.emit("hub-entered");
    } else if (command.kind === "activate-hub" && this.room >= 0)
      this.status = "return-to-hub";
    else if (this.room < 0) {
      if (command.kind !== "interact" && command.kind !== "activate-hub")
        this.status = "choose-room";
      else if (this.active.every(Boolean)) {
        this.won = true;
        this.status = "won";
        this.emit("win");
      } else this.status = "hub-locked";
    } else if (command.kind === "reset") {
      this.rooms[this.room] = createGrid(this.grids[this.room]);
      this.active[this.room] = false;
      this.status = "reset";
      this.emit("reset");
    } else if (command.kind === "undo" || command.kind === "move") {
      if (this.active[this.room]) this.status = "room-locked";
      else if (command.kind === "move" && this.cooldown > 0)
        return { ok: false, error: "Move cooling down" };
      else {
        const before = this.rooms[this.room];
        const gridCommand =
          command.kind === "move"
            ? {
                kind: "move" as const,
                direction: command.direction,
                sequence: before.sequence + 1,
                revision: before.revision,
              }
            : {
                kind: "undo" as const,
                sequence: before.sequence + 1,
                revision: before.revision,
              };
        const result = applyGridCommand(before, gridCommand);
        if (command.kind === "move")
          this.cooldown = this.definition.moveInterval;
        if (result.ok) {
          this.rooms[this.room] = result.state;
          this.emit(command.kind, {
            direction: command.kind === "move" ? command.direction : undefined,
            from: before.position.player,
            to: result.state.position.player,
            cratesBefore: [...before.position.crates],
            cratesAfter: [...result.state.position.crates],
          });
        }
      }
    } else if (command.kind === "clue" || command.kind === "interact") {
      const state = this.rooms[this.room];
      if (!this.discovered[this.room] || command.kind === "clue") {
        const p = state.position.player,
          c = state.definition.start,
          width = state.definition.width;
        const distance =
          Math.abs((p % width) - (c % width)) +
          Math.abs(Math.floor(p / width) - Math.floor(c / width));
        if (
          !this.discovered[this.room] &&
          distance > this.definition.discoveryDistance
        )
          this.status = "approach-plaque";
        else {
          this.discovered[this.room] = true;
          this.status = "clue";
          this.emit("clue", { clueIndex: this.clueIndices[this.room] });
        }
      } else if (gridWon(state)) {
        if (!this.active[this.room]) {
          this.active[this.room] = true;
          this.emit("activated");
        }
        this.status = "activated";
      } else {
        this.status = "solve-room";
        this.emit("clue", { clueIndex: this.clueIndices[this.room] });
      }
    } else return { ok: false, error: "Unknown campaign command" };
    this.sequence++;
    this.revision++;
    return { ok: true };
  }
  step(dt: number): void {
    if (!Number.isFinite(dt) || dt < 0 || dt > 1)
      throw Error("Invalid puzzle campaign timestep");
    if (this.won || dt === 0) return;
    this.tick++;
    this.clock += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
  }
  observe(): PuzzleCampaignObservation {
    return freeze(
      copy({
        requestedSeed: this.requestedSeed,
        effectiveSeed: this.effectiveSeed,
        room: this.room,
        rooms: this.rooms.map((grid, i) => ({
          id: this.roomDefinitions[i].id,
          grid,
          discovered: this.discovered[i],
          active: this.active[i],
          clueIndex: this.clueIndices[i],
          solution: this.solutions[i],
        })),
        won: this.won,
        clock: this.clock,
        cooldown: this.cooldown,
        status: this.status,
        revision: this.revision,
        sequence: this.sequence,
        tick: this.tick,
      }),
    );
  }
  snapshot(): PuzzleCampaignSnapshot {
    return copy({
      version: 2,
      kind: "puzzle-campaign",
      identity: this.definition.identity,
      requestedSeed: this.requestedSeed,
      effectiveSeed: this.effectiveSeed,
      room: this.room,
      discovered: this.discovered,
      active: this.active,
      won: this.won,
      clock: this.clock,
      cooldown: this.cooldown,
      status: this.status,
      revision: this.revision,
      sequence: this.sequence,
      tick: this.tick,
      eventSequence: this.eventSequence,
      pendingEvents: this.events,
      rooms: this.rooms.map((r, i) =>
        serializeGridCheckpoint(r, this.identity(i)),
      ),
    });
  }
  restore(value: unknown): void {
    const v = value as PuzzleCampaignSnapshot;
    if (
      !v ||
      v.version !== 2 ||
      v.kind !== "puzzle-campaign" ||
      v.identity?.gameId !== this.definition.identity.gameId ||
      v.identity?.rulesBuildId !== this.definition.identity.rulesBuildId ||
      v.identity?.contentId !== this.definition.identity.contentId ||
      v.requestedSeed !== this.requestedSeed ||
      v.effectiveSeed !== this.effectiveSeed
    )
      throw Error(
        "Puzzle campaign checkpoint identity or version mismatch; restart required",
      );
    integer(v.room, -1, this.rooms.length - 1);
    for (const n of [v.revision, v.sequence, v.tick, v.eventSequence])
      integer(n, 0);
    if (
      v.revision !== v.sequence ||
      !Number.isFinite(v.clock) ||
      v.clock < 0 ||
      !Number.isFinite(v.cooldown) ||
      v.cooldown < 0 ||
      v.cooldown > this.definition.moveInterval ||
      !Array.isArray(v.rooms) ||
      v.rooms.length !== this.rooms.length ||
      !Array.isArray(v.discovered) ||
      !Array.isArray(v.active) ||
      v.discovered.length !== this.rooms.length ||
      v.active.length !== this.rooms.length ||
      [...v.discovered, ...v.active].some((b) => typeof b !== "boolean") ||
      typeof v.won !== "boolean" ||
      !Array.isArray(v.pendingEvents) ||
      v.pendingEvents.length > 256
    )
      throw Error("Invalid puzzle campaign checkpoint");
    const statuses: PuzzleCampaignStatus[] = [
      "ready",
      "tutorial",
      "return-to-hub",
      "hub",
      "entered-room",
      "choose-room",
      "hub-locked",
      "won",
      "reset",
      "room-locked",
      "approach-plaque",
      "clue",
      "activated",
      "solve-room",
    ];
    if (!statuses.includes(v.status))
      throw Error("Invalid puzzle campaign status");
    const rooms = v.rooms.map((bytes, i) =>
      restoreGridCheckpoint(this.grids[i], this.identity(i), bytes),
    );
    if (
      v.active.some(
        (active, i) => active && (!v.discovered[i] || !gridWon(rooms[i])),
      ) ||
      (v.won &&
        (!v.active.every(Boolean) || v.room !== -1 || v.status !== "won"))
    )
      throw Error("Invalid puzzle campaign activation state");
    let previous = v.eventSequence - v.pendingEvents.length;
    integer(previous, 0);
    const kinds = [
      "room-entered",
      "hub-entered",
      "clue",
      "activated",
      "reset",
      "undo",
      "move",
      "win",
    ];
    for (const event of v.pendingEvents) {
      if (
        !event ||
        event.sequence !== ++previous ||
        event.tick > v.tick ||
        !kinds.includes(event.kind) ||
        typeof event.sourceId !== "string"
      )
        throw Error("Invalid puzzle campaign event cursor");
      integer(event.tick, 0);
      integer(event.room, -1, this.rooms.length - 1);
    }
    this.rooms = rooms;
    this.room = v.room;
    this.discovered = [...v.discovered];
    this.active = [...v.active];
    this.won = v.won;
    this.clock = v.clock;
    this.cooldown = v.cooldown;
    this.status = v.status;
    this.revision = v.revision;
    this.sequence = v.sequence;
    this.tick = v.tick;
    this.eventSequence = v.eventSequence;
    this.events = copy(v.pendingEvents);
  }
  drainEvents(): readonly PuzzleCampaignEvent[] {
    const events = this.events;
    this.events = [];
    return freeze(events);
  }
}
