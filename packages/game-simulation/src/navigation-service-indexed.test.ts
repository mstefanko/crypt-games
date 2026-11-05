import { describe, expect, it } from "vitest";
import {
  SustainedNavigationScheduler as Service,
  type SustainedNavigationDiagnostic,
} from "./navigation-service";

const grid = (weighted = false, unreachable = false) => ({
  width: 12,
  height: 12,
  revision: 0,
  costs: Array.from({ length: 144 }, (_, n) =>
    unreachable && n % 12 === 6 ? 0 : weighted ? 1 + ((n * 17) % 9) : 1,
  ),
});
const equal = (a: Service, b: Service) =>
  expect(JSON.stringify(b.capture())).toBe(JSON.stringify(a.capture()));
function pair(weighted = false, unreachable = false) {
  const g = grid(weighted, unreachable);
  return [new Service(g), new Service(g, { strategy: "indexed" })] as const;
}
describe("indexed point control", () => {
  for (const weighted of [false, true])
    for (const unreachable of [false, true]) {
      it(`preserves every tick and exact restore for weighted=${weighted}, unreachable=${unreachable}`, () => {
        const [legacy, indexed] = pair(weighted, unreachable);
        for (const service of [legacy, indexed])
          for (let n = 0; n < 8; n++)
            service.request({
              algorithm: "astar",
              start: n * 12,
              goal: 143 - n,
            });
        let restored = new Service(grid(weighted, unreachable), {
          strategy: "indexed",
        });
        for (let tick = 0; tick < 180; tick++) {
          equal(legacy, indexed);
          if (tick % 17 === 0) {
            restored = new Service(grid(weighted, unreachable), {
              strategy: "indexed",
            });
            restored.restore(legacy.capture());
          }
          legacy.advance(7);
          indexed.advance(7);
          restored.advance(7);
          equal(legacy, restored);
        }
        expect(legacy.observeSummary().pendingSearches).toBe(0);
      });
    }
  it("keeps BFS and start=goal semantics and blocked endpoints", () => {
    const [a, b] = pair();
    for (const s of [a, b]) {
      s.request({ algorithm: "bfs", start: 0, goal: 143 });
      s.request({ algorithm: "astar", start: 11, goal: 11 });
    }
    for (let n = 0; n < 160; n++) {
      a.advance(3);
      b.advance(3);
      equal(a, b);
    }
    const g = grid();
    g.costs[143] = 0;
    const c = new Service(g),
      d = new Service(g, { strategy: "indexed" });
    for (const s of [c, d]) {
      s.request({ algorithm: "astar", start: 0, goal: 143 });
      s.advance();
    }
    equal(c, d);
  });
  it("preserves fork isolation, cancellation, release and terrain invalidation", () => {
    const [a, b] = pair(true);
    for (const s of [a, b]) {
      for (let n = 0; n < 4; n++)
        s.request({ algorithm: "astar", start: n, goal: 143 - n });
      s.advance(8);
    }
    const af = a.fork(),
      bf = b.fork();
    for (const s of [af, bf]) {
      s.cancel(2);
      s.release(2);
      s.advance(17);
      s.setTerrain({ ...grid(true), revision: 1 });
      s.release(1);
      s.request({ algorithm: "astar", start: 0, goal: 130 });
    }
    equal(af, bf);
    equal(a, b);
    for (let n = 0; n < 80; n++) {
      af.advance(5);
      bf.advance(5);
      equal(af, bf);
    }
    a.advance(7);
    b.advance(7);
    equal(a, b);
    expect(af.capture()).not.toEqual(a.capture());
  });
  it("emits deterministic metadata and counts without affecting authority", () => {
    const events: SustainedNavigationDiagnostic[] = [];
    const g = grid(true),
      plain = new Service(g),
      observed = new Service(g, { diagnostics: (e) => events.push(e) }),
      indexed = new Service(g, {
        strategy: "indexed",
        diagnostics: (e) => events.push(e),
      });
    for (const s of [plain, observed, indexed])
      s.request({ algorithm: "astar", start: 0, goal: 143 });
    for (let n = 0; n < 40; n++) {
      for (const s of [plain, observed, indexed]) s.advance(5);
      equal(plain, observed);
      equal(plain, indexed);
    }
    const work = events.filter(
      (e) => e.operation === "expansion" && e.phase === "after",
    );
    expect(work.length).toBeGreaterThan(0);
    expect(
      work.every(
        (e) =>
          e.id === 1 &&
          e.goal === 143 &&
          e.start === 0 &&
          e.terrainRevision === 0,
      ),
    ).toBe(true);
    expect(
      work.some(
        (e) => e.strategy === "legacy" && e.work!.frontierComparisons > 0,
      ),
    ).toBe(true);
    expect(
      work.some((e) => e.strategy === "indexed" && e.work!.heapComparisons > 0),
    ).toBe(true);
    expect(
      work
        .filter((e) => e.strategy === "indexed")
        .every(
          (e) =>
            e.work!.closedMembershipScans === 0 &&
            e.work!.frontierMembershipScans === 0,
        ),
    ).toBe(true);
  });
  it("isolates thrown diagnostics errors", () => {
    const [a, b] = pair();
    const broken = new Service(grid(), {
      strategy: "indexed",
      diagnostics: () => {
        throw Error("host failure");
      },
    });
    for (const s of [a, b, broken])
      s.request({ algorithm: "astar", start: 0, goal: 143 });
    for (let n = 0; n < 40; n++) {
      a.advance(5);
      b.advance(5);
      broken.advance(5);
      equal(a, b);
      equal(a, broken);
    }
  });
});
