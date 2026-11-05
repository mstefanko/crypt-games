import { describe, expect, it, vi } from "vitest";
import { createWorld, step, observe } from "./simulation";
import { copyValidatedWorld, serializeCheckpoint } from "./checkpoint";
import * as checkpointCodec from "./checkpoint";
import type { World } from "./types";
import * as inputCodec from "./input";
import { neutralHeld } from "./input";
import {
  CampaignPlatformOwner,
  CAMPAIGN_PLATFORM_LIMITS,
} from "./campaign-platform";
import {
  CAMPAIGN_PLATFORM_FIXTURE as authored,
  CAMPAIGN_PLATFORM_FIXTURE_DEFINITIONS as definitions,
  CAMPAIGN_PLATFORM_FIXTURE_IDENTITY as identity,
  createCampaignPlatformFixture as fixture,
} from "./campaign-platform-fixture";
import type { InputFrame } from "@onepage/game-project/runtime";
const input = (axis = 0): InputFrame => ({
  slots: [{ slot: 0, held: neutralHeld(), axes: { moveX: axis }, edges: [] }],
});
const move = (owner: CampaignPlatformOwner, axis: number, ticks: number) => {
  for (let i = 0; i < ticks; i++)
    owner.execute({ kind: "frame", input: input(axis) });
};
const exit = (owner: CampaignPlatformOwner, id: string) =>
  owner.execute({ kind: "exit", id });
const unlock = (owner: CampaignPlatformOwner) => {
  move(owner, 127, 26);
  exit(owner, "to-shrine");
  move(owner, 127, 26);
  owner.execute({ kind: "pickup", id: "phase" });
  move(owner, -127, 26);
  exit(owner, "to-hall");
  exit(owner, "sealed-door");
};
const attack = (owner: CampaignPlatformOwner) => {
  owner.execute({
    kind: "frame",
    input: {
      slots: [
        {
          slot: 0,
          held: { ...neutralHeld(), attack: true },
          axes: { moveX: 0 },
          edges: [{ action: "attack", kind: "pressed" }],
        },
      ],
    },
  });
  owner.execute({
    kind: "frame",
    input: {
      slots: [
        {
          slot: 0,
          held: neutralHeld(),
          axes: { moveX: 0 },
          edges: [{ action: "attack", kind: "released" }],
        },
      ],
    },
  });
  move(owner, 0, 4);
};

describe("M8b authored campaign/platform composition", () => {
  it("validates each frame once, including terminal frames, with platform error precedence", () => {
    const owner = fixture();
    const consume = vi.spyOn(inputCodec, "consumeFrame");
    try {
      owner.executeFrames(input());
      expect(consume).toHaveBeenCalledTimes(1);
      const world = (owner as unknown as { world: World }).world;
      const hero = world.actors.find((actor) => actor.slot === 0)!;
      hero.health = 0;
      hero.grounded = false;
      hero.riderId = null;
      world.campaign.defeatedPlacementIds.push(
        JSON.stringify([world.levelId, hero.spawnId]),
      );
      world.status = "lost";
      owner.executeFrames(input());
      expect(consume).toHaveBeenCalledTimes(2);
      const terminal = (owner as unknown as { world: World }).world;
      terminal.tick = Number.MAX_SAFE_INTEGER;
      terminal.decoder.lastTick = terminal.tick - 1;
      const invalid = {
        slots: [
          {
            ...input().slots[0],
            edges: [{ action: "invalid", kind: "pressed" }],
          },
        ],
      } as any;
      let expected = "";
      try {
        step(copyValidatedWorld(terminal), invalid);
      } catch (error) {
        expected = (error as Error).message;
      }
      expect(expected).toMatch(/exhaust|counter|safe/i);
      expect(() => owner.executeFrames(invalid)).toThrow(expected);
      expect(consume).toHaveBeenCalledTimes(2);
    } finally {
      consume.mockRestore();
    }
  });

  it("never freezes or retains caller definitions through construction and restore", () => {
    const platform = structuredClone(definitions);
    const campaign = structuredClone(authored);
    const selectedIdentity = { ...identity };
    const owner = new CampaignPlatformOwner(
      platform,
      selectedIdentity,
      campaign,
    );
    owner.executeFrames(input());
    const saved = owner.checkpoint();
    owner.restore(saved);
    const assertUnfrozen = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      expect(Object.isFrozen(value)).toBe(false);
      for (const child of Object.values(value)) assertUnfrozen(child);
    };
    for (const value of [platform, campaign, selectedIdentity])
      assertUnfrozen(value);
    (platform.levels[0] as any).deathY++;
    (campaign.rooms[0].assets as string[]).push("caller-asset");
    selectedIdentity.rulesBuildId = "changed";
    expect(owner.checkpoint()).toBe(saved);
  });

  it("uses the exact existing platform authority for movement, combat and decoder state", () => {
    const owner = fixture();
    const world = createWorld(definitions, identity, "hall-start");
    for (let i = 0; i < 20; i++) {
      const frame = input(127);
      owner.execute({ kind: "frame", input: frame });
      step(world, frame);
    }
    expect(owner.observation().platform).toEqual(observe(world));
    expect(JSON.parse(owner.checkpoint()).platform).toBe(
      serializeCheckpoint(world),
    );
    const saved = owner.checkpoint(),
      restored = fixture();
    restored.restore(saved);
    move(owner, -127, 10);
    move(restored, -127, 10);
    expect(restored.checkpoint()).toBe(owner.checkpoint());
  });
  it("stages ordinary frames without encoding or decoding external checkpoints", () => {
    const owner = fixture();
    const decode = vi.spyOn(checkpointCodec, "restoreCheckpoint");
    const encode = vi.spyOn(checkpointCodec, "serializeCheckpoint");
    try {
      owner.executeFrames(input(127), 8);
      expect(decode).not.toHaveBeenCalled();
      expect(encode).not.toHaveBeenCalled();
    } finally {
      decode.mockRestore();
      encode.mockRestore();
    }
    const restored = fixture();
    restored.restore(owner.checkpoint());
    owner.executeFrames(input(-127), 8);
    restored.executeFrames(input(-127), 8);
    expect(restored.checkpoint()).toBe(owner.checkpoint());
  });
  it("copies all mutable platform state while sharing only frozen prepared definitions", () => {
    const owner = fixture();
    owner.execute({
      kind: "frame",
      input: {
        slots: [
          {
            slot: 0,
            held: { ...neutralHeld(), attack: true },
            axes: { moveX: 0 },
            edges: [{ action: "attack", kind: "pressed" }],
          },
        ],
      },
    });
    const world = (owner as unknown as { world: World }).world;
    const before = serializeCheckpoint(world);
    const copied = copyValidatedWorld(world);
    expect(serializeCheckpoint(copied)).toBe(before);
    expect(copied.definitions).toBe(world.definitions);
    expect(Object.isFrozen(copied.definitions.levels[0].tiles)).toBe(true);
    expect(() => {
      (copied.definitions.levels[0] as any).deathY = 0;
    }).toThrow();
    copied.identity.contentId = "changed";
    copied.initialPlayerSlots.push(3);
    copied.actors[0].ai.direction = -1;
    copied.actors[0].execution!.hits.push({
      targetId: 99,
      count: 1,
      lastTick: 0,
    });
    copied.actors[0].health = 0;
    copied.decoder.slots[0].held.attack = false;
    copied.decoder.slots[0].axes.moveX = 127;
    copied.campaign.visitedLevelIds.push("vault");
    copied.campaign.defeatedPlacementIds.push("forged");
    copied.index.buckets.set("forged", []);
    expect(world.index.buckets.has("forged")).toBe(false);
    expect(serializeCheckpoint(world)).toBe(before);
    // The direct validator retains contact, decoder, counter and outcome invariants.
    for (const mutate of [
      (w: World) => {
        w.actors[0].grounded = false;
        w.actors[0].riderId = "missing";
      },
      (w: World) => {
        w.decoder.lastTick--;
      },
      (w: World) => {
        w.nextEntityId = w.actors[0].id;
      },
      (w: World) => {
        w.actors[0].health = 0;
      },
      (w: World) => {
        w.actors[0].x = Number.MAX_SAFE_INTEGER;
      },
    ]) {
      const invalid = copyValidatedWorld(world);
      mutate(invalid);
      expect(() => copyValidatedWorld(invalid)).toThrow();
      expect(serializeCheckpoint(world)).toBe(before);
    }
  });
  it("rolls back a late invalid edge across compaction without copying retained prefixes", () => {
    const owner = fixture();
    for (let batch = 0; batch < 15; batch++) owner.executeFrames(input(), 256);
    owner.executeFrames(input(), 255);
    const history = (owner as any).history;
    const before = owner.checkpoint();
    const press: InputFrame = {
      slots: [
        {
          slot: 0,
          held: { ...neutralHeld(), attack: true },
          axes: { moveX: 0 },
          edges: [{ action: "attack", kind: "pressed" }],
        },
      ],
    };
    expect(() => owner.executeFrames(press, 2)).toThrow(/Pressed/);
    expect(owner.checkpoint()).toBe(before);
    expect((owner as any).history).toBe(history);
    expect(history).toHaveLength(4095);
    owner.executeFrames(input(), 2);
    expect((owner as any).history).not.toBe(history);
    const restored = fixture();
    restored.restore(owner.checkpoint());
    owner.executeFrames(input(127), 2);
    restored.executeFrames(input(127), 2);
    expect(restored.checkpoint()).toBe(owner.checkpoint());
  });
  it("preserves the external canonical checkpoint byte cap for internal staging", () => {
    const defs = structuredClone(definitions);
    const spawn = defs.levels[0].spawns[0];
    (defs.levels[0] as any).spawns = Array.from({ length: 256 }, (_, i) => ({
      ...spawn,
      id: `actor-${i}`,
      slot: i === 0 ? 0 : null,
      team: i % 2,
    }));
    const world = createWorld(defs, identity, "hall-start");
    world.tick = 1_000_000_000_000_000;
    world.decoder.lastTick = world.tick - 1;
    for (const [index, actor] of world.actors.entries()) {
      actor.id = 1_000_000_000_000_000 + index;
      actor.execution = {
        id: actor.id,
        abilityId: "strike",
        tick: 0,
        hits: [],
      };
    }
    world.nextEntityId = world.nextExecutionId = Number.MAX_SAFE_INTEGER;
    for (const actor of world.actors)
      actor.execution!.hits = world.actors
        .filter((target) => target.team !== actor.team)
        .map((target) => ({
          targetId: target.id,
          count: 1,
          lastTick: world.tick - 1,
        }));
    expect(serializeCheckpoint(world).length).toBeGreaterThan(2097152);
    expect(() =>
      checkpointCodec.restoreCheckpoint(
        defs,
        identity,
        serializeCheckpoint(world),
      ),
    ).toThrow(/byte limit/);
    expect(() => copyValidatedWorld(world)).toThrow(/byte limit/);
  });
  it("publishes only validated, current, single-use prepared restores with detached metadata", () => {
    class Composite extends CampaignPlatformOwner {
      prepare(bytes: string) {
        return this.prepareCampaignRestore(bytes, false);
      }
    }
    const owner = new Composite(definitions, identity, authored);
    const source = fixture();
    source.executeFrames(input(), 3);
    const saved = source.checkpoint();
    const ready = owner.prepare(saved);
    (ready.history[0] as any).input.slots[0].axes.moveX = 127;
    (ready.history as any[]).pop();
    ready.adopt();
    expect(owner.checkpoint()).toBe(saved);
    expect(() => ready.adopt()).toThrow(/Stale/);
    const stale = owner.prepare(saved);
    owner.executeFrames(input(), 1);
    const before = owner.checkpoint();
    expect(() => stale.adopt()).toThrow(/Stale/);
    expect(() => owner.prepare("{}")).toThrow();
    expect(owner.checkpoint()).toBe(before);
  });
  it("requires physical reach and acquired permission, revisits and commits seeded rewards once", () => {
    const owner = fixture(),
      before = owner.checkpoint();
    expect(() => exit(owner, "sealed-door")).toThrow(/gate/);
    expect(() => exit(owner, "to-shrine")).toThrow(/reach/);
    expect(owner.checkpoint()).toBe(before);
    unlock(owner);
    expect(owner.observation().visited).toEqual(["hall", "shrine", "vault"]);
    expect(owner.observation().transactions.flags).toEqual([
      { id: "phase", value: true },
    ]);
    expect(owner.observation().transactions.resources[0].quantity).toBe(1);
    owner.execute({ kind: "checkpoint" });
    move(owner, 127, 26);
    owner.execute({ kind: "pickup", id: "chest" });
    const collected = owner.checkpoint();
    expect(() => owner.execute({ kind: "pickup", id: "chest" })).toThrow(
      /already committed/,
    );
    expect(owner.checkpoint()).toBe(collected);
    move(owner, -127, 26);
    exit(owner, "to-hall");
    exit(owner, "sealed-door");
    expect(owner.observation().transactions.revision).toBe(3);
    expect(owner.observation().transactions.outcomes).toEqual([
      "phase-shrine",
      "vault-chest",
      "vault-opened",
    ]);
  });
  it("stages a whole destination and reward without mutation and rejects stale/forged plans", () => {
    const owner = fixture();
    unlock(owner);
    exit(owner, "to-hall");
    const before = owner.checkpoint(),
      plan = owner.stageEntry("exit", "sealed-door");
    expect(owner.checkpoint()).toBe(before);
    expect(() => owner.commitEntry({ ...plan, assets: ["unknown"] })).toThrow(
      /plan/,
    );
    expect(owner.checkpoint()).toBe(before);
    move(owner, 0, 1);
    const after = owner.checkpoint();
    expect(() => owner.commitEntry(plan)).toThrow(/Stale/);
    expect(owner.checkpoint()).toBe(after);
    const current = owner.stageEntry("exit", "sealed-door");
    owner.commitEntry(current);
    const committed = owner.checkpoint();
    expect(() => owner.commitEntry(current)).toThrow(/Stale/);
    expect(owner.checkpoint()).toBe(committed);
  });
  it("preserves ability/rewards/permanent enemies but resets ordinary combat/motion after checkpoint death", () => {
    const owner = fixture();
    move(owner, 127, 26);
    exit(owner, "to-shrine");
    move(owner, 127, 26);
    owner.execute({ kind: "pickup", id: "phase" });
    move(owner, 127, 32);
    attack(owner);
    expect(
      owner.observation().platform.actors.find((a) => a.spawnId === "guardian")!
        .health,
    ).toBe(0);
    expect(owner.observation().defeated).toEqual(['["shrine","guardian"]']);
    move(owner, -127, 58);
    exit(owner, "to-hall");
    move(owner, 127, 26);
    exit(owner, "to-shrine");
    expect(
      owner.observation().platform.actors.find((a) => a.spawnId === "guardian")!
        .health,
    ).toBe(0);
    exit(owner, "to-hall");
    exit(owner, "sealed-door");
    owner.execute({ kind: "checkpoint" });
    move(owner, 127, 26);
    owner.execute({ kind: "pickup", id: "chest" });
    move(owner, 127, 32);
    attack(owner);
    expect(
      owner.observation().platform.actors.find((a) => a.spawnId === "guardian")!
        .health,
    ).toBe(0);
    move(owner, 127, 90);
    expect(owner.observation().platform.status).toBe("lost");
    const durable = owner.observation().transactions;
    owner.execute({ kind: "recover" });
    const state = owner.observation();
    expect(state.roomId).toBe("vault");
    expect(state.platform.status).toBe("playing");
    expect(
      state.platform.actors.find((a) => a.spawnId === "guardian")!.health,
    ).toBe(1);
    expect(state.platform.actors.find((a) => a.slot === 0)!.health).toBe(12);
    expect(state.platform.tick).toBe(0);
    expect(state.transactions).toEqual(durable);
    expect(state.defeated).toEqual(['["shrine","guardian"]']);
    const restored = fixture();
    restored.restore(owner.checkpoint());
    expect(restored.checkpoint()).toBe(owner.checkpoint());
    const portable = fixture();
    portable.restoreProgress(owner.progress());
    expect(portable.observation().defeated).toEqual(
      owner.observation().defeated,
    );
    expect(portable.observation().transactions).toEqual(
      owner.observation().transactions,
    );
    owner.execute({ kind: "reset" });
    expect(owner.observation().roomId).toBe("hall");
    expect(owner.observation().transactions.revision).toBe(0);
    expect(owner.observation().defeated).toEqual([]);
    expect(owner.observation().visited).toEqual(["hall"]);
  });
  it("replays exact cross-room continuation, RNG rewards and reset history", () => {
    const owner = fixture();
    unlock(owner);
    owner.execute({ kind: "checkpoint" });
    move(owner, 127, 26);
    const saved = owner.checkpoint(),
      restored = fixture();
    restored.restore(saved);
    for (const target of [owner, restored]) {
      target.execute({ kind: "pickup", id: "chest" });
      move(target, 127, 32);
      attack(target);
      move(target, 127, 90);
      target.execute({ kind: "recover" });
      target.execute({ kind: "reset" });
      unlock(target);
    }
    expect(restored.checkpoint()).toBe(owner.checkpoint());
    const resetRestored = fixture();
    resetRestored.restore(owner.checkpoint());
    expect(resetRestored.checkpoint()).toBe(owner.checkpoint());
  });
  it("rejects corrupt/incompatible or impossible imports without changing the retained checkpoint", () => {
    const owner = fixture();
    unlock(owner);
    owner.execute({ kind: "checkpoint" });
    move(owner, 127, 26);
    owner.execute({ kind: "pickup", id: "chest" });
    const before = owner.checkpoint();
    const mutate = [
      (v: any) => (v.identity.contentId = "other"),
      (v: any) => (v.definition.rooms[0].exits[0].to = "vault"),
      (v: any) => v.transactions.resources[0].quantity++,
      (v: any) => v.transactions.random.streams[0].draws++,
      (v: any) => v.transactions.outcomes.pop(),
      (v: any) => v.transactions.receipts.pop(),
      (v: any) => (v.checkpointRoomId = "hall"),
      (v: any) => v.visited.pop(),
      (v: any) => v.defeated.push('["vault","guardian"]'),
      (v: any) => v.history.pop(),
      (v: any) =>
        (v.platform = v.platform.replace('"lastTick":25', '"lastTick":24')),
      (v: any) => (v.extra = true),
    ];
    for (const corrupt of mutate) {
      const v = JSON.parse(before);
      corrupt(v);
      expect(() => owner.restore(JSON.stringify(v))).toThrow();
      expect(owner.checkpoint()).toBe(before);
    }
    for (const bytes of [
      "{}",
      '{"format":1,"format":2}',
      "[".repeat(33),
      " ".repeat(CAMPAIGN_PLATFORM_LIMITS.bytes + 1),
    ]) {
      expect(() => owner.restore(bytes)).toThrow();
      expect(owner.checkpoint()).toBe(before);
    }
  });
  it("rejects malformed commands and nested exotic input atomically, including terminal states", () => {
    const owner = fixture();
    const getter = {
      kind: "frame",
      get input() {
        throw Error("must not invoke accessor");
      },
    };
    const invalid: any[] = [
      getter,
      { kind: "unknown" },
      { kind: "pickup", id: "missing" },
      { kind: "checkpoint" },
      { kind: "recover" },
      { kind: "frame", input: { slots: [], commands: {} } },
      { kind: "frame", input: { slots: [], commands: [{ type: "restart" }] } },
      {
        kind: "frame",
        input: {
          slots: [
            {
              slot: 0,
              held: neutralHeld(),
              axes: { moveX: 0 },
              edges: [],
              extra: 1,
            },
          ],
        },
      },
      { kind: "frame", input: { slots: [], extra: 1 } },
      { kind: "frame", input: { slots: [], commands: "bad" } },
      { kind: "frame", input: { slots: [], [Symbol("hidden")]: 1 } },
      { kind: "frame", input: { slots: [], toJSON: () => ({ slots: [] }) } },
    ];
    for (const command of invalid) {
      const before = owner.checkpoint();
      expect(() => owner.execute(command)).toThrow();
      expect(owner.checkpoint()).toBe(before);
    }
    move(owner, 127, 160);
    expect(owner.observation().platform.status).toBe("lost");
    const before = owner.checkpoint();
    expect(() =>
      owner.execute({
        kind: "frame",
        input: { slots: [], commands: {} },
      } as any),
    ).toThrow();
    expect(owner.checkpoint()).toBe(before);
  });
  it("validates authored graph, gates, outcomes, permanent placements and detached data", () => {
    const variants = [
      (v: any) => (v.rooms[0].exits[0].to = "missing"),
      (v: any) => (v.rooms[0].exits[0].requires = "missing"),
      (v: any) => v.rooms[0].pickups.push(v.rooms[1].pickups[0]),
      (v: any) => v.rooms[0].permanentEnemies.push("player"),
      (v: any) => v.rooms.push(v.rooms[0]),
      (v: any) => v.rooms[0].assets.push("hall-palette"),
    ];
    for (const change of variants) {
      const bad = structuredClone(authored);
      change(bad);
      expect(
        () => new CampaignPlatformOwner(definitions, identity, bad),
      ).toThrow();
    }
    const defs = structuredClone(definitions),
      desc = structuredClone(authored),
      id = structuredClone(identity),
      owner = new CampaignPlatformOwner(defs, id, desc);
    (defs.levels[0] as any).deathY = 0;
    (desc.rooms[0] as any).id = "changed";
    id.contentId = "changed";
    const observed = owner.observation();
    (observed.room as any).id = "changed";
    (observed.transactions.resources[0] as any).quantity = 90;
    observed.platform.actors[0].health = 0;
    expect(owner.checkpoint()).toBe(fixture().checkpoint());
  });
  it("compacts sustained play beyond 4096 frames and repeatedly restores exact continuation", () => {
    let owner = fixture();
    const stale = owner.stageEntry("reset");
    for (let batch = 0; batch < 36; batch++) {
      owner.executeFrames({ slots: [] }, 256);
      if (batch % 8 === 7) {
        const saved = owner.checkpoint();
        const restored = fixture();
        restored.restore(saved);
        expect(restored.checkpoint()).toBe(saved);
        owner = restored;
      }
    }
    expect(owner.observation().platform.tick).toBe(9216);
    const saved = JSON.parse(owner.checkpoint());
    expect(saved.base).not.toBeNull();
    expect(saved.history.length).toBeLessThan(
      CAMPAIGN_PLATFORM_LIMITS.commands,
    );
    expect(() => owner.commitEntry(stale)).toThrow(/Stale/);
    const restored = fixture();
    restored.restore(owner.checkpoint());
    owner.executeFrames(input(127), 26);
    restored.executeFrames(input(127), 26);
    expect(restored.checkpoint()).toBe(owner.checkpoint());
    owner.execute({ kind: "reset" });
    expect(owner.checkpoint()).toBe(fixture().checkpoint());
  }, 30_000);
  it("retains exact lost state across compaction and recovers without a history reserve", () => {
    const owner = fixture();
    move(owner, 127, 160);
    for (let i = 0; i < 17; i++) owner.executeFrames({ slots: [] }, 256);
    const restored = fixture();
    restored.restore(owner.checkpoint());
    expect(restored.observation().platform.status).toBe("lost");
    for (const target of [owner, restored]) target.execute({ kind: "recover" });
    expect(restored.checkpoint()).toBe(owner.checkpoint());
    expect(owner.observation().platform.status).toBe("playing");
  }, 30_000);
  it("rolls back a multi-frame gesture when a later platform frame exhausts its counter", () => {
    const owner = fixture();
    owner.restoreProgress(owner.progress());
    const value = JSON.parse(owner.checkpoint());
    const platform = JSON.parse(value.platform);
    platform.tick = Number.MAX_SAFE_INTEGER - 4096;
    platform.decoder.lastTick = platform.tick - 1;
    value.platform = JSON.stringify(platform);
    value.base.platform = value.platform;
    // Platform serialization is canonical; preserve its object field ordering.
    const restorePlatform = createWorld(definitions, identity, "hall-start");
    restorePlatform.tick = platform.tick;
    restorePlatform.decoder.lastTick = platform.decoder.lastTick;
    value.platform = serializeCheckpoint(restorePlatform);
    value.base.platform = value.platform;
    owner.restore(JSON.stringify(value));
    for (let batch = 0; batch < 15; batch++)
      owner.executeFrames({ slots: [] }, 256);
    owner.executeFrames({ slots: [] }, 255);
    expect(JSON.parse(owner.checkpoint()).history).toHaveLength(4095);
    const before = owner.checkpoint();
    expect(() => owner.executeFrames({ slots: [] }, 4)).toThrow();
    expect(owner.checkpoint()).toBe(before);
  });
  it("accepts platform tile arrays larger than the command history limit", () => {
    const platform = structuredClone(definitions);
    for (const level of platform.levels) {
      (level as any).width = 80 * 16;
      (level as any).height = 60 * 16;
      (level as any).tiles = Array(80 * 60).fill(0);
    }
    expect(
      () => new CampaignPlatformOwner(platform, identity, authored),
    ).not.toThrow();
  });
  it("rolls back exit reward and destination when a complete transaction cannot fit", () => {
    const bad = structuredClone(authored);
    (bad.transactions.resources[0] as any).capacity = 0;
    const owner = new CampaignPlatformOwner(definitions, identity, bad);
    move(owner, 127, 26);
    exit(owner, "to-shrine");
    move(owner, 127, 26);
    owner.execute({ kind: "pickup", id: "phase" });
    move(owner, -127, 26);
    exit(owner, "to-hall");
    const before = owner.checkpoint();
    expect(() => owner.stageEntry("exit", "sealed-door")).toThrow();
    expect(owner.checkpoint()).toBe(before);
    expect(() => exit(owner, "sealed-door")).toThrow();
    expect(owner.checkpoint()).toBe(before);
  });
  it("compacts byte-heavy frame history and preserves exact continuation", () => {
    const owner = fixture();
    move(owner, 127, 160);
    const frame: InputFrame = {
      slots: Array.from({ length: 4 }, (_, slot) => ({
        slot,
        held: neutralHeld(),
        axes: { moveX: 0 },
        edges: Array.from({ length: 32 }, () => ({
          action: "jump" as const,
          kind: "cancel" as const,
        })),
      })),
    };
    for (let i = 0; i < 500; i++)
      owner.execute({ kind: "frame", input: frame });
    const saved = owner.checkpoint();
    const state = JSON.parse(saved);
    expect(state.base).not.toBeNull();
    expect(JSON.stringify(state.history).length).toBeLessThan(
      CAMPAIGN_PLATFORM_LIMITS.historyBytes,
    );
    const restored = fixture();
    restored.restore(saved);
    expect(restored.checkpoint()).toBe(saved);
    owner.execute({ kind: "recover" });
    restored.execute({ kind: "recover" });
    expect(restored.checkpoint()).toBe(owner.checkpoint());
  }, 30_000);
  it("exports durable portable progress and resumes the authored checkpoint entrance", () => {
    const owner = fixture();
    unlock(owner);
    owner.execute({ kind: "checkpoint" });
    move(owner, 127, 26);
    owner.execute({ kind: "pickup", id: "chest" });
    const saved = owner.progress();
    const data = JSON.parse(saved);
    expect(data.platform).toBeUndefined();
    expect(data.history).toBeUndefined();
    expect(data.roomId).toBeUndefined();
    const restored = fixture();
    restored.restoreProgress(saved);
    expect(restored.progress()).toBe(saved);
    expect(restored.observation().roomId).toBe("vault");
    expect(restored.observation().platform.tick).toBe(0);
    expect(
      restored.observation().platform.actors.find((a) => a.slot === 0)!.x,
    ).toBe(26 * 256);
    expect(restored.observation().transactions).toEqual(
      owner.observation().transactions,
    );
    expect(restored.observation().visited).toEqual(owner.observation().visited);
    move(restored, 127, 26);
    expect(() => restored.execute({ kind: "pickup", id: "chest" })).toThrow(
      /already committed/,
    );
    const exact = fixture();
    exact.restore(restored.checkpoint());
    expect(exact.checkpoint()).toBe(restored.checkpoint());
  });
  it("rejects inconsistent portable progression, gates, sources, balances and versions atomically", () => {
    const owner = fixture();
    unlock(owner);
    owner.execute({ kind: "checkpoint" });
    move(owner, 127, 26);
    owner.execute({ kind: "pickup", id: "chest" });
    const portable = owner.progress();
    const before = owner.checkpoint();
    const mutations = [
      (v: any) => v.version++,
      (v: any) => v.compatibility++,
      (v: any) => (v.identity.contentId = "changed"),
      (v: any) => v.transactions.resources[0].quantity++,
      (v: any) => (v.transactions.commands[0].operations[0].value = false),
      (v: any) => v.transactions.random.streams[0].state++,
      (v: any) => v.visited.pop(),
      (v: any) => v.defeated.push('["vault","guardian"]'),
      (v: any) => (v.checkpointRoomId = "shrine"),
      (v: any) => v.events.reverse(),
      (v: any) => v.events.push(v.events[0]),
      (v: any) => (v.platform = "forged"),
    ];
    for (const mutate of mutations) {
      const value = JSON.parse(portable);
      mutate(value);
      expect(() => owner.restoreProgress(JSON.stringify(value))).toThrow();
      expect(owner.checkpoint()).toBe(before);
    }
    const gated = JSON.parse(fixture().progress());
    gated.events.push({
      kind: "visit",
      id: "vault",
      from: "hall",
      exit: "sealed-door",
    });
    gated.visited.push("vault");
    expect(() => owner.restoreProgress(JSON.stringify(gated))).toThrow(
      /Unreachable/,
    );
    const missingReward = JSON.parse(portable);
    missingReward.events = missingReward.events.filter(
      (e: any) => e.id !== "vault-opened" && e.id !== "vault-chest",
    );
    const phaseOnly = fixture();
    move(phaseOnly, 127, 26);
    exit(phaseOnly, "to-shrine");
    move(phaseOnly, 127, 26);
    phaseOnly.execute({ kind: "pickup", id: "phase" });
    missingReward.transactions = phaseOnly.observation().transactions;
    expect(() => owner.restoreProgress(JSON.stringify(missingReward))).toThrow(
      /missing authored exit outcome/,
    );
    expect(() => owner.restoreProgress(before)).toThrow();
    expect(() => owner.restore(portable)).toThrow();
  });
  it("explicitly replays historical exact v1 saves and upgrades to a bounded v2 base", () => {
    const owner = fixture();
    move(owner, 127, 26);
    exit(owner, "to-shrine");
    move(owner, 127, 26);
    owner.execute({ kind: "pickup", id: "phase" });
    const old = JSON.parse(owner.checkpoint());
    old.format = "campaign-platform-v1";
    delete old.events;
    delete old.base;
    old.transactions.commands[0].id = "campaign-53";
    old.transactions.receipts[0].id = "campaign-53";
    const restored = fixture();
    restored.restore(JSON.stringify(old));
    expect(restored.observation().platform).toEqual(
      owner.observation().platform,
    );
    expect(JSON.parse(restored.checkpoint()).format).toBe(
      "campaign-platform-v2",
    );
    const again = fixture();
    again.restore(restored.checkpoint());
    expect(again.checkpoint()).toBe(restored.checkpoint());
    const invalid = structuredClone(old);
    invalid.transactions.resources[0].quantity++;
    expect(() => again.restore(JSON.stringify(invalid))).toThrow(
      /Inconsistent/,
    );
  });
  it("rejects a destination whose prepared platform authority cannot validate before publication", () => {
    const bad = structuredClone(definitions);
    (bad.levels[1].spawns[0] as any).y = 160 * 256;
    const owner = new CampaignPlatformOwner(bad, identity, authored);
    move(owner, 127, 26);
    const before = owner.checkpoint();
    expect(() => owner.stageEntry("exit", "to-shrine")).toThrow(/embedded/);
    expect(owner.checkpoint()).toBe(before);
  });
});
