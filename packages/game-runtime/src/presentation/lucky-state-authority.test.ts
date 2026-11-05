import { expect, it, vi } from "vitest";
vi.mock("@onepage/game-runtime/card-run-presenter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./card-run-presenter")>()),
  CardRunPresenter: class {},
}));
import { createLucky } from "../../../../apps/audio-arcade/src/games/lucky";

it("keeps the Lucky wrapper unchanged when simulation restore is rejected", () => {
  const game = createLucky(12);
  const before = game.snapshot!();
  const invalid = structuredClone(before) as any;
  invalid.sequence = 200;
  invalid.simulation.state.money = NaN;
  expect(() => game.restore!(invalid)).toThrow();
  expect(game.snapshot!()).toEqual(before);
});

it("validates and detaches Lucky pending presentation before adopting a save", () => {
  const game = createLucky(12),
    before = game.snapshot!() as any;
  const presentation = {
    queue: { epoch: 0, paused: [], seen: [], pending: [] },
    visible: "score",
  };
  game.restore!({ ...before, presentation });
  const accepted = game.snapshot!();
  presentation.visible = "changed";
  expect(game.snapshot!()).toEqual(accepted);
  const invalid = structuredClone(accepted) as any;
  invalid.presentation.queue.pending = [
    { id: "broken", time: NaN, started: false },
  ];
  expect(() => game.restore!(invalid)).toThrow();
  expect(game.snapshot!()).toEqual(accepted);
});
