import { describe, expect, it, vi } from "vitest";
import { canonical } from "@onepage/game-project/runtime";
import { validateCharacterBuildDefinition } from "@onepage/game-project/character-build";
import { CharacterSessionOwner } from "./character-session";
import { restoreCheckpoint, serializeCheckpoint } from "./checkpoint";
import { CampaignPlatformOwner } from "./campaign-platform";
import {
  ExplorationCharacterOwner,
  EXPLORATION_CHARACTER_BUILDS,
  EXPLORATION_CHARACTER_CATALOG,
  createExplorationCharacterGame as create,
} from "./exploration-character";
import {
  createExplorationGame,
  explorationInput as input,
  EXPLORATION_CAMPAIGN,
  EXPLORATION_DEFINITIONS,
  EXPLORATION_IDENTITY,
} from "./exploration-game";
import { CampaignPlatformSession } from "../../game-runtime/src/session/campaign-platform";
const hero = (owner: CampaignPlatformOwner) =>
  owner.observation().platform.actors.find((actor) => actor.slot === 0)!;
function equip(
  owner: ExplorationCharacterOwner,
  itemId: string | null = "phase-focus",
) {
  const revision = owner.characterObservation().revision;
  return owner.executeCharacter({
    id: `focus-${revision}`,
    revision,
    action: { kind: "equip", slotId: "charm", itemId },
  });
}
function phaseJourney() {
  const owner = createExplorationGame();
  owner.executeFrames(input(127), 26);
  owner.execute({ kind: "exit", id: "to-gallery" });
  for (
    let tick = 0;
    tick < 180 &&
    owner
      .observation()
      .platform.actors.find((actor) => actor.spawnId === "sentinel")!.health;
    tick++
  ) {
    const enemy = owner
      .observation()
      .platform.actors.find((actor) => actor.spawnId === "sentinel")!;
    if (Math.abs(enemy.x - hero(owner).x) > 28 * 256)
      owner.executeFrames(input(enemy.x > hero(owner).x ? 127 : -127));
    else {
      owner.executeFrames(input(0, "attack"));
      owner.executeFrames(input(0, null, "attack"));
      owner.executeFrames(input(), 14);
    }
  }
  expect(
    owner
      .observation()
      .platform.actors.find((actor) => actor.spawnId === "sentinel")!.health,
  ).toBe(0);
  while (hero(owner).x < 244 * 256) owner.executeFrames(input(127));
  owner.execute({ kind: "exit", id: "to-shrine" });
  owner.executeFrames(input(127), 26);
  owner.execute({ kind: "pickup", id: "phase" });
  owner.execute({ kind: "exit", id: "shrine-shortcut" });
  return owner;
}
function phaseOwner() {
  const owner = create();
  owner.restoreProgress(phaseJourney().progress());
  return owner;
}
function legacyCharacter() {
  // Exact previous authored wardrobe definition, without the additive loadout capability.
  const current = EXPLORATION_CHARACTER_BUILDS;
  const definition = validateCharacterBuildDefinition(
    {
      ...current,
      id: "beacon-wardrobe-v1",
      stats: current.stats.filter((stat) => stat.id !== "phaseReach"),
      slots: ["cloak"],
      items: current.items.filter((item) => item.id === "travel-cape"),
      builds: current.builds.map((build) => ({
        ...build,
        baseStats: build.baseStats.filter(
          (stat) => stat.statId !== "phaseReach",
        ),
        grants: build.grants.filter((grant) => grant.itemId === "travel-cape"),
      })),
    },
    EXPLORATION_CHARACTER_CATALOG,
  );
  const owner = new CharacterSessionOwner(
    definition,
    EXPLORATION_CHARACTER_CATALOG,
  );
  owner.execute({
    id: "initial-character",
    revision: 0,
    action: {
      kind: "create",
      buildId: "pilgrim",
      appearanceId: "cool-plain",
      displayName: "Legacy pilgrim",
    },
  });
  owner.execute({
    id: "old-cape",
    revision: 1,
    action: { kind: "equip", slotId: "cloak", itemId: "travel-cape" },
  });
  return owner;
}
const loader = async ({
  roomId,
  assetIds,
}: {
  roomId: string;
  assetIds: readonly string[];
}) => ({ roomId, assetIds, dispose() {} });
describe("Beacon gameplay loadout", () => {
  it("changes only acquired phase reach, preserving ordinary motion, attacks, cosmetics and the ability gate", () => {
    const plain = create(),
      focused = create();
    equip(focused);
    expect(focused.characterObservation().selection).toEqual(
      plain.characterObservation().selection,
    );
    expect(focused.characterObservation().loadout.phaseDistance).toBe(40 * 256);
    for (const frame of [
      input(127),
      input(127, "heavy"),
      input(0, null, "heavy"),
      input(0, "attack"),
      input(0, null, "attack"),
      input(),
    ]) {
      plain.executeFrames(frame);
      focused.executeFrames(frame);
      expect(focused.observation().platform).toEqual(
        plain.observation().platform,
      );
    }
    expect(() => focused.execute({ kind: "exit", id: "phase-gate" })).toThrow();
    const baseline = phaseOwner(),
      boosted = create();
    boosted.restore(baseline.checkpoint());
    equip(boosted);
    const start = hero(boosted).x;
    baseline.execute({ kind: "frame", input: input(127, "heavy") });
    boosted.executeFrames(input(127, "heavy"));
    expect(hero(baseline).x - start).toBe(34 * 256);
    expect(hero(boosted).x - start).toBe(42 * 256);
    expect(hero(boosted).abilityId).toBe(hero(baseline).abilityId);
    expect(hero(boosted).health).toBe(hero(baseline).health);
    expect(
      JSON.parse(JSON.parse(boosted.checkpoint()).campaign).history.at(-1)
        .traversalBonus,
    ).toBe(2048);
  });
  it("keeps the full 40px burst collision constrained and rejects unsupported capability commands atomically", () => {
    const campaign = JSON.parse(JSON.stringify(EXPLORATION_CAMPAIGN));
    campaign.traversal.maxBonus = 2048;
    const definitions = JSON.parse(JSON.stringify(EXPLORATION_DEFINITIONS));
    definitions.levels[0].rectangles.push({
      id: "burst-wall",
      x: 56 * 256,
      y: 96 * 256,
      width: 8 * 256,
      height: 48 * 256,
      oneWay: false,
    });
    const original = phaseJourney();
    const portable = JSON.parse(original.progress());
    portable.definition = JSON.parse(
      new CampaignPlatformOwner(
        definitions,
        EXPLORATION_IDENTITY,
        campaign,
      ).checkpoint(),
    ).definition;
    const owner = new CampaignPlatformOwner(
      definitions,
      EXPLORATION_IDENTITY,
      campaign,
    );
    owner.restoreProgress(canonical(portable));
    owner.execute({
      kind: "frame",
      input: input(127, "heavy"),
      traversalBonus: 2048,
    });
    expect(hero(owner).x).toBe(44 * 256);
    const old = createExplorationGame(),
      before = old.checkpoint();
    expect(() =>
      old.execute({
        kind: "frame",
        input: input(0, "heavy"),
        traversalBonus: 1,
      }),
    ).toThrow("not enabled");
    expect(old.checkpoint()).toBe(before);
    const after = owner.checkpoint();
    for (const traversalBonus of [0, -1, 2049, 1.5, NaN]) {
      expect(() =>
        owner.execute({ kind: "frame", input: input(), traversalBonus }),
      ).toThrow();
      expect(owner.checkpoint()).toBe(after);
    }
  });
  it("derives every future bonus after exact continuation and rejects caller grants, invalid equip and conflicting retry", () => {
    const owner = phaseOwner();
    equip(owner);
    owner.executeFrames(input(127, "heavy"));
    const exact = owner.checkpoint(),
      restored = create();
    restored.restore(exact);
    expect(restored.checkpoint()).toBe(exact);
    for (const frame of [
      input(0, null, "heavy"),
      input(),
      input(127),
      input(0, "heavy"),
    ]) {
      owner.executeFrames(frame);
      restored.executeFrames(frame);
      expect(restored.checkpoint()).toBe(owner.checkpoint());
    }
    equip(restored, null);
    const before = restored.checkpoint();
    expect(() =>
      restored.execute({ kind: "frame", input: input(), traversalBonus: 2048 }),
    ).toThrow("derived");
    expect(restored.checkpoint()).toBe(before);
    // The host gesture rolls back the first frame when a repeated press is invalid.
    restored.executeFrames(input(0, null, "heavy"));
    const beforeGesture = restored.checkpoint();
    expect(() => restored.executeFrames(input(0, "heavy"), 2)).toThrow();
    expect(restored.checkpoint()).toBe(beforeGesture);
    const revision = restored.characterObservation().revision;
    const command = {
      id: "retry-focus",
      revision,
      action: {
        kind: "equip" as const,
        slotId: "charm",
        itemId: "phase-focus",
      },
    };
    const receipt = restored.executeCharacter(command),
      after = restored.checkpoint();
    expect(restored.executeCharacter(command)).toEqual(receipt);
    expect(restored.checkpoint()).toBe(after);
    expect(() =>
      restored.executeCharacter({
        ...command,
        action: { ...command.action, itemId: null },
      }),
    ).toThrow("Conflicting");
    expect(() => equip(restored, "travel-cape")).toThrow();
    expect(restored.checkpoint()).toBe(after);
    equip(restored, null);
    restored.executeFrames(input());
    expect(
      JSON.parse(JSON.parse(restored.checkpoint()).campaign).history.at(-1),
    ).not.toHaveProperty("traversalBonus");
  });
  it("retains the loadout through bounded campaign history compaction and rejects an atomic repeated-edge gesture", () => {
    const owner = create();
    equip(owner);
    for (let batch = 0; batch < 16; batch++) owner.executeFrames(input(), 256);
    owner.executeFrames(input(), 4);
    const envelope = JSON.parse(owner.checkpoint());
    const campaign = JSON.parse(envelope.campaign);
    expect(campaign.base).not.toBeNull();
    expect(campaign.history).toHaveLength(4);
    expect(envelope.frameEquipment).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
      [3, 2],
    ]);
    const restored = create();
    restored.restore(owner.checkpoint());
    expect(restored.checkpoint()).toBe(owner.checkpoint());
    owner.executeFrames(input(127), 3);
    restored.executeFrames(input(127), 3);
    expect(restored.checkpoint()).toBe(owner.checkpoint());
    const before = restored.checkpoint();
    expect(() => restored.executeFrames(input(0, "heavy"), 2)).toThrow();
    expect(restored.checkpoint()).toBe(before);
    expect(restored.characterObservation().loadout.phaseBonus).toBe(2048);
  });
  it("restores a validated composite with one campaign replay and rejects its late witness atomically", () => {
    const owner = create();
    equip(owner);
    owner.executeFrames(input(), 12);
    const exact = owner.checkpoint();
    const replay = vi.spyOn(CampaignPlatformOwner.prototype, "execute");
    const restored = create();
    try {
      restored.restore(exact);
      expect(replay).toHaveBeenCalledTimes(12);
      expect(restored.checkpoint()).toBe(exact);
      const invalid = JSON.parse(exact);
      invalid.frameEquipment.at(-1)[1] = 999;
      expect(() => restored.restore(canonical(invalid))).toThrow();
      expect(restored.checkpoint()).toBe(exact);
    } finally {
      replay.mockRestore();
    }
    owner.executeFrames(input(127), 4);
    restored.executeFrames(input(127), 4);
    expect(restored.checkpoint()).toBe(owner.checkpoint());
  });
  it("prepares current character composites without publication and rejects stale or repeated adoption", () => {
    class Composite extends ExplorationCharacterOwner {
      prepare(bytes: string, portable = false) {
        return this.prepareCharacterRestore(bytes, portable);
      }
    }
    const source = create();
    equip(source);
    source.executeFrames(input(), 3);
    const owner = new Composite();
    const before = owner.checkpoint();
    const ready = owner.prepare(source.checkpoint());
    expect(owner.checkpoint()).toBe(before);
    expect(ready.checkpoint).toBe(source.checkpoint());
    expect(ready.progress).toBe(source.progress());
    expect(ready.roomId).toBe(source.observation().roomId);
    ready.adopt();
    expect(owner.checkpoint()).toBe(source.checkpoint());
    expect(() => ready.adopt()).toThrow(/Stale/);
    const stale = owner.prepare(source.checkpoint());
    equip(owner, null);
    const changed = owner.checkpoint();
    expect(() => stale.adopt()).toThrow(/Stale/);
    expect(owner.checkpoint()).toBe(changed);
    const portable = owner.prepare(source.progress(), true);
    portable.adopt();
    expect(owner.progress()).toBe(source.progress());
  });
  it("rolls back the equipment witness and original history when a compaction-crossing batch fails", () => {
    const owner = create();
    equip(owner);
    for (let batch = 0; batch < 15; batch++) owner.executeFrames(input(), 256);
    owner.executeFrames(input(), 255);
    const previousWitness = (owner as any).frameEquipment;
    const before = owner.checkpoint();
    expect(() => owner.executeFrames(input(0, "heavy"), 2)).toThrow(/Pressed/);
    expect(owner.checkpoint()).toBe(before);
    expect((owner as any).frameEquipment).toBe(previousWitness);
    expect(previousWitness).toHaveLength(4095);
    const restored = create();
    restored.restore(before);
    owner.executeFrames(input(127), 2);
    restored.executeFrames(input(127), 2);
    expect(restored.checkpoint()).toBe(owner.checkpoint());
  });
  it("restores every equipment reference after numeric exhaustion crosses compaction", () => {
    const owner = create();
    equip(owner);
    owner.restoreProgress(owner.progress());
    const envelope = JSON.parse(owner.checkpoint());
    const campaign = JSON.parse(envelope.campaign);
    const platform = restoreCheckpoint(
      EXPLORATION_DEFINITIONS,
      EXPLORATION_IDENTITY,
      campaign.platform,
    );
    platform.tick = Number.MAX_SAFE_INTEGER - 4096;
    platform.decoder.lastTick = platform.tick - 1;
    campaign.platform = campaign.base.platform = serializeCheckpoint(platform);
    envelope.campaign = canonical(campaign);
    owner.restore(canonical(envelope));
    for (let batch = 0; batch < 15; batch++) owner.executeFrames(input(), 256);
    owner.executeFrames(input(), 255);
    const before = owner.checkpoint();
    const witness = (owner as any).frameEquipment;
    expect(() => owner.executeFrames(input(), 4)).toThrow();
    expect(owner.checkpoint()).toBe(before);
    expect((owner as any).frameEquipment).toBe(witness);
    expect(witness).toHaveLength(4095);
    const restored = create();
    restored.restore(before);
    expect(restored.checkpoint()).toBe(before);
  });
  it("retires frame equipment references when a non-frame checkpoint compacts the campaign tail", () => {
    const owner = create();
    equip(owner);
    for (let batch = 0; batch < 15; batch++) owner.executeFrames(input(), 256);
    owner.executeFrames(input(), 255);
    expect(JSON.parse(owner.checkpoint()).frameEquipment).toHaveLength(4095);
    owner.execute({ kind: "checkpoint" });
    const exact = owner.checkpoint(),
      envelope = JSON.parse(exact);
    expect(JSON.parse(envelope.campaign).history).toEqual([]);
    expect(envelope.frameEquipment).toEqual([]);
    const restored = create();
    restored.restore(exact);
    expect(restored.checkpoint()).toBe(exact);
    owner.executeFrames(input(127));
    restored.executeFrames(input(127));
    expect(restored.checkpoint()).toBe(owner.checkpoint());
    expect(JSON.parse(owner.checkpoint()).frameEquipment).toEqual([[0, 2]]);
  });
  it("retains gameplay inventory across portable entrance recovery, actual death, recovery and reset", () => {
    const owner = phaseOwner();
    equip(owner);
    const portable = owner.progress(),
      loaded = create();
    loaded.restoreProgress(portable);
    expect(loaded.characterObservation()).toEqual(owner.characterObservation());
    const wardrobe = loaded.characterObservation();
    loaded.executeFrames(input(127), 140);
    loaded.executeFrames(input(), 80);
    expect(loaded.observation().platform.status).toBe("lost");
    loaded.execute({ kind: "recover" });
    expect(loaded.characterObservation()).toEqual(wardrobe);
    loaded.execute({ kind: "reset" });
    expect(loaded.characterObservation()).toEqual(wardrobe);
    expect(
      loaded
        .observation()
        .transactions.flags.find((flag) => flag.id === "phase")!.value,
    ).toBe(false);
    const x = hero(loaded).x;
    loaded.executeFrames(input(0, "heavy"));
    expect(hero(loaded).x).toBe(x);
  });
  it("explicitly upgrades validated v1 wardrobe saves with spare, unequipped focus and rejects altered legacy definitions", () => {
    const journey = phaseJourney(),
      wardrobe = legacyCharacter();
    const owner = create();
    owner.restore(
      canonical({
        format: "beacon-character-exact-v1",
        campaign: journey.checkpoint(),
        character: wardrobe.capture(),
      }),
    );
    expect(owner.characterObservation().character).toEqual(
      wardrobe.inspect().character,
    );
    expect(
      owner
        .characterObservation()
        .inventory.find((item) => item.itemId === "phase-focus")!.quantity,
    ).toBe(1);
    expect(owner.characterObservation().loadout.phaseBonus).toBe(0);
    expect(owner.observation().platform).toEqual(
      journey.observation().platform,
    );
    const portable = {
      kind: "beacon-character-progress",
      version: 1,
      campaign: journey.progress(),
      character: wardrobe.capture(),
    };
    owner.restoreProgress(canonical(portable));
    expect(owner.observation().visited).toEqual(journey.observation().visited);
    expect(JSON.parse(owner.progress()).version).toBe(2);
    const before = owner.checkpoint();
    const forged = JSON.parse(canonical(portable));
    forged.character.definition.id = "forged";
    expect(() => owner.restoreProgress(canonical(forged))).toThrow();
    expect(owner.checkpoint()).toBe(before);
    const next = JSON.parse(owner.checkpoint());
    next.character.transactions.stats[0].value = 2048;
    expect(() => owner.restore(canonical(next))).toThrow();
    expect(owner.checkpoint()).toBe(before);
    const downgraded = JSON.parse(owner.progress());
    downgraded.version = 1;
    expect(() => owner.restoreProgress(canonical(downgraded))).toThrow();
    expect(owner.checkpoint()).toBe(before);
  });
  it("validates retained frame equipment provenance while allowing equip, burst and later unequip", () => {
    const owner = phaseOwner();
    equip(owner);
    owner.executeFrames(input(127, "heavy"));
    equip(owner, null);
    const exact = owner.checkpoint(),
      envelope = JSON.parse(exact);
    expect(envelope.frameEquipment).toEqual([[0, 2]]);
    expect(owner.characterObservation().loadout.phaseBonus).toBe(0);
    const restored = create();
    restored.restore(exact);
    expect(restored.checkpoint()).toBe(exact);
    owner.executeFrames(input(0, null, "heavy"));
    restored.executeFrames(input(0, null, "heavy"));
    owner.executeFrames(input(127, "heavy"));
    restored.executeFrames(input(127, "heavy"));
    expect(restored.checkpoint()).toBe(owner.checkpoint());
    const before = restored.checkpoint();
    for (const frameEquipment of [
      [],
      [[0, 1]],
      [[0, 3]],
      [
        [0, 2],
        [0, 2],
      ],
      [[1, 2]],
      [[0, 999]],
    ]) {
      expect(() =>
        restored.restore(canonical({ ...envelope, frameEquipment })),
      ).toThrow();
      expect(restored.checkpoint()).toBe(before);
    }
    const neverEquipped = phaseOwner(),
      current = JSON.parse(neverEquipped.checkpoint());
    const definition = JSON.parse(current.campaign).definition;
    const injected = new CampaignPlatformOwner(
      EXPLORATION_DEFINITIONS,
      EXPLORATION_IDENTITY,
      definition,
    );
    injected.restore(current.campaign);
    injected.execute({
      kind: "frame",
      input: input(127, "heavy"),
      traversalBonus: 2048,
    });
    const forged = {
      ...current,
      campaign: injected.checkpoint(),
      frameEquipment: [[0, 1]],
    };
    expect(() => restored.restore(canonical(forged))).toThrow(
      "equipment interleaving",
    );
    expect(restored.checkpoint()).toBe(before);
    const preWitness = { ...forged, format: "beacon-character-exact-v2" };
    delete (preWitness as Partial<typeof preWitness>).frameEquipment;
    expect(() => restored.restore(canonical(preWitness))).toThrow(
      "no equipment interleaving witness",
    );
    expect(restored.checkpoint()).toBe(before);
  });
  it("rebases old character epochs, resets and compaction without retaining stale equipment references", () => {
    const owner = phaseOwner();
    equip(owner);
    owner.executeFrames(input(127, "heavy"));
    const platform = owner.observation().platform;
    const progress = JSON.parse(owner.progress()).campaign;
    owner.chooseCharacter("pilgrim", "cool-plain", "New epoch");
    expect(owner.observation().platform).toEqual(platform);
    expect(JSON.parse(owner.progress()).campaign).toBe(progress);
    expect(JSON.parse(owner.checkpoint()).frameEquipment).toEqual([]);
    const restored = create();
    restored.restore(owner.checkpoint());
    owner.executeFrames(input(0, null, "heavy"));
    restored.executeFrames(input(0, null, "heavy"));
    expect(restored.checkpoint()).toBe(owner.checkpoint());
    const plan = owner.stageEntry("reset");
    owner.commitEntry(plan);
    expect(JSON.parse(owner.checkpoint()).frameEquipment).toEqual([]);
    owner.executeFrames(input());
    expect(JSON.parse(owner.checkpoint()).frameEquipment).toEqual([[0, 1]]);
    restored.restore(owner.checkpoint());
    expect(restored.checkpoint()).toBe(owner.checkpoint());
  });
  it("rejects either legacy authority before loading, and retains upgraded staged owners/resources after failure", async () => {
    const journey = phaseJourney(),
      wardrobe = legacyCharacter();
    for (const portable of [false, true]) {
      const host = new CampaignPlatformSession(
        EXPLORATION_DEFINITIONS,
        EXPLORATION_IDENTITY,
        EXPLORATION_CAMPAIGN,
        1000,
        create,
      );
      let disposed = 0,
        loads = 0;
      const retainedLoader = async (request: Parameters<typeof loader>[0]) => ({
        ...(await loader(request)),
        dispose() {
          disposed++;
        },
      });
      try {
        await host.reset(retainedLoader);
        host.changeOwner((owner) => {
          if (!(owner instanceof ExplorationCharacterOwner)) throw Error();
          equip(owner);
        });
        const before = host.checkpoint();
        const valid = portable
          ? {
              kind: "beacon-character-progress",
              version: 1,
              campaign: journey.progress(),
              character: wardrobe.capture(),
            }
          : {
              format: "beacon-character-exact-v1",
              campaign: journey.checkpoint(),
              character: wardrobe.capture(),
            };
        const restore = (bytes: string, resourceLoader: typeof loader) =>
          portable
            ? host.restoreProgress(bytes, resourceLoader)
            : host.restore(bytes, resourceLoader);
        const badCampaign = JSON.parse(canonical(valid));
        const campaign = JSON.parse(badCampaign.campaign);
        campaign.identity.contentId = "corrupt-legacy-content";
        badCampaign.campaign = canonical(campaign);
        const badCharacter = JSON.parse(canonical(valid));
        badCharacter.character.character.displayName = "Forged legacy";
        for (const corrupted of [badCampaign, badCharacter]) {
          await expect(
            restore(canonical(corrupted), async (request) => {
              loads++;
              return retainedLoader(request);
            }),
          ).rejects.toThrow();
          expect(loads).toBe(0);
          expect(disposed).toBe(0);
          expect(host.checkpoint()).toBe(before);
        }
        await expect(
          restore(canonical(valid), async () => {
            loads++;
            throw Error("legacy room unavailable");
          }),
        ).rejects.toThrow("legacy room unavailable");
        expect(loads).toBe(1);
        expect(disposed).toBe(0);
        expect(host.checkpoint()).toBe(before);
        await restore(canonical(valid), retainedLoader);
        expect(disposed).toBe(1);
        const upgraded = JSON.parse(host.checkpoint());
        expect(upgraded.format).toBe("beacon-character-exact-v3");
        expect(upgraded.character.character.displayName).toBe("Legacy pilgrim");
        const reopened = create();
        reopened.restore(host.checkpoint());
        expect(reopened.checkpoint()).toBe(host.checkpoint());
        expect(reopened.characterObservation().loadout.phaseBonus).toBe(0);
      } finally {
        host.dispose();
      }
    }
  });
  it("uses the same loadout through session multi-frame stepping and rejects resource preparation atomically", async () => {
    const host = new CampaignPlatformSession(
      EXPLORATION_DEFINITIONS,
      EXPLORATION_IDENTITY,
      EXPLORATION_CAMPAIGN,
      1000,
      create,
    );
    try {
      const owner = phaseOwner();
      equip(owner);
      await host.restore(owner.checkpoint(), loader);
      host.step(input(127, "heavy"));
      owner.executeFrames(input(127, "heavy"));
      host.step(input(127, null, "heavy"));
      owner.executeFrames(input(127, null, "heavy"));
      host.step(input(127), 2);
      owner.executeFrames(input(127), 2);
      expect(host.checkpoint()).toBe(owner.checkpoint());
      const before = host.checkpoint();
      const changed = create();
      await expect(
        host.restoreProgress(changed.progress(), async () => {
          throw Error("unavailable");
        }),
      ).rejects.toThrow("unavailable");
      expect(host.checkpoint()).toBe(before);
      expect(() =>
        host.changeOwner((staged) => {
          if (!(staged instanceof ExplorationCharacterOwner)) throw Error();
          equip(staged, null);
          staged.executeFrames(input(127));
          throw Error("rollback");
        }),
      ).toThrow("rollback");
      expect(host.checkpoint()).toBe(before);
    } finally {
      host.dispose();
    }
  });
});
