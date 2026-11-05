import { describe, expect, it } from "vitest";
import { createBlankScore, type Score } from "@onepage/project";
import { createArcadePhrase, type ArcadePhraseOptions } from "./arcade";

function options(score = createBlankScore()): ArcadePhraseOptions {
  return {
    score,
    trackId: score.tracks[0]!.id,
    action: "strike",
    aggression: 2,
    positionTick: 0,
    loopStartTick: 0,
    loopEndTick: 1920,
  };
}
function accompaniment(
  score: Score,
  role: "harmony" | "bass" | "drums" = "harmony",
) {
  score.tracks.push({ ...score.tracks[0]!, id: "backing", role });
  score.patterns.push({
    id: "backing-pattern",
    name: "Backing",
    lengthTicks: 480,
    notes: [60, 64, 67].map((pitch, i) => ({
      id: `chord-${i}`,
      pitch,
      startTick: 0,
      durationTicks: 480,
      velocity: 0.7,
    })),
  });
  score.clips.push({
    id: "backing-clip",
    trackId: "backing",
    patternId: "backing-pattern",
    startTick: 480,
    repeats: 3,
    transpose: 2,
  });
}

describe("Arcade phrases", () => {
  it.each(["major", "minor", "chromatic"] as const)(
    "uses %s metadata with every root without inventing harmony",
    (mode) => {
      const degrees =
        mode === "major"
          ? [0, 2, 4, 5, 7, 9, 11]
          : mode === "minor"
            ? [0, 2, 3, 5, 7, 8, 10]
            : Array.from({ length: 12 }, (_, i) => i);
      for (let root = 0; root < 12; root++) {
        const input = options();
        input.score.scale = { root, mode };
        const phrase = createArcadePhrase({ ...input, aggression: 3 });
        expect(phrase.harmonySource).toBe("scale");
        expect(
          phrase.notes.every((n) =>
            degrees.includes((n.pitch - root + 120) % 12),
          ),
        ).toBe(true);
        expect(phrase.notes.every((n) => n.pitch >= 60 && n.pitch <= 84)).toBe(
          true,
        );
      }
    },
  );
  it("is deterministic, preserves score, and changes density and dynamics without BPM changes", () => {
    const input = options(),
      before = structuredClone(input.score);
    const calm = createArcadePhrase({ ...input, aggression: 1 });
    const fierce = createArcadePhrase({ ...input, aggression: 3 });
    expect(calm.notes).toHaveLength(2);
    expect(fierce.notes).toHaveLength(4);
    expect(fierce.notes[0]!.velocity).toBeGreaterThan(calm.notes[0]!.velocity);
    expect(createArcadePhrase(input)).toEqual(createArcadePhrase(input));
    expect(input.score).toEqual(before);
    expect(createArcadePhrase({ ...input, sequence: 1 }).notes[0]!.id).not.toBe(
      createArcadePhrase(input).notes[0]!.id,
    );
  });
  it("quantizes forward relative to a nonzero loop and exposes absolute scheduling bounds", () => {
    const phrase = createArcadePhrase({
      ...options(),
      positionTick: 1098.2,
      loopStartTick: 960,
    });
    expect(phrase.startTick).toBe(1200);
    expect(phrase.endTick).toBe(1680);
    expect(phrase.notes[0]!.startTick).toBe(240);
    expect(
      phrase.notes.every((n) => n.startTick >= 240 && n.startTick % 120 === 0),
    ).toBe(true);
  });
  it("clips durations at short loop boundaries and never wraps an action early", () => {
    const tiny = createArcadePhrase({
      ...options(),
      loopStartTick: 37,
      loopEndTick: 38,
      positionTick: 37,
    });
    expect(tiny.notes).toHaveLength(1);
    expect(tiny.notes[0]!.startTick).toBe(0);
    expect(tiny.notes[0]!.durationTicks).toBe(1);
    const clipped = createArcadePhrase({
      ...options(),
      positionTick: 1800,
      loopEndTick: 1860,
    });
    expect(clipped.notes).toHaveLength(1);
    expect(
      clipped.notes[0]!.startTick + clipped.notes[0]!.durationTicks,
    ).toBeLessThanOrEqual(1860);
    for (const tick of [1850, 1860, 1900])
      expect(
        createArcadePhrase({
          ...options(),
          positionTick: tick,
          loopEndTick: 1860,
        }).notes,
      ).toEqual([]);
  });
  it("uses transposed repeated sounding accompaniment for phrase boundary anchors", () => {
    const input = options();
    accompaniment(input.score);
    for (const positionTick of [480, 960, 1440]) {
      const phrase = createArcadePhrase({ ...input, positionTick });
      expect(phrase.harmonySource).toBe("score-notes");
      expect([2, 6, 9]).toContain(phrase.notes[0]!.pitch % 12);
      expect([2, 6, 9]).toContain(phrase.notes.at(-1)!.pitch % 12);
    }
    expect(createArcadePhrase(input).harmonySource).toBe("scale");
    expect(createArcadePhrase({ ...input, positionTick: 1920 }).notes).toEqual(
      [],
    );
  });
  it("re-evaluates harmony at a chord change rather than holding the launch chord", () => {
    const input = options();
    accompaniment(input.score);
    input.score.patterns.at(-1)!.lengthTicks = 240;
    input.score.patterns.at(-1)!.notes.forEach((n) => (n.durationTicks = 240));
    input.score.clips.at(-1)!.repeats = 1;
    input.score.clips.push({
      ...input.score.clips.at(-1)!,
      id: "change",
      startTick: 720,
      transpose: 5,
    });
    const phrase = createArcadePhrase({
      ...input,
      positionTick: 480,
      aggression: 3,
    });
    expect([2, 6, 9]).toContain(phrase.notes[0]!.pitch % 12);
    expect([5, 9, 0]).toContain(phrase.notes.at(-1)!.pitch % 12);
  });
  it("ignores drum, silent, noise, and the selected muted track as harmony", () => {
    for (const variant of ["drums", "silent", "noise", "selected"] as const) {
      const input = options();
      accompaniment(input.score, variant === "drums" ? "drums" : "harmony");
      if (variant === "silent") input.score.tracks.at(-1)!.gain = 0;
      if (variant === "noise") input.score.patches[0]!.waveform = "noise";
      if (variant === "selected") input.trackId = "backing";
      expect(
        createArcadePhrase({ ...input, positionTick: 480 }).harmonySource,
      ).toBe("scale");
    }
  });
  it("follows a bass anchor without claiming to recognize a chord", () => {
    const input = options();
    accompaniment(input.score, "bass");
    input.score.patterns.at(-1)!.notes = [
      input.score.patterns.at(-1)!.notes[0]!,
    ];
    const phrase = createArcadePhrase({ ...input, positionTick: 480 });
    expect(phrase.harmonySource).toBe("score-notes");
    expect(phrase.notes[0]!.pitch % 12).toBe(2);
    expect(phrase.description).not.toMatch(/major|minor|chord/);
  });
  it("borrows the selected motif's contour for a strike", () => {
    const input = options();
    input.score.scale.mode = "major";
    input.score.patterns[0]!.notes = [67, 64, 60].map((pitch, i) => ({
      id: String(i),
      pitch,
      startTick: i * 120,
      durationTicks: 100,
      velocity: 0.8,
    }));
    const phrase = createArcadePhrase({ ...input, previousPitch: 72 });
    expect(phrase.notes[0]!.pitch).toBeGreaterThan(phrase.notes[1]!.pitch);
    expect(phrase.notes[1]!.pitch).toBeGreaterThan(phrase.notes[2]!.pitch);
    expect(phrase.description).toContain("song motif");
  });
  it("connects phrases near the previous voice and supports explicit bass/percussion roles", () => {
    const input = options();
    const first = createArcadePhrase({ ...input, previousPitch: 71 });
    expect(Math.abs(first.notes[0]!.pitch - 71)).toBeLessThanOrEqual(1);
    input.score.tracks[0]!.role = "bass";
    expect(
      createArcadePhrase(input).notes.every(
        (n) => n.pitch >= 36 && n.pitch <= 60,
      ),
    ).toBe(true);
    input.score.tracks[0]!.role = "drums";
    accompaniment(input.score);
    const drums = createArcadePhrase({ ...input, positionTick: 480 });
    expect(drums.harmonySource).toBe("percussion");
    expect(drums.notes.every((n) => [36, 38, 42, 46].includes(n.pitch))).toBe(
      true,
    );
  });
  it.each(["strike", "leap", "dash", "guard"] as const)(
    "bounds %s phrases and optional registers",
    (action) => {
      const input = options();
      const phrase = createArcadePhrase({
        ...input,
        action,
        aggression: 3,
        registerOffset: 24,
      });
      expect(
        phrase.notes.every(
          (n) =>
            n.pitch >= 84 &&
            n.pitch <= 108 &&
            n.durationTicks > 0 &&
            n.velocity <= 1,
        ),
      ).toBe(true);
      expect(
        phrase.notes.every((n) => n.startTick + n.durationTicks <= 480),
      ).toBe(true);
    },
  );
  it("rejects invalid inputs instead of producing non-finite note times", () => {
    for (const override of [
      { positionTick: NaN },
      { aggression: 4 },
      { loopEndTick: 0 },
      { loopStartTick: 0.5 },
      { trackId: "missing" },
      { previousPitch: Infinity },
      { sequence: -1 },
      { action: "toString" },
    ])
      expect(() =>
        createArcadePhrase({
          ...options(),
          ...override,
        } as ArcadePhraseOptions),
      ).toThrow();
  });
});
