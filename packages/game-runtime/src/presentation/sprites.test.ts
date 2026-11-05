import { describe, expect, it } from "vitest";
import { sampleAtlasAnimation, orderPresentation } from "./sprites.ts";
import { frameAtTick } from "../../../assets-core/src/pixels.ts";
import type { AssetFrame } from "../../../assets-core/src/types.ts";
describe("V0b stable layer and atlas primitives", () => {
  it("uses layer, depth and lexical stable identity across insertion permutations", () => {
    const items = [
      { id: "b", layer: 20, depth: 1 },
      { id: "a", layer: 20, depth: 1 },
      { id: "terrain", layer: 0, depth: 99 },
      { id: "front", layer: 20, depth: 2 },
    ];
    expect(orderPresentation(items).map((item) => item.id)).toEqual([
      "terrain",
      "a",
      "b",
      "front",
    ]);
    expect(orderPresentation([...items].reverse())).toEqual(
      orderPresentation(items),
    );
    expect(items[0].id).toBe("b");
    expect(() => orderPresentation([items[0], items[0]])).toThrow();
    expect(() =>
      orderPresentation([{ id: "a", layer: 0, depth: NaN }]),
    ).toThrow();
    expect(() =>
      orderPresentation(
        Array.from({ length: 4097 }, (_, id) => ({
          id: String(id),
          layer: 0,
          depth: 0,
        })),
      ),
    ).toThrow();
  });
  it("matches established duration/loop/clamp behavior including accepted 256-frame clips", () => {
    const frames = Array.from(
      { length: 256 },
      (_, i) =>
        ({
          id: `f${i}`,
          durationTicks: (i % 4) + 1,
          visual: {
            kind: "raster",
            mediaId: "atlas",
            x: 0,
            y: 0,
            width: 1,
            height: 1,
          },
        }) satisfies AssetFrame,
    );
    for (const loop of [true, false])
      for (const tick of [-1000, -1, 0, 0.9, 1, 639, 640, 100000])
        expect(sampleAtlasAnimation(frames, tick, loop)).toBe(
          frameAtTick({ direction: "right", frames }, tick, loop),
        );
    expect(
      sampleAtlasAnimation([{ id: "bad", durationTicks: 0 }], 0),
    ).toBeUndefined();
    expect(sampleAtlasAnimation(frames, NaN)).toBeUndefined();
    expect(sampleAtlasAnimation([], 0)).toBeUndefined();
    expect(sampleAtlasAnimation([...frames, frames[0]], 0)).toBeUndefined();
  });
});
