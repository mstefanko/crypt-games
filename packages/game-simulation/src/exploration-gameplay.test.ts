import { describe, expect, it, vi } from "vitest";
import { canonical } from "@onepage/game-project/runtime";
import { CampaignPlatformOwner } from "./campaign-platform";
import { explorationIdentityDetails } from "../../../scripts/lib/game-exploration-identity.mjs";
import { BallisticWorld } from "./ballistics";
import {
  createExplorationGameplayGame as create,
  EXPLORATION_GAMEPLAY_DEFINITION,
} from "./exploration-gameplay";
import {
  createExplorationCharacterGame,
  ExplorationCharacterOwner,
} from "./exploration-character";
import {
  EXPLORATION_CAMPAIGN,
  EXPLORATION_DEFINITIONS,
  EXPLORATION_IDENTITY,
  explorationInput as input,
} from "./exploration-game";
import {
  CampaignPlatformSession,
  prepareCampaignPlatformRecovery,
  type CampaignRoomLoader,
} from "../../game-runtime/src/session/campaign-platform";

const loader: CampaignRoomLoader = async ({ roomId, assetIds }) => ({
  roomId,
  assetIds,
  dispose() {},
});
const session = () =>
  new CampaignPlatformSession(
    EXPLORATION_DEFINITIONS,
    EXPLORATION_IDENTITY,
    EXPLORATION_CAMPAIGN,
    1000,
    create,
  );
function shoot(owner: ReturnType<typeof create>) {
  owner.executeFrames(input(0, "attack"));
  owner.executeFrames(input(0, null, "attack"));
}
function breakTarget(owner: ReturnType<typeof create>) {
  shoot(owner);
  owner.executeFrames(input(), 40);
  expect(owner.observation().gameplay.target.hp).toBe(1);
  shoot(owner);
  owner.executeFrames(input(), 40);
  expect(owner.observation().gameplay.target.hp).toBe(0);
}
function gameplay(owner: ReturnType<typeof create>) {
  return JSON.parse(owner.checkpoint()).gameplay;
}

describe("Beacon's authored static projectile and target", () => {
  it("restores a 4,095-frame production composite exactly with one campaign replay", async () => {
    const { identity } = await explorationIdentityDetails();
    const owner = create(EXPLORATION_CAMPAIGN, identity);
    for (let batch = 0; batch < 15; batch++) owner.executeFrames(input(), 256);
    owner.executeFrames(input(), 255);
    const saved = owner.checkpoint();
    expect(JSON.parse(JSON.parse(saved).campaign).history).toHaveLength(4095);
    const restored = create(EXPLORATION_CAMPAIGN, identity);
    const replay = vi.spyOn(CampaignPlatformOwner.prototype, "execute");
    try {
      restored.restore(saved);
      expect(replay).toHaveBeenCalledTimes(4095);
    } finally {
      replay.mockRestore();
    }
    expect(restored.checkpoint()).toBe(saved);
    // The next tick compacts both campaign history and equipment witnesses.
    owner.executeFrames(input());
    restored.executeFrames(input());
    expect(restored.checkpoint()).toBe(owner.checkpoint());
  });

  it("steps without presentation copies and launches from the moved/jumping hero", () => {
    for (const axis of [-127, 127] as const) {
      const owner = create();
      owner.executeFrames(input(0, "jump"));
      owner.executeFrames(input(0, null, "jump"));
      const before = owner
        .observation()
        .platform.actors.find((actor) => actor.slot === 0)!;
      const observation = vi.spyOn(
        ExplorationCharacterOwner.prototype,
        "observation",
      );
      try {
        owner.executeFrames(input(axis, "attack"));
        expect(observation).not.toHaveBeenCalled();
      } finally {
        observation.mockRestore();
      }
      const hero = owner
        .observation()
        .platform.actors.find((actor) => actor.slot === 0)!;
      const shot = gameplay(owner).shot.ballistic.configuration.bodies[0];
      expect(hero.x).not.toBe(before.x);
      expect(hero.y).not.toBe(before.y);
      expect(shot.x).toBe(
        hero.x + hero.width / 2 + hero.facing * (hero.width / 2 + 3 * 256),
      );
      expect(shot.y).toBe(hero.y + hero.height / 2);
    }
  });

  it("uses campaign command limits and rejects accessors without evaluating them", () => {
    const authored = structuredClone(EXPLORATION_CAMPAIGN);
    const longId = "exit-" + "x".repeat(110);
    (authored.rooms[0].exits[0] as { id: string }).id = longId;
    const owner = create(authored);
    owner.executeFrames(input(127), 26);
    owner.execute({ kind: "exit", id: longId });
    expect(owner.observation().roomId).toBe("gallery");
    const saved = owner.checkpoint();
    const getter = vi.fn(() => "frame");
    expect(() =>
      owner.execute({
        get kind() {
          return getter();
        },
      } as any),
    ).toThrow(/plain/);
    const inputGetter = vi.fn(() => []);
    expect(() =>
      owner.execute({
        kind: "frame",
        input: {
          get slots() {
            return inputGetter();
          },
        },
      }),
    ).toThrow(/accessor|plain/i);
    expect(getter).not.toHaveBeenCalled();
    expect(inputGetter).not.toHaveBeenCalled();
    expect(owner.checkpoint()).toBe(saved);
  });

  it("keeps campaign and gameplay unchanged if projectile preparation fails", () => {
    // A campaign room can use a different stable ID from its platform level.
    // Unsupported spark scenery must fail before the campaign frame commits.
    const authored = JSON.parse(JSON.stringify(EXPLORATION_CAMPAIGN));
    authored.initialRoom = "shelter";
    authored.rooms[0].id = "shelter";
    for (const room of authored.rooms)
      for (const exit of room.exits)
        if (exit.to === "harbor") exit.to = "shelter";
    const unsupported = create(authored);
    const original = unsupported.checkpoint();
    expect(() =>
      unsupported.execute({ kind: "frame", input: input(127, "attack") }),
    ).toThrow("Unknown spark room");
    expect(unsupported.checkpoint()).toBe(original);
    const owner = create();
    const before = owner.checkpoint();
    shoot(owner);
    const flying = owner.checkpoint();
    const fail = vi
      .spyOn(BallisticWorld.prototype, "fork")
      .mockImplementation(() => {
        throw Error("flight staging failed");
      });
    try {
      expect(() => owner.executeFrames(input())).toThrow(
        "flight staging failed",
      );
    } finally {
      fail.mockRestore();
    }
    expect(owner.checkpoint()).toBe(flying);
    expect(flying).not.toBe(before);
  });

  it("launches once per immediately accepted attack, uses P1 contacts/P2 damage and preserves exact midflight continuation", () => {
    const owner = create();
    shoot(owner);
    const moment = owner.checkpoint();
    const detached = owner.observation();
    detached.gameplay.target.rect.x++;
    detached.gameplay.projectile!.x++;
    expect(owner.checkpoint()).toBe(moment);
    expect(
      Object.isFrozen(
        EXPLORATION_GAMEPLAY_DEFINITION.destruction.objects[0].rect,
      ),
    ).toBe(true);
    expect(gameplay(owner).shot.ballistic.format).toBe("p1-ballistics-v1");
    expect(owner.observation().gameplay.projectile!.vx).toBe(6 * 256);
    const resumed = create();
    const replay = vi.spyOn(CampaignPlatformOwner.prototype, "execute");
    try {
      resumed.restore(moment);
      expect(replay).toHaveBeenCalledTimes(
        JSON.parse(JSON.parse(moment).campaign).history.length,
      );
    } finally {
      replay.mockRestore();
    }
    for (let tick = 0; tick < 40; tick++) {
      owner.executeFrames(input());
      resumed.executeFrames(input());
      expect(resumed.checkpoint()).toBe(owner.checkpoint());
    }
    expect(owner.observation().gameplay.target.hp).toBe(1);
    const state = gameplay(owner);
    expect(state.impact.ballistic.state.events[0].targetId).toBe(
      "harbor-target",
    );
    expect(state.destruction.state.receipts[0]).toMatchObject({
      sourceId: "player-spark",
      targetId: "harbor-target",
      outcome: "damage",
      damage: 1,
    });
    owner.executeFrames(input(), 100);
    expect(owner.observation().gameplay.target.hp).toBe(1);
    expect(gameplay(owner).destruction.history).toHaveLength(1);
    shoot(owner);
    owner.executeFrames(input(), 40);
    expect(owner.observation().gameplay.target.hp).toBe(0);
    expect(gameplay(owner).destruction.history).toHaveLength(2);
  });

  it("caps flight, excludes heavy/buffered attacks and moving targets, and expires sustained shots without horizon growth", () => {
    const owner = create();
    owner.executeFrames(input(0, "heavy"));
    expect(owner.observation().gameplay.projectile).toBeNull();
    owner.executeFrames(input(0, null, "heavy"));
    owner.executeFrames(input(), 14);
    shoot(owner);
    const origin = gameplay(owner).shot.ballistic.configuration;
    expect(origin.targets.length).toBeLessThanOrEqual(
      EXPLORATION_GAMEPLAY_DEFINITION.projectile.staticCandidates,
    );
    expect(
      origin.targets.every(
        (target: { shape: { owner: string } }) =>
          target.shape.owner === "beacon-scenery",
      ),
    ).toBe(true);
    owner.executeFrames(input(), 13);
    shoot(owner); // accepted melee but the live spark retains its original flight.
    expect(gameplay(owner).shot.ballistic.configuration).toEqual(origin);
    owner.executeFrames(input(), 40);
    for (let batch = 0; batch < 17; batch++) owner.executeFrames(input(), 256);
    const copy = create();
    copy.restore(owner.checkpoint());
    expect(copy.checkpoint()).toBe(owner.checkpoint());
    expect(gameplay(owner).destruction.history).toHaveLength(1);
    // Fire above every target: the bounded lifetime, rather than a collision,
    // removes this spark. Jump reaches the authored open sky normally.
    owner.executeFrames(input(-127), 7);
    owner.executeFrames(input(0, "jump"));
    owner.executeFrames(input(0, null, "jump"));
    owner.executeFrames(input(), 9);
    const previousImpact = gameplay(owner).impact;
    owner.executeFrames(input(127, "attack"));
    owner.executeFrames(input(0, null, "attack"));
    owner.executeFrames(input(), 47);
    expect(owner.observation().gameplay.projectile).toBeNull();
    expect(gameplay(owner).impact).toEqual(previousImpact);
    const buffered = create();
    buffered.executeFrames(input(0, "heavy"));
    buffered.executeFrames(input(0, null, "heavy"));
    buffered.executeFrames(input(), 9);
    shoot(buffered);
    buffered.executeFrames(input(), 6);
    expect(
      buffered.observation().platform.actors.find((actor) => actor.slot === 0)!
        .abilityId,
    ).toBe("strike");
    expect(buffered.observation().gameplay.projectile).toBeNull();
  });

  it("roundtrips ordinary shots originating beyond both visible room edges", () => {
    const left = create();
    left.executeFrames(input(-127), 20);
    left.executeFrames(input(-127, "attack"));
    expect(left.observation().platform.status).toBe("playing");
    expect(
      gameplay(left).shot.ballistic.configuration.bodies[0].x,
    ).toBeLessThan(-16 * 256);
    const right = create();
    right.executeFrames(input(127), 120);
    right.executeFrames(input(127, "jump"));
    right.executeFrames(input(127, null, "jump"));
    right.executeFrames(input(127), 30);
    right.executeFrames(input(127, "attack"));
    expect(right.observation().platform.status).toBe("playing");
    expect(
      gameplay(right).shot.ballistic.configuration.bodies[0].x,
    ).toBeGreaterThan(336 * 256);
    for (const owner of [left, right]) {
      const restored = create();
      restored.restore(owner.checkpoint());
      expect(restored.checkpoint()).toBe(owner.checkpoint());
      owner.executeFrames(input(0, null, "attack"));
      restored.executeFrames(input(0, null, "attack"));
      expect(restored.checkpoint()).toBe(owner.checkpoint());
    }
  });

  it("rejects independently valid flight/contact combined with lost or younger campaign state", () => {
    const flying = create();
    shoot(flying);
    const impact = create();
    shoot(impact);
    impact.executeFrames(input(), 40);
    const lost = create();
    lost.executeFrames(input(127), 150);
    expect(lost.observation().platform.status).toBe("lost");
    const fresh = create();
    const receiver = create();
    const original = receiver.checkpoint();
    for (const source of [flying, impact]) {
      for (const campaign of [lost, fresh]) {
        const forged = JSON.parse(campaign.checkpoint());
        forged.gameplay = gameplay(source);
        expect(() => receiver.restore(canonical(forged))).toThrow(
          campaign === lost ? "Nonplaying campaign" : "Spark age exceeds",
        );
        expect(receiver.checkpoint()).toBe(original);
      }
    }
  });

  it("restores a contact on the last allowed flight tick", () => {
    const owner = create();
    breakTarget(owner);
    owner.executeFrames(input(-127), 4);
    owner.executeFrames(input(127, "attack"));
    owner.executeFrames(input(0, null, "attack"));
    owner.executeFrames(input(), 46);
    expect(gameplay(owner).shot.ballistic.state.tick).toBe(47);
    const before = owner.checkpoint();
    const resumed = create();
    resumed.restore(before);
    owner.executeFrames(input());
    resumed.executeFrames(input());
    expect(resumed.checkpoint()).toBe(owner.checkpoint());
    expect(gameplay(owner).impact.ballistic.state.tick).toBe(48);
    const after = create();
    after.restore(owner.checkpoint());
    expect(after.checkpoint()).toBe(owner.checkpoint());
  });

  it("keeps target damage across journey import/revisit/wardrobe, clears flight at entrances and repairs only on reset", async () => {
    const owner = create();
    breakTarget(owner);
    shoot(owner);
    const live = owner.checkpoint();
    const journey = owner.progress();
    expect(JSON.parse(journey).gameplay.shot).toBeUndefined();
    const portable = create();
    portable.restoreProgress(journey);
    expect(portable.observation().gameplay.target.hp).toBe(0);
    expect(portable.observation().gameplay.projectile).toBeNull();
    owner.executeFrames(input(127), 26);
    owner.execute({ kind: "exit", id: "to-gallery" });
    owner.execute({ kind: "exit", id: "to-harbor" });
    expect(owner.observation().gameplay.target.hp).toBe(0);
    expect(owner.observation().gameplay.projectile).toBeNull();
    const active = session();
    await active.restore(live, loader);
    const before = JSON.parse(active.checkpoint()).gameplay;
    active.changeOwner((selected) => {
      if (!(selected instanceof ExplorationCharacterOwner))
        throw Error("unexpected owner");
      selected.chooseCharacter("pilgrim", "cool-plain", "Ocean");
    });
    expect(JSON.parse(active.checkpoint()).gameplay).toEqual(before);
    await active.reset(loader);
    expect(
      JSON.parse(active.checkpoint()).gameplay.destruction.state.objects[0].hp,
    ).toBe(2);
    expect(JSON.parse(active.checkpoint()).gameplay.shot).toBeNull();
  });

  it("rejects forged primitive state/targets and historical saves atomically, retaining rejected originals", () => {
    const owner = create();
    shoot(owner);
    const moment = owner.checkpoint();
    const edits = [
      (saved: any) =>
        saved.gameplay.shot.ballistic.state.bodies[0].positionRemainderX++,
      (saved: any) =>
        saved.gameplay.shot.ballistic.configuration.targets[0].shape.rect.x++,
      (saved: any) =>
        (saved.gameplay.shot.ballistic.configuration.bodies[0].vx = 1),
      (saved: any) => (saved.gameplay.definition.projectile.liveCap = 4),
      (saved: any) => (saved.gameplay.destruction.state.objects[0].hp = 0),
      (saved: any) => (saved.gameplay.shot.roomId = "gallery"),
      (saved: any) => (saved.gameplay.shot.ballistic.state.tick = 256),
    ];
    for (const edit of edits) {
      const saved = JSON.parse(moment);
      edit(saved);
      expect(() => owner.restore(canonical(saved))).toThrow();
      expect(owner.checkpoint()).toBe(moment);
    }
    const old = createExplorationCharacterGame();
    expect(() => owner.restore(old.checkpoint())).toThrow("no migration");
    const original = old.progress();
    const rejected = prepareCampaignPlatformRecovery(
      EXPLORATION_DEFINITIONS,
      EXPLORATION_IDENTITY,
      EXPLORATION_CAMPAIGN,
      original,
      create,
    );
    expect(rejected.status).toBe("rejected");
    expect(rejected.original).toBe(original);
    expect(owner.checkpoint()).toBe(moment);
  });

  it("rolls back extension flight/contact/damage through multi-frame failures and failed/cancelled resource transitions", async () => {
    const owner = create();
    shoot(owner);
    const before = owner.checkpoint();
    const original = CampaignPlatformOwner.prototype.execute;
    let steps = 0;
    const fail = vi
      .spyOn(CampaignPlatformOwner.prototype, "execute")
      .mockImplementation(function (this: CampaignPlatformOwner, command) {
        if (++steps === 35) throw Error("staged projectile failure");
        return original.call(this, command);
      });
    try {
      expect(() => owner.executeFrames(input(), 40)).toThrow(
        "staged projectile failure",
      );
    } finally {
      fail.mockRestore();
    }
    expect(owner.checkpoint()).toBe(before);
    const active = session();
    await active.restore(before, loader);
    await expect(
      active.restore(before, async () => {
        throw Error("assets unavailable");
      }),
    ).rejects.toThrow("assets unavailable");
    expect(active.checkpoint()).toBe(before);
    let release!: (value: Awaited<ReturnType<CampaignRoomLoader>>) => void;
    const pending = active.reset(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    await Promise.resolve();
    active.step(input());
    const changed = active.checkpoint();
    release(await loader({ roomId: "harbor", assetIds: ["harbor-palette"] }));
    expect((await pending).status).toBe("stale");
    expect(active.checkpoint()).toBe(changed);
  });

  it("forks exact ballistic carries and configuration without aliasing either branch", () => {
    const owner = create();
    shoot(owner);
    const checkpoint = gameplay(owner).shot.ballistic;
    const world = new BallisticWorld(checkpoint.configuration);
    world.restore(checkpoint);
    const branch = world.fork(),
      captured = world.capture();
    branch.step();
    expect(world.capture()).toEqual(captured);
    const observed = branch.observe();
    observed.bodies[0].x++;
    expect(branch.observe()).not.toEqual(observed);
    world.step();
    expect(branch.capture()).toEqual(world.capture());
  });
});
