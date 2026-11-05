import { describe, expect, it } from "vitest";
import { createBlankScore } from "@onepage/project";
import {
  arcadeBarTicks,
  createArcadeBacking,
  createArcadeExperimentPhrase,
  type ArcadeExperimentOptions,
} from "./arcade-experiments";
const options = (
  overrides: Partial<ArcadeExperimentOptions> = {},
): ArcadeExperimentOptions => ({
  score: createBlankScore(),
  trackId: "melody",
  mode: "phrase-rider",
  intent: "strike",
  startTick: 0,
  loopStartTick: 0,
  loopEndTick: 3840,
  intensity: 1,
  ...overrides,
});
describe("Arcade experiments", () => {
  it("develops a recognizable full-bar idea with stable identity across repetition", () => {
    const input = options();
    const before = structuredClone(input.score);
    const first = createArcadeExperimentPhrase(input);
    const repeat = createArcadeExperimentPhrase({ ...input, sequence: 9 });
    expect(first.endTick).toBe(1920);
    expect(first.notes.length).toBeGreaterThan(3);
    expect(first.notes.at(-1)!.startTick).toBeGreaterThan(1440);
    expect(first.notes.map(({ id, ...n }) => n)).toEqual(
      repeat.notes.map(({ id, ...n }) => n),
    );
    expect(first.notes[0]!.id).not.toBe(repeat.notes[0]!.id);
    expect(input.score).toEqual(before);
  });
  it("changes musical identity for an answer and density for intensity without polyphonic stacking", () => {
    const motif = createArcadeExperimentPhrase(options());
    const answer = createArcadeExperimentPhrase(options({ intent: "reply" }));
    const fierce = createArcadeExperimentPhrase(options({ intensity: 3 }));
    expect(answer.notes.map((n) => n.pitch)).not.toEqual(
      motif.notes.map((n) => n.pitch),
    );
    expect(fierce.notes.length).toBeGreaterThan(motif.notes.length);
    expect(fierce.notes[0]!.velocity).toBeGreaterThan(motif.notes[0]!.velocity);
    for (let i = 1; i < fierce.notes.length; i++)
      expect(
        fierce.notes[i - 1]!.startTick + fierce.notes[i - 1]!.durationTicks,
      ).toBeLessThanOrEqual(fierce.notes[i]!.startTick);
  });
  it("borrows the selected song motif and respects harmony audible in the chosen backing", () => {
    const score = createBlankScore();
    score.patterns[0]!.notes = [67, 64, 60].map((pitch, i) => ({
      id: `m${i}`,
      pitch,
      startTick: i * 240,
      durationTicks: 120,
      velocity: 0.8,
    }));
    score.tracks.push({ ...score.tracks[0]!, id: "harmony", role: "harmony" });
    score.patterns.push({
      id: "h",
      name: "Chord",
      lengthTicks: 3840,
      notes: [62, 65, 69].map((pitch, i) => ({
        id: `h${i}`,
        pitch,
        startTick: 0,
        durationTicks: 3840,
        velocity: 0.8,
      })),
    });
    score.clips.push({
      id: "h",
      trackId: "harmony",
      patternId: "h",
      startTick: 0,
      repeats: 1,
      transpose: 0,
    });
    const song = createArcadeExperimentPhrase(options({ score }));
    expect(song.harmonySource).toBe("score-notes");
    expect([2, 5, 9]).toContain(song.notes[0]!.pitch % 12);
    expect([2, 5, 9]).toContain(song.notes.at(-1)!.pitch % 12);
    const scaleOnly = createArcadeExperimentPhrase(
      options({ score: createArcadeBacking(score, "melody", "metronome") }),
    );
    expect(scaleOnly.harmonySource).toBe("scale");
  });
  it("uses the meter and clips at nonzero, partial loop boundaries", () => {
    const score = createBlankScore();
    score.meter = [7, 8];
    expect(arcadeBarTicks(score)).toBe(1680);
    const phrase = createArcadeExperimentPhrase(
      options({
        score,
        startTick: 960,
        loopStartTick: 960,
        loopEndTick: 1710,
        intensity: 3,
      }),
    );
    expect(phrase.startTick).toBe(960);
    expect(phrase.endTick).toBe(1710);
    expect(phrase.notes[0]!.startTick).toBe(0);
    expect(
      phrase.notes.every(
        (n) => n.startTick >= 0 && n.startTick + n.durationTicks <= 750,
      ),
    ).toBe(true);
  });
  it.each(["major", "minor", "chromatic"] as const)(
    "keeps melodic movement in each %s key",
    (mode) => {
      for (let root = 0; root < 12; root++) {
        const score = createBlankScore();
        score.scale = { root, mode };
        const notes = createArcadeExperimentPhrase(
          options({ score, intensity: 3, intent: "leap" }),
        ).notes;
        const intervals =
          mode === "major"
            ? [0, 2, 4, 5, 7, 9, 11]
            : mode === "minor"
              ? [0, 2, 3, 5, 7, 8, 10]
              : Array.from({ length: 12 }, (_, i) => i);
        expect(
          notes.every((n) => intervals.includes((n.pitch - root + 120) % 12)),
        ).toBe(true);
      }
    },
  );
  it("creates a kit groove independent of the selected melodic role and keeps a fill's backbone", () => {
    const groove = createArcadeExperimentPhrase(
      options({ mode: "groove-fighter", intensity: 2 }),
    );
    const fill = createArcadeExperimentPhrase(
      options({ mode: "groove-fighter", intent: "dash", intensity: 2 }),
    );
    expect(groove.harmonySource).toBe("percussion");
    expect(groove.notes.some((n) => n.pitch === 36)).toBe(true);
    expect(groove.notes.some((n) => n.pitch === 38)).toBe(true);
    expect(
      groove.notes.filter((n) => n.startTick < 1440).map(({ id, ...n }) => n),
    ).toEqual(
      fill.notes.filter((n) => n.startTick < 1440).map(({ id, ...n }) => n),
    );
    expect(fill.notes.every((n) => [36, 38, 42, 46].includes(n.pitch))).toBe(
      true,
    );
    const drop = createArcadeExperimentPhrase(
      options({ mode: "groove-fighter", intent: "guard" }),
    );
    expect(drop.notes.every((n) => n.pitch === 36)).toBe(true);
  });
  it("carries Ribbon pitch forward one scale step per pulse instead of snapping back every beat", () => {
    const one = createArcadeExperimentPhrase(
      options({ mode: "ribbon-lead", previousPitch: 60, ribbon: 1 }),
    );
    const two = createArcadeExperimentPhrase(
      options({
        mode: "ribbon-lead",
        startTick: 480,
        previousPitch: one.lastPitch,
        ribbon: 1,
      }),
    );
    expect(one.lastPitch).toBe(62);
    expect(two.lastPitch).toBe(63);
    const fall = createArcadeExperimentPhrase(
      options({ mode: "ribbon-lead", intent: "dash", previousPitch: 72 }),
    );
    expect(fall.lastPitch).toBeLessThan(72);
    const hold = createArcadeExperimentPhrase(
      options({ mode: "ribbon-lead", intent: "guard", previousPitch: 72 }),
    );
    expect(hold.lastPitch).toBe(72);
  });
  it.each(["phrase-rider", "groove-fighter", "ribbon-lead"] as const)(
    "represents an explicit rest in %s",
    (mode) => {
      const rest = createArcadeExperimentPhrase(
        options({ mode, intent: "rest" }),
      );
      expect(rest.notes).toEqual([]);
      expect(rest.endTick).toBeGreaterThan(rest.startTick);
    },
  );
  it("arranges only playback and leaves drum performance a space of its own", () => {
    const score = createBlankScore();
    score.tracks.push(
      { ...score.tracks[0]!, id: "d", role: "drums" },
      { ...score.tracks[0]!, id: "b", role: "bass" },
    );
    const before = structuredClone(score);
    expect(
      createArcadeBacking(score, "drums", "without-role").tracks.map(
        (t) => t.gain,
      ),
    ).toEqual([0.65, 0, 0.65]);
    expect(
      createArcadeBacking(score, "melody", "foundation").tracks.map(
        (t) => t.gain,
      ),
    ).toEqual([0, 0.65, 0.65]);
    expect(createArcadeBacking(score, "melody", "full")).toEqual(score);
    expect(score).toEqual(before);
  });
  it("rejects invalid mode, times and motion without non-finite notes", () => {
    for (const override of [
      { startTick: 3840 },
      { startTick: 0.5 },
      { ribbon: NaN },
      { direction: Infinity },
      { intensity: 4 },
      { mode: "missing" },
      { intent: "missing" },
    ])
      expect(() =>
        createArcadeExperimentPhrase(
          options(override as Partial<ArcadeExperimentOptions>),
        ),
      ).toThrow();
  });
});

it("samples a live Ribbon slice and changes its gate without scheduling a whole beat", () => {
  const calm = createArcadeExperimentPhrase(
    options({
      mode: "ribbon-lead",
      ribbonStepTicks: 120,
      previousPitch: 60,
      ribbon: 1,
      intensity: 1,
    }),
  );
  const fierce = createArcadeExperimentPhrase(
    options({
      mode: "ribbon-lead",
      ribbonStepTicks: 120,
      previousPitch: 60,
      ribbon: 1,
      intensity: 3,
    }),
  );
  expect(calm.endTick).toBe(120);
  expect(calm.notes).toHaveLength(1);
  expect(fierce.notes).toHaveLength(1);
  expect(calm.notes[0]!.durationTicks).toBeGreaterThan(
    fierce.notes[0]!.durationTicks,
  );
  expect(calm.lastPitch).toBe(62);
  expect(fierce.lastPitch).toBe(62);
});
