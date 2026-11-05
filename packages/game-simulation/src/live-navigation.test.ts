import { describe, expect, it } from "vitest";
import { LiveNavigation } from "./live-navigation";

describe("LiveNavigation checkpoint budgets", () => {
  it("rejects changed authored limits atomically and resumes the authored scheduler", () => {
    const navigation = new LiveNavigation({
      width: 8,
      height: 8,
      maxRequests: 2,
      expansionsPerTick: 1,
    });
    const id = navigation.request(0, 63);
    navigation.step();
    const saved = navigation.snapshot();
    for (const field of ["max", "budget"] as const) {
      for (const delta of [-1, 1]) {
        const candidate = structuredClone(saved);
        candidate[field] += delta;
        expect(() => navigation.restore(candidate)).toThrow();
        expect(navigation.snapshot()).toEqual(saved);
      }
    }
    const resumed = new LiveNavigation({
      width: 8,
      height: 8,
      maxRequests: 2,
      expansionsPerTick: 1,
    });
    resumed.restore(saved);
    navigation.step();
    resumed.step();
    expect(resumed.snapshot()).toEqual(navigation.snapshot());
    expect(resumed.result(id)?.status).toBe("in-progress");
    expect(resumed.request(1, 62)).toBeGreaterThan(0);
    expect(resumed.request(2, 61)).toBe(-1);
  });
});

describe("LiveNavigation constructor", () => {
  const construct = (options: unknown) =>
    new LiveNavigation(
      options as ConstructorParameters<typeof LiveNavigation>[0],
    );

  it("rejects invalid dimensions, admission counts, and work budgets", () => {
    for (const field of [
      "width",
      "height",
      "maxRequests",
      "expansionsPerTick",
    ]) {
      for (const value of [
        0,
        -1,
        1.5,
        NaN,
        Infinity,
        -Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        "2",
        null,
      ]) {
        expect(() =>
          construct({ width: 2, height: 2, [field]: value }),
        ).toThrow();
      }
    }
    for (const value of [undefined, null, {}, { width: 2 }])
      expect(() => construct(value)).toThrow();
    for (const [width, height] of [
      [0x100000000, 1],
      [0x10000, 0x10000],
      [Number.MAX_SAFE_INTEGER, 2],
    ])
      expect(() => construct({ width, height })).toThrow("cell count");
  });

  it("rejects malformed arrays and nonfinite costs before allocating cells", () => {
    for (const field of ["walkable", "costs"]) {
      for (const value of [
        null,
        {},
        "1234",
        new Array(1),
        [undefined],
        new Array(5).fill(field === "costs" ? 1 : true),
      ])
        expect(() =>
          construct({ width: 2, height: 2, [field]: value }),
        ).toThrow();
    }
    for (const value of [0, 1, "true", null])
      expect(() =>
        construct({ width: 2, height: 2, walkable: [value] }),
      ).toThrow();
    for (const value of [NaN, Infinity, -Infinity, "1", true, null])
      expect(() =>
        construct({ width: 2, height: 2, costs: [value] }),
      ).toThrow();
    // These dimensions are representable but intentionally too large to allocate
    // in a test: malformed data must be rejected before Array.from is reached.
    expect(() =>
      construct({ width: 0xffffffff, height: 1, costs: [NaN] }),
    ).toThrow("cell value");
  });

  it("preserves defaults, dense prefixes, finite cost clamping, and input ownership", () => {
    const defaults = new LiveNavigation({ width: 2, height: 2 });
    expect(defaults.snapshot()).toMatchObject({
      cells: [true, true, true, true],
      costs: [1, 1, 1, 1],
      max: 128,
      budget: 512,
    });
    const walkable = [true, false];
    const costs = [-1, 0, 0.5];
    const navigation = new LiveNavigation({
      width: 2,
      height: 2,
      walkable,
      costs,
      maxRequests: 1,
      expansionsPerTick: 1,
    });
    walkable[0] = false;
    costs[0] = 9;
    expect(navigation.snapshot()).toMatchObject({
      cells: [true, false, true, true],
      costs: [0.25, 0.25, 0.5, 1],
      max: 1,
      budget: 1,
    });
    const id = navigation.request(0, 3);
    expect(navigation.request(0, 2)).toBe(-1);
    navigation.step();
    expect(navigation.result(id)?.status).toBe("in-progress");
    navigation.step();
    navigation.step();
    expect(navigation.result(id)?.path).toEqual([0, 2, 3]);
    expect(
      new LiveNavigation({
        width: 1,
        height: 1,
        walkable: [],
        costs: [],
        maxRequests: Number.MAX_SAFE_INTEGER,
        expansionsPerTick: Number.MAX_SAFE_INTEGER,
      }).snapshot(),
    ).toMatchObject({ cells: [true], costs: [1] });
  });
});

describe("LiveNavigation result ownership", () => {
  it("returns only detached public fields throughout search continuation", () => {
    const navigation = new LiveNavigation({
      width: 4,
      height: 4,
      expansionsPerTick: 1,
    });
    const id = navigation.request(0, 15);
    expect(navigation.result(-1)).toBeUndefined();
    for (const advance of [false, true]) {
      if (advance) navigation.step();
      const before = navigation.snapshot();
      const result = navigation.result(id)!;
      expect(Object.keys(result).sort()).toEqual([
        "path",
        "revision",
        "status",
      ]);
      result.status = "unreachable";
      result.revision = 999;
      result.path.push(999);
      expect(navigation.snapshot()).toEqual(before);
    }
    const resumed = new LiveNavigation({
      width: 4,
      height: 4,
      expansionsPerTick: 1,
    });
    resumed.restore(navigation.snapshot());
    for (let i = 0; i < 32; i++) {
      navigation.step();
      resumed.step();
      expect(navigation.snapshot()).toEqual(resumed.snapshot());
    }
    const completed = navigation.result(id)!;
    expect(completed.status).toBe("complete");
    const saved = navigation.snapshot();
    completed.path.reverse();
    completed.path.length = 0;
    completed.status = "stale";
    completed.revision++;
    expect(navigation.snapshot()).toEqual(saved);
    expect(navigation.result(id)?.path).toEqual(resumed.result(id)?.path);
    navigation.setCell(1, false);
    const stale = navigation.result(id)!;
    stale.path.push(999);
    expect(navigation.result(id)?.path).not.toContain(999);
    navigation.retire(id);
    expect(navigation.result(id)).toBeUndefined();
  });
});

describe("LiveNavigation mutation and admission boundaries", () => {
  const create = () =>
    new LiveNavigation({ width: 3, height: 2, expansionsPerTick: 1 });
  const invalidCells = [
    -1,
    6,
    0.5,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "0",
    null,
    undefined,
  ];

  it("rejects malformed cell mutations atomically and preserves pending continuation", () => {
    const navigation = create();
    const control = create();
    const id = navigation.request(0, 5);
    control.request(0, 5);
    navigation.step();
    control.step();
    const before = navigation.snapshot();
    const mutate = (i: unknown, walkable: unknown, cost: unknown) =>
      navigation.setCell(i as number, walkable as boolean, cost as number);
    for (const i of invalidCells) {
      expect(() => mutate(i, false, 1)).toThrow();
      expect(navigation.snapshot()).toEqual(before);
    }
    for (const walkable of [0, 1, "false", null, undefined]) {
      expect(() => mutate(1, walkable, 1)).toThrow();
      expect(navigation.snapshot()).toEqual(before);
    }
    for (const cost of [NaN, Infinity, -Infinity, "1", true, null]) {
      expect(() => mutate(1, false, cost)).toThrow();
      expect(navigation.snapshot()).toEqual(before);
    }
    for (let tick = 0; tick < 8; tick++) {
      navigation.step();
      control.step();
      expect(navigation.snapshot()).toEqual(control.snapshot());
    }
    expect(navigation.result(id)?.path).toEqual([0, 1, 2, 5]);
    navigation.setCell(1, false, -1);
    expect(navigation.snapshot()).toMatchObject({
      revision: 1,
      costs: [1, 0.25, 1, 1, 1, 1],
    });
    expect(navigation.result(id)?.status).toBe("stale");
    const saved = navigation.snapshot();
    navigation.setCell(1, false, 0.25);
    expect(navigation.snapshot()).toEqual(saved);
  });

  it("rejects malformed request endpoints before admission and ID allocation", () => {
    const navigation = create();
    const before = navigation.snapshot();
    for (const cell of invalidCells) {
      for (const [start, goal] of [
        [cell, 5],
        [0, cell],
      ]) {
        expect(() =>
          navigation.request(start as number, goal as number),
        ).toThrow();
        expect(navigation.snapshot()).toEqual(before);
      }
    }
    expect(navigation.request(0, 5)).toBe(1);
    navigation.setCell(1, false);
    const blocked = navigation.request(1, 5);
    expect(navigation.result(blocked)?.status).toBe("unreachable");
    const full = new LiveNavigation({ width: 1, height: 1, maxRequests: 1 });
    full.request(0, 0);
    const saved = full.snapshot();
    expect(() => full.request(NaN, 0)).toThrow();
    expect(full.request(0, 0)).toBe(-1);
    expect(full.snapshot()).toEqual(saved);
  });

  it("rejects exhausted counters without publishing an unrestorable snapshot", () => {
    const navigation = create();
    const saved = navigation.snapshot();
    saved.next = Number.MAX_SAFE_INTEGER - 1;
    saved.revision = Number.MAX_SAFE_INTEGER - 1;
    navigation.restore(saved);
    const id = navigation.request(0, 5);
    expect(id).toBe(Number.MAX_SAFE_INTEGER - 1);
    navigation.setCell(1, false);
    const exhausted = navigation.snapshot();
    expect(() => navigation.request(0, 5)).toThrow();
    expect(() => navigation.setCell(2, false)).toThrow();
    expect(navigation.snapshot()).toEqual(exhausted);
    navigation.setCell(1, false);
    expect(navigation.snapshot()).toEqual(exhausted);
    const resumed = create();
    resumed.restore(exhausted);
    navigation.step();
    resumed.step();
    expect(navigation.snapshot()).toEqual(resumed.snapshot());
    navigation.retire(id);
    expect(navigation.result(id)).toBeUndefined();
  });
});

describe("LiveNavigation normalized cost updates", () => {
  it("does not invalidate searches or consume revisions for equivalent clamped costs", () => {
    const navigation = new LiveNavigation({ width: 2, height: 1 });
    navigation.setCell(1, true, -1);
    const id = navigation.request(0, 1);
    navigation.step();
    const before = navigation.snapshot();
    for (const cost of [-2, 0, 0.1, 0.25]) navigation.setCell(1, true, cost);
    expect(navigation.snapshot()).toEqual(before);
    expect(navigation.result(id)?.status).toBe("complete");
    const exhausted = navigation.snapshot();
    exhausted.revision = Number.MAX_SAFE_INTEGER;
    navigation.restore(exhausted);
    navigation.setCell(1, true, 0);
    expect(navigation.snapshot()).toEqual(exhausted);
  });
});
