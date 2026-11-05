import { afterEach, describe, expect, it, vi } from "vitest";
import { compileScore } from "@onepage/music-core/runtime";
import { validateScore } from "@onepage/project";
import { cryptballScore, cryptScore, CRYPT_SCORE_REGISTRY, BAR_TICKS } from "../src/audio-score";
import { effectsAuditionScore, eventCue, specialCue } from "../src/audio-effects";
import { createInitialState } from "../sim/session";

const device = vi.hoisted(() => ({ time: 0, playing: false, renders: [] as { patch: string; pitch: number; gain: number; at: number; stop: ReturnType<typeof vi.fn> }[], starts: 0, stop: vi.fn(), energy: [] as number[], gain: vi.fn(), trackGain: vi.fn(), running: "running" }));
vi.mock("@onepage/music-web-audio", () => ({
  AudioEngine: class {
    get currentTime() { return device.time; }
    get activeVoiceCount() { return 0; }
    get isPlaying() { return device.playing; }
    async enable() {}
    async play() { device.starts++; device.playing = true; }
    get transportOrigin() { return 0; }
    setTrackGain = device.trackGain;
    setEnergy(energy: number) { device.energy.push(energy); }
    prepareMixCaptureTaps() {}
    readMixTaps() { return { music: { context: { state: device.running }, gain: { cancelScheduledValues() {}, setTargetAtTime: device.gain } }, preProtection: { context: { state: device.running } } }; }
    stop() { device.playing = false; device.stop(); }
    async dispose() { this.stop(); }
  },
  renderPerformanceVoice(_context: unknown, _destination: unknown, patch: { id: string }, pitch: number, _velocity: number, at: number, duration: number, gain: number) {
    const stop = vi.fn(); device.renders.push({ patch: patch.id, pitch, gain, at, stop });
    return { stop, end: at + duration + .1 };
  },
}));
import { CryptballAudio, CourtMixer } from "../src/audio";
const owned: CryptballAudio[] = [];
async function running() {
  const audio = new CryptballAudio(() => {}); owned.push(audio);
  await audio.engine.unlock(); await audio.engine.resume();
  return audio;
}
afterEach(async () => {
  for (const audio of owned.splice(0)) await audio.engine.dispose();
  device.time = 0; device.renders.length = 0; device.starts = 0; device.playing = false; device.energy.length = 0; vi.clearAllMocks();
});

describe("original crypt score", () => {
  it("has distinct valid arrangements with silent optional pressure tracks", () => {
    expect(CRYPT_SCORE_REGISTRY).toHaveLength(8);
    for (const [id] of CRYPT_SCORE_REGISTRY) {
      const score = cryptScore(id);
      expect(validateScore(score)).toEqual({ valid: true, errors: [] });
      expect(score.lengthTicks).toBe(BAR_TICKS * (id === 'menu' || id === 'results' ? 16 : 32));
      if (id === 'menu' || id === 'results') continue;
      const normal = compileScore(score, { energy: 1 }), full = compileScore(score, { energy: 2 });
      expect(full.length).toBeGreaterThan(normal.length);
      expect(full.filter(n => !n.trackId.startsWith('pressure-'))).toEqual(normal);
      for (let bar = 0; bar < 32; bar++) expect(normal.some(n => n.startTick >= bar * BAR_TICKS && n.startTick < (bar + 1) * BAR_TICKS)).toBe(true);
    }
  });
  it("exports the exact special descriptors in a valid, bounded listening reel", () => {
    const audition = effectsAuditionScore();
    expect(validateScore(audition)).toEqual({ valid: true, errors: [] });
    expect(compileScore(audition).length).toBeGreaterThan(40);
    const teams = ["rams", "foxes", "owls", "gators", "bats", "hornets"] as const;
    expect(new Set(teams.map(team => specialCue(team, "tell").voices[0]!.patch.id)).size).toBe(6);
    expect(new Set(["check", "strike", "board", "post", "save"].map(type => eventCue({ type, tick: 1 }, "cryptball")!.voices.map(v => v.patch.id).join("+"))).size).toBe(5);
  });
});

describe("crypt audio lifecycle and event authority", () => {
  it("keeps transport through volume changes, independent zero gains, and overtime entry", async () => {
    const audio = await running(); const starts = device.starts;
    audio.volumes(0, .8);
    expect(device.gain).toHaveBeenLastCalledWith(0, 0, .018);
    const state = createInitialState(); state.overtime = true;
    audio.tick(state, [{ type: "save", tick: state.tick, epoch: 0, counter: 0 }]);
    expect(device.renders.length).toBe(2); expect(device.renders[0]!.gain).toBeGreaterThan(0);
    expect(device.energy).toEqual([]); expect(device.starts).toBe(starts);
    audio.volumes(.7, 0);
    expect(device.renders.every(v => v.stop.mock.calls.length === 1)).toBe(true);
    state.tick++; audio.tick(state, [{ type: "strike", tick: state.tick, epoch: 0, counter: 1 }]);
    expect(device.renders.length).toBe(2); expect(device.starts).toBe(starts);
  });
  it("deduplicates every sport and suppresses historical activation after reconnect", async () => {
    const audio = await running(); const state = createInitialState(); state.tick = 100;
    audio.tick(state, [{ type: "special", kind: "rams", tick: 20, epoch: 0, counter: 0 }]);
    expect(device.renders).toHaveLength(0);
    const event = { type: "special", kind: "rams", tick: 100, epoch: 0, counter: 1 };
    audio.tick(state, [event]); const count = device.renders.length;
    expect(count).toBe(2); audio.tick(state, [event]); expect(device.renders).toHaveLength(count);
    // A snapshot already in rush has no fabricated activation or success cue.
    audio.resetMatch(); state.specials[0].active = { playerId: state.players[0]!.id, elapsedTicks: 12, remainingTicks: 30, heading: 0 } as typeof state.specials[0]["active"];
    audio.tick(state, []); expect(device.renders).toHaveLength(count);
  });
  it("plays delayed authoritative contacts once even behind predicted display ticks", async () => {
    const audio = await running(); const state = createInitialState(); state.tick = 120;
    audio.tick(state, [], true);
    const event = { type: "save", tick: 100, epoch: 3, counter: 7 };
    audio.tick(state, [event], true);
    const count = device.renders.length; expect(count).toBe(2);
    state.tick = 119; audio.tick(state, [event], true);
    expect(device.renders).toHaveLength(count);
    audio.tick(state, [{ ...event, tick: 101, counter: 8 }], true);
    expect(device.renders.length).toBeGreaterThan(count);
  });
  it("separates predicted onset keys from unrelated authoritative event counters", async () => {
    const audio=await running(); const state=createInitialState(); state.tick=10;
    const predicted={type:"dash",tick:10,epoch:1,counter:7,predicted:true,origin:{epoch:1,generation:1,participantId:"p0",seq:1,eventKind:"dash",ordinal:0}};
    audio.tick(state,[predicted],true); const count=device.renders.length;
    expect(count).toBeGreaterThan(0);
    audio.tick(state,[{type:"save",tick:9,epoch:1,counter:7}],true);
    expect(device.renders.length).toBeGreaterThan(count);
  });
  it("voices only a freshly crossed rush phase, suppressing recovery and observation gaps", async () => {
    const audio = await running(); const state = createInitialState(); state.tick = 8;
    const active = { playerId: state.players[0]!.id, elapsedTicks: 8, remainingTicks: 34, heading: 0, burstStart: 9, secondBurstAvailable: false, contactUsed: false, receptionUsed: false, stoppedTicks: -1 };
    state.specials[0].active = active;
    audio.tick(state, []); expect(device.renders).toHaveLength(0);
    state.tick = 9; active.elapsedTicks = 9; active.remainingTicks--;
    audio.tick(state, []); expect(device.renders.map(v => v.patch)).toEqual(["ram-rush"]);
    audio.resetMatch(); state.tick = 8; active.elapsedTicks = 8;
    audio.tick(state, []);
    state.tick = 33; active.elapsedTicks = 33;
    audio.tick(state, []); expect(device.renders).toHaveLength(1);
  });
  it("only plays success on contact and separately voices the manual second Flutter", async () => {
    const audio = await running(); const state = createInitialState();
    audio.tick(state, [{ type: "special", kind: "bats", tick: 0, epoch: 0, counter: 0 }]);
    expect(device.renders.map(v => v.pitch)).toEqual([57,62]);
    device.time = 1; state.tick = 60;
    audio.tick(state, [{ type: "special-burst", kind: "bats", stage: 2, tick: 60, epoch: 0, counter: 1 }]);
    expect(device.renders.slice(-2).map(v => v.pitch)).toEqual([69,74]);
    device.time = 2; state.tick = 120;
    audio.tick(state, [{ type: "special-success", kind: "gators", contact: "ball", tick: 120, epoch: 0, counter: 2 }]);
    expect(device.renders.slice(-2).map(v => v.patch)).toEqual(["gator-clack", "body-thud"]);
  });
  it("bounds effect voices, reserves priority via eviction, and stops delayed sources on mute/pause/reset/dispose", async () => {
    const mixer = new CourtMixer(); await mixer.enable();
    const patch = eventCue({ type: "strike", tick: 0 }, "cryptball")!.voices[0]!.patch;
    for (let i = 0; i < 8; i++) expect(mixer.tryPreviewNote(patch, 48)).not.toBeNull();
    expect(mixer.tryPreviewNote(patch, 48)).toBeNull(); expect(device.renders).toHaveLength(8);
    mixer.priority = true; expect(mixer.tryPreviewNote(patch, 48)).not.toBeNull();
    expect(device.renders[0]!.stop).toHaveBeenCalledOnce(); expect(mixer.activeVoiceCount).toBe(8);
    mixer.stop(); expect(device.renders.every(v => v.stop.mock.calls.length === 1)).toBe(true);
    await mixer.dispose();
    const audio = await running(); const state = createInitialState();
    for (const action of [() => audio.engine.setMuted(true), () => audio.engine.pause(), () => audio.resetMatch(), () => audio.engine.dispose()]) {
      audio.engine.setMuted(false); await audio.engine.resume();
      const offset = device.renders.length;
      state.tick++; audio.tick(state, [{ type: "special", kind: "hornets", tick: state.tick, epoch: 0, counter: state.tick }]);
      expect(device.renders.length).toBeGreaterThan(offset);
      await action();
      expect(device.renders.slice(offset).every(v => v.stop.mock.calls.length === 1)).toBe(true);
    }
  });
});

describe('confirmed adaptive score', () => {
  const stamp = (snapshotSeq: number, generation = 0) => ({ matchId: 'room:1', epoch: 1, generation, snapshotSeq });
  it('ignores predicted stakes, stale authority, duplicates and reconnect history', async () => {
    const audio = await running(), state = createInitialState();
    state.phase = 'play'; state.remainingTicks = 60 * 60;
    audio.observeMusic(state, stamp(1), 0);
    await Promise.resolve(); await Promise.resolve();
    device.trackGain.mockClear();
    state.overtime = true; state.tick++;
    audio.tick(state, [], false);
    expect(device.trackGain).not.toHaveBeenCalled();
    audio.observeMusic(state, stamp(2), 0);
    expect(device.trackGain).toHaveBeenCalledWith('pressure-pulse', 1, expect.any(Number), 240 / 128);
    const renders = device.renders.length, calls = device.trackGain.mock.calls.length;
    audio.observeMusic(state, stamp(2), 0);
    audio.observeMusic({ ...state, overtime: false }, stamp(1), 0);
    expect(device.trackGain).toHaveBeenCalledTimes(calls);
    expect(device.renders).toHaveLength(renders);
    audio.observeMusic(state, stamp(3, 1), 0);
    expect(device.renders).toHaveLength(renders);
    audio.observeMusic({ ...state, overtime: false }, stamp(20, 0), 0);
    expect(device.trackGain).toHaveBeenLastCalledWith('pressure-drums', 1);
  });
  it('uses next-bar fades, replaces unstarted requests and holds audible pressure for two bars', async () => {
    const mixer = new CourtMixer(); mixer.selectScene('cryptball');
    mixer.setPressure(0, true); device.trackGain.mockClear();
    device.time = .2; mixer.setPressure(1);
    expect(device.trackGain).toHaveBeenCalledWith('pressure-pulse', 1, 1.875, 1.875);
    device.time = .3; mixer.setPressure(0);
    expect(device.trackGain).toHaveBeenLastCalledWith('pressure-drums', 0, 1.875, 1.875);
    device.time = .4; mixer.setPressure(1);
    device.time = 2; mixer.setPressure(0);
    expect(device.trackGain).toHaveBeenLastCalledWith('pressure-drums', 0, 5.625, 1.875);
    mixer.stop();
  });
  it('keeps stings on music volume and coalesces final score with controlled outcome', async () => {
    const audio = await running(), state = createInitialState(); state.phase = 'play';
    audio.observeMusic(state, stamp(1), 0); await Promise.resolve(); await Promise.resolve();
    audio.volumes(.7, 0);
    state.tick++; state.score = [1, 0]; state.phase = 'results'; state.winner = 0;
    audio.observeMusic(state, stamp(2), 0);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(device.renders.length).toBeGreaterThan(0);
    expect(device.renders.length).toBeLessThanOrEqual(6);
    expect(device.renders.some(v => v.stop.mock.calls.length === 0)).toBe(true);
    audio.volumes(0, .8);
    expect(device.renders.every(v => v.stop.mock.calls.length > 0)).toBe(true);
  });
});
