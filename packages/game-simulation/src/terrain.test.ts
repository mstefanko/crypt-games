import { describe, expect, it } from "vitest";
import type {
  CaveContent,
  CaveRect,
  CaveDirection,
} from "@onepage/game-project/cave-types";
import { validateCaveContent } from "@onepage/game-project/cave-validation";
import { assertCavePlainData } from "@onepage/game-project/cave-data";
import {
  geometryOverlaps,
  geometrySweep,
  compareGeometryTime,
} from "./geometry";
import { TerrainField } from "./terrain-field";
import {
  overlapFieldAabb,
  raycastField,
  sweepFieldAabb,
} from "./terrain-query";
import {
  drillFootprint,
  diskTerrainCells,
  stageTerrainEdits,
} from "./terrain-edit";
import { moveCaveActor } from "./cave-motor";
function content(): CaveContent {
  const protectedCells = Array<boolean>(16384).fill(false);
  for (const [x, y] of [
    [2, 2],
    [8, 2],
  ])
    for (let dy = 0; dy < 4; dy++)
      for (let dx = 0; dx < 4; dx++)
        protectedCells[(y + dy) * 128 + x + dx] = true;
  return {
    version: "cave-content-v1",
    id: "terrain-test",
    width: 128,
    height: 128,
    cellSize: 1024,
    chunkSize: 16,
    materials: [
      {
        id: "air",
        solid: false,
        hp: 0,
        drillResistance: 0,
        blastResistance: 0,
        oreYield: 0,
        cue: "air",
      },
      {
        id: "ore",
        solid: true,
        hp: 20,
        drillResistance: 2,
        blastResistance: 0,
        oreYield: 3,
        cue: "ore",
      },
    ],
    cells: Array<number>(16384).fill(0),
    protected: protectedCells,
    player: { id: "player", x: 2048, y: 2048, hp: 100 },
    drones: [{ id: "drone", x: 8192, y: 2048 }],
    extraction: { x: 2048, y: 2048, width: 4096, height: 4096 },
    roof: { nodes: [], edges: [], zones: [], braceSockets: [] },
    tools: {
      drillDamage: 12,
      drillReach: 4096,
      drillInterval: 6,
      chargeDamage: 20,
      chargeRadius: 4096,
      chargeFuse: 60,
      charges: 4,
      braces: 2,
      braceReach: 4096,
      roofWarningTicks: 120,
      roofDamage: 20,
    },
  };
}
function paint(c: CaveContent, x: number, y: number, material = 1): void {
  (c.cells as number[])[y * 128 + x] = material;
}
/** Independent closed ray oracle: intersect the four finite rectangle edges. */
function referenceRay(
  p: { x: number; y: number },
  v: { x: number; y: number },
  r: CaveRect,
): { n: number; d: number } | null {
  if (p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height)
    return { n: 0, d: 1 };
  const times: { n: number; d: number }[] = [];
  for (const [
    origin,
    velocity,
    low,
    high,
    other,
    otherVelocity,
    otherLow,
    otherHigh,
  ] of [
    [p.x, v.x, r.x, r.x + r.width, p.y, v.y, r.y, r.y + r.height],
    [p.y, v.y, r.y, r.y + r.height, p.x, v.x, r.x, r.x + r.width],
  ]) {
    if (!velocity) continue;
    for (const face of [low, high]) {
      const n = (face - origin) * Math.sign(velocity),
        d = Math.abs(velocity),
        along = other * d + otherVelocity * n;
      if (n >= 0 && n <= d && along >= otherLow * d && along <= otherHigh * d)
        times.push({ n, d });
    }
  }
  return times.sort(compareGeometryTime)[0] ?? null;
}
describe("P4 bounded terrain", () => {
  it("rejects direction arrays and coercible objects without running user conversion hooks", () => {
    const f = new TerrainField(content()),
      actor = { x: 2048, y: 2048, width: 2048, height: 2048 };
    let converted = false;
    for (const direction of [
      ["right"],
      {
        toString() {
          converted = true;
          return "right";
        },
      },
      { direction: "up" },
    ])
      expect(() =>
        drillFootprint(f, actor, direction as unknown as CaveDirection, 4096),
      ).toThrow(/direction/);
    expect(converted).toBe(false);
  });

  it("validates plain-data admission without invoking getters or accepting sparse/cyclic data", () => {
    const c = content();
    expect(validateCaveContent(c).id).toBe(c.id);
    let invoked = false;
    Object.defineProperty(c, "evil", {
      enumerable: true,
      get() {
        invoked = true;
        return 1;
      },
    });
    expect(() => validateCaveContent(c)).toThrow(/accessor/);
    expect(invoked).toBe(false);
    expect(() => assertCavePlainData([, 1])).toThrow(/sparse/);
    expect(() => assertCavePlainData({ n: -0 })).toThrow(/noncanonical/);
    expect(() => assertCavePlainData({ n: NaN })).toThrow();
    expect(() => assertCavePlainData({ n: Infinity })).toThrow();
    expect(() => assertCavePlainData({ a: 1, unknown: undefined })).toThrow();
    const a: unknown[] = [];
    expect(() => assertCavePlainData([a, a])).not.toThrow();
    a.push(a);
    expect(() => assertCavePlainData(a)).toThrow(/cyclic/);
    expect(() => assertCavePlainData({ x: "é😀\n" }, 16)).not.toThrow();
    expect(() => assertCavePlainData({ x: "é😀\n" }, 15)).toThrow(/byte/);
  });
  it("rejects unknown content fields, invalid protected rescue cells and extraction roof hazards", () => {
    expect(() => validateCaveContent({ ...content(), extra: 0 })).toThrow(
      /unknown/,
    );
    const c = content();
    (c.protected as boolean[])[2 * 128 + 8] = false;
    expect(() => validateCaveContent(c)).toThrow(/protected/);
    const roof = {
      nodes: [{ id: "n", anchorCells: [20 * 128 + 20] }],
      edges: [],
      braceSockets: [],
      zones: [{ id: "z", rect: c.extraction, nodeIds: ["n"] }],
    };
    const d = { ...content(), roof };
    paint(d, 20, 20);
    expect(() => validateCaveContent(d)).toThrow(/extraction/);
  });
  it("stages multi-source damage commutatively with one-time ore and immutable private chunks", () => {
    const c = content();
    paint(c, 15, 15);
    paint(c, 16, 15);
    paint(c, 17, 15);
    (c.protected as boolean[])[15 * 128 + 17] = true;
    const a = new TerrainField(c),
      b = new TerrainField(c),
      cells = [15 * 128 + 15, 15 * 128 + 16, 15 * 128 + 17];
    const effects = [
      { sourceId: "a", sequence: 0, kind: "drill" as const, cells, damage: 12 },
      { sourceId: "b", sequence: 0, kind: "blast" as const, cells, damage: 10 },
    ];
    const tx = stageTerrainEdits(a, effects);
    expect(a.cell(15, 15).hp).toBe(20);
    expect(tx.preview().cell(15, 15).solid).toBe(false);
    expect(tx.receipt.reward).toBe(6);
    expect(tx.receipt.dirtyChunks).toEqual([0, 1]);
    tx.commit();
    stageTerrainEdits(b, [...effects].reverse()).commit();
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(a.cell(17, 15).hp).toBe(20);
    expect(() => tx.commit()).toThrow(/stale/);
    expect(stageTerrainEdits(a, effects).receipt.reward).toBe(0);
    const snapshot = a.snapshot();
    (snapshot.cells as number[])[15 * 128 + 17] = 0;
    expect(a.cell(17, 15).solid).toBe(true);
    const stale = stageTerrainEdits(a, []);
    stageTerrainEdits(a, []).commit();
    expect(() => stale.commit()).toThrow(/stale/);
  });
  it("keeps HP-only edits off occupancy revision and rejects invalid imports atomically", () => {
    const c = content();
    paint(c, 20, 20);
    const f = new TerrainField(c);
    stageTerrainEdits(f, [
      {
        sourceId: "d",
        sequence: 0,
        kind: "drill",
        cells: [20 * 128 + 20],
        damage: 4,
      },
    ]).commit();
    expect(f.stateRevision).toBe(1);
    expect(f.terrainRevision).toBe(0);
    expect(f.cell(20, 20).hp).toBe(18);
    const old = f.snapshot(),
      bad = structuredClone(old);
    (bad.hp as number[])[20 * 128 + 20] = 21;
    expect(() => f.restore(bad)).toThrow();
    expect(f.snapshot()).toEqual(old);
    const g = new TerrainField(c, old);
    expect(g.snapshot()).toEqual(old);
    const removal = structuredClone(old);
    (removal.cells as number[])[20 * 128 + 20] = 0;
    (removal.hp as number[])[20 * 128 + 20] = 0;
    expect(() => f.restore(removal)).toThrow(/revision|reward/);
    expect(() =>
      stageTerrainEdits(f, [
        {
          sourceId: "a",
          sequence: 0,
          kind: "drill",
          cells: [2570, 2570],
          damage: 4,
        },
      ]),
    ).toThrow();
    expect(f.snapshot()).toEqual(old);
  });
  it("admits five256cell effects and dirty publication across all64chunks without truncation", () => {
    const c = content(),
      ids: number[] = [];
    for (let chunk = 0; chunk < 64; chunk++)
      for (let i = 0; i < 20; i++) {
        const x = (chunk % 8) * 16 + 8 + (i % 4),
          y = Math.floor(chunk / 8) * 16 + 8 + Math.floor(i / 4);
        paint(c, x, y);
        ids.push(y * 128 + x);
      }
    const f = new TerrainField(c),
      effects = Array.from({ length: 5 }, (_, i) => ({
        sourceId: `effect-${i}`,
        sequence: 0,
        kind: i === 0 ? ("drill" as const) : ("blast" as const),
        cells: ids.slice(i * 256, (i + 1) * 256),
        damage: 1024,
      })),
      tx = stageTerrainEdits(f, effects);
    expect(tx.receipt.candidates).toBe(1280);
    expect(tx.receipt.changes).toHaveLength(1280);
    expect(tx.receipt.dirtyChunks).toHaveLength(64);
    expect(tx.receipt.reward).toBe(3840);
    expect(f.stateRevision).toBe(0);
    tx.commit();
    expect(f.terrainRevision).toBe(1);
    expect(new TerrainField(c, f.snapshot()).snapshot()).toEqual(f.snapshot());
    expect(() => stageTerrainEdits(f, [...effects, effects[0]])).toThrow(/cap/);
  });
  it("compares optimized queries to a full-field reference on random cells, corners and chunk seams", () => {
    const c = content();
    let seed = 98765;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    for (let y = 10; y < 118; y++)
      for (let x = 10; x < 118; x++) if (rand(7) === 0) paint(c, x, y);
    const f = new TerrainField(c),
      solids: { id: number; rect: CaveRect }[] = [];
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 128; x++)
        if (f.cell(x, y).solid)
          solids.push({
            id: y * 128 + x,
            rect: { x: x * 1024, y: y * 1024, width: 1024, height: 1024 },
          });
    for (let n = 0; n < 180; n++) {
      const body = {
          x: (10 + rand(100)) * 1024 + (n % 3 ? rand(1024) : 0),
          y: (10 + rand(100)) * 1024 + (n % 3 ? rand(1024) : 0),
          width: 1 + rand(4096),
          height: 1 + rand(4096),
        },
        delta = { x: rand(8193) - 4096, y: rand(8193) - 4096 };
      const reference = (kind: "overlap" | "ray" | "sweep") =>
        solids
          .flatMap((s) => {
            const time =
              kind === "overlap"
                ? geometryOverlaps(body, s.rect)
                  ? { n: 0, d: 1 }
                  : null
                : kind === "ray"
                  ? referenceRay(body, delta, s.rect)
                  : geometrySweep(body, delta, s.rect);
            return time ? [{ id: s.id, time }] : [];
          })
          .sort((a, b) => compareGeometryTime(a.time, b.time) || a.id - b.id);
      const simple = (r: ReturnType<typeof raycastField>) =>
        r.contacts.map((h) => ({ id: h.cell.id, time: h.time }));
      expect(simple(overlapFieldAabb(f, body))).toEqual(reference("overlap"));
      expect(simple(raycastField(f, body, delta))).toEqual(reference("ray"));
      expect(simple(sweepFieldAabb(f, body, delta))).toEqual(
        reference("sweep"),
      );
    }
    const full = overlapFieldAabb(f, {
      x: 0,
      y: 0,
      width: 131072,
      height: 131072,
    });
    expect(full.counters.candidates).toBe(16384);
    expect(
      overlapFieldAabb(f, { x: -1, y: 1024, width: 1, height: 1 }).contacts[0]
        .cell.protected,
    ).toBe(true);
  });
  it("pins open-interior ray and sweep tangency, zero ray and endpoint policies", () => {
    const c = content();
    paint(c, 16, 16);
    const f = new TerrainField(c),
      x = 16384,
      y = 16384;
    expect(
      raycastField(f, { x: x + 512, y: y + 512 }, { x: 0, y: 0 }).contacts[0]
        .time,
    ).toEqual({ n: 0, d: 1 });
    expect(
      raycastField(f, { x, y: y + 512 }, { x: 0, y: 0 }).contacts[0].time,
    ).toEqual({ n: 0, d: 1 });
    expect(
      raycastField(f, { x: x - 1024, y }, { x: 1024, y: 0 }).contacts[0].time,
    ).toEqual({ n: 1024, d: 1024 });
    expect(
      raycastField(f, { x: x - 1024, y: y + 512 }, { x: 1024, y: 0 })
        .contacts[0].time,
    ).toEqual({ n: 1024, d: 1024 });
    expect(
      sweepFieldAabb(
        f,
        { x: x - 2048, y, width: 1024, height: 1024 },
        { x: 1024, y: 0 },
      ).contacts[0].time,
    ).toEqual({ n: 1024, d: 1024 });
    expect(
      sweepFieldAabb(
        f,
        { x: x - 1024, y, width: 1024, height: 1024 },
        { x: -512, y: 0 },
      ).contacts,
    ).toEqual([]);
    paint(c, 16, 15);
    const seam = new TerrainField(c),
      hits = raycastField(seam, { x: x - 1024, y }, { x: 4096, y: 0 });
    expect(hits.contacts.map((h) => h.cell.id)).toEqual([
      15 * 128 + 16,
      16 * 128 + 16,
    ]);
  });
  it("carves the complete16px cutter at all1024 transverse offsets in all four directions", () => {
    for (const direction of ["up", "right", "down", "left"] as const) {
      const c = content();
      for (let y = 15; y < 30; y++)
        for (let x = 15; x < 30; x++)
          if (
            direction === "up"
              ? y === 19
              : direction === "down"
                ? y === 22
                : direction === "left"
                  ? x === 19
                  : x === 22
          )
            paint(c, x, y);
      const f = new TerrainField(c);
      for (let offset = 0; offset < 1024; offset++) {
        const horizontal = direction === "right" || direction === "left",
          actor: CaveRect = {
            x: horizontal ? 20 * 1024 : 20 * 1024 + offset,
            y: horizontal ? 20 * 1024 + offset : 20 * 1024,
            width: 2048,
            height: 2048,
          };
        expect(overlapFieldAabb(f, actor).contacts).toHaveLength(0);
        const cells = drillFootprint(f, actor, direction, 4096);
        expect(cells.length).toBeGreaterThanOrEqual(4);
        const transverse = horizontal ? actor.y : actor.x;
        const lanes = new Set(
          cells.map((id) => (horizontal ? Math.floor(id / 128) : id % 128)),
        );
        for (
          let lane = Math.floor((transverse - 1024) / 1024);
          lane < Math.ceil((transverse + 3072) / 1024);
          lane++
        )
          expect(lanes.has(lane)).toBe(true);
        const preview = stageTerrainEdits(f, [
          {
            sourceId: "drill",
            sequence: offset,
            kind: "drill",
            cells,
            damage: 1024,
          },
        ]).preview();
        const contact =
          (direction === "up" || direction === "left" ? 19 : 22) * 1024;
        const corridor = horizontal
          ? { x: contact, y: actor.y - 1024, width: 1024, height: 4096 }
          : { x: actor.x - 1024, y: contact, width: 4096, height: 1024 };
        expect(overlapFieldAabb(preview, corridor).contacts).toHaveLength(0);
        const dx =
            direction === "right" ? 512 : direction === "left" ? -512 : 0,
          dy = direction === "down" ? 512 : direction === "up" ? -512 : 0;
        let moved = { x: actor.x, y: actor.y };
        for (let tick = 0; tick < 6; tick++)
          moved = moveCaveActor(preview, moved, dx, dy);
        expect(moved).toEqual({ x: actor.x + dx * 6, y: actor.y + dy * 6 });
      }
    }
  });
  it("stops at protected rock and never selects hidden cells, with bounded integer disks", () => {
    const c = content();
    for (let y = 18; y < 25; y++) {
      paint(c, 22, y);
      paint(c, 23, y);
    }
    for (let y = 18; y < 25; y++)
      (c.protected as boolean[])[y * 128 + 22] = true;
    const f = new TerrainField(c);
    expect(
      drillFootprint(
        f,
        { x: 20 * 1024, y: 20 * 1024, width: 2048, height: 2048 },
        "right",
        4096,
      ),
    ).toEqual([]);
    const disk = diskTerrainCells(f, { x: 22 * 1024, y: 22 * 1024 }, 4096);
    expect(disk.length).toBeLessThanOrEqual(81);
    expect(new Set(disk).size).toBe(disk.length);
    for (const id of disk) {
      const dx = (id % 128) * 1024 + 512 - 22 * 1024,
        dy = Math.floor(id / 128) * 1024 + 512 - 22 * 1024;
      expect(dx * dx + dy * dy).toBeLessThanOrEqual(4096 ** 2);
    }
  });
});
