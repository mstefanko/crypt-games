import { renderPerformanceVoice, type PerformanceVoiceRenderer, type Voice } from "./index";
import type { Patch } from "@onepage/project";
import type { InstrumentPalette } from "@onepage/music-core/instrument-palette";
import {
  prepareInstrumentBindings,
  snapshotInstrumentPalette,
  type InstrumentRendererCapabilities,
} from "./instrument-renderer";

export interface InstrumentSample {
  readonly instrument: string;
  readonly root: number;
  readonly velocity: number;
  readonly alternate: number;
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly rms?: number;
}
export interface NativeInstrumentConfig {
  readonly palette: InstrumentPalette;
  readonly id?: string;
  readonly sampleSets: readonly {
    readonly baseUrl: string;
    readonly samples: readonly InstrumentSample[];
  }[];
  readonly capabilities: InstrumentRendererCapabilities;
  readonly unpitchedInstruments?: readonly string[];
  readonly sustainedInstruments?: readonly string[];
  readonly decodeSampleRate?: number;
  readonly fallbackReleaseSeconds?: number;
  readonly legacyInstrument?: (
    patch: Patch,
    pitch: number,
  ) => string | undefined;
}
export function resolveNativeInstrument(
  palette: InstrumentPalette,
  patch: Patch,
  pitch: number,
  legacy?: NativeInstrumentConfig["legacyInstrument"],
): string {
  const binding = palette.bindings.find((b) => b.patchId === patch.id);
  const instrument = binding?.nativeInstrument ?? legacy?.(patch, pitch);
  if (!instrument) throw Error(`Unbound acoustic patch ${patch.id}`);
  return instrument;
}

/** Recorded velocity layers first, nearest recorded pitch second; alternates are explicit. */
export function selectInstrumentSample<T extends InstrumentSample>(
  catalog: readonly T[],
  instrument: string,
  pitch: number,
  velocity: number,
  alternate = 0,
): T {
  const samples = catalog.filter((s) => s.instrument === instrument);
  if (!samples.length) throw Error(`Unknown sampled instrument ${instrument}`);
  const layers = [...new Set(samples.map((s) => s.velocity))].sort(
    (a, b) => a - b,
  );
  const layer = layers[velocity < 0.6 ? 0 : layers.length - 1];
  const candidates = samples
    .filter((s) => s.velocity === layer)
    .sort(
      (a, b) =>
        Math.abs(a.root - pitch) - Math.abs(b.root - pitch) ||
        a.root - b.root ||
        a.alternate - b.alternate,
    );
  const nearest = candidates.filter((s) => s.root === candidates[0].root);
  return nearest[
    ((alternate % nearest.length) + nearest.length) % nearest.length
  ];
}

export function instrumentAlternate(noteId = ""): number {
  let hash = 2166136261;
  for (let i = 0; i < noteId.length; i++)
    hash = Math.imul(hash ^ noteId.charCodeAt(i), 16777619);
  return noteId ? hash >>> 0 : 0;
}

function withStartupDeadline<T>(
  operation: Promise<T>,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error(`Sample ${label} timed out after 10 seconds`)),
      10_000,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// Weak entries do not keep abandoned renderers alive. Calibration identity is part
// of the key so an old take never receives a differently normalized recording.
const decodedCache = new Map<
  string,
  { buffer: WeakRef<AudioBuffer>; profiles: Set<string> }
>();
const decoding = new Map<string, Promise<AudioBuffer>>();
function sharedDecodedBytes(profile?: string) {
  let bytes = 0;
  for (const [key, entry] of decodedCache) {
    const buffer = entry.buffer.deref();
    if (!buffer) {
      decodedCache.delete(key);
      continue;
    }
    if (profile === undefined || entry.profiles.has(profile))
      bytes += buffer.length * buffer.numberOfChannels * 4;
  }
  return bytes;
}

/** Preload atomically, verify shipped bytes, and retain a bounded shared AudioBuffer set. */
export async function createNativeInstrumentRenderer(
  config: NativeInstrumentConfig,
): Promise<PerformanceVoiceRenderer> {
  config = {
    ...config,
    capabilities: {
      ...config.capabilities,
      instruments: [...config.capabilities.instruments],
    },
  };
  const palette = snapshotInstrumentPalette(config.palette);
  const sets = config.sampleSets.map((set) => ({
    baseUrl: set.baseUrl,
    samples: set.samples.map((sample) => Object.freeze({ ...sample })),
  }));
  const allSamples = sets.flatMap((set) => set.samples);
  const unpitched = new Set(config.unpitchedInstruments ?? []);
  const sustained = new Set(config.sustainedInstruments ?? []);
  const fallbackRelease = config.fallbackReleaseSeconds ?? 0.3;
  prepareInstrumentBindings(palette, config.capabilities);
  for (const binding of palette.bindings)
    if (
      binding.rendering !== "synth" && !allSamples.some(
        (sample) => sample.instrument === binding.nativeInstrument,
      )
    )
      throw Error(`Missing recorded instrument: ${binding.nativeInstrument}`);
  for (const sample of allSamples)
    if (
      !Number.isInteger(sample.root) ||
      sample.root < 0 ||
      sample.root > 127 ||
      !Number.isFinite(sample.velocity) ||
      !Number.isInteger(sample.alternate) ||
      sample.alternate < 1 ||
      !Number.isSafeInteger(sample.bytes) ||
      sample.bytes < 1 ||
      !/^[a-f0-9]{64}$/.test(sample.sha256) ||
      (sample.rms !== undefined &&
        (!Number.isFinite(sample.rms) || sample.rms <= 0))
    )
      throw Error("Invalid sample resource");
  const buffers = new Map<InstrumentSample, AudioBuffer>();
  // Decode at source rate: decoding into a 48k live context doubles resident PCM.
  const decoder = new OfflineAudioContext(
    1,
    1,
    config.decodeSampleRate ?? 22050,
  );
  let bytes = 0,
    maxCompressedBytes = 0,
    maxDecodedSampleBytes = 0;
  const decodedRates = new Set<number>();
  // Sequential decoding bounds transient compressed/decoded memory during startup.
  for (const sample of allSamples) {
    const key = `${sample.sha256}:${config.decodeSampleRate ?? 22050}:calibration-v1:${sample.rms ?? "peak-only"}`;
    const cached = decodedCache.get(key);
    let buffer = cached?.buffer.deref();
    if (!buffer) {
      let pending = decoding.get(key);
      if (!pending) {
        pending = (async () => {
          const response = await fetch(
            sets.find((set) => set.samples.includes(sample))!.baseUrl +
              sample.file,
            { signal: AbortSignal.timeout(10_000) },
          );
          if (!response.ok)
            throw Error(`Sample asset unavailable: ${sample.file}`);
          const data = await response.arrayBuffer();
          maxCompressedBytes = Math.max(maxCompressedBytes, data.byteLength);
          if (data.byteLength !== sample.bytes)
            throw Error(`Sample asset size mismatch: ${sample.file}`);
          const digest = [
            ...new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
          ]
            .map((v) => v.toString(16).padStart(2, "0"))
            .join("");
          if (digest !== sample.sha256)
            throw Error(`Sample asset hash mismatch: ${sample.file}`);
          const buffer = await withStartupDeadline(
            decoder.decodeAudioData(data),
            `decode ${sample.file}`,
          );
          // The source recordings have wildly different capture levels (some peaks
          // are below -60 dBFS). Calibrate each recording before musical velocity and
          // track gain; keep the recorded soft/hard timbres, not microphone gain.
          let peak = 0;
          for (let channel = 0; channel < buffer.numberOfChannels; channel++)
            for (const value of buffer.getChannelData(channel))
              peak = Math.max(peak, Math.abs(value));
          if (peak === 0) throw Error(`Silent Sample asset: ${sample.file}`);
          for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
            const values = buffer.getChannelData(channel);
            for (let i = 0; i < values.length; i++)
              values[i] *=
                typeof sample.rms === "number"
                  ? Math.min(0.8 / peak, 0.12 / sample.rms)
                  : 0.8 / peak;
          }
          return buffer;
        })().finally(() => decoding.delete(key));
        decoding.set(key, pending);
      }
      buffer = await pending;
      const existing = decodedCache.get(key);
      if (existing?.buffer.deref() === buffer)
        existing.profiles.add(palette.profile.id);
      else
        decodedCache.set(key, {
          buffer: new WeakRef(buffer),
          profiles: new Set([palette.profile.id]),
        });
    } else cached!.profiles.add(palette.profile.id);
    if (
      sharedDecodedBytes(palette.profile.id) > palette.profile.maxDecodedBytes
    )
      throw Error("Shared sample decoded memory budget exceeded");
    const sampleBytes = buffer.length * buffer.numberOfChannels * 4;
    bytes += sampleBytes;
    maxDecodedSampleBytes = Math.max(maxDecodedSampleBytes, sampleBytes);
    decodedRates.add(buffer.sampleRate ?? config.decodeSampleRate ?? 22050);
    if (bytes > palette.profile.maxDecodedBytes)
      throw Error("Sample decoded memory budget exceeded");
    buffers.set(sample, buffer);
  }
  return {
    memoryDiagnostics: () =>
      Object.freeze({
        kind: "native-decoded-buffer-inventory",
        retainedDecodedPcmBytes: bytes,
        decodedSampleCount: buffers.size,
        sharedUniqueDecodedPcmBytes: sharedDecodedBytes(),
        sharedProfileDecodedPcmBytes: sharedDecodedBytes(palette.profile.id),
        sharedDecodedBudgetProfile: palette.profile.id,
        requestedDecodeSampleRate: config.decodeSampleRate ?? 22050,
        actualDecodeSampleRates: Object.freeze(
          [...decodedRates].sort((a, b) => a - b),
        ),
        maxFetchedCompressedBufferBytes: maxCompressedBytes,
        maxDecodedSampleBytes,
        decodedProfileLimitBytes: palette.profile.maxDecodedBytes,
        scope:
          "Actual retained AudioBuffer PCM payload; sequential compressed-input maximum. Shared counts deduplicate live weak-cache AudioBuffers, and may conservatively include buffers awaiting GC. Excludes decoder scratch, fetch internals, JS objects, effects, device buffers and process memory; not a total peak estimate.",
      }),
    paletteIdentity: Object.freeze({ id: palette.id, hash: palette.hash }),
    maxVoices: config.capabilities.maxVoices,
    id: config.id ?? palette.id,
    releaseSeconds: (patch) => patch.waveform === "harmonic-bass" ? Math.max(0.005, patch.release) :
      palette.bindings.find((b) => b.patchId === patch.id)?.releaseSeconds ??
      fallbackRelease,
    renderVoice(
      ctx,
      output,
      patch,
      pitch,
      velocity,
      at,
      duration,
      gain = 1,
      pan = 0,
      noteId?: string,
    ): Voice {
      if (patch.waveform === "harmonic-bass")
        return renderPerformanceVoice(ctx, output, patch, pitch, velocity, at, duration, gain, pan, noteId);
      const instrument = resolveNativeInstrument(
        palette,
        patch,
        pitch,
        config.legacyInstrument,
      );
      // Captured IDs preserve alternate selection across contexts and take excerpts.
      const alternate = instrumentAlternate(noteId);
      const sample = selectInstrumentSample(
        allSamples,
        instrument,
        pitch,
        velocity,
        alternate,
      );
      const buffer = buffers.get(sample)!;
      const source = ctx.createBufferSource(),
        envelope = ctx.createGain(),
        panner = ctx.createStereoPanner();
      source.buffer = buffer;
      const rate = !unpitched.has(instrument)
        ? 2 ** ((pitch - sample.root) / 12)
        : 1;
      source.playbackRate.value = rate;
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      const level =
        Math.max(0, Math.min(1, velocity)) *
        Math.max(0, Math.min(2, gain)) *
        0.55 *
        (palette.bindings.find((b) => b.patchId === patch.id)?.calibratedGain ??
          1);
      const binding = palette.bindings.find((b) => b.patchId === patch.id);
      const release = binding?.releaseSeconds ?? fallbackRelease;
      if (
        binding?.minSustainSeconds !== undefined &&
        duration + 0.001 < binding.minSustainSeconds
      )
        throw Error(
          `Duration truncates natural tail for ${binding.instrumentId}`,
        );
      if (binding && duration > binding.maxSustainSeconds + 0.001)
        throw Error(`Sustain exceeds ${instrument} policy`);
      if (
        sustained.has(instrument) &&
        duration + release > buffer.duration / rate
      )
        throw Error(`Insufficient recorded sustain for ${instrument}`);
      const end = Math.min(
        at + duration + release,
        at + buffer.duration / rate,
      );
      const releaseAt = Math.min(at + duration, Math.max(at, end - 0.03));
      envelope.gain.setValueAtTime(0, at);
      envelope.gain.linearRampToValueAtTime(
        level,
        Math.min(at + (binding?.attackSeconds ?? 0.003), releaseAt),
      );
      envelope.gain.setValueAtTime(level, releaseAt);
      envelope.gain.linearRampToValueAtTime(0, end);
      source.connect(envelope).connect(panner).connect(output);
      source.onended = () => {
        source.disconnect();
        envelope.disconnect();
        panner.disconnect();
      };
      source.start(at);
      source.stop(end);
      const stop = (time = ctx.currentTime) => {
        try {
          source.stop(Math.max(ctx.currentTime, time));
        } catch {
          /* ended */
        }
      };
      return {
        end,
        stop,
        fadeStop(time, fade) {
          const start = Math.max(ctx.currentTime, time);
          envelope.gain.cancelAndHoldAtTime(start);
          envelope.gain.linearRampToValueAtTime(
            0,
            start + Math.max(0.005, fade),
          );
          stop(start + Math.max(0.005, fade));
        },
      };
    },
  };
}
