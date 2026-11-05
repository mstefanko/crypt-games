import { DeterministicRandom, type RandomSnapshot } from "./rng";

/** First M8b consumer contract. A finite proof session, not a campaign save format. */
export const TRANSACTION_LIMITS = Object.freeze({
  resources: 32,
  stats: 16,
  flags: 64,
  outcomes: 64,
  operations: 16,
  receipts: 16,
  commits: 256,
  quantity: 1_000_000,
});
export interface TransactionResource {
  readonly id: string;
  readonly initial: number;
  readonly capacity: number;
}
export interface TransactionStat {
  readonly id: string;
  readonly initial: number;
  readonly min: number;
  readonly max: number;
}
export interface TransactionDefinition {
  readonly id: string;
  readonly resources: readonly TransactionResource[];
  readonly stats: readonly TransactionStat[];
  readonly flags: readonly string[];
  readonly outcomes: readonly string[];
  readonly rewardSeed: number;
}
export type TransactionOperation =
  | {
      readonly kind: "consume" | "grant";
      readonly resource: string;
      readonly amount: number;
    }
  | {
      readonly kind: "reward";
      readonly resource: string;
      readonly min: number;
      readonly max: number;
    }
  | { readonly kind: "stat"; readonly stat: string; readonly delta: number }
  | { readonly kind: "flag"; readonly flag: string; readonly value: boolean };
export interface TransactionCommand {
  readonly id: string;
  readonly revision: number;
  readonly outcome: string | null;
  readonly operations: readonly TransactionOperation[];
}
export interface TransactionReceipt {
  readonly id: string;
  readonly revision: number;
  readonly rewards: readonly number[];
}
export interface TransactionCheckpoint {
  readonly format: "m8b-transactions-v1";
  readonly definition: TransactionDefinition;
  readonly revision: number;
  readonly resources: readonly {
    readonly id: string;
    readonly quantity: number;
  }[];
  readonly stats: readonly { readonly id: string; readonly value: number }[];
  readonly flags: readonly { readonly id: string; readonly value: boolean }[];
  readonly outcomes: readonly string[];
  readonly receipts: readonly TransactionReceipt[];
  readonly commands: readonly TransactionCommand[];
  readonly random: RandomSnapshot;
}
function fields(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (d) => !Object.hasOwn(d, "value"),
    ) ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw Error("Invalid transaction fields");
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    Object.is(value, -0) ||
    value < min ||
    value > max
  )
    throw Error("Invalid transaction integer");
  return value;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9.-]{0,63}$/.test(value))
    throw Error("Invalid transaction identity");
  return value;
}
function list(value: unknown, max: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1 ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (d) => !Object.hasOwn(d, "value"),
    )
  )
    throw Error("Transaction list cap exceeded");
  return Array.from(value);
}
/** Finite plain-data validation precedes any exact-state comparison or replay. */
function canonical(value: unknown): string {
  let nodes = 0;
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > 100_000 || depth > 12)
      throw Error("Transaction checkpoint work cap");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number")
      return integer(v, -TRANSACTION_LIMITS.quantity, Number.MAX_SAFE_INTEGER);
    if (typeof v === "string" && v.length <= 64) return v;
    if (Array.isArray(v))
      return list(v, TRANSACTION_LIMITS.commits).map((item) =>
        visit(item, depth + 1),
      );
    if (
      !v ||
      typeof v !== "object" ||
      Object.getPrototypeOf(v) !== Object.prototype
    )
      throw Error("Transaction plain data required");
    const keys = Reflect.ownKeys(v);
    if (
      keys.length > 32 ||
      keys.some(
        (key) =>
          typeof key !== "string" || key.length > 64 || key === "__proto__",
      )
    )
      throw Error("Invalid transaction object keys");
    const result: Record<string, unknown> = {};
    for (const key of (keys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
      if (!Object.hasOwn(descriptor, "value"))
        throw Error("Transaction accessor rejected");
      result[key] = visit(descriptor.value, depth + 1);
    }
    return result;
  };
  return JSON.stringify(visit(value, 0));
}
function ordered<T extends { id: string }>(values: T[]): T[] {
  values.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (values.some((entry, i) => i > 0 && entry.id === values[i - 1].id))
    throw Error("Duplicate transaction identity");
  return values;
}
function definition(value: unknown): TransactionDefinition {
  const s = fields(value, [
    "id",
    "resources",
    "stats",
    "flags",
    "outcomes",
    "rewardSeed",
  ]);
  const resources = ordered(
    list(s.resources, TRANSACTION_LIMITS.resources).map((value) => {
      const r = fields(value, ["id", "initial", "capacity"]);
      const capacity = integer(r.capacity, 0, TRANSACTION_LIMITS.quantity);
      return {
        id: id(r.id),
        initial: integer(r.initial, 0, capacity),
        capacity,
      };
    }),
  );
  const stats = ordered(
    list(s.stats, TRANSACTION_LIMITS.stats).map((value) => {
      const r = fields(value, ["id", "initial", "min", "max"]);
      const min = integer(
        r.min,
        -TRANSACTION_LIMITS.quantity,
        TRANSACTION_LIMITS.quantity,
      );
      const max = integer(r.max, min, TRANSACTION_LIMITS.quantity);
      return { id: id(r.id), initial: integer(r.initial, min, max), min, max };
    }),
  );
  const names = (value: unknown, max: number) =>
    ordered(list(value, max).map((value) => ({ id: id(value) }))).map(
      (v) => v.id,
    );
  return {
    id: id(s.id),
    resources,
    stats,
    flags: names(s.flags, TRANSACTION_LIMITS.flags),
    outcomes: names(s.outcomes, TRANSACTION_LIMITS.outcomes),
    rewardSeed: integer(s.rewardSeed, 0, 0xffffffff),
  };
}
function command(value: unknown): TransactionCommand {
  const s = fields(value, ["id", "revision", "outcome", "operations"]);
  const operations = list(s.operations, TRANSACTION_LIMITS.operations).map(
    (value): TransactionOperation => {
      if (!value || typeof value !== "object")
        throw Error("Invalid transaction operation");
      const kind = (value as Record<string, unknown>).kind;
      if (kind === "consume" || kind === "grant") {
        const op = fields(value, ["kind", "resource", "amount"]);
        return {
          kind,
          resource: id(op.resource),
          amount: integer(op.amount, 1, TRANSACTION_LIMITS.quantity),
        };
      }
      if (kind === "reward") {
        const op = fields(value, ["kind", "resource", "min", "max"]);
        const min = integer(op.min, 1, TRANSACTION_LIMITS.quantity);
        return {
          kind,
          resource: id(op.resource),
          min,
          max: integer(op.max, min, TRANSACTION_LIMITS.quantity),
        };
      }
      if (kind === "stat") {
        const op = fields(value, ["kind", "stat", "delta"]);
        return {
          kind,
          stat: id(op.stat),
          delta: integer(
            op.delta,
            -TRANSACTION_LIMITS.quantity,
            TRANSACTION_LIMITS.quantity,
          ),
        };
      }
      if (kind === "flag") {
        const op = fields(value, ["kind", "flag", "value"]);
        if (typeof op.value !== "boolean")
          throw Error("Invalid transaction flag");
        return { kind, flag: id(op.flag), value: op.value };
      }
      throw Error("Unknown transaction operation");
    },
  );
  if (operations.length === 0) throw Error("Empty transaction");
  return {
    id: id(s.id),
    revision: integer(s.revision, 0, TRANSACTION_LIMITS.commits),
    outcome: s.outcome === null ? null : id(s.outcome),
    operations,
  };
}
function random(seed: number) {
  return new DeterministicRandom([
    { name: "rewards", owner: "transactions", seed },
  ]);
}
const copyCommand = (c: TransactionCommand): TransactionCommand => ({
  ...c,
  operations: c.operations.map((o) => ({ ...o })),
});
const copyReceipt = (r: TransactionReceipt): TransactionReceipt => ({
  ...r,
  rewards: [...r.rewards],
});

/** Commands are trusted rule operations; UI callers must use their game's semantic adapter.
 * Each operation observes prior staged operations. Any failure discards the complete batch,
 * including speculative RNG. Recent receipts deduplicate identical requests before revision
 * checking; expired requests reject stale revisions. Declared outcomes never expire. */
export class TransactionOwner {
  private readonly definition: TransactionDefinition;
  private revision = 0;
  private resources: { id: string; quantity: number }[];
  private stats: { id: string; value: number }[];
  private flags: { id: string; value: boolean }[];
  private outcomes: string[] = [];
  private receipts: TransactionReceipt[] = [];
  private commands: TransactionCommand[] = [];
  private random: DeterministicRandom;
  constructor(value: TransactionDefinition) {
    this.definition = definition(value);
    this.resources = this.definition.resources.map((r) => ({
      id: r.id,
      quantity: r.initial,
    }));
    this.stats = this.definition.stats.map((r) => ({
      id: r.id,
      value: r.initial,
    }));
    this.flags = this.definition.flags.map((id) => ({ id, value: false }));
    this.random = random(this.definition.rewardSeed);
  }
  execute(value: TransactionCommand): TransactionReceipt {
    const c = command(value);
    const previous = this.receipts.find((r) => r.id === c.id);
    if (previous) {
      if (
        JSON.stringify(this.commands[previous.revision - 1]) !==
        JSON.stringify(c)
      )
        throw Error("Conflicting transaction retry");
      return copyReceipt(previous);
    }
    if (c.revision !== this.revision) throw Error("Stale transaction revision");
    if (this.revision === TRANSACTION_LIMITS.commits)
      throw Error("Transaction commit cap exceeded");
    if (c.outcome !== null) {
      if (!this.definition.outcomes.includes(c.outcome))
        throw Error("Unknown transaction outcome");
      if (this.outcomes.includes(c.outcome))
        throw Error("Transaction outcome already committed");
    }
    const resources = this.resources.map((r) => ({ ...r }));
    const stats = this.stats.map((r) => ({ ...r }));
    const flags = this.flags.map((r) => ({ ...r }));
    const stagedRandom = random(this.definition.rewardSeed);
    stagedRandom.restore(this.random.capture());
    const rewards: number[] = [];
    for (const op of c.operations) {
      if (op.kind === "stat") {
        const index = stats.findIndex((r) => r.id === op.stat);
        if (index < 0) throw Error("Unknown transaction stat");
        const spec = this.definition.stats[index];
        stats[index].value = integer(
          stats[index].value + op.delta,
          spec.min,
          spec.max,
        );
      } else if (op.kind === "flag") {
        const index = flags.findIndex((r) => r.id === op.flag);
        if (index < 0) throw Error("Unknown transaction flag");
        flags[index].value = op.value;
      } else {
        const index = resources.findIndex((r) => r.id === op.resource);
        if (index < 0) throw Error("Unknown transaction resource");
        const amount =
          op.kind === "reward"
            ? op.min +
              stagedRandom.drawInteger(
                "transactions",
                "rewards",
                op.max - op.min + 1,
              )
            : op.amount;
        if (op.kind === "reward") rewards.push(amount);
        resources[index].quantity = integer(
          resources[index].quantity +
            (op.kind === "consume" ? -amount : amount),
          0,
          this.definition.resources[index].capacity,
        );
      }
    }
    const receipt = { id: c.id, revision: this.revision + 1, rewards };
    this.resources = resources;
    this.stats = stats;
    this.flags = flags;
    this.random = stagedRandom;
    if (c.outcome !== null)
      this.outcomes = [...this.outcomes, c.outcome].sort();
    this.revision++;
    this.commands.push(c);
    this.receipts = [...this.receipts, receipt].slice(
      -TRANSACTION_LIMITS.receipts,
    );
    return copyReceipt(receipt);
  }
  capture(): TransactionCheckpoint {
    return {
      format: "m8b-transactions-v1",
      definition: definition(this.definition),
      revision: this.revision,
      resources: this.resources.map((r) => ({ ...r })),
      stats: this.stats.map((r) => ({ ...r })),
      flags: this.flags.map((r) => ({ ...r })),
      outcomes: [...this.outcomes],
      receipts: this.receipts.map(copyReceipt),
      commands: this.commands.map(copyCommand),
      random: this.random.capture(),
    };
  }
  /** Replay at most 256 commits into a temporary owner. Exact comparison rejects
   * forged balances, missing guards/receipts, RNG changes and incompatible definitions. */
  restore(value: unknown): void {
    const normalized = canonical(value);
    const s = fields(value, [
      "format",
      "definition",
      "revision",
      "resources",
      "stats",
      "flags",
      "outcomes",
      "receipts",
      "commands",
      "random",
    ]);
    if (
      s.format !== "m8b-transactions-v1" ||
      canonical(s.definition) !== canonical(this.definition)
    )
      throw Error("Incompatible transaction checkpoint");
    const revision = integer(s.revision, 0, TRANSACTION_LIMITS.commits);
    const history = list(s.commands, TRANSACTION_LIMITS.commits);
    if (history.length !== revision) throw Error("Invalid transaction history");
    // Bound all externally supplied arrays before comparing the canonical result.
    list(s.resources, TRANSACTION_LIMITS.resources);
    list(s.stats, TRANSACTION_LIMITS.stats);
    list(s.flags, TRANSACTION_LIMITS.flags);
    list(s.outcomes, TRANSACTION_LIMITS.outcomes);
    list(s.receipts, TRANSACTION_LIMITS.receipts);
    const staged = new TransactionOwner(this.definition);
    for (const item of history) staged.execute(command(item));
    const exact = staged.capture();
    if (normalized !== canonical(exact))
      throw Error("Inconsistent transaction checkpoint");
    this.revision = staged.revision;
    this.resources = staged.resources;
    this.stats = staged.stats;
    this.flags = staged.flags;
    this.outcomes = staged.outcomes;
    this.receipts = staged.receipts;
    this.commands = staged.commands;
    this.random = staged.random;
  }
}
