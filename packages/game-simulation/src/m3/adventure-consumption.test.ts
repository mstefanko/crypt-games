import { it, expect } from "vitest";
import {
  createAdventure,
  applyAdventureCommand,
  serializeAdventureCheckpoint,
  restoreAdventureCheckpoint,
  type AdventureDefinitions,
} from "./adventure";
it("atomically consumes inventory and reconstructs consumed quest state", () => {
  const defs: AdventureDefinitions = {
    gameId: "test",
    characterId: "hero",
    compatibilityVersion: 1,
    initial: { mapId: "room", entranceId: "start" },
    items: [{ id: "medicine", stackable: false }],
    quests: ["delivery"],
    flags: { packed: false, delivered: false },
    stats: {},
    maps: [
      {
        id: "room",
        name: "Room",
        width: 3,
        height: 3,
        walls: [],
        entrances: [{ id: "start", cell: 4 }],
        pickups: [
          {
            id: "bottle",
            cell: 4,
            effects: {
              grants: [
                { itemId: "medicine", quantity: 1, instanceId: "bottle" },
              ],
              flags: { packed: true },
            },
          },
        ],
        dialogues: [
          {
            id: "keeper",
            cell: 4,
            flag: "packed",
            before: "Need medicine",
            after: "Thanks",
            choiceId: "deliver",
            effects: {
              consumes: [
                { itemId: "medicine", quantity: 1, instanceId: "bottle" },
              ],
              completeQuest: "delivery",
              flags: { delivered: true },
            },
          },
        ],
        exits: [],
      },
    ],
  };
  let state = createAdventure(defs);
  state = applyAdventureCommand(defs, state, {
    kind: "pickup",
    placementId: "bottle",
    token: "pickup",
    sequence: 1,
    revision: 0,
  }).state;
  const missingDefs = JSON.parse(JSON.stringify(defs)) as AdventureDefinitions;
  missingDefs.maps[0].dialogues[0].effects.consumes = [
    { itemId: "medicine", quantity: 1, instanceId: "missing" },
  ];
  const rejected = applyAdventureCommand(missingDefs, state, {
    kind: "dialogue",
    dialogueId: "keeper",
    choiceId: "deliver",
    token: "missing",
    sequence: 2,
    revision: 1,
  });
  expect(rejected.ok).toBe(false);
  expect(rejected.state).toBe(state);
  expect(state.campaign.inventory).toHaveLength(1);
  expect(state.campaign.quests.delivery).toBe("open");
  expect(state.campaign.flags.delivered).toBe(false);
  const result = applyAdventureCommand(defs, state, {
    kind: "dialogue",
    dialogueId: "keeper",
    choiceId: "deliver",
    token: "deliver",
    sequence: 2,
    revision: 1,
  });
  expect(result.ok).toBe(true);
  expect(result.state.campaign.inventory).toEqual([]);
  const identity = { gameId: "test", rulesBuildId: "test", contentId: "test" };
  expect(
    restoreAdventureCheckpoint(
      defs,
      identity,
      serializeAdventureCheckpoint(defs, result.state, identity),
    ).campaign.flags.delivered,
  ).toBe(true);
  expect(
    applyAdventureCommand(defs, result.state, {
      kind: "dialogue",
      dialogueId: "keeper",
      choiceId: "deliver",
      token: "again",
      sequence: 3,
      revision: 2,
    }).ok,
  ).toBe(false);
});
