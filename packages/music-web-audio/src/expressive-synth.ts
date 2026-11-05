import {
  evaluateExpression,
  evaluateExpressionLane,
  type CompiledExpressiveNote,
  type ExpressiveControlEvent,
  type ExpressionParameter,
  type PerformanceTakeV3,
} from "@onepage/music-core/expressive-performance";
import type { Patch } from "@onepage/project";
import { controlOrder } from "./expressive-stream";

export interface ExpressiveVoiceHandle {
  readonly endContextTime: number;
  updateControls(
    take: PerformanceTakeV3,
    fromSeconds: number,
    parameters?: readonly ExpressionParameter[],
  ): void;
  stop(): void;
}
export interface ExpressiveVoiceRenderer {
  readonly id: string;
  readonly maxVoices: number;
  validateTake?(take: PerformanceTakeV3): void;
  /** Live backends may bound natural tails separately from held-note admission. */
  admissionReleaseSeconds?(take: PerformanceTakeV3, note: CompiledExpressiveNote): number;
  checkHealth?(context: BaseAudioContext): void;
  prepareContext?(
    context: BaseAudioContext,
    take: PerformanceTakeV3,
  ): Promise<void>;
  releaseContext?(context: BaseAudioContext): void;
  releaseSeconds(take: PerformanceTakeV3, note: CompiledExpressiveNote): number;
  renderVoice(
    context: BaseAudioContext,
    destination: AudioNode,
    take: PerformanceTakeV3,
    note: CompiledExpressiveNote,
    offsetSeconds: number,
  ): ExpressiveVoiceHandle;
}
export function expressiveSynthPatch(
  take: PerformanceTakeV3,
  note: CompiledExpressiveNote,
): Patch {
  const binding = take.bindings.find((b) => b.id === note.bindingId);
  const resource = take.resources.find((r) => r.id === binding?.resourceId);
  const patch = resource?.patch;
  if (binding?.kind !== "synth" || resource?.kind !== "synth" || !patch)
    throw Error(
      `Expressive synth unavailable for binding ${note.bindingId}; select its declared renderer`,
    );
  if (
    ![
      "sine",
      "triangle",
      "sawtooth",
      "pulse",
      "harmonic-bass",
      "noise",
    ].includes(patch.waveform) ||
    !Number.isFinite(patch.attack) ||
    patch.attack < 0 ||
    patch.attack > 5 ||
    !Number.isFinite(patch.release) ||
    patch.release < 0 ||
    patch.release > 10 ||
    !Number.isFinite(patch.brightness) ||
    patch.brightness < 0 ||
    patch.brightness > 1 ||
    !Number.isFinite(patch.duty) ||
    patch.duty < 0.05 ||
    patch.duty > 0.95 ||
    (patch.decaySeconds !== undefined &&
      (!Number.isFinite(patch.decaySeconds) ||
        patch.decaySeconds < 0.02 ||
        patch.decaySeconds > 10))
  )
    throw Error(`Invalid expressive synth patch ${patch.id}`);
  return patch;
}
/** Rebuilds cancellable synth automation at a known effective boundary, including interrupted ramps. */
function automate(
  param: AudioParam,
  events: ExpressiveControlEvent[],
  read: (seconds: number) => number,
  from: number,
  through: number,
  offset: number,
) {
  const at = from + offset;
  param.cancelScheduledValues(at);
  param.setValueAtTime(read(from), at);
  const points = new Set<number>([through]);
  for (const event of events) {
    if (event.timeSeconds > from && event.timeSeconds <= through)
      points.add(event.timeSeconds);
    const end = event.timeSeconds + event.rampSeconds;
    if (end > from && end <= through) points.add(end);
  }
  for (const t of [...points].sort((a, b) => a - b)) {
    // A step is discontinuous: finish the preceding ramp before setting its new value.
    const steps = events.filter(
      (e) => e.timeSeconds === t && e.rampSeconds === 0,
    );
    if (steps.length) {
      const before = read(Math.max(from, t - 1e-8));
      param.linearRampToValueAtTime(before, t + offset);
      param.setValueAtTime(read(t), t + offset);
    } else param.linearRampToValueAtTime(read(t), t + offset);
  }
}
export const expressiveSynthRenderer: ExpressiveVoiceRenderer = {
  id: "expressive-synth-v1",
  maxVoices: 256,
  releaseSeconds(take, note) {
    return note.termination === "kill"
      ? 0
      : Math.max(0.005, expressiveSynthPatch(take, note).release);
  },
  renderVoice(ctx, destination, take, note, offset) {
    const patch = expressiveSynthPatch(take, note);
    let source: OscillatorNode | AudioBufferSourceNode;
    if (patch.waveform === "noise") {
      const buffer = ctx.createBuffer(
        1,
        Math.ceil(ctx.sampleRate * 0.6),
        ctx.sampleRate,
      );
      let seed = 0x12345678;
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        samples[i] = (seed >>> 0) / 2147483648 - 1;
      }
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      noise.loop = true;
      source = noise;
    } else {
      const oscillator = ctx.createOscillator();
      oscillator.frequency.value = 440 * 2 ** ((note.pitch - 69) / 12);
      if (patch.waveform === "harmonic-bass" || patch.waveform === "pulse") {
        const real = new Float32Array(65),
          imag = new Float32Array(65);
        if (patch.waveform === "harmonic-bass") {
          imag[1] = 0.8;
          for (let n = 1; n * 2 < 65; n += 2)
            imag[n * 2] =
              (((0.2 * 8) / Math.PI ** 2) * (-1) ** ((n - 1) / 2)) / (n * n);
        } else
          for (let n = 1; n < 65; n++) {
            real[n] =
              (2 * Math.sin(2 * Math.PI * n * patch.duty)) / (Math.PI * n);
            imag[n] =
              (2 * (1 - Math.cos(2 * Math.PI * n * patch.duty))) /
              (Math.PI * n);
          }
        oscillator.setPeriodicWave(
          ctx.createPeriodicWave(real, imag, {
            disableNormalization: patch.waveform === "harmonic-bass",
          }),
        );
      } else oscillator.type = patch.waveform;
      source = oscillator;
    }
    return renderExpressiveSourceVoice(
      ctx,
      destination,
      take,
      note,
      offset,
      patch,
      source,
    );
  },
};

/** Shared owned-source graph for synthesized and preloaded sampled expressive voices. */
export function renderExpressiveSourceVoice(
  ctx: BaseAudioContext,
  destination: AudioNode,
  take: PerformanceTakeV3,
  note: CompiledExpressiveNote,
  offset: number,
  patch: Patch,
  source: OscillatorNode | AudioBufferSourceNode,
): ExpressiveVoiceHandle {
  const part = take.parts.find((p) => p.id === note.partId)!;
  const start = note.startSeconds + offset;
  const releaseStart = note.endSeconds + offset;
  const release =
    note.termination === "kill" ? 0 : Math.max(0.005, patch.release);
  const end = releaseStart + release;
  const envelope = ctx.createGain(),
    partVolume = ctx.createGain(),
    partExpression = ctx.createGain(),
    noteVolume = ctx.createGain(),
    noteExpression = ctx.createGain();
  const filter = ctx.createBiquadFilter(),
    panner = ctx.createStereoPanner();
  const nodes: AudioNode[] = [
    envelope,
    partVolume,
    partExpression,
    noteVolume,
    noteExpression,
    filter,
    panner,
  ];
  filter.type = "lowpass";
  source.connect(filter);
  filter.connect(envelope);
  envelope.connect(partVolume);
  partVolume.connect(partExpression);
  partExpression.connect(noteVolume);
  noteVolume.connect(noteExpression);
  noteExpression.connect(panner);
  panner.connect(destination);
  const level =
    note.velocity *
    part.gain *
    (patch.waveform === "harmonic-bass" ? 0.29 : 0.18);
  const attack = Math.min(
    Math.max(0.002, patch.attack),
    (releaseStart - start) / 2,
  );
  envelope.gain.setValueAtTime(0, start);
  envelope.gain.linearRampToValueAtTime(level, start + attack);
  if (patch.decaySeconds !== undefined && level > 0)
    envelope.gain.exponentialRampToValueAtTime(
      Math.max(
        1e-8,
        level *
          Math.exp(
            -Math.max(0, releaseStart - start - attack) / patch.decaySeconds,
          ),
      ),
      releaseStart,
    );
  else envelope.gain.setValueAtTime(level, releaseStart);
  if (note.termination === "kill") envelope.gain.setValueAtTime(0, end);
  else envelope.gain.linearRampToValueAtTime(0, end);
  const vibrato = ctx.createOscillator(),
    vibratoDepth = ctx.createGain();
  vibrato.frequency.value = 5;
  vibrato.connect(vibratoDepth);
  vibratoDepth.connect(source.detune);
  nodes.push(vibrato, vibratoDepth, source);
  let stopped = false;
  const cleanup = () => {
    for (const node of nodes) node.disconnect();
  };
  source.onended = cleanup;
  const voice: ExpressiveVoiceHandle = {
    endContextTime: end,
    updateControls(current, fromSeconds, parameters) {
      const from = Math.max(note.startSeconds, fromSeconds),
        through = note.endSeconds + release;
      if (from > through) return;
      const currentPart = current.parts.find((p) => p.id === note.partId)!;
      const events = current.controls
        .filter(
          (c) =>
            c.partId === part.id &&
            (c.noteId === undefined || c.noteId === note.id),
        )
        .sort(controlOrder);
      const partEvents = events.filter((c) => c.noteId === undefined),
        noteEvents = events.filter((c) => c.noteId === note.id);
      const lane =
        (
          scope: ExpressiveControlEvent[],
          parameter: ExpressionParameter,
          initial: number,
        ) =>
        (t: number) =>
          evaluateExpressionLane(scope, parameter, t, initial).value;
      for (const [param, scope, parameter, initial] of [
        [
          partVolume.gain,
          partEvents,
          "volume",
          currentPart.initialState?.volume ?? 1,
        ],
        [
          partExpression.gain,
          partEvents,
          "expression",
          currentPart.initialState?.expression ?? 1,
        ],
        [noteVolume.gain, noteEvents, "volume", 1],
        [noteExpression.gain, noteEvents, "expression", 1],
      ] as const)
        if (!parameters || parameters.includes(parameter))
          automate(
            param,
            scope.filter((c) => c.parameter === parameter),
            lane(scope, parameter, initial),
            from,
            through,
            offset,
          );
      const state = (t: number) =>
        evaluateExpression({ parts: current.parts, controls: events }, note, t);
      if (!parameters || parameters.includes("pitchCents"))
        automate(
          source.detune,
          events.filter((c) => c.parameter === "pitchCents"),
          (t) => state(t).pitchCents,
          from,
          through,
          offset,
        );
      if (!parameters || parameters.includes("pan"))
        automate(
          panner.pan,
          events.filter((c) => c.parameter === "pan"),
          (t) => state(t).pan,
          from,
          through,
          offset,
        );
      // Brightness is a qualified synth color control; the two semantic lanes multiply.
      const base = patch.waveform === "harmonic-bass" ? 700 : 18000;
      if (!parameters || parameters.includes("brightness"))
        automate(
          filter.frequency,
          events.filter((c) => c.parameter === "brightness"),
          (t) =>
            Math.min(
              ctx.sampleRate / 2,
              200 + base * patch.brightness * state(t).brightness,
            ),
          from,
          through,
          offset,
        );
      if (!parameters || parameters.includes("modulation"))
        automate(
          vibratoDepth.gain,
          events.filter((c) => c.parameter === "modulation"),
          (t) => 20 * state(t).modulation,
          from,
          through,
          offset,
        );
    },
    stop() {
      if (stopped) return;
      stopped = true;
      envelope.gain.cancelScheduledValues(ctx.currentTime);
      envelope.gain.setValueAtTime(0, ctx.currentTime);
      try {
        source.stop();
        vibrato.stop();
      } catch {}
      cleanup();
    },
  };
  voice.updateControls(take, note.startSeconds);
  source.start(start);
  source.stop(end);
  vibrato.start(start);
  vibrato.stop(end);
  return voice;
}
export const EXPRESSIVE_SYNTH_CAPABILITIES = Object.freeze({
  id: "expressive-synth-v1",
  pitchCents: "audio-rate ramps",
  volume: "linear semantic gain",
  expression: "independent linear semantic gain",
  pan: "note override or part stereo pan applied once",
  brightness: "qualified lowpass approximation",
  modulation: "5 Hz vibrato, maximum 20 cents",
  sustain: "resolved note endSeconds",
  offline: true,
});
