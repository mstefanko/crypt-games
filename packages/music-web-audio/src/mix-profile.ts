/** Explicit opt-in: historical takes retain their original unprotected renderer. */
export type MixProfile = "legacy-v1" | "weather-protected-1";
export const PROTECTED_MIX_LATENCY_FRAMES = 256;
export const PROTECTED_MIX_CEILING = 0.7;
/** Linked-channel lookahead sample limiter. Ceiling reserves 2.1 dB for
 * reconstruction overshoot, with a 4x sinc input detector. Captured true peak
 * must still be measured because time-varying gain changes the waveform. */
export { LinkedPeakProtector } from "./mix-protector-worklet.js";

export interface ProtectionStats {
  frames: number;
  reducedFrames: number;
  dutyCycle: number;
  failed: boolean;
}
const stats = new WeakMap<AudioWorkletNode, ProtectionStats>();
export function readProtectionStats(
  node: AudioWorkletNode | null,
): ProtectionStats | null {
  const value = node ? stats.get(node) : null;
  return value ? { ...value } : null;
}
const registered = new WeakMap<BaseAudioContext, Promise<void>>();
export async function createProtectedMix(context: BaseAudioContext) {
  if (!context.audioWorklet) throw Error("Protected mix requires AudioWorklet");
  let prepared = registered.get(context);
  if (!prepared) {
    prepared = context.audioWorklet.addModule(
      new URL("./mix-protector-worklet.js?no-inline", import.meta.url).href,
    );
    registered.set(context, prepared);
  }
  await prepared;
  const node = new AudioWorkletNode(context, "linked-peak-protector-1", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit",
  });
  // Processor failure must fail closed, not silently bypass output protection.
  stats.set(node, { frames: 0, reducedFrames: 0, dutyCycle: 0, failed: false });
  node.port.onmessage = ({ data }) =>
    stats.set(node, {
      frames: data.frames,
      reducedFrames: data.reducedFrames,
      dutyCycle: data.frames ? data.reducedFrames / data.frames : 0,
      failed: stats.get(node)?.failed ?? false,
    });
  node.onprocessorerror = () => {
    stats.set(node, { ...stats.get(node)!, failed: true });
    node.disconnect();
  };
  return node;
}

/** Four-phase, 32-tap windowed-sinc reconstruction, excluding zero-padded edges.
 * This is a defined QA estimate, not an assertion of all-device analogue peaks. */
export function measureReconstructedPeak(channels: readonly Float32Array[]) {
  let peak = 0;
  for (const samples of channels) {
    for (let i = 0; i < samples.length; i++)
      peak = Math.max(peak, Math.abs(samples[i]));
    for (let i = 16; i < samples.length - 16; i++) {
      for (let phase = 1; phase < 4; phase++) {
        let sum = 0,
          norm = 0;
        for (let tap = -15; tap <= 16; tap++) {
          const x = tap - phase / 4;
          const weight =
            (Math.sin(Math.PI * x) / (Math.PI * x)) *
            (0.5 + 0.5 * Math.cos((Math.PI * x) / 16));
          sum += samples[i + tap] * weight;
          norm += weight;
        }
        peak = Math.max(peak, Math.abs(sum / norm));
      }
    }
  }
  return {
    peak,
    dbtp: 20 * Math.log10(peak),
    method: "4x-32tap-hann-sinc" as const,
  };
}
