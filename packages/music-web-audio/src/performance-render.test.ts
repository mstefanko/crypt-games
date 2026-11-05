import { afterEach, expect, it, vi } from "vitest";
import { createBarFixtureScore } from "@onepage/music-core/bar-planner";
import type { PerformanceTake } from "@onepage/music-core/performance";
import { renderPerformanceTake } from "./performance-render";

// Inspect role automation directly, independently of the real shared synth.
vi.mock("./index", () => ({ renderPerformanceVoice: vi.fn() }));
class Parameter {
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
}
class OfflineContext {
  static instances: OfflineContext[] = [];
  destination = {};
  buses: { gain: Parameter; connect: ReturnType<typeof vi.fn> }[] = [];
  constructor(..._args: unknown[]) {
    OfflineContext.instances.push(this);
  }
  createGain() {
    const bus = { gain: new Parameter(), connect: vi.fn() };
    this.buses.push(bus);
    return bus;
  }
  startRendering = vi.fn(async () => ({ duration: 8 }) as AudioBuffer);
}
function fixture(): PerformanceTake {
  const score = createBarFixtureScore();
  return {
    version: 1,
    id: "render-test",
    bpm: 120,
    ppq: 480,
    lengthTicks: 7680,
    tracks: score.tracks,
    patches: score.patches,
    notes: [],
    automation: [],
    deviations: [],
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  OfflineContext.instances = [];
});
it("rejects an over-capacity passage before constructing an offline context", async () => {
  vi.stubGlobal("OfflineAudioContext", OfflineContext);
  const take = fixture(),
    track = take.tracks[0]!;
  take.notes = Array.from({ length: 257 }, (_, i) => ({
    id: `n${i}`,
    trackId: track.id,
    patchId: track.patchId,
    startTick: 480,
    durationTicks: 960,
    pitch: 60,
    velocity: 0.5,
    gain: track.gain,
    pan: track.pan,
    priority: 100,
    optional: false,
  }));
  await expect(renderPerformanceTake(take)).rejects.toThrow(/voice budget/);
  expect(OfflineContext.instances).toHaveLength(0);
});
it("truncates an interrupted ramp at its actual value and starts the next ramp there", async () => {
  vi.stubGlobal("OfflineAudioContext", OfflineContext);
  const take = fixture();
  take.automation = [
    { id: "down", role: "melody", timeSeconds: 0, value: 0, rampSeconds: 2 },
    { id: "up", role: "melody", timeSeconds: 1, value: 1, rampSeconds: 1 },
  ];
  await renderPerformanceTake(take);
  const gain = OfflineContext.instances[0]!.buses[0]!.gain;
  expect(gain.linearRampToValueAtTime.mock.calls).toEqual([
    [0.5, 1],
    [1, 2],
  ]);
  expect(gain.setValueAtTime.mock.calls).toEqual([
    [1, 0],
    [1, 0],
    [0.5, 1],
  ]);
});
it("requires explicit planned rendering for execution gaps before allocation", async () => {
  vi.stubGlobal("OfflineAudioContext", OfflineContext);
  const take = fixture();
  take.deviations = [
    { kind: "underrun", timeSeconds: 1, reason: "lost output" },
  ];
  await expect(renderPerformanceTake(take)).rejects.toThrow(/deviations/);
  expect(OfflineContext.instances).toHaveLength(0);
  await renderPerformanceTake(take, { mode: "planned" });
  expect(OfflineContext.instances).toHaveLength(1);
});

it("renders captured note identities through the selected instrument and cleans up after rendering", async () => {
  vi.stubGlobal("OfflineAudioContext", OfflineContext);
  const take = fixture(),
    track = take.tracks[0]!;
  take.notes = [
    {
      id: "captured-note-identity",
      trackId: track.id,
      patchId: track.patchId,
      startTick: 0,
      durationTicks: 120,
      pitch: 67,
      velocity: 0.4,
      gain: track.gain,
      pan: track.pan,
      priority: 100,
      optional: false,
    },
  ];
  const renderer = {
    id: "test-instrument",
    maxVoices: 2,
    releaseSeconds: () => 1,
    prepareContext: vi.fn(async (_context: BaseAudioContext) => {}),
    releaseContext: vi.fn(),
    renderVoice: vi.fn(() => ({ stop: vi.fn(), end: 1.125 })),
  };
  await renderPerformanceTake(take, { voiceRenderer: renderer });
  const ctx = OfflineContext.instances[0];
  expect(renderer.prepareContext).toHaveBeenCalledWith(ctx);
  expect(renderer.renderVoice).toHaveBeenCalledOnce();
  expect((renderer.renderVoice.mock.calls as unknown[][])[0].slice(3)).toEqual([
    67,
    0.4,
    0,
    0.125,
    track.gain,
    track.pan,
    "captured-note-identity",
  ]);
  expect(renderer.releaseContext).toHaveBeenCalledExactlyOnceWith(ctx);
  expect(renderer.prepareContext.mock.invocationCallOrder[0]).toBeLessThan(
    renderer.renderVoice.mock.invocationCallOrder[0],
  );
  expect(renderer.renderVoice.mock.invocationCallOrder[0]).toBeLessThan(
    renderer.releaseContext.mock.invocationCallOrder[0],
  );
});

it("checks custom release tails against instrument capacity before allocating offline resources", async () => {
  vi.stubGlobal("OfflineAudioContext", OfflineContext);
  const take = fixture(),
    track = take.tracks[0]!;
  take.patches.find((p) => p.id === track.patchId)!.release = 0.005;
  const note = {
    id: "first",
    trackId: track.id,
    patchId: track.patchId,
    startTick: 0,
    durationTicks: 120,
    pitch: 60,
    velocity: 0.4,
    gain: track.gain,
    pan: track.pan,
    priority: 100,
    optional: false,
  };
  take.notes = [note, { ...note, id: "second", startTick: 960 }];
  const renderer = {
    id: "long-tail",
    maxVoices: 1,
    releaseSeconds: () => 2,
    prepareContext: vi.fn(async () => {}),
    releaseContext: vi.fn(),
    renderVoice: vi.fn(() => ({ stop: vi.fn(), end: 3 })),
  };
  await expect(
    renderPerformanceTake(take, { voiceRenderer: renderer }),
  ).rejects.toThrow(/voice budget/);
  expect(OfflineContext.instances).toHaveLength(0);
  expect(renderer.prepareContext).not.toHaveBeenCalled();
  expect(renderer.renderVoice).not.toHaveBeenCalled();
});

it("releases offline instrument resources when voice rendering fails", async () => {
  vi.stubGlobal("OfflineAudioContext", OfflineContext);
  const take = fixture(),
    track = take.tracks[0]!;
  take.notes = [
    {
      id: "failure",
      trackId: track.id,
      patchId: track.patchId,
      startTick: 0,
      durationTicks: 120,
      pitch: 60,
      velocity: 0.4,
      gain: track.gain,
      pan: track.pan,
      priority: 100,
      optional: false,
    },
  ];
  const renderer = {
    id: "failing",
    releaseSeconds: () => 0.1,
    releaseContext: vi.fn(),
    renderVoice: vi.fn(() => {
      throw Error("instrument failed");
    }),
  };
  await expect(
    renderPerformanceTake(take, { voiceRenderer: renderer }),
  ).rejects.toThrow("instrument failed");
  expect(renderer.releaseContext).toHaveBeenCalledExactlyOnceWith(
    OfflineContext.instances[0],
  );
});

it("rejects unbound or mismatching acoustic palettes before context allocation", async () => {
  vi.stubGlobal("OfflineAudioContext", OfflineContext);
  const { WEATHER_INSTRUMENT_PALETTE: palette } = await import("@onepage/music-core/instrument-palette");
  const { WEATHER_TRACKS, WEATHER_PATCHES } = await import("@onepage/music-core/orchestration");
  const take: PerformanceTake = { ...fixture(), version: 2, tracks: structuredClone(WEATHER_TRACKS), patches: structuredClone(WEATHER_PATCHES), acoustic: {palette, renderingProfile: palette.profile.id}, timeline: [{tick:0,tonic:0,mode:"ionian",ensemble:"light",partIds:["melody-flute"]}] };
  const renderer = { id: "unbound", releaseSeconds: () => .3, prepareContext: vi.fn(async () => {}), renderVoice: vi.fn() };
  for (const voiceRenderer of [renderer, {...renderer,paletteIdentity:{id:palette.id,hash:"0".repeat(64)}}, {...renderer,paletteIdentity:{id:"other-palette",hash:palette.hash}}]) {
    await expect(renderPerformanceTake(take, {voiceRenderer})).rejects.toThrow(/palette identity/);
  }
  expect(OfflineContext.instances).toHaveLength(0);
  expect(renderer.prepareContext).not.toHaveBeenCalled();
  expect(renderer.renderVoice).not.toHaveBeenCalled();
  await renderPerformanceTake(take, {voiceRenderer: {...renderer,paletteIdentity:{id:palette.id,hash:palette.hash}}});
  expect(renderer.prepareContext).toHaveBeenCalledOnce();
  await renderPerformanceTake(take, {voiceRenderer:null});
  expect(OfflineContext.instances).toHaveLength(2);
});
