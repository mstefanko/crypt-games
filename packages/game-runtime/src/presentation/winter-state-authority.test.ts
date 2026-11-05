import { expect, it, vi } from "vitest";
vi.mock("@onepage/game-runtime/pixi/settlement-presenter", () => ({
  SettlementPresenter: class {
    restore() {}
    snapshot() {
      return undefined;
    }
  },
}));
import { createWinter } from "../../../../apps/audio-arcade/src/games/winter";

function presentation() {
  const spring = {
    x: 0,
    y: 0,
    rotation: 0,
    scale: 1,
    target: { x: 0, y: 0, rotation: 0, scale: 1 },
    velocity: { x: 0, y: 0, rotation: 0, scale: 0 },
    pulse: 0,
  };
  return {
    notice: "saved",
    panX: 0,
    panY: 0,
    zoom: 1,
    weatherTime: 0,
    ghostSpring: structuredClone(spring),
    noticeSpring: structuredClone(spring),
    queue: { epoch: 0, paused: [], seen: [], pending: [] },
  };
}

it("keeps Winter simulation and pending presentation unchanged after rejected restore", () => {
  const game = createWinter(12);
  const before = game.snapshot!();
  const invalid = structuredClone(before) as any;
  invalid.presentation = { ...presentation(), notice: "changed" };
  invalid.simulation.people[0].health = NaN;
  expect(() => game.restore!(invalid)).toThrow();
  expect(game.snapshot!()).toEqual(before);
});

it("detaches Winter pending presentation from save inputs and observations", () => {
  const game = createWinter(12);
  const checkpoint = game.snapshot!() as any;
  checkpoint.presentation = presentation();
  game.restore!(checkpoint);
  checkpoint.presentation.notice = "input mutation";
  const observed = game.snapshot!() as any;
  expect(observed.presentation.notice).toBe("saved");
  observed.presentation.notice = "observation mutation";
  expect((game.snapshot!() as any).presentation.notice).toBe("saved");
});

it("rejects malformed presentation before committing a valid changed simulation", () => {
  const game = createWinter(12);
  game.createPresenter!(undefined as any);
  const before = game.snapshot!();
  const candidate = structuredClone(before) as any;
  candidate.simulation.message = "valid changed message";
  candidate.presentation = { notice: "malformed" };
  expect(() => game.restore!(candidate)).toThrow();
  expect(game.snapshot!()).toEqual(before);
});

it("rejects sparse presentation queues before committing simulation", () => {
  const game = createWinter(12);
  game.createPresenter!(undefined as any);
  const before = game.snapshot!();
  for (const field of ["paused", "seen", "pending"]) {
    const candidate = structuredClone(before) as any;
    candidate.simulation.message = "valid changed message";
    candidate.presentation = presentation();
    candidate.presentation.queue[field] = new Array(1);
    expect(() => game.restore!(candidate)).toThrow();
    expect(game.snapshot!()).toEqual(before);
  }
});
