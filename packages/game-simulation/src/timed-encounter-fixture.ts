import { LootEncounterFixture } from "./loot-encounter-fixture";
import type {
  LootFixtureCheckpoint,
  LootFixtureCommand,
  LootFixtureSeeds,
} from "./loot-encounter-fixture";
import { TIMED_ENCOUNTER_PHASES, validateRunIdentity } from "./time-policy";
import type { RulesCue, TimedEncounterPhase } from "./time-policy";

export const TIMED_FIXTURE_LIMITS = Object.freeze({
  ticks: 120,
  commands: 64,
  // Two reserved resume operations can unwind safety -> tactical -> running.
  operations: 186,
  queue: 4,
  delay: 2,
  days: 365,
  hitStop: 2,
});
export interface TimedFixtureConfiguration {
  readonly runId: string;
  readonly runEpoch: number;
  readonly seeds: LootFixtureSeeds;
}
interface CommandOrder {
  readonly revision: number;
  readonly runEpoch: number;
}
export type TimedFixtureCommand = CommandOrder &
  (
    | { readonly kind: "order"; readonly action: LootFixtureCommand["kind"] }
    | { readonly kind: "device"; readonly held: boolean }
    | {
        readonly kind:
          | "tactical-pause"
          | "safety-pause"
          | "resume"
          | "advance-day";
      }
  );
export interface TimedFixtureOrder {
  readonly id: number;
  readonly action: LootFixtureCommand["kind"];
}
export interface TimedFixtureState {
  tick: number;
  revision: number;
  calendarDay: number;
  mode: "running" | "tactical" | "safety";
  resumeMode: "running" | "tactical";
  held: boolean;
  position: number;
  hitStopTicks: number;
  nextOrderId: number;
  queue: TimedFixtureOrder[];
  pending: { order: TimedFixtureOrder; dueTick: number } | null;
  terrainRevision: number;
  loot: LootFixtureCheckpoint;
  cues: RulesCue[];
  counters: {
    ticks: number;
    phases: number;
    scheduled: number;
    committed: number;
    randomDraws: number;
    motion: number;
    frozenActorTicks: number;
  };
}
export interface TimedFixtureCheckpoint {
  readonly format: "m8a-timed-encounter-v1";
  readonly configuration: TimedFixtureConfiguration;
  readonly state: TimedFixtureState;
  readonly operations: readonly TimedFixtureOperation[];
}
export type TimedFixtureOperation =
  | { readonly kind: "step" }
  | { readonly kind: "command"; readonly command: TimedFixtureCommand };
export interface TimedFixtureStep {
  readonly state: TimedFixtureState;
  readonly phases: readonly TimedEncounterPhase[];
  readonly emitted: readonly RulesCue[];
}

function fields(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw Error("Invalid timed fixture fields");
  return value as Record<string, unknown>;
}
function integer(value: unknown, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > max
  )
    throw Error("Invalid timed fixture integer");
  return value;
}
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function parseCommand(value: unknown): TimedFixtureCommand {
  if (value === null || typeof value !== "object")
    throw Error("Invalid timed fixture command");
  const kind = (value as Record<string, unknown>).kind;
  const source = fields(
    value,
    kind === "order"
      ? ["revision", "runEpoch", "kind", "action"]
      : kind === "device"
        ? ["revision", "runEpoch", "kind", "held"]
        : ["revision", "runEpoch", "kind"],
  );
  const base = {
    revision: integer(source.revision, TIMED_FIXTURE_LIMITS.commands + 2),
    runEpoch: integer(source.runEpoch, 1_000_000),
  };
  if (kind === "order") {
    if (
      source.action !== "scout" &&
      source.action !== "claim" &&
      source.action !== "retreat"
    )
      throw Error("Invalid timed fixture action");
    return { ...base, kind, action: source.action };
  }
  if (kind === "device") {
    if (typeof source.held !== "boolean")
      throw Error("Invalid timed fixture device state");
    return { ...base, kind, held: source.held };
  }
  if (
    kind !== "tactical-pause" &&
    kind !== "safety-pause" &&
    kind !== "resume" &&
    kind !== "advance-day"
  )
    throw Error("Invalid timed fixture command kind");
  return { ...base, kind };
}

/** Bounded canonical plain-data comparison, also rejecting cycles, sparse arrays,
 * unknown prototypes and huge inputs before any semantic replay/publication. */
function canonical(value: unknown): string {
  let nodes = 0;
  function normalize(input: unknown, depth: number): unknown {
    if (++nodes > 8192 || depth > 12)
      throw Error("Timed fixture checkpoint data cap exceeded");
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number")
      return integer(input, Number.MAX_SAFE_INTEGER);
    if (typeof input === "string") {
      if (input.length > 128) throw Error("Timed fixture string cap exceeded");
      return input;
    }
    if (Array.isArray(input)) {
      if (
        input.length > TIMED_FIXTURE_LIMITS.operations ||
        Object.keys(input).length !== input.length
      )
        throw Error("Timed fixture array cap exceeded");
      return Array.from(input, (item) => normalize(item, depth + 1));
    }
    if (
      input === null ||
      typeof input !== "object" ||
      Object.getPrototypeOf(input) !== Object.prototype
    )
      throw Error("Invalid timed fixture checkpoint data");
    const keys = Object.keys(input).sort();
    if (keys.length > 24) throw Error("Timed fixture object cap exceeded");
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (key.length > 64 || key === "__proto__")
        throw Error("Invalid timed fixture checkpoint key");
      result[key] = normalize(
        (input as Record<string, unknown>)[key],
        depth + 1,
      );
    }
    return result;
  }
  return JSON.stringify(normalize(value, 0));
}

export class TimedEncounterFixture {
  private readonly configuration: TimedFixtureConfiguration;
  private state: TimedFixtureState;
  private operations: TimedFixtureOperation[] = [];
  constructor(configuration: TimedFixtureConfiguration) {
    const source = fields(configuration, ["runId", "runEpoch", "seeds"]);
    validateRunIdentity(source.runId, source.runEpoch);
    const loot = new LootEncounterFixture(
      source.seeds as LootFixtureSeeds,
    ).capture();
    this.configuration = {
      runId: source.runId as string,
      runEpoch: source.runEpoch as number,
      seeds: { ...loot.seeds },
    };
    this.state = {
      tick: 0,
      revision: 0,
      calendarDay: 0,
      mode: "running",
      resumeMode: "running",
      held: false,
      position: 0,
      hitStopTicks: 0,
      nextOrderId: 1,
      queue: [],
      pending: null,
      terrainRevision: 0,
      loot,
      cues: [],
      counters: {
        ticks: 0,
        phases: 0,
        scheduled: 0,
        committed: 0,
        randomDraws: 0,
        motion: 0,
        frozenActorTicks: 0,
      },
    };
  }

  private loot(state: TimedFixtureState): LootEncounterFixture {
    const loot = new LootEncounterFixture(this.configuration.seeds);
    loot.restore(state.loot);
    return loot;
  }

  /** Validates against pending work followed by all accepted FIFO orders.
   * Projection consumes only a temporary rules owner, never committed RNG. */
  private validateOrder(
    state: TimedFixtureState,
    action: LootFixtureCommand["kind"],
  ): void {
    const pendingCompletion = state.pending
      ? state.pending.dueTick
      : state.tick;
    if (
      pendingCompletion +
        (state.queue.length + 1) * (TIMED_FIXTURE_LIMITS.delay + 1) >
      TIMED_FIXTURE_LIMITS.ticks
    )
      throw Error("Timed fixture remaining tick budget cannot finish order");
    const projected = this.loot(state);
    const orders = [
      ...(state.pending ? [state.pending.order] : []),
      ...state.queue,
      { id: state.nextOrderId, action },
    ];
    for (const order of orders)
      projected.execute({
        revision: projected.capture().revision,
        kind: order.action,
      });
  }

  command(value: TimedFixtureCommand): TimedFixtureState {
    const command = parseCommand(value);
    if (
      command.runEpoch !== this.configuration.runEpoch ||
      command.revision !== this.state.revision
    )
      throw Error("Stale timed fixture command");
    if (
      (command.kind !== "resume" &&
        this.state.revision >= TIMED_FIXTURE_LIMITS.commands) ||
      this.operations.length === TIMED_FIXTURE_LIMITS.operations
    )
      throw Error("Timed fixture command cap exceeded");
    const staged = copy(this.state);
    if (command.kind === "safety-pause") {
      if (staged.mode === "safety") throw Error("Already safety paused");
      staged.resumeMode = staged.mode;
      staged.mode = "safety";
      staged.held = false;
    } else if (command.kind === "resume") {
      if (staged.mode === "running")
        throw Error("Timed fixture is already running");
      staged.mode = staged.mode === "safety" ? staged.resumeMode : "running";
      staged.resumeMode = staged.mode;
    } else {
      if (staged.mode === "safety")
        throw Error("Safety pause blocks command intake");
      if (command.kind === "tactical-pause") {
        if (staged.mode !== "running") throw Error("Already tactical paused");
        staged.mode = staged.resumeMode = "tactical";
        staged.held = false;
      } else if (command.kind === "order") {
        if (staged.queue.length === TIMED_FIXTURE_LIMITS.queue)
          throw Error("Timed fixture order queue cap exceeded");
        this.validateOrder(staged, command.action);
        staged.queue.push({ id: staged.nextOrderId++, action: command.action });
      } else if (command.kind === "device") {
        if (staged.mode !== "running")
          throw Error("Tactical pause blocks device state");
        staged.held = command.held;
      } else {
        if (staged.calendarDay === TIMED_FIXTURE_LIMITS.days)
          throw Error("Timed fixture calendar cap exceeded");
        staged.calendarDay++;
      }
    }
    staged.revision++;
    this.state = staged;
    this.operations.push({ kind: "command", command });
    return this.observe();
  }

  step(): TimedFixtureStep {
    if (this.state.mode !== "running")
      return { state: this.observe(), phases: [], emitted: [] };
    if (
      this.state.tick === TIMED_FIXTURE_LIMITS.ticks ||
      this.operations.length === TIMED_FIXTURE_LIMITS.operations
    )
      throw Error("Timed fixture tick cap exceeded");
    const staged = copy(this.state);
    const tick = staged.tick + 1;
    // Acceptance/intent boundary: consume at most one FIFO order when idle.
    if (staged.pending === null && staged.queue.length) {
      staged.pending = {
        order: staged.queue.shift()!,
        dueTick: tick + TIMED_FIXTURE_LIMITS.delay,
      };
      staged.counters.scheduled++;
    }
    if (staged.hitStopTicks > 0) {
      staged.hitStopTicks--;
      staged.counters.frozenActorTicks++;
    } else if (staged.held) {
      staged.position++;
      staged.counters.motion++;
    }
    // Collect against the stable pending snapshot, then apply one commit.
    const due =
      staged.pending && staged.pending.dueTick <= tick
        ? staged.pending.order
        : null;
    const emitted: RulesCue[] = [];
    if (due) {
      const loot = this.loot(staged);
      const beforeDraws = staged.loot.random.streams.reduce(
        (count, stream) => count + stream.draws,
        0,
      );
      staged.loot = loot.execute({
        revision: staged.loot.revision,
        kind: due.action,
      });
      staged.counters.randomDraws +=
        staged.loot.random.streams.reduce(
          (count, stream) => count + stream.draws,
          0,
        ) - beforeDraws;
      staged.counters.committed++;
      if (due.action === "claim") {
        staged.terrainRevision++;
        staged.hitStopTicks = TIMED_FIXTURE_LIMITS.hitStop;
      }
      staged.pending = null;
      emitted.push({
        runId: this.configuration.runId,
        runEpoch: this.configuration.runEpoch,
        sequence: staged.cues.length + 1,
        tick,
        kind:
          due.action === "scout"
            ? "encounter"
            : due.action === "claim"
              ? "reward"
              : "retreat",
      });
    }
    staged.tick = tick;
    staged.counters.ticks++;
    staged.counters.phases += TIMED_ENCOUNTER_PHASES.length;
    // Observation precedes cue emission; neither calls out to host effects.
    staged.cues.push(...emitted);
    this.state = staged;
    this.operations.push({ kind: "step" });
    return {
      state: this.observe(),
      phases: [...TIMED_ENCOUNTER_PHASES],
      emitted: copy(emitted),
    };
  }

  observe(): TimedFixtureState {
    return copy(this.state);
  }
  capture(): TimedFixtureCheckpoint {
    return {
      format: "m8a-timed-encounter-v1",
      configuration: copy(this.configuration),
      state: this.observe(),
      operations: copy(this.operations),
    };
  }
  restore(value: unknown): void {
    const normalized = canonical(value);
    const source = fields(value, [
      "format",
      "configuration",
      "state",
      "operations",
    ]);
    if (
      source.format !== "m8a-timed-encounter-v1" ||
      canonical(source.configuration) !== canonical(this.configuration) ||
      !Array.isArray(source.operations) ||
      source.operations.length > TIMED_FIXTURE_LIMITS.operations
    )
      throw Error("Incompatible timed fixture checkpoint");
    const staged = new TimedEncounterFixture(this.configuration);
    for (const value of source.operations) {
      if (value === null || typeof value !== "object")
        throw Error("Invalid timed fixture operation");
      const operation = value as Record<string, unknown>;
      if (operation.kind === "step") {
        fields(value, ["kind"]);
        if (staged.state.mode !== "running")
          throw Error("Paused step cannot enter timed fixture history");
        staged.step();
      } else {
        fields(value, ["kind", "command"]);
        if (operation.kind !== "command")
          throw Error("Invalid timed fixture operation kind");
        staged.command(parseCommand(operation.command));
      }
    }
    if (normalized !== canonical(staged.capture()))
      throw Error("Inconsistent timed fixture checkpoint");
    this.state = staged.state;
    this.operations = staged.operations;
  }
}
