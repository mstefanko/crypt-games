/** Three authored rooms exercising M8b composition, deliberately below polished M9. */
import type {
  GameDefinitions,
  CompatibilityIdentity,
  Rect,
} from "@onepage/game-project/runtime";
import {
  CampaignPlatformOwner,
  type CampaignPlatformDefinition,
} from "./campaign-platform";
const U = 256;
const area = (x: number, width = 24): Rect => ({
  x: x * U,
  y: 112 * U,
  width: width * U,
  height: 32 * U,
});
const body = { x: -6 * U, y: -24 * U, width: 12 * U, height: 24 * U };
const rooms = ["hall", "shrine", "vault"];
export const CAMPAIGN_PLATFORM_FIXTURE_IDENTITY: CompatibilityIdentity = {
  rulesBuildId: "campaign-platform-proof-v1",
  contentId: "three-rooms-v1",
};
export const CAMPAIGN_PLATFORM_FIXTURE_DEFINITIONS: GameDefinitions = {
  manifest: {
    schemaVersion: 1,
    gameId: "sealed-vault",
    title: "The Sealed Vault",
    rulesModule: "platform-combat-v1",
    initialLevelId: "hall",
    initialScenarioId: "hall-start",
    levelIds: rooms,
    archetypeIds: ["hero", "guardian"],
    abilityIds: ["strike"],
    scenarioIds: rooms.map((id) => `${id}-start`),
    viewport: { width: 320, height: 180 },
  },
  levels: rooms.map((id) => ({
    id,
    width: 320,
    height: 192,
    tileSize: 16,
    // The final two columns form a real fall hazard. Ordinary motion/combat is
    // wholly the existing platform implementation.
    tiles: Array.from({ length: 20 * 12 }, (_, i) =>
      Math.floor(i / 20) >= 9 && i % 20 < 18 ? 1 : 0,
    ),
    rectangles: [],
    platforms: [],
    spawns: [
      {
        id: "player",
        archetypeId: "hero",
        x: 32 * U,
        y: 144 * U,
        slot: 0,
        team: 0,
        facing: 1 as const,
      },
      ...(id === "hall"
        ? []
        : [
            {
              id: "guardian",
              archetypeId: "guardian",
              x: 176 * U,
              y: 144 * U,
              slot: null,
              team: 1,
              facing: -1 as const,
            },
          ]),
    ],
    goal: {
      x: 304 * U,
      y: 8 * U,
      width: 8 * U,
      height: 8 * U,
      nextLevelId: null,
    },
    deathY: 192 * U,
  })),
  archetypes: [
    {
      id: "hero",
      body,
      hurt: body,
      push: body,
      health: 12,
      speed: 2 * U,
      jumpSpeed: 7 * U,
      gravity: 96,
      maxFallSpeed: 8 * U,
      coyoteTicks: 6,
      jumpBufferTicks: 6,
      attackBufferTicks: 6,
      abilities: ["strike"],
      ai: "none",
      aiRange: 0,
    },
    {
      id: "guardian",
      body,
      hurt: body,
      push: body,
      health: 1,
      speed: 0,
      jumpSpeed: 7 * U,
      gravity: 96,
      maxFallSpeed: 8 * U,
      coyoteTicks: 6,
      jumpBufferTicks: 6,
      attackBufferTicks: 6,
      abilities: ["strike"],
      ai: "none",
      aiRange: 0,
    },
  ],
  abilities: [
    {
      id: "strike",
      startup: 2,
      active: 4,
      recovery: 8,
      hit: { x: 6 * U, y: -24 * U, width: 28 * U, height: 24 * U },
      damage: 1,
      knockbackX: 0,
      knockbackY: 0,
      stunTicks: 0,
      hitStopTicks: 0,
      guardDamage: 0,
      maxHits: 1,
      rehitTicks: 1,
    },
  ],
  scenarios: rooms.map((id, i) => ({
    id: `${id}-start`,
    levelId: id,
    seed: 1729 + i,
    playerSlots: [0],
    ticks: 600,
    actions: [],
    assertions: [],
  })),
};
export const CAMPAIGN_PLATFORM_FIXTURE: CampaignPlatformDefinition = {
  id: "sealed-vault-v1",
  initialRoom: "hall",
  transactions: {
    id: "sealed-vault-ledger",
    resources: [{ id: "coins", initial: 0, capacity: 100 }],
    stats: [],
    flags: ["phase"],
    outcomes: ["phase-shrine", "vault-opened", "vault-chest"],
    rewardSeed: 1234,
  },
  rooms: [
    {
      id: "hall",
      scenarioId: "hall-start",
      assets: ["hall-palette"],
      checkpoint: null,
      permanentEnemies: [],
      pickups: [],
      exits: [
        {
          id: "to-shrine",
          area: area(88),
          to: "shrine",
          requires: null,
          outcome: null,
        },
        {
          id: "sealed-door",
          area: area(24),
          to: "vault",
          requires: "phase",
          outcome: {
            id: "vault-opened",
            operations: [{ kind: "grant", resource: "coins", amount: 1 }],
          },
        },
      ],
    },
    {
      id: "shrine",
      scenarioId: "shrine-start",
      assets: ["shrine-palette"],
      checkpoint: null,
      permanentEnemies: ["guardian"],
      exits: [
        {
          id: "to-hall",
          area: area(24),
          to: "hall",
          requires: null,
          outcome: null,
        },
      ],
      pickups: [
        {
          id: "phase",
          area: area(88),
          outcome: {
            id: "phase-shrine",
            operations: [{ kind: "flag", flag: "phase", value: true }],
          },
        },
      ],
    },
    {
      id: "vault",
      scenarioId: "vault-start",
      assets: ["vault-palette"],
      checkpoint: area(24),
      permanentEnemies: [],
      exits: [
        {
          id: "to-hall",
          area: area(24),
          to: "hall",
          requires: null,
          outcome: null,
        },
      ],
      pickups: [
        {
          id: "chest",
          area: area(88),
          outcome: {
            id: "vault-chest",
            operations: [{ kind: "reward", resource: "coins", min: 2, max: 7 }],
          },
        },
      ],
    },
  ],
};
export function createCampaignPlatformFixture(): CampaignPlatformOwner {
  return new CampaignPlatformOwner(
    CAMPAIGN_PLATFORM_FIXTURE_DEFINITIONS,
    CAMPAIGN_PLATFORM_FIXTURE_IDENTITY,
    CAMPAIGN_PLATFORM_FIXTURE,
  );
}
