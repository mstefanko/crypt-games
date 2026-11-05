import { ADVENTURE_DEFINITIONS as defs, ADVENTURE_EXPERIMENT_ROUTE } from "../../../../examples/game-m3/project";
import { describe, expect, it } from "vitest";
import {
  adventureDialogue,
  adventurePickupCollected,
  applyAdventureCommand,
  commitAdventureTransition,
  createAdventure,
  prepareAdventureTransition,
  restoreAdventureCheckpoint,
  restoreCampaign,
  serializeAdventureCheckpoint,
  serializeCampaign,
  validateAdventureDefinitions,
  type AdventureDefinitions,
  type AdventureState,
  type AdventureCommand,
  type AdventureTravelCommand,
} from "./adventure";
const identity = {
  gameId: defs.gameId,
  rulesBuildId: "actual-source",
  contentId: "actual-content",
};
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function apply(
  state: AdventureState,
  command:
    | Omit<AdventureCommand, "revision" | "sequence">
    | Omit<AdventureTravelCommand, "revision" | "sequence">,
  definitions = defs,
): AdventureState {
  const ordered = {
    ...command,
    revision: state.campaign.revision,
    sequence: state.campaign.sequence + 1,
  } as AdventureCommand | AdventureTravelCommand;
  if (ordered.kind === "travel") {
    const result = prepareAdventureTransition(definitions, state, ordered);
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(result.error);
    const committed = commitAdventureTransition(
      definitions,
      state,
      result.transition,
      result.transition.targetMapId,
    );
    expect(committed.ok).toBe(true);
    return committed.state;
  }
  const result = applyAdventureCommand(definitions, state, ordered);
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error(result.error);
  return result.state;
}
function route(
  count: number = ADVENTURE_EXPERIMENT_ROUTE.length,
  definitions = defs,
) {
  let state = createAdventure(definitions);
  for (const command of ADVENTURE_EXPERIMENT_ROUTE.slice(0, count))
    state = apply(state, command, definitions);
  return state;
}
describe("M3 transactional adventure", () => {
  it("plays pickup/dialogue/reward/return with durable map-placement identity", () => {
    const state = route();
    expect(state.active.mapId).toBe("meadow");
    expect(state.campaign.quests["keeper-errand"]).toBe("complete");
    expect(state.campaign.inventory).toEqual([
      { itemId: "moonflower", quantity: 1 },
      {
        itemId: "keeper-medal",
        quantity: 1,
        instanceId: "keeper-medal-unique",
      },
    ]);
    expect(state.campaign.stats.renown).toBe(1);
    expect(adventurePickupCollected(state, "meadow", "flower-patch")).toBe(
      true,
    );
    const restored = restoreCampaign(
      defs,
      serializeCampaign(defs, state.campaign),
    );
    expect(restored.campaign).toEqual(state.campaign);
    expect(restored.active.player).toBe(29);
    expect(restored.active.epoch).toBe(0);
  });
  it("shows both dialogue branches and blocks an unavailable reward", () => {
    let state = createAdventure(defs);
    for (const command of ADVENTURE_EXPERIMENT_ROUTE.slice(0, 8).filter(
      (c) => c.kind !== "pickup",
    ))
      state = apply(state, command);
    expect(adventureDialogue(defs, state, "keeper")).toEqual({
      text: defs.maps[1].dialogues[0].before,
      choiceId: null,
    });
    const failed = applyAdventureCommand(defs, state, {
      kind: "dialogue",
      dialogueId: "keeper",
      choiceId: "accept-medal",
      token: "reward",
      revision: state.campaign.revision,
      sequence: state.campaign.sequence + 1,
    });
    expect(failed.ok).toBe(false);
    expect(failed.state).toBe(state);
    const ready = route(10);
    expect(adventureDialogue(defs, ready, "keeper").choiceId).toBe(
      "accept-medal",
    );
  });
  it("rejects repeated tokens and rewards after exact restore or map return atomically", () => {
    let state = route(11);
    state = restoreAdventureCheckpoint(
      defs,
      identity,
      serializeAdventureCheckpoint(defs, state, identity),
    );
    for (const token of ["route-reward", "different-reward"]) {
      const before = serializeCampaign(defs, state.campaign);
      const result = applyAdventureCommand(defs, state, {
        kind: "dialogue",
        dialogueId: "keeper",
        choiceId: "accept-medal",
        token,
        revision: state.campaign.revision,
        sequence: state.campaign.sequence + 1,
      });
      expect(result.ok).toBe(false);
      expect(result.state).toBe(state);
      expect(serializeCampaign(defs, state.campaign)).toBe(before);
    }
    const afterReturn = route();
    const restored = restoreCampaign(
      defs,
      serializeCampaign(defs, afterReturn.campaign),
    );
    expect(adventurePickupCollected(restored, "meadow", "flower-patch")).toBe(
      true,
    );
  });
  it("stages maps and retains the complete previous state on failed or stale load", () => {
    const state = route(7),
      before = serializeAdventureCheckpoint(defs, state, identity);
    const prepared = prepareAdventureTransition(defs, state, {
      kind: "travel",
      exitId: "to-lodge",
      token: "travel",
      revision: state.campaign.revision,
      sequence: state.campaign.sequence + 1,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw Error(prepared.error);
    expect(serializeAdventureCheckpoint(defs, state, identity)).toBe(before);
    const failure = commitAdventureTransition(
      defs,
      state,
      prepared.transition,
      "missing",
    );
    expect(failure.ok).toBe(false);
    expect(failure.state).toBe(state);
    const newer = apply(state, { kind: "move", direction: "left" } as any);
    expect(
      commitAdventureTransition(defs, newer, prepared.transition, "lodge").ok,
    ).toBe(false);
    const success = commitAdventureTransition(
      defs,
      state,
      prepared.transition,
      "lodge",
    );
    expect(success.ok).toBe(true);
    expect(success.state.active.mapId).toBe("lodge");
    expect(
      commitAdventureTransition(
        defs,
        success.state,
        prepared.transition,
        "lodge",
      ).ok,
    ).toBe(false);
  });
  it("rolls back full inventories, stat bounds, duplicate instance IDs and all progression effects", () => {
    const full = route(1);
    full.campaign.inventory = Array.from({ length: 100 }, (_, n) => ({
      itemId: "keeper-medal",
      quantity: 1,
      instanceId: `existing-${n}`,
    }));
    const before = serializeCampaign(defs, full.campaign);
    const result = applyAdventureCommand(defs, full, {
      kind: "pickup",
      placementId: "flower-patch",
      token: "full-pickup",
      revision: full.campaign.revision,
      sequence: full.campaign.sequence + 1,
    });
    expect(result.ok).toBe(false);
    expect(result.state).toBe(full);
    expect(serializeCampaign(defs, full.campaign)).toBe(before);
    for (const setup of [
      (s: AdventureState) => (s.campaign.stats.renown = 10),
      (s: AdventureState) =>
        s.campaign.inventory.push({
          itemId: "keeper-medal",
          quantity: 1,
          instanceId: "keeper-medal-unique",
        }),
    ]) {
      const ready = route(10);
      setup(ready);
      const bytes = serializeCampaign(defs, ready.campaign);
      const rejected = applyAdventureCommand(defs, ready, {
        kind: "dialogue",
        dialogueId: "keeper",
        choiceId: "accept-medal",
        token: "will-rollback",
        revision: ready.campaign.revision,
        sequence: ready.campaign.sequence + 1,
      });
      expect(rejected.ok).toBe(false);
      expect(serializeCampaign(defs, ready.campaign)).toBe(bytes);
      expect(ready.campaign.tokens).not.toContain("will-rollback");
    }
  });
  it("fills declared smaller stacks and enforces default 999 stack / 100 slot limits", () => {
    const modified = copy(defs) as any;
    modified.maps[0].pickups[0].effects.grants[0].quantity = 20;
    let state = createAdventure(modified);
    state = apply(state, { kind: "move", direction: "right" } as any, modified);
    state = apply(
      state,
      { kind: "pickup", placementId: "flower-patch", token: "stack" } as any,
      modified,
    );
    expect(state.campaign.inventory.map((s) => s.quantity)).toEqual([9, 9, 2]);
    const saved = JSON.parse(serializeCampaign(modified, state.campaign));
    saved.campaign.inventory[0].quantity = 10;
    expect(() => restoreCampaign(modified, JSON.stringify(saved))).toThrow();
    const bad = copy(modified);
    bad.items[0].maxStack = 1000;
    expect(() => createAdventure(bad)).toThrow();
    const cap = copy(modified);
    cap.inventoryLimit = 101;
    expect(() => createAdventure(cap)).toThrow();
  });
  it("preserves stable identity through display-name/filename rename and rejects missing references", () => {
    const state = route(),
      bytes = serializeCampaign(defs, state.campaign),
      renamed = copy(defs) as any;
    renamed.maps[0].name = "Renamed meadow";
    expect(restoreCampaign(renamed, bytes).campaign).toEqual(state.campaign);
    for (const edit of [
      (d: any) => d.items.pop(),
      (d: any) => d.maps[0].pickups.splice(0),
      (d: any) => d.maps[0].entrances.splice(1),
      (d: any) => d.quests.splice(0),
      (d: any) => (d.maps[0].exits[0].mapId = "missing"),
    ]) {
      const missing = copy(defs);
      edit(missing);
      expect(() => restoreCampaign(missing, bytes)).toThrow();
    }
  });
  it("bounds and validates imported campaigns without mutating existing state", () => {
    const state = route(),
      bytes = serializeCampaign(defs, state.campaign);
    for (const edit of [
      (d: any) => (d.version = 2),
      (d: any) => d.campaign.tokens.push(d.campaign.tokens[0]),
      (d: any) => (d.campaign.flags.invented = true),
      (d: any) => (d.campaign.stats.renown = 11),
      (d: any) => (d.campaign.inventory[1].instanceId = undefined),
      (d: any) => d.campaign.removedPickups.push(d.campaign.removedPickups[0]),
      (d: any) => d.campaign.sequence++,
    ]) {
      const raw = JSON.parse(bytes);
      edit(raw);
      expect(() => restoreCampaign(defs, JSON.stringify(raw))).toThrow();
    }
    expect(() => restoreCampaign(defs, "x".repeat(1048577))).toThrow();
    expect(() => restoreCampaign(defs, "{")).toThrow();
    expect(serializeCampaign(defs, state.campaign)).toBe(bytes);
  });
  it("separates exact source/content/game identity from campaign compatibility", () => {
    const state = route(10),
      bytes = serializeAdventureCheckpoint(defs, state, identity);
    expect(
      serializeAdventureCheckpoint(
        defs,
        restoreAdventureCheckpoint(defs, identity, bytes),
        identity,
      ),
    ).toBe(bytes);
    for (const changed of [
      { ...identity, rulesBuildId: "different" },
      { ...identity, contentId: "different" },
      { ...identity, gameId: "different" },
    ])
      expect(() => restoreAdventureCheckpoint(defs, changed, bytes)).toThrow();
    const raw = JSON.parse(bytes);
    raw.state.active.player = 0;
    expect(() =>
      restoreAdventureCheckpoint(defs, identity, JSON.stringify(raw)),
    ).toThrow();
    expect(() => restoreCampaign(defs, bytes)).toThrow();
  });
  it("rejects stale order and undeclared authored flags/stats before changing state", () => {
    const state = createAdventure(defs);
    for (const c of [
      { kind: "move", direction: "right", revision: 1, sequence: 1 },
      { kind: "move", direction: "right", revision: 0, sequence: 2 },
    ] as const) {
      const result = applyAdventureCommand(defs, state, c);
      expect(result.ok).toBe(false);
      expect(result.state).toBe(state);
    }
    for (const effect of [
      { flags: { unknown: true } },
      { stats: { unknown: 1 } },
      { grants: [{ itemId: "missing", quantity: 1 }] },
    ]) {
      const bad = copy(defs) as any;
      bad.maps[0].pickups[0].effects = effect;
      expect(() => validateAdventureDefinitions(bad)).toThrow();
    }
  });
  it("rejects null and non-string unavailable dialogue choices before any mutation", () => {
    let state = createAdventure(defs);
    for (const command of ADVENTURE_EXPERIMENT_ROUTE.slice(0, 10).filter(
      (command) => command.kind !== "pickup",
    ))
      state = apply(state, command);
    expect(state.active.player).toBe(19);
    expect(adventureDialogue(defs, state, "keeper").choiceId).toBeNull();
    const before = serializeAdventureCheckpoint(defs, state, identity);
    for (const choiceId of [
      null,
      undefined,
      0,
      false,
      [],
      {},
      "accept-medal",
    ]) {
      const result = applyAdventureCommand(defs, state, {
        kind: "dialogue",
        dialogueId: "keeper",
        choiceId,
        token: "unavailable-choice",
        revision: state.campaign.revision,
        sequence: state.campaign.sequence + 1,
      } as unknown as AdventureCommand);
      expect(result.ok).toBe(false);
      expect(result.state).toBe(state);
      expect(serializeAdventureCheckpoint(defs, state, identity)).toBe(before);
    }
  });
  it("continues beyond 2048 map transitions with bounded receipts and ordered replay rejection", () => {
    const definitions = copy(defs);
    for (const map of definitions.maps) {
      for (const entrance of map.entrances) entrance.cell = 17;
      for (const exit of map.exits) exit.cell = 17;
    }
    let state = createAdventure(definitions);
    const original = {
      kind: "travel",
      exitId: "to-lodge",
      token: "trip-0",
      revision: 0,
      sequence: 1,
    } as const;
    for (let index = 0; index < 2100; index++) {
      state = apply(
        state,
        {
          kind: "travel",
          exitId: state.active.mapId === "meadow" ? "to-lodge" : "to-meadow",
          token: `trip-${index}`,
        },
        definitions,
      );
    }
    expect(state.campaign.tokens).toHaveLength(64);
    expect(state.campaign.sequence).toBe(2100);
    const before = serializeAdventureCheckpoint(definitions, state, identity);
    expect(prepareAdventureTransition(definitions, state, original).ok).toBe(
      false,
    );
    expect(
      prepareAdventureTransition(definitions, state, {
        ...original,
        token: "trip-2099",
        revision: state.campaign.revision,
        sequence: state.campaign.sequence + 1,
      }).ok,
    ).toBe(false);
    expect(serializeAdventureCheckpoint(definitions, state, identity)).toBe(
      before,
    );
    state = apply(
      state,
      { kind: "move", direction: "right" } as any,
      definitions,
    );
    state = apply(
      state,
      {
        kind: "pickup",
        placementId: "flower-patch",
        token: "after-many-trips",
      } as any,
      definitions,
    );
    state = apply(
      state,
      { kind: "travel", exitId: "to-lodge", token: "reward-trip" },
      definitions,
    );
    state = apply(
      state,
      { kind: "move", direction: "right" } as any,
      definitions,
    );
    state = apply(
      state,
      { kind: "move", direction: "right" } as any,
      definitions,
    );
    state = apply(
      state,
      {
        kind: "dialogue",
        dialogueId: "keeper",
        choiceId: "accept-medal",
        token: "reward-after-many-trips",
      } as any,
      definitions,
    );
    expect(state.campaign.quests["keeper-errand"]).toBe("complete");
    expect(
      restoreCampaign(
        definitions,
        serializeCampaign(definitions, state.campaign),
      ).campaign,
    ).toEqual(state.campaign);
  });
  it("accepts legacy v1 full opaque receipt arrays and can still claim pickup and reward", () => {
    for (const [initial, kind] of [
      [route(1), "pickup"],
      [route(10), "dialogue"],
    ] as const) {
      initial.campaign.revision = initial.campaign.sequence = 2048;
      initial.campaign.tokens = Array.from(
        { length: 2048 },
        (_, index) => `opaque-old-${index}`,
      );
      let state = restoreCampaign(
        defs,
        serializeCampaign(defs, initial.campaign),
      );
      expect(state.campaign.tokens).toHaveLength(2048);
      state = apply(state, { kind: "move", direction: "right" } as any);
      if (kind === "dialogue")
        state = apply(state, { kind: "move", direction: "right" } as any);
      state = apply(
        state,
        kind === "pickup"
          ? ({ kind, placementId: "flower-patch", token: "new-pickup" } as any)
          : ({
              kind,
              dialogueId: "keeper",
              choiceId: "accept-medal",
              token: "new-reward",
            } as any),
      );
      expect(state.campaign.tokens).toHaveLength(64);
      expect(
        state.campaign.inventory.some(
          (slot) =>
            slot.itemId === (kind === "pickup" ? "moonflower" : "keeper-medal"),
        ),
      ).toBe(true);
      expect(
        restoreCampaign(defs, serializeCampaign(defs, state.campaign)).campaign,
      ).toEqual(state.campaign);
    }
  });
  it("retains permanent pickup and quest guards after real travel expires their receipts", () => {
    const definitions = copy(defs);
    for (const map of definitions.maps) {
      for (const entrance of map.entrances) entrance.cell = 17;
      for (const exit of map.exits) exit.cell = 17;
    }
    let state = createAdventure(definitions);
    state = apply(
      state,
      { kind: "move", direction: "right" } as any,
      definitions,
    );
    state = apply(
      state,
      {
        kind: "pickup",
        placementId: "flower-patch",
        token: "once-pickup",
      } as any,
      definitions,
    );
    state = apply(
      state,
      { kind: "travel", exitId: "to-lodge", token: "first-trip" },
      definitions,
    );
    state = apply(
      state,
      { kind: "move", direction: "right" } as any,
      definitions,
    );
    state = apply(
      state,
      { kind: "move", direction: "right" } as any,
      definitions,
    );
    state = apply(
      state,
      {
        kind: "dialogue",
        dialogueId: "keeper",
        choiceId: "accept-medal",
        token: "once-reward",
      } as any,
      definitions,
    );
    state = apply(
      state,
      { kind: "move", direction: "left" } as any,
      definitions,
    );
    for (let index = 0; index < 70; index++)
      state = apply(
        state,
        {
          kind: "travel",
          exitId: state.active.mapId === "meadow" ? "to-lodge" : "to-meadow",
          token: `recent-trip-${index}`,
        },
        definitions,
      );
    expect(state.campaign.tokens).not.toContain("once-pickup");
    expect(state.campaign.tokens).not.toContain("once-reward");
    state = restoreAdventureCheckpoint(
      definitions,
      identity,
      serializeAdventureCheckpoint(definitions, state, identity),
    );
    state = apply(
      state,
      { kind: "move", direction: "right" } as any,
      definitions,
    );
    state = apply(
      state,
      { kind: "move", direction: "right" } as any,
      definitions,
    );
    let before = serializeCampaign(definitions, state.campaign);
    const repeatedReward = applyAdventureCommand(definitions, state, {
      kind: "dialogue",
      dialogueId: "keeper",
      choiceId: "accept-medal",
      token: "once-reward",
      revision: state.campaign.revision,
      sequence: state.campaign.sequence + 1,
    });
    expect(repeatedReward.ok).toBe(false);
    expect(repeatedReward.state).toBe(state);
    expect(serializeCampaign(definitions, state.campaign)).toBe(before);
    state = apply(
      state,
      { kind: "move", direction: "left" } as any,
      definitions,
    );
    state = apply(
      state,
      { kind: "travel", exitId: "to-meadow", token: "retry-pickup-trip" },
      definitions,
    );
    state = apply(
      state,
      { kind: "move", direction: "right" } as any,
      definitions,
    );
    before = serializeCampaign(definitions, state.campaign);
    const repeatedPickup = applyAdventureCommand(definitions, state, {
      kind: "pickup",
      placementId: "flower-patch",
      token: "once-pickup",
      revision: state.campaign.revision,
      sequence: state.campaign.sequence + 1,
    });
    expect(repeatedPickup.ok).toBe(false);
    expect(repeatedPickup.state).toBe(state);
    expect(serializeCampaign(definitions, state.campaign)).toBe(before);
  });
  it("rederives staged transitions and rejects mutated or forged state atomically", () => {
    const state = route(7),
      before = serializeAdventureCheckpoint(defs, state, identity);
    const prepared = prepareAdventureTransition(defs, state, {
      kind: "travel",
      exitId: "to-lodge",
      token: "proposed-trip",
      revision: state.campaign.revision,
      sequence: state.campaign.sequence + 1,
    });
    if (!prepared.ok) throw Error(prepared.error);
    for (const edit of [
      (proposal: any) => proposal.state.campaign.inventory[0].quantity++,
      (proposal: any) =>
        (proposal.state.campaign.flags["keeper-helped"] = true),
      (proposal: any) => proposal.state.active.player++,
      (proposal: any) => proposal.state.campaign.tokens.push("injected-token"),
      (proposal: any) => (proposal.command.exitId = "not-an-authored-exit"),
      (proposal: any) => {
        proposal.command.exitId = "to-meadow";
        proposal.targetMapId = "meadow";
        proposal.state.active.mapId = "meadow";
        proposal.state.active.entranceId = "trail";
        proposal.state.campaign.checkpoint = {
          mapId: "meadow",
          entranceId: "trail",
        };
      },
      (proposal: any) => delete proposal.command,
    ]) {
      const proposal = copy(prepared.transition);
      edit(proposal);
      const result = commitAdventureTransition(
        defs,
        state,
        proposal,
        proposal.targetMapId,
      );
      expect(result.ok).toBe(false);
      expect(result.state).toBe(state);
      expect(serializeAdventureCheckpoint(defs, state, identity)).toBe(before);
    }
    // Pure proposals need no hidden issuance registry: an equivalent legal
    // command/result can be verified from the trusted committed state.
    expect(
      commitAdventureTransition(defs, state, copy(prepared.transition), "lodge")
        .ok,
    ).toBe(true);
  });
  it("rejects cross-field pickup/quest/reward corruption at both restore boundaries", () => {
    const state = route(11);
    for (const edit of [
      (campaign: any) =>
        (campaign.inventory = campaign.inventory.filter(
          (slot: any) => slot.itemId !== "keeper-medal",
        )),
      (campaign: any) => (campaign.quests["keeper-errand"] = "open"),
      (campaign: any) => (campaign.flags["keeper-helped"] = false),
      (campaign: any) => (campaign.flags["flower-found"] = false),
      (campaign: any) => (campaign.stats.renown = 0),
      (campaign: any) => (campaign.removedPickups = []),
      (campaign: any) => campaign.inventory[0].quantity++,
      (campaign: any) =>
        (campaign.inventory[1].instanceId = "other-medal-instance"),
    ]) {
      const corrupt = copy(state);
      edit(corrupt.campaign);
      const campaignBytes = serializeCampaign(defs, corrupt.campaign);
      const exactBytes = serializeAdventureCheckpoint(defs, corrupt, identity);
      expect(() => restoreCampaign(defs, campaignBytes)).toThrow();
      expect(() =>
        restoreAdventureCheckpoint(defs, identity, exactBytes),
      ).toThrow();
    }
    const unearned = route(10);
    unearned.campaign.inventory.push({
      itemId: "keeper-medal",
      quantity: 1,
      instanceId: "keeper-medal-unique",
    });
    expect(() =>
      restoreCampaign(defs, serializeCampaign(defs, unearned.campaign)),
    ).toThrow();
    expect(
      restoreCampaign(defs, serializeCampaign(defs, state.campaign)).campaign,
    ).toEqual(state.campaign);
  });
  it("declares monotonic flags, non-spending stats and one permanent outcome per quest", () => {
    for (const edit of [
      (definitions: any) =>
        (definitions.maps[0].pickups[0].effects.flags["flower-found"] = false),
      (definitions: any) =>
        (definitions.maps[1].dialogues[0].effects.stats.renown = -1),
      (definitions: any) =>
        (definitions.maps[0].pickups[0].effects.completeQuest =
          "keeper-errand"),
      (definitions: any) =>
        delete definitions.maps[1].dialogues[0].effects.completeQuest,
    ]) {
      const definitions = copy(defs);
      edit(definitions);
      expect(() => validateAdventureDefinitions(definitions)).toThrow();
    }
  });
  it("roundtrips every legal route outcome including a later pickup sharing monotonic flags", () => {
    const definitions = copy(defs) as any;
    definitions.maps[1].pickups.push({
      id: "late-flower",
      cell: 19,
      effects: {
        grants: [{ itemId: "moonflower", quantity: 1 }],
        flags: { "flower-found": true, "keeper-helped": true },
        stats: { renown: 1 },
      },
    });
    let state = createAdventure(definitions);
    for (const command of [
      ...ADVENTURE_EXPERIMENT_ROUTE.slice(0, 11),
      {
        kind: "pickup",
        placementId: "late-flower",
        token: "after-quest-pickup",
      },
    ] as const) {
      state = apply(state, command, definitions);
      expect(
        restoreCampaign(
          definitions,
          serializeCampaign(definitions, state.campaign),
        ).campaign,
      ).toEqual(state.campaign);
      expect(
        restoreAdventureCheckpoint(
          definitions,
          identity,
          serializeAdventureCheckpoint(definitions, state, identity),
        ),
      ).toEqual(state);
    }
    expect(state.campaign.stats.renown).toBe(2);
    expect(
      state.campaign.inventory.find((slot) => slot.itemId === "moonflower")
        ?.quantity,
    ).toBe(2);
  });
});
