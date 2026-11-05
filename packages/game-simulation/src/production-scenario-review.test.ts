import { describe, expect, it } from "vitest";
import { createProductionScenario } from "./production-scenario-session";

function start(seed: number) {
  const owner = createProductionScenario(seed);
  for (const index of [0, 1]) {
    owner.command({ kind: "select", index });
    owner.command({ kind: "repair" });
    owner.command({ kind: "assign" });
  }
  return owner;
}
describe("Harbor independent review", () => {
  it("wins each authored layout using the real repair, delivery, meal and ship rules", () => {
    for (const seed of [1, 2, 3, 419, 311]) {
      const owner = start(seed);
      let building = false;
      for (let i = 0; i < 4800; i++) {
        const o = owner.observe();
        if (!building && o.supplies >= 12) {
          owner.command({ kind: "select", index: 2 });
          owner.command({ kind: "repair" });
          building = true;
        }
        if (o.sites[2]!.repaired && o.food >= 12 && o.supplies >= 8)
          owner.command({ kind: "ship" });
        if (owner.observe().outcome !== "playing") break;
        owner.step(0.05);
      }
      expect(owner.observe().outcome, `seed ${seed}`).toBe("won");
    }
  });
  it("continues worker paths, production, pending builds and accounting over JSON boundaries", () => {
    for (const seed of [1, 2, 3]) {
      const a = start(seed),
        b = createProductionScenario(seed);
      let building = false;
      for (let i = 0; i < 2000; i++) {
        if (!building && a.observe().supplies >= 12) {
          a.command({ kind: "select", index: 2 });
          a.command({ kind: "repair" });
          building = true;
        }
        if (i % 10 === 0) {
          b.restore(JSON.parse(JSON.stringify(a.snapshot())));
          a.step(0.05);
          b.step(0.05);
          expect(b.snapshot()).toEqual(a.snapshot());
          expect(b.observe()).toEqual(a.observe());
        } else a.step(0.05);
      }
    }
  });
  it("rejects topology, content, roster, cargo, sparse and identity corruption atomically", () => {
    const owner = start(1);
    owner.step(0.05);
    const before = owner.snapshot();
    const edits: ((v: ReturnType<typeof owner.snapshot>) => void)[] = [
      (v) => {
        v.seed++;
      },
      (v) => {
        v.workers.jobs[0]!.quantity = 100;
      },
      (v) => {
        v.workers.workers.pop();
      },
      (v) => {
        v.workers.workers[0]!.payload = { resource: "supplies", quantity: 200 };
      },
      (v) => {
        v.grid.costs[0] = 0;
      },
      (v) => {
        v.workers.workers[0]!.path = [100, 101];
      },
      (v) => {
        delete v.sites[0];
      },
      (v) => {
        v.pending.push("warehouse");
      },
      (v) => {
        v.capacity = 120;
      },
      (v) => {
        v.workers.jobs[0]!.enabled = false;
      },
      (v) => {
        v.ledger = { ...v.ledger, revision: 100 };
      },
    ];
    for (const edit of edits) {
      const malformed = structuredClone(before);
      edit(malformed);
      expect(() => owner.restore(malformed)).toThrow();
      expect(owner.snapshot()).toEqual(before);
    }
    const detached = owner.observe() as unknown as ReturnType<
      typeof owner.snapshot
    >;
    detached.workers.jobs[0]!.quantity = 999;
    detached.grid.costs[0] = 0;
    expect(owner.snapshot()).toEqual(before);
  });
});
