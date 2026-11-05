/** Authored form is independent of weather; only abstract future material is stored. */
export type SongSection =
  | "intro"
  | "verse"
  | "verse-prime"
  | "chorus"
  | "verse-double-prime"
  | "bridge"
  | "solo"
  | "final-chorus"
  | "outro";
export type PhrasePhase = "statement" | "answer" | "development" | "release";
export const SONG_SECTIONS: readonly SongSection[] = [
  "intro",
  "verse",
  "verse-prime",
  "chorus",
  "verse-double-prime",
  "bridge",
  "solo",
  "final-chorus",
  "outro",
];
export type SongTemplate = "A" | "B";
export const SONG_TEMPLATES = {
  A: [4, 4, 4, 8, 4, 4, 8, 8, 4],
  B: [4, 4, 4, 8, 4, 4, 12, 8, 4],
} as const;
export interface HookNote {
  bar: number;
  offset: number;
  duration: number;
  pitch: number;
  degree: number;
}
export interface SongPlan {
  songPlanVersion: 1;
  template: SongTemplate;
  songIndex: number;
  songBar: number;
  hook: {
    id: string;
    notes: HookNote[];
    length: 4;
    age: number;
    lifetime: 2 | 3;
    tonic: number;
    mode: import("./tonality").ModeId;
  };
  verse: number[];
  soloDebt: number;
  missedFeatureDeadlines: number;
  debtDeadlineSong: number | null;
  recurrenceDeadlineBar: number;
  pendingRequest: null | {
    reason: string;
    priority: number;
    sinceBar: number;
    destination: string;
  };
  exit: {
    normal: number[];
    optional: number[];
    maximumExtension: 0;
    destinations: SongSection[];
  };
  feature: null | {
    startBar: number;
    length: 8 | 12;
    phase: PhrasePhase;
    interrupted: boolean;
  };
  history: {
    songIndex: number;
    template: SongTemplate;
    hookId: string;
    featureCompleted: boolean;
  }[];
  featureCompleted: boolean;
  hookProgress: null | {
    startBar: number;
    bars: number;
    interrupted: boolean;
    tonic: number;
    pitchDelta: number | null;
    trackId: string;
  };
  arranger: {
    weightTier: 0 | 1 | 2 | 3;
    activity: number;
    brightness: number;
    density: number;
    tension: number;
  };
}
export function songPosition(plan: SongPlan) {
  let bar = plan.songBar;
  const lengths = SONG_TEMPLATES[plan.template];
  for (let index = 0; index < lengths.length; index++) {
    const length = lengths[index]!;
    if (bar < length)
      return {
        section: SONG_SECTIONS[index]!,
        index,
        sectionBar: bar,
        sectionLength: length,
      };
    bar -= length;
  }
  throw new RangeError("Song position outside template");
}
export function phrasePhase(offset: number, length: number): PhrasePhase {
  const boundaries =
    length === 12 ? [3, 6, 10] : length === 8 ? [2, 4, 6] : [1, 2, 3];
  return offset < boundaries[0]!
    ? "statement"
    : offset < boundaries[1]!
      ? "answer"
      : offset < boundaries[2]!
        ? "development"
        : "release";
}
