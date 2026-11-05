import {
  AudioEngine,
  renderPerformanceVoice,
  type PerformanceVoiceRenderer,
  type Patch,
} from "./index";
import { ticksToSeconds } from "@onepage/music-core/runtime";
import {
  roleGainAt,
  type RoleGainEvent,
} from "@onepage/music-core/performance";
import {
  StreamQueue,
  type StreamConfig,
  type StreamWindow,
  type StreamReceipt,
} from "./stream";
export type {
  StreamConfig,
  StreamWindow,
  StreamReceipt,
  TickerFactory,
} from "./stream";
const LOOKAHEAD = 0.15;
const MAX_VOICES = 256;
/** Opt-in streaming transport on the existing owner/context and shared synthesis graph. */
export class StreamingAudioEngine extends AudioEngine {
  private voiceRenderer: PerformanceVoiceRenderer | null = null;
  private preparingRenderer: Promise<void> | null = null;
  /** Switch only between takes; every active take has one declared renderer. */
  setVoiceRenderer(renderer: PerformanceVoiceRenderer | null) {
    if (this.isPlaying || this.stream)
      throw Error("Stop before changing instrument renderer");
    if (
      renderer?.maxVoices !== undefined &&
      (!Number.isInteger(renderer.maxVoices) ||
        renderer.maxVoices < 1 ||
        renderer.maxVoices > MAX_VOICES)
    )
      throw Error("Invalid renderer voice budget");
    if (this.preparingRenderer) this.streamEpoch++;
    this.voiceRenderer = renderer;
  }
  readRoleCaptureTaps(): ReadonlyMap<string, AudioNode> {
    return new Map(this.roleBuses);
  }
  /** Shared music input for additive renderers; follows role ducking and the existing music mixer. */
  readMusicInput(role = "melody"): AudioNode {
    if (!this.context || !this.output) throw Error("Enable audio before requesting music input");
    return this.musicDestination(role);
  }
  readAudioContext() {
    return this.context;
  }
  protected override get voiceCapacity() {
    return this.voiceLimit;
  }
  private get voiceLimit() {
    return this.voiceRenderer?.maxVoices ?? MAX_VOICES;
  }
  private releaseFor(patch: Patch) {
    const release =
      this.voiceRenderer?.releaseSeconds(patch) ??
      Math.max(0.005, patch.release);
    if (!Number.isFinite(release) || release < 0.005 || release > 10)
      throw Error("Invalid renderer release");
    return release;
  }
  private stream: StreamQueue | null = null;
  private roleAutomation: RoleGainEvent[] = [];
  private lastUnderrunThrough = -1;
  private streamEpoch = 0;
  private streamHorizon = LOOKAHEAD;
  private streamNotBeforeEnd = 0;
  private streamSignatureBytes = 0;
  private streamSubmissions = new Map<
    string,
    { signature: string; receipt: StreamReceipt; endTick: number }
  >();
  private streamTicker?: () => void;
  private streamReceipts: StreamReceipt[] = [];
  private streamReceiptOverflow = false;
  private roleBuses = new Map<string, GainNode>();
  private receipt(value: StreamReceipt) {
    if (this.streamReceipts.length >= 4096) {
      this.streamReceipts.shift();
      this.streamReceiptOverflow = true;
    }
    this.streamReceipts.push(value);
  }
  drainStreamReceipts() {
    const result = this.streamReceipts.splice(0);
    if (this.streamReceiptOverflow)
      result.unshift({
        epoch: this.streamEpoch,
        id: "overflow",
        status: "dropped",
        reason: "receipt-overflow",
        overflow: true,
      });
    this.streamReceiptOverflow = false;
    return result;
  }
  async beginStream(config: StreamConfig): Promise<number> {
    this.stop();
    const epoch = this.streamEpoch;
    const copy = structuredClone({ ...config, ticker: undefined });
    const queue = new StreamQueue(epoch, copy);
    const horizon = config.lookaheadSeconds ?? LOOKAHEAD;
    if (!Number.isFinite(horizon) || horizon < 0.025 || horizon > 0.5)
      throw Error("Invalid stream horizon");
    // Serialize preparation cleanup so a cancelled epoch cannot tear down a
    // newer epoch's graph on the same AudioContext.
    await this.preparingRenderer?.catch(() => {});
    if (epoch !== this.streamEpoch) throw Error("Stream start cancelled");
    await this.enable();
    if (epoch !== this.streamEpoch) throw Error("Stream start cancelled");
    const renderer = this.voiceRenderer,
      context = this.context!;
    const preparation = (async () => {
      try {
        await renderer?.prepareContext?.(context);
        if (epoch !== this.streamEpoch) throw Error("Stream start cancelled");
      } catch (error) {
        renderer?.releaseContext?.(context);
        throw error;
      }
    })();
    this.preparingRenderer = preparation;
    try {
      await preparation;
    } finally {
      if (this.preparingRenderer === preparation) this.preparingRenderer = null;
    }
    if (epoch !== this.streamEpoch) throw Error("Stream start cancelled");
    this.streamHorizon = horizon;
    this.stream = queue;
    this.playing = true;
    this.looping = false;
    this.bpm = config.bpm;
    this.rangeStart = config.startTick ?? 0;
    this.origin = this.currentTime + Math.max(0.3, horizon + 0.05);
    for (const track of config.tracks) {
      if (this.roleBuses.has(track.role)) continue;
      const bus = this.context!.createGain();
      bus.gain.setValueAtTime(1, this.currentTime);
      bus.connect(this.musicDestination(track.role));
      this.roleBuses.set(track.role, bus);
    }
    const pumpUnsafe = () => {
      if (this.stream !== queue || !this.playing) return;
      const now = this.currentTime;
      const through =
        this.rangeStart + ((now + horizon - this.origin) * this.bpm * 480) / 60;
      if (
        !queue.ended &&
        now >
          this.origin +
            ticksToSeconds(queue.preparedThrough - this.rangeStart, this.bpm) &&
        this.lastUnderrunThrough !== queue.preparedThrough
      ) {
        this.lastUnderrunThrough = queue.preparedThrough;
        this.receipt({
          epoch,
          id: "coverage",
          status: "skipped",
          reason: "coverage-underrun",
          tick: queue.preparedThrough,
          observedAtContextTime: now,
        });
      }
      const ready = queue.take(through);
      this.pruneSubmissions();
      for (const n of ready) {
        const at =
          this.origin + ticksToSeconds(n.startTick - this.rangeStart, this.bpm);
        if (at < now) {
          this.receipt({
            epoch,
            id: n.id,
            noteId: n.id,
            status: "skipped",
            reason: "late",
            observedAtContextTime: now,
            atContextTime: at,
            tick: n.startTick,
          });
          continue;
        }
        for (const v of this.voices) if (v.end <= now) this.voices.delete(v);
        if (this.voices.size >= this.voiceLimit) {
          this.receipt({
            epoch,
            id: n.id,
            noteId: n.id,
            status: "dropped",
            reason: "capacity",
            tick: n.startTick,
          });
          continue;
        }
        const patch = copy.patches.find((p) => p.id === n.patchId)!;
        const role = copy.tracks.find((t) => t.id === n.trackId)!.role;
        const creationStarted = performance.now();
        const v = (
          this.voiceRenderer?.renderVoice.bind(this.voiceRenderer) ??
          renderPerformanceVoice
        )(
          this.context!,
          this.roleBuses.get(role) ?? this.output!,
          patch,
          n.pitch,
          n.velocity,
          at,
          ticksToSeconds(n.durationTicks, this.bpm),
          n.gain,
          n.pan,
          n.id,
        );
        v.trackId = n.trackId;
        v.optional = n.optional;
        v.noteId = n.id;
        v.releaseStart = at + ticksToSeconds(n.durationTicks, this.bpm);
        this.voices.add(v);
        this.receipt({
          epoch,
          id: n.id,
          noteId: n.id,
          status: "scheduled",
          tick: n.startTick,
          note: structuredClone(n),
          atContextTime: at,
          observedAtContextTime: now,
          nodeCreationMs: performance.now() - creationStarted,
        });
      }
      if (
        queue.ended &&
        now >= this.streamNotBeforeEnd &&
        queue.notes.length === 0 &&
        this.activeVoiceCount === 0 &&
        now >=
          this.origin +
            ticksToSeconds(queue.preparedThrough - this.rangeStart, this.bpm)
      ) {
        this.receipt({ epoch, id: "end", status: "ended", reason: "drained" });
        this.stop("drained");
      }
    };
    const pump = () => {
      try {
        pumpUnsafe();
      } catch {
        this.receipt({
          epoch,
          id: "renderer",
          status: "dropped",
          reason: "renderer-failure",
          observedAtContextTime: this.currentTime,
        });
        this.stop("renderer-failure");
      }
    };
    const factory =
      config.ticker ??
      ((cb: () => void, ms: number) => {
        const timer = setInterval(cb, ms);
        return () => clearInterval(timer);
      });
    try {
      this.streamTicker = factory(pump, 25);
      pump();
    } catch (error) {
      this.stop("ticker-failure");
      throw error;
    }
    return epoch;
  }
  submitStreamWindow(window: StreamWindow): StreamReceipt {
    const q = this.stream;
    if (!q)
      return {
        epoch: this.streamEpoch,
        id: window.id,
        status: "rejected",
        reason: "no-stream",
      };
    const signature = JSON.stringify(window);
    const prior = this.streamSubmissions.get(window.id);
    if (prior)
      return prior.signature === signature
        ? { ...prior.receipt, reason: "duplicate" }
        : {
            epoch: q.epoch,
            id: window.id,
            status: "rejected",
            reason: "duplicate-window-id",
          };
    if (this.streamSignatureBytes + signature.length * 2 > 4 * 1024 * 1024) {
      const r: StreamReceipt = {
        epoch: q.epoch,
        id: window.id,
        status: "rejected",
        reason: "identity-memory-limit",
      };
      this.receipt(r);
      return r;
    }
    if (
      this.origin +
        ticksToSeconds(window.startTick - this.rangeStart, this.bpm) <
      this.currentTime + this.streamHorizon
    ) {
      const rejected: StreamReceipt = {
        epoch: q.epoch,
        id: window.id,
        status: "rejected",
        reason: "deadline",
      };
      this.receipt(rejected);
      return rejected;
    }
    // Validate on an isolated copy first: failures never partially replace coverage.
    const probe = q.fork();
    const validation = probe.submit(window);
    if (validation.status === "rejected") {
      this.receipt(validation);
      return validation;
    }
    const retained = q.notes.filter((n) => n.startTick < window.startTick);
    const interval = (n: (typeof window.notes)[number]): [number, number] => {
      const at =
        this.origin + ticksToSeconds(n.startTick - this.rangeStart, this.bpm);
      const patch = q.config.patches.find((p) => p.id === n.patchId)!;
      return [
        Math.max(this.currentTime, at - this.streamHorizon),
        at + ticksToSeconds(n.durationTicks, this.bpm) + this.releaseFor(patch),
      ];
    };
    // Coordinate compression sorts once; optional admission only updates covered segments.
    const existing: [number, number][] = [...this.voices]
      .filter((v) => v.end > this.currentTime)
      .map((v) => [this.currentTime, v.end]);
    const budget = new VoiceBudget([
      ...existing,
      ...retained.map(interval),
      ...window.notes.map(interval),
    ]);
    for (const span of [...existing, ...retained.map(interval)])
      budget.add(span);
    const selected = window.notes.filter((n) => !n.optional);
    for (const n of selected) budget.add(interval(n));
    if (budget.peak > this.voiceLimit) {
      const receipt: StreamReceipt = {
        epoch: q.epoch,
        id: window.id,
        status: "rejected",
        reason: "mandatory-capacity",
      };
      this.receipt(receipt);
      return receipt;
    }
    const dropped = window.notes
      .filter((n) => n.optional)
      .sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1))
      .filter((n) => {
        if (budget.fits(interval(n), this.voiceLimit)) {
          budget.add(interval(n));
          selected.push(n);
          return false;
        }
        return true;
      });
    if (
      this.origin +
        ticksToSeconds(window.startTick - this.rangeStart, this.bpm) <
      this.currentTime + this.streamHorizon
    ) {
      const receipt: StreamReceipt = {
        epoch: q.epoch,
        id: window.id,
        status: "rejected",
        reason: "deadline",
      };
      this.receipt(receipt);
      return receipt;
    }
    const receipt = q.submit({ ...window, notes: selected });
    this.receipt(receipt);
    if (receipt.status === "accepted") {
      this.streamSubmissions.set(window.id, {
        signature,
        receipt: structuredClone(receipt),
        endTick: window.endTick,
      });
      this.streamSignatureBytes += signature.length * 2;
    }
    if (receipt.status === "accepted" && receipt.reason !== "duplicate")
      for (const n of dropped)
        this.receipt({
          epoch: q.epoch,
          id: window.id,
          noteId: n.id,
          status: "dropped",
          reason: "optional-capacity",
          tick: n.startTick,
        });
    return receipt;
  }
  /** Bounded UI/event overlay, rendered through the same role bus and global budget.
   * Does not alter harmonic checkpoints or prepared coverage. */
  submitStreamOverlay(
    notes: StreamWindow["notes"],
    reason = "overlay",
  ): boolean {
    const q = this.stream;
    if (!q || q.ended || !notes.length || notes.length > 4) return false;
    const now = this.currentTime;
    if (
      notes.some(
        (n) =>
          !Number.isSafeInteger(n.startTick) || n.startTick < this.rangeStart,
      )
    )
      return false;
    const startTick = Math.min(...notes.map((n) => n.startTick));
    const endTick = Math.max(...notes.map((n) => n.startTick)) + 1;
    const probe = new StreamQueue(q.epoch, { ...q.config, startTick });
    if (
      probe.submit({
        epoch: q.epoch,
        revision: 0,
        id: "overlay",
        startTick,
        endTick,
        notes,
      }).status !== "accepted"
    )
      return false;
    if (
      notes.some(
        (n) =>
          q.notes.some((p) => p.id === n.id) ||
          [...this.voices].some((v) => v.noteId === n.id),
      )
    )
      return false;
    const times = notes.map((n) => {
      const at =
        this.origin + ticksToSeconds(n.startTick - this.rangeStart, this.bpm);
      const patch = q.config.patches.find((p) => p.id === n.patchId)!;
      return {
        n,
        at,
        patch,
        end:
          at +
          ticksToSeconds(n.durationTicks, this.bpm) +
          this.releaseFor(patch),
      };
    });
    if (times.some((t) => t.at < now || t.at > now + this.streamHorizon))
      return false;
    const end = Math.max(...times.map((t) => t.end));
    if (
      this.activeVoiceCount + this.reservedVoiceSlots(end) + notes.length >
      this.voiceLimit
    )
      return false;
    for (const { n, at, patch } of times) {
      const role = q.config.tracks.find((t) => t.id === n.trackId)!.role;
      const voice = (
        this.voiceRenderer?.renderVoice.bind(this.voiceRenderer) ??
        renderPerformanceVoice
      )(
        this.context!,
        this.roleBuses.get(role)!,
        patch,
        n.pitch,
        n.velocity,
        at,
        ticksToSeconds(n.durationTicks, this.bpm),
        n.gain,
        n.pan,
        n.id,
      );
      Object.assign(voice, {
        trackId: n.trackId,
        noteId: n.id,
        optional: true,
        releaseStart: at + ticksToSeconds(n.durationTicks, this.bpm),
      });
      this.voices.add(voice);
      this.receipt({
        epoch: q.epoch,
        id: n.id,
        noteId: n.id,
        status: "scheduled",
        reason,
        tick: n.startTick,
        note: structuredClone(n),
        atContextTime: at,
        observedAtContextTime: now,
      });
    }
    return true;
  }
  /** Audition an already rendered take on this owner; no second AudioContext. */
  async auditionBuffer(buffer: AudioBuffer) {
    if (
      buffer.duration <= 0 ||
      buffer.duration > 610 ||
      buffer.length > 32_000_000 ||
      buffer.numberOfChannels > 2
    )
      throw new Error("Invalid audition buffer");
    this.stop("audition");
    const epoch = this.streamEpoch;
    await this.enable();
    if (epoch !== this.streamEpoch) return;
    const source = this.context!.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output!);
    const voice = {
      end: this.currentTime + buffer.duration,
      stop: () => {
        source.stop();
        source.disconnect();
      },
    };
    this.voices.add(voice);
    this.playing = true;
    source.onended = () => {
      source.disconnect();
      this.voices.delete(voice);
      if (this.streamEpoch === epoch) this.stop("drained");
    };
    source.start(this.currentTime);
  }
  /** Explicit emergency policy: retire an optional tail, never an attack or mandatory cue.
   * Its node slot remains occupied until the fade completes; callers must retry later. */
  retireOptionalTail(): boolean {
    if (!this.stream) return false;
    const now = this.currentTime;
    const victim = [...this.voices]
      .filter(
        (v) =>
          v.optional &&
          !v.retiring &&
          v.releaseStart !== undefined &&
          v.releaseStart <= now &&
          v.end > now &&
          v.fadeStop,
      )
      .sort(
        (a, b) =>
          a.releaseStart! - b.releaseStart! || (a.noteId! < b.noteId! ? -1 : 1),
      )[0];
    if (!victim) return false;
    const fade = Math.min(0.01, victim.end - now);
    victim.fadeStop!(now, fade);
    victim.retiring = true;
    victim.end = now + fade;
    this.receipt({
      epoch: this.streamEpoch,
      id: victim.noteId!,
      noteId: victim.noteId,
      status: "stolen",
      reason: "optional-release-tail",
      atContextTime: now,
      duration: fade,
      observedAtContextTime: now,
    });
    return true;
  }
  endStream(notBeforeContextTime = this.currentTime) {
    if (!Number.isFinite(notBeforeContextTime) || notBeforeContextTime < this.currentTime || notBeforeContextTime > this.currentTime + 10) throw Error("Invalid stream tail deadline");
    this.streamNotBeforeEnd = notBeforeContextTime;
    if (this.stream) this.stream.ended = true;
  }
  readTransport() {
    const q = this.stream;
    return {
      epoch: this.streamEpoch,
      running: this.playing,
      origin: this.origin,
      bpm: this.bpm,
      startTick: this.rangeStart,
      positionTick:
        this.rangeStart +
        (Math.max(
          0,
          this.currentTime - this.origin - this.outputLatencySeconds,
        ) *
          this.bpm *
          480) /
          60,
      preparedThrough: q?.preparedThrough ?? this.rangeStart,
      audioCommittedThrough: q?.frontier ?? this.rangeStart,
      nextUncoveredOnset: q?.preparedThrough ?? this.rangeStart,
      queuedNotes: q?.notes.length ?? 0,
    };
  }
  readOutputClock() {
    const sampledAtPerformanceMs = performance.now();
    let stamp: AudioTimestamp | undefined;
    try {
      stamp = this.context?.getOutputTimestamp?.();
    } catch {
      stamp = undefined;
    }
    const valid =
      this.context?.state === "running" &&
      stamp &&
      Number.isFinite(stamp.contextTime) &&
      Number.isFinite(stamp.performanceTime) &&
      stamp.performanceTime! > 0;
    const stale =
      valid &&
      stamp !== undefined &&
      (sampledAtPerformanceMs - stamp.performanceTime! > 500 ||
        stamp.performanceTime! > sampledAtPerformanceMs + 5);
    return {
      epoch: this.streamEpoch,
      status: stale
        ? ("stale" as const)
        : valid
          ? ("valid" as const)
          : ("unavailable" as const),
      contextTime: stamp
        ? Math.max(0, (stamp.contextTime ?? 0) - this.outputLatencySeconds)
        : 0,
      performanceTime: stamp?.performanceTime ?? 0,
      sampledAtPerformanceMs,
    };
  }
  setRoleGain(
    role: import("@onepage/project").Track["role"],
    value: number,
    rampSeconds = 0.03,
    allowPreroll = false,
  ) {
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1 ||
      !Number.isFinite(rampSeconds) ||
      rampSeconds < 0 ||
      rampSeconds > 1
    )
      throw Error("Invalid role gain");

    const bus = this.roleBuses.get(role);
    if (!bus) return false;
    const now = allowPreroll
      ? Math.max(this.currentTime, this.origin)
      : this.currentTime;
    if (now < this.origin) return false;
    if (bus.gain.cancelAndHoldAtTime) bus.gain.cancelAndHoldAtTime(now);
    else {
      bus.gain.cancelScheduledValues(now);
      bus.gain.setValueAtTime(
        roleGainAt(this.roleAutomation, role, now - this.origin),
        now,
      );
    }
    bus.gain.linearRampToValueAtTime(value, now + rampSeconds);
    this.roleAutomation.push({
      id: `gain-${this.roleAutomation.length}`,
      role,
      timeSeconds: Math.max(0, now - this.origin),
      value,
      rampSeconds,
    });
    // Capture owns history. Live retargeting needs only each role's present value
    // and the unfinished part of its latest ramp, never a lifetime automation quota.
    const at = Math.max(0, now - this.origin);
    const compact: RoleGainEvent[] = [];
    for (const r of this.roleBuses.keys()) {
      const role = r as RoleGainEvent["role"];
      compact.push({
        id: `baseline-${role}`,
        role,
        timeSeconds: at,
        value: roleGainAt(this.roleAutomation, role, at),
        rampSeconds: 0,
      });
      const last = this.roleAutomation.filter((e) => e.role === role).at(-1);
      if (last && last.timeSeconds + last.rampSeconds > at)
        compact.push({
          ...last,
          timeSeconds: at,
          rampSeconds: last.timeSeconds + last.rampSeconds - at,
        });
    }
    this.roleAutomation = compact;
    this.receipt({
      epoch: this.streamEpoch,
      id: role,
      status: "gain",
      tick: this.readTransport().positionTick,
      value,
      duration: rampSeconds,
      rampSeconds,
      role,
      atContextTime: now,
    });
    return true;
  }
  protected override reservedVoiceSlots(end: number) {
    if (!this.stream) return 0;
    const now = this.currentTime;
    const spans: [number, number][] = [...this.voices]
      .filter((v) => v.end > now)
      .map((v) => [now, Math.min(end, v.end)]);
    for (const n of this.stream.notes) {
      const at =
        this.origin + ticksToSeconds(n.startTick - this.rangeStart, this.bpm);
      const start = Math.max(now, at - this.streamHorizon);
      const stop = Math.min(
        end,
        at +
          ticksToSeconds(n.durationTicks, this.bpm) +
          this.releaseFor(
            this.stream.config.patches.find((p) => p.id === n.patchId)!,
          ),
      );
      if (start < stop) spans.push([start, stop]);
    }
    const budget = new VoiceBudget(spans);
    spans.forEach((span) => budget.add(span));
    return Math.max(0, budget.peak - this.voices.size);
  }
  private pruneSubmissions() {
    for (const [id, entry] of this.streamSubmissions) {
      if (entry.endTick <= (this.stream?.frontier ?? 0)) {
        this.streamSignatureBytes -= entry.signature.length * 2;
        this.streamSubmissions.delete(id);
      }
    }
  }
  /** Explicit gap recovery on the original clock; already scheduled tails keep sounding. */
  recoverStreamAt(startTick: number): boolean {
    const q = this.stream;
    if (
      !q ||
      q.ended ||
      !Number.isSafeInteger(startTick) ||
      startTick % 1920 !== 0 ||
      startTick < q.preparedThrough ||
      this.currentTime <=
        this.origin +
          ticksToSeconds(q.preparedThrough - this.rangeStart, this.bpm) ||
      this.origin + ticksToSeconds(startTick - this.rangeStart, this.bpm) <
        this.currentTime + this.streamHorizon
    )
      return false;
    this.receipt({
      epoch: q.epoch,
      id: "recovery",
      status: "skipped",
      reason: "coverage-recovery",
      tick: q.preparedThrough,
      observedAtContextTime: this.currentTime,
    });
    q.recoverAt(startTick);
    this.pruneSubmissions();
    return true;
  }
  async suspendDevice() {
    await this.context?.suspend();
    this.stop();
  }
  override stop(reason = "interrupted") {
    const hadStream = !!this.stream;
    if (this.stream && reason !== "drained")
      this.receipt({
        epoch: this.streamEpoch,
        id: "stop",
        status: "ended",
        reason,
        observedAtContextTime: this.currentTime,
      });
    this.roleAutomation = [];
    this.streamNotBeforeEnd = 0;
    this.lastUnderrunThrough = -1;
    this.streamEpoch++;
    this.streamTicker?.();
    this.streamTicker = undefined;
    this.stream = null;
    this.streamSubmissions.clear();
    this.streamSignatureBytes = 0;
    for (const bus of this.roleBuses.values()) bus.disconnect();
    this.roleBuses.clear();
    super.stop();
    if (hadStream && this.context)
      this.voiceRenderer?.releaseContext?.(this.context);
  }
}

/** Allocated node intervals, including scheduling lookahead and release tails. */
class VoiceBudget {
  private points: number[];
  private counts: number[];
  constructor(spans: [number, number][]) {
    this.points = [...new Set(spans.flat())].sort((a, b) => a - b);
    this.counts = this.points.map(() => 0);
  }
  get peak() {
    return Math.max(0, ...this.counts);
  }
  fits([start, end]: [number, number], limit: number) {
    return this.points.every(
      (at, i) => at < start || at >= end || this.counts[i]! < limit,
    );
  }
  add([start, end]: [number, number]) {
    this.points.forEach((at, i) => {
      if (at >= start && at < end) this.counts[i]!++;
    });
  }
}
