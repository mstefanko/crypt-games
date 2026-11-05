import {
  degreePitch,
  pitchClass,
  type ModeId,
  type TonalContext,
} from "./tonality";
export interface HarmonicGrammar {
  mode: ModeId;
  chordDegrees: readonly number[];
  tensions: readonly number[];
  characteristicDegree: number;
  closure: readonly number[];
}
export const HARMONIC_GRAMMARS: Record<ModeId, HarmonicGrammar> =
  Object.fromEntries(
    (
      [
        "ionian",
        "lydian",
        "mixolydian",
        "dorian",
        "aeolian",
        "phrygian",
      ] as ModeId[]
    ).map((mode) => [
      mode,
      {
        mode,
        chordDegrees:
          mode === "aeolian" || mode === "phrygian"
            ? [0, 3, 4, 5]
            : mode === "lydian"
              ? [0, 1, 4, 5]
              : mode === "mixolydian"
                ? [0, 3, 6, 5]
                : [0, 3, 4, 5],
        tensions: [0, 0.35, 0.85, 0.65],
        characteristicDegree:
          mode === "lydian"
            ? 3
            : mode === "dorian"
              ? 5
              : mode === "mixolydian"
                ? 6
                : 2,
        closure: [2, 0],
      },
    ]),
  ) as unknown as Record<ModeId, HarmonicGrammar>;
export function harmonicChords(context: TonalContext): number[][] {
  return HARMONIC_GRAMMARS[context.mode].chordDegrees.map((d, i) => {
    const result = [d, d + 2, d + 4].map((n) =>
      pitchClass(degreePitch(context, n)),
    );
    // Minor dominant explicitly raises the seventh, resolved by the next tonic bar.
    if (i === 2 && (context.mode === "aeolian" || context.mode === "phrygian"))
      result[1] = pitchClass(context.tonic + 11);
    return result;
  });
}
