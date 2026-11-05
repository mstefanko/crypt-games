import {
  assertPerformanceTakeV3,
  NEUTRAL_EXPRESSION,
  type CompiledExpressiveNote,
  type ExpressiveControlEvent,
  type ExpressivePart,
  type ExpressiveWindow,
  type PerformanceTakeV3,
} from "@onepage/music-core/expressive-performance";
import {
  ExpressiveStreamQueue,
  type ExpressiveReceipt,
  controlOrder,
  type ExpressiveTimelineRevision,
} from "./expressive-stream";
import {
  expressiveSynthRenderer,
  type ExpressiveVoiceHandle,
  type ExpressiveVoiceRenderer,
} from "./expressive-synth";
import type { TickerFactory } from "./stream";

export interface ExpressiveEngineOptions {
  audioContext: AudioContext;
  destination?: AudioNode;
  destinations?: Partial<Record<ExpressivePart["role"], AudioNode>>;
  renderer?: ExpressiveVoiceRenderer;
}
export interface ExpressiveBeginOptions {
  /** Frozen resource/part/time-map header. Submit musical events through windows. */
  take: PerformanceTakeV3;
  originContextTime?: number;
  startSeconds?: number;
  lookaheadSeconds?: number;
  maxHorizonSeconds?: number;
  maxPendingNotes?: number;
  maxWindowControls?: number;
  rollingCaptureSeconds?: number;
  ticker?: TickerFactory;
  /** Audio clock position (not scheduling lookahead); use for heard-memory decisions. */
  onHeardFrontier?: (seconds: number) => void;
}
/** Owns voices and queues, never the caller's AudioContext or music/environment mixer. */
export class ExpressiveAudioEngine {
  private epoch = 0;
  private queue: ExpressiveStreamQueue | null = null;
  private voices = new Map<
    string,
    { note: CompiledExpressiveNote; voice: ExpressiveVoiceHandle }
  >();
  private originOffset = 0;
  private startSeconds = 0;
  private lookahead = 0.1;
  private ticker?: () => void;
  private receipts: ExpressiveReceipt[] = [];
  private finalTake: PerformanceTakeV3 | null = null;
  private disposed = false;
  private readonly renderer: ExpressiveVoiceRenderer;
  private requestedControls = 0;
  private receiptOverflow = false;
  private immediateQuota: { at: number; events: number; writes: number }[] = [];
  private controlWrites = 0;
  private rejectedControls = 0;
  private lastUnderrunThrough = -1;
  private onHeardFrontier?: (seconds: number) => void;
  private heardFrontier = -1;
  constructor(private readonly options: ExpressiveEngineOptions) {
    this.renderer = options.renderer ?? expressiveSynthRenderer;
  }
  begin(config: ExpressiveBeginOptions): number {
    if (this.disposed) throw Error("Expressive engine disposed");
    assertPerformanceTakeV3(config.take);
    if (config.take.notes.length || config.take.controls.length)
      throw Error(
        "Begin expects an event-free expressive header; submit notes and controls together in windows",
      );
    const lookahead = config.lookaheadSeconds ?? 0.1;
    const start = config.startSeconds ?? 0;
    const origin =
      config.originContextTime ??
      this.options.audioContext.currentTime + Math.max(0.2, lookahead + 0.05);
    if (
      !Number.isFinite(lookahead) ||
      lookahead < 0.025 ||
      lookahead > 0.5 ||
      !Number.isFinite(origin) ||
      origin < this.options.audioContext.currentTime
    )
      throw Error("Invalid expressive clock");
    // Validate even unused bindings before the first deadline.
    for (const binding of config.take.bindings)
      this.renderer.releaseSeconds(config.take, {
        bindingId: binding.id,
      } as CompiledExpressiveNote);
    const epoch = this.epoch + (this.queue ? 2 : 1);
    const queue = new ExpressiveStreamQueue(
      epoch,
      config.take,
      {
        maxVoices: this.renderer.maxVoices,
        validateTake: this.renderer.validateTake?.bind(this.renderer),
        maxHorizonSeconds: config.maxHorizonSeconds,
        maxPendingNotes: config.maxPendingNotes,
        maxWindowControls: config.maxWindowControls,
        rollingCaptureSeconds:
          config.rollingCaptureSeconds ??
          (config.take.durationSeconds >= 120 &&
          config.take.tempoMap.length === 1
            ? 120
            : undefined),
        releaseSeconds: (n) => (this.renderer.admissionReleaseSeconds ?? this.renderer.releaseSeconds).call(this.renderer, config.take, n),
      },
      start,
    );
    this.stop();
    this.epoch = epoch;
    this.queue = queue;
    this.finalTake = null;
    this.startSeconds = start;
    this.lookahead = lookahead;
    this.originOffset = origin - start;
    this.lastUnderrunThrough = -1;
    this.onHeardFrontier = config.onHeardFrontier;
    this.heardFrontier = -1;
    this.requestedControls = 0;
    this.immediateQuota = [];
    this.controlWrites = 0;
    this.rejectedControls = 0;
    const ticker =
      config.ticker ??
      ((callback, interval) => {
        const id = setInterval(callback, interval);
        return () => clearInterval(id);
      });
    this.ticker = ticker(() => this.pump(), 25);
    return epoch;
  }
  submitWindow(window: ExpressiveWindow): ExpressiveReceipt {
    if (!this.queue)
      return {
        epoch: this.epoch,
        status: "rejected",
        reason: "stale-or-stopped",
      };
    const receipt = this.queue.submit(window);
    this.record(receipt);
    return receipt;
  }
  submitTimelineWindow(window: ExpressiveWindow, timeline: ExpressiveTimelineRevision): ExpressiveReceipt {
    const receipt = this.queue?.submitTimelineWindow(window, timeline) ?? {epoch: this.epoch, status: "rejected" as const, reason: "stale-or-stopped"};
    this.record(receipt);
    return receipt;
  }
  getPendingEvents() {
    return structuredClone({notes: this.queue?.notes ?? [], controls: this.queue?.controls ?? []});
  }
  applyControls(request: {
    epoch: number;
    controls: ExpressiveControlEvent[];
  }): ExpressiveReceipt {
    if (!this.queue || request.epoch !== this.epoch)
      return {
        epoch: this.epoch,
        status: "rejected",
        reason: "stale-or-stopped",
      };
    if (
      request.controls.some(
        (c) =>
          c.noteId !== undefined ||
          !(c.parameter in NEUTRAL_EXPRESSION) ||
          !Number.isFinite(c.timeSeconds) ||
          c.timeSeconds < 0 ||
          !Number.isFinite(c.rampSeconds) ||
          c.rampSeconds < 0 ||
          !Number.isFinite(c.value) ||
          !c.id ||
          !this.queue!.template.parts.some((p) => p.id === c.partId),
      )
    ) {
      const receipt: ExpressiveReceipt = {
        epoch: this.epoch,
        status: "rejected",
        reason: "invalid-immediate-control",
      };
      this.record(receipt);
      return receipt;
    }
    const minimum = Math.max(
      this.queue.frontierSeconds,
      this.options.audioContext.currentTime - this.originOffset + 0.01,
      this.startSeconds,
    );
    // Exactly this effective off-grid timestamp is retained for replay.
    const latest = new Map(
      request.controls
        .slice()
        .sort(controlOrder)
        .map((c) => [`${c.partId}:${c.parameter}`, c]),
    );
    const prior = [
      ...this.queue.getCommittedTimeline().controls,
      ...this.queue.controls,
    ].sort(controlOrder);
    const controls = [...latest.values()]
      .filter((c) => {
        const last = prior
          .filter(
            (p) =>
              !p.noteId &&
              p.partId === c.partId &&
              p.parameter === c.parameter &&
              p.timeSeconds <= Math.max(c.timeSeconds, minimum),
          )
          .at(-1);
        const part = this.queue!.template.parts.find((p) => p.id === c.partId);
        const target =
          last?.value ??
          part?.initialState?.[c.parameter] ??
          (c.parameter === "pan" ? part?.pan : NEUTRAL_EXPRESSION[c.parameter]);
        return c.value !== target;
      })
      .map((c) => ({
        ...c,
        timeSeconds: Math.max(c.timeSeconds, minimum),
        rampSeconds: Math.max(0.01, Math.min(2, c.rampSeconds)),
      }));
    const now = this.options.audioContext.currentTime;
    this.immediateQuota = this.immediateQuota.filter((q) => q.at > now - 1);
    const writes = controls.reduce(
      (sum, c) =>
        sum +
        [...this.voices.values()].filter(
          (v) =>
            v.note.partId === c.partId &&
            v.voice.endContextTime > c.timeSeconds + this.originOffset,
        ).length +
        this.queue!.notes.filter(
          (n) =>
            n.partId === c.partId &&
            n.startSeconds <= c.timeSeconds &&
            n.endSeconds +
              this.renderer.releaseSeconds(this.queue!.template, n) >
              c.timeSeconds,
        ).length,
      0,
    );
    const usedEvents = this.immediateQuota.reduce(
        (sum, q) => sum + q.events,
        0,
      ),
      usedWrites = this.immediateQuota.reduce((sum, q) => sum + q.writes, 0);
    if (
      controls.length > 16 ||
      usedEvents + controls.length > 64 ||
      writes > 1024 ||
      usedWrites + writes > 4096
    ) {
      this.rejectedControls += controls.length;
      const receipt: ExpressiveReceipt = {
        epoch: this.epoch,
        status: "rejected",
        reason:
          controls.length > 16 || usedEvents + controls.length > 64
            ? "immediate-event-budget"
            : "voice-write-budget",
      };
      this.record(receipt);
      return receipt;
    }
    const receipt = this.queue.addControls(request.epoch, controls);
    if (receipt.status === "accepted")
      this.immediateQuota.push({ at: now, events: controls.length, writes });
    if (receipt.status === "accepted") {
      this.requestedControls += controls.length;
      receipt.status = "controls";
    }
    this.record(receipt);
    return receipt;
  }
  pump(): void {
    const queue = this.queue;
    if (!queue) return;
    const now = this.options.audioContext.currentTime;
    for (const [id, entry] of this.voices)
      if (entry.voice.endContextTime <= now) this.voices.delete(id);
    const position = now - this.originOffset;
    const heard = Math.min(position, queue.frontierSeconds, queue.preparedThroughSeconds);
    if (heard >= this.startSeconds && heard > this.heardFrontier && this.options.audioContext.state !== "suspended") {
      this.heardFrontier = heard;
      this.onHeardFrontier?.(heard);
    }
    if (
      queue.ended &&
      !queue.notes.length &&
      !queue.controls.length &&
      !this.voices.size &&
      position >= queue.preparedThroughSeconds
    ) {
      this.stop("drained");
      return;
    }
    if (
      !queue.ended &&
      position > queue.preparedThroughSeconds + 0.02 &&
      this.lastUnderrunThrough !== queue.preparedThroughSeconds
    ) {
      this.lastUnderrunThrough = queue.preparedThroughSeconds;
      queue.template.deviations.push({
        kind: "coverage-underrun",
        timeSeconds: Math.max(0, queue.preparedThroughSeconds),
        reason: "prepared-audio-coverage-exhausted",
      });
      this.record({
        epoch: this.epoch,
        status: "rejected",
        reason: "coverage-underrun",
        timeSeconds: queue.preparedThroughSeconds,
      });
    }
    const through = Math.max(
      this.startSeconds,
      now - this.originOffset + this.lookahead,
    );
    const ready = queue.take(through);
    if (!ready.notes.length && !ready.controls.length) {
      try { this.renderer.checkHealth?.(this.options.audioContext); }
      catch (error) {
        this.finalTake = queue.getCapturedTake();
        this.finalTake.deviations.push({kind: "renderer-failure", timeSeconds: Math.max(0, position - queue.captureOriginSeconds), reason: String(error)});
        this.stop("renderer-failure");
      }
      return;
    }
    const take = queue.getCommittedTimeline();
    try {
      this.renderer.checkHealth?.(this.options.audioContext);
      for (const note of ready.notes) {
        const at = note.startSeconds + this.originOffset;
        if (at < now - 0.001) {
          take.deviations.push({
            kind: "late",
            timeSeconds: note.startSeconds,
            noteId: note.id,
            reason: "audio-deadline-missed",
          });
          throw Error(`Expressive audio deadline missed for ${note.id}`);
        }
        const role = take.parts.find((p) => p.id === note.partId)!.role;
        const destination =
          this.options.destinations?.[role] ??
          this.options.destination ??
          this.options.audioContext.destination;
        const voice = this.renderer.renderVoice(
          this.options.audioContext,
          destination,
          take,
          note,
          this.originOffset,
        );
        this.voices.set(note.id, { note, voice });
        this.record({
          epoch: this.epoch,
          status: "scheduled",
          noteId: note.id,
          timeSeconds: note.startSeconds,
        });
      }
      const partChanges = ready.controls.filter((c) => !c.noteId);
      for (const { note, voice } of this.voices.values()) {
        const changes = partChanges.filter((c) => c.partId === note.partId);
        if (changes.length) {
          voice.updateControls(
            take,
            Math.max(
              note.startSeconds,
              Math.min(...changes.map((c) => c.timeSeconds)),
            ),
            [...new Set(changes.map((c) => c.parameter))],
          );
          this.controlWrites += changes.length;
        }
      }
    } catch (error) {
      this.finalTake = queue.getCapturedTake();
      this.finalTake.deviations.push({
        kind: "renderer-failure",
        timeSeconds: Math.max(
          0,
          now - this.originOffset - queue.captureOriginSeconds,
        ),
        reason: error instanceof Error ? error.message : "renderer-failure",
      });
      this.stop("renderer-failure");
    }
  }
  /** Finish admitted coverage and allow every already-owned release tail to drain. */
  endStream() {
    if (this.queue) this.queue.ended = true;
  }
  getClock() {
    return {
      epoch: this.epoch,
      positionSeconds: Math.max(
        this.startSeconds,
        this.options.audioContext.currentTime - this.originOffset,
      ),
      frontierSeconds: this.queue?.frontierSeconds ?? this.startSeconds,
      protectedThroughSeconds: this.queue?.protectedThroughSeconds ?? this.startSeconds,
      preparedThroughSeconds:
        this.queue?.preparedThroughSeconds ?? this.startSeconds,
      originContextTime: this.originOffset + this.startSeconds,
      running: !!this.queue,
    };
  }
  getSnapshot() {
    return {
      ...this.getClock(),
      activeVoices: [...this.voices.values()].filter(
        (v) => v.voice.endContextTime > this.options.audioContext.currentTime,
      ).length,
      pendingNotes: this.queue?.notes.length ?? 0,
      pendingControls: this.queue?.controls.length ?? 0,
      requestedControls: this.requestedControls,
      controlWrites: this.controlWrites,
      rejectedControls: this.rejectedControls,
      captureOriginSeconds: this.queue?.captureOriginSeconds ?? 0,
      captureNotes:
        this.queue?.capturedNoteCount ?? this.finalTake?.notes.length ?? 0,
      receiptOverflow: this.receiptOverflow,
      capabilities: {
        renderer: this.renderer.id,
        maxVoices: this.renderer.maxVoices,
        live: true,
        offline: true,
      },
    };
  }
  getCapturedTake(): PerformanceTakeV3 {
    const take = this.queue?.getCapturedTake() ?? this.finalTake;
    if (!take) throw Error("No expressive capture");
    return structuredClone(take);
  }
  drainReceipts() {
    const receipts = this.receipts.splice(0);
    if (this.receiptOverflow)
      receipts.unshift({
        epoch: this.epoch,
        status: "rejected",
        reason: "receipt-overflow",
      });
    this.receiptOverflow = false;
    return receipts;
  }
  private record(receipt: ExpressiveReceipt) {
    if (this.receipts.length >= 4096) {
      this.receipts.shift();
      this.receiptOverflow = true;
    }
    this.receipts.push(structuredClone(receipt));
  }
  stop(reason = "user-stop") {
    const previous = this.queue;
    if (previous) {
      this.finalTake ??= previous.getCapturedTake();
      const position = Math.max(
        0,
        this.options.audioContext.currentTime -
          this.originOffset -
          previous.captureOriginSeconds,
      );
      if (
        [...this.voices.values()].some(
          (v) => v.voice.endContextTime > this.options.audioContext.currentTime,
        ) &&
        !this.finalTake.deviations.some((d) => d.kind === "stopped")
      )
        this.finalTake.deviations.push({
          kind: "stopped",
          timeSeconds: position,
          reason,
        });
      previous.stop();
      this.queue = null;
      this.epoch++;
      this.record({
        epoch: this.epoch,
        status: "stopped",
        reason,
        timeSeconds: position,
      });
    }
    this.ticker?.();
    this.ticker = undefined;
    for (const { voice } of this.voices.values()) voice.stop();
    this.voices.clear();
    if (reason === "renderer-failure") this.renderer.releaseContext?.(this.options.audioContext);
  }
  reset(config: ExpressiveBeginOptions) {
    return this.begin(config);
  }
  dispose() {
    this.stop("disposed");
    this.renderer.releaseContext?.(this.options.audioContext);
    this.disposed = true;
  }
}
export function createExpressiveAudioEngine(options: ExpressiveEngineOptions) {
  return new ExpressiveAudioEngine(options);
}

/** Shared renderer and controls for generated live notes and frozen seconds-based takes. */
export async function renderPerformanceTakeV3Offline(
  take: PerformanceTakeV3,
  options: {
    sampleRate?: number;
    renderer?: ExpressiveVoiceRenderer;
    mode?: "clean" | "planned";
    /** Include the explicitly approximate leading rolling-capture region. Default renders it for state, then crops PCM. */
    includeApproximatePreroll?: boolean;
  } = {},
): Promise<AudioBuffer> {
  assertPerformanceTakeV3(take);
  if (take.deviations.length && options.mode !== "planned")
    throw Error(
      "Expressive take has execution deviations; choose explicitly labeled planned rendering",
    );
  const marker = take.provenance.captureFaithfulFromSeconds ?? 0;
  if (
    typeof marker !== "number" ||
    !Number.isFinite(marker) ||
    marker < 0 ||
    marker >= take.durationSeconds
  )
    throw Error("Invalid expressive faithful capture boundary");
  const sampleRate = options.sampleRate ?? 48000;
  if (![22050, 44100, 48000, 96000].includes(sampleRate))
    throw Error("Invalid expressive sample rate");
  const renderer = options.renderer ?? expressiveSynthRenderer;
  const sorted = [...take.notes].sort(
    (a, b) => a.startSeconds - b.startSeconds || a.id.localeCompare(b.id),
  );
  let ends: number[] = [],
    duration = take.durationSeconds;
  for (const note of sorted) {
    const release = renderer.releaseSeconds(take, note);
    if (!Number.isFinite(release) || release < 0 || release > 10)
      throw Error("Invalid expressive renderer release");
    ends = ends.filter((end) => end > note.startSeconds);
    if (ends.length >= renderer.maxVoices)
      throw Error("Expressive offline voice budget");
    const end = note.endSeconds + release;
    ends.push(end);
    duration = Math.max(duration, end);
  }
  renderer.validateTake?.(take);
  const frames = Math.max(1, Math.ceil(duration * sampleRate));
  if (frames > 32000000) throw Error("Expressive offline frame budget");
  const context = new OfflineAudioContext(2, frames, sampleRate);
  try {
    await renderer.prepareContext?.(context, take);
    for (const note of sorted)
      renderer.renderVoice(context, context.destination, take, note, 0);
    const rendered = await context.startRendering();
    if (!marker || options.includeApproximatePreroll) return rendered;
    const startFrame = Math.ceil(marker * sampleRate),
      frames = rendered.length - startFrame;
    if (frames < 1)
      throw Error("Expressive capture has no faithful listening frames");
    const cropped = context.createBuffer(
      rendered.numberOfChannels,
      frames,
      sampleRate,
    );
    for (let channel = 0; channel < rendered.numberOfChannels; channel++)
      cropped.copyToChannel(
        rendered.getChannelData(channel).subarray(startFrame),
        channel,
      );
    return cropped;
  } finally {
    renderer.releaseContext?.(context);
  }
}
