import { WorkletSynthesizer } from "spessasynth_lib";
import { SoundBankLoader, SpessaSynthProcessor } from "spessasynth_core";
import type { Patch } from "@onepage/project";
import { renderPerformanceVoice, type PerformanceVoiceRenderer, type Voice } from "./index";

import type { InstrumentPalette } from "@onepage/music-core/instrument-palette";
import {
  prepareInstrumentBindings,
  snapshotInstrumentPalette,
  type InstrumentRendererCapabilities,
} from "./instrument-renderer";
export interface SoundfontInstrumentConfig {
  readonly id: string;
  readonly palette: InstrumentPalette;
  readonly capabilities: InstrumentRendererCapabilities;
  readonly bankUrl: string;
  readonly bankSha256: string;
  readonly workletUrl: string;
  readonly worklets: number;
  readonly maxBankBytes?: number;
  readonly fallbackReleaseSeconds?: number;
  readonly fixedPitches?: Readonly<Record<string, number>>;
  readonly legacyInstrument?: (
    patch: Patch,
    pitch: number,
  ) => { program: number; pitch: number } | undefined;
}
const MAX_OFFLINE_FRAMES = 32_000_000;
const PREPARE_TIMEOUT_MS = 8_000;
const clip = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
type Slot = {
  synth: WorkletSynthesizer;
  channel: number;
  through: number;
  cleanups: { end: number; run(): void }[];
};
type State = {
  slots: Slot[];
  synths: WorkletSynthesizer[];
  core?: SpessaSynthProcessor;
  offlineFrames: number;
  disposed: boolean;
};
const midiVelocity = (velocity: number) =>
  velocity <= 0 ? 0 : Math.round(clip(velocity, 0, 1) * 126) + 1;

/** Resource-injected SoundFont playback; the host transport owns every onset. */
export class SoundfontInstrumentRenderer implements PerformanceVoiceRenderer {
  readonly id: string;
  readonly paletteIdentity: Readonly<{ id: string; hash: string }>;
  private readonly config: SoundfontInstrumentConfig;
  private readonly palette: InstrumentPalette;
  constructor(config: SoundfontInstrumentConfig) {
    this.palette = snapshotInstrumentPalette(config.palette);
    this.config = Object.freeze({
      ...config,
      palette: this.palette,
      fixedPitches: Object.freeze({ ...config.fixedPitches }),
      capabilities: Object.freeze({
        ...config.capabilities,
        instruments: Object.freeze([...config.capabilities.instruments]),
      }),
    });
    if (
      !Number.isInteger(config.worklets) ||
      config.worklets < 1 ||
      config.worklets > 4 ||
      config.worklets * 16 !== config.capabilities.maxVoices
    )
      throw Error("Invalid SoundFont worklet profile");
    this.id = config.id;
    this.paletteIdentity = Object.freeze({
      id: this.palette.id,
      hash: this.palette.hash,
    });
  }
  get maxVoices() {
    return this.config.capabilities.maxVoices;
  }
  private instrument(patch: Patch, pitch: number) {
    const binding = this.palette.bindings.find((b) => b.patchId === patch.id);
    const selected = binding
      ? {
          program: binding.soundfontProgram,
          pitch:
            this.config.fixedPitches?.[patch.id] ??
            Math.round(clip(pitch, 0, 127)),
        }
      : this.config.legacyInstrument?.(patch, pitch);
    if (!selected) throw Error(`Unbound acoustic patch ${patch.id}`);
    return selected;
  }
  private states = new WeakMap<BaseAudioContext, State>();
  private preparing = new WeakMap<BaseAudioContext, Promise<void>>();
  private bank?: Promise<ArrayBuffer>;
  private retainedBankBytes = 0;
  private activeWorkletCount = 0;
  memoryDiagnostics() {
    return Object.freeze({
      kind: "soundfont-known-resource-inventory",
      retainedBankArrayBufferBytes: this.retainedBankBytes,
      activeWorkletCount: this.activeWorkletCount,
      configuredWorkletsPerLiveContext: this.config.worklets,
      scope:
        "Retained fetched bank ArrayBuffer and active worklet instances only. Excludes parsed bank/sample copies, processor heaps, offline core, effects, transport buffers and total process memory.",
    });
  }
  releaseSeconds(patch: Patch) {
    if (patch.waveform === "harmonic-bass") return Math.max(0.005, patch.release);
    return (
      this.palette.bindings.find((b) => b.patchId === patch.id)
        ?.releaseSeconds ??
      this.config.fallbackReleaseSeconds ??
      0.18
    );
  }
  async prepareContext(context: BaseAudioContext): Promise<void> {
    const pending = this.preparing.get(context);
    if (pending) return pending;
    if (this.states.has(context)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        this.releaseContext(context);
        reject(
          Error(
            "SoundFont preparation timed out; original synth remains available",
          ),
        );
      }, PREPARE_TIMEOUT_MS);
    });
    const work = Promise.race([
      this.prepare(context, controller.signal),
      timeout,
    ]);
    this.preparing.set(context, work);
    try {
      await work;
    } finally {
      clearTimeout(timer!);
      this.preparing.delete(context);
    }
  }
  private async prepare(context: BaseAudioContext, signal: AbortSignal) {
    prepareInstrumentBindings(this.palette, this.config.capabilities);
    this.bank ??= fetch(this.config.bankUrl, {
      signal: AbortSignal.timeout(7_500),
    })
      .then(async (response) => {
        if (!response.ok)
          throw Error(`SoundFont unavailable (${response.status})`);
        const bank = await response.arrayBuffer();
        if (
          bank.byteLength >
          (this.config.maxBankBytes ?? this.palette.profile.maxPackagedBytes)
        )
          throw Error("SoundFont exceeds palette budget");
        const digest = new Uint8Array(
          await crypto.subtle.digest("SHA-256", bank),
        );
        if (
          Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(
            "",
          ) !== this.config.bankSha256
        )
          throw Error("SoundFont hash mismatch");
        this.retainedBankBytes = bank.byteLength;
        return bank;
      })
      .catch((error) => {
        this.bank = undefined;
        this.retainedBankBytes = 0;
        throw error;
      });
    const bank = await this.bank;
    signal.throwIfAborted();
    const state: State = {
      slots: [],
      synths: [],
      offlineFrames: 0,
      disposed: false,
    };
    this.states.set(context, state);
    try {
      if ("startRendering" in context) {
        const core = new SpessaSynthProcessor(context.sampleRate, {
          effectsEnabled: false,
          maxBufferSize: 128,
        });
        state.core = core;
        await core.processorInitialized;
        signal.throwIfAborted();
        if (state.disposed) throw Error("SoundFont loading cancelled");
        core.soundBankManager.addSoundBank(
          SoundBankLoader.fromArrayBuffer(bank.slice(0)),
          "palette",
        );
        core.setSystemParameter("voiceCap", 16);
        core.setSystemParameter("autoAllocateVoices", false);
        core.setSystemParameter("gain", 4);
      } else {
        await context.audioWorklet.addModule(this.config.workletUrl);
        signal.throwIfAborted();
        for (let group = 0; group < this.config.worklets; group++) {
          if (state.disposed) throw Error("SoundFont loading cancelled");
          const synth = new WorkletSynthesizer(context, {
            eventsEnabled: false,
          });
          state.synths.push(synth);
          this.activeWorkletCount++;
          await synth.soundBankManager.addSoundBank(bank.slice(0), "palette");
          await synth.isReady;
          if (state.disposed) throw Error("SoundFont loading cancelled");
          synth.setSystemParameter("effectsEnabled", false);
          synth.setSystemParameter("voiceCap", 32);
          synth.setSystemParameter("autoAllocateVoices", false);
          synth.setSystemParameter("gain", 4);
          for (let channel = 0; channel < 16; channel++) {
            synth.midiChannels[channel].setDrums(false);
            state.slots.push({ synth, channel, through: -1, cleanups: [] });
          }
        }
      }
      if (state.disposed) throw Error("SoundFont loading cancelled");
    } catch (error) {
      if (this.states.get(context) === state) this.releaseContext(context);
      throw error;
    }
  }
  releaseContext(context: BaseAudioContext) {
    const state = this.states.get(context);
    if (!state) return;
    state.disposed = true;
    for (const slot of state.slots)
      for (const cleanup of slot.cleanups) cleanup.run();
    for (const synth of state.synths) synth.destroy();
    this.activeWorkletCount -= state.synths.length;
    state.core?.destroySynthProcessor();
    this.states.delete(context);
  }
  renderVoice(
    context: BaseAudioContext,
    destination: AudioNode,
    patch: Patch,
    pitch: number,
    velocity: number,
    at: number,
    duration: number,
    gain = 1,
    pan = 0,
  ): Voice {
    if (patch.waveform === "harmonic-bass")
      return renderPerformanceVoice(context, destination, patch, pitch, velocity, at, duration, gain, pan);
    const state = this.states.get(context);
    if (!state || state.disposed)
      throw Error("SoundFont renderer is not ready");
    const selected = this.instrument(patch, pitch);
    const release = this.releaseSeconds(patch);
    const binding = this.palette.bindings.find((b) => b.patchId === patch.id);
    if (
      binding?.minSustainSeconds !== undefined &&
      duration + 0.001 < binding.minSustainSeconds
    )
      throw Error(
        `Duration truncates natural tail for ${binding.instrumentId}`,
      );
    if (binding && duration > binding.maxSustainSeconds + 0.001)
      throw Error("SoundFont sustain exceeds palette policy");
    const end = at + duration + release;
    const envelope = context.createGain(),
      panner = context.createStereoPanner();
    envelope.gain.value = 0;
    envelope.gain.setValueAtTime(0, 0);
    envelope.gain.setValueAtTime(
      clip(gain, 0, 2) * 0.7 * (binding?.calibratedGain ?? 1),
      at,
    );
    // The bank's release is 180ms; this final gate also bounds exceptional tails.
    envelope.gain.setValueAtTime(0, end);
    panner.pan.value = clip(pan, -1, 1);
    envelope.connect(panner);
    panner.connect(destination);
    let disconnectSource = () => {};
    let noteOff = (_time: number) => {};
    let retireSlot = (_time: number, _end: number) => {};
    if (state.core) {
      const frames = Math.ceil((duration + release) * context.sampleRate);
      if (state.offlineFrames + frames > MAX_OFFLINE_FRAMES)
        throw Error(
          "SoundFont export exceeds 32M voice-frame memory budget; export a shorter take",
        );
      state.offlineFrames += frames;
      const core = state.core;
      core.stopAllChannels(true);
      core.programChange(0, selected.program);
      core.noteOn(0, selected.pitch, midiVelocity(velocity));
      core.processMessage([0x80, selected.pitch, 0], 0, {
        time: core.currentTime + duration,
      });
      const buffer = context.createBuffer(2, frames, context.sampleRate);
      const left = buffer.getChannelData(0),
        right = buffer.getChannelData(1);
      for (let frame = 0; frame < frames; frame += 128)
        core.process(left, right, frame, Math.min(128, frames - frame));
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(envelope);
      source.start(at);
      disconnectSource = () => {
        try {
          source.stop();
        } catch {
          /* Already ended. */
        }
        source.disconnect();
      };
    } else {
      const slot = state.slots.find((s) => s.through <= at);
      if (!slot) {
        envelope.disconnect();
        panner.disconnect();
        throw Error("SoundFont voice capacity exceeded");
      }
      for (const s of state.slots) {
        s.cleanups = s.cleanups.filter((cleanup) => {
          if (cleanup.end <= context.currentTime) {
            cleanup.run();
            return false;
          }
          return true;
        });
      }
      slot.through = end;
      const { synth, channel } = slot;
      synth.connectChannel(envelope, channel);
      synth.programChange(channel, selected.program, { time: at });
      synth.noteOn(channel, selected.pitch, midiVelocity(velocity), {
        time: at,
      });
      synth.noteOff(channel, selected.pitch, { time: at + duration });
      noteOff = (time) => synth.noteOff(channel, selected.pitch, { time });
      retireSlot = (time, retiredEnd) => {
        // Tail retirement happens after the original timestamped note-off.
        // Do not shorten a slot already reserved by a later scheduled note.
        if (time >= at + duration && slot.through === end)
          slot.through = retiredEnd;
      };
      let connected = true;
      disconnectSource = () => {
        if (connected) {
          connected = false;
          synth.disconnectChannel(envelope, channel);
        }
      };
      slot.cleanups.push({
        end,
        run: () => {
          disconnectSource();
          envelope.disconnect();
          panner.disconnect();
        },
      });
    }
    let stopped = false;
    return {
      end,
      stop: (when = context.currentTime) => {
        if (stopped) return;
        stopped = true;
        envelope.gain.cancelScheduledValues(when);
        envelope.gain.setValueAtTime(0, when);
        // Keep the isolated slot quarantined through its scheduled end. A transport
        // stop destroys all worklets, including their future MIDI message queues.
        if (when <= context.currentTime) {
          disconnectSource();
          envelope.disconnect();
          panner.disconnect();
        }
      },
      fadeStop: (when, fade) => {
        envelope.gain.cancelAndHoldAtTime(when);
        envelope.gain.linearRampToValueAtTime(0, when + fade);
        noteOff(when);
        retireSlot(when, when + fade);
      },
    };
  }
}
