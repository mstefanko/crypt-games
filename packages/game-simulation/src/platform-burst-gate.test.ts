import { expect, it } from "vitest";
import {
  CampaignPlatformOwner,
  type CampaignPlatformDefinition,
} from "./campaign-platform";
import { CAMPAIGN_PLATFORM_FIXTURE_DEFINITIONS as base } from "./campaign-platform-fixture";
import {
  compileBurstReturnGateLevel,
  compileBurstReturnGateRoom,
  validateBurstReturnGate,
} from "./platform-burst-gate";
import {
  neutralPlatformHeld,
  type PlatformActionV2,
  type PlatformHeldV2,
} from "./platform-input-v2";
const U = 256;
function fixture(unlocked = true) {
  const hero = {
    ...base.archetypes[0],
    id: "courier",
    speed: 512,
    jumpSpeed: 1792,
    gravity: 96,
    maxFallSpeed: 2048,
    coyoteTicks: 6,
  };
  const level = compileBurstReturnGateLevel("gate");
  const gate = {
    ...compileBurstReturnGateRoom("gate", "gate"),
    exits: [],
    pickups: [
      {
        id: "unlock",
        area: { x: 48 * U, y: 176 * U, width: 32 * U, height: 32 * U },
        outcome: {
          id: "earned",
          operations: [{ kind: "flag" as const, flag: "burst", value: true }],
        },
      },
    ],
  };
  const definitions = {
    ...base,
    manifest: {
      ...base.manifest,
      levelIds: ["gate"],
      archetypeIds: ["courier"],
      scenarioIds: ["gate-start"],
      initialLevelId: "gate",
      initialScenarioId: "gate-start",
    },
    levels: [level],
    archetypes: [hero],
    scenarios: [{ ...base.scenarios[0], id: "gate-start", levelId: "gate" }],
  };
  const campaign: CampaignPlatformDefinition = {
    id: "burst-gate",
    initialRoom: "gate",
    inputCodec: "platform-input-v2",
    traversal: { flag: "burst", distance: 8192 },
    rooms: [gate],
    transactions: {
      id: "ledger",
      resources: [],
      stats: [],
      flags: ["burst"],
      outcomes: ["earned"],
      rewardSeed: 1,
    },
  };
  const owner = new CampaignPlatformOwner(
    definitions,
    { rulesBuildId: "burst-gate-rules", contentId: "gap-112" },
    campaign,
  );
  if (unlocked) owner.execute({ kind: "pickup", id: "unlock" });
  let held: PlatformHeldV2 = neutralPlatformHeld();
  return {
    owner,
    level,
    hero,
    gate,
    frame(axis = 0, actions: PlatformActionV2[] = []) {
      const next = neutralPlatformHeld();
      for (const a of actions) next[a] = true;
      const edges = (Object.keys(next) as PlatformActionV2[])
        .filter((a) => next[a] !== held[a])
        .map((action) => ({
          action,
          kind: next[action] ? ("pressed" as const) : ("released" as const),
        }));
      owner.execute({
        kind: "frame",
        input: {
          slots: [{ slot: 0, held: next, axes: { moveX: axis }, edges }],
        },
      });
      held = next;
    },
  };
}
it("crosses the restricted gap using ordinary acquired burst input", () => {
  const f = fixture();
  expect(
    validateBurstReturnGate(f.level, f.hero, f.gate).maximumUnassistedGap,
  ).toBeLessThan(112 * U);
  for (let i = 0; i < 35; i++) f.frame(127);
  f.frame(127, ["jump"]);
  for (let i = 0; i < 14; i++) f.frame(127);
  f.frame(127, ["heavy"]);
  for (let i = 0; i < 35; i++) f.frame(127);
  const a = f.owner.observation().platform.actors[0];
  expect(f.owner.observation().platform.status).toBe("playing");
  expect(a.grounded).toBe(true);
  expect(a.x).toBeGreaterThan(240 * U);
});
it("cannot cross by holding drop or unacquired burst on the same approach", () => {
  for (const actions of [[], ["drop"], ["heavy"]] as PlatformActionV2[][]) {
    const f = fixture(false);
    for (let i = 0; i < 35; i++) f.frame(127);
    f.frame(127, ["jump", ...actions]);
    for (let i = 0; i < 60; i++) f.frame(127, actions);
    expect(f.owner.observation().platform.status).toBe("lost");
  }
});
it("rejects reverse/aerial ingress and extra supports that bypass the envelope", () => {
  const f = fixture();
  expect(() =>
    validateBurstReturnGate(f.level, f.hero, {
      ...f.gate,
      anchors: [
        { id: "reverse", x: 300 * U, y: 208 * U, facing: -1, settleTicks: 1 },
      ],
    }),
  ).toThrow(/ingress/);
  expect(() =>
    validateBurstReturnGate(
      {
        ...f.level,
        rectangles: [
          {
            id: "bypass",
            x: 100 * U,
            y: 180 * U,
            width: 200 * U,
            height: 8 * U,
            oneWay: true,
          },
        ],
      },
      f.hero,
      f.gate,
    ),
  ).toThrow(/geometry/);
});

it("exactly restores an airborne burst corridor checkpoint while durable progress recovers safely", () => {
  const f = fixture();
  f.owner.execute({ kind: "checkpoint" });
  for (let i = 0; i < 35; i++) f.frame(127);
  f.frame(127, ["jump"]);
  for (let i = 0; i < 14; i++) f.frame(127);
  f.frame(127, ["heavy"]);
  const mid = f.owner.checkpoint();
  const restored = fixture();
  restored.owner.restore(mid);
  expect(restored.owner.checkpoint()).toBe(mid);
  const recovered = fixture();
  recovered.owner.restoreProgress(f.owner.progress());
  expect(recovered.owner.observation().platform.actors[0].grounded).toBe(true);
  expect(recovered.owner.observation().platform.actors[0].x).toBe(58 * U);
});

it("rejects unassisted launch windows including coyote, held jump and simultaneous drop", () => {
  for (let launch = 20; launch <= 42; launch++) {
    const f = fixture(false);
    for (let tick = 0; tick < launch; tick++) f.frame(127);
    f.frame(127, ["jump", "drop"]);
    for (let tick = 0; tick < 75; tick++) f.frame(127, ["jump", "drop"]);
    expect(f.owner.observation().platform.actors[0].x).toBeLessThan(240 * U);
    expect(f.owner.observation().platform.status).toBe("lost");
  }
});
