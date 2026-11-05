import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateDefinitions } from "../../game-project/src/index";
import type { Action, Held } from "../../game-project/src/runtime";
import type { TickEvent } from "./index";
import {
  cancelFrame,
  createWorld,
  neutralHeld,
  observe,
  restoreCheckpoint,
  serializeCheckpoint,
  step,
} from "./index";

// Independent supervisor acceptance test: use the shipping documents and legal
// semantic input only. No coordinate writes or altered enemy/controller tuning.
const base = new URL("../../../examples/game-m1/", import.meta.url);
const read = (path: string) =>
  JSON.parse(readFileSync(new URL(path, base), "utf8"));
const manifest = read("game.project.json");
const definitions = validateDefinitions({
  manifest,
  levels: manifest.levelIds.map((id: string) => read(`levels/${id}.json`)),
  archetypes: manifest.archetypeIds.map((id: string) =>
    read(`archetypes/${id}.json`),
  ),
  abilities: manifest.abilityIds.map((id: string) =>
    read(`abilities/${id}.json`),
  ),
  scenarios: manifest.scenarioIds.map((id: string) =>
    read(`scenarios/${id}.json`),
  ),
});
const identity = {
  rulesBuildId: "supervisor-fixture",
  contentId: "shipping-documents",
};

describe("shipping tiny objective through legal inputs", () => {
  it("traverses both authored rooms, uses both strikes and wins; restoring mid-run preserves the outcome", () => {
    let world = createWorld(definitions, identity);
    let previous: Held = neutralHeld();
    const events: TickEvent[] = [];
    const initialObservation = observe(world);
    const initialBytes = JSON.stringify(initialObservation);
    let checkpointWasAirborne = false;
    for (let tick = 0; tick < 900 && world.status === "playing"; tick++) {
      const held: Held = {
        left: false,
        right: true,
        jump: tick % 28 === 0,
        attack: tick % 25 === 0,
        heavy: tick % 41 === 0,
        guard: false,
      };
      const edges = (Object.keys(held) as Action[])
        .filter((action) => held[action] !== previous[action])
        .map((action) => ({
          action,
          kind: held[action] ? ("pressed" as const) : ("released" as const),
        }));
      const frame = { slots: [{ slot: 0, held, axes: { moveX: 127 }, edges }] };
      events.push(...step(world, frame));
      if (tick === 90) {
        checkpointWasAirborne = !world.actors[0].grounded;
        const bytes = serializeCheckpoint(world);
        const restored = restoreCheckpoint(definitions, identity, bytes);
        expect(serializeCheckpoint(restored)).toBe(bytes);
        world = restored;
      }
      previous = held;
    }
    expect(world.status).toBe("won");
    expect(world.levelId).toBe("room-2");
    expect(world.campaign.visitedLevelIds).toEqual(["room-1", "room-2"]);
    expect(events.filter((event) => event.type === "level")).toHaveLength(1);
    expect(
      new Set(
        events
          .filter((event) => event.type === "strike")
          .map((event) => event.abilityId),
      ),
    ).toEqual(new Set(["quick-strike", "heavy-strike"]));
    expect(checkpointWasAirborne).toBe(true);
    expect(JSON.stringify(initialObservation)).toBe(initialBytes);
  });

  it("loses to the real sentinel, then restarts with fresh entity identity and no held controls", () => {
    const world = createWorld(definitions, identity);
    const firstId = world.actors[0].id;
    const firstEpoch = world.actors[0].motionEpoch;
    for (let tick = 0; tick < 600 && world.status === "playing"; tick++)
      step(world);
    expect(world.status).toBe("lost");
    expect(world.actors[0].health).toBe(0);
    const frame = cancelFrame(world.decoder);
    frame.commands = [{ type: "restart" }];
    step(world, frame);
    expect(world.status).toBe("playing");
    expect(world.levelId).toBe("room-1");
    expect(world.actors[0].health).toBe(definitions.archetypes[0].health);
    expect(world.actors[0].id).toBeGreaterThan(firstId);
    expect(world.actors[0].motionEpoch).toBeGreaterThan(firstEpoch);
    expect(
      world.decoder.slots.every((slot) =>
        Object.values(slot.held).every((value) => !value),
      ),
    ).toBe(true);
  });
});
