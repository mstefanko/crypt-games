import { expect, it, vi } from "vitest";
const commands = vi.hoisted(() => vi.fn());
vi.mock("@onepage/game-simulation/combat-run-session", () => ({
  CombatRunSession: class {
    command = commands;
    observe() { return {}; }
    step() {}
    drainEvents() { return []; }
  },
}));
import { createCinder } from "../../../../apps/audio-arcade/src/games/cinder";
it("keeps Cinder movement held-only and combat commands as deduplicated pulses", () => {
  const game = createCinder(1);
  const input = (held: string[], pressed: string[], action?: string) => ({
    held: new Set(held), pressed: new Set(pressed), released: new Set<string>(),
    pointer: { x: 0, y: 0, down: false, pressed: false, released: false }, action,
  });
  game.update(0, input(["KeyA", "KeyW", "KeyS", "KeyJ"], ["KeyJ", "KeyA", "KeyW", "KeyS"], "attack"));
  expect(commands).toHaveBeenLastCalledWith({ type: "input", left: true, right: false,
    jump: true, drop: true, actions: ["attack"] });
  game.update(0, input(["KeyJ"], []));
  expect(commands).toHaveBeenLastCalledWith({ type: "input", left: false, right: false,
    jump: false, drop: false, actions: [] });
  game.update(0, input([], [], "jump"));
  expect(commands).toHaveBeenLastCalledWith({ type: "input", left: false, right: false,
    jump: true, drop: false, actions: ["jump"] });
  game.update(0, input([], ["Enter"]));
  expect(commands).toHaveBeenLastCalledWith({ type: "retry" });
});
