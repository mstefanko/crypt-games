import { AudioEngine, type PlaybackOptions } from "@onepage/music-web-audio";
import {
  AdaptiveMusic,
  type MusicArrangements,
} from "./presentation/adaptive-music.ts";
import type { Patch, Score } from "@onepage/project";

/** Injectable device boundary; PPQ ticks never come from gameplay ticks. */
export interface M2AudioEngine {
  readonly currentTime: number;
  readonly activeVoiceCount?: number;
  readonly isPlaying?: boolean;
  enable(): Promise<void>;
  play(score: Score, options?: PlaybackOptions): Promise<void>;
  setEnergy(energy: number): void;
  queueScore?(score: Score): void;
  previewNote(
    patch: Patch,
    pitch: number,
    velocity?: number,
    durationSeconds?: number,
    gain?: number,
    pan?: number,
    delaySeconds?: number,
  ): () => void;
  /** Legacy injected engines may omit admission; their previewNote must admit. */
  tryPreviewNote?: (
    ...args: Parameters<M2AudioEngine["previewNote"]>
  ) => (() => void) | null;
  loadSample?(id: string, bytes: ArrayBuffer): Promise<number | null>;
  previewSample?(id: string, gain?: number): (() => void) | null;
  stop(): void;
  dispose(): Promise<void>;
}
let owner: M2Audio | undefined;

/** One synth/context owns music and bounded SFX/dialogue buses. No HTMLAudio/RAF. */
export class M2Audio {
  private readonly engine: M2AudioEngine;
  private score: Score;
  readonly music?: AdaptiveMusic;
  private disposed = false;
  private unlocked = false;
  private paused = true;
  private muted = false;
  private energy: 1 | 2 = 1;
  private generation = 0;
  private running = false;
  private transportStarts = 0;
  private starting?: { token: number; promise: Promise<void> };
  // Device unlock survives transport cancellation; only disposal/ownership can
  // invalidate its result. Keep a single resume request until it settles.
  private unlocking?: Promise<boolean>;
  private suppressedThrough = -1;
  private sounds = new Map<string, { stop: () => void; end: number }>();
  private seen = new Set<string>();
  private error: string | null = null;
  private acceptedSounds = 0;
  private sampleDurations = new Map<string, number>();
  private sampleLoading?: Promise<void>;
  private sampleFailures = 0;
  private acceptedSamples = 0;
  private duplicateSounds = 0;
  private capacityDropped = 0;
  private cueLog: { key: string; audioTime: number }[] = [];
  constructor(
    private readonly options: {
      /** Default score for ordinary playback. With music, its low/high scores
       * take precedence for all playback and synth fallback patch selection. */
      score: Score;
      /** Optional adaptive bank; low is selected initially and overrides score. */
      music?: MusicArrangements;
      samples?: readonly { id: string; bytes: ArrayBuffer }[];
      engine?: M2AudioEngine;
      onError?: (message: string) => void;
      /** Cancel an authoring preview before acquiring the runtime audio device. */
      stopAudition?: () => void;
    },
  ) {
    if (
      (options.samples?.length ?? 0) > 4 ||
      options.samples?.some(
        (s) =>
          !/^[a-z][a-z0-9-]{0,31}$/.test(s.id) || s.bytes.byteLength > 65536,
      ) ||
      new Set(options.samples?.map((s) => s.id)).size !==
        (options.samples?.length ?? 0)
    )
      throw Error("Invalid sample selection");
    this.score = structuredClone(options.score);
    this.engine = options.engine ?? new AudioEngine();
    if (options.music) {
      if (!this.engine.queueScore)
        throw Error("Adaptive music requires queued score support");
      this.music = new AdaptiveMusic(options.music, (score, energy) => {
        this.score = score;
        this.setEnergy(energy);
        if (this.running) {
          try {
            this.engine.queueScore!(score);
          } catch (error) {
            this.fail(error);
          }
        }
      });
    }
  }
  private fail(error: unknown): void {
    this.error = `Sound unavailable: ${error instanceof Error ? error.message : String(error)}`;
    this.options.onError?.(this.error);
  }
  private clearSounds(): void {
    for (const sound of this.sounds.values()) sound.stop();
    this.sounds.clear();
  }
  private stop(): void {
    this.generation++;
    this.running = false;
    this.starting = undefined;
    this.clearSounds();
    this.engine.stop();
  }
  /** Invoke synchronously from the actual pointer/key activation callback. */
  unlock(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (owner !== this) {
      owner?.pause();
      owner = this;
    }
    this.options.stopAudition?.();
    if (this.unlocking) return this.unlocking;
    const promise = this.enable();
    this.unlocking = promise;
    void promise.finally(() => {
      if (this.unlocking === promise) this.unlocking = undefined;
    });
    return promise;
  }
  private async enable(): Promise<boolean> {
    try {
      await this.engine.enable();
      if (this.disposed || owner !== this) return false;
      this.unlocked = true;
      this.error = null;
      if (this.options.samples?.length) await this.loadSamples();
      await this.start();
      return !this.disposed && owner === this;
    } catch (error) {
      if (!this.disposed && owner === this) this.fail(error);
      return false;
    }
  }
  private loadSamples(): Promise<void> {
    if (this.sampleLoading) return this.sampleLoading;
    const promise = (async () => {
      for (const sample of this.options.samples ?? []) {
        if (this.disposed || owner !== this) return;
        // The device cache is authoritative (it can be recreated independently).
        // Loading is idempotent there; recheck selected assets on every gesture.
        this.sampleDurations.delete(sample.id);
        const token = this.generation;
        try {
          if (!this.engine.loadSample || !this.engine.previewSample)
            throw Error("Decoded sample playback unsupported");
          const duration = await this.engine.loadSample(
            sample.id,
            sample.bytes,
          );
          if (
            duration !== null &&
            !this.disposed &&
            owner === this &&
            token === this.generation
          )
            this.sampleDurations.set(sample.id, duration);
        } catch (error) {
          if (!this.disposed && owner === this && token === this.generation) {
            this.sampleFailures++;
            this.fail(error);
          }
        }
      }
    })();
    this.sampleLoading = promise;
    void promise.finally(() => {
      if (this.sampleLoading === promise) this.sampleLoading = undefined;
    });
    return promise;
  }
  private start(): Promise<void> {
    if (
      this.disposed ||
      this.paused ||
      this.muted ||
      !this.unlocked ||
      owner !== this
    )
      return Promise.resolve();
    if (this.running && this.engine.isPlaying !== false)
      return Promise.resolve();
    const token = this.generation;
    if (this.starting?.token === token) return this.starting.promise;
    const promise = this.play(token);
    this.starting = { token, promise };
    void promise.finally(() => {
      if (this.starting?.promise === promise) this.starting = undefined;
    });
    return promise;
  }
  private async play(token: number): Promise<void> {
    try {
      this.transportStarts++;
      // Only an explicit stop/reset begins another authored loop. Ordinary flow
      // entries retain the existing AudioEngine clock and eligible music voices.
      const startedScore = this.score;
      await this.engine.play(startedScore, { loop: true, energy: this.energy });
      if (!this.disposed && token === this.generation) {
        this.running = true;
        if (this.score !== startedScore) {
          this.engine.setEnergy(this.energy);
          this.engine.queueScore?.(this.score);
        }
      }
    } catch (error) {
      if (!this.disposed && token === this.generation) this.fail(error);
    }
  }
  setEncounter(active: boolean): void {
    this.setEnergy(active ? 2 : 1);
  }
  setEnergy(energy: 1 | 2): void {
    if (this.disposed || this.energy === energy) return;
    this.energy = energy;
    this.engine.setEnergy(energy);
  }
  setMuted(muted: boolean): void {
    if (this.disposed || muted === this.muted) return;
    this.muted = muted;
    this.stop();
    if (!muted) void this.start();
  }
  pause(): void {
    if (this.disposed) return;
    this.paused = true;
    this.music?.pause();
    this.stop();
  }
  async resume(): Promise<void> {
    if (this.disposed) return;
    this.paused = false;
    this.music?.resume();
    await this.start();
  }
  /** Normal flow entry clears transient buses but preserves the music transport. */
  transition(suppressThroughGameplayTick = -1): void {
    if (this.disposed) return;
    this.clearSounds();
    this.seen.clear();
    this.suppressedThrough = suppressThroughGameplayTick;
    // Adaptive intent survives ordinary flow entries just like its transport.
    // Clearing transient buses must not lower its energy or requeue its score.
    if (!this.music) this.setEnergy(1);
  }
  /** Explicit restore/transport reset invalidates events and stops all voices. */
  reset(suppressThroughGameplayTick = -1): void {
    if (this.disposed) return;
    this.stop();
    this.seen.clear();
    this.suppressedThrough = suppressThroughGameplayTick;
    this.setEnergy(1);
    if (this.music) this.music.restore(this.music.snapshot());
    if (!this.paused) void this.start();
  }
  suppressEffectsThrough(gameplayTick: number): void {
    this.reset(Math.max(this.suppressedThrough, gameplayTick));
  }
  effect(
    id: string,
    patch: Patch,
    pitch: number,
    durationSeconds = 0.1,
    atGameplayTick?: number,
  ): void {
    this.sound("sfx", id, patch, pitch, durationSeconds, atGameplayTick);
  }
  dialogue(id: string, patch: Patch, pitch = 72, durationSeconds = 0.07): void {
    this.sound("dialogue", id, patch, pitch, durationSeconds);
  }
  /** Use a short synth fallback while loading/unavailable; never replay old cues. */
  sampleEffect(id: string, sampleId: string, atGameplayTick?: number): boolean {
    const duration = this.sampleDurations.get(sampleId);
    return this.sound(
      "sfx",
      id,
      this.score.patches[0],
      48,
      duration ?? 0.08,
      atGameplayTick,
      duration === undefined ? undefined : sampleId,
    );
  }
  private sound(
    bus: "sfx" | "dialogue",
    id: string,
    patch: Patch,
    pitch: number,
    duration: number,
    tick?: number,
    sampleId?: string,
  ): boolean {
    if (
      this.disposed ||
      !this.unlocked ||
      this.paused ||
      this.muted ||
      owner !== this ||
      (tick !== undefined && tick <= this.suppressedThrough)
    )
      return false;
    const key = `${bus}:${id}`;
    if (this.seen.has(key)) {
      this.duplicateSounds++;
      return false;
    }
    for (const [key, sound] of this.sounds)
      if (sound.end <= this.engine.currentTime) this.sounds.delete(key);
    if (this.sounds.size >= 32) {
      this.capacityDropped++;
      return false;
    }
    const stop = sampleId
      ? (this.engine.previewSample?.(sampleId, 0.7) ?? null)
      : this.engine.tryPreviewNote
        ? this.engine.tryPreviewNote(
            patch,
            pitch,
            0.6,
            duration,
            bus === "dialogue" ? 0.3 : 0.7,
          )
        : this.engine.previewNote(
            patch,
            pitch,
            0.6,
            duration,
            bus === "dialogue" ? 0.3 : 0.7,
          );
    if (!stop) {
      this.capacityDropped++;
      return false;
    }
    this.seen.add(key);
    if (this.seen.size > 512)
      this.seen.delete(this.seen.values().next().value!);
    this.acceptedSounds++;
    this.cueLog.push({ key, audioTime: this.engine.currentTime });
    if (this.cueLog.length > 64) this.cueLog.shift();
    if (sampleId) this.acceptedSamples++;
    this.sounds.set(key, {
      stop,
      end: this.engine.currentTime + duration + (sampleId ? 0 : patch.release),
    });
    return true;
  }
  stats() {
    return {
      unlocked: this.unlocked,
      muted: this.muted,
      paused: this.paused,
      energy: this.energy,
      activeVoices: this.engine.activeVoiceCount ?? null,
      transportStarts: this.transportStarts,
      acceptedSounds: this.acceptedSounds,
      acceptedSamples: this.acceptedSamples,
      loadedSamples: this.sampleDurations.size,
      sampleFailures: this.sampleFailures,
      duplicateSounds: this.duplicateSounds,
      capacityDropped: this.capacityDropped,
      cueLog: this.cueLog.map((cue) => ({ ...cue })),
      error: this.error,
      disposed: this.disposed,
    };
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.music?.dispose();
    this.sampleDurations.clear();
    this.stop();
    if (owner === this) owner = undefined;
    await this.engine.dispose();
  }
}
export type { Patch, Score } from "@onepage/project";
