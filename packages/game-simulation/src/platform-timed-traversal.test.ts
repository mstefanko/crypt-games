import { describe, it, expect } from "vitest";
import raw from "../../../examples/game-m1/definitions.json";
import { validateDefinitions, UNIT as U } from "../../game-project/src/index";
import {
  CampaignPlatformOwner,
  type CampaignPlatformDefinition,
} from "./campaign-platform";
import { compilePlatformRoom, platformTemplate } from "./platform-room-library";
import {
  neutralPlatformHeld,
  type PlatformActionV2,
  type PlatformHeldV2,
  type PlatformInputFrameV2,
} from "./platform-input-v2";
import {
  enumeratePlatformWaitPhases,
  recordTimedFerryTraversal,
} from "./platform-timed-traversal";
import type { GameDefinitions } from "../../game-project/src/runtime";
function content() {
  const level = compilePlatformRoom(
    platformTemplate("ferry-rest"),
    "ferry-room",
  );
  const body = { x: -6 * U, y: -24 * U, width: 12 * U, height: 24 * U };
  const defs: GameDefinitions = {
    manifest: {
      ...raw.manifest,
      schemaVersion: 1,
      rulesModule: "platform-combat-v1",
      gameId: "timed-test",
      initialLevelId: level.id,
      initialScenarioId: "start",
      levelIds: [level.id],
      archetypeIds: ["courier"],
      abilityIds: raw.abilities.map((a) => a.id),
      scenarioIds: ["start"],
    },
    levels: [level],
    archetypes: [
      {
        id: "courier",
        body,
        hurt: body,
        push: body,
        health: 3,
        speed: 2 * U,
        jumpSpeed: 7 * U,
        gravity: 96,
        maxFallSpeed: 8 * U,
        coyoteTicks: 6,
        jumpBufferTicks: 6,
        attackBufferTicks: 6,
        abilities: raw.archetypes[0].abilities,
        ai: "none",
        aiRange: 0,
      },
    ],
    abilities: raw.abilities,
    scenarios: [
      {
        id: "start",
        levelId: level.id,
        seed: 1,
        playerSlots: [0],
        ticks: 1800,
        actions: [],
        assertions: [],
      },
    ],
  };
  const campaign: CampaignPlatformDefinition = {
    id: "ferry-course",
    inputCodec: "platform-input-v2",
    initialRoom: level.id,
    initialAnchor: "west",
    transactions: {
      id: "ledger",
      resources: [],
      stats: [],
      flags: [],
      outcomes: [],
      rewardSeed: 1,
    },
    rooms: [
      {
        id: level.id,
        scenarioId: "start",
        assets: [],
        exits: [],
        pickups: [],
        checkpoint: null,
        permanentEnemies: [],
        defaultAnchor: "west",
        anchors: [
          { id: "west", x: 32 * U, y: 208 * U, facing: 1, settleTicks: 1 },
        ],
      },
    ],
  };
  return {
    definitions: validateDefinitions(defs),
    campaign,
    identity: { rulesBuildId: "timed-rules", contentId: "timed-content" },
  };
}
function recorder(
  owner: CampaignPlatformOwner,
  after?: (frame: PlatformInputFrameV2) => void,
) {
  let held: PlatformHeldV2 = neutralPlatformHeld();
  const frames: PlatformInputFrameV2[] = [];
  return {
    frames,
    frame(axis = 0, actions: PlatformActionV2[] = []) {
      const next = neutralPlatformHeld();
      for (const a of actions) next[a] = true;
      const edges = (Object.keys(next) as PlatformActionV2[])
        .filter((a) => next[a] !== held[a])
        .map((action) => ({
          action,
          kind: next[action] ? ("pressed" as const) : ("released" as const),
        }));
      const f = {
        slots: [{ slot: 0, held: next, axes: { moveX: axis }, edges }],
      };
      owner.execute({ kind: "frame", input: f });
      held = next;
      frames.push(f);
      after?.(f);
    },
  };
}
describe("production timed ferry certificates", () => {
  it("waits, boards, rides and jumps to recovery floor using only ordinary frames", () => {
    const c = content(),
      owner = new CampaignPlatformOwner(c.definitions, c.identity, c.campaign);
    const { frame, frames } = recorder(owner);
    const evidence = recordTimedFerryTraversal(
      owner,
      frame,
      c.definitions.levels[0].platforms[0],
    );
    expect(evidence.waitTicks).toBeGreaterThan(0);
    expect(evidence.rideTicks).toBeGreaterThan(100);
    expect(evidence.periodTicks).toBe(384);
    expect(evidence.sampledPhaseCount).toBe(384);
    expect(evidence.totalTicks).toBe(frames.length);
    const a = owner.observation().platform.actors[0];
    expect(a.grounded).toBe(true);
    expect(a.x).toBeGreaterThan(352 * U);
    const replay = new CampaignPlatformOwner(
      c.definitions,
      c.identity,
      c.campaign,
    );
    for (const input of frames) replay.execute({ kind: "frame", input });
    expect(replay.checkpoint()).toBe(owner.checkpoint());
  });
  it("exact restores mid-ride and continues all subsequent ordinary frames byte-for-byte", () => {
    const c = content(),
      owner = new CampaignPlatformOwner(c.definitions, c.identity, c.campaign);
    let restored: CampaignPlatformOwner | undefined;
    let compared = 0;
    const { frame } = recorder(owner, (input) => {
      if (restored) {
        restored.execute({ kind: "frame", input });
        expect(restored.checkpoint()).toBe(owner.checkpoint());
        compared++;
      } else if (
        owner.observation().platform.actors[0].platformMotion?.supportId ===
        "platform:ferry"
      ) {
        restored = new CampaignPlatformOwner(
          c.definitions,
          c.identity,
          c.campaign,
        );
        restored.restore(owner.checkpoint());
        expect(restored.checkpoint()).toBe(owner.checkpoint());
      }
    });
    recordTimedFerryTraversal(
      owner,
      frame,
      c.definitions.levels[0].platforms[0],
    );
    expect(compared).toBeGreaterThan(100);
  });
  it("rejects authored blocked rider corridors before issuing a timed certificate", () => {
    const c = content(),
      l = c.definitions.levels[0];
    expect(() =>
      validateDefinitions({
        ...c.definitions,
        levels: [
          {
            ...l,
            rectangles: [
              ...l.rectangles,
              {
                id: "overhead-stop",
                x: 200 * U,
                y: 140 * U,
                width: 16 * U,
                height: 36 * U,
                oneWay: false,
              },
            ],
          },
        ],
      }),
    ).toThrow(/rider path intersects/);
  });
  it("measures the snapped production period and the distinct stride-sampled states", () => {
    const c = content(),
      l = c.definitions.levels[0],
      p = l.platforms[0];
    const definitions = validateDefinitions({
      ...c.definitions,
      levels: [
        { ...l, platforms: [{ ...p, endX: p.x + 10 * U, speed: 3 * U }] },
      ],
    });
    const owner = new CampaignPlatformOwner(
        definitions,
        c.identity,
        c.campaign,
      ),
      { frame } = recorder(owner);
    const start = owner.observation().platform.platforms[0],
      sampled = new Set<string>();
    for (let phase = 0; phase < 8; phase++) {
      const p = owner.observation().platform.platforms[0];
      sampled.add(`${p.x}:${p.direction}`);
      for (let g = 0; g < 3; g++) frame();
    }
    expect(sampled.size).toBe(
      enumeratePlatformWaitPhases(10 * U, 3 * U, 3).phaseCount,
    );
    expect(owner.observation().platform.platforms[0]).toEqual(start);
  });
  it("uses finite neutral waits from several reachable predeparture phases", () => {
    for (const delay of [1, 17, 128, 383]) {
      const c = content(),
        owner = new CampaignPlatformOwner(
          c.definitions,
          c.identity,
          c.campaign,
        ),
        { frame } = recorder(owner);
      for (let n = 0; n < delay; n++) frame();
      const evidence = recordTimedFerryTraversal(
        owner,
        frame,
        c.definitions.levels[0].platforms[0],
      );
      expect(evidence.waitTicks).toBeLessThanOrEqual(evidence.periodTicks);
      expect(evidence.rideTicks).toBeGreaterThan(0);
    }
  });
  it("enumerates P/gcd(P,g) phases including endpoint-snap periods", () => {
    expect(enumeratePlatformWaitPhases(10, 3, 3)).toEqual({
      periodTicks: 8,
      strideTicks: 3,
      phaseCount: 8,
      phases: [0, 3, 6, 1, 4, 7, 2, 5],
    });
    expect(enumeratePlatformWaitPhases(12, 3, 2).phaseCount).toBe(4);
    expect(enumeratePlatformWaitPhases(192 * U, U, 8).phaseCount).toBe(48);
    expect(() => enumeratePlatformWaitPhases(100000, 1)).toThrow(/budget/);
  });
});
