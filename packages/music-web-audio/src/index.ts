import {
  readProtectionStats,
  createProtectedMix,
  type MixProfile,
  PROTECTED_MIX_LATENCY_FRAMES,
} from "./mix-profile";
import {
  EnvironmentAudio,
  type NoiseBedOptions,
  type ScheduledSampleOptions,
} from "./environment-audio";
export type {
  NoiseBedOptions,
  ScheduledSampleOptions,
} from "./environment-audio";
import { compileScore, ticksToSeconds } from "@onepage/music-core/runtime";

export type {
  StreamConfig,
  StreamWindow,
  StreamReceipt,
  TickerFactory,
} from "./stream";
import type { Patch, Score } from "@onepage/project";
export type { Patch } from "@onepage/project";
export interface PlaybackOptions {
  startTick?: number;
  endTick?: number;
  loop?: boolean;
  energy?: number;
  mutedTrackIds?: string[];
  soloTrackId?: string | null;
}
export interface RenderOptions extends Omit<PlaybackOptions, "loop"> {
  loops?: number;
  tailSeconds?: number;
  sampleRate?: number;
}
const MAX_VOICES = 256;
const MAX_EVENTS = 100000;
const MAX_FRAMES = 32_000_000;
const LOOKAHEAD = 0.15;
const noiseBuffers = new WeakMap<BaseAudioContext, Map<number, AudioBuffer>>();
const finite = (v: number, fallback: number) =>
  Number.isFinite(v) ? v : fallback;
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
export interface Voice {
  optional?: boolean;
  noteId?: string;
  releaseStart?: number;
  retiring?: boolean;
  fadeStop?: (at: number, duration: number) => void;
  trackId?: string;
  stop: (at?: number) => void;
  end: number;
}

/** Optional, preloaded instrument renderer. One musical note owns one Voice;
 * renderers must bound internal layers and report their complete release tail. */
export interface PerformanceVoiceRenderer {
  readonly id: string;
  /** Acoustic bindings this renderer prepared; absent on generic/unbound renderers. */
  readonly paletteIdentity?: Readonly<{ id: string; hash: string }>;
  readonly maxVoices?: number;
  /** Partial resource inventory; excludes browser/process/effects and opaque worklet allocations. */
  memoryDiagnostics?(): Readonly<
    Record<string, number | string | readonly number[]>
  >;
  releaseSeconds(patch: Patch): number;
  prepareContext?(context: BaseAudioContext): Promise<void>;
  releaseContext?(context: BaseAudioContext): void;
  renderVoice: typeof renderPerformanceVoice;
}

// Identical synthesis graph for live preview, game playback and offline export.
export function renderPerformanceVoice(
  ctx: BaseAudioContext,
  destination: AudioNode,
  patch: Patch,
  pitch: number,
  velocity: number,
  start: number,
  duration: number,
  gain = 1,
  pan = 0,
  _noteId?: string,
): Voice {
  const attack = clamp(finite(patch.attack, 0.005), 0.002, 5);
  const release = clamp(finite(patch.release, 0.06), 0.005, 10);
  const end = start + duration + release;
  const envelope = ctx.createGain();
  const panner = ctx.createStereoPanner();
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value =
    patch.waveform === "harmonic-bass"
      ? 220 + clamp(finite(patch.brightness, 0.2), 0, 1) * 700
      : 200 + clamp(finite(patch.brightness, 1), 0, 1) * 18000;
  panner.pan.value = patch.waveform === "harmonic-bass" ? 0 : clamp(finite(pan, 0), -1, 1);
  envelope.gain.setValueAtTime(0, start);
  const level =
    clamp(finite(velocity, 0.7), 0, 1) * clamp(finite(gain, 1), 0, 2) *
    (patch.waveform === "harmonic-bass" ? 0.29 : 0.18);
  envelope.gain.linearRampToValueAtTime(
    level,
    start + Math.min(attack, duration / 2),
  );
  const decay = patch.decaySeconds;
  const endLevel =
    decay === undefined
      ? level
      : level *
        Math.exp(
          -Math.max(0, duration - Math.min(attack, duration / 2)) /
            clamp(finite(decay, 0.8), 0.02, 10),
        );
  if (decay !== undefined && level > 0)
    envelope.gain.exponentialRampToValueAtTime(
      Math.max(1e-8, endLevel),
      start + duration,
    );
  else envelope.gain.setValueAtTime(level, start + duration);
  envelope.gain.linearRampToValueAtTime(0, end);
  let source: AudioScheduledSourceNode;
  if (patch.waveform === "noise") {
    // MIDI kit lanes share a patch but carry distinct deterministic percussion.
    const key = [36, 38, 42, 46].includes(pitch) ? pitch : 0;
    let buffers = noiseBuffers.get(ctx);
    if (!buffers) {
      buffers = new Map();
      noiseBuffers.set(ctx, buffers);
    }
    let buffer = buffers.get(key);
    if (!buffer) {
      buffer = ctx.createBuffer(
        1,
        Math.ceil(ctx.sampleRate * 0.6),
        ctx.sampleRate,
      );
      const samples = buffer.getChannelData(0);
      let seed = 0x12345678,
        previous = 0,
        phase = 0;
      for (let i = 0; i < samples.length; i++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        const random = (seed >>> 0) / 2147483648 - 1,
          t = i / ctx.sampleRate;
        if (key === 36) {
          phase +=
            (2 * Math.PI * (44 + 110 * Math.exp(-t * 35))) / ctx.sampleRate;
          samples[i] = Math.sin(phase) * Math.exp(-t * 20);
        } else if (key === 38)
          samples[i] =
            (0.8 * random + 0.2 * Math.sin(2 * Math.PI * 180 * t)) *
            Math.exp(-t * 24);
        else if (key === 42 || key === 46)
          samples[i] =
            (random - previous) * 0.5 * Math.exp(-t * (key === 42 ? 85 : 14));
        else samples[i] = random;
        previous = random;
      }
      buffers.set(key, buffer);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = key === 0;
    source = noise;
  } else {
    const osc = ctx.createOscillator();
    osc.frequency.value = 440 * 2 ** ((clamp(pitch, 0, 127) - 69) / 12);
    if (patch.waveform === "harmonic-bass") {
      // One oscillator/voice, phase-coherent fundamental and octave support.
      // Disable browser normalization so the explicit 80/20 amplitudes survive.
      const real = new Float32Array(65), imag = new Float32Array(65);
      imag[1] = 0.8;
      for (let n = 1; n * 2 < imag.length; n += 2)
        imag[n * 2] = 0.2 * 8 / (Math.PI ** 2) * (-1) ** ((n - 1) / 2) / (n * n);
      osc.setPeriodicWave(ctx.createPeriodicWave(real, imag, { disableNormalization: true }));
    } else if (patch.waveform === "pulse") {
      const real = new Float32Array(33),
        imag = new Float32Array(33);
      const duty = clamp(finite(patch.duty, 0.5), 0.05, 0.95);
      for (let n = 1; n < 33; n++) {
        real[n] = (2 * Math.sin(2 * Math.PI * n * duty)) / (Math.PI * n);
        imag[n] = (2 * (1 - Math.cos(2 * Math.PI * n * duty))) / (Math.PI * n);
      }
      osc.setPeriodicWave(ctx.createPeriodicWave(real, imag));
    } else osc.type = patch.waveform;
    source = osc;
  }
  source.connect(filter);
  filter.connect(envelope);
  envelope.connect(panner);
  panner.connect(destination);
  let ended = false;
  source.onended = () => {
    ended = true;
    source.disconnect();
    filter.disconnect();
    envelope.disconnect();
    panner.disconnect();
  };
  source.start(start);
  source.stop(end);
  return {
    end,
    fadeStop: (at, seconds) => {
      const t = Math.max(ctx.currentTime, at);
      envelope.gain.cancelScheduledValues(t);
      envelope.gain.setValueAtTime(
        (decay === undefined
          ? level
          : level * Math.exp(-Math.max(0, t - start - attack) / decay)) *
          clamp((end - t) / release, 0, 1),
        t,
      );
      envelope.gain.linearRampToValueAtTime(0, t + seconds);
      source.stop(t + seconds);
    },
    stop: (at = ctx.currentTime) => {
      if (ended) return;
      const t = Math.max(ctx.currentTime, at);
      envelope.gain.cancelScheduledValues(t);
      envelope.gain.setValueAtTime(0, t);
      try {
        source.stop(t);
      } catch {
        /* Already ended. */
      }
    },
  };
}

function prepare(score: Score, options: PlaybackOptions) {
  const start = options.startTick ?? 0,
    end = options.endTick ?? score.lengthTicks;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > score.lengthTicks
  )
    throw new Error("Invalid playback range");
  const events = compileScore(score, {
    startTick: start,
    endTick: end,
    energy: options.energy,
  }).filter(
    (e) =>
      !options.mutedTrackIds?.includes(e.trackId) &&
      (!options.soloTrackId || options.soloTrackId === e.trackId),
  );
  if (events.length > MAX_EVENTS) throw new Error("Score has too many events");
  return { start, end, events, length: ticksToSeconds(end - start, score.bpm) };
}

export class AudioEngine {
  protected context: AudioContext | null = null;
  protected get voiceCapacity() {
    return MAX_VOICES;
  }
  protected output: GainNode | null = null;
  private mixProfile: MixProfile = "legacy-v1";
  private protection: AudioWorkletNode | null = null;
  private protectedOutput: GainNode | null = null;
  private lowMusic: GainNode | null = null;
  /** Profile changes require a fresh device, preventing stale graph/binding reuse. */
  setMixProfile(profile: MixProfile) {
    if (this.context || this.playing)
      throw Error("Dispose before changing mix profile");
    if (profile !== "legacy-v1" && profile !== "weather-protected-1")
      throw Error("Unknown mix profile");
    this.mixProfile = profile;
  }
  get outputMixProfile() {
    return this.mixProfile;
  }
  get outputLatencySeconds() {
    return this.mixProfile === "weather-protected-1" && this.context
      ? PROTECTED_MIX_LATENCY_FRAMES / this.context.sampleRate
      : 0;
  }
  protected musicDestination(role: string): AudioNode {
    return this.lowMusic &&
      (role === "bass" || role === "percussion" || role === "drums")
      ? this.lowMusic
      : this.output!;
  }
  /** Bounded selective reduction; upper voices retain their full spectrum. */
  setLowMusicGain(gain: number, rampSeconds = 0.08) {
    if (
      !Number.isFinite(gain) ||
      gain < 0.6 ||
      gain > 1 ||
      !Number.isFinite(rampSeconds) ||
      rampSeconds < 0.02 ||
      rampSeconds > 2
    )
      throw Error("Invalid low music reduction");
    if (!this.lowMusic || !this.context) return false;
    const p = this.lowMusic.gain,
      now = this.currentTime;
    if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(now);
    else {
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
    }
    p.linearRampToValueAtTime(gain, now + rampSeconds);
    return true;
  }
  async prepareEnvironmentProfile() {
    const graph = this.environmentGraph();
    if (!graph) throw Error("Environment profile requires running device");
    await graph.prepareEvolvingProfile();
  }
  readEnvironmentResources() {
    return this.environment?.readResources() ?? {
      logicalBeds: 0, legacyBufferBytes: 0, evolvingProcessors: 0,
      internalTextureLayers: 0, effects: 0, processorFailures: 0,
    };
  }
  private volume = 1;
  private environmentVolume = 1;
  private master: GainNode | null = null;
  private environment: EnvironmentAudio | null = null;
  private environmentSamples = new Set<string>();
  private legacySampleOutputs = new Set<GainNode>();
  private samples = new Map<string, AudioBuffer>();
  private pendingSamples = new Set<string>();
  private sampleGeneration = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  protected voices = new Set<Voice>();
  private generation = 0;
  protected playing = false;
  protected origin = 0;
  protected rangeStart = 0;
  private rangeEnd = 0;
  protected bpm = 120;
  protected looping = false;
  private trackBuses = new Map<string, GainNode>();
  private trackRoles = new Map<string, string>();
  private trackAutomation = new Map<string, { initial: number; ramps: { at: number; end: number; from: number; to: number }[] }>();
  /** Audio-clock automation for an existing score track; bounded by score tracks.
   * Replacing a future ramp evaluates the existing curve at that boundary. */
  setTrackGain(trackId: string, gain: number, atTime = this.currentTime, rampSeconds = 0) {
    if (!Number.isFinite(gain) || gain < 0 || gain > 1 || !Number.isFinite(atTime) || atTime < 0 || !Number.isFinite(rampSeconds) || rampSeconds < 0 || rampSeconds > 30)
      throw Error("Invalid track gain automation");
    const bus = this.trackBuses.get(trackId);
    if (!bus) return false;
    const now = this.currentTime;
    atTime = Math.max(now, atTime);
    const old = this.trackAutomation.get(trackId) ?? { initial: 1, ramps: [] };
    const valueAt = (time: number) => {
      let value = old.initial;
      for (const r of old.ramps) {
        if (time < r.at) break;
        value = time >= r.end ? r.to : r.from + (r.to - r.from) * (time - r.at) / (r.end - r.at);
      }
      return value;
    };
    const initial = valueAt(now), from = valueAt(atTime);
    const ramps = old.ramps.filter(r => r.end > now && r.at < atTime).map(r => ({ ...r, end: Math.min(r.end, atTime), to: valueAt(Math.min(r.end, atTime)) }));
    if (ramps.length >= 64) throw Error("Track automation capacity exceeded");
    ramps.push({ at: atTime, end: atTime + rampSeconds, from, to: gain });
    // Rebuild the remaining curve from an explicit current value. This also
    // works on devices without cancelAndHoldAtTime and never guesses .value.
    bus.gain.cancelScheduledValues(now);
    bus.gain.setValueAtTime(initial, now);
    for (const r of ramps) {
      if (r.at > now) bus.gain.setValueAtTime(r.from, r.at);
      if (r.end > Math.max(now, r.at)) bus.gain.linearRampToValueAtTime(r.to, r.end);
      else bus.gain.setValueAtTime(r.to, Math.max(now, r.at));
    }
    this.trackAutomation.set(trackId, { initial, ramps });
    return true;
  }
  /** Start of the current transport in local AudioContext seconds. */
  get transportOrigin() { this.syncTransport(); return this.origin; }
  private energy = 3;
  private trackEnergy = new Map<string, number>();
  private enqueue: ((score: Score) => void) | null = null;
  private queued = false;
  private nextTransports: {
    origin: number;
    start: number;
    end: number;
    bpm: number;
  }[] = [];
  /** Extension admission shares the same hard device voice budget. */
  protected reservedVoiceSlots(_end: number): number {
    return 0;
  }
  get isPlaying() {
    return this.playing;
  }
  /** Live/scheduled voices, excluding voices whose audio-clock release has elapsed. */
  get activeVoiceCount() {
    for (const v of this.voices)
      if (v.end <= this.currentTime) this.voices.delete(v);
    return this.voices.size;
  }
  get currentTime() {
    return this.context?.currentTime ?? 0;
  }
  get state() {
    return this.context?.state ?? "closed";
  }
  get hasQueuedScore() {
    this.syncTransport();
    return this.queued || this.nextTransports.length > 0;
  }
  /** Replace a looping score at the next unscheduled loop boundary. Last edit wins. */
  queueScore(score: Score) {
    if (this.playing && this.looping) this.enqueue?.(score);
  }
  private syncTransport() {
    while (
      this.nextTransports.length &&
      this.currentTime >= this.nextTransports[0]!.origin
    ) {
      const next = this.nextTransports.shift()!;
      this.origin = next.origin;
      this.rangeStart = next.start;
      this.rangeEnd = next.end;
      this.bpm = next.bpm;
    }
  }
  /** Live master gain affects scheduled and active music/effect voices without resetting transport. */
  setVolume(volume: number) {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1)
      throw new Error("Invalid volume");
    this.volume = volume;
    if (this.output && this.context)
      (this.master ?? this.output).gain.setValueAtTime(
        volume,
        this.context.currentTime,
      );
  }
  /** Shared preparation prevents an overlapping caller observing a half-built graph. */
  private enableInFlight: Promise<void> | null = null;
  async enable() {
    if (this.enableInFlight) return this.enableInFlight;
    const preparation = this.enableContext();
    this.enableInFlight = preparation;
    try {
      await preparation;
    } finally {
      if (this.enableInFlight === preparation) this.enableInFlight = null;
    }
  }
  private async enableContext() {
    if (!this.context || this.context.state === "closed") {
      // Pending decodes belong to their original device; reopened devices get
      // distinct identities. Unsettled native decodes retain their finite slots;
      // decoded AudioBuffers remain portable across contexts.
      this.sampleGeneration++;
      this.environment?.dispose();
      this.environment = null;
      this.master?.disconnect();
      this.master = null;
      this.output?.disconnect();
      this.lowMusic?.disconnect();
      this.lowMusic = null;
      this.protection?.disconnect();
      this.protection = null;
      this.protectedOutput?.disconnect();
      this.protectedOutput = null;
      const created = new AudioContext();
      this.context = created;
      this.output = created.createGain();
      this.output.gain.setValueAtTime(this.volume, this.context.currentTime);
      if (this.mixProfile === "weather-protected-1") {
        let protection: AudioWorkletNode;
        try {
          protection = await createProtectedMix(created);
        } catch (error) {
          if (created === this.context) await this.dispose();
          throw error;
        }
        if (created !== this.context) {
          protection.disconnect();
          return;
        }
        this.protection = protection;
        protection.addEventListener("processorerror", () => this.stop());
        this.master = created.createGain();
        this.master.gain.value = this.volume;
        this.output.gain.value = 1;
        this.lowMusic = created.createGain();
        this.lowMusic.connect(this.output);
        this.output.connect(this.master);
        this.master.connect(this.protection);
        this.protectedOutput = created.createGain();
        this.protection.connect(this.protectedOutput);
        this.protectedOutput.connect(created.destination);
      } else this.output.connect(this.context.destination);
      this.context.onstatechange = () => {
        if (created === this.context && created.state !== "running")
          this.stop();
      };
    }
    const ctx = this.context;
    await ctx.resume();
    if (ctx !== this.context) return;
    if (ctx.state !== "running") throw new Error("Sound could not be enabled");
    if (this.master)
      this.master.gain.setValueAtTime(this.volume, ctx.currentTime);
    this.protectedOutput?.gain.setValueAtTime(1, ctx.currentTime);
  }
  async play(score: Score, options: PlaybackOptions = {}) {
    this.stop();
    const token = this.generation;
    const looping = options.loop ?? score.playback === "loop";
    let plan = prepare(score, {
      ...options,
      energy: 3,
      startTick:
        options.startTick ?? (looping ? score.loop?.startTick : undefined),
      endTick: options.endTick ?? (looping ? score.loop?.endTick : undefined),
    });
    this.setEnergy(options.energy ?? 3);
    this.trackEnergy = new Map(score.tracks.map((t) => [t.id, t.minEnergy]));
    await this.enable();
    if (token !== this.generation) return;
    const ctx = this.context!;
    this.rangeStart = plan.start;
    this.rangeEnd = plan.end;
    this.bpm = score.bpm;
    this.looping = looping;
    this.origin = ctx.currentTime + 0.03;
    for (const track of score.tracks) {
      const bus = ctx.createGain();
      bus.gain.setValueAtTime(1, ctx.currentTime);
      bus.connect(this.musicDestination(track.role));
      this.trackBuses.set(track.id, bus);
      this.trackRoles.set(track.id, track.role);
    }
    this.playing = true;
    let scheduledScore = score,
      scheduleOrigin = this.origin;
    let pending: {
      score: Score;
      plan: ReturnType<typeof prepare>;
      when: number;
    } | null = null;
    this.enqueue = (next) => {
      // Snapshot before queuing: callers can continue editing their own score.
      const snapshot = structuredClone(next);
      const nextPlan = prepare(snapshot, {
        ...options,
        energy: 3,
        startTick: options.startTick ?? snapshot.loop?.startTick,
        endTick: options.endTick ?? snapshot.loop?.endTick,
      });
      const earliest = ctx.currentTime + LOOKAHEAD + 0.005;
      const boundary =
        scheduleOrigin +
        Math.max(1, Math.ceil((earliest - scheduleOrigin) / plan.length)) *
          plan.length;
      pending = {
        score: snapshot,
        plan: nextPlan,
        when: pending?.when ?? boundary,
      };
      this.queued = true;
    };
    let cycle = 0,
      index = 0;
    const pump = () => {
      if (!this.playing || token !== this.generation) return;
      this.syncTransport();
      for (const v of this.voices)
        if (v.end <= ctx.currentTime) this.voices.delete(v);
      // Removed tracks survive only while their release tails are still live.
      // Repeated queued edits cannot retain an unbounded collection of buses.
      for (const [id, bus] of this.trackBuses) {
        if (this.trackEnergy.has(id) || [...this.voices].some(v => v.trackId === id)) continue;
        bus.gain.cancelScheduledValues(ctx.currentTime); bus.disconnect();
        this.trackBuses.delete(id); this.trackRoles.delete(id); this.trackAutomation.delete(id);
      }
      const horizon = ctx.currentTime + LOOKAHEAD;
      let scheduled = 0;
      while (scheduled++ < MAX_EVENTS) {
        const nextEvent = plan.events[index];
        const nextWhen = nextEvent
          ? scheduleOrigin +
            cycle * plan.length +
            ticksToSeconds(
              Math.max(plan.start, nextEvent.startTick) - plan.start,
              scheduledScore.bpm,
            )
          : scheduleOrigin + (cycle + 1) * plan.length;
        if (
          pending &&
          pending.when <= horizon &&
          (!plan.events.length || nextWhen >= pending.when)
        ) {
          scheduleOrigin = pending.when;
          scheduledScore = pending.score;
          for (const track of scheduledScore.tracks) {
            const existing = this.trackBuses.get(track.id);
            if (existing) {
              if (this.trackRoles.get(track.id) !== track.role) {
                existing.disconnect(); existing.connect(this.musicDestination(track.role));
                this.trackRoles.set(track.id, track.role);
              }
              continue;
            }
            const bus = ctx.createGain();
            bus.gain.setValueAtTime(1, ctx.currentTime);
            bus.connect(this.musicDestination(track.role));
            this.trackBuses.set(track.id, bus);
            this.trackRoles.set(track.id, track.role);
          }
          plan = pending.plan;
          this.nextTransports.push({
            origin: scheduleOrigin,
            start: plan.start,
            end: plan.end,
            bpm: scheduledScore.bpm,
          });
          this.trackEnergy = new Map(
            scheduledScore.tracks.map((t) => [t.id, t.minEnergy]),
          );
          pending = null;
          this.queued = false;
          cycle = 0;
          index = 0;
          this.syncTransport();
        }
        if (index >= plan.events.length) {
          if (!this.looping || !plan.events.length) break;
          cycle++;
          index = 0;
          if (scheduleOrigin + cycle * plan.length > horizon) break;
        }
        const event = plan.events[index];
        const when =
          scheduleOrigin +
          cycle * plan.length +
          ticksToSeconds(
            Math.max(plan.start, event.startTick) - plan.start,
            scheduledScore.bpm,
          );
        if (when > horizon) break;
        index++;
        // Skip elapsed notes after throttling; never burst the missed backlog.
        if (when < ctx.currentTime - 0.02) {
          if (
            this.looping &&
            cycle * plan.length < ctx.currentTime - scheduleOrigin - plan.length
          ) {
            cycle = Math.floor(
              (ctx.currentTime - scheduleOrigin) / plan.length,
            );
            index = 0;
          }
          continue;
        }
        if ((this.trackEnergy.get(event.trackId) ?? 1) > this.energy) continue;
        const patch = scheduledScore.patches.find(
          (p) => p.id === event.patchId,
        );
        if (!patch) continue;
        if (this.voices.size >= this.voiceCapacity) {
          this.stop();
          return;
        }
        const duration = ticksToSeconds(
          Math.min(plan.end, event.startTick + event.durationTicks) -
            Math.max(plan.start, event.startTick),
          scheduledScore.bpm,
        );
        if (duration > 0) {
          const v = renderPerformanceVoice(
            ctx,
            this.trackBuses.get(event.trackId) ?? this.output!,
            patch,
            event.pitch,
            event.velocity,
            Math.max(ctx.currentTime, when),
            duration,
            event.gain,
            event.pan,
          );
          v.trackId = event.trackId;
          this.voices.add(v);
        }
      }
      if (
        !this.looping &&
        ctx.currentTime >=
          scheduleOrigin +
            plan.length +
            Math.max(0, ...scheduledScore.patches.map((p) => p.release))
      )
        this.stop();
    };
    pump();
    if (this.playing) this.timer = setInterval(pump, 25);
  }
  /** Changes layer eligibility while preserving the audio clock and fixed BPM. */
  setEnergy(energy: number) {
    if (!Number.isInteger(energy) || energy < 1 || energy > 3)
      throw new Error("Energy must be 1, 2 or 3");
    this.energy = energy;
    for (const v of this.voices)
      if (v.trackId && (this.trackEnergy.get(v.trackId) ?? 1) > energy) {
        v.stop();
        this.voices.delete(v);
      }
  }
  getPositionTick() {
    this.syncTransport();
    if (!this.playing) return this.rangeStart;
    let ticks =
      (Math.max(0, this.currentTime - this.origin) * this.bpm * 480) / 60;
    const length = this.rangeEnd - this.rangeStart;
    ticks = this.looping ? ticks % length : Math.min(length, ticks);
    return this.rangeStart + ticks;
  }
  /** Audio-clock delay to a score tick in the current pass; late notes start now. */
  getDelayToTick(tick: number) {
    this.syncTransport();
    if (
      !this.playing ||
      !Number.isFinite(tick) ||
      tick < this.rangeStart ||
      tick >= this.rangeEnd
    )
      return 0;
    const elapsed = this.currentTime - this.origin;
    const length = ticksToSeconds(this.rangeEnd - this.rangeStart, this.bpm);
    const offset = ticksToSeconds(tick - this.rangeStart, this.bpm);
    const cycle = this.looping ? Math.max(0, Math.floor(elapsed / length)) : 0;
    const when = cycle * length + offset;
    return Math.max(0, when - elapsed);
  }
  /** Compatibility wrapper for existing composer callers requiring a stop function. */
  previewNote(
    patch: Patch,
    pitch: number,
    velocity = 0.7,
    durationSeconds = 0.3,
    gain = 1,
    pan = 0,
    delaySeconds = 0,
  ): () => void {
    return (
      this.tryPreviewNote(
        patch,
        pitch,
        velocity,
        durationSeconds,
        gain,
        pan,
        delaySeconds,
      ) ?? (() => {})
    );
  }
  /** Explicit admission for owners that must account for device/capacity drops. */
  tryPreviewNote(
    patch: Patch,
    pitch: number,
    velocity = 0.7,
    durationSeconds = 0.3,
    gain = 1,
    pan = 0,
    delaySeconds = 0,
  ): (() => void) | null {
    if (!this.context || this.context.state !== "running") return null;
    for (const v of this.voices)
      if (v.end <= this.context.currentTime) this.voices.delete(v);
    if (
      this.voices.size +
        this.reservedVoiceSlots(
          this.context.currentTime +
            clamp(finite(delaySeconds, 0), 0, 10) +
            clamp(
              finite(durationSeconds, 0.3),
              1 / this.context.sampleRate,
              10,
            ) +
            Math.max(0.005, patch.release),
        ) >=
      this.voiceCapacity
    )
      return null;
    const v = renderPerformanceVoice(
      this.context,
      this.output!,
      patch,
      pitch,
      velocity,
      this.context.currentTime + clamp(finite(delaySeconds, 0), 0, 10),
      clamp(finite(durationSeconds, 0.3), 1 / this.context.sampleRate, 10),
      gain,
      pan,
    );
    this.voices.add(v);
    return () => {
      v.stop();
      this.voices.delete(v);
    };
  }
  /** Trusted canonical PCM16 WAVs. Defaults remain four <=1s/64KiB assets;
   * environment opts into four <=6s/1.2MB assets, with a shared 16MiB decoded cap.
   * Loading never creates another device owner. */
  async loadSample(
    id: string,
    bytes: ArrayBuffer,
    profile: "short" | "environment" = "short",
  ): Promise<number | null> {
    if (profile !== "short" && profile !== "environment")
      throw new Error("Invalid sample profile");
    const long = profile === "environment";
    const maxDuration = long ? 6 : 1;
    if (
      !/^[a-z][a-z0-9-]{0,31}$/.test(id) ||
      bytes.byteLength < 44 ||
      bytes.byteLength > (long ? 1_152_044 : 65536)
    )
      throw new Error("Sample exceeds encoded limits");
    // Validate canonical PCM16 WAV before native decode to bound allocation too.
    const header = new DataView(bytes),
      ascii = (at: number, text: string) =>
        [...text].every((c, i) => header.getUint8(at + i) === c.charCodeAt(0));
    const channels = header.getUint16(22, true),
      rate = header.getUint32(24, true),
      dataBytes = header.getUint32(40, true);
    if (
      !ascii(0, "RIFF") ||
      !ascii(8, "WAVEfmt ") ||
      !ascii(36, "data") ||
      header.getUint32(4, true) !== bytes.byteLength - 8 ||
      header.getUint32(16, true) !== 16 ||
      header.getUint16(20, true) !== 1 ||
      ![1, 2].includes(channels) ||
      rate < 8000 ||
      rate > 48000 ||
      header.getUint16(34, true) !== 16 ||
      header.getUint16(32, true) !== channels * 2 ||
      header.getUint32(28, true) !== rate * channels * 2 ||
      dataBytes !== bytes.byteLength - 44 ||
      !dataBytes ||
      dataBytes % (channels * 2) ||
      dataBytes / (channels * 2 * rate) > maxDuration
    )
      throw new Error("Unsupported or oversized sample WAV");
    if (this.samples.has(id)) return this.samples.get(id)!.duration;
    const token = this.sampleGeneration,
      pendingKey = `${token}:${long ? "environment" : "short"}:${id}`;
    if (
      [...this.pendingSamples].some(
        (key) => key.startsWith(`${token}:`) && key.endsWith(`:${id}`),
      ) ||
      [...this.samples.keys()].filter(
        (key) => this.environmentSamples.has(key) === long,
      ).length +
        [...this.pendingSamples].filter((key) =>
          key.includes(`:${long ? "environment" : "short"}:`),
        ).length >=
        4
    )
      throw new Error("Sample load capacity exceeded");
    const ctx = this.context;
    if (!ctx || ctx.state !== "running") return null;
    this.pendingSamples.add(pendingKey);
    try {
      const buffer = await ctx.decodeAudioData(bytes.slice(0));
      if (
        token !== this.sampleGeneration ||
        ctx !== this.context ||
        ctx.state !== "running"
      )
        return null;
      if (
        !Number.isFinite(buffer.duration) ||
        buffer.duration <= 0 ||
        buffer.duration > maxDuration ||
        buffer.numberOfChannels < 1 ||
        buffer.numberOfChannels > 2 ||
        buffer.length > (long ? Math.ceil(ctx.sampleRate * 6) : 96000) ||
        [...this.samples.values()].reduce(
          (sum, sample) => sum + sample.length * sample.numberOfChannels * 4,
          0,
        ) +
          buffer.length * buffer.numberOfChannels * 4 >
          16 * 1024 * 1024
      )
        throw new Error("Sample exceeds decoded limits");
      this.samples.set(id, buffer);
      if (long) this.environmentSamples.add(id);
      return buffer.duration;
    } catch (error) {
      // Device cancellation supersedes a decoder failure from its old context.
      if (
        token !== this.sampleGeneration ||
        ctx !== this.context ||
        ctx.state !== "running"
      )
        return null;
      throw error;
    } finally {
      this.pendingSamples.delete(pendingKey);
    }
  }
  private environmentGraph() {
    if (!this.context || this.context.state !== "running" || !this.output)
      return null;
    if (this.mixProfile === "weather-protected-1" && !this.protection) return null;
    if (!this.environment) {
      if (!this.master) {
        this.master = this.context.createGain();
        this.master.gain.setValueAtTime(this.volume, this.currentTime);
        this.master.connect(this.context.destination);
        this.output.disconnect();
        this.output.gain.setValueAtTime(1, this.currentTime);
        this.output.connect(this.master);
        for (const effect of this.legacySampleOutputs) {
          effect.disconnect();
          effect.connect(this.master);
        }
      }
      this.environment = new EnvironmentAudio(
        this.context,
        this.master,
        this.output,
      );
      this.environment.setVolume(this.environmentVolume, 0);
    }
    return this.environment;
  }
  /** Read-only tap points share the same device clock. Consumers must disconnect
   * their capture graph before disposal and retain at most their declared budget. */
  readProtectionStats() {
    return readProtectionStats(this.protection);
  }
  /** Allocate the stable environment bus before observers connect. Beds/impacts
   * may start later; preparation itself creates no environmental sources. */
  prepareMixCaptureTaps() {
    this.environmentGraph();
    return this.readMixTaps();
  }
  readMixTaps() {
    return {
      profile: this.mixProfile,
      latencySeconds: this.outputLatencySeconds,
      master: this.protectedOutput ?? this.master ?? this.output,
      preProtection: this.master ?? this.output,
      environment: this.environment?.captureTap ?? null,
      lowMusic: this.lowMusic,
      music: this.output,
    };
  }
  /** Live environmental bus gain affects active thunder and beds without music attenuation. */
  setEnvironmentVolume(gain: number, rampSeconds = 0.03) {
    if (
      !Number.isFinite(gain) ||
      gain < 0 ||
      gain > 1 ||
      !Number.isFinite(rampSeconds) ||
      rampSeconds < 0 ||
      rampSeconds > 2
    )
      throw new Error("Invalid environment volume");
    this.environmentVolume = gain;
    this.environment?.setVolume(gain, rampSeconds);
  }
  /** Scheduled auxiliary effects have an independent four-voice budget. */
  scheduleSample(
    id: string,
    options: ScheduledSampleOptions = {},
  ): (() => void) | null {
    const buffer = this.samples.get(id);
    return buffer
      ? (this.environmentGraph()?.schedule(buffer, options) ?? null)
      : null;
  }
  setNoiseBed(id: string, options: NoiseBedOptions) {
    return this.environmentGraph()?.setBed(id, options) ?? false;
  }
  stopNoiseBed(id: string) {
    this.environment?.stopBed(id);
  }
  duckMusic(
    gain: number,
    holdSeconds = 0.3,
    releaseSeconds = 0.7,
    atContextTime?: number,
  ) {
    return (
      this.environmentGraph()?.duck(
        gain,
        holdSeconds,
        releaseSeconds,
        atContextTime,
      ) ?? false
    );
  }
  /** Uses the same master gain and global voice cap as score and synth voices. */
  previewSample(id: string, gain = 0.7): (() => void) | null {
    if (this.environmentSamples.has(id))
      return this.scheduleSample(id, { gain });
    const ctx = this.context,
      buffer = this.samples.get(id);
    if (!ctx || ctx.state !== "running" || !buffer) return null;
    for (const v of this.voices)
      if (v.end <= ctx.currentTime) this.voices.delete(v);
    if (
      this.voices.size +
        this.reservedVoiceSlots(ctx.currentTime + buffer.duration) >=
      this.voiceCapacity
    )
      return null;
    const source = ctx.createBufferSource(),
      envelope = ctx.createGain();
    source.buffer = buffer;
    envelope.gain.setValueAtTime(
      clamp(finite(gain, 0.7), 0, 1),
      ctx.currentTime,
    );
    source.connect(envelope);
    envelope.connect(this.master ?? this.output!);
    this.legacySampleOutputs.add(envelope);
    let stopped = false;
    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      source.disconnect();
      envelope.disconnect();
      this.legacySampleOutputs.delete(envelope);
      this.voices.delete(v);
    };
    const v: Voice = {
      end: ctx.currentTime + buffer.duration,
      stop: () => {
        if (stopped) return;
        source.stop();
        cleanup();
      },
    };
    source.onended = cleanup;
    this.voices.add(v);
    source.start(ctx.currentTime);
    return v.stop;
  }
  stop() {
    this.protectedOutput?.gain.setValueAtTime(0, this.currentTime);
    this.protection?.port.postMessage("reset");
    this.environment?.stop();
    this.generation++;
    this.playing = false;
    this.enqueue = null;
    this.queued = false;
    this.nextTransports = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const v of this.voices) v.stop();
    this.voices.clear();
    for (const bus of this.trackBuses.values()) {
      bus.gain.cancelScheduledValues(this.currentTime);
      bus.disconnect();
    }
    this.trackBuses.clear();
    this.trackAutomation.clear();
    this.trackRoles.clear();
  }
  async dispose() {
    this.enableInFlight = null;
    this.sampleGeneration++;
    this.samples.clear();
    this.environmentSamples.clear();
    this.stop();
    const ctx = this.context;
    this.context = null;
    this.environment?.dispose();
    this.environment = null;
    this.master?.disconnect();
    this.master = null;
    this.output?.disconnect();
    this.lowMusic?.disconnect();
    this.lowMusic = null;
    this.protection?.disconnect();
    this.protection = null;
    this.protectedOutput?.disconnect();
    this.protectedOutput = null;
    this.output = null;
    if (ctx && ctx.state !== "closed") await ctx.close();
  }
}

export async function renderScore(
  score: Score,
  options: RenderOptions = {},
): Promise<AudioBuffer> {
  const plan = prepare(score, options);
  const loops = options.loops ?? 1,
    sampleRate = options.sampleRate ?? 48000,
    tail = options.tailSeconds ?? 0.2;
  if (
    !Number.isInteger(loops) ||
    loops < 1 ||
    loops > 128 ||
    ![22050, 44100, 48000, 96000].includes(sampleRate) ||
    !Number.isFinite(tail) ||
    tail < 0 ||
    tail > 10
  )
    throw new Error("Invalid render options");
  const duration = plan.length * loops + tail,
    frames = Math.ceil(duration * sampleRate);
  if (
    !Number.isFinite(frames) ||
    frames < 1 ||
    duration > 600 ||
    frames > MAX_FRAMES ||
    plan.events.length * loops > MAX_EVENTS
  )
    throw new Error("Render exceeds supported size");
  const ctx = new OfflineAudioContext(2, frames, sampleRate);
  const ends: number[] = [];
  for (let cycle = 0; cycle < loops; cycle++)
    for (const event of plan.events) {
      const patch = score.patches.find((p) => p.id === event.patchId);
      if (!patch) continue;
      const at =
        cycle * plan.length +
        ticksToSeconds(
          Math.max(plan.start, event.startTick) - plan.start,
          score.bpm,
        );
      const length = ticksToSeconds(
        Math.min(plan.end, event.startTick + event.durationTicks) -
          Math.max(plan.start, event.startTick),
        score.bpm,
      );
      if (length <= 0) continue;
      while (ends.length && ends[0] <= at) ends.shift();
      if (ends.length >= MAX_VOICES)
        throw new Error("Render exceeds voice limit");
      const v = renderPerformanceVoice(
        ctx,
        ctx.destination,
        patch,
        event.pitch,
        event.velocity,
        at,
        length,
        event.gain,
        event.pan,
      );
      ends.push(v.end);
      ends.sort((a, b) => a - b);
    }
  return ctx.startRendering();
}

export function encodeWav(buffer: AudioBuffer): Uint8Array {
  const channels = buffer.numberOfChannels,
    frames = buffer.length;
  if (channels < 1 || channels > 2 || frames > MAX_FRAMES)
    throw new Error("Unsupported WAV dimensions");
  const bytes = frames * channels * 2,
    result = new Uint8Array(44 + bytes),
    view = new DataView(result.buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) result[at + i] = value.charCodeAt(i);
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, bytes, true);
  const data = Array.from({ length: channels }, (_, c) =>
    buffer.getChannelData(c),
  );
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < channels; c++) {
      const s = clamp(finite(data[c][i], 0), -1, 1);
      view.setInt16(
        44 + (i * channels + c) * 2,
        Math.round(s * (s < 0 ? 32768 : 32767)),
        true,
      );
    }
  return result;
}
