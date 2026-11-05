import { describe, expect, it } from "vitest";
import { createWorld, step } from "./simulation";
import { serializeCheckpoint } from "./checkpoint";
import {
  CampaignPlatformOwner,
  CAMPAIGN_PLATFORM_LIMITS,
} from "./campaign-platform";
import {
  EXPLORATION_CAMPAIGN as authored,
  EXPLORATION_DEFINITIONS as definitions,
  EXPLORATION_IDENTITY as identity,
  createExplorationGame as create,
  explorationInput as input,
} from "./exploration-game";
import {
  CampaignPlatformSession,
  CampaignPlatformRecoveryError,
} from "../../game-runtime/src/session/campaign-platform";
const move = (
  game: CampaignPlatformOwner,
  ticks: number,
  axis: -127 | 0 | 127 = 0,
) => game.executeFrames(input(axis), ticks);
const travel = (game: CampaignPlatformOwner, id: string) =>
  game.execute({ kind: "exit", id });
const attack = (game: CampaignPlatformOwner) => {
  game.executeFrames(input(0, "attack"));
  game.executeFrames(input(0, null, "attack"));
  move(game, 14);
};
const gallery = () => {
  const game = create();
  move(game, 26, 127);
  travel(game, "to-gallery");
  return game;
};
function defeat(game: CampaignPlatformOwner, id: string) {
  for (
    let tick = 0;
    tick < 180 &&
    game.observation().platform.actors.find((actor) => actor.spawnId === id)!
      .health;
    tick++
  ) {
    const observation = game.observation(),
      hero = observation.platform.actors.find((actor) => actor.slot === 0)!,
      enemy = observation.platform.actors.find(
        (actor) => actor.spawnId === id,
      )!;
    if (Math.abs(enemy.x - hero.x) > 28 * 256)
      move(game, 1, enemy.x > hero.x ? 127 : -127);
    else attack(game);
  }
  expect(
    game.observation().platform.actors.find((actor) => actor.spawnId === id)!
      .health,
  ).toBe(0);
}
function unlock() {
  const game = gallery();
  defeat(game, "sentinel");
  move(game, 1, 127);
  while (
    game.observation().platform.actors.find((actor) => actor.slot === 0)!.x <
    244 * 256
  )
    move(game, 1, 127);
  travel(game, "to-shrine");
  move(game, 26, 127);
  game.execute({ kind: "pickup", id: "phase" });
  travel(game, "shrine-shortcut");
  travel(game, "phase-gate");
  return game;
}
describe("M9 B0 platform consumer and authored Beacon Return", () => {
  it("saves future-affecting windup/recovery decisions and replays their real platform attacks", () => {
    const game = gallery();
    let sawWindup = false,
      sawAttack = false,
      sawRecovery = false;
    for (let tick = 0; tick < 200; tick++) {
      move(game, 1);
      const observation = game.observation(),
        enemy = observation.platform.actors.find(
          (actor) => actor.slot === null,
        )!;
      sawWindup ||= observation.behaviors[0].actor.state === "windup";
      sawAttack ||= enemy.abilityId !== null;
      sawRecovery ||= observation.behaviors[0].actor.state === "recover";
      if (observation.behaviors[0].actor.state === "windup") {
        const saved = game.checkpoint(),
          restored = create();
        restored.restore(saved);
        for (let future = 0; future < 40; future++) {
          move(game, 1);
          move(restored, 1);
          expect(restored.checkpoint()).toBe(game.checkpoint());
        }
        const state = JSON.parse(saved);
        state.behaviors[0].actor.timer++;
        const before = restored.checkpoint();
        expect(() => restored.restore(JSON.stringify(state))).toThrow();
        expect(restored.checkpoint()).toBe(before);
      }
      if (sawWindup && sawAttack && sawRecovery) break;
    }
    expect([sawWindup, sawAttack, sawRecovery]).toEqual([true, true, true]);
    expect(
      game.observation().platform.actors.find((actor) => actor.slot === 0)!
        .health,
    ).toBeLessThan(18);
  });
  it("keeps bounded compaction, role timer validation and atomic malformed frame rejection", () => {
    const game = create();
    move(game, 256);
    for (let batch = 0; batch < 16; batch++) move(game, 256);
    expect(JSON.parse(game.checkpoint()).base).not.toBeNull();
    const reopened = create();
    reopened.restore(game.checkpoint());
    move(game, 20);
    move(reopened, 20);
    expect(reopened.checkpoint()).toBe(game.checkpoint());
    const encounter = gallery();
    for (let batch = 0; batch < 16; batch++) move(encounter, 256);
    const encounterBytes = encounter.checkpoint(),
      compact = JSON.parse(encounterBytes);
    expect(compact.base.behaviors).toHaveLength(1);
    const copy = create();
    copy.restore(encounterBytes);
    move(encounter, 1);
    move(copy, 1);
    expect(copy.checkpoint()).toBe(encounter.checkpoint());
    compact.base.behaviors[0].actor.timer = 100;
    const retained = copy.checkpoint();
    expect(() => copy.restore(JSON.stringify(compact))).toThrow(
      /behavior actor integer/,
    );
    expect(copy.checkpoint()).toBe(retained);
    const before = game.checkpoint();
    expect(() =>
      game.executeFrames(
        {
          slots: [
            {
              slot: 0,
              held: input().slots[0].held,
              axes: { moveX: 128 },
              edges: [],
            },
          ],
        },
        2,
      ),
    ).toThrow();
    expect(game.checkpoint()).toBe(before);
    const bad = structuredClone(authored) as unknown as Record<string, unknown>;
    bad.traversal = null;
    expect(
      () =>
        new CampaignPlatformOwner(
          definitions,
          identity,
          bad as unknown as typeof authored,
        ),
    ).toThrow(/traversal/);
    expect(CAMPAIGN_PLATFORM_LIMITS.commands).toBe(4096);
  });
  it("requires physical traversal, grants a real burst-strike, checkpoints, death recovery, keeper victory and reset", () => {
    const initial = create();
    expect(() => travel(initial, "phase-gate")).toThrow(/gate/);
    const game = unlock();
    game.execute({ kind: "checkpoint" });
    const x = game.observation().platform.actors[0].x;
    game.executeFrames(input(127, "heavy"));
    const burst = game.observation().platform.actors[0];
    expect(burst.x - x).toBe(34 * 256);
    expect(burst.abilityId).toBe("strike");
    game.executeFrames(input(0, null, "heavy"));
    move(game, 14);
    // A deliberate fall demonstrates checkpoint/death policy with acquired progress.
    move(game, 36, 127);
    move(game, 80);
    expect(game.observation().platform.status).toBe("lost");
    game.execute({ kind: "recover" });
    expect(game.observation().roomId).toBe("crossing");
    expect(
      game.observation().transactions.flags.find((flag) => flag.id === "phase")!
        .value,
    ).toBe(true);
    // Cross the actual pit with a jump plus the acquired burst.
    move(game, 36, 127);
    game.executeFrames(input(127, "jump"));
    game.executeFrames(input(127, null, "jump"));
    move(game, 16, 127);
    game.executeFrames(input(127, "heavy"));
    game.executeFrames(input(127, null, "heavy"));
    move(game, 16, 127);
    defeat(game, "sentinel");
    while (game.observation().platform.actors[0].x < 244 * 256)
      move(game, 1, 127);
    travel(game, "to-beacon");
    expect(() => game.execute({ kind: "pickup", id: "beacon" })).toThrow();
    defeat(game, "keeper");
    while (game.observation().platform.actors[0].x < 148 * 256)
      move(game, 1, 127);
    game.execute({ kind: "pickup", id: "beacon" });
    expect(game.observation().visited).toHaveLength(5);
    expect(
      game
        .observation()
        .transactions.flags.find((flag) => flag.id === "complete")!.value,
    ).toBe(true);
    const portable = game.progress(),
      restored = create();
    restored.restoreProgress(portable);
    expect(restored.observation().roomId).toBe("crossing");
    expect(restored.observation().transactions).toEqual(
      game.observation().transactions,
    );
    const corrupt = JSON.parse(portable);
    corrupt.defeated = corrupt.defeated.filter(
      (id: string) => !id.includes("keeper"),
    );
    expect(() => restored.restoreProgress(JSON.stringify(corrupt))).toThrow(
      /defeat/,
    );
    game.execute({ kind: "reset" });
    expect(game.observation().visited).toEqual(["harbor"]);
    expect(
      game.observation().transactions.flags.every((flag) => !flag.value),
    ).toBe(true);
  });
  it("rejects malformed NPC intent overrides before changing platform authority", () => {
    const world = createWorld(definitions, identity, "gallery-start"),
      before = serializeCheckpoint(world);
    const player = world.actors.find((actor) => actor.slot === 0)!,
      enemy = world.actors.find((actor) => actor.slot === null)!;
    for (const [id, intent] of [
      [player.id, { axis: 0, attack: false }],
      [enemy.id, { axis: 128, attack: false }],
      [enemy.id, { axis: 0 }],
      [enemy.id, { axis: 0, attack: false, extra: true }],
    ] as const) {
      expect(() =>
        step(
          world,
          input(),
          new Map([[id, intent]]) as Parameters<typeof step>[2],
        ),
      ).toThrow(/NPC/);
      expect(serializeCheckpoint(world)).toBe(before);
    }
  });
  it("stages portable resources before publication and retains invalid import originals", async () => {
    const owner = unlock(),
      session = new CampaignPlatformSession(definitions, identity, authored);
    owner.execute({ kind: "checkpoint" });
    const original = owner.progress(),
      before = session.checkpoint();
    let complete!: () => void,
      loads = 0,
      disposed = 0;
    const pending = session.restoreProgress(
      original,
      async ({ roomId, assetIds }) => {
        loads++;
        await new Promise<void>((resolve) => {
          complete = resolve;
        });
        return {
          roomId,
          assetIds,
          dispose: () => {
            disposed++;
          },
        };
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(session.checkpoint()).toBe(before);
    complete();
    await pending;
    expect(session.observation().roomId).toBe("crossing");
    const saved = session.checkpoint(),
      invalid = original.replace('"version":1', '"version":99');
    try {
      await session.restoreProgress(invalid, async () => {
        throw Error("must not load");
      });
      throw Error("must reject");
    } catch (error) {
      expect(error).toBeInstanceOf(CampaignPlatformRecoveryError);
      expect((error as CampaignPlatformRecoveryError).original).toBe(invalid);
    }
    expect(session.checkpoint()).toBe(saved);
    expect(loads).toBe(1);
    session.dispose();
    expect(disposed).toBe(1);
  });
});

it("keeps empty behavior lists compatible with v2 and rejects v2/v3 cross-loads atomically", () => {
  const plain = structuredClone(authored);
  for (const room of plain.rooms) delete (room as any).behaviors;
  const empty = structuredClone(plain);
  for (const room of empty.rooms) (room as any).behaviors = [];
  const v2 = new CampaignPlatformOwner(definitions, identity, plain);
  const withEmpty = new CampaignPlatformOwner(definitions, identity, empty);
  const v3 = create();
  expect(JSON.parse(v3.progress()).definition.rooms).toEqual(authored.rooms);
  expect(JSON.parse(withEmpty.checkpoint()).format).toBe("campaign-platform-v2");
  withEmpty.restore(v2.checkpoint());
  expect(withEmpty.checkpoint()).toBe(v2.checkpoint());
  for (const [target, other] of [[v2, v3], [v3, v2]]) {
    const before = target.checkpoint();
    expect(() => target.restore(other.checkpoint())).toThrow();
    expect(target.checkpoint()).toBe(before);
  }
});

it("runs two independent placements including a ranger and restores their future decisions", () => {
  const authoredPair = structuredClone(authored), platformPair = structuredClone(definitions);
  const level = platformPair.levels.find(l => l.id === "harbor")!;
  // Controlled authored encounter in a flat room; exercise both roles together.
  (level.spawns as Array<(typeof level.spawns)[number]>).push(
    { ...platformPair.levels.find(l => l.id === "gallery")!.spawns[1], id: "close-bruiser", x: 70 * 256 },
    { ...platformPair.levels.find(l => l.id === "crossing")!.spawns[1], id: "close-ranger", x: 94 * 256 },
  );
  (authoredPair.rooms[0] as any).behaviors = [
    { spawnId: "close-bruiser", role: "bruiser" },
    { spawnId: "close-ranger", role: "ranger" },
  ];
  const game = new CampaignPlatformOwner(platformPair, identity, authoredPair);
  const sawAttacks = new Set<string>(), sawWindups = new Set<string>();
  let saved = false;
  for (let tick = 0; tick < 160; tick++) {
    move(game, 1);
    const o = game.observation();
    for (const b of o.behaviors) if (b.actor.state === "windup") sawWindups.add(b.role);
    for (const a of o.platform.actors) if (a.slot === null && a.abilityId) sawAttacks.add(a.spawnId);
    if (!saved && o.behaviors.some(b => b.actor.state === "windup")) {
      const restored = new CampaignPlatformOwner(platformPair, identity, authoredPair);
      restored.restore(game.checkpoint());
      for (let future = 0; future < 12; future++) {
        move(restored, 1); move(game, 1);
        expect(restored.checkpoint()).toBe(game.checkpoint());
      }
      saved = true;
    }
  }
  expect(saved).toBe(true);
  expect([...sawWindups].sort()).toEqual(["bruiser", "ranger"]);
  expect([...sawAttacks].sort()).toEqual(["close-bruiser", "close-ranger"]);
});
