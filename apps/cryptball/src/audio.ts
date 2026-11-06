import { M2Audio, type Patch, type Score } from "@onepage/game-runtime/audio";
import { AudioEngine, renderPerformanceVoice, type PlaybackOptions } from "@onepage/music-web-audio";
import type { Observation, CryptballEvent } from "./contract";
import { cryptballScore, cryptScore, cryptSting, type CryptScoreId, type CryptStingKind } from "./audio-score";
import { compileScore } from "@onepage/music-core/runtime";
import { musicObservation, transitionSting, continuousMusic, type MusicObservation, type MusicStamp } from "./audio-music-policy";
import { eventCue, specialCue, EFFECT_MIX_GAIN, type AudioCue, type CueVoice } from "./audio-effects";

/** The app owns only its eight effect voices and music gain automation. The synth
 * remains the sole context/transport owner; M2Audio gates all unlock/mute/lifecycle.
 * Effects connect before the master/protection, never to the post-limiter tap.
 * The shared runtime has no persistent independent music-volume setter, so this
 * local policy uses its public graph taps rather than restarting the transport. */
export class CourtMixer {
  private scene: CryptScoreId = 'menu';
  private score = cryptScore('menu');
  private playGeneration = 0;
  private starting = false;
  private pendingSting: CryptStingKind | null = null;
  cueSting(kind: CryptStingKind) { if (this.starting) this.pendingSting = kind; else this.sting(kind); }
  private pressure = 0;
  private pressureUntil = 0;
  private pressurePending: { target: number; at: number } | null = null;
  private readonly pressureTracks = ['pressure-pulse', 'pressure-drums'];
  selectScene(scene: CryptScoreId) {
    if (this.scene === scene) return false;
    this.scene = scene; this.score = cryptScore(scene);
    this.pressureUntil = 0; this.pressurePending = null;
    return true;
  }
  setPressure(target: number, hydrate = false) {
    if (hydrate) {
      this.pressure = target; this.pressurePending = null; this.pressureUntil = 0;
      for (const id of this.pressureTracks) this.synth.setTrackGain(id, target);
      return;
    }
    const now = this.currentTime;
    if (this.pressurePending && now >= this.pressurePending.at) {
      this.pressure = this.pressurePending.target; this.pressurePending = null;
    }
    if (target === (this.pressurePending?.target ?? this.pressure)) return;
    // Each request replaces only future automation. An audible change holds two
    // bars and takes a full bar to fade; all timing comes from this device.
    const bar = 240 / this.score.bpm;
    const origin = this.synth.transportOrigin;
    const earliest = Math.max(now + .16, this.pressureUntil);
    const at = this.pressurePending && now < this.pressurePending.at ? this.pressurePending.at : origin + Math.max(0, Math.ceil((earliest - origin) / bar)) * bar;
    for (const id of this.pressureTracks) this.synth.setTrackGain(id, target, at, bar);
    this.pressurePending = { target, at }; this.pressureUntil = at + 2 * bar;
  }
  sting(kind: CryptStingKind) {
    this.prune();
    const destination = this.synth.readMixTaps().music;
    if (!this.music || !destination || destination.context.state !== 'running') return;
    const score = cryptSting(kind);
    const notes = compileScore(score);
    // One sting replaces the previous musical accent; effects have their own cap.
    for (const v of this.voices.filter(v => v.music)) v.stop();
    this.voices = this.voices.filter(v => !v.music);
    for (const note of notes) {
      if (this.voices.length >= 8 || this.activeVoiceCount >= 32) break;
      const patch = score.patches.find(p => p.id === note.patchId)!;
      const rendered = renderPerformanceVoice(destination.context, destination, patch, note.pitch, note.velocity,
        this.currentTime + note.startTick * 60 / (score.bpm * 480), note.durationTicks * 60 / (score.bpm * 480), note.gain * .7, note.pan);
      this.voices.push({ stop: () => rendered.stop(), end: rendered.end, priority: true, music: true });
    }
    this.duck();
  }
  private music = .7;
  private effects = .8;
  private duckUntil = 0;
  private boundContext: BaseAudioContext | null = null;
  private readonly contextChanged = () => {
    if (this.boundContext?.state !== "running") this.clearVoices();
  };
  private bindGraph() {
    const context = this.synth.readMixTaps().preProtection?.context ?? null;
    if (context === this.boundContext) return;
    this.boundContext?.removeEventListener?.("statechange", this.contextChanged);
    this.clearVoices();
    this.boundContext = context;
    context?.addEventListener?.("statechange", this.contextChanged);
  }
  private voices: { stop: () => void; end: number; priority: boolean; music?: boolean }[] = [];
  pan = 0;
  priority = false;
  voice: CueVoice | null = null;
  constructor(private readonly synth = new AudioEngine()) {}
  get currentTime() { return this.synth.currentTime; }
  get activeVoiceCount() { this.prune(); return this.synth.activeVoiceCount + this.voices.length; }
  get isPlaying() { return this.synth.isPlaying; }
  async enable() { await this.synth.enable(); this.synth.prepareMixCaptureTaps(); this.bindGraph(); this.applyMusic(); }
  async play(_score: Score, options?: PlaybackOptions) {
    const token = ++this.playGeneration;
    this.starting = true;
    const score = this.score;
    this.clearVoices();
    await this.synth.play(score, { ...options, energy: 2 });
    if (token !== this.playGeneration) return;
    this.synth.prepareMixCaptureTaps(); this.bindGraph(); this.applyMusic();
    this.setPressure(this.pressure, true);
    this.starting = false;
    const sting = this.pendingSting; this.pendingSting = null;
    if (sting) this.sting(sting);
  }
  setEnergy(_energy: number) { /* All synchronized layers run; pressure uses track gain. */ }
  setVolumes(music: number, effects: number) {
    this.music = Number.isFinite(music) ? Math.max(0, Math.min(1, music)) : .7;
    this.effects = Number.isFinite(effects) ? Math.max(0, Math.min(1, effects)) : .8;
    this.applyMusic();
    for (const v of this.voices.filter(v => v.music ? this.music === 0 : this.effects === 0)) v.stop();
    this.voices = this.voices.filter(v => v.music ? this.music !== 0 : this.effects !== 0);
  }
  private applyMusic() {
    const bus = this.synth.readMixTaps().music;
    if (!bus) return;
    const now = this.currentTime;
    bus.gain.cancelScheduledValues(now);
    bus.gain.setTargetAtTime(this.music * (now < this.duckUntil ? .66 : 1), now, .018);
    if (now < this.duckUntil) bus.gain.setTargetAtTime(this.music, this.duckUntil, .17);
  }
  duck() { this.duckUntil = Math.max(this.duckUntil, this.currentTime + .25); this.applyMusic(); }
  private prune() { this.voices = this.voices.filter(v => v.end > this.currentTime); }
  previewNote(p: Patch, pitch: number, velocity = .6, duration = .1, gain = .7) {
    return this.tryPreviewNote(p, pitch, velocity, duration, gain) ?? (() => {});
  }
  tryPreviewNote(patch: Patch, pitch: number, velocity = .6, duration = .1, gain = .7) {
    this.prune();
    const destination = this.synth.readMixTaps().preProtection;
    if (this.effects === 0 || !destination || destination.context.state !== "running") return null;
    if (this.voices.length >= 8) {
      if (!this.priority) return null;
      const victim = this.voices.findIndex(v => !v.priority);
      // A major cue may replace the oldest major cue, keeping the hard cap.
      this.voices.splice(victim < 0 ? 0 : victim, 1)[0]!.stop();
    }
    if (this.synth.activeVoiceCount + this.voices.length >= 32) return null;
    const descriptor = this.voice;
    const delay = descriptor?.delay ?? 0;
    const rendered = renderPerformanceVoice(destination.context, destination, patch, pitch,
      descriptor?.velocity ?? velocity, this.currentTime + delay, duration,
      (descriptor?.gain ?? gain) * this.effects * EFFECT_MIX_GAIN, this.pan);
    const item = { stop: () => rendered.stop(), end: rendered.end, priority: this.priority };
    this.voices.push(item);
    return () => { item.stop(); this.voices = this.voices.filter(v => v !== item); };
  }
  private clearVoices() { for (const v of this.voices) v.stop(); this.voices = []; }
  stop() { this.playGeneration++; this.starting = false; this.pendingSting = null; if (this.pressurePending) this.pressure = this.pressurePending.target; this.pressurePending = null; this.clearVoices(); this.duckUntil = 0; this.synth.stop(); }
  async dispose() {
    this.clearVoices();
    this.boundContext?.removeEventListener?.("statechange", this.contextChanged);
    this.boundContext = null;
    await this.synth.dispose();
  }
}

export class CryptballAudio {
  readonly engine: M2Audio;
  private musicPrevious: MusicObservation | null = null;
  private lastBoard = -99;
  private seen = new Set<string>();
  private previous: Pick<Observation, "tick" | "specials"> | null = null;
  private readonly base = cryptballScore();
  constructor(onError: (text: string) => void, private readonly mixer = new CourtMixer()) {
    this.engine = new M2Audio({ score: this.base, engine: mixer, onError });
  }
  resetMatch() {
    this.lastBoard = -99; this.seen.clear(); this.previous = null;
    this.musicPrevious = null; this.mixer.selectScene('cryptball'); this.mixer.setPressure(0, true);
    this.engine.reset();
  }
  titleCue() {
    this.previous = null; this.musicPrevious = null;
    if (this.mixer.selectScene('menu')) this.engine.reset();
    this.mixer.setPressure(0, true); void this.engine.resume();
  }
  /** Authoritative-only channel. Prediction is deliberately confined to tick(). */
  get lastMusicStamp() { return this.musicPrevious?.stamp; }
  observeMusic(state: Observation, stamp?: MusicStamp, controlledTeam: 0|1|null = null) {
    const previous = this.musicPrevious;
    const beforeStamp = previous?.stamp;
    if (stamp && beforeStamp && stamp.matchId === beforeStamp.matchId && stamp.epoch === beforeStamp.epoch &&
      (stamp.generation < beforeStamp.generation || (stamp.generation === beforeStamp.generation && stamp.snapshotSeq <= beforeStamp.snapshotSeq))) return;
    const next = musicObservation(state, stamp);
    // Duplicate snapshots do not consume transitions or cancel queued automation.
    if (previous && previous.tick === next.tick && JSON.stringify(previous.stamp) === JSON.stringify(next.stamp)) return;
    const continuous = previous !== null && continuousMusic(previous, next);
    const sting = previous && continuous ? transitionSting(previous, next, state, controlledTeam) : null;
    if (this.mixer.selectScene(next.intent.scene)) this.engine.reset();
    this.mixer.setPressure(next.intent.pressure, !continuous || state.phase === 'results');
    const status = this.engine.stats();
    if (sting && status.unlocked && !status.muted && !status.paused) this.mixer.cueSting(sting);
    if (next.intent.attackTell && !previous?.intent.attackTell) this.mixer.duck();
    this.musicPrevious = next;
  }
  volumes(music: number, effects: number) { this.mixer.setVolumes(music, effects); }
  private emit(cue: AudioCue, key: string, tick: number, x = 0) {
    this.mixer.pan = Math.max(-.6, Math.min(.6, x / 256 / 240));
    this.mixer.priority = cue.priority ?? false;
    const acceptedBefore = this.engine.stats().acceptedSounds;
    cue.voices.forEach((voice,index) => {
      this.mixer.voice = voice;
      this.engine.effect(`${key}:${index}`, voice.patch, voice.pitch, voice.duration, tick);
    });
    this.mixer.voice = null; this.mixer.priority = false;
    // No side effect from muted/locked/paused effects, including gain ducking.
    const stats = this.engine.stats();
    if (cue.duck && stats.acceptedSounds > acceptedBefore) this.mixer.duck();
  }
  tick(state: Observation, events: readonly CryptballEvent[], authoritative = false) {
    const previous = this.previous;
    const restored = previous !== null && state.tick < previous.tick;
    for (const [index,event] of events.entries()) {
      // Online intake already excludes reconnect history. Predicted display ticks
      // may run ahead of newly delivered authority, so they cannot age events.
      if (!authoritative && (restored || (!previous && event.tick < state.tick) || (previous && event.tick < previous.tick))) continue;
      const origin = event.origin;
      const key = event.predicted && origin
        ? `prediction:${origin.epoch}:${origin.generation}:${origin.participantId}:${origin.seq}:${origin.eventKind}:${origin.ordinal}`
        : Number.isSafeInteger(event.epoch) && Number.isSafeInteger(event.counter)
        ? `${event.epoch}:${event.counter}` : `${event.tick}:${index}:${JSON.stringify(event)}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!);
      const cue = eventCue(event, state.sportId);
      if (!cue) continue;
      if (["board", "post"].includes(event.type)) {
        if (event.tick - this.lastBoard < 5) continue;
        this.lastBoard = event.tick;
      }
      this.emit(cue, key, event.tick, event.x);
    }
    // Only a phase crossed in a continuous observed activation can produce a
    // rush/scrape. Rejoining an already active move never invents its old tell.
    if (previous && !restored && state.tick > previous.tick) state.specials.forEach((special,team) => {
      const before = previous.specials[team]?.active, active = special.active;
      const kind = state.teamIds[team];
      const tell = kind === "rams" ? 9 : 6;
      if ((kind === "rams" || kind === "gators") && before && active && before.playerId === active.playerId &&
        state.tick - previous.tick <= 6 && active.stoppedTicks < 0 && active.elapsedTicks < (kind === "gators" && state.sportId === "cryptcheck" ? 24 : 30) &&
        before.elapsedTicks < tell && active.elapsedTicks >= tell && active.elapsedTicks - before.elapsedTicks === state.tick - previous.tick) {
        const player = state.players.find(p => p.id === active.playerId);
        this.emit(specialCue(kind, "active"), `phase:${state.tick - active.elapsedTicks}:${team}`, state.tick, player?.x);
      }
    });
    // Keep only the tiny data needed for transition detection, not a mutable
    // simulation reference (local observations can share their active object).
    this.previous = { tick: state.tick, specials: structuredClone(state.specials) };
  }
}
