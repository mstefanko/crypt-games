import { describe, expect, it } from "vitest";
import {
  CIRCLE_LIMITS, circleOverlapsCircle, circleOverlapsRect, circleSegment,
  circleSweepCircle, circleSweepRect, queryCircleGeometry,
} from "./circle-geometry";
import type { CircleGeometryShape, GeometryCircle } from "./circle-geometry";
import type { GeometryRect, GeometryVector } from "./geometry";
const unit: GeometryCircle = { x: 0, y: 0, radius: 1 };
function shape(id: string, patch: Partial<CircleGeometryShape> = {}): CircleGeometryShape {
  return { bodyId: id, shapeId: "body", owner: "static-world", category: "world", region: "body", sensor: false, priority: 0, kind: "circle", circle: { x: 10, y: 0, radius: 1 }, ...patch } as CircleGeometryShape;
}
// Independent small-coordinate analytic reference. Production uses exact integer
// discriminants and integer sqrt instead of this test-only floating square root.
function referenceCircle(c: GeometryCircle, d: GeometryVector, t: GeometryCircle): number | null {
  const x = c.x - t.x, y = c.y - t.y, r = c.radius + t.radius;
  const a = d.x * d.x + d.y * d.y, b = 2 * (x * d.x + y * d.y), q = x * x + y * y - r * r;
  if (q < 0 || (q === 0 && (a === 0 || b < 0))) return 0;
  if (q === 0 || a === 0 || b >= 0 || b * b - 4 * a * q < 0) return null;
  const time = (-b - Math.sqrt(b * b - 4 * a * q)) / (2 * a);
  return time <= 1 ? Math.ceil(time * CIRCLE_LIMITS.timeScale - 1e-8) : null;
}
describe("P1 bounded circle queries", () => {
  it("returns canonical zero components for coincident centers", () => {
    for (const delta of [{ x: 1, y: 0 }, { x: 0, y: 1 }]) {
      const contact = queryCircleGeometry([shape("center", { kind: "circle", circle: unit })], { kind: "sweep", circle: unit, delta }).contacts[0];
      expect(contact.normal).toEqual({ x: 0 - delta.x, y: 0 - delta.y });
      expect(JSON.parse(JSON.stringify(contact))).toEqual(contact);
    }
  });
  it("rejects an entire mixed segment query unless rectangles are filtered out", () => {
    const shapes = [shape("circle"), shape("box", { kind: "rect", rect: { x: 100, y: 100, width: 1, height: 1 } })];
    const query = { kind: "segment" as const, origin: { x: 0, y: 0 }, delta: { x: 20, y: 0 } };
    expect(() => queryCircleGeometry(shapes, query)).toThrow("circle targets only");
    expect(queryCircleGeometry(shapes, query, { excludeBodyIds: ["box"] }).contacts.map(c => c.bodyId)).toEqual(["circle"]);
  });
  it("matches analytic circle entry across exhaustive tiny positions and motions", () => {
    const target = { x: 0, y: 0, radius: 2 };
    for (let x = -5; x <= 5; x++) for (let y = -5; y <= 5; y++)
      for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
        const c = { x, y, radius: 1 }, d = { x: dx, y: dy };
        expect(circleSweepCircle(c, d, target)).toBe(referenceCircle(c, d, target));
      }
  });
  it("uses closed circles and true rounded corners rather than expanded squares", () => {
    const box = { x: 10, y: 10, width: 10, height: 10 };
    expect(circleOverlapsRect({ x: 6, y: 6, radius: 5 }, box)).toBe(false);
    expect(circleOverlapsRect({ x: 7, y: 6, radius: 5 }, box)).toBe(true);
    expect(circleSweepRect({ x: 0, y: 6, radius: 5 }, { x: 6, y: 0 }, box)).toBeNull();
    expect(circleSweepRect({ x: 0, y: 6, radius: 5 }, { x: 7, y: 0 }, box)).toBe(65536);
    expect(circleSweepRect({ x: 0, y: 0, radius: 5 }, { x: 10, y: 10 }, box)).toBe(Math.ceil((1 - Math.sqrt(12.5) / 10) * 65536));
    expect(circleOverlapsCircle(unit, { x: 2, y: 0, radius: 1 })).toBe(true);
    expect(circleOverlapsCircle(unit, { x: 2, y: 1, radius: 1 })).toBe(false);
  });
  it("checks rounded-box entry against an independent face/corner reference", () => {
    const box: GeometryRect = { x: 0, y: 0, width: 2, height: 3 };
    for (let x = -4; x <= 6; x++) for (let y = -4; y <= 7; y++)
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
        const c = { x, y, radius: 1 }, delta = { x: dx, y: dy };
        const qx = Math.max(0, Math.min(x, 2)), qy = Math.max(0, Math.min(y, 3));
        const distance = (x - qx) ** 2 + (y - qy) ** 2;
        let expected: number | null;
        if (distance <= 1) expected = distance < 1 || (dx === 0 && dy === 0) || (x - qx) * dx + (y - qy) * dy < 0 ? 0 : null;
        else {
          const times: number[] = [];
          for (const [face, speed, origin, other, otherSpeed, min, max] of [
            [-1, dx, x, y, dy, 0, 3], [3, dx, x, y, dy, 0, 3],
            [-1, dy, y, x, dx, 0, 2], [4, dy, y, x, dx, 0, 2],
          ]) {
            const time = (face - origin) / speed;
            if (speed !== 0 && time >= 0 && time <= 1 && other + otherSpeed * time >= min && other + otherSpeed * time <= max) times.push(Math.ceil(time * 65536 - 1e-8));
          }
          for (const cx of [0, 2]) for (const cy of [0, 3]) {
            // Radius sum in the analytic circle helper must equal one.
            const time = referenceCircle({ ...c, radius: 0 }, delta, { x: cx, y: cy, radius: 1 });
            if (time !== null) times.push(time);
          }
          expected = times.length ? Math.min(...times) : null;
        }
        expect(circleSweepRect(c, delta, box)).toBe(expected);
      }
  });
  it("handles zero, inside, touching-away, exact tangency and thin cover", () => {
    const target = { x: 4, y: 0, radius: 1 };
    expect(circleSweepCircle(unit, { x: 0, y: 0 }, target)).toBeNull();
    expect(circleSweepCircle(unit, { x: 0, y: 0 }, unit)).toBe(0);
    expect(circleSweepCircle(unit, { x: -1, y: 0 }, { ...target, x: 2 })).toBeNull();
    expect(circleSweepCircle(unit, { x: 8, y: 0 }, { ...target, y: 2 })).toBe(32768);
    expect(circleSweepCircle(unit, { x: 8, y: 0 }, { ...target, y: 3 })).toBeNull();
    expect(circleSegment({ x: 0, y: 1 }, { x: 8, y: 0 }, { x: 4, y: 0, radius: 1 })).toBe(32768);
    expect(circleSegment({ x: 4, y: 0 }, { x: 0, y: 0 }, target)).toBe(0);
    expect(circleSweepRect(unit, { x: 8192, y: 0 }, { x: 8191, y: -1, width: 1, height: 2 })).toBe(65520);
    expect(circleSweepRect({ x: 5, y: 5, radius: 1 }, { x: 1, y: 0 }, { x: 0, y: 0, width: 10, height: 10 })).toBe(0);
  });
  it("keeps maximum coordinates exact including huge discriminants and near tangencies", () => {
    const origin = { x: -250000, y: 250000, radius: 4096 };
    const far = { x: 250000, y: -250000, radius: 4096 };
    expect(circleSweepCircle(origin, { x: 8192, y: 0 }, far)).toBeNull();
    const circle = { x: 249856, y: 250000, radius: 4096 };
    expect(circleSweepRect(circle, { x: 8192, y: 0 }, { x: 262143, y: 250000, width: 1, height: 1 })).toBe(65528);
    expect(circleSweepCircle({ x: 240000, y: 240000, radius: 1 }, { x: 8192, y: 0 }, { x: 244096, y: 244098, radius: 4096 })).toBeNull();
    expect(circleSweepCircle({ x: 240000, y: 240000, radius: 1 }, { x: 8192, y: 0 }, { x: 244096, y: 244097, radius: 4096 })).toBe(32768);
  });
  it("orders quantized contacts, filters complete snapshots and detaches candidates", () => {
    const shapes = [shape("z"), shape("b", { priority: -1 }), shape("a"), shape("sensor", { sensor: true }), shape("hurt", { region: "hurt" })];
    const query = { kind: "sweep" as const, circle: unit, delta: { x: 16, y: 0 } };
    const result = queryCircleGeometry(shapes, query);
    expect(result.contacts.map(c => c.bodyId)).toEqual(["b", "a", "z"]);
    expect(queryCircleGeometry([...shapes].reverse(), query)).toEqual(result);
    expect(queryCircleGeometry(shapes, query, { sensors: "only" }).contacts.map(c => c.bodyId)).toEqual(["sensor"]);
    expect(queryCircleGeometry(shapes, query, { categories: [] }).contacts).toEqual([]);
    expect(queryCircleGeometry(shapes, query, { excludeBodyIds: ["a", "b", "z"] }).contacts).toEqual([]);
    expect(result.counters).toEqual({ scanned: 5, filtered: 2, tested: 3, contacts: 3 });
    const candidate = result.candidates[0]; if (candidate.kind === "circle") (candidate.circle as {x:number}).x = 999;
    expect((shapes[2] as Extract<CircleGeometryShape, {kind:"circle"}>).circle.x).toBe(10);
    const full = Array.from({ length: 256 }, (_, i) => shape(`s-${i}`));
    expect(queryCircleGeometry(full, query).contacts).toHaveLength(256);
    expect(() => queryCircleGeometry([...full, shape("overflow")], query)).toThrow(/cap/);
  });
  it("rejects unsupported pairs and numeric inputs before any filtered/empty query", () => {
    expect(() => circleSweepCircle(unit, { x: 8192, y: 1 }, unit)).toThrow();
    expect(() => circleOverlapsCircle({ ...unit, radius: 0 }, unit)).toThrow();
    expect(() => circleOverlapsRect(unit, { x: 0, y: 0, width: 0, height: 1 })).toThrow();
    expect(() => queryCircleGeometry([], { kind: "sweep", circle: unit, delta: { x: 0.5, y: 0 } })).toThrow();
    expect(() => queryCircleGeometry([shape("a"), shape("a")], { kind: "overlap", circle: unit })).toThrow(/Duplicate/);
    expect(() => queryCircleGeometry([shape("a"), shape("a", { shapeId: "hurt", owner: "other" })], { kind: "overlap", circle: unit })).toThrow(/owners/);
    const box = { ...shape("box"), kind: "rect", rect: { x: 4, y: 0, width: 2, height: 2 } } as CircleGeometryShape;
    expect(() => queryCircleGeometry([box], { kind: "segment", origin: unit, delta: { x: 8, y: 0 } })).toThrow(/segment/);
    expect(() => queryCircleGeometry([{ ...shape("moving"), velocity: { x: 1, y: 0 } } as unknown as CircleGeometryShape], { kind: "overlap", circle: unit }, { categories: [] })).toThrow(/static target/);
    expect(() => queryCircleGeometry([], { kind: "overlap", circle: unit }, { regions: ["invalid" as never] })).toThrow();
    expect(() => circleSegment({ x: 262144, y: 0 }, { x: 1, y: 0 }, unit)).toThrow();
  });
});
