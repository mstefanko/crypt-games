/** Club identities select one team special; gameplay sides remain numeric zero and one. */
export const TEAM_IDS = ["rams", "foxes", "owls", "gators", "bats", "hornets"] as const;
export type TeamId = (typeof TEAM_IDS)[number];
export type TeamSelection = readonly [TeamId, TeamId];
export const DEFAULT_TEAM_IDS: TeamSelection = Object.freeze(["rams", "foxes"]);
export const TEAMS = Object.freeze({
  rams: Object.freeze({ name: "Rams", color: "#72d9d6", assetPrefix: "ivory", icon: "assets/teams/rams.svg" }),
  foxes: Object.freeze({ name: "Foxes", color: "#f08b59", assetPrefix: "ember", icon: "assets/teams/foxes.svg" }),
  owls: Object.freeze({ name: "Owls", color: "#6f9fff", assetPrefix: "owls", icon: "assets/teams/owls.svg" }),
  gators: Object.freeze({ name: "Gators", color: "#9dc95b", assetPrefix: "gators", icon: "assets/teams/gators.svg" }),
  bats: Object.freeze({ name: "Bats", color: "#be8ce8", assetPrefix: "bats", icon: "assets/teams/bats.svg" }),
  hornets: Object.freeze({ name: "Hornets", color: "#f4ce55", assetPrefix: "hornets", icon: "assets/teams/hornets.svg" }),
});
export function isTeamId(value: unknown): value is TeamId {
  return typeof value === "string" && TEAM_IDS.includes(value as TeamId);
}
export function validateTeamSelection(value: unknown): asserts value is TeamSelection {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(isTeamId) || value[0] === value[1])
    throw Error("Choose two different teams.");
}
export function resolveTeamSelection(preferred: TeamId = DEFAULT_TEAM_IDS[0], opponent?: TeamId): TeamSelection {
  if (!isTeamId(preferred) || (opponent !== undefined && !isTeamId(opponent))) throw Error("Unknown team.");
  return [preferred, opponent && opponent !== preferred ? opponent : TEAM_IDS.find((id) => id !== preferred)!];
}
