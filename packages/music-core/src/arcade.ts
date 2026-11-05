import { PPQ, type Note, type Score } from "@onepage/project";

export type ArcadeAction = "strike" | "leap" | "dash" | "guard";
export interface ArcadePhraseOptions {
  score: Score;
  trackId: string;
  action: ArcadeAction;
  positionTick: number;
  loopStartTick: number;
  loopEndTick: number;
  aggression: 1 | 2 | 3;
  previousPitch?: number;
  sequence?: number;
  registerOffset?: number;
}
export interface ArcadePhrase {
  /** Editable note positions are relative to loopStartTick. */
  notes: Note[];
  /** These bounds are absolute score ticks, including for an empty phrase. */
  startTick: number;
  endTick: number;
  lastPitch: number;
  harmonySource: "score-notes" | "scale" | "percussion";
  description: string;
}

const intervals = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
} as const;
const contours: Record<ArcadeAction, number[]> = {
  strike: [0, 2, 1, 0],
  leap: [0, 2, 4, 1],
  dash: [0, 1, 2, 3],
  guard: [0, 0, 0, 0],
};
const clamp = (n: number, low: number, high: number) =>
  Math.max(low, Math.min(high, n));
const pitchClass = (n: number) => ((n % 12) + 12) % 12;
function nearest(pitches: number[], target: number): number {
  return pitches.reduce((best, pitch) =>
    Math.abs(pitch - target) < Math.abs(best - target) ? pitch : best,
  );
}
function pitchesInRange(classes: readonly number[], low: number, high: number) {
  return Array.from({ length: high - low + 1 }, (_, i) => low + i).filter(
    (pitch) => classes.includes(pitchClass(pitch)),
  );
}

/**
 * Deterministic one-beat gesture. The caller owns audio clock, gesture cooldown,
 * patch choice, cancellation and take IDs; the score and its BPM are never changed.
 * A position at/after the loop end returns no notes rather than wrapping sound
 * into the wrong pass. Quantization is anchored to the capture loop's start.
 */
export function createArcadePhrase(input: ArcadePhraseOptions): ArcadePhrase {
  const {
    score,
    action,
    aggression,
    loopStartTick: start,
    loopEndTick: end,
  } = input;
  const track = score.tracks.find(
    (candidate) => candidate.id === input.trackId,
  );
  if (!track) throw new RangeError("Arcade phrase requires an existing track");
  if (
    ![
      input.positionTick,
      start,
      end,
      input.previousPitch ?? 60,
      input.sequence ?? 0,
      input.registerOffset ?? 0,
    ].every(Number.isFinite) ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > score.lengthTicks ||
    ![1, 2, 3].includes(aggression) ||
    !Object.hasOwn(contours, action) ||
    !Number.isInteger(input.sequence ?? 0) ||
    (input.sequence ?? 0) < 0
  )
    throw new RangeError("Invalid Arcade phrase options");
  const offset = clamp(Math.round(input.registerOffset ?? 0), -24, 24);
  const low =
    (track.role === "bass" ? 36 : track.role === "harmony" ? 48 : 60) + offset;
  const high = low + 24;
  const classes = intervals[score.scale.mode].map((n) =>
    pitchClass(n + score.scale.root),
  );
  const palette = pitchesInRange(classes, low, high);
  const center = clamp(
    input.previousPitch ?? low + 7 + (aggression - 1) * 2,
    low,
    high,
  );
  const launch = Math.min(
    end,
    start +
      Math.ceil(Math.max(0, input.positionTick - start) / (PPQ / 4)) *
        (PPQ / 4),
  );
  const finish = Math.min(end, launch + PPQ);
  const result: ArcadePhrase = {
    notes: [],
    startTick: launch,
    endTick: finish,
    lastPitch: nearest(palette, center),
    harmonySource: track.role === "drums" ? "percussion" : "scale",
    description: "Loop boundary: wait for the next pass.",
  };
  if (launch === end) return result;

  const patterns = new Map(
    score.patterns.map((pattern) => [pattern.id, pattern]),
  );
  const tracks = new Map(
    score.tracks.map((candidate) => [candidate.id, candidate]),
  );
  const patches = new Map(score.patches.map((patch) => [patch.id, patch]));
  // Read only the repeat sounding at this tick, rather than expanding the song.
  const sounding = (tick: number): number[] => {
    const harmony: number[] = [],
      bass: number[] = [];
    for (const clip of score.clips) {
      const voice = tracks.get(clip.trackId),
        pattern = patterns.get(clip.patternId);
      if (
        !voice ||
        !pattern ||
        clip.trackId === track.id ||
        voice.gain === 0 ||
        patches.get(voice.patchId)?.waveform === "noise" ||
        !["harmony", "bass"].includes(voice.role)
      )
        continue;
      const relative = tick - clip.startTick;
      if (relative < 0 || relative >= pattern.lengthTicks * clip.repeats)
        continue;
      const local = relative % pattern.lengthTicks;
      for (const note of pattern.notes) {
        if (
          note.velocity > 0 &&
          note.startTick <= local &&
          local < note.startTick + note.durationTicks
        )
          (voice.role === "harmony" ? harmony : bass).push(
            pitchClass(note.pitch + clip.transpose),
          );
      }
    }
    // A sounding bass note is evidence for one anchor, not a complete chord.
    return [...new Set(harmony.length ? harmony : bass)];
  };

  // Borrow a short contour from the actual selected phrase when available.
  const sourceClip = score.clips.find((clip) => {
    const pattern = patterns.get(clip.patternId);
    return (
      clip.trackId === track.id &&
      pattern &&
      clip.startTick <= launch &&
      launch < clip.startTick + pattern.lengthTicks * clip.repeats
    );
  });
  const sourcePattern = sourceClip
    ? patterns.get(sourceClip.patternId)
    : undefined;
  const motif = [...(sourcePattern?.notes ?? [])]
    .filter((note) => note.velocity > 0)
    .sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch)
    .slice(0, 4);
  const sourceContour = motif.map((note) => {
    const pitch = note.pitch + (sourceClip?.transpose ?? 0);
    // Preserve contour while adapting foreign/chromatic notes to this scale.
    const allScale = pitchesInRange(classes, 0, 127);
    return allScale.indexOf(nearest(allScale, pitch));
  });
  const borrowed = sourceContour.length >= 2 && track.role !== "drums";
  const contour =
    borrowed && action === "strike"
      ? sourceContour.map((degree) => clamp(degree - sourceContour[0]!, -4, 4))
      : contours[action];
  const rhythm =
    action === "guard"
      ? aggression === 1
        ? [0]
        : aggression === 2
          ? [0, PPQ / 2]
          : [0, 120, 240, 360]
      : aggression === 1
        ? [0, PPQ / 2]
        : aggression === 2
          ? [0, PPQ / 4, (PPQ * 3) / 4]
          : [0, 120, 240, 360];
  const available = rhythm.filter((tick) => launch + tick < finish);
  const atLaunch = sounding(launch);
  const anchorPalette = atLaunch.length
    ? pitchesInRange(atLaunch, low, high)
    : palette;
  const anchor = nearest(anchorPalette, center);
  const anchorIndex = palette.indexOf(nearest(palette, anchor));
  for (let i = 0; i < available.length; i++) {
    const tick = launch + available[i]!;
    const activeClasses = sounding(tick);
    const chordPitches = activeClasses.length
      ? pitchesInRange(activeClasses, low, high)
      : [];
    const degree = contour[i % contour.length]!;
    let pitch = palette[clamp(anchorIndex + degree, 0, palette.length - 1)]!;
    // Launch, quarter-note beats and phrase endings favor observed sounding
    // accompaniment; other notes are brief scale tones. No chord is invented.
    if (
      track.role !== "drums" &&
      chordPitches.length &&
      (i === 0 ||
        i === available.length - 1 ||
        tick % PPQ === 0 ||
        score.scale.mode === "chromatic")
    ) {
      pitch = nearest(chordPitches, i === 0 ? center : pitch);
      result.harmonySource = "score-notes";
    }
    if (track.role === "drums")
      pitch =
        action === "guard"
          ? 42
          : action === "leap"
            ? [42, 46, 42, 38][i % 4]!
            : action === "dash"
              ? [36, 42, 38, 42][i % 4]!
              : [36, 38, 42, 38][i % 4]!;
    const next = launch + (available[i + 1] ?? PPQ);
    const durationTicks = Math.max(
      1,
      Math.min(
        finish - tick,
        Math.floor((next - tick) * (action === "guard" ? 0.95 : 0.75)),
      ),
    );
    result.notes.push({
      id: `arcade:${input.sequence ?? 0}:${launch}:${action}:${i}`,
      startTick: tick - start,
      durationTicks,
      pitch,
      velocity: clamp(
        0.52 + aggression * 0.12 + (i === 0 ? 0.06 : -0.02 * (i % 2)),
        0,
        1,
      ),
    });
    result.lastPitch = pitch;
  }
  result.description = `${action} · ${["", "calm", "driving", "fierce"][aggression]} · ${result.notes.length} notes · ${result.harmonySource === "score-notes" ? "follows sounding accompaniment" : result.harmonySource === "percussion" ? "percussion gesture" : "follows song scale"}${borrowed && action === "strike" ? " · song motif" : ""}`;
  return result;
}
