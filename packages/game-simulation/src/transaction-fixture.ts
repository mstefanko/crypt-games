import { TransactionOwner, type TransactionCommand } from "./transactions";

/** Small atomic purchase, consumption, permanent ability and seeded reward consumer. */
export const TRANSACTION_FIXTURE_DEFINITION = {
  id: "market-proof-v1",
  resources: [
    { id: "coins", initial: 10, capacity: 100 },
    { id: "potions", initial: 0, capacity: 3 },
  ],
  stats: [{ id: "health", initial: 5, min: 0, max: 10 }],
  flags: ["dash"],
  outcomes: ["dash-shrine", "first-chest"],
  rewardSeed: 1729,
} as const;
export type TransactionFixtureAction = "buy" | "drink" | "unlock" | "chest";
export const TRANSACTION_FIXTURE_DESCRIPTOR = Object.freeze({
  id: "market-proof-v1",
  actions: ["buy", "drink", "unlock", "chest"],
  observations: [
    "resources",
    "stats",
    "flags",
    "outcomes",
    "receipts",
    "random",
  ],
  scope: "bounded-atomic-transactions; no room/campaign adapter",
});
export function createTransactionFixture(): TransactionOwner {
  return new TransactionOwner(TRANSACTION_FIXTURE_DEFINITION);
}
export function transactionFixtureCommand(
  action: TransactionFixtureAction,
  id: string,
  revision: number,
): TransactionCommand {
  switch (action) {
    case "buy":
      return {
        id,
        revision,
        outcome: null,
        operations: [
          { kind: "consume", resource: "coins", amount: 3 },
          { kind: "grant", resource: "potions", amount: 1 },
        ],
      };
    case "drink":
      return {
        id,
        revision,
        outcome: null,
        operations: [
          { kind: "consume", resource: "potions", amount: 1 },
          { kind: "stat", stat: "health", delta: 3 },
        ],
      };
    case "unlock":
      return {
        id,
        revision,
        outcome: "dash-shrine",
        operations: [
          { kind: "consume", resource: "coins", amount: 2 },
          { kind: "flag", flag: "dash", value: true },
        ],
      };
    case "chest":
      return {
        id,
        revision,
        outcome: "first-chest",
        operations: [{ kind: "reward", resource: "coins", min: 2, max: 7 }],
      };
    default:
      throw Error("Unknown market proof action");
  }
}
