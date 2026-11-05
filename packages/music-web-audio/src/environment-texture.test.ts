import { afterEach, expect, it, vi } from "vitest";
import { EnvironmentAudio } from "./environment-audio";
import { WeatherTexture } from "./environment-texture-worklet.js";

function render(seed: number, kind: "rain" | "wind", seconds = 24) {
  const rate = 8000,
    texture = new WeatherTexture(seed, kind, rate);
  const left = new Float32Array(rate * seconds),
    right = left.slice();
  for (let i = 0; i < left.length; i++) {
    texture.processInto(0.12, kind === "wind" ? 420 : 1700, 0.18, 0.9, 0.8);
    left[i] = texture.outputLeft;
    right[i] = texture.outputRight;
  }
  return { left, right, texture, rate };
}
it("replays continuous seeded motion exactly and changes seed without a two-second waveform repeat", () => {
  const a = render(42, "wind"),
    b = render(42, "wind"),
    c = render(43, "wind");
  expect(a.left).toEqual(b.left);
  expect(a.left).not.toEqual(c.left);
  const offset = a.rate * 2;
  let xy = 0,
    xx = 0,
    yy = 0;
  for (let i = offset; i < a.left.length - offset; i++) {
    const x = a.left[i],
      y = a.left[i + offset];
    xy += x * y;
    xx += x * x;
    yy += y * y;
  }
  expect(Math.abs(xy / Math.sqrt(xx * yy))).toBeLessThan(0.1);
  expect(a.texture.frames).toBe(a.left.length);
});
it.each(["wind", "rain"] as const)(
  "keeps %s finite, continuous, evolving and mono compatible",
  (kind) => {
    const { left, right, rate } = render(71, kind, 60);
    const windows: number[] = [];
    let mono = 0,
      stereo = 0,
      maxJump = 0;
    for (let i = rate; i < left.length; i++) {
      expect(Number.isFinite(left[i])).toBe(true);
      mono += ((left[i] + right[i]) / 2) ** 2;
      stereo += (left[i] ** 2 + right[i] ** 2) / 2;
      maxJump = Math.max(maxJump, Math.abs(left[i] - left[i - 1]));
    }
    for (let start = rate; start < left.length; start += rate) {
      let sum = 0;
      for (let i = start; i < start + rate; i++) sum += left[i] ** 2;
      windows.push(Math.sqrt(sum / rate));
    }
    expect(Math.min(...windows)).toBeGreaterThan(0.0001);
    expect(Math.max(...windows) / Math.min(...windows)).toBeGreaterThan(1.15);
    expect(mono / stereo).toBeGreaterThan(0.85);
    expect(maxJump).toBeLessThan(0.18);
  },
);
it("smooths a changing target without resetting audio time or its stochastic state", () => {
  const t = render(9, "rain", 2).texture;
  const frames = t.frames,
    previous = t.outputLeft;
  t.processInto(0, 1800, -0.18, 0.4, 0.2);
  expect(t.frames).toBe(frames + 1);
  expect(Math.abs(t.outputLeft - previous)).toBeLessThan(0.1);
  for (let i = 0; i < 8000 * 8; i++) t.processInto(0, 1800, -0.18, 0.4, 0.2);
  expect(Math.abs(t.outputLeft)).toBeLessThan(1e-6);
});

class Param {
  value = 0;
  setValueAtTime = vi.fn();
  cancelScheduledValues = vi.fn();
}
class Worklet {
  static instances: Worklet[] = [];
  onprocessorerror: (() => void) | null = null;
  parameters = new Map(
    ["level", "filterHz", "pan", "gustiness", "activity"].map((k) => [
      k,
      new Param(),
    ]),
  );
  port = { postMessage: vi.fn(), close: vi.fn() };
  connect = vi.fn();
  disconnect = vi.fn();
  constructor(
    _ctx: unknown,
    _name: string,
    readonly options: unknown,
  ) {
    Worklet.instances.push(this);
  }
}
function fixture() {
  const bus = { gain: new Param(), connect: vi.fn(), disconnect: vi.fn() };
  const ctx = {
    state: "running",
    currentTime: 0,
    sampleRate: 48000,
    createGain: () => bus,
    audioWorklet: {
      addModule: vi.fn(async (_url: string): Promise<void> => {}),
    },
  };
  return {
    ctx,
    owner: new EnvironmentAudio(
      ctx as unknown as AudioContext,
      bus as unknown as GainNode,
      bus as unknown as GainNode,
    ),
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  Worklet.instances = [];
});
it("requires opt-in preparation, admits two logical beds, avoids UI automation churn and tears down", async () => {
  vi.stubGlobal("AudioWorkletNode", Worklet);
  const { owner, ctx } = fixture();
  const options = {
    seed: 42,
    level: 0.1,
    filterHz: 420,
    profile: "weather-evolving-1" as const,
    texture: "wind" as const,
  };
  expect(owner.setBed("wind", options)).toBe(false);
  await owner.prepareEvolvingProfile();
  expect(ctx.audioWorklet.addModule.mock.calls[0][0]).toContain(
    "environment-texture-worklet.js?no-inline",
  );
  expect(owner.setBed("wind", options)).toBe(true);
  const node = Worklet.instances[0];
  for (let i = 0; i < 100; i++) {
    ctx.currentTime += 0.1;
    expect(owner.setBed("wind", options)).toBe(true);
  }
  expect(node.parameters.get("level")!.setValueAtTime).toHaveBeenCalledTimes(1);
  expect(owner.setBed("rain", { ...options, texture: "rain" })).toBe(true);
  expect(owner.setBed("third", options)).toBe(false);
  expect(owner.readResources()).toEqual({
    logicalBeds: 2,
    legacyBufferBytes: 0,
    evolvingProcessors: 2,
    internalTextureLayers: 4,
    effects: 0,
    processorFailures: 0,
  });
  owner.stop();
  for (const n of Worklet.instances) {
    expect(n.port.postMessage).toHaveBeenCalledWith("stop");
    expect(n.port.close).toHaveBeenCalledTimes(1);
    expect(n.disconnect).toHaveBeenCalledTimes(1);
  }
  expect(owner.readResources().logicalBeds).toBe(0);
  owner.dispose();
  expect(owner.setBed("wind", options)).toBe(false);
});
it("rejects malformed new options without allocating and cancels stale preparation", async () => {
  vi.stubGlobal("AudioWorkletNode", Worklet);
  const { owner, ctx } = fixture();
  let resolve!: () => void;
  ctx.audioWorklet.addModule.mockImplementation(
    () =>
      new Promise<void>((r) => {
        resolve = r;
      }),
  );
  const pending = owner.prepareEvolvingProfile();
  owner.dispose();
  resolve();
  await expect(pending).rejects.toThrow(/cancelled/);
  expect(Worklet.instances).toHaveLength(0);
  const fresh = fixture();
  await fresh.owner.prepareEvolvingProfile();
  const o = {
    seed: 1,
    level: 0.1,
    filterHz: 420,
    profile: "weather-evolving-1" as const,
    texture: "wind" as const,
  };
  expect(fresh.owner.setBed("wind", { ...o, gustiness: Infinity })).toBe(false);
  expect(fresh.owner.setBed("wind", { ...o, activity: -1 })).toBe(false);
  expect(Worklet.instances).toHaveLength(0);
});

it("reports a processor fault and bounds retries until an explicit stop", async () => {
  vi.stubGlobal("AudioWorkletNode", Worklet);
  const { owner } = fixture();
  await owner.prepareEvolvingProfile();
  const o = {
    seed: 1,
    level: 0.1,
    filterHz: 420,
    profile: "weather-evolving-1" as const,
    texture: "wind" as const,
  };
  expect(owner.setBed("wind", o)).toBe(true);
  Worklet.instances[0].onprocessorerror!();
  expect(owner.readResources().processorFailures).toBe(1);
  expect(owner.readResources().logicalBeds).toBe(0);
  for (let i = 0; i < 100; i++) expect(owner.setBed("wind", o)).toBe(false);
  expect(Worklet.instances).toHaveLength(1);
  owner.stop();
  expect(owner.setBed("wind", o)).toBe(true);
  owner.dispose();
});
