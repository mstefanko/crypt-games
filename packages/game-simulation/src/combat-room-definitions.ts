import type {
  GameDefinitions,
  AbilityDefinition,
} from "@onepage/game-project/runtime";
export interface CombatRoomTemplate {
  gameId: string;
  title: string;
  units?: number;
  floor?: number;
  roomWidth?: number;
  peacefulRooms?: readonly number[];
  bossRoom?: number;
  reinforcedRoom?: number;
  sideRoomStart?: number;
  heroHealth?: number;
  bossHealth?: number;
}
export function createCombatRoomDefinitions(
  seed: number,
  room: number,
  template: CombatRoomTemplate,
): GameDefinitions {
  const U = template.units ?? 256,
    FLOOR = template.floor ?? 224,
    ROOM_WIDTH = template.roomWidth ?? 960;
  const body = { x: -8 * U, y: -30 * U, width: 16 * U, height: 30 * U };
  const attack = (
    id: string,
    damage: number,
    startup: number,
    active: number,
    recovery: number,
    range: number,
    height = 38,
  ): AbilityDefinition => ({
    id,
    damage,
    startup,
    active,
    recovery,
    hit: { x: 2 * U, y: -height * U, width: range * U, height: height * U },
    knockbackX: 2 * U,
    knockbackY: -U,
    stunTicks: 12,
    hitStopTicks: 3,
    guardDamage: 0,
    maxHits: 1,
    rehitTicks: 30,
  });
  const abilities = [
    attack("sword", 12, 5, 5, 12, 48),
    attack("sword0", 16, 6, 6, 15, 56),
    attack("sword1", 10, 3, 5, 10, 44),
    attack("sword2", 12, 4, 5, 12, 48),
    attack("hammer", 25, 15, 8, 25, 62),
    attack("caster", 10, 8, 2, 24, 4),
    attack("burst", 22, 8, 12, 18, 120, 52),
    attack("trap", 9, 12, 90, 14, 84, 20),
    attack("claw", 8, 8, 6, 16, 43),
    attack("shot", 7, 10, 2, 25, 4),
    attack("bell", 15, 12, 10, 28, 86, 60),
  ];
  for (const a of abilities) {
    Object.assign(a, {
      tags: [
        a.id === "trap"
          ? "stationary"
          : a.id === "shot" || a.id === "caster"
            ? "projectile"
            : "melee",
      ],
      ...(a.id === "caster" ? { cooldownTicks: 34 } : {}),
    });
  }
  const archetype = (
    id: string,
    health: number,
    speed: number,
    ability: string,
    gravity = 90,
  ) => ({
    id,
    body,
    hurt: body,
    push: body,
    health,
    speed,
    jumpSpeed: 8 * U,
    gravity,
    maxFallSpeed: 8 * U,
    coyoteTicks: 7,
    jumpBufferTicks: 8,
    attackBufferTicks: 12,
    abilities: [ability],
    ai: "none" as const,
    aiRange: 0,
  });
  const templates = (seed + room * 7) % 10;
  const platforms = [
    {
      id: "ledge-a",
      x: (210 + templates * 8) * U,
      y: 170 * U,
      width: 130 * U,
      height: 8 * U,
      oneWay: true,
    },
    {
      id: "ledge-b",
      x: 510 * U,
      y: (150 + (templates % 3) * 12) * U,
      width: 140 * U,
      height: 8 * U,
      oneWay: true,
    },
    {
      id: "ledge-c",
      x: 740 * U,
      y: 180 * U,
      width: 100 * U,
      height: 8 * U,
      oneWay: true,
    },
  ];
  const count = (template.peacefulRooms ?? [0, 3]).includes(room)
    ? 0
    : room === (template.bossRoom ?? 5)
      ? 1
      : room >= (template.sideRoomStart ?? 6)
        ? 3
        : room === (template.reinforcedRoom ?? 4)
          ? 5
          : 3;
  const spawns = [
    {
      id: "player",
      archetypeId: "hero",
      x: 40 * U,
      y: FLOOR * U,
      slot: 0 as number | null,
      team: 0,
      facing: 1 as -1 | 1,
    },
    ...Array.from({ length: count }, (_, i) => ({
      id: `enemy-${i}`,
      archetypeId:
        room === (template.bossRoom ?? 5)
          ? "boss"
          : ["lunger", "shooter", "hover"][(seed + room + i) % 3]!,
      x: (300 + i * (room === (template.reinforcedRoom ?? 4) ? 112 : 180)) * U,
      y: (i % 3 === 2 ? 170 : FLOOR) * U,
      slot: null,
      team: 1,
      facing: -1 as -1 | 1,
    })),
  ];
  return {
    manifest: {
      schemaVersion: 1,
      gameId: template.gameId,
      title: template.title,
      rulesModule: "platform-combat-v1",
      initialLevelId: "room",
      initialScenarioId: "start",
      levelIds: ["room"],
      archetypeIds: [
        "hero",
        "spark-trap",
        "lunger",
        "shooter",
        "hover",
        "boss",
      ],
      abilityIds: abilities.map((a) => a.id),
      scenarioIds: ["start"],
      viewport: { width: 480, height: 270 },
    },
    levels: [
      {
        id: "room",
        width: ROOM_WIDTH,
        height: 272,
        tileSize: 16,
        tiles: Array.from({ length: 60 * 17 }, (_, i) =>
          Math.floor(i / 60) >= 14 ? 1 : 0,
        ),
        rectangles: platforms,
        platforms: [],
        spawns,
        goal: { x: 950 * U, y: 0, width: 1, height: 1, nextLevelId: null },
        deathY: 290 * U,
      },
    ],
    archetypes: [
      archetype("hero", template.heroHealth ?? 100, 3 * U, "sword"),
      {
        ...archetype("spark-trap", 1, 0, "trap"),
        body: { x: 0, y: -2 * U, width: U, height: 2 * U },
        hurt: { x: 0, y: 1000 * U, width: U, height: U },
        push: { x: 0, y: 1000 * U, width: U, height: U },
      },
      archetype("lunger", 30, Math.round(1.5 * U), "claw"),
      archetype("shooter", 25, 0, "shot"),
      archetype("hover", 22, U, "claw", 0),
      archetype(
        "boss",
        template.bossHealth ?? 180,
        Math.round(1.7 * U),
        "bell",
      ),
    ],
    abilities,
    scenarios: [
      {
        id: "start",
        levelId: "room",
        seed: ((Math.trunc(seed) % 4294967296) + 4294967296) % 4294967296,
        playerSlots: [0],
        ticks: 60000,
        actions: [],
        assertions: [],
      },
    ],
  };
}
