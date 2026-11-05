import { describe, expect, it } from "vitest";
import {
  createBlankScore,
  createStarter,
  STARTERS,
  validateScore,
} from "./index";
describe("score documents", () => {
  it("provides six deterministic valid original starters including fractional bars", () => {
    expect(STARTERS).toHaveLength(6);
    for (const starter of STARTERS) {
      const score = createStarter(starter.id);
      expect(validateScore(score)).toEqual({ valid: true, errors: [] });
      expect(createStarter(starter.id)).toEqual(score);
      expect(
        score.tracks.some((t) => t.id === starter.suggestedEdit.trackId),
      ).toBe(true);
    }
    expect(createStarter("clockwork-steps").lengthTicks).toBe(3120);
  });
  it("rejects unsafe scalar inputs and unknown format fields", () => {
    for (const patch of [
      { ppq: 96 },
      { bpm: NaN },
      { futureField: true },
      { lengthTicks: 1.5 },
    ])
      expect(validateScore({ ...createBlankScore(), ...patch }).valid).toBe(
        false,
      );
    const score = createBlankScore();
    score.tracks[0]!.gain = 10;
    expect(validateScore(score).valid).toBe(false);
  });
  it("rejects broken references, duplicates, pitch overflow and out-of-bounds expansion", () => {
    const score = createStarter();
    score.tracks[0]!.patchId = "missing";
    score.patterns[0]!.notes.push({ ...score.patterns[0]!.notes[0]! });
    score.clips[0]!.transpose = 100;
    score.clips[0]!.repeats = 2;
    const { errors } = validateScore(score);
    expect(errors.join(" ")).toMatch(/missing patch/);
    expect(errors.join(" ")).toMatch(/duplicate note/);
    expect(errors.join(" ")).toMatch(/exceeds score/);
    expect(errors.join(" ")).toMatch(/pitch out of range/);
  });
  it("rejects invalid loop and note bounds", () => {
    const score = createStarter();
    score.loop = { startTick: 100, endTick: 100 };
    score.patterns[0]!.notes[0]!.durationTicks = 5000;
    expect(validateScore(score).errors.join(" ")).toMatch(
      /loop: invalid bounds/,
    );
    expect(validateScore(score).errors.join(" ")).toMatch(/exceeds pattern/);
  });
});
