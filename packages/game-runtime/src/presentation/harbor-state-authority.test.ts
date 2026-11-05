import { expect, it, vi } from "vitest";
vi.mock("@onepage/game-runtime/pixi/tile-production", () => ({
  SemanticProductionPresenter: class {
    state: unknown;
    restore(value: unknown) {
      this.state = structuredClone(value);
    }
    snapshot() {
      return this.state;
    }
  },
}));
import { createHarbor } from "../../../../apps/audio-arcade/src/games/harbor";
it("upgrades legacy Harbor saves and rejects camera/owner corruption atomically", () => {
  const game = createHarbor(311);
  const before = game.snapshot!() as {
    simulation: Record<string, unknown>;
    cameraX: number;
    cameraY: number;
  };
  const legacy = {
    ...before.simulation,
    cameraX: before.cameraX,
    cameraY: before.cameraY,
  } as Record<string, unknown>;
  delete legacy.version;
  delete legacy.seed;
  delete legacy.kind;
  delete legacy.contentId;
  delete legacy.rulesBuildId;
  delete legacy.event;
  game.restore!(legacy);
  expect(game.snapshot!()).toEqual(before);
  for (const invalid of [
    { ...before, version: 1, cameraX: Infinity },
    {
      ...before,
      version: 1,
      simulation: { ...before.simulation, workers: { workers: [], jobs: [] } },
    },
  ]) {
    expect(() => game.restore!(invalid)).toThrow();
    expect(game.snapshot!()).toEqual(before);
  }
});

it("preserves detached pre-mount Harbor presentation through save and mount", () => {
  const game = createHarbor(311);
  const initial = game.snapshot!() as object;
  const presentation = { version: 1, shipPhase: 0.75, lastOutcome: "won" };
  game.restore!({ ...initial, presentation });
  presentation.shipPhase = 0;
  expect(game.snapshot!()).toMatchObject({ presentation: { shipPhase: 0.75 } });
  game.createPresenter!(undefined as never);
  expect(game.snapshot!()).toMatchObject({ presentation: { shipPhase: 0.75 } });
  game.restore!(initial);
  expect(game.snapshot!()).toEqual(initial);
});
