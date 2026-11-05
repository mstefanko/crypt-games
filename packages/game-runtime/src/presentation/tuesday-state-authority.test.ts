import { expect, it, vi } from "vitest";
vi.mock(
  "@onepage/game-runtime/narrative-presenter",
  async (importOriginal) => ({
    ...(await importOriginal<typeof import("./narrative-presenter")>()),
    NarrativePresenter: class {},
  }),
);
import { createTuesday } from "../../../../apps/audio-arcade/src/games/tuesday";
it("rejects owner/presentation/sequence corruption before changing Tuesday wrapper state", () => {
  const game = createTuesday(743),
    before = game.snapshot!() as any;
  const presentation = {
    queue: { epoch: 0, paused: [], seen: [], pending: [] },
    cueCursor: 0,
    textScale: 22,
  };
  const saved = { ...before, presentation };
  game.restore!(saved);
  const accepted = game.snapshot!();
  presentation.textScale = 16;
  expect(game.snapshot!()).toEqual(accepted);
  for (const mutate of [
    (v: any) => {
      v.sequence = 200;
      v.simulation.owner.state.player.x = NaN;
    },
    (v: any) => {
      v.presentation.queue.pending = [{ id: "bad", time: NaN, started: false }];
    },
    (v: any) => {
      v.sequence = -1;
    },
  ]) {
    const v = structuredClone(accepted);
    mutate(v);
    expect(() => game.restore!(v)).toThrow();
    expect(game.snapshot!()).toEqual(accepted);
  }
  const owner = before.simulation.owner;
  delete owner.identity;
  game.restore!({ sequence: 0, simulation: owner, presentation: undefined });
  expect(game.snapshot!()).toMatchObject({
    simulation: { kind: "narrative-protocol", tick: 0, sequence: 0 },
  });
});
