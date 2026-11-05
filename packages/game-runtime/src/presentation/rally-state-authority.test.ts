import { afterEach, expect, it, vi } from "vitest";
vi.mock("@onepage/game-runtime/pixi/kart-race-presenter", () => ({
  KartRacePresenter: class {},
}));
import * as raceSession from "@onepage/game-simulation/kart-race-session";
import { createRally } from "../../../../apps/audio-arcade/src/games/rally";
function game() {
  const context = new Proxy({}, { get: () => () => {}, set: () => true });
  vi.stubGlobal("document", {
    createElement: () => ({ getContext: () => context }),
  });
  return createRally(419);
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("restores new and legacy Rally checkpoints and rejects wrapper corruption atomically", () => {
  const a = game();
  const saved = a.snapshot!() as {
    version: number;
    simulation: Record<string, unknown>;
    seed: number;
    cameraHeading: number;
  };
  a.restore!(JSON.parse(JSON.stringify(saved)));
  expect(a.snapshot!()).toEqual(saved);
  const legacy = {
    ...saved.simulation,
    version: 1,
    cameraHeading: saved.cameraHeading,
  };
  a.restore!(legacy);
  const upgraded = a.snapshot!();
  expect(upgraded).toMatchObject({
    version: 2,
    simulation: { kind: "kart-race", seed: 419 },
  });
  for (const invalid of [
    { ...saved, cameraHeading: NaN },
    { ...saved, seed: 1 },
    { ...saved, simulation: { ...saved.simulation, karts: [] } },
  ]) {
    expect(() => a.restore!(invalid)).toThrow();
    expect(a.snapshot!()).toEqual(upgraded);
  }
});

it("keeps physical and semantic Rally pulses equivalent and coalesces coincidence", () => {
  const input = (pressed: string[] = [], action?: string) => ({
    held: new Set<string>(),
    pressed: new Set(pressed),
    released: new Set<string>(),
    pointer: { x: 0, y: 0, down: false, pressed: false, released: false },
    action,
  });
  for (const [code, action] of [
    ["Digit2", "cart2"],
    ["KeyE", "item"],
    ["KeyR", "reset"],
    ["Enter", "retry"],
  ]) {
    const physical = game(),
      semantic = game(),
      coincident = game(),
      legacy = game();
    physical.update(0.05, input([code!]));
    semantic.update(0.05, input([], action));
    coincident.update(0.05, input([code!], action));
    legacy.update(0.05, input([], code));
    expect(coincident.snapshot!()).toEqual(physical.snapshot!());
    expect(legacy.snapshot!()).toEqual(physical.snapshot!());
    // Enter historically requests both item and retry; named retry requests only retry.
    if (code !== "Enter")
      expect(semantic.snapshot!()).toEqual(physical.snapshot!());
    physical.update(0.05, input());
    coincident.update(0.05, input());
    expect(coincident.snapshot!()).toEqual(physical.snapshot!());
  }
});

it("preserves the legacy item pulse as both item and retry without making it held", () => {
  const createSession = raceSession.createKartRaceSession;
  const commands = vi.fn();
  vi.spyOn(raceSession, "createKartRaceSession").mockImplementation((...args) => {
    const owner = createSession(...args);
    return { ...owner, command: (command) => { commands(command); return owner.command(command); } };
  });
  const item = game(), enter = game();
  const input = (action?: string) => ({
    held: new Set<string>(), pressed: new Set<string>(), released: new Set<string>(),
    pointer: { x: 0, y: 0, down: false, pressed: false, released: false }, action,
  });
  item.update(0.05, input("item"));
  expect(commands).toHaveBeenLastCalledWith(expect.objectContaining({ useItem: true, retry: true, throttle: false }));
  enter.update(0.05, input("Enter"));
  expect(item.snapshot()).toEqual(enter.snapshot());
  item.update(0.05, input());
  enter.update(0.05, input());
  expect(item.snapshot()).toEqual(enter.snapshot());
});
