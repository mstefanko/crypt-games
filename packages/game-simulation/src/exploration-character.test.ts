import { describe, it, expect } from "vitest";
import {
  ExplorationCharacterOwner,
  createExplorationCharacterGame as create,
} from "./exploration-character";
import {
  createExplorationGame,
  explorationInput,
  EXPLORATION_DEFINITIONS,
  EXPLORATION_IDENTITY,
  EXPLORATION_CAMPAIGN,
} from "./exploration-game";
import { CampaignPlatformSession } from "../../game-runtime/src/session/campaign-platform";
function customize(owner: ExplorationCharacterOwner) {
  owner.executeCharacter({
    id: "name",
    revision: 1,
    action: {
      kind: "customize",
      appearanceId: "cool-cape",
      displayName: "Ocean",
    },
  });
  owner.executeCharacter({
    id: "cape",
    revision: 2,
    action: { kind: "equip", slotId: "cloak", itemId: null },
  });
}
const session = () =>
  new CampaignPlatformSession(
    EXPLORATION_DEFINITIONS,
    EXPLORATION_IDENTITY,
    EXPLORATION_CAMPAIGN,
    1000,
    create,
  );
const loader = async ({
  roomId,
  assetIds,
}: {
  roomId: string;
  assetIds: readonly string[];
}) => ({ roomId, assetIds, dispose() {} });
describe("Beacon durable character", () => {
  it("detaches caller-owned campaign data for later exact and portable reopen", () => {
    const campaign = JSON.parse(JSON.stringify(EXPLORATION_CAMPAIGN));
    const owner = new ExplorationCharacterOwner(campaign);
    const exact = owner.checkpoint(),
      progress = owner.progress();
    campaign.rooms[0].assets[0] = "edited-palette";
    owner.restore(exact);
    expect(owner.checkpoint()).toBe(exact);
    owner.restoreProgress(progress);
    expect(owner.progress()).toBe(progress);
  });
  it("retains layered wardrobe with exact continuation and portable entrance recovery", () => {
    const owner = create();
    const platformBefore = JSON.parse(owner.checkpoint()).campaign;
    customize(owner);
    expect(JSON.parse(owner.checkpoint()).campaign).toBe(platformBefore);
    owner.executeFrames(explorationInput(127), 26);
    owner.execute({ kind: "exit", id: "to-gallery" });
    const exact = create();
    exact.restore(owner.checkpoint());
    expect(exact.checkpoint()).toBe(owner.checkpoint());
    exact.executeFrames(explorationInput(), 12);
    owner.executeFrames(explorationInput(), 12);
    expect(exact.checkpoint()).toBe(owner.checkpoint());
    const portable = create();
    portable.restoreProgress(owner.progress());
    expect(portable.observation().roomId).toBe("harbor");
    expect(portable.observation().visited).toEqual(["harbor", "gallery"]);
    expect(portable.characterObservation()).toEqual(
      owner.characterObservation(),
    );
    owner.execute({ kind: "reset" });
    expect(owner.characterObservation()).toEqual(
      portable.characterObservation(),
    );
  });
  it("rejects either corrupted authority atomically and enforces C1 requirements", () => {
    const owner = create();
    customize(owner);
    const original = owner.checkpoint();
    const corrupt = JSON.parse(original);
    corrupt.character.character.displayName = "Forged";
    expect(() => owner.restore(JSON.stringify(corrupt))).toThrow();
    expect(owner.checkpoint()).toBe(original);
    const bad = JSON.parse(original);
    bad.campaign = bad.campaign.replace("m9-b0-platform-v1", "unknown-rules");
    expect(() => owner.restore(JSON.stringify(bad))).toThrow();
    expect(owner.checkpoint()).toBe(original);
    expect(() =>
      owner.executeCharacter({
        id: "bad",
        revision: 3,
        action: { kind: "equip", slotId: "cloak", itemId: "unknown" },
      }),
    ).toThrow();
    expect(owner.checkpoint()).toBe(original);
    const noncanonical = JSON.parse(original);
    noncanonical.campaign = JSON.stringify(
      JSON.parse(noncanonical.campaign),
      null,
      2,
    );
    expect(() => owner.restore(JSON.stringify(noncanonical))).toThrow(
      "Noncanonical",
    );
    expect(owner.checkpoint()).toBe(original);
    const forgedProgress = JSON.parse(owner.progress());
    forgedProgress.character.character.displayName = "Forged";
    expect(() =>
      owner.restoreProgress(JSON.stringify(forgedProgress)),
    ).toThrow();
    expect(owner.checkpoint()).toBe(original);
    const wrongProgress = JSON.parse(owner.progress());
    wrongProgress.campaign = wrongProgress.campaign.replace(
      "beacon-five-rooms-v1",
      "wrong-content",
    );
    expect(() =>
      owner.restoreProgress(JSON.stringify(wrongProgress)),
    ).toThrow();
    expect(owner.checkpoint()).toBe(original);
    const unknownExact = JSON.parse(original);
    unknownExact.format = "beacon-character-exact-v99";
    expect(() => owner.restore(JSON.stringify(unknownExact))).toThrow();
    expect(owner.checkpoint()).toBe(original);
    const progress = JSON.parse(owner.progress());
    progress.version = 99;
    expect(() => owner.restoreProgress(JSON.stringify(progress))).toThrow();
    expect(owner.checkpoint()).toBe(original);
  });
  it("chooses starters atomically while rebasing replay history and preserving campaign authority", () => {
    const owner = create();
    owner.executeFrames(explorationInput(127), 26);
    owner.execute({ kind: "exit", id: "to-gallery" });
    const campaign = owner.observation();
    const progress = JSON.parse(owner.progress()).campaign;
    owner.chooseCharacter("pilgrim", "cool-cape", "Pilgrim");
    expect(owner.observation().platform).toEqual(campaign.platform);
    expect(JSON.parse(owner.progress()).campaign).toBe(progress);
    expect(JSON.parse(JSON.parse(owner.checkpoint()).campaign).history).toEqual(
      [],
    );
    expect(owner.characterObservation().character).toMatchObject({
      buildId: "pilgrim",
      displayName: "Pilgrim",
      equipment: [],
    });
    const before = owner.checkpoint();
    for (const args of [
      ["unknown", "cool-cape", "Name"],
      ["traveler", "missing", "Name"],
      ["traveler", "cool-cape", ""],
    ]) {
      expect(() => owner.chooseCharacter(args[0], args[1], args[2])).toThrow();
      expect(owner.checkpoint()).toBe(before);
    }
    const restored = create();
    restored.restore(before);
    expect(restored.checkpoint()).toBe(before);
    restored.restoreProgress(owner.progress());
    expect(restored.characterObservation()).toEqual(
      owner.characterObservation(),
    );
  });
  it("explicitly imports original journey v1 without losing discoveries and original exact v3", () => {
    const old = createExplorationGame();
    old.executeFrames(explorationInput(127), 26);
    old.execute({ kind: "exit", id: "to-gallery" });
    const next = create();
    customize(next);
    next.restoreProgress(old.progress());
    expect(next.observation().visited).toEqual(old.observation().visited);
    expect(next.characterObservation().selection.appearanceId).toBe(
      "warm-cape",
    );
    next.restore(old.checkpoint());
    expect(next.observation().platform).toEqual(old.observation().platform);
  });
  it("retains wardrobe through an actual death and checkpoint recovery", () => {
    const owner = create();
    customize(owner);
    const wardrobe = owner.characterObservation();
    owner.executeFrames(explorationInput(127), 140);
    owner.executeFrames(explorationInput(), 80);
    expect(owner.observation().platform.status).toBe("lost");
    owner.execute({ kind: "recover" });
    expect(owner.characterObservation()).toEqual(wardrobe);
    expect(owner.observation().platform.status).toBe("playing");
  });
  it("stages both authorities, retains resources after failure, and invalidates late loads on customization", async () => {
    const host = session();
    await host.reset(loader);
    const before = host.checkpoint();
    const corrupt = JSON.parse(before);
    corrupt.character.character.displayName = "Forged";
    let loads = 0;
    await expect(
      host.restore(JSON.stringify(corrupt), async (request) => {
        loads++;
        return loader(request);
      }),
    ).rejects.toThrow();
    expect(loads).toBe(0);
    expect(host.checkpoint()).toBe(before);
    const other = create();
    customize(other);
    await expect(
      host.restore(other.checkpoint(), async () => {
        throw Error("load failed");
      }),
    ).rejects.toThrow("load failed");
    expect(host.checkpoint()).toBe(before);
    let resolve!: (resource: Awaited<ReturnType<typeof loader>>) => void;
    let disposed = 0;
    const pending = host.restore(
      other.checkpoint(),
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await Promise.resolve();
    host.changeOwner((owner) => {
      if (!(owner instanceof ExplorationCharacterOwner)) throw Error();
      customize(owner);
    });
    const changed = host.checkpoint();
    resolve({
      roomId: "harbor",
      assetIds: ["harbor-palette"],
      dispose() {
        disposed++;
      },
    });
    expect((await pending).status).toBe("stale");
    expect(disposed).toBe(1);
    expect(host.checkpoint()).toBe(changed);
    expect(() =>
      host.changeOwner((owner) => {
        if (!(owner instanceof ExplorationCharacterOwner))
          throw Error("wrong owner");
        owner.executeCharacter({
          id: "staged-fresh-change",
          revision: owner.characterObservation().revision,
          action: {
            kind: "customize",
            appearanceId: "warm-cape",
            displayName: "Must not leak",
          },
        });
        owner.executeFrames(explorationInput(127), 2);
        expect(owner.checkpoint()).not.toBe(changed);
        expect(owner.characterObservation().character!.displayName).toBe(
          "Must not leak",
        );
        throw Error("reject");
      }),
    ).toThrow();
    expect(host.checkpoint()).toBe(changed);
    host.dispose();
  });
});

it("session factory retains edited behavior through staged load and discards a rejected second wardrobe command", async () => {
  const { createExplorationCampaign } = await import("./exploration-game");
  const { DEFAULT_CAMPAIGN_BEHAVIOR_DOCUMENT } = await import(
    "./behavior-authoring"
  );
  const content = structuredClone(DEFAULT_CAMPAIGN_BEHAVIOR_DOCUMENT);
  const campaign = createExplorationCampaign({
    ...content,
    rooms: {
      ...content.rooms,
      gallery: { sentinel: { ...content.rooms.gallery.sentinel, windup: 30 } },
    },
  });
  const factory = () => create(campaign);
  const host = new CampaignPlatformSession(
    EXPLORATION_DEFINITIONS,
    EXPLORATION_IDENTITY,
    campaign,
    1000,
    factory,
  );
  try {
    await host.reset(loader);
    host.step(explorationInput(127), 26);
    await host.travel("to-gallery", loader);
    expect(host.observation().behaviors[0].parameters!.windup).toBe(30);
    const before = host.checkpoint();
    await host.restore(before, loader);
    expect(host.checkpoint()).toBe(before);
    expect(() =>
      host.changeOwner((owner) => {
        if (!(owner instanceof ExplorationCharacterOwner))
          throw Error("wrong owner");
        owner.executeCharacter({
          id: "first",
          revision: 1,
          action: {
            kind: "customize",
            appearanceId: "cool-cape",
            displayName: "Staged",
          },
        });
        expect(owner.checkpoint()).not.toBe(before);
        owner.executeCharacter({
          id: "second",
          revision: 2,
          action: { kind: "equip", slotId: "cloak", itemId: "missing" },
        });
      }),
    ).toThrow();
    expect(host.checkpoint()).toBe(before);
    const incompatible = create();
    let loads = 0;
    await expect(
      host.restore(incompatible.checkpoint(), async (request) => {
        loads++;
        return loader(request);
      }),
    ).rejects.toThrow();
    expect(loads).toBe(0);
    expect(host.checkpoint()).toBe(before);
    await expect(
      host.restoreProgress(incompatible.progress(), loader),
    ).rejects.toThrow();
    expect(host.checkpoint()).toBe(before);
  } finally {
    host.dispose();
  }
});
