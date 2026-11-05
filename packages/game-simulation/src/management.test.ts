import { describe, expect, it, vi } from "vitest";
import { TransactionOwner } from "./transactions";
import {
  ManagementSession,
  type ManagementAction,
  type ManagementSave,
} from "./management";
const run = (s: ManagementSession, action: ManagementAction) => {
  const revision = s.observe().revision;
  s.execute({ id: `desk-${revision}`, revision, action });
};
function day(s: ManagementSession, ada: "accept" | "reject") {
  for (const [documentId, decision] of [
    ["ada", ada],
    ["bo", "reject"],
    ["cy", "reject"],
  ] as const)
    run(s, { kind: "decide", documentId, decision });
  run(s, { kind: "settle" });
}
describe("M10 document decisions and day settlement", () => {
  it("captures the ledger once per detached observation", () => {
    const session = new ManagementSession();
    const capture = vi.spyOn(TransactionOwner.prototype, "capture");
    try {
      const observation = session.observe();
      expect(capture).toHaveBeenCalledTimes(1);
      observation.decisions.push({
        documentId: "ada",
        decision: "reject",
        correct: false,
      });
      expect(session.observe().decisions).toEqual([]);
    } finally {
      capture.mockRestore();
    }
  });

  it("changes the rule and settles a durable delayed audit exactly after restoration", () => {
    const a = new ManagementSession();
    day(a, "reject"); // one day-one mistake: 9 wages, 8 expenses, 3 delayed audit
    expect(a.observe()).toMatchObject({
      credits: 21,
      pendingAudit: 3,
      settled: true,
    });
    const b = new ManagementSession();
    b.load(a.save());
    for (const s of [a, b]) {
      run(s, { kind: "next-day" });
      day(s, "reject");
    }
    expect(a.save()).toEqual(b.save());
    expect(a.observe()).toMatchObject({
      credits: 22,
      auditCompleted: true,
      complete: true,
    });
    expect(a.save().ledger.outcomes).toContain("day-1-ada");
  });
  it("pays correct decisions, preserves committed decisions and deduplicates retries", () => {
    const s = new ManagementSession();
    const c = {
      id: "first",
      revision: 0,
      action: { kind: "decide", documentId: "ada", decision: "accept" },
    } as const;
    s.execute(c);
    const save = s.save();
    s.execute(c);
    expect(s.save()).toEqual(save);
    const b = new ManagementSession();
    b.load(save);
    b.execute(c);
    expect(b.save()).toEqual(save);
    expect(b.observe().credits).toBe(24);
    const detached = b.save();
    (detached.commands as unknown[]).length = 0;
    expect(b.save()).toEqual(save);
  });
  it("continues at every boundary for all 64 complete decision combinations without deadlock", () => {
    for (let mask = 0; mask < 64; mask++) {
      const s = new ManagementSession();
      let errors = 0,
        dayOneErrors = 0;
      for (let index = 0; index < 6; index++) {
        const documentId = ["ada", "bo", "cy"][index % 3];
        const decision = mask & (1 << index) ? "accept" : "reject";
        const correct =
          index === 0 ? decision === "accept" : decision === "reject";
        if (!correct) {
          errors++;
          if (index < 3) dayOneErrors++;
        }
        const restored = new ManagementSession();
        restored.load(s.save());
        const action = { kind: "decide", documentId, decision } as const;
        run(s, action);
        run(restored, action);
        expect(restored.save()).toEqual(s.save());
        if (index === 2 || index === 5) {
          const mid = new ManagementSession();
          mid.load(s.save());
          run(s, { kind: "settle" });
          run(mid, { kind: "settle" });
          expect(mid.save()).toEqual(s.save());
          const settled = new ManagementSession();
          settled.load(s.save());
          const last = s.save().commands.at(-1)!;
          settled.execute(last);
          expect(settled.save()).toEqual(s.save());
          if (index === 2) {
            run(s, { kind: "next-day" });
            run(settled, { kind: "next-day" });
            expect(settled.save()).toEqual(s.save());
            const next = s.save().commands.at(-1)!;
            s.execute(next);
            expect(settled.save()).toEqual(s.save());
          }
        }
      }
      expect(s.observe()).toMatchObject({
        complete: true,
        auditCompleted: true,
        pendingAudit: dayOneErrors * 3,
        credits: 28 - errors * 3 - dayOneErrors * 3,
      });
    }
  });
  it("rejects illegal and conflicting commands atomically", () => {
    const s = new ManagementSession();
    const before = s.save();
    for (const action of [
      { kind: "settle" },
      { kind: "next-day" },
      { kind: "decide", documentId: "unknown", decision: "accept" },
    ] as ManagementAction[]) {
      expect(() => run(s, action)).toThrow();
      expect(s.save()).toEqual(before);
    }
    run(s, { kind: "decide", documentId: "ada", decision: "accept" });
    const after = s.save();
    expect(() =>
      run(s, { kind: "decide", documentId: "ada", decision: "reject" }),
    ).toThrow();
    expect(() =>
      s.execute({ id: "desk-0", revision: 0, action: { kind: "settle" } }),
    ).toThrow();
    expect(() =>
      s.execute({
        id: "stale",
        revision: 0,
        action: { kind: "decide", documentId: "bo", decision: "reject" },
      }),
    ).toThrow();
    expect(s.save()).toEqual(after);
  });
  it("rejects forged balances, audit, decision correctness, history, outcomes and incompatible saves without mutation", () => {
    const s = new ManagementSession();
    day(s, "reject");
    const before = s.save();
    const edits: ((v: any) => void)[] = [
      (v) => v.ledger.resources[0].quantity++,
      (v) => (v.pendingAudit = 0),
      (v) => (v.decisions[0].correct = true),
      (v) => v.commands.reverse(),
      (v) => v.commands.push(v.commands[0]),
      (v) => v.ledger.outcomes.pop(),
      (v) => (v.day = 2),
      (v) => (v.settled = false),
      (v) => (v.format = "future"),
      (v) => (v.extra = true),
      (v) => (v.commands[0].action.position = { x: 1, y: 2 }),
      (v) => v.ledger.definition.rewardSeed++,
      (v) => (v.commands = Array(10).fill(v.commands[0])),
      (v) => (v.ledger.random = {}),
    ];
    for (const edit of edits) {
      const v = JSON.parse(JSON.stringify(before)) as ManagementSave;
      edit(v);
      expect(() => s.load(v)).toThrow();
      expect(s.save()).toEqual(before);
    }
  });
  it("rejects accessors, sparse/custom arrays, cycles and deep data before executing getters", () => {
    const s = new ManagementSession();
    const before = s.save();
    let reads = 0;
    const accessor = { ...before };
    Object.defineProperty(accessor, "day", {
      enumerable: true,
      get() {
        reads++;
        return 1;
      },
    });
    const sparse = { ...before, commands: Array(2) };
    const custom = { ...before, commands: Object.assign([], { extra: 1 }) };
    const disguised: any[] = [];
    disguised.length = 1;
    Object.assign(disguised, {
      foo: { id: "first", revision: 0, action: { kind: "settle" } },
    });
    const hidden: any[] = [];
    Object.defineProperty(hidden, "0", {
      value: { id: "first", revision: 0, action: { kind: "settle" } },
      enumerable: false,
    });
    const cycle: any = { ...before };
    cycle.ledger = cycle;
    for (const v of [
      accessor,
      sparse,
      custom,
      { ...before, commands: disguised },
      { ...before, commands: hidden },
      cycle,
      { ...before, day: -0 },
      { ...before, day: 1.5 },
      { ...before, commands: Array(100000) },
    ]) {
      expect(() => s.load(v)).toThrow();
      expect(s.save()).toEqual(before);
    }
    expect(reads).toBe(0);
  });
});
