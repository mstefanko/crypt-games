/** Generic boundary-stable arrangement policy; authored themes remain caller content. */
export interface GameplayMusicIntent {
  identity: string;
  intensity: number;
  progress: number;
  roles?: number;
  roleIds?: readonly string[];
  event?: string;
  clue?: number;
  pan?: number;
  occlusion?: number;
  suppressLead?: boolean;
  baseDrone?: boolean;
  sparseLead?: number;
}
export interface GameplayTheme {
  bpm: number;
  beatsPerBar?: number;
  root: number;
  scale: readonly number[];
  motif: readonly number[];
  rhythm?: readonly number[];
}
export interface GameplayForegroundPattern {
  notes: readonly number[];
  times: readonly number[];
  lengths: readonly number[];
  part: string;
}
export interface GameplayMusicProfile {
  id: string;
  theme: GameplayTheme;
  selectTheme?: (
    intent: GameplayMusicIntent,
    adaptive: boolean,
  ) => GameplayTheme;
  chordCycle?: readonly number[];
  phraseBars?: number;
  compositionSeed?: number;
  patches?: Partial<
    Record<
      "melody" | "bass" | "harmony" | "drums",
      {
        waveform: "sine" | "triangle" | "pulse" | "sawtooth" | "noise";
        brightness?: number;
        attack?: number;
        release?: number;
      }
    >
  >;
  foregroundPatterns?: readonly GameplayForegroundPattern[];
}
export class GameplayMusicDirector {
  private tier = 1;
  private changed = -10;
  decide(
    profile: GameplayMusicProfile,
    intent: GameplayMusicIntent,
    bar: number,
    adaptive = true,
  ) {
    const strength = adaptive
      ? Math.max(0, Math.min(1, intent.intensity))
      : 0.5;
    const candidate = strength > 0.72 ? 3 : strength > 0.38 ? 2 : 1;
    if (
      bar - this.changed >= 2 &&
      (candidate > this.tier
        ? strength > [0, 0, 0.46, 0.8][candidate]!
        : candidate < this.tier
          ? strength < [0, 0.3, 0.64][candidate]!
          : false)
    ) {
      this.tier = candidate;
      this.changed = bar;
    }
    return {
      theme: adaptive
        ? (profile.selectTheme?.(intent, true) ?? profile.theme)
        : profile.theme,
      tier: adaptive ? this.tier : 2,
      roles: adaptive ? Math.max(1, intent.roles ?? this.tier + 1) : 3,
      cue: `${intent.identity} · ${adaptive ? "adaptive" : "fixed"} arrangement ${adaptive ? this.tier : 2}`,
    };
  }
}
