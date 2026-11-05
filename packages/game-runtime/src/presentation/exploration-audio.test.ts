import { expect, it, vi } from "vitest";
import scoreData from "../../../../examples/game-m2/score.json";
import { explorationAudio } from "./exploration-audio.ts";
import type { M2AudioEngine, Score } from "../m2-audio.ts";
function fake(enable = async () => {}) {
  return {
    currentTime: 0,
    enable: vi.fn(enable),
    play: vi.fn<M2AudioEngine["play"]>(async () => {}),
    setEnergy: vi.fn(),
    setVolume: vi.fn(),
    loadSample: vi.fn<NonNullable<M2AudioEngine["loadSample"]>>(
      async (_id: string, _bytes: ArrayBuffer) => 0.12,
    ),
    previewSample: vi.fn<NonNullable<M2AudioEngine["previewSample"]>>(() =>
      vi.fn(),
    ),
    previewNote: vi.fn<M2AudioEngine["previewNote"]>(() => vi.fn()),
    stop: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
}
it("uses live device gain without transport restarts and retains gesture/mute/disposal", async () => {
  const device = fake(),
    { audio, setVolume } = explorationAudio(
      scoreData as Score,
      vi.fn(),
      device,
    );
  setVolume(0);
  await audio.resume();
  expect(device.play).not.toHaveBeenCalled();
  await audio.unlock();
  expect(device.setVolume).toHaveBeenLastCalledWith(0);
  const startsBeforeVolume = device.play.mock.calls.length;
  const stopsBeforeVolume = device.stop.mock.calls.length;
  for (const value of [0.1, 0.6, 1, 0]) setVolume(value);
  expect(device.play).toHaveBeenCalledTimes(startsBeforeVolume);
  expect(device.stop).toHaveBeenCalledTimes(stopsBeforeVolume);
  audio.effect("one", scoreData.patches[0] as Score["patches"][number], 64);
  expect(device.previewNote).toHaveBeenCalledOnce();
  audio.setMuted(true);
  const starts = device.play.mock.calls.length;
  await audio.resume();
  expect(device.play).toHaveBeenCalledTimes(starts);
  await audio.dispose();
  expect(device.dispose).toHaveBeenCalledOnce();
});
it("pause while unlocking never starts playback after asynchronous completion", async () => {
  let resolve!: () => void;
  const device = fake(
    () =>
      new Promise<void>((r) => {
        resolve = r;
      }),
  );
  const { audio } = explorationAudio(scoreData as Score, vi.fn(), device);
  await audio.resume();
  const unlock = audio.unlock();
  audio.pause();
  resolve();
  await unlock;
  expect(device.play).not.toHaveBeenCalled();
  await audio.dispose();
});

it("decoded selected strikes share transient deduplication, capacity, mute and reset ownership", async () => {
  const device = fake();
  const { audio, setVolume } = explorationAudio(
    scoreData as Score,
    vi.fn(),
    device,
  );
  audio.sampleEffect("early", "beacon-strike", 0);
  expect(device.previewSample).not.toHaveBeenCalled();
  await audio.resume();
  await audio.unlock();
  expect(device.loadSample).toHaveBeenCalledOnce();
  expect(device.loadSample.mock.calls[0][1].byteLength).toBe(1964);
  audio.sampleEffect("one", "beacon-strike", 1);
  audio.sampleEffect("one", "beacon-strike", 1);
  expect(device.previewSample).toHaveBeenCalledOnce();
  setVolume(0);
  expect(device.setVolume).toHaveBeenLastCalledWith(0);
  for (let i = 0; i < 40; i++)
    audio.sampleEffect(`cue-${i}`, "beacon-strike", 2);
  expect(device.previewSample).toHaveBeenCalledTimes(32);
  expect(audio.stats().capacityDropped).toBe(9);
  audio.reset(4);
  audio.sampleEffect("suppressed", "beacon-strike", 4);
  audio.pause();
  audio.sampleEffect("paused", "beacon-strike", 5);
  audio.setMuted(true);
  await audio.resume();
  audio.sampleEffect("muted", "beacon-strike", 6);
  expect(device.previewSample).toHaveBeenCalledTimes(32);
  await audio.dispose();
  audio.sampleEffect("disposed", "beacon-strike", 7);
  expect(device.previewSample).toHaveBeenCalledTimes(32);
});
it("late decode after pause never starts music or replays a dropped strike; disposal ignores decode failure", async () => {
  let resolve!: (duration: number) => void;
  const device = fake();
  device.loadSample.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const report = vi.fn(),
    { audio } = explorationAudio(scoreData as Score, report, device);
  await audio.resume();
  const unlocking = audio.unlock();
  await Promise.resolve();
  audio.sampleEffect("waiting", "beacon-strike", 1);
  audio.pause();
  resolve(0.12);
  await unlocking;
  expect(device.play).not.toHaveBeenCalled();
  expect(device.previewSample).not.toHaveBeenCalled();
  await audio.unlock();
  await audio.resume();
  audio.sampleEffect("fresh", "beacon-strike", 2);
  expect(device.previewSample).toHaveBeenCalledOnce();
  await audio.dispose();
  const failed = fake();
  failed.loadSample.mockRejectedValue(Error("decode failed"));
  const unavailable = explorationAudio(
    scoreData as Score,
    report,
    failed,
  ).audio;
  await unavailable.resume();
  await unavailable.unlock();
  expect(failed.play).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledWith(expect.stringContaining("decode failed"));
  unavailable.sampleEffect("missing", "beacon-strike", 1);
  expect(failed.previewSample).not.toHaveBeenCalled();
  expect(failed.previewNote).toHaveBeenCalledOnce();
  await unavailable.dispose();
});
it("ownership handoff during decode permits loading missing samples on reacquisition", async () => {
  let resolve!: (duration: number) => void;
  const first = fake();
  first.loadSample.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const a = explorationAudio(scoreData as Score, vi.fn(), first).audio;
  await a.resume();
  const unlocking = a.unlock();
  await Promise.resolve();
  const second = fake(),
    b = explorationAudio(scoreData as Score, vi.fn(), second).audio;
  await b.unlock();
  resolve(0.12);
  await unlocking;
  expect(a.stats().loadedSamples).toBe(0);
  await a.unlock();
  await a.resume();
  expect(first.loadSample).toHaveBeenCalledTimes(2);
  a.sampleEffect("fresh", "beacon-strike", 1);
  expect(first.previewSample).toHaveBeenCalledOnce();
  await a.dispose();
  await b.dispose();
});

it("disposed pending sample failures cannot publish errors or resume the device", async () => {
  let reject!: (reason: Error) => void;
  const device = fake();
  device.loadSample.mockImplementation(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  const report = vi.fn(),
    { audio } = explorationAudio(scoreData as Score, report, device);
  await audio.resume();
  const unlocking = audio.unlock();
  await Promise.resolve();
  await audio.dispose();
  reject(Error("late decode"));
  await unlocking;
  expect(report).not.toHaveBeenCalled();
  expect(device.play).not.toHaveBeenCalled();
  expect(audio.stats().loadedSamples).toBe(0);
});

it("silent cancelled decode and failed loading retain strike fallback without stale errors", async () => {
  const device = fake();
  device.loadSample.mockResolvedValueOnce(null);
  const report = vi.fn(),
    { audio } = explorationAudio(scoreData as Score, report, device);
  await audio.resume();
  await audio.unlock();
  expect(report).not.toHaveBeenCalled();
  expect(audio.stats().sampleFailures).toBe(0);
  expect(audio.sampleEffect("cancelled-fallback", "beacon-strike", 1)).toBe(
    true,
  );
  expect(device.previewNote).toHaveBeenCalledOnce();
  expect(device.previewSample).not.toHaveBeenCalled();
  await audio.unlock();
  expect(audio.sampleEffect("loaded-strike", "beacon-strike", 2)).toBe(true);
  expect(device.previewSample).toHaveBeenCalledOnce();
  await audio.dispose();
});
it("device rejected samples and local transient saturation do not consume cue identities", async () => {
  const device = fake(),
    { audio } = explorationAudio(scoreData as Score, vi.fn(), device);
  await audio.resume();
  await audio.unlock();
  device.previewSample.mockReturnValueOnce(null);
  expect(audio.sampleEffect("retry", "beacon-strike", 1)).toBe(false);
  expect(audio.stats()).toMatchObject({
    acceptedSounds: 0,
    acceptedSamples: 0,
    duplicateSounds: 0,
    cueLog: [],
  });
  expect(audio.sampleEffect("retry", "beacon-strike", 1)).toBe(true);
  expect(audio.stats()).toMatchObject({
    acceptedSounds: 1,
    acceptedSamples: 1,
    duplicateSounds: 0,
  });
  for (let i = 0; i < 31; i++)
    audio.sampleEffect(`fill-${i}`, "beacon-strike", 2);
  expect(audio.sampleEffect("full-retry", "beacon-strike", 3)).toBe(false);
  device.currentTime = 1;
  expect(audio.sampleEffect("full-retry", "beacon-strike", 3)).toBe(true);
  expect(audio.stats().duplicateSounds).toBe(0);
  await audio.dispose();
});
it("pause during native failure silently cancels it and uses fallback until a later successful gesture", async () => {
  let reject!: (error: Error) => void;
  const device = fake();
  device.loadSample.mockImplementationOnce(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  const report = vi.fn(),
    { audio } = explorationAudio(scoreData as Score, report, device);
  await audio.resume();
  const pending = audio.unlock();
  await Promise.resolve();
  audio.pause();
  reject(Error("old native decode"));
  await pending;
  expect(report).not.toHaveBeenCalled();
  expect(audio.stats().sampleFailures).toBe(0);
  await audio.resume();
  expect(audio.sampleEffect("fallback", "beacon-strike", 1)).toBe(true);
  expect(device.previewNote).toHaveBeenCalledOnce();
  await audio.unlock();
  expect(audio.sampleEffect("decoded", "beacon-strike", 2)).toBe(true);
  expect(device.previewSample).toHaveBeenCalledOnce();
  await audio.dispose();
});

it("fallback synthesis also records only explicitly admitted device voices", async () => {
  const device = {
    ...fake(),
    tryPreviewNote: vi.fn<NonNullable<M2AudioEngine["tryPreviewNote"]>>(
      () => null,
    ),
  };
  device.loadSample.mockResolvedValue(null);
  const { audio } = explorationAudio(scoreData as Score, vi.fn(), device);
  await audio.resume();
  await audio.unlock();
  expect(audio.sampleEffect("retry-fallback", "beacon-strike", 1)).toBe(false);
  expect(audio.stats()).toMatchObject({
    acceptedSounds: 0,
    acceptedSamples: 0,
    duplicateSounds: 0,
    cueLog: [],
  });
  device.tryPreviewNote.mockReturnValue(vi.fn());
  expect(audio.sampleEffect("retry-fallback", "beacon-strike", 1)).toBe(true);
  expect(audio.stats()).toMatchObject({
    acceptedSounds: 1,
    acceptedSamples: 0,
    duplicateSounds: 0,
  });
  expect(device.previewNote).not.toHaveBeenCalled();
  await audio.dispose();
});

it("revalidates already decoded selections against a recreated device cache on the next gesture", async () => {
  let cached = false;
  const device = fake();
  device.loadSample.mockImplementation(async () => {
    cached = true;
    return 0.12;
  });
  device.previewSample.mockImplementation(() => (cached ? vi.fn() : null));
  const { audio } = explorationAudio(scoreData as Score, vi.fn(), device);
  await audio.resume();
  await audio.unlock();
  expect(audio.sampleEffect("before-recreation", "beacon-strike", 1)).toBe(
    true,
  );
  // Simulate a device that loses decoded buffers while the M2 owner survives.
  cached = false;
  expect(audio.sampleEffect("replacement-cue", "beacon-strike", 2)).toBe(false);
  await audio.unlock();
  expect(device.loadSample).toHaveBeenCalledTimes(2);
  expect(audio.sampleEffect("replacement-cue", "beacon-strike", 2)).toBe(true);
  expect(audio.stats().acceptedSamples).toBe(2);
  await audio.dispose();
});

it("adaptive decisions survive pending enable only as latest intent and queue failures remain presentation errors", async () => {
  let resolve!: () => void;
  const device = {
    ...fake(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    ),
    queueScore: vi.fn(),
  };
  const report = vi.fn(),
    { audio } = explorationAudio(scoreData as Score, report, device);
  await audio.resume();
  const pending = audio.unlock();
  audio.music!.request("high");
  audio.pause();
  audio.music!.restore({ version: 1, state: "low" });
  resolve();
  await pending;
  expect(device.play).not.toHaveBeenCalled();
  await audio.resume();
  expect(device.play.mock.lastCall![0].title).toContain("low");
  device.queueScore.mockImplementationOnce(() => {
    throw Error("queue unavailable");
  });
  expect(() => audio.music!.request("high")).not.toThrow();
  expect(report).toHaveBeenCalledWith(
    expect.stringContaining("queue unavailable"),
  );
  audio.pause();
  await audio.resume();
  expect(device.play.mock.lastCall![1]?.energy).toBe(2);
  await audio.dispose();
});

it("reconciles the latest arrangement requested while device play is pending", async () => {
  let resolve!: () => void;
  const device = { ...fake(), queueScore: vi.fn() };
  device.play.mockImplementationOnce(
    () =>
      new Promise<void>((r) => {
        resolve = r;
      }),
  );
  const { audio } = explorationAudio(scoreData as Score, vi.fn(), device);
  await audio.resume();
  const unlocking = audio.unlock();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  audio.music!.request("high");
  resolve();
  await unlocking;
  expect(device.queueScore).toHaveBeenCalledOnce();
  expect(device.queueScore.mock.lastCall![0].title).toContain("high");
  audio.pause();
  await audio.dispose();
});

it("ordinary flow transitions preserve adaptive energy and queue without restarting music", async () => {
  const device = { ...fake(), queueScore: vi.fn() };
  const { audio } = explorationAudio(scoreData as Score, vi.fn(), device);
  await audio.resume();
  await audio.unlock();
  audio.music!.request("high");
  audio.sampleEffect("before-transition", "beacon-strike", 1);
  const starts = device.play.mock.calls.length;
  const queues = device.queueScore.mock.calls.length;
  const energyChanges = device.setEnergy.mock.calls.length;
  audio.transition(1);
  expect(audio.stats().energy).toBe(2);
  expect(audio.music!.snapshot().state).toBe("high");
  expect(device.play).toHaveBeenCalledTimes(starts);
  expect(device.queueScore).toHaveBeenCalledTimes(queues);
  expect(device.setEnergy).toHaveBeenCalledTimes(energyChanges);
  expect(audio.music!.request("high")).toBe(false);
  expect(audio.sampleEffect("old", "beacon-strike", 1)).toBe(false);
  expect(audio.sampleEffect("fresh", "beacon-strike", 2)).toBe(true);
  await audio.dispose();
});

it("adaptive bank takes precedence over the ordinary score while legacy devices keep that score", async () => {
  const ordinary = structuredClone(scoreData) as Score;
  ordinary.title = "Ordinary fallback score";
  for (const adaptive of [false, true]) {
    const device = adaptive ? { ...fake(), queueScore: vi.fn() } : fake();
    const { audio } = explorationAudio(ordinary, vi.fn(), device);
    await audio.resume();
    await audio.unlock();
    const played = device.play.mock.lastCall![0];
    if (adaptive) expect(played.title).not.toBe(ordinary.title);
    else expect(played).toEqual(ordinary);
    expect(ordinary.title).toBe("Ordinary fallback score");
    await audio.dispose();
  }
});
