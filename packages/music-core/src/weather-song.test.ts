import { describe, it, expect } from "vitest";
import {
  createWeatherComposerCheckpoint,
  composeWeatherBar,
  prepareWeatherBars,
  reviseWeatherBars,
  validateWeatherComposerCheckpoint,
  type WeatherComposedBar,
  type ComposerWeatherObservation,
} from "./weather-composer";
import { WEATHER_SONG_V2_TRACKS as WEATHER_SONG_TRACKS } from "./orchestration";
import {
  WEATHER_SONG_V2_INSTRUMENT_PALETTE as WEATHER_SONG_INSTRUMENT_PALETTE,
  paletteBinding,
} from "./instrument-palette";
import * as old from "./legacy-weather-chamber-6/weather-composer";
import * as oldWeather from "./legacy-weather-chamber-6/weather-model";
function groupBy<T, K>(items: T[], key: (value: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of items) {
    const k = key(value);
    groups.set(k, [...(groups.get(k) ?? []), value]);
  }
  return groups;
}
const calm: ComposerWeatherObservation = {
  id: "clear",
  front: "clear",
  intensity: 0.2,
  precipitation: 0,
  gustiness: 0,
};
function run(
  seed: number,
  count: number,
  observation = (bar: number) => ({ ...calm, id: `clear:${bar}` }),
) {
  let state = createWeatherComposerCheckpoint(seed);
  const bars: WeatherComposedBar[] = [];
  for (let bar = 0; bar < count; bar++) {
    const result = composeWeatherBar(state, observation(bar));
    bars.push(result);
    state = result.checkpoint;
  }
  return bars;
}
describe("versioned weather song form", () => {
  it("realizes alternating complete 48/52-bar forms and guaranteed long features under reversals", () => {
    const bars = run(33, 300, (bar) => ({
      ...calm,
      id: `weather:${bar}`,
      front: bar % 2 ? "cold" : "warm",
      stormStrength: bar % 2 ? 0.8 : 0,
      fog: bar % 3 ? 0 : 0.8,
    }));
    const songs = groupBy(bars, (b) => b.trace.song!.songIndex);
    for (const song of [...songs.values()].slice(0, -1)) {
      const meta = song[0]!.trace.song!;
      expect(song.length).toBe(meta.template === "A" ? 48 : 52);
      const feature = song.filter((b) => b.trace.song!.feature);
      expect(feature.length).toBe(meta.template === "A" ? 8 : 12);
      expect(
        feature.every((b) =>
          b.events.some((n) => n.trackId.startsWith("melody-")),
        ),
      ).toBe(true);
      expect(feature[3]!.trace.song!.closure).toBe("open");
      expect(feature[3]!.trace.arrival).toBe(false);
      if (feature.length === 12)
        expect(
          feature
            .slice(0, 10)
            .every((b) => !b.trace.resolution && b.trace.choice !== 4),
        ).toBe(true);
    }
    expect(JSON.stringify(bars)).toBe(
      JSON.stringify(
        run(33, 300, (bar) => ({
          ...calm,
          id: `weather:${bar}`,
          front: bar % 2 ? "cold" : "warm",
          stormStrength: bar % 2 ? 0.8 : 0,
          fog: bar % 3 ? 0 : 0.8,
        })),
      ),
    );
  });
  it("repeats complete exact hooks before variation, persists 2–3 songs and meets start gap", () => {
    const bars = run(9, 300);
    const starts = bars.filter((b) => b.trace.song!.hookStatementStart);
    expect(starts[0]!.bar).toBe(12);
    expect(
      Math.max(...starts.slice(1).map((b, i) => b.bar - starts[i]!.bar)),
    ).toBeLessThanOrEqual(30);
    const statements = starts.map((b) => ({
      id: b.trace.song!.hookId,
      notes: bars
        .slice(b.bar, b.bar + 4)
        .flatMap((x) =>
          x.events
            .filter((n) => n.trackId.startsWith("melody-"))
            .map((n) => [n.startTick - b.bar * 1920, n.durationTicks, n.pitch]),
        ),
    }));
    for (const group of groupBy(statements, (s) => s.id).values()) {
      for (const statement of group)
        expect(statement.notes).toEqual(group[0]!.notes);
    }
    const songStarts = bars.filter((b) => b.trace.song!.songBar === 0);
    const lifetime = [
      ...groupBy(songStarts, (b) => b.trace.song!.hookId).values(),
    ];
    for (const group of lifetime.slice(0, -1))
      expect(group.length).toBeGreaterThanOrEqual(2);
  });
  it("keeps prepared revision inside the two-bar uncommitted suffix", () => {
    const state = createWeatherComposerCheckpoint(2),
      before = structuredClone(state);
    const prepared = prepareWeatherBars(state, [calm, calm]);
    const revised = reviseWeatherBars(prepared, 1, [
      { ...calm, id: "revised", stormStrength: 1 },
    ]);
    expect(revised.bars[0]).toEqual(prepared.bars[0]);
    expect(state).toEqual(before);
    expect(() => reviseWeatherBars(prepared, 0, [calm, calm, calm])).toThrow();
  });
  it("records missed safety features and repays debt at the next completed slot", () => {
    let state = createWeatherComposerCheckpoint(4);
    let interrupted = false,
      paid = false;
    for (let i = 0; i < 110; i++) {
      const feature =
        state.song!.songBar >= 28 &&
        state.song!.songBar < 30 &&
        state.song!.songIndex === 0;
      const b = composeWeatherBar(
        state,
        calm,
        feature ? { forceFallback: true } : {},
      );
      state = b.checkpoint;
      if (feature) {
        interrupted = true;
        expect(state.song!.soloDebt).toBe(1);
        expect(state.song!.debtDeadlineSong).toBe(1);
      }
      if (state.song!.songIndex === 1 && state.song!.featureCompleted) {
        paid = true;
        expect(state.song!.soloDebt).toBe(0);
      }
    }
    expect(interrupted && paid).toBe(true);
  });
  it("bounds state and rejects malicious/unknown checkpoints", () => {
    const state = run(5, 1000).at(-1)!.checkpoint;
    expect(state.song!.history.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(state).length).toBeLessThan(12000);
    expect(() =>
      validateWeatherComposerCheckpoint({
        ...state,
        version: "unknown",
      } as never),
    ).toThrow();
    state.song!.hook.notes[0]!.pitch = NaN;
    expect(() => composeWeatherBar(state, calm)).toThrow();
  });
  it("defers reversing requests to a settled authored exit and emits bounded connecting gestures", () => {
    let state = createWeatherComposerCheckpoint(8);
    for (let i = 0; i < 4; i++)
      state = composeWeatherBar(state, {
        ...calm,
        stormStrength: 1,
      }).checkpoint;
    const entering = composeWeatherBar(state, { ...calm, stormStrength: 1 });
    expect(entering.trace.song!.sectionBar).toBe(0);
    expect(entering.trace.transition?.tailPolicy).toBe("preserve");
    expect(entering.checkpoint.ensemble).toBe("dark");
    const reversed = composeWeatherBar(entering.checkpoint, calm);
    expect(reversed.checkpoint.ensemble).toBe("dark");
    expect(reversed.checkpoint.song!.pendingRequest?.sinceBar).toBe(5);
    const verseExit = run(8, 8)[7]!;
    expect(verseExit.events.some((n) => n.startTick % 1920 === 1680)).toBe(
      true,
    );
  });
  it("reports incomplete interrupted hooks and discharges a committed harmonic obligation", () => {
    let state = run(3, 12).at(-1)!.checkpoint;
    state = composeWeatherBar(state, calm, { forceFallback: true }).checkpoint;
    for (let i = 0; i < 2; i++)
      state = composeWeatherBar(state, calm).checkpoint;
    expect(
      composeWeatherBar(state, calm).trace.song!.hookStatementComplete,
    ).toBe(false);
    state.obligation = {
      kind: "dominant-to-tonic",
      createdBar: state.bar - 1,
      deadlineBar: state.bar,
    };
    const resolved = composeWeatherBar(state, calm);
    expect(resolved.trace.resolution).toBe(true);
    expect(resolved.trace.choice).toBe(0);
    expect(resolved.checkpoint.obligation).toBeNull();
  });
  it("uses qualified ranges/durations and independently bound percussion in dry heavy weather", () => {
    const bars = run(61, 104, (bar) => ({
      ...calm,
      id: `dry-heavy:${bar}`,
      stormStrength: 1,
    }));
    expect(
      bars.some((b) => b.events.some((n) => n.trackId === "drums-snare")),
    ).toBe(true);
    expect(
      bars.some((b) => b.events.some((n) => n.trackId === "drums-hat")),
    ).toBe(true);
    expect(
      bars.some(
        (b) =>
          b.trace.song!.feature &&
          b.events.some((n) => n.trackId === "melody-bassoon"),
      ),
    ).toBe(true);
    for (const bar of bars)
      for (const note of bar.events) {
        const track = WEATHER_SONG_TRACKS.find((t) => t.id === note.trackId)!;
        const binding = paletteBinding(
          WEATHER_SONG_INSTRUMENT_PALETTE,
          track.patchId,
        );
        expect(note.pitch).toBeGreaterThanOrEqual(binding.playable[0]);
        expect(note.pitch).toBeLessThanOrEqual(binding.playable[1]);
        expect(note.durationTicks / 960).toBeLessThanOrEqual(
          binding.maxSustainSeconds,
        );
      }
  });
  it("commits only two bars of onsets while preserving a qualified natural timpani tail across revisions", () => {
    const storm = { ...calm, stormStrength: 1, precipitation: 0.8 };
    let state = createWeatherComposerCheckpoint(19);
    for (let i = 0; i < 4; i++)
      state = composeWeatherBar(state, storm).checkpoint;
    const prepared = prepareWeatherBars(state, [storm, storm]);
    const hit = prepared.bars[0]!.events.find(
      (n) => n.trackId === "drums-timpani",
    )!;
    expect(hit.durationTicks).toBe(5376);
    expect(hit.startTick + hit.durationTicks).toBeGreaterThan(
      (state.bar + 2) * 1920,
    );
    expect(
      prepared.bars[1]!.checkpoint.tails.some((n) => n.id === hit.id),
    ).toBe(true);
    const revised = reviseWeatherBars(prepared, state.bar + 1, [calm]);
    expect(revised.bars[0]).toEqual(prepared.bars[0]);
    expect(revised.bars[1]!.checkpoint.tails.some((n) => n.id === hit.id)).toBe(
      true,
    );
    const carrying = composeWeatherBar(revised.bars[1]!.checkpoint, calm, {
      hold: true,
    });
    expect(carrying.events).toEqual([]);
    expect(carrying.arrangement.activeRoles).toContain("drums");
    expect(carrying.checkpoint.releaseTails.some((n) => n.id === hit.id)).toBe(
      false,
    );
    expect(() => prepareWeatherBars(state, [storm, storm, storm])).toThrow();
  });
  it("keeps a complete hook at one transposition when lock requests change inside its statement", () => {
    let state = run(23, 12).at(-1)!.checkpoint;
    const notes: number[][] = [];
    for (let i = 0; i < 4; i++) {
      const b = composeWeatherBar(state, calm, {
        tonic: i === 0 ? 5 : 11,
        lockedMode: i % 2 ? "phrygian" : "dorian",
      });
      state = b.checkpoint;
      notes.push(
        b.events
          .filter((n) => n.trackId.startsWith("melody-"))
          .map((n) => n.pitch),
      );
      expect(b.trace.song!.hookReturn).toBe("constant-transposition");
      expect(state.tonalContext.tonic).toBe(5);
      expect(state.tonalContext.mode).toBe(state.song!.hook.mode);
      if (i === 3) expect(b.trace.song!.hookStatementComplete).toBe(true);
    }
    expect(notes.flat()).toEqual(
      state.song!.hook.notes.map((n) => n.pitch + 5),
    );
  });
  it("does not roll debt deadlines forward or count an overdue debt more than once", () => {
    let state = createWeatherComposerCheckpoint(17);
    for (let i = 0; i < 204; i++) {
      const interrupt = state.song!.songIndex < 3 && state.song!.songBar === 28;
      state = composeWeatherBar(
        state,
        calm,
        interrupt ? { forceFallback: true } : {},
      ).checkpoint;
      if (state.song!.songIndex > 0 && state.song!.songIndex < 3)
        expect(state.song!.debtDeadlineSong).toBe(1);
    }
    expect(state.song!.missedFeatureDeadlines).toBe(1);
    expect(state.song!.soloDebt).toBe(0);
  });
  it.each([
    (s: ReturnType<typeof createWeatherComposerCheckpoint>) => {
      s.song!.arranger.activity = NaN;
    },
    (s: ReturnType<typeof createWeatherComposerCheckpoint>) => {
      s.song!.verse[1] = Infinity;
    },
    (s: ReturnType<typeof createWeatherComposerCheckpoint>) => {
      s.song!.hook.notes[2]!.bar = 0;
    },
    (s: ReturnType<typeof createWeatherComposerCheckpoint>) => {
      s.song!.feature = {
        startBar: 200,
        length: 12,
        phase: "answer",
        interrupted: false,
      };
    },
    (s: ReturnType<typeof createWeatherComposerCheckpoint>) => {
      s.song!.exit.maximumExtension = 8 as never;
    },
    (s: ReturnType<typeof createWeatherComposerCheckpoint>) => {
      s.song!.missedFeatureDeadlines = -1;
    },
  ])(
    "rejects malformed nested composer state before emitting notes",
    (mutate) => {
      const state = createWeatherComposerCheckpoint(17);
      mutate(state);
      expect(() => validateWeatherComposerCheckpoint(state)).toThrow();
    },
  );
  it("makes ambience-led policy actual fragments and composed silence without claiming solo or full hooks", () => {
    let state = createWeatherComposerCheckpoint(11);
    const bars: WeatherComposedBar[] = [];
    for (let i = 0; i < 60; i++) {
      const b = composeWeatherBar(
        state,
        { ...calm, stormStrength: 1, precipitation: 1 },
        { musicalPolicy: "ambience" },
      );
      state = b.checkpoint;
      bars.push(b);
    }
    expect(bars.filter((b) => b.events.length === 0).length).toBeGreaterThan(
      30,
    );
    expect(
      bars.every(
        (b) =>
          !b.trace.song!.feature &&
          !b.trace.song!.hookStatementComplete &&
          !b.trace.song!.hookStatementStart &&
          b.trace.song!.weightTier === 0,
      ),
    ).toBe(true);
    for (const b of bars.filter((b) => b.trace.song!.hookReturn === "fragment"))
      expect(b.events.some((n) => n.trackId.startsWith("melody-"))).toBe(true);
    expect(state.song!.soloDebt).toBe(0);
  });
  it("fits every locked tonic and ensemble with one whole-hook pitch displacement and unchanged rhythm", () => {
    for (const ensemble of ["light", "reflective", "dark", "earthy"] as const)
      for (let tonic = 0; tonic < 12; tonic++) {
        let state = run(23, 12).at(-1)!.checkpoint;
        const material = state.song!.hook.notes;
        const emitted: { pitch: number; offset: number; duration: number }[] =
          [];
        for (let i = 0; i < 4; i++) {
          const b = composeWeatherBar(state, calm, {
            tonic,
            lockedEnsemble: ensemble,
          });
          state = b.checkpoint;
          expect(["exact", "constant-transposition"]).toContain(
            b.trace.song!.hookReturn,
          );
          for (const n of b.events.filter((n) =>
            n.trackId.startsWith("melody-"),
          ))
            emitted.push({
              pitch: n.pitch,
              offset: n.startTick - 12 * 1920,
              duration: n.durationTicks,
            });
          if (i === 3) expect(b.trace.song!.hookStatementComplete).toBe(true);
        }
        expect(emitted.length).toBe(material.length);
        expect(
          new Set(emitted.map((n, i) => n.pitch - material[i]!.pitch)).size,
        ).toBe(1);
        expect(emitted.map((n) => [n.offset, n.duration])).toEqual(
          material.map((n) => [n.bar * 1920 + n.offset, n.duration]),
        );
      }
  });
  it("pins hook register and instrument through mid-statement changes and never scores a rejected reduced budget", () => {
    let state = run(5, 12).at(-1)!.checkpoint;
    const material = state.song!.hook.notes;
    const emitted: number[] = [];
    const tracks: string[] = [];
    for (let i = 0; i < 4; i++) {
      const b = composeWeatherBar(state, calm, {
        tonic: i === 0 ? 11 : 0,
        lockedEnsemble: i === 0 ? "dark" : "light",
        intent: { weight: 0 },
        maxEvents: 7,
      });
      expect(b.status).toBe("planned");
      state = b.checkpoint;
      for (const n of b.events.filter((n) => n.trackId.startsWith("melody-"))) {
        emitted.push(n.pitch);
        tracks.push(n.trackId);
      }
    }
    expect(
      new Set(emitted.map((pitch, i) => pitch - material[i]!.pitch)).size,
    ).toBe(1);
    expect(new Set(tracks).size).toBe(1);
    const rejected = composeWeatherBar(run(5, 12).at(-1)!.checkpoint, calm, {
      maxEvents: 1,
      tonic: 11,
      lockedEnsemble: "dark",
    });
    expect(rejected.status).toBe("resync-required");
    expect(rejected.events).toEqual([]);
    expect(rejected.trace.song!.hookStatementStart).toBe(false);
    expect(rejected.trace.song!.hookReturn).toBeNull();
  });
  it("preserves the frozen command-model and composer replay path", () => {
    let weather = oldWeather.createWeatherState(617),
      legacy = old.createWeatherComposerCheckpoint(617),
      routed = createWeatherComposerCheckpoint(617, "weather-chamber-6");
    const trace: unknown[] = [];
    for (let bar = 0; bar < 64; bar++) {
      for (let tick = 0; tick < 120; tick++)
        weather = oldWeather.stepWeather(
          weather,
          weather.tick === 240
            ? [{ tick: 240, type: "add-front", kind: "cold" }]
            : [],
        );
      const w = oldWeather.observeWeather(weather),
        a = old.composeWeatherBar(legacy, w),
        b = composeWeatherBar(routed, w);
      expect(b).toEqual(a);
      legacy = a.checkpoint;
      routed = b.checkpoint;
      trace.push(a);
    }
    let hash = 2166136261;
    for (const ch of JSON.stringify(trace))
      hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
    expect((hash >>> 0).toString(16)).toBe("954bf90e");
  });
});
