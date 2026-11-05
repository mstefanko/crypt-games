import { describe, expect, it } from "vitest";
import {
  TransactionOwner,
  TRANSACTION_LIMITS,
  type TransactionCommand,
} from "./transactions";
import {
  createTransactionFixture,
  transactionFixtureCommand,
  TRANSACTION_FIXTURE_DEFINITION,
} from "./transaction-fixture";
const action = (
  owner: TransactionOwner,
  kind: "buy" | "drink" | "unlock" | "chest",
  id = `request-${owner.capture().revision}`,
) =>
  owner.execute(transactionFixtureCommand(kind, id, owner.capture().revision));
const noop = (revision: number): TransactionCommand => ({
  id: `noop-${revision}`,
  revision,
  outcome: null,
  operations: [{ kind: "flag", flag: "dash", value: false }],
});
describe("M8b atomic transaction core", () => {
  it("commits purchase/consumption/ability/reward together and resumes exactly", () => {
    const a = createTransactionFixture();
    action(a, "buy");
    action(a, "drink");
    action(a, "unlock");
    const b = createTransactionFixture();
    b.restore(a.capture());
    expect(action(a, "chest")).toEqual(action(b, "chest"));
    expect(a.capture()).toEqual(b.capture());
    expect(a.capture().stats).toEqual([{ id: "health", value: 8 }]);
    expect(a.capture().flags).toEqual([{ id: "dash", value: true }]);
  });
  it("rolls back earlier consumption when a later stat/capacity operation fails", () => {
    const a = createTransactionFixture();
    action(a, "buy");
    action(a, "drink");
    action(a, "buy");
    const before = a.capture();
    expect(() => action(a, "drink")).toThrow();
    expect(a.capture()).toEqual(before);
    const b = new TransactionOwner({
      ...TRANSACTION_FIXTURE_DEFINITION,
      resources: [
        { id: "coins", initial: 10, capacity: 100 },
        { id: "potions", initial: 3, capacity: 3 },
      ],
    });
    const full = b.capture();
    expect(() => action(b, "buy")).toThrow();
    expect(b.capture()).toEqual(full);
  });
  it("leaves RNG and all state unchanged on rejection after a reward draw", () => {
    const a = createTransactionFixture(),
      before = a.capture();
    expect(() =>
      a.execute({
        id: "bad-reward",
        revision: 0,
        outcome: "first-chest",
        operations: [
          { kind: "reward", resource: "coins", min: 1, max: 4 },
          { kind: "consume", resource: "potions", amount: 1 },
        ],
      }),
    ).toThrow();
    expect(a.capture()).toEqual(before);
    expect(action(a, "chest")).toEqual(
      action(createTransactionFixture(), "chest"),
    );
  });
  it("retries exact recent commands once and rejects conflicts/stale writes", () => {
    const a = createTransactionFixture(),
      c = transactionFixtureCommand("buy", "purchase", 0);
    const receipt = a.execute(c),
      before = a.capture();
    expect(a.execute(c)).toEqual(receipt);
    expect(a.capture()).toEqual(before);
    expect(() =>
      a.execute({
        ...c,
        operations: [{ kind: "grant", resource: "coins", amount: 9 }],
      }),
    ).toThrow(/Conflicting/);
    expect(() => a.execute({ ...c, id: "stale" })).toThrow(/Stale/);
    expect(a.capture()).toEqual(before);
  });
  it("keeps permanent outcomes after retry receipt eviction", () => {
    const a = createTransactionFixture();
    action(a, "chest", "chest-request");
    for (let i = 1; i <= TRANSACTION_LIMITS.receipts; i++) a.execute(noop(i));
    const before = a.capture();
    expect(before.receipts.some((r) => r.id === "chest-request")).toBe(false);
    expect(() =>
      a.execute(transactionFixtureCommand("chest", "chest-request", 0)),
    ).toThrow(/Stale/);
    expect(() => action(a, "chest", "another-id")).toThrow(/already committed/);
    expect(a.capture()).toEqual(before);
    const b = createTransactionFixture();
    b.restore(before);
    expect(b.capture()).toEqual(before);
  });
  it("rejects impossible exact snapshots atomically", () => {
    const a = createTransactionFixture();
    action(a, "buy");
    action(a, "chest");
    const before = a.capture();
    const variants = [
      (v: any) => v.resources[0].quantity++,
      (v: any) => v.outcomes.pop(),
      (v: any) => v.random.streams[0].draws++,
      (v: any) => v.receipts.pop(),
      (v: any) => v.commands[0].operations[0].amount++,
      (v: any) => (v.definition.id = "other"),
      (v: any) => v.revision++,
      (v: any) => v.flags.push({ id: "unknown", value: true }),
      (v: any) => (v.extra = true),
      (v: any) => (v.resources[0].extra = undefined),
      (v: any) => (v.resources[0][Symbol("hidden")] = true),
      (v: any) => (v.resources.extra = true),
      (v: any) => (v.resources[0] = { toJSON: () => before.resources[0] }),
      (v: any) => (v.commands[0].revision = -0),
      (v: any) => Object.defineProperty(v.resources[0], "hidden", { value: 1 }),
    ];
    for (const mutate of variants) {
      const bad = structuredClone(before);
      mutate(bad);
      expect(() => a.restore(bad)).toThrow();
      expect(a.capture()).toEqual(before);
    }
  });
  it("detaches definitions, commands, receipts and observations", () => {
    const def = structuredClone(TRANSACTION_FIXTURE_DEFINITION) as any;
    const a = new TransactionOwner(def);
    def.resources[0].capacity = 0;
    const c = transactionFixtureCommand("chest", "chest", 0) as any;
    const receipt = a.execute(c) as any;
    c.operations[0].max = 999;
    receipt.rewards[0] = 999;
    const observed = a.capture() as any;
    observed.commands[0].operations[0].min = 100;
    const b = createTransactionFixture();
    b.restore(a.capture());
    expect(b.capture()).toEqual(a.capture());
  });
  it("rejects invalid references, bounds, empty/unknown operations and oversized requests", () => {
    const a = createTransactionFixture(),
      before = a.capture();
    for (const operations of [
      [],
      [{ kind: "grant", resource: "missing", amount: 1 }],
      [{ kind: "grant", resource: "coins", amount: -1 }],
      [{ kind: "stat", stat: "missing", delta: 1 }],
      [{ kind: "flag", flag: "missing", value: true }],
      [{ kind: "unknown" }],
      Array.from({ length: 17 }, () => ({
        kind: "grant",
        resource: "coins",
        amount: 1,
      })),
    ]) {
      expect(() =>
        a.execute({ id: "bad", revision: 0, outcome: null, operations } as any),
      ).toThrow();
      expect(a.capture()).toEqual(before);
    }
  });
  it("bounds history work and rejects beyond the finite proof session", () => {
    const a = createTransactionFixture();
    for (let i = 0; i < TRANSACTION_LIMITS.commits; i++) a.execute(noop(i));
    const before = a.capture();
    expect(() => a.execute(noop(TRANSACTION_LIMITS.commits))).toThrow(/cap/);
    const b = createTransactionFixture();
    b.restore(before);
    expect(b.capture()).toEqual(before);
  });
});
