import { afterEach, describe, expect, it, vi } from "vitest";
import { createBlankScore, assertScore } from "@onepage/project";
import { assertPlayableScore } from "../../music-core/src/score-validation";
import { WEATHER_LOW_FOUNDATION_PATCH as patch } from "../../music-core/src/orchestration";
import { WEATHER_SONG_V2_INSTRUMENT_PALETTE as palette } from "../../music-core/src/instrument-palette";
import { renderPerformanceVoice } from "./index";
import { createNativeInstrumentRenderer } from "./native-instrument-renderer";
import { SoundfontInstrumentRenderer } from "./soundfont-instrument-renderer";
const parameter = () => ({
  value: 0,
  setValueAtTime: vi.fn(),
  linearRampToValueAtTime: vi.fn(),
  cancelScheduledValues: vi.fn(),
});
const node = () => ({
  gain: parameter(),
  frequency: parameter(),
  pan: parameter(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  setPeriodicWave: vi.fn(),
  onended: null,
});
function context() {
  const sources: ReturnType<typeof node>[] = [],
    panners: ReturnType<typeof node>[] = [];
  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    createGain: node,
    createStereoPanner: () => {
      const n = node();
      panners.push(n);
      return n;
    },
    createBiquadFilter: node,
    createPeriodicWave: vi.fn(() => ({})),
    createOscillator: () => {
      const n = node();
      sources.push(n);
      return n;
    },
  };
  return {
    ctx: ctx as unknown as BaseAudioContext,
    sources,
    panners,
    wave: ctx.createPeriodicWave,
  };
}
afterEach(() => vi.unstubAllGlobals());
describe("explicit harmonic bass", () => {
  it("accepts the generic patch through both authoring and playback validators", () => {
    const score = createBlankScore();
    score.patches[0] = { ...patch, id: score.patches[0].id };
    expect(() => assertScore(score)).not.toThrow();
    expect(() => assertPlayableScore(score)).not.toThrow();
  });
  it("uses a centered phase-coherent single oscillator and includes the release in voice lifetime", () => {
    const { ctx, sources, panners, wave } = context();
    const voice = renderPerformanceVoice(
      ctx,
      {} as AudioNode,
      patch,
      29,
      0.57,
      1,
      3,
      0.62,
      0.8,
    );
    expect(sources).toHaveLength(1);
    expect(panners[0].pan.value).toBe(0);
    const call = wave.mock.calls[0] as unknown as [
      Float32Array,
      Float32Array,
      PeriodicWaveOptions,
    ];
    expect(call[1][1]).toBeCloseTo(0.8);
    expect(call[1][2]).toBeCloseTo((0.2 * 8) / Math.PI ** 2);
    expect(call[2].disableNormalization).toBe(true);
    expect(voice.end).toBe(4.3);
    expect(sources[0].stop).toHaveBeenCalledWith(4.3);
    voice.fadeStop?.(2, 0.08);
    expect(sources[0].stop).toHaveBeenLastCalledWith(2.08);
    voice.stop(2.1);
    expect(sources[0].stop).toHaveBeenLastCalledWith(2.1);
  });
  it("explicitly uses identical synthesis in native and SoundFont routes without sample substitution", async () => {
    vi.stubGlobal("OfflineAudioContext", class {});
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const onlySynth = {
      ...palette,
      bindings: palette.bindings.filter((b) => b.rendering === "synth"),
    };
    const capabilities = {
      instruments: [],
      maxVoices: 32,
      maxTailSeconds: 0.3,
      native: true,
      offline: true,
    };
    const native = await createNativeInstrumentRenderer({
      palette: onlySynth,
      sampleSets: [],
      capabilities,
    });
    const sf = new SoundfontInstrumentRenderer({
      id: "hybrid-test",
      palette: onlySynth,
      capabilities: { ...capabilities, native: false },
      bankUrl: "/no-bank",
      bankSha256: "0".repeat(64),
      workletUrl: "/none",
      worklets: 2,
    });
    for (const renderer of [native, sf]) {
      const c = context();
      const voice = renderer.renderVoice(
        c.ctx,
        {} as AudioNode,
        patch,
        36,
        0.57,
        0,
        2.5,
        0.35,
        0,
      );
      expect(c.sources).toHaveLength(1);
      expect(c.wave).toHaveBeenCalledOnce();
      expect(voice.end).toBe(2.8);
      expect(renderer.releaseSeconds(patch)).toBe(0.3);
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(native.memoryDiagnostics?.().decodedSampleCount).toBe(0);
  });
});
