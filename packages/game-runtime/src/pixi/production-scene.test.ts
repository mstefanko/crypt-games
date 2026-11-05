import { describe, expect, it } from "vitest";
import {
  pickProductionSite,
  productionActors,
  productionFootprint,
  type ProductionSceneState,
} from "./production-scene";
import { harborScene } from "../../../../apps/audio-arcade/src/games/harbor/scene";
import manifest from "../../../../apps/audio-arcade/public/assets/collection/harbor/manifest.json";
const state = (): ProductionSceneState => ({
  variation: 0,
  time: 1,
  selected: 0,
  pending: [],
  offset: { x: 0, y: 0 },
  outcome: "playing",
  sites: [
    {
      id: "lighthouse",
      name: "Lighthouse",
      cell: 7 * 16 + 12,
      kind: "lighthouse",
      cost: 12,
      repaired: false,
    },
  ],
  workers: [
    {
      id: "a",
      cell: 6 * 16 + 5,
      state: "carry-to-storage",
      travel: 0.175,
      path: [6 * 16 + 6],
      payload: { resource: "food", quantity: 2 },
    },
  ],
});
describe("semantic production composition", () => {
  it("maps cargo and continuous worker travel without crediting storage", () => {
    const s = state(),
      before = structuredClone(s),
      items = productionActors(s, harborScene, manifest.clips, 0);
    expect(items.find((i) => i.id === "a")?.x).toBe(172);
    expect(items.find((i) => i.id === "a")?.frame).toContain("carry.right");
    expect(items.find((i) => i.id === "a:cargo")?.frame).toBe("cargo.food");
    expect(s).toEqual(before);
  });
  it("binds restoration, selection footprint and departure to observations", () => {
    const s = state();
    expect(productionActors(s, harborScene, manifest.clips, 0)[0].frame).toBe(
      "building.lighthouse.dark",
    );
    s.sites = [{ ...s.sites[0], repaired: true }];
    expect(productionActors(s, harborScene, manifest.clips, 0)[0].frame).toBe(
      "building.lighthouse.lit",
    );
    expect(pickProductionSite(s, harborScene, 400, 240)).toBe(0);
    expect(pickProductionSite(s, harborScene, 30, 30)).toBeUndefined();
    expect(productionFootprint(s, harborScene)).toEqual({
      x: 384,
      y: 226,
      width: 32,
      height: 28,
    });
    const ship = productionActors(s, harborScene, manifest.clips, 1).find(
      (i) => i.id === "rescue-ship",
    )!;
    expect(ship.x).toBe(566);
    expect(ship.alpha).toBeCloseTo(0);
  });
  it("uses distinct workshop foundation, construction and complete poses", () => {
    const s = state();
    s.sites = [
      { ...s.sites[0], id: "workshop", kind: "producer", repaired: false },
    ];
    expect(productionActors(s, harborScene, manifest.clips, 0)[0].frame).toBe(
      "building.workshop.foundation",
    );
    s.pending = ["workshop"];
    expect(productionActors(s, harborScene, manifest.clips, 0)[0].frame).toBe(
      "building.workshop.construction",
    );
    s.sites = [{ ...s.sites[0], repaired: true }];
    const ready = productionActors(s, harborScene, manifest.clips, 0)[0];
    expect(ready.frame).toBe("building.workshop");
    expect(ready.height / ready.width).toBe(2);
  });
  it("has every semantic frame and authored directional clip in the manifest", () => {
    for (const s of Object.values(harborScene.sites)) {
      expect(manifest.frames).toHaveProperty(s.frame);
      if (s.repairedFrame)
        expect(manifest.frames).toHaveProperty(s.repairedFrame);
    }
    for (const direction of ["left", "right", "up", "down"])
      for (const action of ["idle", "walk", "carry", "tool"])
        expect(manifest.clips).toHaveProperty(`worker.${action}.${direction}`);
    for (const resource of Object.values(harborScene.cargo))
      expect(manifest.frames).toHaveProperty(resource);
  });
});
