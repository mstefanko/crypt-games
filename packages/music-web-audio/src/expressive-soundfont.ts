import {
  SoundBankLoader,
  SpessaSynthProcessor,
  GeneratorTypes,
} from "spessasynth_core";
import {
  assertPerformanceTakeV3,
  createExpressionEvaluator,
  type PerformanceTakeV3,
  type CompiledExpressiveNote,
} from "@onepage/music-core/expressive-performance";

export interface ExpressiveSoundfontOptions {
  bank: ArrayBuffer;
  sampleRate?: number;
  /** Deviated captures retain their admitted plan, not a physical-stop PCM projection. */
  mode?: "clean" | "planned";
  startSeconds?: number;
  endSeconds?: number;
  /** Diagnostic export only; normal replay omits approximate rolling preroll. */
  includeApproximatePreroll?: boolean;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
  onMetrics?: (metrics: {
    voiceFrames: number;
    notes: number;
    outputFrames: number;
  }) => void;
}
/** Faithful prefix render/crop. One bank/processor and two small scratch buffers;
 * no retained per-note AudioBuffers, and no independent MIDI sequencer/transport.
 * Dynamic volume/expression/pan are applied once outside the SF processor.
 * This backend is offline: audition uses its exact exported buffer.
 */
export async function renderPerformanceTakeV3Soundfont(
  take: PerformanceTakeV3,
  options: ExpressiveSoundfontOptions,
): Promise<AudioBuffer> {
  assertPerformanceTakeV3(take);
  if (take.deviations.length && options.mode !== "planned")
    throw Error("GM take has execution deviations; choose explicitly labeled planned rendering");
  const rate = options.sampleRate ?? 48000;
  const faithful = take.provenance.captureFaithfulFromSeconds ?? 0;
  if (
    typeof faithful !== "number" ||
    !Number.isFinite(faithful) ||
    faithful < 0 ||
    faithful >= take.durationSeconds
  )
    throw Error("Invalid faithful capture boundary");
  const begin =
      options.startSeconds ??
      (options.includeApproximatePreroll ? 0 : faithful),
    finish = options.endSeconds ?? take.durationSeconds + 64;
  if (
    ![22050, 44100, 48000].includes(rate) ||
    !Number.isFinite(begin) ||
    !Number.isFinite(finish) ||
    begin < 0 ||
    (!options.includeApproximatePreroll && begin < faithful) ||
    finish <= begin ||
    finish > take.durationSeconds + 64
  )
    throw Error("Invalid GM excerpt or sample rate");
  if (
    options.bank.byteLength < 12 ||
    options.bank.byteLength > 64 * 1024 * 1024
  )
    throw Error("GM bank exceeds 64 MiB budget");
  const declaredHashes = new Set(
    take.resources
      .filter((r) => r.kind === "soundfont" && r.sha256)
      .map((r) => r.sha256!.toLowerCase()),
  );
  if (declaredHashes.size) {
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", options.bank)),
    )
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    if (declaredHashes.size !== 1 || !declaredHashes.has(digest))
      throw Error("GM bank does not match frozen take resource identity");
  }
  const frames = Math.ceil((finish - begin) * rate);
  if (frames > 32_000_000) throw Error("GM output frame budget exceeded");
  const output = new AudioBuffer({
    numberOfChannels: 2,
    length: frames,
    sampleRate: rate,
  });
  const left = output.getChannelData(0),
    right = output.getChannelData(1);
  const bank = SoundBankLoader.fromArrayBuffer(options.bank.slice(0));
  const bindings = new Map(take.bindings.map((b) => [b.id, b]));
  const presets = new Map<string, ReturnType<typeof bank.presets.find>>();
  for (const binding of take.bindings) {
    if (binding.kind !== "soundfont" || binding.gmProgram === undefined)
      throw Error(`GM binding unavailable: ${binding.id}`);
    const preset = bank.presets.find(
      (p) =>
        p.program === binding.gmProgram &&
        p.bankMSB === (binding.bankMsb ?? 0) &&
        p.bankLSB === (binding.bankLsb ?? 0) &&
        p.isGMGSDrum === !!binding.drum,
    );
    if (!preset) throw Error(`GM bank has no exact preset for ${binding.id}`);
    presets.set(binding.id, preset);
  }
  // Explicitly reject unsupported expression rather than silently claiming parity.
  if (
    take.parts.some(
      (p) =>
        p.initialState?.brightness !== undefined &&
        p.initialState.brightness !== 1,
    ) ||
    take.controls.some((c) => c.parameter === "brightness" && c.value !== 1)
  )
    throw Error("GM brightness mapping is not qualified in this profile");
  const core = new SpessaSynthProcessor(rate, {
    effectsEnabled: false,
    maxBufferSize: 128,
  });
  await core.processorInitialized;
  core.soundBankManager.addSoundBank(bank, "expressive-gm");
  core.setSystemParameter("voiceCap", 256);
  core.setSystemParameter("autoAllocateVoices", false);
  core.setSystemParameter("gain", 1);
  const scratchL = new Float32Array(128),
    scratchR = new Float32Array(128);
  let processedFrames = 0;
  let lastFrame = Math.ceil((take.durationSeconds - begin) * rate);
  let yieldFrames = 0;
  const notes = take.notes
    .filter((n) => n.startSeconds < finish && n.velocity > 0)
    .sort(
      (a, b) =>
        a.startSeconds - b.startSeconds ||
        (a.sourceOrder ?? 0) - (b.sourceOrder ?? 0) ||
        a.id.localeCompare(b.id),
    );
  const exclusivePlan = planExclusiveChokes(
    notes,
    (n) =>
      presets
        .get(n.bindingId)!
        .getVoiceParameters(n.pitch, Math.max(1, Math.round(n.velocity * 127)))
        .map((v) => v.generators[GeneratorTypes.exclusiveClass]),
    rate,
  );

  try {
    for (const [index, note] of notes.entries()) {
      options.signal?.throwIfAborted();
      const binding = bindings.get(note.bindingId)!;
      const channel = binding.drum ? 9 : 0;
      core.stopAllChannels(true);
      core.controllerChange(channel, 121, 0);
      core.midiChannels[channel].setDrums(!!binding.drum);
      core.controllerChange(channel, 0, binding.bankMsb ?? 0);
      core.controllerChange(channel, 32, binding.bankLsb ?? 0);
      core.programChange(channel, binding.gmProgram!);
      core.controllerChange(channel, 7, 127);
      core.controllerChange(channel, 11, 127);
      core.controllerChange(channel, 10, 64);
      core.controllerChange(channel, 64, 0);
      core.controllerChange(channel, 91, 0);
      core.controllerChange(channel, 93, 0);
      core.controllerChange(channel, 101, 0);
      core.controllerChange(channel, 100, 0);
      core.controllerChange(channel, 6, 96);
      core.controllerChange(channel, 38, 0);
      const evaluate = createExpressionEvaluator(take, note);
      const initial = evaluate(note.startSeconds);
      if (Math.abs(initial.pitchCents) > 9600)
        throw Error("GM profile pitch range exceeds 96 semitones");
      core.pitchWheel(
        channel,
        Math.max(
          0,
          Math.min(
            16383,
            Math.round(8192 + (initial.pitchCents / 9600) * 8192),
          ),
        ),
      );
      core.controllerChange(channel, 1, Math.round(initial.modulation * 127));
      core.noteOn(
        channel,
        note.pitch,
        Math.max(1, Math.round(note.velocity * 127)),
      );
      const chokes = exclusivePlan.get(note.id) ?? [];
      let chokeIndex = 0;
      const releaseFrame = Math.max(
        1,
        Math.round((note.endSeconds - note.startSeconds) * rate),
      );
      // Render natural releases until silence or the requested excerpt end.
      // Some valid GM presets release for more than ten seconds; the total
      // synthesis-work cap bounds cost without silently cutting those voices.
      const maxFrames =
        note.termination === "kill"
          ? Math.min(
              Math.ceil((finish - note.startSeconds) * rate),
              releaseFrame,
            )
          : Math.ceil((finish - note.startSeconds) * rate);
      const relevant = take.controls.filter(
        (c) => c.partId === note.partId && (!c.noteId || c.noteId === note.id),
      );
      const ramps = relevant.filter((c) => c.rampSeconds > 0);
      const edges = [
        ...new Set([
          releaseFrame,
          ...chokes.map((c) => c.frame),
          ...relevant
            .flatMap((c) => [c.timeSeconds, c.timeSeconds + c.rampSeconds])
            .map((t) => Math.round((t - note.startSeconds) * rate))
            .filter((f) => f > 0 && f < maxFrames),
        ]),
      ].sort((a, b) => a - b);
      let cursor = 0,
        released = false,
        edgeIndex = 0;
      while (cursor < maxFrames) {
        while (chokes[chokeIndex]?.frame <= cursor) {
          releasePinnedExclusiveVoices(
            core,
            channel,
            chokes[chokeIndex].classes,
          );
          chokeIndex++;
        }
        if (!released && cursor >= releaseFrame) {
          core.noteOff(channel, note.pitch);
          released = true;
        }
        if (cursor > 0 && core.voiceCount === 0) break;
        while (edges[edgeIndex] <= cursor) edgeIndex++;
        const nowSeconds = note.startSeconds + cursor / rate;
        const hasActiveRamp = ramps.some(
          (c) =>
            c.rampSeconds > 0 &&
            c.timeSeconds <= nowSeconds &&
            c.timeSeconds + c.rampSeconds > nowSeconds,
        );
        const size = Math.min(
          hasActiveRamp ? 32 : 128,
          maxFrames - cursor,
          (edges[edgeIndex] ?? maxFrames) - cursor,
        );
        const at = note.startSeconds + cursor / rate;
        const from = evaluate(at),
          to = evaluate(at + (size - 1) / rate);
        if (Math.abs(from.pitchCents) > 9600 || Math.abs(to.pitchCents) > 9600)
          throw Error("GM profile pitch range exceeds 96 semitones");
        core.pitchWheel(
          channel,
          Math.max(
            0,
            Math.min(16383, Math.round(8192 + (from.pitchCents / 9600) * 8192)),
          ),
        );
        core.controllerChange(channel, 1, Math.round(from.modulation * 127));
        scratchL.fill(0);
        scratchR.fill(0);
        core.process(scratchL, scratchR, 0, size);
        for (let i = 0; i < size; i++) {
          const frame =
            Math.round((note.startSeconds - begin) * rate) + cursor + i;
          if (frame < 0 || frame >= frames) continue;
          const f = size === 1 ? 0 : i / (size - 1);
          const gain = from.gain + (to.gain - from.gain) * f;
          const pan = from.pan + (to.pan - from.pan) * f;
          const l = scratchL[i],
            r = scratchR[i];
          if (pan <= 0) {
            const a = ((pan + 1) * Math.PI) / 2;
            left[frame] += gain * (l + r * Math.cos(a));
            right[frame] += gain * r * Math.sin(a);
          } else {
            const a = (pan * Math.PI) / 2;
            left[frame] += gain * l * Math.cos(a);
            right[frame] += gain * (r + l * Math.sin(a));
          }
        }
        cursor += size;
        processedFrames += size;
        yieldFrames += size;
        if (yieldFrames >= 262144) {
          yieldFrames = 0;
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          options.signal?.throwIfAborted();
        }
        if (processedFrames > 1_500_000_000)
          throw Error(
            "GM synthesis work budget exceeded; render a shorter prefix",
          );
      }
      lastFrame = Math.max(
        lastFrame,
        Math.round((note.startSeconds - begin) * rate) + cursor,
      );
      if (
        options.endSeconds === undefined &&
        cursor >= maxFrames &&
        core.voiceCount > 0 &&
        note.termination !== "kill"
      )
        throw Error(
          "GM natural release exceeds 64-second final-tail budget; choose an explicit excerpt",
        );
      if (index % 8 === 0) {
        options.onProgress?.(index + 1, notes.length);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    options.onProgress?.(notes.length, notes.length);
    options.onMetrics?.({
      voiceFrames: processedFrames,
      notes: notes.length,
      outputFrames:
        options.endSeconds === undefined ? Math.min(frames, lastFrame) : frames,
    });
    if (options.endSeconds === undefined && lastFrame < frames) {
      const trimmed = new AudioBuffer({
        numberOfChannels: 2,
        length: Math.max(1, lastFrame),
        sampleRate: rate,
      });
      trimmed.copyToChannel(left.subarray(0, lastFrame), 0);
      trimmed.copyToChannel(right.subarray(0, lastFrame), 1);
      return trimmed;
    }
    return output;
  } finally {
    core.destroySynthProcessor();
  }
}

interface ExclusiveChoke {
  frame: number;
  classes: number[];
}
/** Pinned 4.3.22 channel/class semantics: an onset chokes prior rendered voices,
 * including release tails. Simultaneous sample-frame onsets do not choke each
 * other (`hasRendered` is false until the first processor block).
 * Unlike the SF2 spec's preset scope, the pinned core does not test preset identity.
 * Part identity represents the original controller/channel domain across patches.
 */
export function planExclusiveChokes(
  notes: readonly CompiledExpressiveNote[],
  classesFor: (note: CompiledExpressiveNote) => readonly number[],
  sampleRate: number,
): Map<string, ExclusiveChoke[]> {
  const sorted = notes
      .slice()
      .sort(
        (a, b) =>
          Math.round(a.startSeconds * sampleRate) -
            Math.round(b.startSeconds * sampleRate) ||
          (a.sourceOrder ?? 0) - (b.sourceOrder ?? 0) ||
          a.id.localeCompare(b.id),
      ),
    next = new Map<string, number>(),
    plan = new Map<string, ExclusiveChoke[]>();
  for (let end = sorted.length; end > 0; ) {
    let start = end - 1;
    const frame = Math.round(sorted[start].startSeconds * sampleRate);
    while (
      start > 0 &&
      Math.round(sorted[start - 1].startSeconds * sampleRate) === frame
    )
      start--;
    const group = sorted.slice(start, end).map((note) => ({
      note,
      classes: [...new Set(classesFor(note).filter((c) => c !== 0))],
    }));
    for (const { note, classes } of group) {
      const grouped = new Map<number, number[]>();
      for (const c of classes) {
        const later = next.get(`${note.partId}:${c}`);
        if (later !== undefined) {
          const offset = later - frame;
          grouped.set(offset, [...(grouped.get(offset) ?? []), c]);
        }
      }
      plan.set(
        note.id,
        [...grouped]
          .map(([frame, classes]) => ({ frame, classes }))
          .sort((a, b) => a.frame - b.frame),
      );
    }
    for (const { note, classes } of group)
      for (const c of classes) next.set(`${note.partId}:${c}`, frame);
    end = start;
  }
  return plan;
}
/** Narrow pinned-library bridge. The processor's public API exposes no voice
 * handle, so guard the exact internal shape before invoking the library's own
 * release primitive; no invented cutoff envelope or bank rewrite is involved.
 * Upgrade qualification must exercise the acoustic exclusive-class tests.
 */
export function releasePinnedExclusiveVoices(
  core: SpessaSynthProcessor,
  channel: number,
  classes: readonly number[],
): void {
  type PinnedVoice = {
    isActive: boolean;
    channel: number;
    exclusiveClass: number;
    hasRendered: boolean;
    exclusiveRelease(time: number): void;
  };
  const voices = (core as unknown as { synthCore?: { voices?: PinnedVoice[] } })
    .synthCore?.voices;
  if (!Array.isArray(voices))
    throw Error(
      "Pinned SoundFont exclusive-release API unavailable; requalify spessasynth_core",
    );
  for (const voice of voices)
    if (
      voice.isActive &&
      voice.channel === channel &&
      voice.hasRendered &&
      classes.includes(voice.exclusiveClass)
    ) {
      if (typeof voice.exclusiveRelease !== "function")
        throw Error("Pinned SoundFont exclusive-release primitive unavailable");
      voice.exclusiveRelease(core.currentTime);
    }
}
