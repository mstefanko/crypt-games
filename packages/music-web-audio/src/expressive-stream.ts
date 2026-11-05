import {
  serializePerformanceTakeV3,
  createTempoMap,
  type CompiledExpressiveNote,
  type ExpressiveControlEvent,
  type ExpressiveWindow,
  type PerformanceTakeV3,
} from "@onepage/music-core/expressive-performance";

import {
  rebaseExpressiveCapture,
  restorePartBaseline,
} from "./expressive-capture";

export interface ExpressiveReceipt {
  epoch: number;
  status: "accepted" | "rejected" | "scheduled" | "controls" | "stopped";
  reason?: string;
  noteId?: string;
  controls?: ExpressiveControlEvent[];
  timeSeconds?: number;
}
export interface ExpressiveStreamLimits {
  maxVoices?: number;
  maxPendingNotes?: number;
  maxWindowControls?: number;
  maxHorizonSeconds?: number;
  validateTake?: (take: PerformanceTakeV3) => void;
  rollingCaptureSeconds?: number;
  releaseSeconds?: (note: CompiledExpressiveNote) => number;
}
export type ExpressiveTimelineRevision = Pick<PerformanceTakeV3, "tempoMap" | "meterMap" | "lengthTicks" | "instruments">;
/** Pure admission and commitment. A committed onset owns its release and note-local curves. */
export class ExpressiveStreamQueue {
  notes: CompiledExpressiveNote[] = [];
  controls: ExpressiveControlEvent[] = [];
  frontierSeconds: number;
  preparedThroughSeconds: number;
  revision = -1;
  ended = false;
  private committedNotes: CompiledExpressiveNote[] = [];
  private committedControls: ExpressiveControlEvent[] = [];
  private windows = new Map<string, string>();
  private closed = false;
  private captureOriginTick = 0;
  private captureFaithfulFromAbsoluteSeconds = 0;
  private windowBytes = 0;
  readonly template: PerformanceTakeV3;
  constructor(
    readonly epoch: number,
    template: PerformanceTakeV3,
    readonly limits: ExpressiveStreamLimits = {},
    startSeconds = 0,
  ) {
    serializePerformanceTakeV3(template);
    this.template = structuredClone(template);
    if (
      !Number.isFinite(startSeconds) ||
      startSeconds < 0 ||
      (!limits.rollingCaptureSeconds &&
        startSeconds >= template.durationSeconds)
    )
      throw Error("Invalid expressive stream start");
    if (!Number.isInteger(epoch) || epoch < 1)
      throw Error("Invalid expressive epoch");
    for (const [value, max] of [
      [limits.maxVoices ?? 256, 256],
      [limits.maxPendingNotes ?? 1024, 8192],
      [limits.maxWindowControls ?? 512, 65536],
    ] as const)
      if (!Number.isInteger(value) || value < 1 || value > max)
        throw Error("Invalid expressive stream budget");
    if (
      !Number.isFinite(limits.maxHorizonSeconds ?? 30) ||
      (limits.maxHorizonSeconds ?? 30) < 0.1 ||
      (limits.maxHorizonSeconds ?? 30) > 600
    )
      throw Error("Invalid expressive horizon");
    if (
      limits.rollingCaptureSeconds !== undefined &&
      (!Number.isFinite(limits.rollingCaptureSeconds) ||
        limits.rollingCaptureSeconds < 30 ||
        limits.rollingCaptureSeconds > 300)
    )
      throw Error("Invalid rolling capture profile");
    if (limits.rollingCaptureSeconds && startSeconds > 0)
      this.captureOriginTick = Math.floor(this.tickAtSeconds(startSeconds));
    this.frontierSeconds = this.preparedThroughSeconds = startSeconds;
  }
  private reject(reason: string): ExpressiveReceipt {
    return { epoch: this.epoch, status: "rejected", reason };
  }
  /** Replace future maps and events as one transaction. Already committed timing is immutable. */
  submitTimelineWindow(window: ExpressiveWindow, timeline: ExpressiveTimelineRevision): ExpressiveReceipt {
    const previous = {
      tempoMap: this.template.tempoMap, meterMap: this.template.meterMap,
      lengthTicks: this.template.lengthTicks, durationSeconds: this.template.durationSeconds,
      instruments: this.template.instruments,
    };
    try {
      if (this.windows.has(`${window.revision}:${window.startSeconds}:${window.endSeconds}`) &&
        JSON.stringify(timeline) !== JSON.stringify({tempoMap: previous.tempoMap, meterMap: previous.meterMap, lengthTicks: previous.lengthTicks, instruments: previous.instruments}))
        return this.reject("conflicting-timeline-window");
      const nextClock = createTempoMap(this.template.ppq, timeline.tempoMap);
      const oldClock = createTempoMap(this.template.ppq, this.template.tempoMap);
      const protectedTicks = new Set([0, this.tickAtSeconds(this.frontierSeconds), ...this.template.tempoMap.map(p => p.tick), ...timeline.tempoMap.map(p => p.tick)]);
      for (const tick of protectedTicks) {
        if (oldClock.tickToSeconds(tick) <= this.frontierSeconds &&
          Math.abs(nextClock.tickToSeconds(tick) - oldClock.tickToSeconds(tick)) > 1e-7)
          return this.reject("timeline-retimes-committed-prefix");
      }
      for (const note of this.committedNotes)
        if ([ [note.startTick, note.startSeconds], [note.keyReleaseTick, note.keyReleaseSeconds], [note.endTick, note.endSeconds] ].some(([tick, seconds]) => Math.abs(nextClock.tickToSeconds(tick) - seconds) > 1e-7))
          return this.reject("timeline-retimes-owned-note");
      const oldMeter = this.template.meterMap.filter(m => oldClock.tickToSeconds(m.tick) < this.frontierSeconds);
      const newMeter = timeline.meterMap.filter(m => nextClock.tickToSeconds(m.tick) < this.frontierSeconds);
      if (JSON.stringify(oldMeter) !== JSON.stringify(newMeter)) return this.reject("timeline-changes-committed-meter");
      const oldInstruments = this.template.instruments.filter(i => oldClock.tickToSeconds(i.tick) < this.frontierSeconds);
      const newInstruments = timeline.instruments.filter(i => nextClock.tickToSeconds(i.tick) < this.frontierSeconds);
      if (JSON.stringify(oldInstruments) !== JSON.stringify(newInstruments)) return this.reject("timeline-changes-committed-instrument");
      Object.assign(this.template, structuredClone(timeline), {durationSeconds: nextClock.tickToSeconds(timeline.lengthTicks)});
      const receipt = this.submit(window);
      if (receipt.status !== "accepted") Object.assign(this.template, previous);
      return receipt;
    } catch (error) {
      Object.assign(this.template, previous);
      return this.reject(error instanceof Error ? error.message : "invalid-timeline");
    }
  }
  get protectedThroughSeconds() {
    return Math.max(this.frontierSeconds, ...this.committedNotes.map(n => n.endSeconds));
  }
  submit(window: ExpressiveWindow): ExpressiveReceipt {
    if (this.closed || this.ended || window.epoch !== this.epoch)
      return this.reject("stale-or-stopped");
    if (
      !Array.isArray(window.notes) ||
      !Array.isArray(window.controls) ||
      window.notes.some((n) => !n || typeof n !== "object") ||
      window.controls.some((c) => !c || typeof c !== "object")
    )
      return this.reject("invalid-window-events");
    const { startSeconds: start, endSeconds: end } = window;
    const key = `${window.revision}:${start}:${end}`,
      signature = JSON.stringify(window);
    if (this.windows.has(key))
      return this.windows.get(key) === signature
        ? { epoch: this.epoch, status: "accepted", reason: "duplicate" }
        : this.reject("conflicting-window");
    if (
      !Number.isSafeInteger(window.revision) ||
      window.revision < this.revision ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start ||
      start < this.frontierSeconds ||
      start > this.preparedThroughSeconds + 1e-8 ||
      (!this.limits.rollingCaptureSeconds &&
        end > this.template.durationSeconds) ||
      end - this.frontierSeconds > (this.limits.maxHorizonSeconds ?? 30) ||
      window.notes.length > (this.limits.maxPendingNotes ?? 1024) ||
      window.controls.length > (this.limits.maxWindowControls ?? 512)
    )
      return this.reject("invalid-window-or-frontier");
    if (start < this.preparedThroughSeconds && window.revision <= this.revision)
      return this.reject("replacement-needs-new-revision");
    const retainedNotes = this.notes.filter((n) => n.startSeconds < start);
    const committedIds = new Set(this.committedNotes.map((n) => n.id));
    const replacedIds = new Set(
      this.notes.filter((n) => n.startSeconds >= start).map((n) => n.id),
    );
    const retainedControls = this.controls.filter((c) =>
      c.noteId ? !replacedIds.has(c.noteId) : c.timeSeconds < start,
    );
    if (
      window.notes.some(
        (n) =>
          n.startSeconds < start ||
          n.startSeconds >= end ||
          committedIds.has(n.id),
      )
    )
      return this.reject("onset-outside-window-or-committed");
    if (
      this.limits.rollingCaptureSeconds &&
      window.notes.some(
        (n) =>
          n.endSeconds - n.startSeconds > this.limits.rollingCaptureSeconds!,
      )
    )
      return this.reject("rolling-hold-budget");
    const incomingIds = new Set(window.notes.map((n) => n.id));
    // Rolling capture restores part baselines; note-local curves are onset-owned and may not require hidden pre-onset state.
    if (
      this.limits.rollingCaptureSeconds &&
      window.controls.some(
        (c) =>
          c.noteId !== undefined &&
          c.timeSeconds <
            (window.notes.find((n) => n.id === c.noteId)?.startSeconds ??
              Infinity),
      )
    )
      return this.reject("rolling-note-control-precedes-onset");
    if (
      window.controls.some((c) =>
        c.noteId
          ? !incomingIds.has(c.noteId)
          : c.timeSeconds < start || c.timeSeconds >= end,
      )
    )
      return this.reject("control-outside-window-or-onset-owned");
    const notes = [...this.committedNotes, ...retainedNotes, ...window.notes];
    const controls = [
      ...this.committedControls,
      ...retainedControls,
      ...window.controls,
    ];
    if (
      retainedNotes.length + window.notes.length >
        (this.limits.maxPendingNotes ?? 1024) ||
      controls.length > 65536 ||
      notes.length > 8192 ||
      this.windows.size >= 4096 ||
      this.windowBytes + signature.length * 2 > 4 * 1024 * 1024
    )
      return this.reject("event-or-capture-budget");
    try {
      const candidate = this.validationTake(notes, controls, end);
      serializePerformanceTakeV3(candidate);
      this.limits.validateTake?.(candidate);
      this.validateVoices(notes);
      this.validateDensity(controls);
    } catch (error) {
      return this.reject(
        error instanceof Error ? error.message : "invalid-events",
      );
    }
    // Mutation begins only after every note, control, binding and occupancy check passes.
    this.notes = [...retainedNotes, ...structuredClone(window.notes)].sort(
      (a, b) => a.startSeconds - b.startSeconds || a.id.localeCompare(b.id),
    );
    this.controls = [
      ...retainedControls,
      ...structuredClone(window.controls),
    ].sort(controlOrder);
    this.preparedThroughSeconds = end;
    this.revision = window.revision;
    this.windows.set(key, signature);
    this.windowBytes += signature.length * 2;
    return { epoch: this.epoch, status: "accepted" };
  }
  private validateVoices(notes: CompiledExpressiveNote[]) {
    let ends: number[] = [];
    for (const n of [...notes].sort(
      (a, b) => a.startSeconds - b.startSeconds,
    )) {
      ends = ends.filter((end) => end > n.startSeconds);
      if (ends.length >= (this.limits.maxVoices ?? 256))
        throw Error("voice-budget");
      const tail = this.limits.releaseSeconds?.(n) ?? 0.1;
      if (!Number.isFinite(tail) || tail < 0 || tail > 10)
        throw Error("invalid-release");
      ends.push(n.endSeconds + tail);
    }
  }
  private validateDensity(controls: ExpressiveControlEvent[]) {
    const ordered = [...controls].sort(controlOrder);
    let first = 0;
    for (let last = 0; last < ordered.length; last++) {
      while (ordered[last].timeSeconds - ordered[first].timeSeconds >= 0.1)
        first++;
      if (last - first + 1 > 256) throw Error("control-density-budget");
    }
  }
  /** Immediate controls use the same validator; pending controls on the same lane are superseded. */
  addControls(
    epoch: number,
    events: ExpressiveControlEvent[],
  ): ExpressiveReceipt {
    if (this.closed || epoch !== this.epoch)
      return this.reject("stale-or-stopped");
    if (
      events.length > (this.limits.maxWindowControls ?? 512) ||
      events.some((c) => c.noteId || c.timeSeconds < this.frontierSeconds)
    )
      return this.reject("invalid-immediate-controls");
    const lanes = new Map(
      events.map((c) => [`${c.partId}:${c.parameter}`, c.timeSeconds]),
    );
    const retained = this.controls.filter(
      (c) =>
        c.noteId ||
        c.timeSeconds < (lanes.get(`${c.partId}:${c.parameter}`) ?? Infinity),
    );
    try {
      const all = [...this.committedControls, ...retained, ...events];
      const candidate = this.validationTake(
        [...this.committedNotes, ...this.notes],
        all,
        this.preparedThroughSeconds,
      );
      serializePerformanceTakeV3(candidate);
      this.limits.validateTake?.(candidate);
      this.validateDensity(all);
    } catch (error) {
      return this.reject(
        error instanceof Error ? error.message : "invalid-controls",
      );
    }
    this.controls = [...retained, ...structuredClone(events)].sort(
      controlOrder,
    );
    return {
      epoch: this.epoch,
      status: "accepted",
      controls: structuredClone(events),
    };
  }
  take(throughSeconds: number): {
    notes: CompiledExpressiveNote[];
    controls: ExpressiveControlEvent[];
  } {
    if (this.closed) return { notes: [], controls: [] };
    if (
      !Number.isFinite(throughSeconds) ||
      throughSeconds < this.frontierSeconds
    )
      return { notes: [], controls: [] };
    const notes = this.notes.filter((n) => n.startSeconds < throughSeconds);
    const ids = new Set(notes.map((n) => n.id));
    // All authored curves commit with onset, even when their points are beyond this window.
    const controls = this.controls.filter((c) =>
      c.noteId ? ids.has(c.noteId) : c.timeSeconds < throughSeconds,
    );
    this.notes = this.notes.filter((n) => n.startSeconds >= throughSeconds);
    const controlIds = new Set(controls.map((c) => c.id));
    this.controls = this.controls.filter((c) => !controlIds.has(c.id));
    this.committedNotes.push(...notes);
    this.committedControls.push(...controls);
    this.frontierSeconds = throughSeconds;
    this.pruneCapture();
    return structuredClone({ notes, controls });
  }
  private validationTake(
    notes: CompiledExpressiveNote[],
    controls: ExpressiveControlEvent[],
    endSeconds: number,
  ): PerformanceTakeV3 {
    const take = { ...this.template, notes, controls };
    if (!this.limits.rollingCaptureSeconds) return take;
    const endTick = Math.max(
      this.captureOriginTick + 1,
      this.template.lengthTicks,
      Math.ceil(
        this.tickAtSeconds(
          Math.max(
            endSeconds,
            ...controls.map((c) => c.timeSeconds + c.rampSeconds),
          ),
        ),
      ),
      ...notes.map((n) => n.endTick),
    );
    return rebaseExpressiveCapture(
      take,
      this.captureOriginTick,
      endTick,
      this.captureFaithfulFromAbsoluteSeconds,
    );
  }
  private pruneCapture() {
    const seconds = this.limits.rollingCaptureSeconds;
    if (!seconds) return;
    const desired = this.frontierSeconds - seconds;
    if (desired <= 0) return;
    const retained = this.committedNotes.filter(
      (n) => n.endSeconds + (this.limits.releaseSeconds?.(n) ?? 0.1) >= desired,
    );
    const originTick = Math.floor(
        this.tickAtSeconds(
          Math.min(desired, ...retained.map((n) => n.startSeconds)),
        ),
      ),
      origin = createTempoMap(
        this.template.ppq,
        this.template.tempoMap,
      ).tickToSeconds(originTick);
    if (originTick <= this.captureOriginTick) return;
    const timeline = this.getCommittedTimeline();
    restorePartBaseline(timeline, origin);
    this.template.parts = timeline.parts;
    this.committedNotes = this.committedNotes.filter(
      (n) => n.startSeconds >= origin || retained.some((r) => r.id === n.id),
    );
    const ids = new Set(this.committedNotes.map((n) => n.id));
    this.captureFaithfulFromAbsoluteSeconds = desired;
    const lastPast = new Map(
      [...this.committedControls]
        .sort(controlOrder)
        .filter((c) => !c.noteId && c.timeSeconds < origin)
        .map((c) => [`${c.partId}:${c.parameter}`, c.id]),
    );
    this.committedControls = this.committedControls
      .filter((c) =>
        c.noteId
          ? ids.has(c.noteId)
          : c.timeSeconds >= origin ||
            (lastPast.get(`${c.partId}:${c.parameter}`) === c.id &&
              c.timeSeconds + c.rampSeconds > origin),
      )
      .map((c) =>
        !c.noteId && c.timeSeconds < origin
          ? {
              ...c,
              timeSeconds: origin,
              rampSeconds: c.timeSeconds + c.rampSeconds - origin,
            }
          : c,
      );
    this.template.deviations = this.template.deviations.filter(
      (d) => d.timeSeconds >= origin,
    );
    this.captureOriginTick = originTick;
    for (const [key, signature] of this.windows) {
      const end = Number(key.split(":")[2]);
      if (end < origin) {
        this.windows.delete(key);
        this.windowBytes -= signature.length * 2;
      }
    }
  }
  getCommittedTimeline(): PerformanceTakeV3 {
    return structuredClone({
      ...this.template,
      notes: this.committedNotes,
      controls: [...this.committedControls].sort(controlOrder),
    });
  }
  getCapturedTake(): PerformanceTakeV3 {
    return structuredClone(
      this.validationTake(
        this.committedNotes,
        [...this.committedControls].sort(controlOrder),
        Math.max(this.frontierSeconds, this.preparedThroughSeconds),
      ),
    );
  }
  get captureOriginSeconds() {
    return createTempoMap(
      this.template.ppq,
      this.template.tempoMap,
    ).tickToSeconds(this.captureOriginTick);
  }
  private tickAtSeconds(seconds: number) {
    const clock = createTempoMap(this.template.ppq, this.template.tempoMap);
    // Live absolute clocks can exceed the finite 600-second export domain.
    // Find the active segment directly, including when pruning across old maps.
    const point = [...this.template.tempoMap].reverse().find(p => clock.tickToSeconds(p.tick) <= seconds)!;
    return point.tick + ((seconds - clock.tickToSeconds(point.tick)) * this.template.ppq * 1e6) / point.microsecondsPerBeat;
  }
  get capturedNoteCount() {
    return this.committedNotes.length;
  }
  stop() {
    this.closed = true;
    this.notes = [];
    this.controls = [];
  }
}
export function controlOrder(
  a: ExpressiveControlEvent,
  b: ExpressiveControlEvent,
) {
  return (
    a.timeSeconds - b.timeSeconds ||
    (a.order ?? 0) - (b.order ?? 0) ||
    a.id.localeCompare(b.id)
  );
}
