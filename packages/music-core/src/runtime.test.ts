import { expect, it } from "vitest";
import {
  createBlankScore,
  createStarter,
  validateScore,
  type Score,
  PPQ,
} from "@onepage/project";
import { compileScore as authoringCompile } from "./index";
import {
  assertPlayableScore,
  compileScore,
  ticksToSeconds,
  secondsToTicks,
} from "./runtime";
import m2Score from "../../../examples/game-m2/score.json";
it("runtime compiler and authoring entry emit identical traces for authored scores/energies/windows", () => {
  for (const score of [createBlankScore(), createStarter(), m2Score as Score]) {
    expect(() => assertPlayableScore(score)).not.toThrow();
    for (const energy of [1, 2, 3])
      for (const startTick of [0, 240, 960])
        expect(compileScore(score, { energy, startTick })).toEqual(
          authoringCompile(score, { energy, startTick }),
        );
  }
});
it("rejects malformed shape, resource bounds and broken references before expansion", () => {
  const mutations: ((score: Score) => void)[] = [
    (s) => {
      s.ppq = 60 as 480;
    },
    (s) => {
      s.bpm = NaN;
    },
    (s) => {
      s.loop = null;
    },
    (s) => {
      s.loop!.endTick = s.lengthTicks + 1;
    },
    (s) => {
      s.meter = [4, 3] as unknown as [number, 4];
    },
    (s) => {
      s.tracks[0].patchId = "missing";
    },
    (s) => {
      s.clips[0].patternId = "missing";
    },
    (s) => {
      s.clips[0].trackId = "missing";
    },
    (s) => {
      s.clips[0].repeats = 1025;
    },
    (s) => {
      s.patterns[0].notes[0].durationTicks = 10_000_000;
    },
    (s) => {
      s.patterns[0].notes[0].velocity = Infinity;
    },
    (s) => {
      s.patterns[0].notes.push({ ...s.patterns[0].notes[0] });
    },
    (s) => {
      s.patches[0].attack = -1;
    },
    (s) => {
      s.patches[0].waveform = "unknown" as "sine";
    },
    (s) => {
      s.tracks.push({ ...s.tracks[0] });
    },
    (s) => {
      s.tracks[0].minEnergy = 4;
    },
    (s) => {
      Object.assign(s, { executable: "bad" });
    },
    (s) => {
      s.clips[0].transpose = 127;
    },
    (s) => {
      s.sections = [
        { id: "bad", name: "bad", startTick: s.lengthTicks, lengthTicks: 1 },
      ];
    },
  ];
  for (const mutate of mutations) {
    const score = structuredClone(m2Score) as Score;
    mutate(score);
    expect(validateScore(score).valid).toBe(false);
    expect(() => compileScore(score)).toThrow("Invalid score");
  }
  const score = structuredClone(m2Score) as Score;
  score.lengthTicks = 10_000_000;
  score.clips = Array.from({ length: 2048 }, (_, i) => ({
    ...score.clips[0],
    id: `clip-${i}`,
    repeats: 1024,
  }));
  expect(() => compileScore(score)).toThrow("expanded note limit");
  expect(() => assertPlayableScore(null)).toThrow("Invalid score");
});

it("enforces the declared v1 PPQ contract and converts its musical time without rounding", () => {
  expect(PPQ).toBe(480);
  for (const bpm of [20, 112, 120, 400])
    for (const ticks of [0, 1, PPQ, 960.5, 10_000_000])
      expect(secondsToTicks(ticksToSeconds(ticks, bpm), bpm)).toBeCloseTo(
        ticks,
        7,
      );
  for (const ppq of [96, 240, 960]) {
    const unsupported = { ...createBlankScore(), ppq };
    expect(validateScore(unsupported).valid).toBe(false);
    expect(() => assertPlayableScore(unsupported)).toThrow("Invalid score");
  }
});
