import { expect, it, vi } from "vitest";
import scores from "./exploration-music.json";
import { AdaptiveMusic, type MusicArrangements } from "./adaptive-music.ts";
import { explorationMusicState } from "./exploration-audio.ts";
const arrangements = scores as unknown as MusicArrangements;
it("coalesces paused decisions, replaces queued A→B→A and cancels to baseline", () => {
  const apply = vi.fn(),
    music = new AdaptiveMusic(arrangements, apply);
  music.request("high");
  music.request("low");
  music.request("high");
  expect(apply).toHaveBeenCalledTimes(1);
  music.resume();
  expect(apply).toHaveBeenLastCalledWith(arrangements.high, 2);
  expect(music.request("high")).toBe(false);
  music.cancel();
  expect(apply).toHaveBeenLastCalledWith(arrangements.low, 1);
  music.request("high");
  music.request("low");
  expect(apply).toHaveBeenLastCalledWith(arrangements.low, 1);
  expect(music.snapshot()).toEqual({ version: 1, state: "low" });
});
it("restores only bounded intent, validates atomically and never replays disposed work", () => {
  const apply = vi.fn(),
    music = new AdaptiveMusic(arrangements, apply);
  music.restore({ version: 1, state: "high" });
  const before = music.snapshot();
  expect(() => music.restore({ version: 2, state: "bad" } as never)).toThrow();
  expect(music.snapshot()).toEqual(before);
  music.resume();
  music.pause();
  music.request("low");
  music.dispose();
  const count = apply.mock.calls.length;
  music.resume();
  music.restore(before);
  music.request("high");
  expect(apply).toHaveBeenCalledTimes(count);
});
it("rejects incompatible arrangements before publishing and snapshots inputs", () => {
  const bad = structuredClone(arrangements);
  bad.high.bpm++;
  const apply = vi.fn();
  expect(() => new AdaptiveMusic(bad, apply)).toThrow(/share/);
  expect(apply).not.toHaveBeenCalled();
  const source = structuredClone(arrangements),
    music = new AdaptiveMusic(source, apply);
  source.high.bpm++;
  music.request("high");
  music.resume();
  expect(apply.mock.lastCall![0].bpm).toBe(arrangements.high.bpm);
});
it("derives music from living enemies without mutating observation or save bytes", () => {
  const observation = {
    platform: { status: "playing", actors: [{ team: 1, health: 1 }] },
  };
  const before = JSON.stringify(observation);
  expect(explorationMusicState(observation)).toBe("high");
  expect(JSON.stringify(observation)).toBe(before);
  observation.platform.actors[0].health = 0;
  expect(explorationMusicState(observation)).toBe("low");
  observation.platform.actors[0].health = 1;
  observation.platform.status = "lost";
  expect(explorationMusicState(observation)).toBe("low");
});

it("rejects energy-gated banks before publication so queued changes cannot cut current-loop voices", () => {
  for (const state of ["low", "high"] as const) {
    const bank = structuredClone(arrangements);
    bank[state].tracks[0].minEnergy = 2;
    const apply = vi.fn();
    expect(() => new AdaptiveMusic(bank, apply)).toThrow(/minEnergy 1/);
    expect(apply).not.toHaveBeenCalled();
  }
});
