import type { SportId } from "./contract";

/** Renderer-owned exhaustive mode policy; adding a mode cannot inherit volley art. */
export const SPORT_ART_PROFILES = {
  cryptball: { athletes: "legacy", floor: null, ball: "orb" },
  cryptkick: { athletes: "sports", floor: null, ball: "kick" },
  "rift-volley": { athletes: "sports", floor: "sports.floor.volley", ball: "volley" },
  "crypt-dodge": { athletes: "dodge", floor: null, ball: "dodge" },
  "crypt-guardian": { athletes: "dodge", floor: null, ball: "orb" },
  cryptcheck: { athletes: "hockey", floor: "hockey.floor", ball: "puck" },
} as const satisfies Record<SportId, { athletes: "legacy" | "sports" | "hockey" | "dodge"; floor: string | null; ball: string }>;

export function athleteClipId(sport: SportId, team: string, archetype: string, clip: string, heading: string) {
  // Temporary victim poses share the authored body scale, palettes and pivot.
  // The hockey stick is stowed while down; the puck remains in world space.
  if (sport === "cryptcheck") {
    const recovery = clip === "knockdown-fall" ? "slide-launch" : clip === "knockdown" ? "slide" : clip === "get-up" ? "slide-recover" : null;
    if (recovery) return `sports.${team}.${recovery}.${heading}`;
  }
  if (sport === "crypt-dodge" || sport === "crypt-guardian") return ["idle", "run", "dive", "dive-recover"].includes(clip) ? `sports.${team}.${clip}.${heading}` : `new.${team}.${clip}.${heading}`;
  const profile = SPORT_ART_PROFILES[sport];
  return profile.athletes === "legacy" ? `${team}.${archetype}.${clip}.${heading}`
    : `${profile.athletes}.${team}.${clip}.${heading}`;
}
