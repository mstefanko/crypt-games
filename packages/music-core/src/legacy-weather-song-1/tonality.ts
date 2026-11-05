/** Parallel modal collections; all pitch classes are transposable. */
export const MODE_INTERVALS = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
} as const;
export type ModeId = keyof typeof MODE_INTERVALS;
export interface TonalContext {
  tonic: number;
  mode: ModeId;
  grammarVersion: 1;
  permittedAlterations: number[];
  harmonicFunction: "tonic" | "predominant" | "dominant" | "color";
  pendingResolution: null | {
    pitchClass: number;
    targetPitchClass: number;
    deadlineTick: number;
  };
}
export const pitchClass = (n: number): number => ((n % 12) + 12) % 12;
export function createTonalContext(
  mode: ModeId = "ionian",
  tonic = 0,
): TonalContext {
  if (
    !MODE_INTERVALS[mode] ||
    !Number.isInteger(tonic) ||
    tonic < 0 ||
    tonic > 11
  )
    throw new RangeError("Invalid tonal context");
  return {
    tonic,
    mode,
    grammarVersion: 1,
    permittedAlterations: [],
    harmonicFunction: "tonic",
    pendingResolution: null,
  };
}
export function scalePitchClasses(context: TonalContext): number[] {
  return MODE_INTERVALS[context.mode].map((n) => pitchClass(n + context.tonic));
}
export function degreePitch(
  context: TonalContext,
  degree: number,
  octave = 5,
): number {
  if (!Number.isInteger(degree)) throw new RangeError("Invalid scale degree");
  return (
    octave * 12 +
    context.tonic +
    MODE_INTERVALS[context.mode][((degree % 7) + 7) % 7]! +
    Math.floor(degree / 7) * 12
  );
}
export const MODE_CHARACTERISTIC_DEGREE: Record<ModeId, number> = {
  ionian: 2,
  lydian: 3,
  mixolydian: 6,
  dorian: 5,
  aeolian: 5,
  phrygian: 1,
};
