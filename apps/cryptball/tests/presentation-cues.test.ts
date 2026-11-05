import { it, expect, vi } from "vitest";
import { CryptballAudio } from "../src/audio";
import { createCryptballSession } from "../sim/session";
it("slide, save, block, perfect reflection and charged strike use distinct synth cues", () => {
  const audio = new CryptballAudio(() => {});
  const effect = vi.spyOn(audio.engine, "effect").mockImplementation(() => {});
  const state = createCryptballSession().observe();
  audio.tick(
    state,
    ["slide", "keeper-dive", "save", "block", "perfect-block", "strike", "power-bank"].map(
      (type, counter) => ({
        type,
        tick: state.tick,
        charge: type === "strike" ? 24 : 0,
        counter,
      }),
    ),
  );
  expect(effect.mock.calls.map((call) => call[1].id)).toEqual([
    "gator-scrape",
    "gator-scrape",
    "body-thud", "keeper-save",
    "body-thud",
    "body-thud", "owl-glass",
    "ball-strike",
    "ball-strike",
  ]);
  audio.engine.dispose();
});
