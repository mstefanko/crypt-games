import { describe, expect, it } from "vitest";
import { createBlankScore, createStarter } from "@onepage/project";
import { compileScore, secondsToTicks, ticksToSeconds } from "./index";
describe("musical time", () => {
  it("converts exactly and preserves fractional ticks", () => {
    expect(ticksToSeconds(3120, 120)).toBe(3.25);
    expect(secondsToTicks(3.25, 120)).toBe(3120);
    expect(secondsToTicks(0.001, 120)).toBeCloseTo(0.96, 12);
    expect(() => ticksToSeconds(1, 0)).toThrow();
  });
});
describe("score compiler", () => {
  it("expands repeats, transposes, clips half-open windows and preserves absolute time", () => {
    const score = createBlankScore();
    score.patterns[0]!.lengthTicks = 960;
    score.patterns[0]!.notes = [
      { id: "n", startTick: 0, durationTicks: 720, pitch: 60, velocity: 0.8 },
    ];
    score.clips[0]!.repeats = 4;
    score.clips[0]!.transpose = 2;
    const notes = compileScore(score, { startTick: 480, endTick: 1200 });
    expect(notes.map((n) => [n.startTick, n.durationTicks, n.pitch])).toEqual([
      [480, 240, 62],
      [960, 240, 62],
    ]);
    expect(new Set(notes.map((n) => n.id)).size).toBe(2);
    expect(compileScore(score, { startTick: 720, endTick: 960 })).toEqual([]);
  });
  it("applies minimum energy inclusively", () => {
    const score = createStarter();
    expect(
      compileScore(score, { energy: 2 }).some((n) => n.trackId === "drums"),
    ).toBe(false);
    expect(
      compileScore(score, { energy: 3 }).some((n) => n.trackId === "drums"),
    ).toBe(true);
  });
  it("rejects invalid score and windows before compilation", () => {
    const score = createStarter();
    expect(() => compileScore(score, { energy: NaN })).toThrow();
    expect(() =>
      compileScore(score, { endTick: score.lengthTicks + 1 }),
    ).toThrow();
    score.clips[0]!.patternId = "absent";
    expect(() => compileScore(score)).toThrow(/missing pattern/);
  });
});
