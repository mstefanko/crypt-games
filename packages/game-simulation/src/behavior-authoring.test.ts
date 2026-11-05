import { expect, it } from "vitest";
import defaults from "../../../examples/game-exploration/behaviors.json";
import { prepareCampaignBehaviorDocument } from "./behavior-authoring";
import {
  createExplorationCampaign,
  createExplorationGame,
  explorationInput,
  EXPLORATION_CAMPAIGN,
} from "./exploration-game";
import { createBehaviorActor, stepBehavior } from "./behavior";
it("prepares defaults without changing exact campaign definition", () => {
  expect(createExplorationCampaign(defaults)).toEqual(EXPLORATION_CAMPAIGN);
  expect(
    EXPLORATION_CAMPAIGN.rooms.every((r) =>
      r.behaviors?.every((b) => !b.parameters),
    ),
  ).toBe(true);
});
it("diagnoses unknown fields, malformed documents and bounds at source pointers", () => {
  for (const value of [0, 121, -0, 1.5, "2", null]) {
    const doc = structuredClone(defaults) as any;
    doc.rooms.gallery.sentinel.windup = value;
    try {
      prepareCampaignBehaviorDocument(doc, "source.json");
      throw Error("accepted");
    } catch (error: any) {
      expect(error.diagnostics[0]).toMatchObject({
        file: "source.json",
        jsonPointer: "/rooms/gallery/sentinel/windup",
      });
    }
  }
  const doc = structuredClone(defaults) as any;
  doc.rooms.gallery.sentinel.damage = 9;
  expect(() => prepareCampaignBehaviorDocument(doc)).toThrow("Unknown");
  delete doc.rooms.gallery.sentinel.damage;
  delete doc.rooms.gallery.sentinel.range;
  expect(() => prepareCampaignBehaviorDocument(doc)).toThrow("Missing");
});
it("edited parameters affect real campaign and exact saves reject other definitions atomically", () => {
  const doc = structuredClone(defaults);
  doc.rooms.gallery.sentinel.windup = 30;
  const live = createExplorationGame(doc),
    restored = createExplorationGame(doc);
  live.executeFrames(explorationInput(127), 26);
  live.execute({ kind: "exit", id: "to-gallery" });
  let sawEdited = false;
  for (let i = 0; i < 100; i++) {
    live.executeFrames(explorationInput());
    if (live.observation().behaviors[0].actor.timer === 30) {
      sawEdited = true;
      break;
    }
  }
  expect(sawEdited).toBe(true);
  const checkpoint = live.checkpoint();
  restored.restore(checkpoint);
  for (let i = 0; i < 40; i++) {
    restored.executeFrames(explorationInput());
    live.executeFrames(explorationInput());
    expect(restored.checkpoint()).toBe(live.checkpoint());
  }
  const unchanged = createExplorationGame(),
    before = unchanged.checkpoint();
  expect(() => unchanged.restore(live.checkpoint())).toThrow();
  expect(unchanged.checkpoint()).toEqual(before);
  const params = doc.rooms.gallery.sentinel;
  const actor = { ...createBehaviorActor("bruiser"), position: 0 };
  expect(
    stepBehavior(actor, { target: 0, threatened: false }, params).actor.timer,
  ).toBe(30);
  expect(
    stepBehavior(actor, { target: 0, threatened: false }).actor.timer,
  ).toBe(2);
  expect(() =>
    stepBehavior(
      { ...actor, state: "windup", timer: 31 },
      { target: 0, threatened: false },
      params,
    ),
  ).toThrow();
});

it("validates saved behavior timers against the edited placement, including parameter mismatch", async () => {
  const { createCampaignBehaviors, validateCampaignBehaviors } = await import(
    "./campaign-behavior"
  );
  const parameters = { range: 2, windup: 30, recovery: 20, retreat: 15 };
  const placements = [
    { spawnId: "sentinel", role: "bruiser" as const, parameters },
  ];
  const state = createCampaignBehaviors(placements);
  const saved = [
    {
      ...state[0],
      actor: { ...state[0].actor, state: "windup" as const, timer: 30 },
    },
  ];
  expect(validateCampaignBehaviors(saved, placements)).toEqual(saved);
  expect(() =>
    validateCampaignBehaviors(
      [{ ...saved[0], actor: { ...saved[0].actor, timer: 31 } }],
      placements,
    ),
  ).toThrow();
  expect(() =>
    validateCampaignBehaviors(
      [{ ...saved[0], parameters: { ...parameters, range: 3 } }],
      placements,
    ),
  ).toThrow();
  expect(() =>
    validateCampaignBehaviors(
      [{ ...saved[0], actor: { ...saved[0].actor, extra: true } }],
      placements,
    ),
  ).toThrow();
});

it("resets edited placement parameters to defaults without retaining overrides", async () => {
  const { applyCampaignBehaviorDocument } = await import(
    "./behavior-authoring"
  );
  const doc = structuredClone(defaults);
  doc.rooms.gallery.sentinel.windup = 30;
  const edited = createExplorationCampaign(doc);
  expect(edited.rooms[1].behaviors![0].parameters!.windup).toBe(30);
  const reset = applyCampaignBehaviorDocument(edited, defaults);
  expect(reset).toEqual(EXPLORATION_CAMPAIGN);
  let read = false;
  const accessor = structuredClone(defaults);
  Object.defineProperty(accessor.rooms.gallery.sentinel, "range", {
    get() {
      read = true;
      return 1;
    },
    enumerable: true,
  });
  expect(() => prepareCampaignBehaviorDocument(accessor)).toThrow("Accessor");
  expect(read).toBe(false);
});
