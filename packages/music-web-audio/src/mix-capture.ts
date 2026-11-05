import type { StreamingAudioEngine } from "./stream-engine";
const preparedContexts = new WeakSet<BaseAudioContext>();
const activeCaptures = new WeakSet<StreamingAudioEngine>();
export interface MixedCaptureOptions {
  signal?: AbortSignal;
  requireTransport?: boolean;
  onProgress?: (seconds: number) => void;
}
export async function captureMixedOutput(
  engine: StreamingAudioEngine,
  seconds: number,
  options: MixedCaptureOptions = {},
) {
  if (activeCaptures.has(engine))
    throw Error("A mixed capture is already active");
  activeCaptures.add(engine);
  try {
    return await captureMixedOutputInner(engine, seconds, options);
  } finally {
    activeCaptures.delete(engine);
  }
}
/** Captures six stereo stems in one processor callback. Master includes the
 * declared protector delay; other stems are pre-delay. No post-hoc alignment guess. */
async function captureMixedOutputInner(
  engine: StreamingAudioEngine,
  seconds: number,
  options: MixedCaptureOptions,
) {
  const context = engine.readAudioContext();
  if (
    !context ||
    context.state !== "running" ||
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds > 60
  )
    throw Error("Mixed capture requires a running device and 0–60 seconds");
  if (
    options.signal?.aborted ||
    (options.requireTransport && !engine.isPlaying)
  )
    throw Error("Mixed capture cancelled or transport stopped");
  const initialEpoch = engine.readTransport().epoch;
  const frames = Math.ceil(seconds * context.sampleRate);
  if (frames * 12 * 4 > 160 * 1024 * 1024)
    throw Error("Mixed capture exceeds 160 MiB PCM budget");

  if (!preparedContexts.has(context)) {
    await context.audioWorklet.addModule(
      new URL("./mix-capture-worklet.js?no-inline", import.meta.url).href,
    );
    preparedContexts.add(context);
  }
  if (options.signal?.aborted || context.state !== "running")
    throw Error("Mixed capture cancelled or device suspended");
  const node = new AudioWorkletNode(context, "mixed-capture-1", {
    numberOfInputs: 6,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 2,
    channelCountMode: "explicit",
    processorOptions: { frames },
  });
  const upper = context.createGain(),
    silence = context.createGain();
  silence.gain.value = 0;
  node.connect(silence);
  silence.connect(context.destination);
  const taps = engine.prepareMixCaptureTaps();
  const roles = engine.readRoleCaptureTaps();
  const sources: (AudioNode | null | undefined)[] = [
    taps.master,
    taps.preProtection,
    taps.environment,
    roles.get("bass"),
    roles.get("drums") ?? roles.get("percussion"),
    upper,
  ];
  for (const [role, tap] of roles)
    if (role !== "bass" && role !== "percussion" && role !== "drums")
      tap.connect(upper);
  sources.forEach((tap, i) => tap?.connect(node, 0, i));
  const data = Array.from({ length: 12 }, () => new Float32Array(frames));
  return new Promise<{
    sampleRate: number;
    startContextTime: number;
    profile: string;
    latencySeconds: number;
    names: readonly string[];
    channels: Float32Array[];
  }>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      settled = true;
      clearTimeout(timeout);
      clearInterval(monitor);
      options.signal?.removeEventListener("abort", abort);
      node.port.postMessage("cancel");
      node.port.onmessage = null;
      node.port.close();
      sources.forEach((tap, i) => {
        try {
          tap?.disconnect(node, 0, i);
        } catch {
          /* owner disposed */
        }
      });
      for (const [role, tap] of roles)
        if (role !== "bass" && role !== "percussion" && role !== "drums")
          try {
            tap.disconnect(upper);
          } catch {
            /* owner disposed */
          }
      node.disconnect();
      upper.disconnect();
      silence.disconnect();
    };
    const abort = () => {
      if (!settled) {
        cleanup();
        reject(
          Error("Mixed capture cancelled before the full interval elapsed"),
        );
      }
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const monitor = setInterval(() => {
      if (
        context.state !== "running" ||
        (options.requireTransport &&
          (!engine.isPlaying || engine.readTransport().epoch !== initialEpoch))
      ) {
        if (!settled) {
          cleanup();
          reject(
            Error("Mixed capture interrupted by transport or device change"),
          );
        }
      }
    }, 50);
    const timeout = setTimeout(
      () => {
        cleanup();
        reject(Error("Mixed capture interrupted or device suspended"));
      },
      seconds * 1000 + 5000,
    );
    node.onprocessorerror = () => {
      cleanup();
      reject(Error("Mixed capture processor failed"));
    };
    node.port.onmessage = ({ data: chunk }) => {
      if (settled) return;
      options.onProgress?.(
        Math.min(
          seconds,
          (chunk.offset + chunk.data[0].length) / context.sampleRate,
        ),
      );
      chunk.data.forEach((channel: Float32Array, i: number) =>
        data[i].set(channel, chunk.offset),
      );
      if (chunk.done) {
        cleanup();
        resolve({
          sampleRate: context.sampleRate,
          startContextTime: chunk.startFrame / context.sampleRate,
          profile: taps.profile,
          latencySeconds: taps.latencySeconds,
          names: [
            "master",
            "pre-protection",
            "environment",
            "bass",
            "percussion",
            "upper-music",
          ],
          channels: data,
        });
      }
    };
  });
}
