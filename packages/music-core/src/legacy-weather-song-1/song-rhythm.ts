/** Authored tick-grid vocabulary. Related variants retain the same accent skeleton. */
export interface SongDrumPattern {
  readonly id: string;
  readonly family: "none" | "structural" | "moving" | "heavy";
  readonly tiers: readonly number[];
  readonly density: number;
  readonly accents: readonly number[];
  readonly similarityGroup: string;
  readonly entry: boolean;
  readonly exit: boolean;
  readonly fill: boolean;
  readonly kick: readonly number[];
  readonly snare: readonly number[];
  readonly hat: readonly number[];
}
export const SONG_DRUM_PATTERNS: readonly SongDrumPattern[] = [
  {
    id: "no-drums",
    family: "none",
    tiers: [0, 1, 2, 3],
    density: 0,
    accents: [],
    similarityGroup: "silence",
    entry: true,
    exit: true,
    fill: false,
    kick: [],
    snare: [],
    hat: [],
  },
  {
    id: "structural-entry",
    family: "structural",
    tiers: [1],
    density: 0.1,
    accents: [0],
    similarityGroup: "downbeat",
    entry: true,
    exit: false,
    fill: false,
    kick: [0],
    snare: [],
    hat: [],
  },
  {
    id: "moving-a",
    family: "moving",
    tiers: [2],
    density: 0.55,
    accents: [0, 960],
    similarityGroup: "backbeat",
    entry: true,
    exit: false,
    fill: false,
    kick: [0, 1200],
    snare: [480, 1440],
    hat: [240, 720, 1200, 1680],
  },
  {
    id: "moving-b",
    family: "moving",
    tiers: [2],
    density: 0.45,
    accents: [0, 960],
    similarityGroup: "backbeat",
    entry: false,
    exit: false,
    fill: false,
    kick: [0, 960],
    snare: [480, 1440],
    hat: [240, 1200, 1680],
  },
  {
    id: "moving-exit",
    family: "moving",
    tiers: [2],
    density: 0.3,
    accents: [0, 960],
    similarityGroup: "backbeat",
    entry: false,
    exit: true,
    fill: true,
    kick: [0],
    snare: [480, 1200, 1440],
    hat: [240, 720],
  },
  {
    id: "heavy-arrival",
    family: "heavy",
    tiers: [3],
    density: 0.5,
    accents: [0, 960],
    similarityGroup: "heavy-downbeat",
    entry: true,
    exit: false,
    fill: false,
    kick: [0, 960],
    snare: [1440],
    hat: [480, 1440],
  },
  {
    id: "stop-time",
    family: "heavy",
    tiers: [2, 3],
    density: 0.1,
    accents: [0],
    similarityGroup: "heavy-downbeat",
    entry: false,
    exit: true,
    fill: false,
    kick: [0],
    snare: [],
    hat: [],
  },
];
export function songDrumPattern(
  tier: number,
  sectionBar: number,
  lastBar: boolean,
): SongDrumPattern {
  const id =
    tier === 0
      ? "no-drums"
      : tier === 1
        ? sectionBar === 0
          ? "structural-entry"
          : "no-drums"
        : tier === 3
          ? lastBar
            ? "stop-time"
            : "heavy-arrival"
          : lastBar
            ? "moving-exit"
            : sectionBar % 2
              ? "moving-b"
              : "moving-a";
  return SONG_DRUM_PATTERNS.find((pattern) => pattern.id === id)!;
}
