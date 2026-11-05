import {
  assertPerformanceTakeV3,
  evaluateExpression,
  type CompiledExpressiveNote,
  type ExpressiveResource,
  type PerformanceTakeV3,
} from "@onepage/music-core/expressive-performance";
import {
  expressiveSynthRenderer,
  renderExpressiveSourceVoice,
  type ExpressiveVoiceRenderer,
} from "./expressive-synth";
import type { Patch } from "@onepage/project";
const SAMPLE_PATCH: Patch = {
  id: "expressive-native-v1",
  name: "Native sample envelope v1",
  waveform: "sine",
  attack: 0.005,
  release: 0.08,
  brightness: 1,
  duty: 0.5,
};
export const EXPRESSIVE_NATIVE_CAPABILITIES = Object.freeze({
  id: "expressive-native-v1",
  pitchCents: "sample detune; conservative exhaustion admission",
  volume: "independent semantic linear gain",
  expression: "independent semantic linear gain",
  pan: "one stereo panner",
  brightness: "unavailable",
  modulation: "unavailable",
  sustain: "declared source loop only; no inferred acoustic technique",
  live: true,
  offline: true,
});
/** Hash-verified resources load completely before a renderer can enter an audio deadline. */
export async function createExpressiveNativeRenderer(
  take: PerformanceTakeV3,
  options: {
    maxDecodedBytes?: number;
    maxResourceBytes?: number;
    maxVoices?: number;
    decodeSampleRate?: number;
  } = {},
): Promise<ExpressiveVoiceRenderer> {
  assertPerformanceTakeV3(take);
  const maxDecoded = options.maxDecodedBytes ?? 64 * 1024 * 1024,
    maxResource = options.maxResourceBytes ?? 16 * 1024 * 1024,
    maxVoices = options.maxVoices ?? 64;
  if (
    !Number.isSafeInteger(maxDecoded) ||
    maxDecoded < 1 ||
    maxDecoded > 256 * 1024 * 1024 ||
    !Number.isSafeInteger(maxResource) ||
    maxResource < 1 ||
    maxResource > 64 * 1024 * 1024 ||
    !Number.isSafeInteger(maxVoices) ||
    maxVoices < 1 ||
    maxVoices > 256
  )
    throw Error("Invalid native expressive resource budget");
  const decoder = new OfflineAudioContext(
      1,
      1,
      options.decodeSampleRate ?? 48000,
    ),
    buffers = new Map<string, AudioBuffer>(),
    identities = new Map<string, string>();
  let decodedBytes = 0;
  const resourceSignature = (r: ExpressiveResource) =>
    JSON.stringify({
      id: r.id,
      kind: r.kind,
      sha256: r.sha256,
      sample: r.sample,
    });
  const samples = take.resources.filter((r) => r.kind === "sample");
  for (const resource of samples) {
    if (!resource.uri || !resource.sha256 || !resource.sample)
      throw Error(
        `Sample ${resource.id} needs URI, SHA-256 and root/loop metadata`,
      );
    const response = await fetch(resource.uri, {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw Error(`Sample unavailable ${resource.id}`);
    const declared = Number(response.headers.get("content-length"));
    if (declared > maxResource) throw Error("Sample compressed byte budget");
    const reader = response.body?.getReader();
    if (!reader) throw Error("Sample streaming response unavailable");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxResource) {
        await reader.cancel();
        throw Error("Sample compressed byte budget");
      }
      chunks.push(next.value);
    }
    const data = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      data.set(chunk, at);
      at += chunk.byteLength;
    }
    const digest = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
    ]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
    if (digest !== resource.sha256.toLowerCase())
      throw Error(`Sample hash mismatch ${resource.id}`);
    const buffer = await decoder.decodeAudioData(data.buffer);
    decodedBytes += buffer.length * buffer.numberOfChannels * 4;
    if (decodedBytes > maxDecoded)
      throw Error("Native expressive decoded byte budget");
    const loop = resource.sample.loop;
    if (
      loop &&
      (loop.startSeconds < 0 ||
        loop.endSeconds > buffer.duration ||
        loop.endSeconds <= loop.startSeconds)
    )
      throw Error(`Invalid source loop ${resource.id}`);
    buffers.set(resource.id, buffer);
    identities.set(resource.id, resourceSignature(resource));
  }
  function sampleFor(current: PerformanceTakeV3, note: CompiledExpressiveNote) {
    const binding = current.bindings.find((b) => b.id === note.bindingId),
      resource = current.resources.find((r) => r.id === binding?.resourceId),
      buffer = resource && buffers.get(resource.id);
    if (
      binding?.kind !== "sample" ||
      !resource?.sample ||
      !buffer ||
      identities.get(resource.id) !== resourceSignature(resource)
    )
      throw Error(`Unprepared sampled binding ${note.bindingId}`);
    return { resource, buffer };
  }
  function validateExpression(
    current: PerformanceTakeV3,
    note: CompiledExpressiveNote,
  ) {
    const events = current.controls.filter(
      (c) =>
        c.partId === note.partId &&
        (c.noteId === undefined || c.noteId === note.id),
    );
    if (
      events.some(
        (c) =>
          (c.parameter === "brightness" && c.value !== 1) ||
          (c.parameter === "modulation" && c.value !== 0),
      )
    )
      throw Error(
        "Native expressive brightness/modulation is unavailable; select an explicit supported profile",
      );
    const initial = current.parts.find(
      (p) => p.id === note.partId,
    )?.initialState;
    if (
      (initial?.brightness !== undefined && initial.brightness !== 1) ||
      (initial?.modulation !== undefined && initial.modulation !== 0)
    )
      throw Error("Unsupported native initial expression");
    const { resource, buffer } = sampleFor(current, note);
    if (!resource.sample!.loop) {
      const points = [
        note.startSeconds,
        note.endSeconds + 0.08,
        ...events.flatMap((c) => [
          c.timeSeconds,
          c.timeSeconds + c.rampSeconds,
        ]),
      ].filter((t) => t >= note.startSeconds && t <= note.endSeconds + 0.08);
      const maximumCents = Math.max(
        ...points.map((t) => evaluateExpression(current, note, t).pitchCents),
      );
      const fastest =
        2 **
        ((note.pitch - resource.sample!.rootPitch) / 12 + maximumCents / 1200);
      if (
        (note.endSeconds -
          note.startSeconds +
          (note.termination === "kill" ? 0 : 0.08)) *
          fastest >
        buffer.duration
      )
        throw Error(
          `Sample exhaustion at bent pitch for ${note.id}; shorten note or provide a qualified source loop`,
        );
    }
  }
  const renderer: ExpressiveVoiceRenderer = {
    id: EXPRESSIVE_NATIVE_CAPABILITIES.id,
    maxVoices,
    validateTake(current) {
      for (const note of current.notes)
        if (
          current.bindings.find((b) => b.id === note.bindingId)?.kind ===
          "sample"
        )
          validateExpression(current, note);
    },
    async prepareContext(_context, current) {
      assertPerformanceTakeV3(current);
      this.validateTake!(current);
    },
    releaseSeconds(current, note) {
      if (
        current.bindings.find((b) => b.id === note.bindingId)?.kind === "synth"
      )
        return expressiveSynthRenderer.releaseSeconds(current, note);
      sampleFor(current, note);
      return note.termination === "kill" ? 0 : 0.08;
    },
    renderVoice(context, destination, current, note, offset) {
      if (
        current.bindings.find((b) => b.id === note.bindingId)?.kind === "synth"
      )
        return expressiveSynthRenderer.renderVoice(
          context,
          destination,
          current,
          note,
          offset,
        );
      validateExpression(current, note);
      const { resource, buffer } = sampleFor(current, note),
        source = context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value =
        2 ** ((note.pitch - resource.sample!.rootPitch) / 12);
      const loop = resource.sample!.loop;
      if (loop) {
        source.loop = true;
        source.loopStart = loop.startSeconds;
        source.loopEnd = loop.endSeconds;
      }
      const voice = renderExpressiveSourceVoice(
        context,
        destination,
        current,
        note,
        offset,
        SAMPLE_PATCH,
        source,
      );
      return {
        ...voice,
        updateControls(next, from, parameters) {
          validateExpression(next, note);
          voice.updateControls(next, from, parameters);
        },
      };
    },
  };
  // Fail preparation of frozen notes before a live renderer is handed to the caller.
  await renderer.prepareContext!(decoder, take);
  return renderer;
}
