import { describe, it, expect } from "vitest";
import {
  createTonalContext,
  MODE_INTERVALS,
  scalePitchClasses,
  MODE_CHARACTERISTIC_DEGREE,
  degreePitch,
  type ModeId,
} from "./tonality";
import { harmonicChords } from "./harmonic-grammar";
import {
  composeWeatherBar,
  createWeatherComposerCheckpoint,
  type ComposerWeatherObservation,
} from "./legacy-weather-chamber-6/weather-composer";
import { WEATHER_TRACKS } from "./orchestration";
import { weatherMusicalIntent } from "./weather-intent";
const clear: ComposerWeatherObservation = {
  id: "clear",
  front: "clear",
  intensity: 0.5,
  precipitation: 0,
  gustiness: 0.7,
};
const storm: ComposerWeatherObservation = {
  ...clear,
  id: "storm",
  stormStrength: 0.8,
  precipitation: 0.7,
};
const role = (id: string) => WEATHER_TRACKS.find((t) => t.id === id)?.role;
describe("modal weather composition", () => {
  it("transposes every collection and chord over all twelve tonics with explicit minor V alteration", () => {
    for (const mode of Object.keys(MODE_INTERVALS) as ModeId[])
      for (let tonic = 0; tonic < 12; tonic++) {
        const c = createTonalContext(mode, tonic);
        expect(scalePitchClasses(c)).toEqual(
          MODE_INTERVALS[mode].map((n) => (n + tonic) % 12),
        );
        expect(harmonicChords(c)[0]).toEqual(
          [0, 2, 4].map((d) => degreePitch(c, d) % 12),
        );
        if (mode === "aeolian")
          expect(harmonicChords(c)[2]).toContain((tonic + 11) % 12);
      }
  });
  it("keeps transposed parts playable and closes every four bars in the current tonic", () => {
    for (const mode of Object.keys(MODE_INTERVALS) as ModeId[])
      for (let tonic = 0; tonic < 12; tonic++) {
        let s = createWeatherComposerCheckpoint(19);
        for (let bar = 0; bar < 4; bar++) {
          const b = composeWeatherBar(s, clear, {
            lockedMode: mode,
            lockedEnsemble: "dark",
            tonic,
          });
          for (const note of b.events) {
            if (role(note.trackId) === "harmony")
              expect(note.pitch).toBeGreaterThanOrEqual(55);
            if (role(note.trackId) === "melody")
              expect(note.pitch).toBeLessThanOrEqual(79);
            expect(Number.isFinite(note.pitch)).toBe(true);
          }
          if (bar === 3) {
            expect(b.trace.choice).toBe(0);
            expect(b.checkpoint.obligation).toBeNull();
          }
          s = b.checkpoint;
        }
      }
  });
  it("keeps paired fixture rhythm, velocities and motif while changing pitches and parts independently", () => {
    const s = createWeatherComposerCheckpoint(91);
    const major = composeWeatherBar(s, clear, {
      lockedMode: "ionian",
      lockedEnsemble: "light",
    });
    const minor = composeWeatherBar(s, clear, {
      lockedMode: "aeolian",
      lockedEnsemble: "light",
    });
    expect(
      major.events.map((n) => [n.startTick, n.durationTicks, n.velocity]),
    ).toEqual(
      minor.events.map((n) => [n.startTick, n.durationTicks, n.velocity]),
    );
    expect(major.events.map((n) => n.pitch)).not.toEqual(
      minor.events.map((n) => n.pitch),
    );
    const dark = composeWeatherBar(s, clear, {
      lockedMode: "ionian",
      lockedEnsemble: "dark",
    });
    expect(
      dark.events.map((n) => [n.startTick, n.durationTicks, n.pitch]),
    ).toEqual(major.events.map((n) => [n.startTick, n.durationTicks, n.pitch]));
    expect(dark.events.map((n) => n.trackId)).not.toEqual(
      major.events.map((n) => n.trackId),
    );
    expect(s.tonalContext.mode).toBe("ionian");
  });
  it("exposes modal characteristic tones as bounded unaccented colors", () => {
    for (const mode of [
      "lydian",
      "mixolydian",
      "dorian",
      "aeolian",
    ] as ModeId[]) {
      const bar = composeWeatherBar(createWeatherComposerCheckpoint(8), clear, {
        lockedMode: mode,
      });
      const color =
        degreePitch(
          createTonalContext(mode),
          MODE_CHARACTERISTIC_DEGREE[mode],
        ) % 12;
      expect(
        bar.events
          .filter((n) => role(n.trackId) === "melody")
          .some((n) => n.pitch % 12 === color),
      ).toBe(true);
    }
  });
  it("qualifies weather ticks, bridges at a phrase boundary, preserves notes and commits after all old tails", () => {
    let s = createWeatherComposerCheckpoint(4);
    for (let bar = 0; bar < 4; bar++)
      s = composeWeatherBar(s, storm, { simulationTick: bar * 120 }).checkpoint;
    expect(s.tonalContext.mode).toBe("ionian");
    const before = structuredClone(s);
    const bridge = composeWeatherBar(s, storm, { simulationTick: 480 });
    expect(s).toEqual(before);
    expect(bridge.checkpoint.tonalTransition?.transitionTick).toBe(4 * 1920);
    expect(
      bridge.events
        .filter((n) => role(n.trackId) !== "drums")
        .every((n) => [0, 7].includes(n.pitch % 12)),
    ).toBe(true);
    const incoming = composeWeatherBar(bridge.checkpoint, storm, {
      simulationTick: 600,
    });
    expect(incoming.checkpoint.tonalContext.mode).toBe("aeolian");
    expect(incoming.checkpoint.ensemble).toBe("dark");
    expect(
      before.releaseTails.every(
        (n) => n.startTick + n.durationTicks + 960 <= incoming.bar * 1920,
      ),
    ).toBe(true);
    expect(
      incoming.events.every((n) =>
        WEATHER_TRACKS.some(
          (t) => t.id === n.trackId && t.patchId === n.patchId,
        ),
      ),
    ).toBe(true);
  });
  it("prioritizes storm and separates quiet fog from active clear weather and heat", () => {
    expect(weatherMusicalIntent({ ...storm, thermalBand: "hot" }).mode).toBe(
      "aeolian",
    );
    expect(weatherMusicalIntent({ ...clear, thermalBand: "hot" }).mode).toBe(
      "mixolydian",
    );
    const fog = weatherMusicalIntent({
      ...clear,
      intensity: 0,
      gustiness: 0,
      fog: 0.8,
    });
    const bright = weatherMusicalIntent(clear);
    expect(fog.activity).toBeLessThan(bright.activity);
    expect(fog.brightness).toBeLessThan(bright.brightness);
  });
  it("does not admit oscillating weather or a held pending transition; fallbacks retain committed mode", () => {
    let s = createWeatherComposerCheckpoint(3);
    for (let bar = 0; bar < 16; bar++)
      s = composeWeatherBar(s, bar % 2 ? clear : storm, {
        simulationTick: bar * 60,
      }).checkpoint;
    expect(s.tonalContext.mode).toBe("ionian");
    const locked = composeWeatherBar(
      createWeatherComposerCheckpoint(3),
      clear,
      { lockedMode: "dorian" },
    ).checkpoint;
    const fallback = composeWeatherBar(locked, storm, {
      forceFallback: true,
      hold: true,
    });
    expect(fallback.checkpoint.tonalContext.mode).toBe("dorian");
  });
});
