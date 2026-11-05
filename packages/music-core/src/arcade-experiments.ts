import { PPQ, type Note, type Score } from "@onepage/project";
import {
  createArcadePhrase,
  type ArcadeAction,
  type ArcadePhrase,
} from "./arcade";

export type ArcadeExperiment =
  | "phrase-rider"
  | "groove-fighter"
  | "ribbon-lead";
export type ArcadeIntent = ArcadeAction | "reply" | "rest";
export type ArcadeBacking =
  | "without-role"
  | "full"
  | "foundation"
  | "metronome";
export interface ArcadeExperimentOptions {
  score: Score;
  trackId: string;
  mode: ArcadeExperiment;
  intent: ArcadeIntent;
  startTick: number;
  loopStartTick: number;
  loopEndTick: number;
  intensity: 1 | 2 | 3;
  sequence?: number;
  previousPitch?: number;
  direction?: number;
  /** Ribbon height, from low (0) to high (1). */
  ribbon?: number;
  /** Optional audio-clock slice for responsive live ribbon scheduling. */
  ribbonStepTicks?: number;
}
const scaleIntervals = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));
const nearest = (pitches: number[], target: number) =>
  pitches.reduce((best, n) =>
    Math.abs(n - target) < Math.abs(best - target) ? n : best,
  );
export function arcadeBarTicks(score: Score): number {
  return (PPQ * 4 * score.meter[0]) / score.meter[1];
}
/** One stable song-derived phrase, or one beat of a continuous ribbon voice.
 * Sequence changes IDs only. Input timing is absolute; returned notes are loop-relative.
 */
export function createArcadeExperimentPhrase(
  input: ArcadeExperimentOptions,
): ArcadePhrase {
  const {
    score,
    intent,
    intensity,
    startTick,
    loopStartTick,
    loopEndTick,
    mode,
  } = input;
  if (
    !["phrase-rider", "groove-fighter", "ribbon-lead"].includes(mode) ||
    !["strike", "leap", "dash", "guard", "reply", "rest"].includes(intent) ||
    !Number.isInteger(startTick) ||
    startTick < loopStartTick ||
    startTick >= loopEndTick ||
    !Number.isFinite(input.ribbon ?? 0.5) ||
    !Number.isFinite(input.direction ?? 0) ||
    !Number.isInteger(input.ribbonStepTicks ?? PPQ) ||
    (input.ribbonStepTicks ?? PPQ) < 1 ||
    (input.ribbonStepTicks ?? PPQ) > PPQ
  )
    throw new RangeError("Invalid Arcade experiment options");
  // Reuse the score-aware harmony reader and validation from ordinary gestures.
  const anchor = createArcadePhrase({
    score,
    trackId: input.trackId,
    action: "guard",
    aggression: intensity,
    positionTick: startTick,
    loopStartTick,
    loopEndTick,
    previousPitch: input.previousPitch,
    sequence: input.sequence,
  });
  const track = score.tracks.find((t) => t.id === input.trackId)!;
  const length =
    mode === "ribbon-lead"
      ? (input.ribbonStepTicks ?? PPQ)
      : arcadeBarTicks(score);
  const endTick = Math.min(loopEndTick, startTick + length);
  const result: ArcadePhrase = {
    ...anchor,
    notes: [],
    startTick,
    endTick,
    harmonySource:
      mode === "groove-fighter" ? "percussion" : anchor.harmonySource,
    description: intent === "rest" ? "Rest · space for the song" : "",
  };
  if (mode === "ribbon-lead")
    result.lastPitch = input.previousPitch ?? anchor.lastPitch;
  if (intent === "rest") return result;
  const low = track.role === "bass" ? 36 : track.role === "harmony" ? 48 : 60;
  const palette = Array.from({ length: 25 }, (_, i) => low + i).filter((p) =>
    scaleIntervals[score.scale.mode].includes(
      (p - score.scale.root + 120) % 12,
    ),
  );
  const sourceClip = score.clips.find(
    (c) =>
      c.trackId === track.id &&
      c.startTick <= startTick &&
      startTick <
        c.startTick +
          (score.patterns.find((p) => p.id === c.patternId)?.lengthTicks ?? 0) *
            c.repeats,
  );
  const motif = [
    ...(score.patterns.find((p) => p.id === sourceClip?.patternId)?.notes ??
      []),
  ]
    .filter((n) => n.velocity > 0)
    .sort((a, b) => a.startTick - b.startTick)
    .slice(0, 6);
  const motifContour =
    motif.length > 1
      ? motif.map((n) => Math.round((n.pitch - motif[0]!.pitch) / 2))
      : [0, 2, 1, -1, 0, 1];
  const tonic = nearest(
    palette.filter((p) => (p - score.scale.root + 120) % 12 === 0),
    low + 7,
  );
  const center =
    mode === "ribbon-lead"
      ? (input.previousPitch ?? tonic)
      : nearest(palette, tonic + (intensity === 3 ? 5 : 0));
  const base = palette.indexOf(nearest(palette, center));
  const rhythm =
    intensity === 1
      ? [0, 2, 3.5, 5, 7]
      : intensity === 2
        ? [0, 1.5, 2, 3.5, 4.5, 5, 6, 7]
        : [0, 0.5, 1.5, 2, 3, 3.5, 4, 4.5, 5, 6, 6.5, 7];
  const offsets =
    mode === "ribbon-lead"
      ? intensity === 1
        ? [0]
        : intensity === 2
          ? [0, 240]
          : [0, 120, 240, 360]
      : mode === "groove-fighter"
        ? Array.from({ length: 16 }, (_, i) => (i * length) / 16)
        : rhythm.map((n) => Math.round((n * length) / 8));
  for (let i = 0; i < offsets.length; i++) {
    const offset = offsets[i]!,
      tick = startTick + offset;
    if (tick >= endTick) break;
    let pitch: number;
    if (mode === "groove-fighter") {
      // A full persistent kit pattern. Density adds hats/ghosts; the backbone remains.
      const step = i;
      let voices =
        step % 8 === 0
          ? [36, 42]
          : step % 8 === 4
            ? [38, 42]
            : step % (intensity === 1 ? 4 : 2) === 0
              ? [42]
              : intensity === 3
                ? [42]
                : [];
      if (intent === "leap" && [3, 10, 14].includes(step))
        voices = [...voices, step === 10 ? 36 : 46];
      if (intent === "dash" && step >= 12)
        voices = [step % 2 ? 38 : 46, ...(intensity > 1 ? [42] : [])];
      if (intent === "guard") voices = step % 8 === 0 ? [36] : [];
      for (const [voiceIndex, drum] of [...new Set(voices)].entries())
        result.notes.push({
          id: `arcade:${input.sequence ?? 0}:${startTick}:${i}:${voiceIndex}`,
          startTick: tick - loopStartTick,
          durationTicks: Math.max(
            1,
            Math.min(endTick - tick, Math.round(length / 20)),
          ),
          pitch: drum,
          velocity:
            drum === 42 ? 0.35 + intensity * 0.07 : 0.7 + intensity * 0.05,
        });
      continue;
    }
    let degree: number;
    if (mode === "ribbon-lead") {
      const target = clamp(input.ribbon ?? 0.5, 0, 1) * (palette.length - 1);
      const previous = palette.indexOf(
        nearest(palette, result.lastPitch ?? center),
      );
      const delta =
        input.direction || (intent === "leap" ? 1 : intent === "dash" ? -1 : 0);
      degree = delta
        ? previous + Math.sign(delta)
        : previous + clamp(Math.round(target) - previous, -1, 1);
      if (intent === "guard") degree = previous;
    } else {
      const shape = motifContour[i % motifContour.length]!;
      degree =
        base +
        (intent === "leap"
          ? Math.min(5, Math.floor(i / 2))
          : intent === "dash"
            ? 4 - Math.floor(i / 2)
            : intent === "guard"
              ? -Math.min(3, Math.floor(i / 2))
              : intent === "reply"
                ? -shape
                : shape);
    }
    pitch = palette[clamp(degree, 0, palette.length - 1)]!;
    if (
      mode === "phrase-rider" &&
      (i === 0 || i === offsets.length - 1 || offset % PPQ === 0)
    ) {
      const landing = createArcadePhrase({
        score,
        trackId: input.trackId,
        action: "guard",
        aggression: intensity,
        positionTick: tick,
        loopStartTick,
        loopEndTick,
        previousPitch: pitch,
      });
      if (landing.harmonySource === "score-notes") {
        pitch = landing.notes[0]?.pitch ?? pitch;
        result.harmonySource = "score-notes";
      } else if (i === offsets.length - 1)
        pitch = nearest(
          [tonic, tonic + 12].filter((p) => p <= low + 24),
          pitch,
        );
    }
    const next = Math.min(length, offsets[i + 1] ?? length);
    result.notes.push({
      id: `arcade:${input.sequence ?? 0}:${startTick}:${i}`,
      startTick: tick - loopStartTick,
      durationTicks: Math.max(
        1,
        Math.min(
          endTick - tick,
          Math.floor(
            (next - offset) *
              (mode === "ribbon-lead"
                ? intensity === 1
                  ? 0.98
                  : intensity === 2
                    ? 0.9
                    : 0.76
                : intent === "guard"
                  ? 0.9
                  : 0.72),
          ),
        ),
      ),
      pitch,
      velocity: 0.5 + intensity * 0.1 + (i === 0 ? 0.06 : i % 2 ? -0.05 : 0),
    });
    result.lastPitch = pitch;
  }
  const names =
    mode === "groove-fighter"
      ? {
          strike: "Pocket groove",
          leap: "Offbeat variation",
          dash: "Turnaround fill",
          guard: "Kick drop",
          reply: "Pocket groove",
        }
      : mode === "ribbon-lead"
        ? {
            strike: "Ribbon melody",
            leap: "Lift",
            dash: "Fall",
            guard: "Held tone",
            reply: "Ribbon melody",
          }
        : {
            strike: "Song motif",
            reply: "Answer",
            leap: "Rise",
            dash: "Descending answer",
            guard: "Resolve",
          };
  result.description = `${names[intent]} · ${result.notes.length} notes · ${mode === "groove-fighter" ? "drum lane" : result.harmonySource === "score-notes" ? "song harmony" : "song scale"}`;
  return result;
}

/** Playback-only arrangement; the original score and its track metadata are preserved. */
export function createArcadeBacking(
  score: Score,
  role: Score["tracks"][number]["role"],
  backing: ArcadeBacking,
): Score {
  if (backing === "metronome")
    return { ...score, tracks: score.tracks.map((t) => ({ ...t, gain: 0 })) };
  return {
    ...score,
    tracks: score.tracks.map((t) => ({
      ...t,
      gain:
        backing === "full"
          ? t.gain
          : backing === "without-role"
            ? t.role === role
              ? 0
              : t.gain
            : t.role === "bass" || t.role === "drums"
              ? t.role === role
                ? 0
                : t.gain
              : 0,
    })),
  };
}
