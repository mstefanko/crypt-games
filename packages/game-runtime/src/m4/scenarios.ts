/** Development-only trusted fixtures. Never imported by a production player. */
import {
  validateArenaDefinition,
  type ArenaDefinition,
} from "../../../game-simulation/src/m3/arena";
export type M4Profile = "arena" | "grid" | "duel" | "adventure";
export interface NamedScenario {
  version: 1;
  id: string;
  profile: M4Profile;
  name: string;
  seed: number;
  clock: "tick" | "command";
  actors?: number;
  projectiles?: number;
}
export const namedScenarios: readonly NamedScenario[] = [
  ...(["arena", "grid", "duel", "adventure"] as const).map((profile) => ({
    version: 1 as const,
    id: `${profile}-default`,
    profile,
    name: `${profile} production fixture`,
    seed: 41,
    clock:
      profile === "arena" || profile === "duel"
        ? ("tick" as const)
        : ("command" as const),
  })),
  {
    version: 1,
    id: "arena-production-default",
    profile: "arena",
    name: "Arena production seed and definition",
    seed: 123456789,
    clock: "tick",
  },
  {
    version: 1,
    id: "arena-visible-40-20",
    profile: "arena",
    name: "Visible arena 40 actors / 20 projectiles",
    seed: 41,
    clock: "tick",
    actors: 40,
    projectiles: 20,
  },
  {
    version: 1,
    id: "arena-visible-100-100",
    profile: "arena",
    name: "Visible arena 100 actors / 100 projectiles",
    seed: 41,
    clock: "tick",
    actors: 100,
    projectiles: 100,
  },
];
export function findScenario(id: string, profile?: M4Profile): NamedScenario {
  const found = namedScenarios.find(
    (s) => s.id === id && (!profile || s.profile === profile),
  );
  if (!found) throw Error("M4_SCENARIO: unsupported named scenario");
  return { ...found };
}
export function scenarioArenaDefinition(
  base: ArenaDefinition,
  s: NamedScenario,
): ArenaDefinition {
  if (!s.actors) return base;
  const U = 256;
  return validateArenaDefinition({
    ...base,
    id: s.id,
    width: 320 * U,
    height: 180 * U,
    walls: [],
    player: {
      id: "hero",
      x: 24 * U,
      y: 24 * U,
      width: 8 * U,
      height: 8 * U,
      hp: 1000000,
    },
    enemies: Array.from({ length: s.actors - 1 }, (_, i) => ({
      id: `visible-${i}`,
      x: (80 + (i % 15) * 15) * U,
      y: (14 + Math.floor(i / 15) * 22) * U,
      width: 8 * U,
      height: 8 * U,
      hp: 1000000,
    })),
    enemySpeed: 0,
    projectileSpeed: 1,
    projectileTicks: 3600,
    fireCooldown: 1,
    maxProjectiles: 256,
  });
}
