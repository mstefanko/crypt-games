import { describe, it, expect } from "vitest";
import {
  P3SlopeWorld,
  P3_SLOPE_FIXTURE,
  stepP3Motor,
  sampleP3Height,
  validateP3HeightField,
  prepareP3HeightField,
  validateP3Slopes,
} from "./p3-surfaces";
const command = { move: 256, jump: false, drop: false };
describe("P3 authored surfaces", () => {
  it("traverses maximum-grade seams in both directions without detaching", () => {
    const w = new P3SlopeWorld(P3_SLOPE_FIXTURE, {
      x: 1024,
      y: 4096,
      vy: 0,
      grounded: "flat",
    });
    for (let i = 0; i < 32; i++) {
      expect(w.step(command).grounded).not.toBeNull();
    }
    for (let i = 0; i < 32; i++)
      expect(w.step({ ...command, move: -256 }).grounded).not.toBeNull();
    expect(w.observe()).toEqual({ x: 1024, y: 4096, vy: 0, grounded: "flat" });
  });
  it("jumps, lands, drops one-way and ignores its underside", () => {
    const s = [
      {
        id: "one",
        x1: 0,
        x2: 4096,
        y1: 4096,
        y2: 4096,
        kind: "one-way" as const,
      },
    ];
    let b = { x: 1024, y: 4096, vy: 0, grounded: "one" as string | null };
    b = stepP3Motor(s, b, { move: 0, jump: true, drop: false });
    expect(b.y).toBeLessThan(4096);
    expect(b.grounded).toBeNull();
    for (let i = 0; i < 40; i++) {
      b = stepP3Motor(s, b, { move: 0, jump: false, drop: false });
      if (b.grounded) break;
    }
    expect(b.grounded).toBe("one");
    b = stepP3Motor(s, b, { move: 0, jump: false, drop: true });
    expect(b.y).toBeGreaterThan(4096);
    expect(b.grounded).toBeNull();
    expect(
      stepP3Motor(
        s,
        { x: 1024, y: 4300, vy: -256, grounded: null },
        { move: 0, jump: false, drop: false },
      ).grounded,
    ).toBeNull();
  });
  it("sweeps fast fall through a thin surface and blocks head on ceiling", () => {
    expect(
      stepP3Motor(
        P3_SLOPE_FIXTURE,
        { x: 1024, y: 4000, vy: 512, grounded: null },
        { move: 0, jump: false, drop: false },
      ).y,
    ).toBe(4096);
    const slopes = [
      ...P3_SLOPE_FIXTURE,
      {
        id: "ceiling",
        x1: 0,
        x2: 2048,
        y1: 3584,
        y2: 3584,
        kind: "ceiling" as const,
      },
    ];
    let b = stepP3Motor(
      slopes,
      { x: 1024, y: 4096, vy: 0, grounded: "flat" },
      { move: 0, jump: true, drop: false },
    );
    expect(b.y).toBe(3840);
    expect(b.vy).toBe(0);
  });
  it("restores exact continued slope snapshots and rejects tampering atomically", () => {
    const a = new P3SlopeWorld(P3_SLOPE_FIXTURE, {
      x: 1024,
      y: 4096,
      vy: 0,
      grounded: "flat",
    });
    for (let i = 0; i < 9; i++) a.step(command);
    const saved = a.capture();
    const b = new P3SlopeWorld(P3_SLOPE_FIXTURE, {
      x: 1024,
      y: 4096,
      vy: 0,
      grounded: "flat",
    });
    b.restore(saved);
    for (let i = 0; i < 10; i++)
      expect(b.step(command)).toEqual(a.step(command));
    const before = b.capture();
    expect(() =>
      b.restore({ ...saved, state: { ...saved.state, y: saved.state.y + 1 } }),
    ).toThrow();
    expect(b.capture()).toEqual(before);
  });
  it("samples triangle gradients and rejects steep or unbounded fields", () => {
    const f = { columns: 2, rows: 2, pitch: 1024, heights: [0, 256, 0, 256] };
    expect(sampleP3Height(f, 512, 512)).toEqual({
      height: 128,
      gradientX: 64,
      gradientY: 0,
    });
    expect(sampleP3Height(f, 1024, 1024).height).toBe(256);
    expect(() =>
      validateP3HeightField({ ...f, heights: [0, 257, 0, 0] }),
    ).toThrow();
    expect(() => sampleP3Height(f, 1025, 0)).toThrow();
  });
  it("selects earliest contact independently of authored segment order", () => {
    const slopes = [
      {
        id: "later",
        x1: 0,
        x2: 4096,
        y1: 4096,
        y2: 4096,
        kind: "floor" as const,
      },
      {
        id: "early",
        x1: 0,
        x2: 4096,
        y1: 3500,
        y2: 3500,
        kind: "ceiling" as const,
      },
      {
        id: "roof",
        x1: 0,
        x2: 4096,
        y1: 3400,
        y2: 3400,
        kind: "ceiling" as const,
      },
    ];
    const state = { x: 1024, y: 3900, vy: -512, grounded: null };
    const command = { move: 128, jump: false, drop: false };
    const a = stepP3Motor(slopes, state, command);
    expect(a.y).toBe(3756);
    expect(stepP3Motor(slopes.slice().reverse(), state, command)).toEqual(a);
    expect(() =>
      stepP3Motor(
        P3_SLOPE_FIXTURE,
        { x: 1024, y: 4096, vy: 1, grounded: "flat" },
        command,
      ),
    ).toThrow();
  });
  it("detaches at gaps and rejects ambiguous seams/unsupported grades", () => {
    const gap = [
      { id: "a", x1: 0, x2: 1024, y1: 4096, y2: 4096, kind: "floor" as const },
      {
        id: "b",
        x1: 1100,
        x2: 2048,
        y1: 4096,
        y2: 4096,
        kind: "floor" as const,
      },
    ];
    const b = stepP3Motor(
      gap,
      { x: 1000, y: 4096, vy: 0, grounded: "a" },
      { move: 128, jump: false, drop: false },
    );
    expect(b.grounded).toBeNull();
    expect(b.y).toBe(4112);
    expect(
      () =>
        new P3SlopeWorld([{ ...gap[0], y2: 0 }], {
          x: 0,
          y: 4096,
          vy: 0,
          grounded: "a",
        }),
    ).toThrow();
  });
  it("clamps both horizontal edges and top and recovers a fall throughout the exact horizon", () => {
    const idle = { move: 0, jump: false, drop: false };
    expect(
      stepP3Motor(
        [],
        { x: 0, y: 256, vy: -256, grounded: null },
        { ...idle, move: -256 },
      ),
    ).toEqual({ x: 0, y: 256, vy: 0, grounded: null });
    expect(
      stepP3Motor(
        [],
        { x: 32760, y: 32760, vy: 512, grounded: null },
        { ...idle, move: 256 },
      ),
    ).toEqual({ x: 32768, y: 32768, vy: 0, grounded: null });
    const a = new P3SlopeWorld(P3_SLOPE_FIXTURE, {
      x: 1024,
      y: 4096,
      vy: 0,
      grounded: "flat",
    });
    let respawns = 0,
      oldX = 1024;
    let continued: P3SlopeWorld | undefined;
    for (let i = 0; i < 256; i++) {
      const state = a.step({ ...idle, move: i < 128 ? 256 : -256 });
      if (continued)
        expect(continued.step({ ...idle, move: i < 128 ? 256 : -256 })).toEqual(
          state,
        );
      if (state.x === 1024 && oldX > 1024) respawns++;
      oldX = state.x;
      expect(state.x).toBeGreaterThanOrEqual(0);
      expect(state.y).toBeLessThanOrEqual(32768);
      if (i === 120) {
        const b = new P3SlopeWorld(P3_SLOPE_FIXTURE, {
          x: 1024,
          y: 4096,
          vy: 0,
          grounded: "flat",
        });
        b.restore(a.capture());
        expect(b.capture()).toEqual(a.capture());
        continued = b;
      }
    }
    expect(respawns).toBeGreaterThan(0);
    expect(a.capture().commands).toHaveLength(256);
    const before = a.capture();
    expect(() => a.step(idle)).toThrow();
    expect(a.capture()).toEqual(before);
  });
  it("rejects floors without head clearance and ceilings outside the reachable head box", () => {
    for (const kind of ["floor", "one-way"] as const)
      expect(() =>
        validateP3Slopes([
          { id: "bad", x1: 0, x2: 1024, y1: 255, y2: 255, kind },
        ]),
      ).toThrow();
    expect(() =>
      validateP3Slopes([
        { id: "bad", x1: 0, x2: 1024, y1: 32513, y2: 32513, kind: "ceiling" },
      ]),
    ).toThrow();
  });
  it("prepares one immutable field and samples constant cell work", () => {
    const field = {
      columns: 16,
      rows: 16,
      pitch: 2048,
      heights: Array(256).fill(0),
    };
    const prepared = prepareP3HeightField(field);
    field.heights[0] = 8192;
    for (let i = 0; i < 256; i++) expect(prepared.sample(i, 0).height).toBe(0);
    expect(prepared.work()).toEqual({
      validations: 1,
      samples: 256,
      heightReads: 1024,
    });
    expect(Object.isFrozen(prepared.field.heights)).toBe(true);
    expect(() => sampleP3Height(field, 0, 0)).toThrow();
    expect(() => prepared.sample(-1, 0)).toThrow();
  });
});
