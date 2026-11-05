import {
  applyCampaignBehaviorDocument,
  DEFAULT_CAMPAIGN_BEHAVIOR_DOCUMENT,
} from "./behavior-authoring";
/** Authored M9 development game assembled from production platform campaign APIs. */
import type {
  GameDefinitions,
  CompatibilityIdentity,
  Rect,
  InputFrame,
} from "@onepage/game-project/runtime";
import {
  CampaignPlatformOwner,
  type CampaignPlatformDefinition,
} from "./campaign-platform";
import { neutralHeld } from "./input";
const U = 256;
const roomIds = ["harbor", "gallery", "shrine", "crossing", "beacon"];
const area = (x: number, width = 24): Rect => ({
  x: x * U,
  y: 112 * U,
  width: width * U,
  height: 32 * U,
});
const body = { x: -6 * U, y: -24 * U, width: 12 * U, height: 24 * U };
/** Fixed deterministic fixture identity. Production injects a prepared source/content identity. */
export const EXPLORATION_FIXTURE_IDENTITY: CompatibilityIdentity = {
  rulesBuildId: "m9-b0-platform-v1",
  contentId: "beacon-five-rooms-v1",
};
/** Historical fixture alias; never use this as the production compatibility policy. */
export const EXPLORATION_IDENTITY = EXPLORATION_FIXTURE_IDENTITY;

const archetype = (
  id: string,
  health: number,
  speed: number,
  abilities: string[],
) => ({
  id,
  body,
  hurt: body,
  push: body,
  health,
  speed: speed * U,
  jumpSpeed: 7 * U,
  gravity: 96,
  maxFallSpeed: 8 * U,
  coyoteTicks: 6,
  jumpBufferTicks: 6,
  attackBufferTicks: 6,
  abilities,
  ai: "none" as const,
  aiRange: 0,
});
export const EXPLORATION_DEFINITIONS: GameDefinitions = {
  manifest: {
    schemaVersion: 1,
    gameId: "beacon-return",
    title: "Beacon Return",
    rulesModule: "platform-combat-v1",
    initialLevelId: "harbor",
    initialScenarioId: "harbor-start",
    levelIds: roomIds,
    archetypeIds: ["hero", "bruiser", "ranger", "keeper"],
    abilityIds: ["strike", "smash", "reach"],
    scenarioIds: roomIds.map((id) => `${id}-start`),
    viewport: { width: 320, height: 180 },
  },
  levels: roomIds.map((id) => ({
    id,
    width: 320,
    height: 192,
    tileSize: 16,
    tiles: Array.from({ length: 20 * 12 }, (_, index) =>
      Math.floor(index / 20) >= 9 &&
      index % 20 < 18 &&
      !(id === "crossing" && index % 20 >= 8 && index % 20 <= 9)
        ? 1
        : 0,
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
      ...(id === "gallery" || id === "crossing" || id === "beacon"
        ? [
            {
              id: id === "beacon" ? "keeper" : "sentinel",
              archetypeId:
                id === "gallery"
                  ? "bruiser"
                  : id === "crossing"
                    ? "ranger"
                    : "keeper",
              x: (id === "crossing" ? 224 : 160) * U,
              y: 144 * U,
              slot: null,
              team: 1,
              facing: -1 as const,
            },
          ]
        : []),
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
    archetype("hero", 18, 2, ["strike"]),
    archetype("bruiser", 2, 1, ["smash"]),
    archetype("ranger", 2, 1, ["reach"]),
    archetype("keeper", 5, 1, ["smash"]),
  ],
  abilities: [
    {
      id: "strike",
      startup: 2,
      active: 4,
      recovery: 8,
      hit: { x: 6 * U, y: -24 * U, width: 32 * U, height: 24 * U },
      damage: 1,
      knockbackX: 0,
      knockbackY: 0,
      stunTicks: 8,
      hitStopTicks: 0,
      guardDamage: 0,
      maxHits: 1,
      rehitTicks: 1,
    },
    {
      id: "smash",
      startup: 8,
      active: 3,
      recovery: 18,
      hit: { x: 6 * U, y: -24 * U, width: 28 * U, height: 24 * U },
      damage: 3,
      knockbackX: 0,
      knockbackY: 0,
      stunTicks: 8,
      hitStopTicks: 0,
      guardDamage: 0,
      maxHits: 1,
      rehitTicks: 1,
    },
    {
      id: "reach",
      startup: 10,
      active: 2,
      recovery: 14,
      hit: { x: 6 * U, y: -20 * U, width: 64 * U, height: 12 * U },
      damage: 1,
      knockbackX: 0,
      knockbackY: 0,
      stunTicks: 4,
      hitStopTicks: 0,
      guardDamage: 0,
      maxHits: 1,
      rehitTicks: 1,
    },
  ],
  scenarios: roomIds.map((id, i) => ({
    id: `${id}-start`,
    levelId: id,
    seed: 4100 + i,
    playerSlots: [0],
    ticks: 3600,
    actions: [],
    assertions: [],
  })),
};
const exit = (
  id: string,
  x: number,
  to: string,
  requires: string | null = null,
) => ({ id, area: area(x), to, requires, outcome: null });
const BASE_EXPLORATION_CAMPAIGN: CampaignPlatformDefinition = {
  id: "beacon-return-v1",
  initialRoom: "harbor",
  traversal: { flag: "phase", distance: 32 * U },
  transactions: {
    id: "beacon-ledger",
    resources: [{ id: "relics", initial: 0, capacity: 1 }],
    stats: [],
    flags: ["phase", "complete"],
    outcomes: ["phase-found", "beacon-restored"],
    rewardSeed: 811,
  },
  rooms: [
    {
      id: "harbor",
      scenarioId: "harbor-start",
      assets: ["harbor-palette"],
      checkpoint: area(24),
      permanentEnemies: [],
      behaviors: [],
      pickups: [],
      exits: [
        exit("to-gallery", 88, "gallery"),
        exit("phase-gate", 24, "crossing", "phase"),
      ],
    },
    {
      id: "gallery",
      scenarioId: "gallery-start",
      assets: ["gallery-palette"],
      checkpoint: null,
      permanentEnemies: ["sentinel"],
      behaviors: [{ spawnId: "sentinel", role: "bruiser" }],
      pickups: [],
      exits: [
        exit("to-harbor", 24, "harbor"),
        exit("to-shrine", 248, "shrine"),
      ],
    },
    {
      id: "shrine",
      scenarioId: "shrine-start",
      assets: ["shrine-palette"],
      checkpoint: area(24),
      permanentEnemies: [],
      behaviors: [],
      pickups: [
        {
          id: "phase",
          area: area(88),
          outcome: {
            id: "phase-found",
            operations: [{ kind: "flag", flag: "phase", value: true }],
          },
        },
      ],
      exits: [
        exit("to-gallery", 24, "gallery"),
        exit("shrine-shortcut", 88, "harbor", "phase"),
      ],
    },
    {
      id: "crossing",
      scenarioId: "crossing-start",
      assets: ["crossing-palette"],
      checkpoint: area(24),
      permanentEnemies: ["sentinel"],
      behaviors: [{ spawnId: "sentinel", role: "ranger" }],
      pickups: [],
      exits: [
        exit("to-harbor", 24, "harbor"),
        exit("to-beacon", 248, "beacon", "phase"),
      ],
    },
    {
      id: "beacon",
      scenarioId: "beacon-start",
      assets: ["beacon-palette"],
      checkpoint: null,
      permanentEnemies: ["keeper"],
      behaviors: [{ spawnId: "keeper", role: "bruiser" }],
      pickups: [
        {
          id: "beacon",
          area: area(152, 80),
          requiresDefeated: ["keeper"],
          outcome: {
            id: "beacon-restored",
            operations: [
              { kind: "flag", flag: "complete", value: true },
              { kind: "grant", resource: "relics", amount: 1 },
            ],
          },
        },
      ],
      exits: [exit("beacon-return", 24, "crossing")],
    },
  ],
};
export function createExplorationCampaign(
  behaviorContent: unknown = DEFAULT_CAMPAIGN_BEHAVIOR_DOCUMENT,
): CampaignPlatformDefinition {
  return applyCampaignBehaviorDocument(
    BASE_EXPLORATION_CAMPAIGN,
    behaviorContent,
  );
}
export const EXPLORATION_CAMPAIGN = createExplorationCampaign();
export function createExplorationGame(
  behaviorContent: unknown = DEFAULT_CAMPAIGN_BEHAVIOR_DOCUMENT,
  identity: CompatibilityIdentity = EXPLORATION_FIXTURE_IDENTITY,
): CampaignPlatformOwner {
  return new CampaignPlatformOwner(
    EXPLORATION_DEFINITIONS,
    identity,
    createExplorationCampaign(behaviorContent),
  );
}
export function explorationInput(
  axis: -127 | 0 | 127 = 0,
  pressed: "attack" | "jump" | "heavy" | null = null,
  released: "attack" | "jump" | "heavy" | null = null,
): InputFrame {
  return {
    slots: [
      {
        slot: 0,
        held: { ...neutralHeld(), ...(pressed ? { [pressed]: true } : {}) },
        axes: { moveX: axis },
        edges: [
          ...(pressed ? [{ action: pressed, kind: "pressed" as const }] : []),
          ...(released
            ? [{ action: released, kind: "released" as const }]
            : []),
        ],
      },
    ],
  };
}
