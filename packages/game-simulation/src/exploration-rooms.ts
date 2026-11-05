/** Detached room presentation; deliberately outside authoritative compatibility. */
export const EXPLORATION_ROOMS = [
  {
    id: "harbor",
    title: "Harbor refuge",
    color: "#83c9ca",
    description:
      "Find the shrine's phase burst. The sealed crossing waits at the western arch.",
  },
  {
    id: "gallery",
    title: "Sentinel gallery",
    color: "#d9b786",
    description:
      "The bruiser approaches, winds up, then commits. Strike or jump during the tell.",
  },
  {
    id: "shrine",
    title: "Phase shrine",
    color: "#b0a0e7",
    description:
      "Claim phase burst (K). Return directly to the harbor through the shrine shortcut.",
  },
  {
    id: "crossing",
    title: "Broken crossing",
    color: "#93c997",
    description:
      "Phase burst carries you forward. Checkpoint here; the eastern path reaches the beacon.",
  },
  {
    id: "beacon",
    title: "Beacon keeper",
    color: "#edaa83",
    description:
      "Defeat the keeper and reclaim the beacon. The return arch leads back to your checkpoint.",
  },
] as const;
