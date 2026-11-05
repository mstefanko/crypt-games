import { describe, expect, it } from "vitest";
import {
  compareGeometryTime,
  GEOMETRY_LIMITS,
  geometryOverlaps,
  geometrySegment,
  geometrySweep,
  queryGeometry,
} from "./geometry";
import type { GeometryShape } from "./geometry";
import { inspectGeometryFixture } from "../../../apps/game-lab/src/geometry-proof";
import { sweepArenaContact } from "./m3/arena-geometry";
import { overlaps } from "./collision";

const box = { x: 0, y: 0, width: 2, height: 2 };
function shape(
  bodyId: string,
  patch: Partial<GeometryShape> = {},
): GeometryShape {
  return {
    bodyId,
    shapeId: "body",
    owner: "test",
    category: "world",
    region: "body",
    sensor: false,
    priority: 0,
    rect: { x: 4, y: 0, width: 1, height: 2 },
    ...patch,
  };
}
describe("P0 geometry contracts", () => {
  it("preserves platform overlap and arena sweep for exhaustive small integer configurations", () => {
    for (let x = -3; x <= 3; x++)
      for (let y = -3; y <= 3; y++) {
        const target = { x, y, width: 2, height: 2 };
        expect(geometryOverlaps(box, target)).toBe(overlaps(box, target));
        for (let dx = -3; dx <= 3; dx++)
          for (let dy = -3; dy <= 3; dy++)
            expect(geometrySweep(box, { x: dx, y: dy }, target)).toEqual(
              sweepArenaContact(box, dx, dy, target),
            );
      }
  });
  it("declares tangent, corner, endpoint, zero and initial penetration semantics", () => {
    expect(geometryOverlaps(box, { ...box, x: 2 })).toBe(false);
    expect(geometrySweep(box, { x: 2, y: 0 }, { ...box, x: 4 })).toEqual({
      n: 2,
      d: 2,
    });
    expect(geometrySweep(box, { x: 2, y: 2 }, { ...box, x: 4, y: 0 })).toBe(
      null,
    );
    expect(geometrySweep(box, { x: 2, y: 0 }, { ...box, x: 3, y: 2 })).toBe(
      null,
    );
    expect(geometrySweep(box, { x: 0, y: 0 }, box)).toEqual({ n: 0, d: 1 });
    expect(geometrySweep(box, { x: -1, y: 0 }, { ...box, x: 2 })).toBe(null);
    expect(geometrySegment({ x: -2, y: 1 }, { x: 2, y: 0 }, box)).toEqual({
      n: 2,
      d: 2,
    });
    expect(geometrySegment({ x: 0, y: 0 }, { x: 0, y: 0 }, box)).toBe(null);
    expect(geometrySegment({ x: 1, y: 1 }, { x: 0, y: 0 }, box)).toEqual({
      n: 0,
      d: 1,
    });
  });
  it("sorts contacts by exact time, priority, body then shape, independent of input order", () => {
    const shapes = [
      shape("z"),
      shape("a"),
      shape("b", { priority: -1 }),
      shape("a", { shapeId: "hurt", region: "hurt" }),
      shape("near", { priority: 1024, rect: { ...box, x: 3 } }),
    ];
    const run = (s: GeometryShape[]) =>
      queryGeometry(
        s,
        { kind: "sweep", rect: box, delta: { x: 8, y: 0 } },
        { regions: ["body", "hurt"] },
      );
    const result = run(shapes);
    expect(run([...shapes].reverse())).toEqual(result);
    function permutations(
      rest: GeometryShape[],
      prefix: GeometryShape[] = [],
    ): void {
      if (rest.length === 0) expect(run(prefix)).toEqual(result);
      for (let i = 0; i < rest.length; i++)
        permutations(
          rest.filter((_, j) => i !== j),
          [...prefix, rest[i]],
        );
    }
    permutations(shapes);
    expect(result.contacts.map((c) => `${c.bodyId}/${c.shapeId}`)).toEqual([
      "near/body",
      "b/body",
      "a/body",
      "a/hurt",
      "z/body",
    ]);
    expect(result.candidates.map((c) => c.bodyId)).toEqual([
      "a",
      "a",
      "b",
      "near",
      "z",
    ]);
    expect(result.counters).toEqual({
      scanned: 5,
      filtered: 0,
      tested: 5,
      contacts: 5,
    });
    expect(compareGeometryTime({ n: 1, d: 2 }, { n: 2, d: 4 })).toBe(0);
    expect(compareGeometryTime({ n: 1, d: 4 }, { n: 3, d: 4 })).toBe(-1);
    expect(compareGeometryTime({ n: 3, d: 4 }, { n: 1, d: 4 })).toBe(1);
  });
  it("filters categories, regions, sensors and entire owner bodies without dropping capped results", () => {
    const shapes = [
      shape("world"),
      shape("actor", { category: "actor" }),
      shape("sensor", { sensor: true }),
      shape("hurt", { region: "hurt" }),
    ];
    const q = { kind: "sweep" as const, rect: box, delta: { x: 8, y: 0 } };
    expect(queryGeometry(shapes, q).contacts.map((c) => c.bodyId)).toEqual([
      "actor",
      "world",
    ]);
    expect(
      queryGeometry(shapes, q, { sensors: "only" }).contacts.map(
        (c) => c.bodyId,
      ),
    ).toEqual(["sensor"]);
    expect(
      queryGeometry(shapes, q, {
        categories: ["world"],
        sensors: "include",
        excludeBodyIds: ["world"],
      }).contacts.map((c) => c.bodyId),
    ).toEqual(["sensor"]);
    expect(queryGeometry(shapes, q, { categories: [] }).contacts).toEqual([]);
    const full = Array.from({ length: 256 }, (_, i) => shape(`shape-${i}`));
    expect(queryGeometry(full, q).contacts).toHaveLength(256);
    expect(() => queryGeometry([...full, shape("overflow")], q)).toThrow(/cap/);
  });
  it("rejects unsupported or malformed input before querying, including an empty query", () => {
    const q = { kind: "sweep" as const, rect: box, delta: { x: 8192, y: 1 } };
    expect(() => queryGeometry([], q)).toThrow(/cap/);
    expect(() => geometryOverlaps({ ...box, width: 0 }, box)).toThrow();
    expect(() => geometryOverlaps({ ...box, x: NaN }, box)).toThrow();
    expect(() => geometrySweep(box, { x: 0.5, y: 0 }, box)).toThrow();
    expect(() =>
      geometrySegment({ x: 262144, y: 1 }, { x: 1, y: 0 }, box),
    ).toThrow();
    expect(() => compareGeometryTime({ n: 0, d: 0 }, { n: 1, d: 1 })).toThrow();
    expect(() =>
      queryGeometry([shape("a"), shape("a")], { kind: "overlap", rect: box }),
    ).toThrow(/Duplicate/);
    expect(() =>
      queryGeometry(
        [shape("a"), shape("a", { shapeId: "hurt", owner: "other" })],
        { kind: "overlap", rect: box },
      ),
    ).toThrow(/owners/);
    expect(() =>
      queryGeometry([shape("bad id")], { kind: "overlap", rect: box }),
    ).toThrow(/identity/);
    expect(() =>
      queryGeometry([shape("a", { region: "circle" as never })], {
        kind: "overlap",
        rect: box,
      }),
    ).toThrow(/Unsupported/);
  });
  it("keeps maximum-coordinate arithmetic exact and returns detached inspection facts", () => {
    const max = GEOMETRY_LIMITS.coordinate;
    const target = { x: max - 1, y: -max, width: 1, height: 1 };
    expect(
      geometrySegment(
        { x: max - 8192, y: -max + 0 },
        { x: 8192, y: 0 },
        target,
      ),
    ).toBe(null);
    expect(
      geometrySweep(
        { x: max - 8193, y: -max, width: 1, height: 2 },
        { x: 8192, y: 0 },
        { x: max - 1, y: -max, width: 1, height: 2 },
      ),
    ).toEqual({ n: 8191, d: 8192 });
    expect(
      geometrySweep(
        { x: -max, y: -1, width: 1, height: 2 },
        { x: 8192, y: 0 },
        { x: max - 1, y: -1, width: 1, height: 2 },
      ),
    ).toBe(null);
    const s = shape("object");
    const before = JSON.stringify(s);
    const result = queryGeometry([s], { kind: "overlap", rect: box });
    expect(JSON.stringify(s)).toBe(before);
    (result.candidates[0].rect as { x: number }).x = 99;
    expect(s.rect.x).toBe(4);
  });
  it("drives a projectile/object fixture through public primitives and exposes inspection", () => {
    const proof = inspectGeometryFixture();
    expect(proof.projectile).toEqual({
      x: 992,
      y: 256,
      width: 32,
      height: 32,
      stopped: true,
    });
    expect(proof.contactOrder.map((c) => c.bodyId)).toEqual(["object"]);
    expect(proof.shapes.map((s) => s.region)).toEqual([
      "body",
      "hurt",
      "attack",
    ]);
    expect(proof.counters).toEqual({
      scanned: 3,
      filtered: 2,
      tested: 1,
      contacts: 1,
    });
    expect(proof.stateOwner).toBe("fixture-projectile");
  });
});
