import { afterEach, expect, it, vi } from "vitest";
import { createBlankScore } from "@onepage/project";
import { encodeWav } from "./index";
import { StreamingAudioEngine as AudioEngine } from "./stream-engine";
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
  type = "";
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

function wav(seconds: number) {
  const length = 8000 * seconds;
  return encodeWav({
    numberOfChannels: 1,
    length,
    sampleRate: 8000,
    getChannelData: () => new Float32Array(length),
  } as unknown as AudioBuffer).buffer as ArrayBuffer;
}
it("keeps strict sample defaults and independently bounds long asset admission", async () => {
  vi.stubGlobal("AudioContext", Context);
  const e = new AudioEngine();
  await e.enable();
  const c = Context.instances[0];
  c.decodeAudioData.mockImplementation(
    async (bytes) =>
      ({
        duration: (bytes.byteLength - 44) / 16000,
        numberOfChannels: 1,
        length: (bytes.byteLength - 44) / 2,
      }) as AudioBuffer,
  );
  await expect(e.loadSample("legacy-long", wav(2))).rejects.toThrow();
  for (let i = 0; i < 4; i++)
    expect(await e.loadSample(`short-${i}`, wav(1))).toBe(1);
  await expect(e.loadSample("short-full", wav(1))).rejects.toThrow(/capacity/);
  for (let i = 0; i < 4; i++)
    expect(await e.loadSample(`long-${i}`, wav(6), "environment")).toBe(6);
  await expect(
    e.loadSample("long-full", wav(2), "environment"),
  ).rejects.toThrow(/capacity/);
  await expect(
    e.loadSample("oversized", wav(7), "environment"),
  ).rejects.toThrow();
  await e.dispose();
});
it("schedules independent effect slots, cancels future audio and restores music on stop", async () => {
  vi.stubGlobal("AudioContext", Context);
  const e = new AudioEngine();
  await e.enable();
  await e.loadSample("boom", wav(1), "environment");
  const c = Context.instances[0];
  for (let i = 0; i < 4; i++)
    expect(
      e.scheduleSample("boom", {
        atContextTime: 2,
        duck: { gain: 0.4, holdSeconds: 0.3 },
      }),
    ).not.toBeNull();
  expect(e.scheduleSample("boom")).toBeNull();
  expect(e.activeVoiceCount).toBe(0);
  expect(c.sources.every((s) => s.start.mock.calls[0][0] === 2)).toBe(true);
  const music = c.gains[0],
    master = c.gains[1];
  e.setVolume(0);
  expect(master.gain.setValueAtTime).toHaveBeenLastCalledWith(0, 0);
  expect(music.gain.setValueAtTime).not.toHaveBeenLastCalledWith(0, 0);
  e.stop();
  expect(c.sources.every((s) => s.stop.mock.calls.length === 1)).toBe(true);
  expect(music.gain.cancelScheduledValues).toHaveBeenLastCalledWith(0);
  expect(music.gain.setValueAtTime).toHaveBeenLastCalledWith(1, 0);
  expect(e.scheduleSample("boom", { atContextTime: -1 })).toBeNull();
  await e.dispose();
});
it("overlapping music ducks retain the lower envelope and cancelling a future effect removes its duck", async () => {
  vi.stubGlobal("AudioContext", Context);
  const e = new AudioEngine();
  await e.enable();
  await e.loadSample("boom", wav(1));
  const c = Context.instances[0];
  expect(e.duckMusic(0.5, 1, 1)).toBe(true);
  expect(e.duckMusic(0.3, 2, 1)).toBe(true);
  const music = c.gains[0];
  expect(music.gain.linearRampToValueAtTime.mock.calls).toContainEqual([
    0.3, 1,
  ]);
  expect(music.gain.linearRampToValueAtTime.mock.calls.at(-1)).toEqual([1, 3]);
  const cancel = e.scheduleSample("boom", {
    atContextTime: 5,
    duck: { gain: 0.1 },
  })!;
  cancel();
  expect(music.gain.linearRampToValueAtTime.mock.calls.at(-1)).toEqual([1, 3]);
  await e.dispose();
});
it("creates deterministic bounded beds, smooths changes, and cleans up on suspension/context replacement", async () => {
  vi.stubGlobal("AudioContext", Context);
  const e = new AudioEngine();
  await e.enable();
  const c = Context.instances[0];
  const o = { seed: 42, level: 0.2, filterHz: 800, pan: -0.2 };
  expect(e.setNoiseBed("rain", o)).toBe(true);
  const original = c.sources[0].buffer!.getChannelData(0).slice();
  expect(e.setNoiseBed("rain", { ...o, level: 0.5 })).toBe(true);
  expect(c.sources).toHaveLength(1);
  expect(e.setNoiseBed("wind", { ...o, seed: 7 })).toBe(true);
  expect(e.setNoiseBed("third", o)).toBe(false);
  expect(e.setNoiseBed("bad", { ...o, filterHz: Infinity })).toBe(false);
  c.state = "suspended";
  c.onstatechange?.();
  expect(c.sources.every((s) => s.stop.mock.calls.length === 1)).toBe(true);
  await e.enable();
  expect(e.setNoiseBed("rain", o)).toBe(true);
  expect(c.sources.at(-1)!.buffer!.getChannelData(0)).toEqual(original);
  c.state = "closed";
  await e.enable();
  expect(Context.instances).toHaveLength(2);
  expect(e.setNoiseBed("rain", o)).toBe(true);
  await e.dispose();
});
it("environment effects cannot starve a renderer with one music slot", async () => {
  vi.stubGlobal("AudioContext", Context);
  const e = new AudioEngine();
  e.setVoiceRenderer({
    id: "one",
    maxVoices: 1,
    releaseSeconds: () => 0.01,
    renderVoice: () => ({ end: 1, stop: () => {} }),
  });
  const score = createBlankScore();
  await e.beginStream({
    bpm: 120,
    tracks: score.tracks,
    patches: score.patches,
    ticker: () => () => {},
  });
  await e.loadSample("boom", wav(1), "environment");
  for (let i = 0; i < 4; i++) expect(e.scheduleSample("boom")).not.toBeNull();
  expect(e.tryPreviewNote(score.patches[0], 60)).not.toBeNull();
  await e.dispose();
});
it("retains an active release under a future attack and cancellation, and changes active environmental gain alone", async () => {
  vi.stubGlobal("AudioContext", Context);
  const e = new AudioEngine();
  await e.enable();
  await e.loadSample("boom", wav(1), "environment");
  e.duckMusic(0.2, 0, 2);
  const c = Context.instances[0],
    music = c.gains[0];
  c.currentTime = 0.5;
  const cancel = e.scheduleSample("boom", {
    atContextTime: 1,
    duck: { gain: 0.1, holdSeconds: 1, releaseSeconds: 1 },
  })!;
  const calls = music.gain.linearRampToValueAtTime.mock.calls;
  expect(calls.find((call) => call[1] === 0.99)?.[0]).toBeCloseTo(0.596);
  cancel();
  expect(music.gain.setValueAtTime).toHaveBeenLastCalledWith(0.4, 0.5);
  expect(music.gain.linearRampToValueAtTime.mock.calls.at(-1)).toEqual([1, 2]);
  e.scheduleSample("boom");
  const aux = c.gains[2],
    before = music.gain.linearRampToValueAtTime.mock.calls.length;
  e.setEnvironmentVolume(0, 0.1);
  expect(aux.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 0.6);
  expect(music.gain.linearRampToValueAtTime.mock.calls.length).toBe(before);
  expect(c.sources.at(-1)!.stop).not.toHaveBeenCalled();
  const activeSource = c.sources.at(-1)!;
  expect(e.scheduleSample("boom")).not.toBeNull();
  const nextGain = activeSource.connect.mock.calls[0][0];
  const newGain = c.sources.at(-1)!.connect.mock.calls[0][0];
  expect(nextGain.connect.mock.calls[0][0].connect.mock.calls[0][0]).toBe(aux);
  expect(newGain.connect.mock.calls[0][0].connect.mock.calls[0][0]).toBe(aux);
  await e.dispose();
});
it("accepts full six-second environment decodes on a96kHz device and cancels stale decodes on disposal", async () => {
  vi.stubGlobal("AudioContext", Context);
  const e = new AudioEngine();
  await e.enable();
  const c = Context.instances[0];
  c.sampleRate = 96000;
  c.decodeAudioData.mockResolvedValue({
    duration: 6,
    length: 576000,
    numberOfChannels: 2,
  } as AudioBuffer);
  expect(await e.loadSample("hi-rate", wav(6), "environment")).toBe(6);
  let resolve!: (b: AudioBuffer) => void;
  c.decodeAudioData.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = e.loadSample("pending", wav(6), "environment");
  await e.dispose();
  resolve({ duration: 6, length: 576000, numberOfChannels: 2 } as AudioBuffer);
  expect(await pending).toBeNull();
});
it("reroutes already-playing legacy effects around a newly created music duck bus", async () => {
  vi.stubGlobal("AudioContext", Context);
  const e = new AudioEngine();
  await e.enable();
  await e.loadSample("beep", wav(1));
  e.previewSample("beep");
  const c = Context.instances[0],
    legacy = c.gains[1];
  expect(legacy.connect).toHaveBeenLastCalledWith(c.gains[0]);
  e.duckMusic(0.2);
  expect(legacy.disconnect).toHaveBeenCalled();
  expect(legacy.connect).toHaveBeenLastCalledWith(c.gains[2]);
  await e.dispose();
});
