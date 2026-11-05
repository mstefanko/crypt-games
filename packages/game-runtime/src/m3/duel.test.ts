import { DEFAULT_M3_PROJECT } from "../../../../examples/game-m3/project.ts";
import { describe, it, expect } from "vitest";
import { DuelGame } from "./duel.ts";
import { InputQueue } from "../input.ts";
const identity = { rulesBuildId: "duel-test", contentId: "fixture-v1" };
describe("M3 local duel reuses M2 combat", () => {
  it("gathers trades for both semantic slots and round-trips full hit-stop and held state", () => {
    const game = new DuelGame(DEFAULT_M3_PROJECT.duel, identity),
      queue = new InputQueue();
    queue.set("first", 0, "attack", true);
    queue.set("second", 1, "attack", true);
    let hitstop = false;
    for (let tick = 0; tick < 20; tick++) {
      game.step(queue.consume());
      const actors = game.observation().actors;
      if (actors.every((a) => a.health < 8)) {
        hitstop = actors.every((a) => a.freezeTicks > 0);
        break;
      }
    }
    expect(hitstop).toBe(true);
    expect(game.observation().actors.map((a) => a.health)).toEqual([6, 6]);
    const bytes = game.checkpoint(),
      restored = new DuelGame(DEFAULT_M3_PROJECT.duel, identity);
    restored.restore(bytes);
    expect(restored.checkpoint()).toBe(bytes);
    queue.cancelAll();
    const cancel = queue.consume();
    game.step(cancel);
    restored.step(cancel);
    expect(restored.checkpoint()).toBe(game.checkpoint());
  });
  it("guards independently, rejects mismatched identity atomically, and rematches twenty times", () => {
    const game = new DuelGame(DEFAULT_M3_PROJECT.duel, identity),
      queue = new InputQueue();
    queue.set("first", 0, "attack", true);
    queue.set("guard", 1, "guard", true);
    for (let t = 0; t < 20; t++) game.step(queue.consume());
    expect(game.observation().actors[1].health).toBe(8);
    const before = game.checkpoint();
    expect(() =>
      game.restore(before.replace("duel-test", "wrong-rules")),
    ).toThrow();
    expect(game.checkpoint()).toBe(before);
    for (let n = 0; n < 20; n++) {
      game.restart();
      expect(game.observation().actors.map((a) => a.health)).toEqual([8, 8]);
      expect(game.observation().actors.map((a) => a.slot)).toEqual([0, 1]);
    }
  });
});
