import { afterEach, expect, it, vi } from "vitest";
import scoreData from "../../../examples/game-m2/score.json";
import { M2Audio, type M2AudioEngine, type Score } from "./m2-audio";
const score = scoreData as Score;
function device() {
  return {
    currentTime: 0,
    activeVoiceCount: 0,
    enable: vi.fn(async () => {}),
    play: vi.fn(async () => {}),
    setEnergy: vi.fn(),
    previewNote: vi.fn(() => vi.fn()),
    stop: vi.fn(),
    dispose: vi.fn(async () => {}),
  } satisfies M2AudioEngine;
}
const instances: M2Audio[] = [];
afterEach(async () => {
  for (const audio of instances.splice(0)) await audio.dispose();
});
function coordinator(engine = device(), onError = vi.fn()) {
  const audio = new M2Audio({ score, engine, onError });
  instances.push(audio);
  return { audio, engine, onError };
}
it("unlocks by gesture, excludes audition, layers without restarting, mutes all buses", async () => {
  const stopAudition = vi.fn(),
    engine = device();
  const audio = new M2Audio({ score, engine, stopAudition });
  instances.push(audio);
  await audio.resume();
  expect(engine.play).not.toHaveBeenCalled();
  expect(await audio.unlock()).toBe(true);
  expect(stopAudition).toHaveBeenCalledOnce();
  expect(engine.play).toHaveBeenCalledOnce();
  audio.setEncounter(true);
  audio.setEncounter(false);
  expect(engine.setEnergy.mock.calls).toEqual([[2], [1]]);
  expect(engine.play).toHaveBeenCalledOnce();
  audio.effect("jump-1", score.patches[0], 64);
  audio.dialogue("line-1", score.patches[0]);
  expect(engine.previewNote).toHaveBeenCalledTimes(2);
  audio.setMuted(true);
  for (const result of engine.previewNote.mock.results)
    expect(result.value).toHaveBeenCalledOnce();
  audio.effect("jump-2", score.patches[0], 64);
  expect(engine.previewNote).toHaveBeenCalledTimes(2);
  audio.setMuted(false);
  await Promise.resolve();
  expect(engine.play).toHaveBeenCalledTimes(2);
});
it("reports rejected unlock, preserves device unlock through pause, and rejects late disposal", async () => {
  const { audio, engine, onError } = coordinator();
  engine.enable.mockRejectedValueOnce(new Error("gesture rejected"));
  expect(await audio.unlock()).toBe(false);
  expect(onError).toHaveBeenCalledWith(
    expect.stringContaining("gesture rejected"),
  );
  let resolve!: () => void;
  engine.enable.mockImplementation(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  await audio.resume();
  const pending = audio.unlock();
  audio.pause();
  resolve();
  expect(await pending).toBe(true);
  expect(audio.stats()).toMatchObject({ unlocked: true, paused: true });
  expect(engine.play).not.toHaveBeenCalled();
  const late = audio.unlock();
  await audio.dispose();
  resolve();
  expect(await late).toBe(false);
  expect(engine.play).not.toHaveBeenCalled();
});
it("background pause and restore suppress old SFX, preserve one owner and dispose once", async () => {
  const { audio, engine } = coordinator();
  await audio.resume();
  await audio.unlock();
  audio.effect("hit-10", score.patches[0], 64, 0.1, 10);
  audio.effect("hit-10", score.patches[0], 64, 0.1, 10);
  expect(engine.previewNote).toHaveBeenCalledOnce();
  audio.pause();
  audio.effect("hit-11", score.patches[0], 64, 0.1, 11);
  await audio.resume();
  audio.reset(20);
  audio.effect("hit-10", score.patches[0], 64, 0.1, 10);
  audio.effect("hit-21", score.patches[0], 64, 0.1, 21);
  expect(engine.previewNote).toHaveBeenCalledTimes(2);
  const other = coordinator();
  await other.audio.resume();
  await other.audio.unlock();
  expect(audio.stats().paused).toBe(true);
  audio.effect("hit-22", score.patches[0], 64, 0.1, 22);
  expect(engine.previewNote).toHaveBeenCalledTimes(2);
  await audio.dispose();
  await audio.dispose();
  expect(engine.dispose).toHaveBeenCalledOnce();
  await audio.resume();
  expect(await audio.unlock()).toBe(false);
});
it("bounds burst SFX allocations and clears stopped voices on reset", async () => {
  const { audio, engine } = coordinator();
  await audio.resume();
  await audio.unlock();
  for (let n = 0; n < 100; n++) audio.effect(String(n), score.patches[0], 64);
  expect(engine.previewNote).toHaveBeenCalledTimes(32);
  audio.reset();
  for (const result of engine.previewNote.mock.results)
    expect(result.value).toHaveBeenCalledOnce();
});

it("normal screen transitions keep the same music clock while clearing transient buses and lowering energy", async () => {
  const { audio, engine } = coordinator();
  await audio.resume();
  await audio.unlock();
  engine.currentTime = 1.75;
  audio.setEncounter(true);
  audio.effect("hit", score.patches[0], 52, 0.1, 10);
  audio.dialogue("line", score.patches[0]);
  const stopsBefore = engine.stop.mock.calls.length;
  for (const screen of [
    "cinematic",
    "result",
    "title",
    "play",
    "loss",
    "retry",
  ]) {
    audio.transition(10);
    await audio.resume();
    await audio.unlock();
    expect(engine.play, screen).toHaveBeenCalledOnce();
    expect(engine.stop, screen).toHaveBeenCalledTimes(stopsBefore);
    expect(engine.currentTime, screen).toBe(1.75);
    expect(audio.stats()).toMatchObject({
      energy: 1,
      transportStarts: 1,
      paused: false,
    });
  }
  for (const result of engine.previewNote.mock.results)
    expect(result.value).toHaveBeenCalledOnce();
  audio.effect("old", score.patches[0], 52, 0.1, 10);
  expect(engine.previewNote).toHaveBeenCalledTimes(2);
  audio.effect("new", score.patches[0], 52, 0.1, 11);
  expect(engine.previewNote).toHaveBeenCalledTimes(3);
});
it("concurrent unlock/resume share one pending start and flow entry cannot restart it", async () => {
  const { audio, engine } = coordinator();
  let enable!: () => void, play!: () => void;
  engine.enable.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        enable = done;
      }),
  );
  engine.play.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        play = done;
      }),
  );
  await audio.resume();
  const first = audio.unlock(),
    second = audio.unlock();
  expect(engine.enable).toHaveBeenCalledOnce();
  audio.transition(5);
  enable();
  await Promise.resolve();
  expect(engine.play).toHaveBeenCalledOnce();
  const resumed = audio.resume();
  audio.transition(6);
  play();
  await Promise.all([first, second, resumed]);
  await audio.resume();
  await audio.unlock();
  expect(engine.play).toHaveBeenCalledOnce();
  expect(audio.stats().transportStarts).toBe(1);
});
it("explicit pause, mute and restore still stop transports, and a late start cannot revive a paused owner", async () => {
  const { audio, engine } = coordinator();
  await audio.resume();
  await audio.unlock();
  audio.pause();
  expect(engine.stop).toHaveBeenCalledOnce();
  await Promise.all([audio.resume(), audio.resume(), audio.unlock()]);
  expect(engine.play).toHaveBeenCalledTimes(2);
  audio.setMuted(true);
  audio.transition();
  await audio.resume();
  await audio.unlock();
  expect(engine.play).toHaveBeenCalledTimes(2);
  audio.setMuted(false);
  await Promise.resolve();
  expect(engine.play).toHaveBeenCalledTimes(3);
  audio.pause();
  audio.reset(100);
  await audio.resume();
  expect(engine.play).toHaveBeenCalledTimes(4);

  audio.pause();
  let finish!: () => void;
  engine.play.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        finish = done;
      }),
  );
  const pending = audio.resume();
  audio.pause();
  finish();
  await pending;
  expect(audio.stats().paused).toBe(true);
  await audio.resume();
  expect(engine.play).toHaveBeenCalledTimes(6);
  expect(audio.stats().transportStarts).toBe(6);
});

it("reset during pending device enable shares one unlock and starts only the latest transport state", async () => {
  const { audio, engine } = coordinator();
  let enabled!: () => void;
  engine.enable.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        enabled = resolve;
      }),
  );
  await audio.resume();
  const first = audio.unlock();
  audio.reset(50);
  const second = audio.unlock();
  expect(second).toBe(first);
  expect(engine.enable).toHaveBeenCalledOnce();
  expect(engine.play).not.toHaveBeenCalled();
  enabled();
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(audio.stats()).toMatchObject({
    unlocked: true,
    paused: false,
    energy: 1,
    transportStarts: 1,
  });
  expect(engine.play).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    loop: true,
    energy: 1,
  });
  audio.effect("stale", score.patches[0], 60, 0.1, 50);
  expect(engine.previewNote).not.toHaveBeenCalled();
});
it("pause and mute preserve a pending device unlock while keeping every transport silent", async () => {
  const { audio, engine } = coordinator();
  let enabled!: () => void;
  engine.enable.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        enabled = resolve;
      }),
  );
  await audio.resume();
  const first = audio.unlock();
  audio.pause();
  audio.reset(10);
  audio.setMuted(true);
  expect(audio.unlock()).toBe(first);
  enabled();
  expect(await first).toBe(true);
  expect(audio.stats()).toMatchObject({
    unlocked: true,
    paused: true,
    muted: true,
    transportStarts: 0,
  });
  expect(engine.enable).toHaveBeenCalledOnce();
  expect(engine.play).not.toHaveBeenCalled();
  await audio.resume();
  expect(engine.play).not.toHaveBeenCalled();
  audio.setMuted(false);
  await Promise.resolve();
  expect(engine.play).toHaveBeenCalledOnce();
});
it("ownership transfer and disposal cannot start sound after a delayed device unlock", async () => {
  const first = coordinator(),
    second = coordinator();
  let enabled!: () => void;
  first.engine.enable.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        enabled = resolve;
      }),
  );
  await first.audio.resume();
  const pending = first.audio.unlock();
  await second.audio.resume();
  await second.audio.unlock();
  enabled();
  expect(await pending).toBe(false);
  expect(first.audio.stats()).toMatchObject({ unlocked: false, paused: true });
  expect(first.engine.play).not.toHaveBeenCalled();
  expect(second.engine.play).toHaveBeenCalledOnce();

  let late!: () => void;
  first.engine.enable.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        late = resolve;
      }),
  );
  const disposed = first.audio.unlock();
  await first.audio.dispose();
  late();
  expect(await disposed).toBe(false);
  expect(first.engine.play).not.toHaveBeenCalled();
});
it("forwards energy only when encounter eligibility actually changes", async () => {
  const { audio, engine } = coordinator();
  for (let tick = 0; tick < 600; tick++) audio.setEncounter(false);
  expect(engine.setEnergy).not.toHaveBeenCalled();
  audio.setEncounter(true);
  for (let tick = 0; tick < 600; tick++) audio.setEncounter(true);
  expect(engine.setEnergy.mock.calls).toEqual([[2]]);
  audio.transition();
  audio.transition();
  audio.reset();
  for (let tick = 0; tick < 600; tick++) audio.setEncounter(false);
  expect(engine.setEnergy.mock.calls).toEqual([[2], [1]]);
});

it("an interrupted transport restarts once after an explicit gesture and failed unlock remains retryable", async () => {
  const engine = { ...device(), isPlaying: true };
  const { audio, onError } = coordinator(engine);
  await audio.resume();
  await audio.unlock();
  expect(engine.play).toHaveBeenCalledTimes(1);
  engine.isPlaying = false; // AudioEngine stops transport on suspended/interrupted state.
  engine.enable.mockRejectedValueOnce(Error("resume denied"));
  expect(await audio.unlock()).toBe(false);
  expect(onError).toHaveBeenCalledOnce();
  expect(engine.play).toHaveBeenCalledTimes(1);
  engine.isPlaying = true;
  await audio.unlock(); // Successful device resume still needs a stopped transport.
  expect(engine.play).toHaveBeenCalledTimes(1);
  engine.isPlaying = false;
  await Promise.all([audio.unlock(), audio.unlock()]);
  expect(engine.play).toHaveBeenCalledTimes(2);
  expect(audio.stats().error).toBe(null);
});

it("bounded observational cue counters distinguish accepted, duplicate and capacity-dropped effects", async () => {
  const { audio } = coordinator();
  await audio.resume();
  await audio.unlock();
  const patch = score.patches[0];
  for (let i = 0; i < 40; i++) audio.effect(`cue-${i}`, patch, 60);
  audio.effect("cue-0", patch, 60);
  const stats = audio.stats();
  expect(stats.acceptedSounds).toBe(32);
  expect(stats.capacityDropped).toBe(8);
  expect(stats.duplicateSounds).toBe(1);
  expect(stats.cueLog).toHaveLength(32);
  stats.cueLog[0].key = "external mutation";
  expect(audio.stats().cueLog[0].key).toBe("sfx:cue-0");
});
