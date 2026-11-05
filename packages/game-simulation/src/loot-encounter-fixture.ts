import { DeterministicRandom } from "./rng";
import type { RandomSnapshot } from "./rng";

export const LOOT_FIXTURE_LIMITS = Object.freeze({
  rounds: 8,
  commands: 16,
  coins: 20,
  health: 24,
});
export interface LootFixtureSeeds {
  readonly encounter: number;
  readonly loot: number;
}
export type LootFixtureCommand = {
  readonly revision: number;
  readonly kind: "scout" | "claim" | "retreat";
};
export interface LootEncounter {
  readonly id: number;
  readonly kind: "slime" | "bandit" | "wisp";
}
export interface LootFixtureCheckpoint {
  readonly format: "m8a-loot-encounter-v1";
  readonly seeds: LootFixtureSeeds;
  readonly revision: number;
  readonly rounds: number;
  readonly coins: number;
  readonly health: number;
  readonly encounter: LootEncounter | null;
  readonly commands: readonly LootFixtureCommand[];
  readonly random: RandomSnapshot;
}
const enemies = ["slime", "bandit", "wisp"] as const;
const damage = { slime: 1, bandit: 3, wisp: 2 } as const;
const ENCOUNTER_OWNER = "fixture.encounter";
const LOOT_OWNER = "fixture.loot";

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
    throw Error("Invalid loot fixture fields");
  return value as Record<string, unknown>;
}
function bounded(value: unknown, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > max
  )
    throw Error("Invalid loot fixture integer");
  return value;
}
function seeds(value: unknown): LootFixtureSeeds {
  const source = fields(value, ["encounter", "loot"]);
  return {
    encounter: bounded(source.encounter, 0xffffffff),
    loot: bounded(source.loot, 0xffffffff),
  };
}
function command(value: unknown): LootFixtureCommand {
  const source = fields(value, ["revision", "kind"]);
  if (
    source.kind !== "scout" &&
    source.kind !== "claim" &&
    source.kind !== "retreat"
  )
    throw Error("Invalid loot fixture command");
  return {
    revision: bounded(source.revision, LOOT_FIXTURE_LIMITS.commands),
    kind: source.kind,
  };
}
function random(seeds: LootFixtureSeeds): DeterministicRandom {
  return new DeterministicRandom([
    { name: "encounter", owner: ENCOUNTER_OWNER, seed: seeds.encounter },
    { name: "loot", owner: LOOT_OWNER, seed: seeds.loot },
  ]);
}

/** Bounded command-driven proof, with real encounter selection, damage and loot.
 * There is no render callback or ambient time/entropy path into authority. */
export class LootEncounterFixture {
  private readonly seeds: LootFixtureSeeds;
  private random: DeterministicRandom;
  private revision = 0;
  private rounds = 0;
  private coins = 0;
  private health: number = LOOT_FIXTURE_LIMITS.health;
  private encounter: LootEncounter | null = null;
  private commands: LootFixtureCommand[] = [];

  constructor(initialSeeds: LootFixtureSeeds) {
    this.seeds = seeds(initialSeeds);
    this.random = random(this.seeds);
  }

  execute(value: LootFixtureCommand): LootFixtureCheckpoint {
    const accepted = command(value);
    if (accepted.revision !== this.revision)
      throw Error("Stale loot fixture revision");
    if (this.revision === LOOT_FIXTURE_LIMITS.commands)
      throw Error("Loot fixture command cap exceeded");
    const stagedRandom = random(this.seeds);
    stagedRandom.restore(this.random.capture());
    let encounter = this.encounter,
      rounds = this.rounds,
      coins = this.coins,
      health = this.health;
    if (accepted.kind === "scout") {
      if (encounter !== null) throw Error("Resolve the active encounter first");
      if (rounds === LOOT_FIXTURE_LIMITS.rounds)
        throw Error("Loot fixture round cap exceeded");
      const kind =
        enemies[
          stagedRandom.drawInteger(ENCOUNTER_OWNER, "encounter", enemies.length)
        ];
      rounds++;
      encounter = { id: rounds, kind };
    } else {
      if (encounter === null) throw Error("No active encounter");
      if (accepted.kind === "claim") {
        // A capacity failure deliberately happens after the speculative draw.
        const reward = 1 + stagedRandom.drawInteger(LOOT_OWNER, "loot", 5);
        if (coins + reward > LOOT_FIXTURE_LIMITS.coins)
          throw Error("Loot capacity exceeded");
        if (health < damage[encounter.kind])
          throw Error("Insufficient fixture health");
        coins += reward;
        health -= damage[encounter.kind];
      }
      encounter = null;
    }
    this.random = stagedRandom;
    this.encounter = encounter;
    this.rounds = rounds;
    this.coins = coins;
    this.health = health;
    this.commands.push(accepted);
    this.revision++;
    return this.capture();
  }

  capture(): LootFixtureCheckpoint {
    return {
      format: "m8a-loot-encounter-v1",
      seeds: { ...this.seeds },
      revision: this.revision,
      rounds: this.rounds,
      coins: this.coins,
      health: this.health,
      encounter: this.encounter ? { ...this.encounter } : null,
      commands: this.commands.map((entry) => ({ ...entry })),
      random: this.random.capture(),
    };
  }

  /** Replays at most sixteen accepted commands into a temporary owner, then
   * compares the complete state. Rejects structurally valid impossible rewards,
   * missing draws and forged encounter/history combinations without mutation. */
  restore(value: unknown): void {
    const source = fields(value, [
      "format",
      "seeds",
      "revision",
      "rounds",
      "coins",
      "health",
      "encounter",
      "commands",
      "random",
    ]);
    if (source.format !== "m8a-loot-encounter-v1")
      throw Error("Incompatible loot fixture checkpoint");
    const restoredSeeds = seeds(source.seeds);
    if (
      restoredSeeds.encounter !== this.seeds.encounter ||
      restoredSeeds.loot !== this.seeds.loot
    )
      throw Error("Incompatible loot fixture seeds");
    if (
      !Array.isArray(source.commands) ||
      source.commands.length > LOOT_FIXTURE_LIMITS.commands
    )
      throw Error("Loot fixture command cap exceeded");
    const commands = source.commands.map(command);
    let encounter: LootEncounter | null = null;
    if (source.encounter !== null) {
      const active = fields(source.encounter, ["id", "kind"]);
      if (
        active.kind !== "slime" &&
        active.kind !== "bandit" &&
        active.kind !== "wisp"
      )
        throw Error("Invalid fixture encounter");
      encounter = {
        id: bounded(active.id, LOOT_FIXTURE_LIMITS.rounds),
        kind: active.kind,
      };
    }
    const restoredRandom = random(this.seeds);
    restoredRandom.restore(source.random);
    const parsed: LootFixtureCheckpoint = {
      format: "m8a-loot-encounter-v1",
      seeds: restoredSeeds,
      revision: bounded(source.revision, LOOT_FIXTURE_LIMITS.commands),
      rounds: bounded(source.rounds, LOOT_FIXTURE_LIMITS.rounds),
      coins: bounded(source.coins, LOOT_FIXTURE_LIMITS.coins),
      health: bounded(source.health, LOOT_FIXTURE_LIMITS.health),
      encounter,
      commands,
      random: restoredRandom.capture(),
    };
    const staged = new LootEncounterFixture(this.seeds);
    for (const entry of commands) staged.execute(entry);
    if (JSON.stringify(parsed) !== JSON.stringify(staged.capture()))
      throw Error("Inconsistent loot fixture checkpoint");
    this.random = staged.random;
    this.revision = staged.revision;
    this.rounds = staged.rounds;
    this.coins = staged.coins;
    this.health = staged.health;
    this.encounter = staged.encounter;
    this.commands = staged.commands;
  }
}

export function replayLootFixture(
  initialSeeds: LootFixtureSeeds,
  commands: readonly LootFixtureCommand[],
): LootFixtureCheckpoint {
  if (
    !Array.isArray(commands) ||
    commands.length > LOOT_FIXTURE_LIMITS.commands
  )
    throw Error("Loot fixture replay command cap exceeded");
  const fixture = new LootEncounterFixture(initialSeeds);
  for (const entry of commands) fixture.execute(entry);
  return fixture.capture();
}
