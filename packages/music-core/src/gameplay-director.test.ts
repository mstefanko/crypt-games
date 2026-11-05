import { expect, it } from "vitest";
import {
  GameplayMusicDirector,
  type GameplayMusicProfile,
} from "./gameplay-director";
const base = {
  bpm: 100,
  root: 60,
  scale: [0, 2, 4, 5, 7, 9, 11],
  motif: [0, 2, 4, 2],
};
const profile: GameplayMusicProfile = {
  id: "synthetic",
  theme: base,
  selectTheme: (intent, adaptive) =>
    adaptive && intent.identity === "alternate"
      ? { ...base, root: 62, motif: [4, 2, 1, 0] }
      : base,
};
it("keeps fixed comparison stable under changing intensity", () => {
  const d = new GameplayMusicDirector();
  const quiet = { identity: "home", intensity: 0, progress: 0 };
  expect(d.decide(profile, quiet, 0, false).tier).toBe(2);
  expect(d.decide(profile, { ...quiet, intensity: 1 }, 1, false).tier).toBe(2);
});
it("holds an arrangement for two bars and uses threshold hysteresis", () => {
  const d = new GameplayMusicDirector(),
    i = { identity: "flow", intensity: 1, progress: 0 };
  expect(d.decide(profile, i, 0).tier).toBe(3);
  expect(d.decide(profile, { ...i, intensity: 0 }, 1).tier).toBe(3);
  expect(d.decide(profile, { ...i, intensity: 0 }, 2).tier).toBe(1);
});
it("selects injected thematic content and supports profiles without selectors", () => {
  const d = new GameplayMusicDirector(),
    i = { identity: "alternate", intensity: 0.5, progress: 0 };
  expect(d.decide(profile, i, 0).theme.root).toBe(62);
  expect(d.decide(profile, i, 1, false).theme).toEqual(base);
  expect(d.decide({ id: "plain", theme: base }, i, 2).theme).toEqual(base);
});
