import { afterEach, expect, it, vi } from "vitest";
import { createBlankScore } from "@onepage/project";
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

it("streams held notes with one context, drains tails and rejects stale epochs", async () => {
  vi.stubGlobal("AudioContext", Context);
  let pump = () => {};
  const score = createBlankScore(),
    engine = new AudioEngine();
  const epoch = await engine.beginStream({
    bpm: 120,
    tracks: score.tracks,
    patches: score.patches,
    ticker: (cb) => {
      pump = cb;
      return () => {};
    },
  });
  const n = {
    id: "held",
    trackId: score.tracks[0].id,
    patchId: score.patches[0].id,
    startTick: 0,
    durationTicks: 2400,
    pitch: 60,
    velocity: 0.5,
    gain: score.tracks[0].gain,
    pan: score.tracks[0].pan,
    priority: 1,
    optional: false,
  };
  expect(
    engine.submitStreamWindow({
      epoch,
      revision: 0,
      id: "first",
      startTick: 0,
      endTick: 1920,
      notes: [n],
    }).status,
  ).toBe("accepted");
  const ctx = Context.instances[0];
  ctx.currentTime = 0.2;
  pump();
  expect(ctx.sources).toHaveLength(1);
  expect(ctx.sources[0].start).toHaveBeenCalledWith(0.3);
  expect(ctx.sources[0].stop.mock.calls[0][0]).toBeGreaterThan(2.8);
  expect(
    engine.submitStreamWindow({
      epoch,
      revision: 0,
      id: "rest",
      startTick: 1920,
      endTick: 3840,
      notes: [],
    }).status,
  ).toBe("accepted");
  ctx.currentTime = 2;
  pump();
  expect(ctx.sources).toHaveLength(1);
  expect(engine.setRoleGain(score.tracks[0].role, 0.4)).toBe(true);
  const receipts = engine.drainStreamReceipts();
  expect(receipts.find((r) => r.status === "scheduled")?.note).toEqual(n);
  expect(receipts.find((r) => r.status === "gain")?.atContextTime).toBe(2);
  engine.endStream();
  ctx.currentTime = 5;
  pump();
  expect(engine.isPlaying).toBe(false);
  expect(
    engine.submitStreamWindow({
      epoch,
      revision: 0,
      id: "stale",
      startTick: 3840,
      endTick: 5760,
      notes: [],
    }).status,
  ).toBe("rejected");
  expect(Context.instances).toHaveLength(1);
  await engine.dispose();
});
it("declines mandatory overload atomically and drops optional overload without stopping stream", async () => {
  vi.stubGlobal("AudioContext", Context);
  let pump = () => {};
  const engine = new AudioEngine(),
    score = createBlankScore();
  const epoch = await engine.beginStream({
    bpm: 120,
    tracks: score.tracks,
    patches: score.patches,
    ticker: (cb) => {
      pump = cb;
      return () => {};
    },
  });
  const notes = Array.from({ length: 257 }, (_, i) => ({
    id: `n${i}`,
    trackId: score.tracks[0].id,
    patchId: score.patches[0].id,
    startTick: 0,
    durationTicks: 480,
    pitch: 60,
    velocity: 0.2,
    gain: score.tracks[0].gain,
    pan: score.tracks[0].pan,
    priority: i % 256,
    optional: false,
  }));
  expect(
    engine.submitStreamWindow({
      epoch,
      id: "too-many",
      revision: 0,
      startTick: 0,
      endTick: 1920,
      notes,
    }).reason,
  ).toBe("mandatory-capacity");
  expect(engine.readTransport().queuedNotes).toBe(0);
  notes[256].optional = true;
  expect(
    engine.submitStreamWindow({
      epoch,
      id: "bounded",
      revision: 0,
      startTick: 0,
      endTick: 1920,
      notes,
    }).status,
  ).toBe("accepted");
  Context.instances[0].currentTime = 0.2;
  pump();
  expect(engine.activeVoiceCount).toBe(256);
  expect(engine.isPlaying).toBe(true);
  expect(
    engine.drainStreamReceipts().some((r) => r.reason === "optional-capacity"),
  ).toBe(true);
  await engine.dispose();
});
it("rechecks current audio time for a replacement racing the pump and skips elapsed notes", async () => {
  vi.stubGlobal("AudioContext", Context);
  let pump = () => {};
  const engine = new AudioEngine(),
    score = createBlankScore();
  const epoch = await engine.beginStream({
    bpm: 120,
    tracks: score.tracks,
    patches: score.patches,
    ticker: (cb) => {
      pump = cb;
      return () => {};
    },
  });
  const n = {
    id: "n",
    trackId: score.tracks[0].id,
    patchId: score.patches[0].id,
    startTick: 0,
    durationTicks: 480,
    pitch: 60,
    velocity: 0.5,
    gain: score.tracks[0].gain,
    pan: score.tracks[0].pan,
    priority: 1,
    optional: false,
  };
  const first = {
    epoch,
    id: "a",
    revision: 0,
    startTick: 0,
    endTick: 3840,
    notes: [n],
  };
  expect(engine.submitStreamWindow(first).status).toBe("accepted");
  const ctx = Context.instances[0];
  ctx.currentTime = 2.2;
  expect(
    engine.submitStreamWindow({
      epoch,
      id: "race",
      revision: 1,
      startTick: 1920,
      endTick: 3840,
      notes: [],
    }).reason,
  ).toBe("deadline");
  pump();
  expect(ctx.sources).toHaveLength(0);
  expect(
    engine
      .drainStreamReceipts()
      .some((r) => r.status === "skipped" && r.noteId === "n"),
  ).toBe(true);
  expect(engine.submitStreamWindow(first).reason).toBe("duplicate");
  expect(engine.isPlaying).toBe(true);
  await engine.dispose();
});
it("shared preview admission cannot consume reservations for pending stream voices", async () => {
  vi.stubGlobal("AudioContext", Context);
  const engine = new AudioEngine(),
    score = createBlankScore();
  const epoch = await engine.beginStream({
    bpm: 120,
    tracks: score.tracks,
    patches: score.patches,
    ticker: () => () => {},
  });
  const notes = Array.from({ length: 256 }, (_, i) => ({
    id: `reserved-${i}`,
    trackId: score.tracks[0].id,
    patchId: score.patches[0].id,
    startTick: 0,
    durationTicks: 480,
    pitch: 60,
    velocity: 0.1,
    gain: score.tracks[0].gain,
    pan: score.tracks[0].pan,
    priority: 1,
    optional: false,
  }));
  expect(
    engine.submitStreamWindow({
      epoch,
      id: "reserved",
      revision: 0,
      startTick: 0,
      endTick: 1920,
      notes,
    }).status,
  ).toBe("accepted");
  expect(engine.tryPreviewNote(score.patches[0], 72)).toBeNull();
  expect(engine.isPlaying).toBe(true);
  await engine.dispose();
});
it("role automation fallback uses the interpolated gain when retargeting an active ramp", async () => {
  vi.stubGlobal("AudioContext", Context);
  const engine = new AudioEngine(),
    score = createBlankScore();
  await engine.beginStream({
    bpm: 120,
    tracks: score.tracks,
    patches: score.patches,
    ticker: () => () => {},
  });
  const ctx = Context.instances[0];
  ctx.currentTime = 0.3;
  engine.setRoleGain(score.tracks[0].role, 0, 1);
  ctx.currentTime = 0.8;
  engine.setRoleGain(score.tracks[0].role, 1, 1);
  // Master gain is first; next gain is the first role bus.
  expect(ctx.gains[1].gain.setValueAtTime).toHaveBeenLastCalledWith(0.5, 0.8);
  await engine.dispose();
});
it("reserves nodes created ahead of onset, not only acoustically overlapping voices", async () => {
  vi.stubGlobal("AudioContext", Context);
  let pump = () => {};
  const engine = new AudioEngine(),
    score = createBlankScore();
  score.patches[0].release = 0.005;
  const epoch = await engine.beginStream({
    bpm: 120,
    tracks: score.tracks,
    patches: score.patches,
    ticker: (cb) => {
      pump = cb;
      return () => {};
    },
  });
  const notes = Array.from({ length: 300 }, (_, i) => ({
    id: `short-${i}`,
    trackId: score.tracks[0].id,
    patchId: score.patches[0].id,
    startTick: Math.floor(i / 2),
    durationTicks: 1,
    pitch: 60,
    velocity: 0.1,
    gain: score.tracks[0].gain,
    pan: score.tracks[0].pan,
    priority: 1,
    optional: false,
  }));
  expect(
    engine.submitStreamWindow({
      epoch,
      id: "node-budget",
      revision: 0,
      startTick: 0,
      endTick: 1920,
      notes,
    }).reason,
  ).toBe("mandatory-capacity");
  Context.instances[0].currentTime = 0.3;
  pump();
  expect(engine.activeVoiceCount).toBe(0);
  expect(engine.isPlaying).toBe(true);
  await engine.dispose();
});
it("explicitly retires only optional releasing tails and retains node capacity through fade", async () => {
  vi.stubGlobal("AudioContext", Context);
  let pump = () => {};
  const engine = new AudioEngine(),
    score = createBlankScore();
  score.patches[0].release = 1;
  const epoch = await engine.beginStream({
    bpm: 120,
    tracks: score.tracks,
    patches: score.patches,
    ticker: (cb) => {
      pump = cb;
      return () => {};
    },
  });
  const notes = [false, true].map((optional, i) => ({
    id: `tail-${i}`,
    trackId: score.tracks[0].id,
    patchId: score.patches[0].id,
    startTick: 0,
    durationTicks: 480,
    pitch: 60,
    velocity: 0.1,
    gain: score.tracks[0].gain,
    pan: score.tracks[0].pan,
    priority: 1,
    optional,
  }));
  engine.submitStreamWindow({
    epoch,
    id: "tails",
    revision: 0,
    startTick: 0,
    endTick: 1920,
    notes,
  });
  const ctx = Context.instances[0];
  ctx.currentTime = 0.2;
  pump();
  expect(engine.retireOptionalTail()).toBe(false);
  ctx.currentTime = 0.85;
  expect(engine.retireOptionalTail()).toBe(true);
  expect(engine.activeVoiceCount).toBe(2);
  expect(engine.retireOptionalTail()).toBe(false);
  ctx.currentTime = 0.861;
  expect(engine.activeVoiceCount).toBe(1);
  const receipts = engine.drainStreamReceipts();
  expect(
    receipts.filter((r) => r.status === "stolen").map((r) => r.noteId),
  ).toEqual(["tail-1"]);
  expect(engine.isPlaying).toBe(true);
  await engine.dispose();
});
it("reports output clock availability and rejects stale correlation samples", async () => {
  vi.stubGlobal("AudioContext", Context);
  const engine = new AudioEngine(),
    score = createBlankScore();
  await engine.beginStream({
    bpm: 120,
    tracks: score.tracks,
    patches: score.patches,
    ticker: () => () => {},
  });
  expect(engine.readOutputClock().status).toBe("unavailable");
  const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
  Object.assign(Context.instances[0], {
    getOutputTimestamp: () => ({ contextTime: 0.5, performanceTime: 950 }),
  });
  expect(engine.readOutputClock().status).toBe("valid");
  Object.assign(Context.instances[0], {
    getOutputTimestamp: () => ({ contextTime: 0.5, performanceTime: 200 }),
  });
  expect(engine.readOutputClock().status).toBe("stale");
  clock.mockRestore();
  await engine.dispose();
});
it("rejects preroll expression so captured automation never starts before its take", async () => {
  vi.stubGlobal("AudioContext", Context);
  const engine = new AudioEngine(),
    score = createBlankScore();
  await engine.beginStream({
    bpm: 120,
    tracks: score.tracks,
    patches: score.patches,
    ticker: () => () => {},
  });
  expect(engine.setRoleGain(score.tracks[0].role, 0.25)).toBe(false);
  expect(engine.drainStreamReceipts().some((r) => r.status === "gain")).toBe(
    false,
  );
  Context.instances[0].currentTime = engine.readTransport().origin;
  expect(engine.setRoleGain(score.tracks[0].role, 0.25)).toBe(true);
  expect(
    engine.drainStreamReceipts().find((r) => r.status === "gain")
      ?.atContextTime,
  ).toBe(engine.readTransport().origin);
  await engine.dispose();
});
it("inherited legacy playback and device lifecycle cancel the extension on the same owner", async () => {
  vi.stubGlobal("AudioContext", Context);
  const score = createBlankScore(),
    engine = new AudioEngine();
  const cancel = vi.fn();
  const epoch = await engine.beginStream({
    bpm: 120,
    tracks: score.tracks,
    patches: score.patches,
    ticker: () => cancel,
  });
  await engine.play(score, { loop: true });
  expect(cancel).toHaveBeenCalledOnce();
  expect(Context.instances).toHaveLength(1);
  expect(
    engine.submitStreamWindow({
      epoch,
      id: "old",
      revision: 0,
      startTick: 0,
      endTick: 1920,
      notes: [],
    }).reason,
  ).toBe("no-stream");
  const before = engine.readTransport().epoch;
  const ctx = Context.instances[0];
  ctx.state = "suspended";
  ctx.onstatechange?.();
  expect(engine.isPlaying).toBe(false);
  expect(engine.readTransport().epoch).toBeGreaterThan(before);
  await engine.dispose();
});

it("recovers an underrun at a future whole bar on the original clock", async () => {
  vi.stubGlobal("AudioContext", Context);
  const engine = new AudioEngine(),
    score = createBlankScore();
  let pump = () => {};
  const epoch = await engine.beginStream({
    bpm: 120,
    tracks: score.tracks,
    patches: score.patches,
    ticker: (cb) => {
      pump = cb;
      return () => {};
    },
  });
  const window = {
    epoch,
    id: "first",
    revision: 0,
    startTick: 0,
    endTick: 1920,
    notes: [],
  };
  engine.submitStreamWindow(window);
  const origin = engine.readTransport().origin;
  Context.instances[0].currentTime = origin + 3;
  pump();
  expect(
    engine.submitStreamWindow({
      ...window,
      id: "late",
      startTick: 1920,
      endTick: 3840,
    }).reason,
  ).toBe("deadline");
  expect(engine.recoverStreamAt(1920)).toBe(false);
  expect(engine.recoverStreamAt(3840)).toBe(true);
  expect(engine.readTransport().origin).toBe(origin);
  expect(
    engine.submitStreamWindow({
      ...window,
      id: "recovered",
      startTick: 3840,
      endTick: 5760,
    }).status,
  ).toBe("accepted");
  expect(
    engine.drainStreamReceipts().some((r) => r.reason === "coverage-recovery"),
  ).toBe(true);
  engine.endStream();
  expect(engine.recoverStreamAt(7680)).toBe(false);
  Context.instances[0].currentTime = origin + 7;
  pump();
  expect(engine.isPlaying).toBe(false);
  await engine.dispose();
});
it("keeps accepting dense bars beyond old session byte, event and window quotas", async () => {
  vi.stubGlobal("AudioContext", Context);
  const engine = new AudioEngine(),
    score = createBlankScore();
  let pump = () => {};
  const epoch = await engine.beginStream({
    bpm: 120,
    tracks: score.tracks,
    patches: score.patches,
    ticker: (cb) => {
      pump = cb;
      return () => {};
    },
  });
  const origin = engine.readTransport().origin;
  for (let bar = 0; bar < 4200; bar++) {
    const notes = Array.from({ length: 12 }, (_, i) => ({
      id: `n-${bar}-${i}`,
      trackId: score.tracks[0].id,
      patchId: score.patches[0].id,
      startTick: bar * 1920 + i * 120,
      durationTicks: 60,
      pitch: 60,
      velocity: 0.1,
      gain: score.tracks[0].gain,
      pan: score.tracks[0].pan,
      priority: 1,
      optional: false,
    }));
    expect(
      engine.submitStreamWindow({
        epoch,
        id: `bar-${bar}`,
        revision: bar,
        startTick: bar * 1920,
        endTick: (bar + 1) * 1920,
        notes,
      }).status,
    ).toBe("accepted");
    Context.instances[0].currentTime = origin + (bar + 1) * 2 - 0.2;
    pump();
    engine.drainStreamReceipts();
  }
  await engine.dispose();
});
it("admits effects alongside sequential queued notes but rejects overlapping required overflow atomically", async () => {
  vi.stubGlobal("AudioContext", Context);
  const engine = new AudioEngine(),
    score = createBlankScore();
  score.patches[0].release = 0.005;
  const epoch = await engine.beginStream({
    bpm: 120,
    tracks: score.tracks,
    patches: score.patches,
    ticker: () => () => {},
  });
  const note = (i: number, startTick: number) => ({
    id: `n-${i}`,
    trackId: score.tracks[0].id,
    patchId: score.patches[0].id,
    startTick,
    durationTicks: 1,
    pitch: 60,
    velocity: 0.1,
    gain: score.tracks[0].gain,
    pan: score.tracks[0].pan,
    priority: 1,
    optional: false,
  });
  expect(
    engine.submitStreamWindow({
      epoch,
      id: "sequential",
      revision: 0,
      startTick: 0,
      endTick: 1920,
      notes: Array.from({ length: 300 }, (_, i) => note(i, i * 6)),
    }).status,
  ).toBe("accepted");
  expect(engine.tryPreviewNote(score.patches[0], 72, 0.1, 4)).not.toBeNull();
  const before = engine.readTransport();
  expect(
    engine.submitStreamWindow({
      epoch,
      id: "overlap",
      revision: 1,
      startTick: 0,
      endTick: 1920,
      notes: Array.from({ length: 256 }, (_, i) => note(i, 0)),
    }).reason,
  ).toBe("mandatory-capacity");
  expect(engine.readTransport()).toEqual(before);
  await engine.dispose();
});

it("overlay rejection is atomic, preserves coverage and emits timed scheduled evidence only on success", async () => {
  vi.stubGlobal("AudioContext", Context);
  const engine = new AudioEngine(),
    score = createBlankScore();
  await engine.beginStream({
    bpm: 120,
    tracks: score.tracks,
    patches: score.patches,
    ticker: () => () => {},
  });
  const ctx = Context.instances[0];
  ctx.currentTime = 0.2;
  const n = {
    id: "overlay-ok",
    trackId: score.tracks[0].id,
    patchId: score.patches[0].id,
    startTick: 0,
    durationTicks: 120,
    pitch: 72,
    velocity: 0.3,
    gain: score.tracks[0].gain,
    pan: score.tracks[0].pan,
    priority: 10,
    optional: true,
  };
  const before = engine.readTransport();
  engine.drainStreamReceipts();
  expect(
    engine.submitStreamOverlay(
      [n, { ...n, id: "bad", pitch: 128 }],
      "weather-stinger",
    ),
  ).toBe(false);
  expect(ctx.sources).toHaveLength(0);
  expect(engine.readTransport()).toEqual(before);
  expect(engine.drainStreamReceipts()).toEqual([]);
  expect(
    engine.submitStreamOverlay(
      [n, { ...n, id: "late", startTick: 200 }],
      "weather-stinger",
    ),
  ).toBe(false);
  expect(ctx.sources).toHaveLength(0);
  expect(engine.readTransport()).toEqual(before);
  expect(engine.submitStreamOverlay([n], "weather-stinger")).toBe(true);
  expect(ctx.sources).toHaveLength(1);
  const receipt = engine.drainStreamReceipts()[0];
  expect(receipt).toMatchObject({
    status: "scheduled",
    reason: "weather-stinger",
    atContextTime: 0.3,
    observedAtContextTime: 0.2,
    tick: 0,
    note: n,
  });
  expect(engine.readTransport().preparedThrough).toBe(before.preparedThrough);
  expect(engine.readTransport().queuedNotes).toBe(before.queuedNotes);
  expect(engine.submitStreamOverlay([n])).toBe(false);
  await engine.dispose();
});

it("overlay reservation overload rejects the entire batch without allocating nodes or mutating stream coverage", async () => {
  vi.stubGlobal("AudioContext", Context);
  const engine = new AudioEngine(),
    score = createBlankScore();
  const epoch = await engine.beginStream({
    bpm: 120,
    tracks: score.tracks,
    patches: score.patches,
    ticker: () => () => {},
  });
  const n = {
    id: "reserved-base",
    trackId: score.tracks[0].id,
    patchId: score.patches[0].id,
    startTick: 0,
    durationTicks: 480,
    pitch: 60,
    velocity: 0.1,
    gain: score.tracks[0].gain,
    pan: score.tracks[0].pan,
    priority: 100,
    optional: false,
  };
  engine.submitStreamWindow({
    epoch,
    id: "full",
    revision: 0,
    startTick: 0,
    endTick: 1920,
    notes: Array.from({ length: 255 }, (_, i) => ({
      ...n,
      id: `reserve-${i}`,
    })),
  });
  const ctx = Context.instances[0];
  ctx.currentTime = 0.2;
  const before = engine.readTransport();
  engine.drainStreamReceipts();
  expect(
    engine.submitStreamOverlay(
      [
        { ...n, id: "ack-a", optional: true },
        { ...n, id: "ack-b", optional: true },
      ],
      "ui-acknowledgement",
    ),
  ).toBe(false);
  expect(ctx.sources).toHaveLength(0);
  expect(engine.readTransport()).toEqual(before);
  expect(engine.drainStreamReceipts()).toEqual([]);
  expect(
    engine.submitStreamOverlay(
      [{ ...n, id: "ack-a", optional: true }],
      "ui-acknowledgement",
    ),
  ).toBe(true);
  expect(ctx.sources).toHaveLength(1);
  expect(engine.drainStreamReceipts()[0].reason).toBe("ui-acknowledgement");
  await engine.dispose();
});

it("auditions kept audio on the same owner and cancels it when another stream starts", async () => {
  vi.stubGlobal("AudioContext", Context);
  const engine = new AudioEngine(),
    score = createBlankScore();
  const cancel = vi.fn();
  await engine.beginStream({
    bpm: 120,
    tracks: score.tracks,
    patches: score.patches,
    ticker: () => cancel,
  });
  const buffer = {
    duration: 2,
    length: 96000,
    numberOfChannels: 2,
  } as AudioBuffer;
  await engine.auditionBuffer(buffer);
  expect(cancel).toHaveBeenCalledOnce();
  expect(Context.instances).toHaveLength(1);
  const source = Context.instances[0].sources[0];
  expect(source.buffer).toBe(buffer);
  expect(source.start).toHaveBeenCalledOnce();
  expect(engine.isPlaying).toBe(true);
  await engine.beginStream({
    bpm: 120,
    tracks: score.tracks,
    patches: score.patches,
    ticker: () => () => {},
  });
  expect(source.stop).toHaveBeenCalledOnce();
  expect(source.disconnect).toHaveBeenCalled();
  // A stale natural-end callback cannot cancel the newer owner epoch.
  source.onended?.();
  expect(engine.isPlaying).toBe(true);
  await engine.dispose();
});

it("cancels an audition pending enable before it can allocate a source", async () => {
  vi.stubGlobal("AudioContext", Context);
  const engine = new AudioEngine();
  let release!: () => void;
  const enabled = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(engine, "enable").mockImplementation(async () => {
    await enabled;
  });
  const pending = engine.auditionBuffer({
    duration: 1,
    length: 48000,
    numberOfChannels: 1,
  } as AudioBuffer);
  engine.stop();
  release();
  await pending;
  expect(Context.instances).toHaveLength(0);
  expect(engine.isPlaying).toBe(false);
  await engine.dispose();
});
it("rejects malformed overlay start times atomically without throwing", async () => {
  vi.stubGlobal("AudioContext", Context);
  const engine = new AudioEngine(),
    score = createBlankScore();
  await engine.beginStream({
    bpm: 120,
    tracks: score.tracks,
    patches: score.patches,
    ticker: () => () => {},
  });
  Context.instances[0].currentTime = 0.2;
  const before = engine.readTransport();
  for (const startTick of [NaN, -1, 0.5, Infinity]) {
    const note = {
      id: "invalid-start",
      trackId: score.tracks[0].id,
      patchId: score.patches[0].id,
      startTick,
      durationTicks: 120,
      pitch: 72,
      velocity: 0.3,
      gain: score.tracks[0].gain,
      pan: score.tracks[0].pan,
      priority: 10,
      optional: true,
    };
    expect(engine.submitStreamOverlay([note])).toBe(false);
  }
  expect(Context.instances[0].sources).toHaveLength(0);
  expect(engine.readTransport()).toEqual(before);
  await engine.dispose();
});
it("retargets expression beyond the former lifetime quota and records explicit preroll gain", async () => {
  vi.stubGlobal("AudioContext", Context);
  const engine = new AudioEngine(),
    score = createBlankScore();
  await engine.beginStream({
    bpm: 120,
    tracks: score.tracks,
    patches: score.patches,
    ticker: () => () => {},
  });
  expect(engine.setRoleGain(score.tracks[0].role, 0, 0, true)).toBe(true);
  expect(
    engine.drainStreamReceipts().find((r) => r.status === "gain")
      ?.atContextTime,
  ).toBe(engine.readTransport().origin);
  const ctx = Context.instances[0];
  ctx.currentTime = 0.3;
  for (let i = 0; i < 3000; i++) {
    ctx.currentTime += 0.001;
    expect(engine.setRoleGain(score.tracks[0].role, i % 2, 0.03)).toBe(true);
    engine.drainStreamReceipts();
  }
  expect(
    ctx.gains[1].gain.setValueAtTime.mock.calls.at(-1)?.[0],
  ).toBeGreaterThan(0);
  expect(ctx.gains[1].gain.setValueAtTime.mock.calls.at(-1)?.[0]).toBeLessThan(
    1,
  );
  await engine.dispose();
});

it("uses the selected renderer with stable note identity and releases its context on stop", async () => {
  vi.stubGlobal("AudioContext", Context);
  const engine = new AudioEngine(),
    score = createBlankScore();
  const stopVoice = vi.fn();
  const renderer = {
    id: "test-instrument",
    maxVoices: 2,
    releaseSeconds: vi.fn(() => 1),
    prepareContext: vi.fn(async (_context: BaseAudioContext) => {}),
    releaseContext: vi.fn(),
    renderVoice: vi.fn(
      (
        _ctx: BaseAudioContext,
        _dest: AudioNode,
        _patch: (typeof score.patches)[number],
        _pitch: number,
        _velocity: number,
        start: number,
        duration: number,
        _gain?: number,
        _pan?: number,
        _id?: string,
      ) => ({ stop: stopVoice, end: start + duration + 1 }),
    ),
  };
  engine.setVoiceRenderer(renderer);
  let pump = () => {};
  const epoch = await engine.beginStream({
    bpm: 120,
    tracks: score.tracks,
    patches: score.patches,
    ticker: (cb) => {
      pump = cb;
      return () => {};
    },
  });
  expect(renderer.prepareContext).toHaveBeenCalledWith(Context.instances[0]);
  expect(() => engine.setVoiceRenderer(null)).toThrow(/Stop/);
  const note = {
    id: "captured-note-identity",
    trackId: score.tracks[0].id,
    patchId: score.patches[0].id,
    startTick: 0,
    durationTicks: 120,
    pitch: 67,
    velocity: 0.4,
    gain: score.tracks[0].gain,
    pan: score.tracks[0].pan,
    priority: 100,
    optional: false,
  };
  expect(
    engine.submitStreamWindow({
      epoch,
      id: "custom",
      revision: 0,
      startTick: 0,
      endTick: 1920,
      notes: [note],
    }).status,
  ).toBe("accepted");
  Context.instances[0].currentTime = 0.2;
  pump();
  expect(renderer.renderVoice).toHaveBeenCalledOnce();
  expect(renderer.renderVoice.mock.calls[0].slice(3)).toEqual([
    67,
    0.4,
    0.3,
    0.125,
    score.tracks[0].gain,
    score.tracks[0].pan,
    "captured-note-identity",
  ]);
  expect(Context.instances[0].sources).toHaveLength(0);
  engine.stop();
  expect(stopVoice).toHaveBeenCalled();
  expect(renderer.releaseContext).toHaveBeenCalledExactlyOnceWith(
    Context.instances[0],
  );
  engine.stop();
  expect(renderer.releaseContext).toHaveBeenCalledOnce();
  engine.setVoiceRenderer(null);
  await engine.dispose();
});

it("reserves custom instrument release tails and rejects required overflow atomically", async () => {
  vi.stubGlobal("AudioContext", Context);
  const engine = new AudioEngine(),
    score = createBlankScore();
  score.patches[0].release = 0.005;
  const renderer = {
    id: "long-tail",
    maxVoices: 1,
    releaseSeconds: () => 2,
    renderVoice: vi.fn(() => ({ stop: vi.fn(), end: 3 })),
  };
  engine.setVoiceRenderer(renderer);
  const epoch = await engine.beginStream({
    bpm: 120,
    tracks: score.tracks,
    patches: score.patches,
    ticker: () => () => {},
  });
  const note = {
    id: "first",
    trackId: score.tracks[0].id,
    patchId: score.patches[0].id,
    startTick: 0,
    durationTicks: 120,
    pitch: 60,
    velocity: 0.4,
    gain: score.tracks[0].gain,
    pan: score.tracks[0].pan,
    priority: 100,
    optional: false,
  };
  const before = engine.readTransport();
  // Musical gates do not overlap, but the declared instrument releases do.
  expect(
    engine.submitStreamWindow({
      epoch,
      id: "tails",
      revision: 0,
      startTick: 0,
      endTick: 1920,
      notes: [note, { ...note, id: "second", startTick: 960 }],
    }).reason,
  ).toBe("mandatory-capacity");
  expect(engine.readTransport()).toEqual(before);
  expect(renderer.renderVoice).not.toHaveBeenCalled();
  expect(
    engine.submitStreamWindow({
      epoch,
      id: "one",
      revision: 0,
      startTick: 0,
      endTick: 1920,
      notes: [note],
    }).status,
  ).toBe("accepted");
  await engine.dispose();
});

it("releases a prepared instrument when stop cancels asynchronous stream preparation", async () => {
  vi.stubGlobal("AudioContext", Context);
  const engine = new AudioEngine(),
    score = createBlankScore();
  let finish!: () => void;
  const preparing = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const renderer = {
    id: "async-instrument",
    releaseSeconds: () => 0.1,
    prepareContext: vi.fn(() => preparing),
    releaseContext: vi.fn(),
    renderVoice: vi.fn(() => ({ stop: vi.fn(), end: 1 })),
  };
  engine.setVoiceRenderer(renderer);
  const pending = engine.beginStream({
    bpm: 120,
    tracks: score.tracks,
    patches: score.patches,
    ticker: () => () => {},
  });
  await vi.waitFor(() =>
    expect(renderer.prepareContext).toHaveBeenCalledOnce(),
  );
  engine.stop();
  finish();
  await expect(pending).rejects.toThrow(/cancelled/);
  expect(engine.isPlaying).toBe(false);
  expect(renderer.renderVoice).not.toHaveBeenCalled();
  expect(renderer.releaseContext).toHaveBeenCalledExactlyOnceWith(
    Context.instances[0],
  );
  await engine.dispose();
});

it("finishes cancelled instrument cleanup before preparing a replacement on the shared context", async () => {
  vi.stubGlobal("AudioContext", Context);
  const engine = new AudioEngine(),
    score = createBlankScore();
  let finish!: () => void;
  const preparing = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const old = {
    id: "old",
    releaseSeconds: () => 0.1,
    prepareContext: vi.fn(() => preparing),
    releaseContext: vi.fn(),
    renderVoice: vi.fn(() => ({ stop: vi.fn(), end: 1 })),
  };
  const next = {
    id: "next",
    releaseSeconds: () => 0.1,
    prepareContext: vi.fn(async () => {}),
    releaseContext: vi.fn(),
    renderVoice: vi.fn(() => ({ stop: vi.fn(), end: 1 })),
  };
  const config = {
    bpm: 120,
    tracks: score.tracks,
    patches: score.patches,
    ticker: () => () => {},
  };
  engine.setVoiceRenderer(old);
  const cancelled = engine.beginStream(config);
  const cancellation = expect(cancelled).rejects.toThrow(/cancelled/);
  await vi.waitFor(() => expect(old.prepareContext).toHaveBeenCalledOnce());
  engine.stop();
  engine.setVoiceRenderer(next);
  const replacement = engine.beginStream(config);
  await Promise.resolve();
  expect(next.prepareContext).not.toHaveBeenCalled();
  finish();
  await cancellation;
  await replacement;
  expect(old.releaseContext).toHaveBeenCalledOnce();
  expect(next.prepareContext).toHaveBeenCalledOnce();
  expect(old.releaseContext.mock.invocationCallOrder[0]).toBeLessThan(
    next.prepareContext.mock.invocationCallOrder[0],
  );
  expect(next.releaseContext).not.toHaveBeenCalled();
  expect(engine.isPlaying).toBe(true);
  engine.stop();
  expect(next.releaseContext).toHaveBeenCalledOnce();
  await engine.dispose();
});
