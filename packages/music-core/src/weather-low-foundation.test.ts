import { describe, expect, it } from "vitest";
import {
  composeWeatherBar,
  createWeatherComposerCheckpoint,
} from "./weather-composer";
import * as frozenV1 from "./legacy-weather-song-1/weather-composer";
import {
  WEATHER_SONG_PATCHES,
  WEATHER_SONG_V2_PATCHES,
  WEATHER_SONG_V2_TRACKS,
} from "./orchestration";
import {
  WEATHER_SONG_INSTRUMENT_PALETTE,
  WEATHER_SONG_V2_INSTRUMENT_PALETTE,
} from "./instrument-palette";
import { StreamQueue } from "../../music-web-audio/src/stream";
const heavy = {
  id: "heavy",
  front: "cold" as const,
  intensity: 1,
  precipitation: 0,
  gustiness: 1,
  stormStrength: 1,
};
describe("versioned low foundation", () => {
  it("regenerates song v1 exactly through the frozen source and preserves old patch bytes", () => {
    let routed = createWeatherComposerCheckpoint(617, "weather-song-1");
    let frozen = frozenV1.createWeatherComposerCheckpoint(617);
    const trace: unknown[] = [];
    for (let i = 0; i < 100; i++) {
      const observation = {
        ...heavy,
        id: String(i),
        front: i % 2 ? ("warm" as const) : ("cold" as const),
      };
      const a = composeWeatherBar(routed, observation),
        b = frozenV1.composeWeatherBar(frozen, observation);
      expect(a).toEqual(b);
      trace.push(a);
      routed = a.checkpoint;
      frozen = b.checkpoint;
    }
    let hash = 2166136261;
    for (const c of JSON.stringify(trace))
      hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
    expect((hash >>> 0).toString(16)).toBe("cf63696d");
    expect(
      WEATHER_SONG_V2_PATCHES.slice(0, WEATHER_SONG_PATCHES.length),
    ).toEqual(WEATHER_SONG_PATCHES);
    expect(WEATHER_SONG_INSTRUMENT_PALETTE.id).toBe(
      "weather-orchestra-song-v1",
    );
    expect(
      WEATHER_SONG_INSTRUMENT_PALETTE.bindings.some(
        (b) => b.rendering === "synth",
      ),
    ).toBe(false);
  });
  it("counts the low part, qualifies register and tails and admits notes within the scheduler budget", () => {
    let state = createWeatherComposerCheckpoint(617),
      found = 0;
    const queue = new StreamQueue(1, {
      bpm: 120,
      tracks: WEATHER_SONG_V2_TRACKS,
      patches: WEATHER_SONG_V2_PATCHES,
      maxNoteDurationTicksByPatch: { "weather-timpani-hit": 5760 },
    });
    for (let bar = 0; bar < 150; bar++) {
      const b = composeWeatherBar(state, heavy);
      state = b.checkpoint;
      const meta = b.trace.song!,
        low = b.events.filter((n) => n.trackId === "bass-foundation");
      if (meta.weightTier === 0 || meta.feature) expect(low).toHaveLength(0);
      for (const n of low) {
        found++;
        expect(n.pitch).toBeGreaterThanOrEqual(29);
        expect(n.pitch).toBeLessThanOrEqual(43);
        expect(n.durationTicks).toBe(2880);
        expect(n.pan).toBe(0);
        expect(meta.actualParts).toBeGreaterThanOrEqual(
          new Set(b.events.map((n) => n.trackId)).size,
        );
      }
      const receipt = queue.submit({
        epoch: 1,
        revision: bar,
        id: "b:" + bar,
        startTick: bar * 1920,
        endTick: (bar + 1) * 1920,
        notes: b.events,
      });
      expect(receipt.status).toBe("accepted");
      queue.take((bar + 1) * 1920);
    }
    expect(found).toBeGreaterThan(4);
    const binding = WEATHER_SONG_V2_INSTRUMENT_PALETTE.bindings.find(
      (b) => b.rendering === "synth",
    )!;
    expect(binding.playable).toEqual([29, 43]);
    expect(binding.maxSustainSeconds).toBe(3);
  });
});
