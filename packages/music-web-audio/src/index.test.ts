import { afterEach, describe, expect, it, vi } from "vitest";
import { createBlankScore } from "@onepage/project";
import { AudioEngine, encodeWav, renderScore } from "./index";
import * as playbackValidation from "../../music-core/src/score-validation";
import * as authoringValidation from "@onepage/project";

class Parameter {
  value = 0;
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
  cancelScheduledValues = vi.fn();
}
class Node {
  buffer: AudioBuffer | null = null;
  loop = false;
  gain = new Parameter();
  pan = new Parameter();
  frequency = new Parameter();
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
  setPeriodicWave = vi.fn();
  onended: (() => void) | null = null;
}
class Context {
  static instances: Context[] = [];
  currentTime = 0;
  sampleRate = 48000;
  state = "suspended";
  destination = new Node();
  onstatechange: (() => void) | null = null;
  sources: Node[] = [];
  gains: Node[] = [];
  constructor() {
    Context.instances.push(this);
  }
  resume = vi.fn(async () => {
    this.state = "running";
    this.onstatechange?.();
  });
  close = vi.fn(async () => {
    this.state = "closed";
  });
  decodeAudioData = vi.fn(
    async (_bytes: ArrayBuffer) =>
      ({ duration: 0.12, numberOfChannels: 1, length: 5760 }) as AudioBuffer,
  );
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const samples = new Float32Array(length);
    return {
      length,
      sampleRate,
      getChannelData: () => samples,
    } as unknown as AudioBuffer;
  }
  createBufferSource() {
    const n = new Node();
    this.sources.push(n);
    return n;
  }
  createGain() {
    const node = new Node();
    this.gains.push(node);
    return node;
  }
  createStereoPanner() {
    return new Node();
  }
  createBiquadFilter() {
    return new Node();
  }
  createPeriodicWave() {
    return {};
  }
  createOscillator() {
    const n = new Node();
    this.sources.push(n);
    return n;
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Context.instances = [];
});
describe("shared audio lifecycle", () => {
  it("constructs without touching browser audio globals", () => {
    const engine = new AudioEngine();
    expect(engine.isPlaying).toBe(false);
    expect(engine.currentTime).toBe(0);
  });
  it("applies live master volume to existing music and preview voices without resetting audio time", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", Context);
    const score = createBlankScore();
    score.patterns[0].notes.push({
      id: "n",
      startTick: 0,
      durationTicks: 480,
      pitch: 60,
      velocity: 0.8,
    });
    const engine = new AudioEngine();
    engine.setVolume(0.5);
    await engine.play(score, { loop: true });
    const ctx = Context.instances[0],
      output = ctx.gains[0];
    expect(output.connect).toHaveBeenCalledWith(ctx.destination);
    engine.previewNote(score.patches[0], 64);
    ctx.currentTime = 0.2;
    const position = engine.getPositionTick(),
      sources = ctx.sources.length;
    for (const volume of [0.2, 0.8, 0]) engine.setVolume(volume);
    expect(output.gain.setValueAtTime).toHaveBeenLastCalledWith(0, 0.2);
    expect(engine.getPositionTick()).toBe(position);
    expect(engine.isPlaying).toBe(true);
    expect(ctx.sources).toHaveLength(sources);
    for (const source of ctx.sources)
      expect(source.stop.mock.calls).toHaveLength(1); // scheduled end only
    expect(() => engine.setVolume(NaN)).toThrow("Invalid volume");
    await engine.dispose();
    expect(output.disconnect).toHaveBeenCalledOnce();
  });
  it("cancels scheduled voices on stop and closes on dispose", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", Context);
    const score = createBlankScore();
    score.patterns[0].notes.push({
      id: "n",
      startTick: 0,
      durationTicks: 480,
      pitch: 60,
      velocity: 0.8,
    });
    const engine = new AudioEngine();
    await engine.play(score);
    const ctx = Context.instances[0];
    expect(ctx.sources).toHaveLength(1);
    expect(engine.isPlaying).toBe(true);
    ctx.currentTime = 0.53;
    expect(engine.getPositionTick()).toBeCloseTo(480);
    engine.stop();
    expect(ctx.sources[0].stop).toHaveBeenLastCalledWith(0.53);
    expect(engine.isPlaying).toBe(false);
    await engine.dispose();
    expect(ctx.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("schedules by audio time and skips elapsed notes after a stalled main thread", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", Context);
    const score = createBlankScore();
    score.playback = "one-shot";
    score.loop = null;
    score.patterns[0].notes = [0, 480, 960].map((startTick, i) => ({
      id: String(i),
      startTick,
      durationTicks: 120,
      pitch: 60,
      velocity: 0.8,
    }));
    const engine = new AudioEngine();
    await engine.play(score);
    const ctx = Context.instances[0];
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0].start).toHaveBeenCalledWith(0.03);
    ctx.currentTime = 1;
    vi.advanceTimersByTime(25);
    expect(ctx.sources).toHaveLength(2);
    expect(ctx.sources[1].start).toHaveBeenCalledWith(1.03);
    await engine.dispose();
  });
  it("gives percussion lanes distinct deterministic buffers, cached per lane", async () => {
    vi.stubGlobal("AudioContext", Context);
    const engine = new AudioEngine();
    await engine.enable();
    const patch = {
      ...createBlankScore().patches[0]!,
      waveform: "noise" as const,
    };
    for (const pitch of [36, 38, 42, 46, 36]) engine.previewNote(patch, pitch);
    const sources = Context.instances[0].sources;
    expect(new Set(sources.slice(0, 4).map((s) => s.buffer))).toHaveProperty(
      "size",
      4,
    );
    expect(sources[0].buffer).toBe(sources[4].buffer);
    expect(sources[0].buffer!.getChannelData(0)[100]).not.toBe(
      sources[1].buffer!.getChannelData(0)[100],
    );
    expect(sources.every((s) => !s.loop)).toBe(true);
    await engine.dispose();
  });
  it("aligns phrase previews to the audio clock, including preroll, and cancels future voices", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", Context);
    const score = createBlankScore();
    const engine = new AudioEngine();
    await engine.play(score, { loop: true });
    const ctx = Context.instances[0];
    expect(engine.getDelayToTick(0)).toBeCloseTo(0.03);
    expect(engine.getDelayToTick(480)).toBeCloseTo(0.53);
    ctx.currentTime = 0.28;
    engine.previewNote(
      score.patches[0]!,
      60,
      0.8,
      0.1,
      1,
      0,
      engine.getDelayToTick(480),
    );
    const scheduled = ctx.sources.at(-1)!;
    expect(scheduled.start).toHaveBeenCalledWith(0.53);
    expect(engine.getDelayToTick(0)).toBe(0);
    engine.stop();
    expect(scheduled.stop).toHaveBeenLastCalledWith(0.28);
    expect(engine.getDelayToTick(480)).toBe(0);
    await engine.dispose();
  });
  it("keeps phrase scheduling aligned in a nonzero loop after it wraps", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", Context);
    const engine = new AudioEngine();
    await engine.play(createBlankScore(), {
      startTick: 480,
      endTick: 1440,
      loop: true,
    });
    const ctx = Context.instances[0];
    ctx.currentTime = 1.28;
    expect(engine.getPositionTick()).toBeCloseTo(720);
    expect(engine.getDelayToTick(960)).toBeCloseTo(0.25);
    expect(engine.getDelayToTick(480)).toBe(0);
    await engine.dispose();
  });
  it("applies only the latest live edit at a loop boundary without restarting the clock", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", Context);
    const score = createBlankScore();
    score.loop = { startTick: 480, endTick: 1440 };
    score.patterns[0]!.notes = [
      { id: "n", startTick: 480, durationTicks: 120, pitch: 60, velocity: 0.8 },
    ];
    const engine = new AudioEngine();
    await engine.play(score, { loop: true });
    const ctx = Context.instances[0];
    ctx.currentTime = 0.28;
    const edit = structuredClone(score);
    edit.patterns[0]!.notes[0]!.pitch = 64;
    engine.queueScore(edit);
    edit.patterns[0]!.notes[0]!.pitch = 67;
    engine.queueScore(edit);
    edit.patterns[0]!.notes[0]!.pitch = 90;
    expect(engine.hasQueuedScore).toBe(true);
    expect(engine.getPositionTick()).toBeCloseTo(720);
    ctx.currentTime = 0.9;
    vi.advanceTimersByTime(25);
    expect(ctx.sources).toHaveLength(2);
    expect(ctx.sources[1]!.frequency.value).toBeCloseTo(
      440 * 2 ** ((67 - 69) / 12),
    );
    expect(ctx.sources[1]!.start).toHaveBeenCalledWith(1.03);
    // Scheduling ahead must not move the visible playhead ahead of real audio.
    expect(engine.getPositionTick()).toBeCloseTo(1315.2);
    expect(engine.hasQueuedScore).toBe(true);
    ctx.currentTime = 1.28;
    expect(engine.getPositionTick()).toBeCloseTo(720);
    expect(engine.hasQueuedScore).toBe(false);
    expect(engine.isPlaying).toBe(true);
    await engine.dispose();
  });
  it("updates a silent loop, adopts new tempo/range, and cancels queued changes on stop", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", Context);
    const score = createBlankScore();
    score.loop = { startTick: 0, endTick: 960 };
    const engine = new AudioEngine();
    await engine.play(score, { loop: true });
    const ctx = Context.instances[0];
    ctx.currentTime = 0.28;
    const next = structuredClone(score);
    next.bpm = 60;
    next.loop = { startTick: 480, endTick: 1440 };
    next.patterns[0]!.notes = [
      { id: "n", startTick: 480, durationTicks: 120, pitch: 60, velocity: 0.8 },
    ];
    engine.queueScore(next);
    ctx.currentTime = 0.9;
    vi.advanceTimersByTime(25);
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0]!.start).toHaveBeenCalledWith(1.03);
    expect(engine.getPositionTick()).toBeCloseTo(835.2);
    ctx.currentTime = 1.53;
    expect(engine.getPositionTick()).toBeCloseTo(720);
    engine.queueScore(score);
    engine.stop();
    expect(engine.hasQueuedScore).toBe(false);
    ctx.currentTime = 5;
    vi.advanceTimersByTime(1000);
    expect(ctx.sources).toHaveLength(1);
    await engine.dispose();
  });
  it("retains each audible transport transition when several short loops fit in lookahead", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", Context);
    const score = createBlankScore();
    score.bpm = 400;
    score.loop = { startTick: 0, endTick: 96 };
    const engine = new AudioEngine();
    await engine.play(score, { loop: true });
    const ctx = Context.instances[0];
    engine.queueScore({ ...score, loop: { startTick: 480, endTick: 576 } });
    ctx.currentTime = 0.04;
    vi.advanceTimersByTime(25);
    engine.queueScore({ ...score, loop: { startTick: 960, endTick: 1056 } });
    ctx.currentTime = 0.07;
    vi.advanceTimersByTime(25);
    ctx.currentTime = 0.19;
    expect(engine.getPositionTick()).toBeCloseTo(512);
    expect(engine.hasQueuedScore).toBe(true);
    ctx.currentTime = 0.22;
    expect(engine.getPositionTick()).toBeCloseTo(992);
    expect(engine.hasQueuedScore).toBe(false);
    await engine.dispose();
  });
  it("changes energy without resetting transport and cancels ineligible scheduled layers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", Context);
    const score = createBlankScore();
    score.tracks[0]!.minEnergy = 3;
    score.patterns[0]!.notes = [
      { id: "n", startTick: 0, durationTicks: 960, pitch: 60, velocity: 0.8 },
    ];
    const engine = new AudioEngine();
    await engine.play(score, { energy: 3 });
    const ctx = Context.instances[0];
    ctx.currentTime = 0.53;
    engine.setEnergy(1);
    expect(engine.isPlaying).toBe(true);
    expect(engine.getPositionTick()).toBeCloseTo(480);
    expect(ctx.sources[0].stop).toHaveBeenLastCalledWith(0.53);
    expect(() => engine.setEnergy(4)).toThrow();
    await engine.dispose();
  });
  it("does not leave a scheduler timer when the initial event burst exceeds voice limit", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", Context);
    const score = createBlankScore();
    score.patterns[0]!.notes = Array.from({ length: 257 }, (_, i) => ({
      id: String(i),
      startTick: 0,
      durationTicks: 480,
      pitch: 60,
      velocity: 0.1,
    }));
    const engine = new AudioEngine();
    await engine.play(score);
    expect(engine.isPlaying).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await engine.dispose();
  });
  it("stops on browser interruption", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", Context);
    const engine = new AudioEngine();
    await engine.play(createBlankScore());
    Context.instances[0].state = "interrupted";
    Context.instances[0].onstatechange?.();
    expect(engine.isPlaying).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("stop during async enable prevents a stale playback from starting", async () => {
    vi.stubGlobal("AudioContext", Context);
    const engine = new AudioEngine();
    const pending = engine.play(createBlankScore());
    engine.stop();
    await pending;
    expect(engine.isPlaying).toBe(false);
    await engine.dispose();
  });
  it("rejects oversized offline allocations before creating a context", async () => {
    const score = createBlankScore();
    score.lengthTicks = 9600;
    await expect(renderScore(score, { loops: 128 })).rejects.toThrow(
      "Render exceeds",
    );
  });
});
it("writes interleaved PCM16 WAV with clipping and nonfinite sample sanitization", () => {
  const wav = encodeWav({
    numberOfChannels: 2,
    length: 2,
    sampleRate: 48000,
    getChannelData: (c: number) => new Float32Array(c ? [NaN, 0.5] : [-2, 2]),
  } as AudioBuffer);
  const view = new DataView(wav.buffer);
  expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
  expect(view.getUint32(40, true)).toBe(8);
  expect([44, 46, 48, 50].map((n) => view.getInt16(n, true))).toEqual([
    -32768, 0, 32767, 16384,
  ]);
});

it("validates a playback start once through the runtime boundary, without authoring validation", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("AudioContext", Context);
  const runtime = vi.spyOn(playbackValidation, "assertPlayableScore");
  const authoring = vi.spyOn(authoringValidation, "assertScore");
  const engine = new AudioEngine();
  try {
    await engine.play(createBlankScore());
    expect(runtime).toHaveBeenCalledOnce();
    expect(authoring).not.toHaveBeenCalled();
    expect(Context.instances).toHaveLength(1);
  } finally {
    await engine.dispose();
    runtime.mockRestore();
    authoring.mockRestore();
  }
});
it("rejects unsupported PPQ before constructing any live or offline audio context", async () => {
  vi.stubGlobal("AudioContext", Context);
  const offline = vi.fn();
  vi.stubGlobal("OfflineAudioContext", offline);
  const engine = new AudioEngine();
  const unsupported = {
    ...createBlankScore(),
    ppq: 960,
  } as unknown as ReturnType<typeof createBlankScore>;
  await expect(engine.play(unsupported)).rejects.toThrow("Invalid score");
  await expect(renderScore(unsupported)).rejects.toThrow("Invalid score");
  expect(Context.instances).toHaveLength(0);
  expect(offline).not.toHaveBeenCalled();
  await engine.dispose();
});

describe("bounded decoded sample voices", () => {
  it("validates encoded WAV before decode and routes samples through live gain and stop", async () => {
    vi.stubGlobal("AudioContext", Context);
    const { explorationStrikeSample } = await import(
      "../../game-runtime/src/presentation/exploration-sample.ts"
    );
    const engine = new AudioEngine();
    await engine.enable();
    const ctx = Context.instances[0];
    await expect(
      engine.loadSample("strike", new ArrayBuffer(44)),
    ).rejects.toThrow("WAV");
    expect(ctx.decodeAudioData).not.toHaveBeenCalled();
    expect(await engine.loadSample("strike", explorationStrikeSample())).toBe(
      0.12,
    );
    const stops = Array.from({ length: 270 }, () =>
      engine.previewSample("strike"),
    );
    expect(engine.activeVoiceCount).toBe(256);
    expect(ctx.sources).toHaveLength(256);
    expect(ctx.sources[0].connect).toHaveBeenCalledWith(ctx.gains[1]);
    expect(ctx.gains[1].connect).toHaveBeenCalledWith(ctx.gains[0]);
    engine.setVolume(0);
    expect(ctx.gains[0].gain.setValueAtTime).toHaveBeenLastCalledWith(0, 0);
    engine.stop();
    expect(engine.activeVoiceCount).toBe(0);
    expect(ctx.sources[0].stop).toHaveBeenCalledOnce();
    stops[0]!();
    expect(ctx.sources[0].stop).toHaveBeenCalledOnce();
    await engine.dispose();
    expect(engine.activeVoiceCount).toBe(0);
  });
  it("bounds concurrent loads, rejects oversize decoded buffers, and invalidates disposal results", async () => {
    vi.stubGlobal("AudioContext", Context);
    const { explorationStrikeSample } = await import(
      "../../game-runtime/src/presentation/exploration-sample.ts"
    );
    const engine = new AudioEngine();
    await engine.enable();
    const ctx = Context.instances[0];
    let resolve!: (buffer: AudioBuffer) => void;
    ctx.decodeAudioData.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const first = engine.loadSample("one", explorationStrikeSample());
    await expect(
      engine.loadSample("one", explorationStrikeSample()),
    ).rejects.toThrow("capacity");
    await engine.dispose();
    resolve({
      duration: 0.12,
      numberOfChannels: 1,
      length: 5760,
    } as AudioBuffer);
    await expect(first).resolves.toBeNull();
    expect(engine.activeVoiceCount).toBe(0);
    const next = new AudioEngine();
    await next.enable();
    const context = Context.instances[1];
    context.decodeAudioData.mockResolvedValue({
      duration: 100,
      numberOfChannels: 1,
      length: 1000000,
    } as AudioBuffer);
    await expect(
      next.loadSample("bad", explorationStrikeSample()),
    ).rejects.toThrow("decoded");
    context.decodeAudioData.mockResolvedValue({
      duration: 0.12,
      numberOfChannels: 1,
      length: 5760,
    } as AudioBuffer);
    for (const id of ["one", "two", "three", "four"])
      await next.loadSample(id, explorationStrikeSample());
    await expect(
      next.loadSample("five", explorationStrikeSample()),
    ).rejects.toThrow("capacity");
    await next.dispose();
  });
});

it("releases sample sources onended and declines missing/suspended/global-cap voices explicitly", async () => {
  vi.stubGlobal("AudioContext", Context);
  const { explorationStrikeSample } = await import(
    "../../game-runtime/src/presentation/exploration-sample.ts"
  );
  const engine = new AudioEngine();
  expect(engine.previewSample("strike")).toBeNull();
  await expect(
    engine.loadSample("strike", explorationStrikeSample()),
  ).resolves.toBeNull();
  await engine.enable();
  const ctx = Context.instances[0];
  await engine.loadSample("strike", explorationStrikeSample());
  expect(engine.previewSample("missing")).toBeNull();
  const stop = engine.previewSample("strike");
  expect(stop).toBeTypeOf("function");
  const source = ctx.sources[0],
    envelope = ctx.gains[1];
  source.onended!();
  expect(engine.activeVoiceCount).toBe(0);
  expect(source.disconnect).toHaveBeenCalledOnce();
  expect(envelope.disconnect).toHaveBeenCalledOnce();
  stop!();
  expect(source.stop).not.toHaveBeenCalled();
  ctx.state = "suspended";
  ctx.onstatechange?.();
  expect(engine.previewSample("strike")).toBeNull();
  expect(engine.tryPreviewNote(createBlankScore().patches[0], 60)).toBeNull();
  await engine.enable();
  for (let i = 0; i < 256; i++)
    expect(engine.previewSample("strike")).toBeTypeOf("function");
  expect(engine.previewSample("strike")).toBeNull();
  expect(engine.tryPreviewNote(createBlankScore().patches[0], 60)).toBeNull();
  await engine.dispose();
});
it("native decode rejection releases capacity for a successful retry", async () => {
  vi.stubGlobal("AudioContext", Context);
  const { explorationStrikeSample } = await import(
    "../../game-runtime/src/presentation/exploration-sample.ts"
  );
  const engine = new AudioEngine();
  await engine.enable();
  const ctx = Context.instances[0];
  ctx.decodeAudioData.mockRejectedValueOnce(Error("native decode rejected"));
  await expect(
    engine.loadSample("strike", explorationStrikeSample()),
  ).rejects.toThrow("native decode rejected");
  await expect(
    engine.loadSample("strike", explorationStrikeSample()),
  ).resolves.toBe(0.12);
  expect(engine.previewSample("strike")).toBeTypeOf("function");
  await engine.dispose();
});
it("suspension and recreated devices silently cancel old loads without occupying replacement slots", async () => {
  vi.stubGlobal("AudioContext", Context);
  const { explorationStrikeSample } = await import(
    "../../game-runtime/src/presentation/exploration-sample.ts"
  );
  const engine = new AudioEngine();
  await engine.enable();
  const old = Context.instances[0];
  let reject!: (error: Error) => void;
  old.decodeAudioData.mockImplementationOnce(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  const suspended = engine.loadSample("one", explorationStrikeSample());
  old.state = "suspended";
  reject(Error("cancelled native decode"));
  await expect(suspended).resolves.toBeNull();
  await engine.enable();
  let resolve!: (buffer: AudioBuffer) => void;
  old.decodeAudioData.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = engine.loadSample("one", explorationStrikeSample());
  old.state = "closed";
  old.onstatechange?.();
  await engine.enable();
  const replacement = Context.instances[1];
  await expect(
    engine.loadSample("one", explorationStrikeSample()),
  ).resolves.toBe(0.12);
  resolve({ duration: 0.12, numberOfChannels: 1, length: 5760 } as AudioBuffer);
  await expect(pending).resolves.toBeNull();
  engine.previewSample("one");
  expect(replacement.sources).toHaveLength(1);
  old.onstatechange?.();
  expect(engine.activeVoiceCount).toBe(1);
  await engine.dispose();
});

it("keeps a global finite native-decode budget across device recreation", async () => {
  vi.stubGlobal("AudioContext", Context);
  const { explorationStrikeSample } = await import(
    "../../game-runtime/src/presentation/exploration-sample.ts"
  );
  const engine = new AudioEngine(),
    finishes: (() => void)[] = [],
    loads: Promise<number | null>[] = [];
  for (let i = 0; i < 4; i++) {
    await engine.enable();
    const ctx = Context.instances[i];
    ctx.decodeAudioData.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finishes.push(() =>
            r({
              duration: 0.12,
              numberOfChannels: 1,
              length: 5760,
            } as AudioBuffer),
          );
        }),
    );
    loads.push(engine.loadSample("strike", explorationStrikeSample()));
    ctx.state = "closed";
    ctx.onstatechange?.();
  }
  await engine.enable();
  await expect(
    engine.loadSample("strike", explorationStrikeSample()),
  ).rejects.toThrow("capacity");
  finishes.forEach((f) => f());
  await expect(Promise.all(loads)).resolves.toEqual([null, null, null, null]);
  await expect(
    engine.loadSample("strike", explorationStrikeSample()),
  ).resolves.toBe(0.12);
  await engine.dispose();
});

it("M2 selected playback continues through a real engine context replacement after successful decode", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("AudioContext", Context);
  const { explorationAudio } = await import(
    "../../game-runtime/src/presentation/exploration-audio.ts"
  );
  const scoreData = await import("../../../examples/game-m2/score.json");
  const engine = new AudioEngine(),
    report = vi.fn();
  const { audio } = explorationAudio(
    scoreData.default as Parameters<typeof explorationAudio>[0],
    report,
    engine,
  );
  await audio.resume();
  await audio.unlock();
  expect(audio.sampleEffect("before", "beacon-strike", 1)).toBe(true);
  const old = Context.instances[0];
  old.state = "closed";
  old.onstatechange?.();
  await audio.unlock();
  expect(Context.instances).toHaveLength(2);
  expect(audio.sampleEffect("after", "beacon-strike", 2)).toBe(true);
  expect(
    Context.instances[1].sources.some(
      (source) => source.buffer?.duration === 0.12,
    ),
  ).toBe(true);
  expect(report).not.toHaveBeenCalled();
  expect(audio.stats().acceptedSamples).toBe(2);
  await audio.dispose();
});

describe('track gain automation', () => {
  it('defaults to unity, evaluates replacement curves, clamps past time, and clears nodes on stop', async () => {
    vi.useFakeTimers(); vi.stubGlobal('AudioContext', Context);
    const engine = new AudioEngine(), score = createBlankScore();
    await engine.play(score, { loop: true });
    const ctx = Context.instances[0];
    const bus = (engine as any).trackBuses.get(score.tracks[0].id) as Node;
    expect(bus.gain.setValueAtTime).toHaveBeenCalledWith(1, 0);
    expect(engine.setTrackGain('absent', .5)).toBe(false);
    engine.setTrackGain(score.tracks[0].id, 0, 0);
    engine.setTrackGain(score.tracks[0].id, 1, 1, 2);
    ctx.currentTime = 2;
    engine.setTrackGain(score.tracks[0].id, 0, 2.5, 1);
    expect(bus.gain.setValueAtTime).toHaveBeenLastCalledWith(.75, 2.5);
    expect(bus.gain.linearRampToValueAtTime).toHaveBeenCalledWith(.75, 2.5);
    expect(bus.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 3.5);
    engine.setTrackGain(score.tracks[0].id, .5, 0);
    expect(bus.gain.setValueAtTime).toHaveBeenLastCalledWith(.5, 2);
    expect(() => engine.setTrackGain(score.tracks[0].id, 2)).toThrow();
    const origin = engine.transportOrigin;
    expect(origin).toBe(.03); expect(engine.isPlaying).toBe(true);
    engine.stop(); expect(bus.disconnect).toHaveBeenCalledOnce();
    expect((engine as any).trackBuses.size).toBe(0);
    expect((engine as any).trackAutomation.size).toBe(0);
    await engine.dispose();
  });
  it('caps pending automation and reclaims obsolete queued track buses', async () => {
    vi.useFakeTimers(); vi.stubGlobal('AudioContext', Context);
    const engine = new AudioEngine(), score = createBlankScore();
    score.loop = { startTick: 0, endTick: 480 }; score.lengthTicks = 480;
    await engine.play(score, { loop: true });
    for (let i = 0; i < 64; i++) engine.setTrackGain(score.tracks[0].id, .5, i + 10);
    expect(() => engine.setTrackGain(score.tracks[0].id, .5, 100)).toThrow('capacity');
    const ctx = Context.instances[0];
    for (let i = 0; i < 10; i++) {
      const next = structuredClone(score), id = `track-${i}`;
      next.tracks[0].id = id; next.clips[0].trackId = id;
      engine.queueScore(next);
      ctx.currentTime += .6;
      vi.advanceTimersByTime(200);
      vi.advanceTimersByTime(200);
    }
    expect((engine as any).trackBuses.size).toBeLessThanOrEqual(score.tracks.length + 1);
    await engine.dispose();
  });
});
