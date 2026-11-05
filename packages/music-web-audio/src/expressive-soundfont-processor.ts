import {
  SoundBankLoader,
  SpessaSynthProcessor,
  GeneratorTypes,
} from "spessasynth_core";
import {
  createExpressionEvaluator,
  type CompiledExpressiveNote,
  type PerformanceTakeV3,
} from "@onepage/music-core/expressive-performance";
import { releasePinnedExclusiveVoices } from "./expressive-soundfont";

export const GM_LIVE_SLOTS = 256;
export const GM_LIVE_TAIL_SECONDS = 64;
export interface GmLiveVoice {
  slot: number;
  note: CompiledExpressiveNote;
  take: PerformanceTakeV3;
  offset: number;
  output: number;
}
type Entry = GmLiveVoice & {
  edges: number[];
  edgeIndex: number;
  from: ReturnType<ReturnType<typeof createExpressionEvaluator>>;
  to: ReturnType<ReturnType<typeof createExpressionEvaluator>>;
  evaluate: ReturnType<typeof createExpressionEvaluator>;
  started: boolean;
  released: boolean;
  classes: number[];
};
/** One parsed bank and one processor. Isolated channels preserve note-local bends;
 * processSplit retains bank stereo before canonical gain/pan. No MIDI sequencer.
 */
export class ExpressiveSoundfontProcessor {
  private readonly core: SpessaSynthProcessor;
  private readonly bank: ReturnType<typeof SoundBankLoader.fromArrayBuffer>;
  private entries = new Map<number, Entry>();
  private ordered: Entry[] = [];
  private readonly scratch = Array.from({ length: GM_LIVE_SLOTS }, () => [
    new Float32Array(128),
    new Float32Array(128),
  ]);
  private readonly effects = [new Float32Array(128), new Float32Array(128)];
  private closed = false;
  private constructor(
    readonly rate: number,
    bytes: ArrayBuffer,
    private readonly done: (slot: number, id: string, end: number) => void,
  ) {
    this.bank = SoundBankLoader.fromArrayBuffer(bytes);
    this.core = new SpessaSynthProcessor(rate, {
      effectsEnabled: false,
      maxBufferSize: 128,
    });
  }
  static async create(
    rate: number,
    bytes: ArrayBuffer,
    done: (slot: number, id: string, end: number) => void,
  ) {
    const result = new ExpressiveSoundfontProcessor(rate, bytes, done);
    await result.core.processorInitialized;
    result.core.soundBankManager.addSoundBank(result.bank, "expressive-live");
    result.core.setSystemParameter("gain", 1);
    result.core.setSystemParameter("voiceCap", 1024);
    result.core.setSystemParameter("autoAllocateVoices", false);
    while (result.core.midiChannels.length < GM_LIVE_SLOTS)
      result.core.createMIDIChannel();
    return result;
  }
  add(message: GmLiveVoice) {
    if (
      this.closed ||
      this.entries.has(message.slot) ||
      this.entries.size >= GM_LIVE_SLOTS
    )
      throw Error("GM live slot capacity exceeded");
    const evaluate = createExpressionEvaluator(message.take, message.note);
    const entry: Entry = {
      ...message,
      evaluate,
      edges: this.edges(message),
      edgeIndex: 0,
      from: evaluate(0),
      to: evaluate(0),
      started: false,
      released: false,
      classes: [],
    };
    this.entries.set(message.slot, entry);
    this.ordered.push(entry);
    this.ordered.sort(
      (a, b) =>
        Math.round(a.note.startSeconds * this.rate) -
          Math.round(b.note.startSeconds * this.rate) ||
        (a.note.sourceOrder ?? 0) - (b.note.sourceOrder ?? 0) ||
        a.note.id.localeCompare(b.note.id),
    );
  }
  update(slot: number, id: string, take: PerformanceTakeV3) {
    const entry = this.entries.get(slot);
    if (entry?.note.id === id) {
      entry.take = take;
      entry.evaluate = createExpressionEvaluator(take, entry.note);
      entry.edges = this.edges(entry);
      entry.edgeIndex = 0;
    }
  }
  stop(slot: number, id: string, now: number) {
    const entry = this.entries.get(slot);
    if (entry?.note.id !== id) return;
    this.core.controllerChange(slot, 120, 0);
    this.entries.delete(slot);
    this.ordered = this.ordered.filter((e) => e !== entry);
    this.done(slot, id, now);
  }
  process(outputs: Float32Array[][], now: number) {
    if (this.closed) return;
    // Split at onsets/releases/control edges; 32-frame ramps match the offline GM profile.
    const frames = outputs[0][0].length;
    for (let cursor = 0; cursor < frames; ) {
      const at = now + cursor / this.rate;
      let size = Math.min(32, frames - cursor);
      const entries = this.ordered;
      let reservedSampleVoices = this.core.voiceCount;
      for (const entry of entries) {
        const { note, offset, slot, take } = entry;
        const start = note.startSeconds + offset,
          end = note.endSeconds + offset;
        while (
          entry.edgeIndex < entry.edges.length &&
          Math.round((entry.edges[entry.edgeIndex] - at) * this.rate) <= 0
        )
          entry.edgeIndex++;
        const edge = entry.edges[entry.edgeIndex];
        if (edge !== undefined)
          size = Math.min(size, Math.round((edge - at) * this.rate));
        if (!entry.started && start <= at + 0.5 / this.rate) {
          const binding = take.bindings.find((b) => b.id === note.bindingId)!;
          const preset = this.bank.presets.find(
            (p) =>
              p.program === binding.gmProgram &&
              p.bankMSB === (binding.bankMsb ?? 0) &&
              p.bankLSB === (binding.bankLsb ?? 0) &&
              p.isGMGSDrum === !!binding.drum,
          )!;
          const parameters = preset.getVoiceParameters(
            note.pitch,
            Math.max(1, Math.round(note.velocity * 127)),
          );
          if (reservedSampleVoices + parameters.length > 1024)
            throw Error(
              "GM live sample-voice capacity exceeded; no silent voice stealing",
            );
          reservedSampleVoices += parameters.length;
          entry.classes = [
            ...new Set(
              parameters
                .map((p) => p.generators[GeneratorTypes.exclusiveClass])
                .filter(Boolean),
            ),
          ];
          for (const previous of this.entries.values())
            if (
              previous.started &&
              previous.note.partId === note.partId &&
              previous !== entry
            )
              releasePinnedExclusiveVoices(
                this.core,
                previous.slot,
                entry.classes,
              );
          this.core.controllerChange(slot, 121, 0);
          this.core.midiChannels[slot].setDrums(!!binding.drum);
          this.core.controllerChange(slot, 0, binding.bankMsb ?? 0);
          this.core.controllerChange(slot, 32, binding.bankLsb ?? 0);
          this.core.programChange(slot, binding.gmProgram!);
          for (const [cc, value] of [
            [7, 127],
            [11, 127],
            [10, 64],
            [64, 0],
            [91, 0],
            [93, 0],
            [101, 0],
            [100, 0],
            [6, 96],
            [38, 0],
          ] as const)
            this.core.controllerChange(slot, cc, value);
          const state = entry.evaluate(note.startSeconds, entry.from);
          this.expression(slot, state.pitchCents, state.modulation);
          if (note.velocity > 0)
            this.core.noteOn(
              slot,
              note.pitch,
              Math.max(1, Math.round(note.velocity * 127)),
            );
          entry.started = true;
        }
        if (!entry.started) continue;
        if (!entry.released && end <= at + 0.5 / this.rate) {
          if (note.termination === "kill")
            this.core.controllerChange(slot, 120, 0);
          else this.core.noteOff(slot, note.pitch);
          entry.released = true;
        }
        const state = entry.evaluate(at - offset, entry.from);
        this.expression(slot, state.pitchCents, state.modulation);
        if (
          at > end + GM_LIVE_TAIL_SECONDS &&
          this.core.midiChannels[slot].voiceCount > 0
        )
          throw Error("GM live natural release exceeds 64-second budget");
      }
      for (const entry of entries)
        if (entry.started) {
          this.scratch[entry.slot][0].fill(0);
          this.scratch[entry.slot][1].fill(0);
        }
      this.core.processSplit(
        this.scratch,
        this.effects[0],
        this.effects[1],
        0,
        size,
      );
      for (const entry of entries) {
        if (!entry.started) continue;
        const from = entry.evaluate(at - entry.offset, entry.from),
          to = entry.evaluate(
            at + (size - 1) / this.rate - entry.offset,
            entry.to,
          );
        const [left, right] = this.scratch[entry.slot],
          output = outputs[entry.output];
        for (let i = 0; i < size; i++) {
          const f = size === 1 ? 0 : i / (size - 1),
            gain = from.gain + (to.gain - from.gain) * f,
            pan = from.pan + (to.pan - from.pan) * f;
          if (pan <= 0) {
            const a = ((pan + 1) * Math.PI) / 2;
            output[0][cursor + i] += gain * (left[i] + right[i] * Math.cos(a));
            output[1][cursor + i] += gain * right[i] * Math.sin(a);
          } else {
            const a = (pan * Math.PI) / 2;
            output[0][cursor + i] += gain * left[i] * Math.cos(a);
            output[1][cursor + i] += gain * (right[i] + left[i] * Math.sin(a));
          }
        }
        if (this.core.midiChannels[entry.slot].voiceCount === 0) {
          this.entries.delete(entry.slot);
          this.ordered = this.ordered.filter((e) => e !== entry);
          this.done(entry.slot, entry.note.id, at + size / this.rate);
        }
      }
      cursor += size;
    }
  }
  private edges(message: GmLiveVoice) {
    return [
      ...new Set([
        message.note.startSeconds,
        message.note.endSeconds,
        ...message.take.controls.flatMap((c) => [
          c.timeSeconds,
          c.timeSeconds + c.rampSeconds,
        ]),
      ]),
    ]
      .map((t) => t + message.offset)
      .sort((a, b) => a - b);
  }
  private expression(slot: number, cents: number, modulation: number) {
    if (Math.abs(cents) > 9600)
      throw Error("GM live pitch range exceeds 96 semitones");
    this.core.pitchWheel(
      slot,
      Math.max(0, Math.min(16383, Math.round(8192 + (cents / 9600) * 8192))),
    );
    this.core.controllerChange(slot, 1, Math.round(modulation * 127));
  }
  dispose() {
    this.closed = true;
    this.entries.clear();
    this.ordered = [];
    this.core.destroySynthProcessor();
  }
}
