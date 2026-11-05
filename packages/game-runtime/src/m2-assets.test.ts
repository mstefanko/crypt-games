import { describe, it, expect } from "vitest";
import copperRaw from "../../../examples/game-m2/prepared-assets/copper.json";
import moonRaw from "../../../examples/game-m2/prepared-assets/moon.json";
import definitionsRaw from "../../../examples/game-m1/definitions.json";
import { validateDefinitions } from "../../game-project/src/index.ts";
import {
  createWorld,
  createInputDecoder,
  decodeInputRecords,
  step,
  serializeCheckpoint,
  observe,
} from "../../game-simulation/src/index.ts";
import {
  sampleSkin,
  skinPlacement,
  showsGuard,
  actorSkinAction,
  type PreparedSkin,
} from "./m2-assets.ts";
import manifest from "../../../examples/game-m2/game.project.json";
import level from "../../../examples/game-m2/levels/lantern-path.json";
import hero from "../../../examples/game-m2/archetypes/hero.json";
import sentinel from "../../../examples/game-m2/archetypes/sentinel.json";
import quick from "../../../examples/game-m2/abilities/quick-strike.json";
import heavy from "../../../examples/game-m2/abilities/heavy-strike.json";
import start from "../../../examples/game-m2/scenarios/start.json";
import flow from "../../../examples/game-m2/flow.json";
import { M2Game } from "./m2-game.ts";
import { InputQueue } from "./input.ts";
const skins = [copperRaw, moonRaw] as unknown as PreparedSkin[];
describe("M2 pinned Assets presentation", () => {
  it("shows held guard in both skins and clears on release, stun or death while retaining attack priority", () => {
    const actor = {
      slot: 0,
      health: 8,
      stunTicks: 0,
      abilityId: null,
      grounded: true,
    };
    expect(showsGuard(actor, true)).toBe(true);
    expect(showsGuard(actor, false)).toBe(false);
    expect(actorSkinAction(actor, false, true)).toBe("guard");
    expect(actorSkinAction(actor, false, false)).toBe("idle");
    for (const skin of skins)
      for (const facing of [-1, 1] as const) {
        const sample = sampleSkin(
          skin,
          "hero",
          actorSkinAction(actor, false, true),
          0,
          facing,
        );
        expect(sample.frame.id).toContain("-guard-");
        expect(sample.mirrored).toBe(facing === -1);
      }
    for (const blocked of [
      { ...actor, health: 0 },
      { ...actor, stunTicks: 3 },
    ]) {
      expect(showsGuard(blocked, true)).toBe(false);
      expect(actorSkinAction(blocked, false, true)).toBe("hurt");
    }
    expect(showsGuard({ ...actor, slot: null }, true)).toBe(false);
    expect(
      actorSkinAction({ ...actor, abilityId: "heavy-strike" }, false, true),
    ).toBe("heavy");
    expect(
      actorSkinAction({ ...actor, abilityId: "quick-strike" }, false, true),
    ).toBe("attack");
  });
  it("keeps every full M2 gameplay checkpoint byte identical through 20 actionful encounter, skip and restart loops", () => {
    const definitions = {
      manifest,
      levels: [level],
      archetypes: [hero, sentinel],
      abilities: [quick, heavy],
      scenarios: [start],
    };
    const runs = skins.map(
      () =>
        new M2Game(
          definitions,
          flow,
          { rulesBuildId: "m2-assets-rules", contentId: "m2-assets-content" },
          "m2-assets-flow",
          ["lantern-ending"],
        ),
    );
    for (let cycle = 0; cycle < 20; cycle++) {
      runs.forEach((run) => run.signal("start"));
      const input = new InputQueue();
      for (let tick = 0; tick < 500 && runs[0].kind === "play"; tick++) {
        input.set("right", 0, "right", true);
        input.set("heavy", 0, "heavy", tick % 40 === 0);
        input.set("attack", 0, "attack", tick % 40 === 20);
        const frame = input.consume();
        runs.forEach((run, i) => {
          run.tick(structuredClone(frame));
          for (const actor of run.observation().actors)
            sampleSkin(
              skins[i],
              actor.slot === null ? "sentinel" : "hero",
              actor.abilityId?.includes("heavy")
                ? "heavy"
                : actor.abilityId
                  ? "attack"
                  : "walk",
              actor.abilityId ? actor.abilityTick : tick,
              actor.facing,
            );
        });
        expect(runs[0].gameplayCheckpoint()).toBe(runs[1].gameplayCheckpoint());
      }
      expect(runs[0].kind).toBe("cinematic");
      expect(runs[1].kind).toBe("cinematic");
      runs.forEach((run) => {
        run.signal("skip");
        run.signal("restart");
      });
      expect(runs[0].gameplayCheckpoint()).toBe(runs[1].gameplayCheckpoint());
    }
  });

  it("uses frame timing, trim and authored sockets in both facings", () => {
    for (const skin of skins) {
      const a = sampleSkin(skin, "hero", "walk", 7, 1),
        b = sampleSkin(skin, "hero", "walk", 8, 1);
      expect(a.frame.id).not.toBe(b.frame.id);
      expect(a.frame.trim.y).toBeGreaterThan(0);
      const right = skinPlacement(a, 100, 100),
        left = skinPlacement(sampleSkin(skin, "hero", "walk", 7, -1), 100, 100);
      expect(right.hand.x - 100).toBe(100 - left.hand.x);
      expect(right.hand.y).toBe(left.hand.y);
      expect(right.scaleX).toBe(1);
      expect(left.scaleX).toBe(-1);
    }
    expect(sampleSkin(skins[0], "hero", "idle", 0, 1).frame.trim).not.toEqual(
      sampleSkin(skins[1], "hero", "idle", 0, 1).frame.trim,
    );
  });
  it("reports fallback and rejects missing variants/directions", () => {
    expect(sampleSkin(skins[0], "hero", "unknown", 0, 1).diagnostic).toContain(
      "SKIN_ACTION_FALLBACK",
    );
    const broken = structuredClone(skins[0]);
    broken.variants = [];
    expect(() => sampleSkin(broken, "hero", "idle", 0, 1)).toThrow(
      "missing hero",
    );
    const missingFacing = structuredClone(skins[0]);
    missingFacing.variants[0].actions[0].directions =
      missingFacing.variants[0].actions[0].directions.filter(
        (clip) => clip.direction !== "left",
      );
    expect(() => sampleSkin(missingFacing, "hero", "idle", 0, -1)).toThrow(
      "missing idle:left",
    );
    expect(() => sampleSkin(skins[0], "hero", "idle", NaN, 1)).toThrow(
      "invalid animation tick",
    );
  });
  it("preserves full gameplay checkpoint bytes under the identical 10000-tick semantic log", () => {
    const definitions = validateDefinitions(definitionsRaw),
      identity = { rulesBuildId: "m2-skin-test", contentId: "same-content" };
    const worlds = skins.map(() =>
      createWorld(definitions, identity, "active-mechanics"),
    );
    const decoders = skins.map(() => createInputDecoder());
    const scenario = definitions.scenarios.find(
      (s) => s.id === "active-mechanics",
    )!;
    for (let tick = 0; tick < 10000; tick++) {
      for (const [i, world] of worlds.entries()) {
        const local = tick;
        const records = scenario.actions
          .filter((record) => record.tick === local)
          .map((record) => ({
            ...record,
            tick,
            sequence: record.sequence,
          }));
        const frame = decodeInputRecords(decoders[i], tick, records);
        if (local === 300 || tick % 600 === 599)
          frame.commands = [{ type: "restart" }];
        step(world, frame);
        for (const actor of observe(world).actors) {
          sampleSkin(
            skins[i],
            actor.slot === null ? "sentinel" : "hero",
            actor.hit ? "attack" : "walk",
            tick,
            actor.facing as -1 | 1,
          );
        }
      }
      expect(serializeCheckpoint(worlds[0])).toBe(
        serializeCheckpoint(worlds[1]),
      );
    }
  });
});
