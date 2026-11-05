/** Bounded production CPU submission evidence. No hardware acceptance inference. */
export const WORKLOAD_WARMUP_MS = 10_000;
export const WORKLOAD_MEASURE_MS = 60_000;
const MAX_FRAMES = 36_000,
  MAX_FAILURES = 32,
  MAX_LONG_TASKS = 512;
export interface WorkloadCounts {
  actors: number;
  projectiles: number;
  visibleActors: number;
  visibleProjectiles: number;
}
export interface WorkloadFrame extends WorkloadCounts {
  at: number;
  workMs: number;
  steps: number;
  tick: number;
  totalSteps: number;
  resets: number;
  paused: boolean;
  debtPauses: number;
}
export class WorkloadCapture {
  readonly frames: WorkloadFrame[] = [];
  readonly failures: string[] = [];
  readonly pauseEvents: { at: number; reason: string }[] = [];
  readonly longTasks: { at: number; duration: number }[] = [];
  readonly resets: {
    at: number;
    milliseconds: number;
    fromTick: number;
    toTick: number;
  }[] = [];
  private lastAt?: number;
  private firstMeasured?: WorkloadFrame;
  private lastMeasured?: WorkloadFrame;
  private tickCount = 0;
  private measuredTicks = 0;
  private phase: "warmup" | "measuring" | "complete" = "warmup";
  private min = {
    actors: Infinity,
    projectiles: Infinity,
    visibleActors: Infinity,
    visibleProjectiles: Infinity,
  };
  private max = {
    actors: 0,
    projectiles: 0,
    visibleActors: 0,
    visibleProjectiles: 0,
  };
  private droppedFrames = 0;
  private maximumGapMs = 0;
  private overflow = false;
  private previousTotalSteps?: number;
  private firstFrameAt?: number;
  private maximumWarmupGapMs = 0;
  constructor(
    readonly startedAt: number,
    readonly metadata: Record<string, unknown>,
    readonly longTasksSupported: boolean,
  ) {}
  get complete() {
    return this.phase === "complete";
  }
  get measuring() {
    return this.phase === "measuring";
  }
  beginFrame(at: number) {
    if (!this.complete && at - this.startedAt >= WORKLOAD_WARMUP_MS)
      this.phase = "measuring";
  }
  invalidate(reason: string) {
    if (!this.failures.includes(reason) && this.failures.length < MAX_FAILURES)
      this.failures.push(reason);
  }
  pause(at: number, reason: string) {
    if (this.complete) return;
    this.invalidate(reason);
    if (this.pauseEvents.length < MAX_FAILURES)
      this.pauseEvents.push({ at, reason });
  }
  tick(counts: WorkloadCounts) {
    if (this.complete) return;
    this.tickCount++;
    if (this.measuring) this.measuredTicks++;
    this.checkCounts(counts);
  }
  private checkCounts(counts: WorkloadCounts) {
    for (const key of Object.keys(this.min) as (keyof WorkloadCounts)[]) {
      this.min[key] = Math.min(this.min[key], counts[key]);
      this.max[key] = Math.max(this.max[key], counts[key]);
    }
    if (
      counts.actors !== 40 ||
      counts.projectiles !== 20 ||
      counts.visibleActors !== 40 ||
      counts.visibleProjectiles !== 20
    )
      this.invalidate(
        "Workload lost the required live/visible 40 actors and 20 projectiles.",
      );
  }
  reset(at: number, milliseconds: number, fromTick: number, toTick: number) {
    if (this.complete) return;
    if (this.resets.length >= 128)
      this.invalidate("Reset evidence capacity exceeded.");
    else this.resets.push({ at, milliseconds, fromTick, toTick });
  }
  longTask(at: number, duration: number) {
    if (this.complete || at < this.startedAt + WORKLOAD_WARMUP_MS) return;
    if (this.longTasks.length >= MAX_LONG_TASKS)
      this.invalidate("Long-task evidence capacity exceeded.");
    else this.longTasks.push({ at, duration });
  }
  frame(sample: WorkloadFrame) {
    if (this.complete) return;
    if (
      !Number.isFinite(sample.workMs) ||
      sample.workMs < 0 ||
      !Number.isSafeInteger(sample.totalSteps) ||
      !Number.isSafeInteger(sample.steps) ||
      sample.steps < 0 ||
      sample.steps > 5
    )
      this.invalidate("Invalid bounded frame/tick sample.");
    if (
      this.previousTotalSteps !== undefined &&
      sample.totalSteps - this.previousTotalSteps !== sample.steps
    )
      this.invalidate(
        "Total advancing steps are not monotonic or disagree with per-frame advances.",
      );
    this.previousTotalSteps = sample.totalSteps;
    this.firstFrameAt ??= sample.at;
    if (!this.measuring)
      this.maximumWarmupGapMs = Math.max(
        this.maximumWarmupGapMs,
        sample.at - (this.lastAt ?? this.startedAt),
      );
    this.checkCounts(sample);
    if (sample.paused) this.invalidate("Workload paused during capture.");
    if (sample.debtPauses)
      this.invalidate("Scheduler debt pause occurred during capture.");
    if (this.measuring) {
      if (this.lastAt !== undefined) {
        const gap = sample.at - this.lastAt;
        this.maximumGapMs = Math.max(this.maximumGapMs, gap);
        // Fixed 60 Hz reference; report RAF cadence separately from CPU submission.
        this.droppedFrames += Math.max(0, Math.round(gap / (1000 / 60)) - 1);
      }
      this.firstMeasured ??= sample;
      this.lastMeasured = sample;
      if (this.frames.length >= MAX_FRAMES) {
        this.overflow = true;
        this.invalidate("Frame evidence capacity exceeded.");
      } else this.frames.push({ ...sample });
      if (
        sample.at - this.startedAt >=
        WORKLOAD_WARMUP_MS + WORKLOAD_MEASURE_MS
      ) {
        this.phase = "complete";
        if (
          this.tickCount - this.measuredTicks < 595 ||
          this.firstFrameAt === undefined ||
          this.firstFrameAt > this.startedAt + 250 ||
          this.maximumWarmupGapMs > 100
        )
          this.invalidate(
            "Incomplete active warmup: require 595 advancing warmup ticks, prompt first RAF and bounded warmup RAF gaps.",
          );
        if (
          this.measuredTicks < 3595 ||
          this.frames.length < 600 ||
          this.maximumGapMs > 100 ||
          !this.firstMeasured ||
          this.firstMeasured.at > this.startedAt + WORKLOAD_WARMUP_MS + 250 ||
          sample.totalSteps <= this.firstMeasured.totalSteps
        )
          this.invalidate(
            "Incomplete active measurement span: require sustained advancing 60 Hz ticks, bounded RAF gaps and the full measurement interval.",
          );
        if (
          this.frames.reduce((sum, frame) => sum + frame.steps, 0) !==
          this.measuredTicks
        )
          this.invalidate(
            "Measured tick instrumentation disagrees with recorded RAF advances.",
          );
      }
    }
    this.lastAt = sample.at;
  }
  report() {
    const values = this.frames
      .map((frame) => frame.workMs)
      .sort((a, b) => a - b);
    const p50ms = values.length
      ? values[Math.ceil(values.length * 0.5) - 1]
      : null;
    const p95ms = values.length
      ? values[Math.ceil(values.length * 0.95) - 1]
      : null;
    const duration = this.lastMeasured
      ? this.lastMeasured.at - (this.startedAt + WORKLOAD_WARMUP_MS)
      : 0;
    const valid =
      this.complete &&
      !this.failures.length &&
      !this.overflow &&
      this.measuredTicks > 0 &&
      duration >= WORKLOAD_MEASURE_MS;
    return {
      format: "m6-production-phone-workload-v1",
      workload: "arena-40-20",
      metadata: this.metadata,
      status: this.phase,
      complete: this.complete,
      valid,
      acceptance:
        "Recorded workload evidence only. Observer classification/notes do not establish physical-device acceptance; verify actual hardware and the complete release protocol separately.",
      protocol: {
        warmupMs: WORKLOAD_WARMUP_MS,
        measuredMs: WORKLOAD_MEASURE_MS,
        minimumWarmupTicks: 595,
        maximumWarmupRAFGapMs: 100,
        firstFrameToleranceMs: 250,
        minimumMeasuredTicks: 3595,
        minimumRAFFrames: 600,
        maximumRAFGapMs: 100,
        measurementStartToleranceMs: 250,
        timed:
          "Per RAF: production input polling through scheduler updates and render submission, including exact fixture resets and per-tick count instrumentation. Excludes report serialization, percentile calculation and GPU completion.",
        fixture:
          "Validated fixed visible arena derived from the existing benchmark: moving AI, real fire-created swept projectiles, no walls/hits. The twenty shots start closely together and fan through the upper band; visible counts mean submitted in-frustum bodies, not guaranteed disjoint marks. Exact fixture reset every 1000 advances prevents projectile expiry; resets and their CPU cost are retained and included, never hidden from the frame timer.",
        RAFDrops:
          "Estimated against 60 Hz from RAF gaps; not hardware presentation/dropped GPU frame telemetry.",
      },
      startedAt: this.startedAt,
      measuredDurationMs: duration,
      tickCount: this.tickCount,
      warmupTicks: this.tickCount - this.measuredTicks,
      firstFrameAt: this.firstFrameAt ?? null,
      maximumWarmupGapMs: this.maximumWarmupGapMs,
      measuredTicks: this.measuredTicks,
      startTick: this.firstMeasured?.tick ?? null,
      endTick: this.lastMeasured?.tick ?? null,
      startTotalSteps: this.firstMeasured?.totalSteps ?? null,
      endTotalSteps: this.lastMeasured?.totalSteps ?? null,
      worldTickResets: this.resets,
      counts: { min: this.tickCount ? this.min : null, max: this.max },
      cpuUpdateRenderSubmit: {
        samples: values.length,
        p50ms,
        p95ms,
        maxMs: values.at(-1) ?? null,
        targetP95ms: 12,
        numericTargetMet: valid && (p95ms ?? Infinity) <= 12,
      },
      RAF: {
        estimatedDroppedFrames: this.droppedFrames,
        maximumGapMs: this.maximumGapMs,
      },
      longTasks: {
        supported: this.longTasksSupported,
        entries: this.longTasks,
        boundaryLimit:
          "Observer callbacks arriving after capture completion/disconnect, including a terminal task that has not yet ended, may be unavailable. The per-RAF CPU timer still includes the terminal render submission.",
      },
      pauses: {
        events: this.pauseEvents,
        pausedFrames: this.frames.filter((frame) => frame.paused).length,
        debtPauses: this.lastMeasured?.debtPauses ?? 0,
      },
      failures: this.failures,
      frames: this.frames,
    };
  }
}
