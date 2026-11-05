import type { Track, Patch } from "@onepage/project";
import type { PerformanceNote } from "@onepage/music-core/performance";
export type TickerFactory = (
  callback: () => void,
  intervalMs: number,
) => () => void;
export interface StreamConfig {
  bpm: number;
  tracks: Track[];
  patches: Patch[];
  startTick?: number;
  /** Explicit qualified one-shot exceptions; onset commitment remains two bars. */
  maxNoteDurationTicksByPatch?: Record<string, number>;
  lookaheadSeconds?: number;
  ticker?: TickerFactory;
}
export interface StreamWindow {
  epoch: number;
  revision: number;
  id: string;
  startTick: number;
  endTick: number;
  notes: PerformanceNote[];
}
export interface StreamReceipt {
  epoch: number;
  id: string;
  status:
    | "accepted"
    | "rejected"
    | "scheduled"
    | "skipped"
    | "dropped"
    | "ended"
    | "gain"
    | "stolen";
  reason?: string;
  tick?: number;
  noteId?: string;
  value?: number;
  duration?: number;
  atContextTime?: number;
  rampSeconds?: number;
  role?: Track["role"];
  note?: PerformanceNote;
  overflow?: boolean;
  observedAtContextTime?: number;
  nodeCreationMs?: number;
}
/** Bounded onset-owned symbolic queue. Audio commitment is independent of prepared coverage. */
export class StreamQueue {
  notes: PerformanceNote[] = [];
  preparedThrough: number;
  frontier: number;
  revision = -1;
  ended = false;
  private ids = new Map<string, { signature: string; endTick: number }>();
  private identityBytes = 0;
  private onsetIds = new Map<string, number>();
  constructor(
    readonly epoch: number,
    readonly config: StreamConfig,
  ) {
    if (
      !Number.isFinite(config.bpm) ||
      config.bpm < 20 ||
      config.bpm > 400 ||
      !Number.isSafeInteger(config.startTick ?? 0) ||
      (config.startTick ?? 0) < 0
    )
      throw Error("Invalid stream configuration");
    if (
      config.patches.some(
        (p) =>
          !p.id ||
          !["sine", "triangle", "sawtooth", "pulse", "noise", "harmonic-bass"].includes(
            p.waveform,
          ) ||
          !Number.isFinite(p.attack) ||
          p.attack < 0 ||
          p.attack > 5 ||
          !Number.isFinite(p.release) ||
          p.release < 0 ||
          p.release > 10 ||
          (p.decaySeconds !== undefined &&
            (!Number.isFinite(p.decaySeconds) ||
              p.decaySeconds < 0.02 ||
              p.decaySeconds > 10)) ||
          !Number.isFinite(p.brightness) ||
          p.brightness < 0 ||
          p.brightness > 1 ||
          !Number.isFinite(p.duty) ||
          p.duty < 0.05 ||
          p.duty > 0.95,
      ) ||
      config.tracks.some(
        (t) =>
          !t.id ||
          !["melody", "bass", "harmony", "drums"].includes(t.role) ||
          !config.patches.some((p) => p.id === t.patchId) ||
          !Number.isFinite(t.gain) ||
          t.gain < 0 ||
          t.gain > 1 ||
          !Number.isFinite(t.pan) ||
          Math.abs(t.pan) > 1 ||
          !Number.isInteger(t.minEnergy) ||
          t.minEnergy < 1 ||
          t.minEnergy > 3,
      )
    )
      throw Error("Invalid stream resources");
    if (
      config.tracks.length > 32 ||
      config.patches.length > 64 ||
      new Set(config.tracks.map((t) => t.id)).size !== config.tracks.length ||
      new Set(config.patches.map((p) => p.id)).size !== config.patches.length
    )
      throw Error("Invalid stream resources");
    for (const [id, ticks] of Object.entries(
      config.maxNoteDurationTicksByPatch ?? {},
    ))
      if (
        !config.patches.some((p) => p.id === id) ||
        !Number.isInteger(ticks) ||
        ticks < 3840 ||
        ticks > 9600
      )
        throw Error("Invalid qualified sustain limit");
    this.preparedThrough = this.frontier = config.startTick ?? 0;
  }
  submit(w: StreamWindow): StreamReceipt {
    const reject = (reason: string): StreamReceipt => ({
      epoch: this.epoch,
      id: w.id,
      status: "rejected",
      reason,
    });
    if (w.epoch !== this.epoch || this.ended) return reject("stale-or-ended");
    if (
      !w.id ||
      w.id.length > 128 ||
      !Number.isSafeInteger(w.revision) ||
      w.revision < this.revision ||
      !Number.isSafeInteger(w.startTick) ||
      !Number.isSafeInteger(w.endTick) ||
      w.endTick <= w.startTick ||
      w.startTick < (this.config.startTick ?? 0) ||
      w.notes.length > 512
    )
      return reject("invalid-window");
    const signature = JSON.stringify(w);
    if (this.ids.has(w.id))
      return this.ids.get(w.id)?.signature === signature
        ? {
            epoch: this.epoch,
            id: w.id,
            status: "accepted",
            reason: "duplicate",
          }
        : reject("duplicate-window-id");
    if (this.onsetIds.size + this.notes.length + w.notes.length > 16384)
      return reject("event-limit");
    if (this.identityBytes + signature.length * 2 > 4 * 1024 * 1024)
      return reject("identity-memory-limit");
    if (this.ids.size >= 4096) return reject("window-limit");
    if (w.startTick < this.frontier || w.startTick > this.preparedThrough)
      return reject("frontier-or-gap");
    if (
      w.startTick < this.preparedThrough &&
      (w.startTick % 1920 !== 0 || w.revision <= this.revision)
    )
      return reject("replacement-boundary-or-revision");
    const retained = this.notes.filter((n) => n.startTick < w.startTick);
    const ids = new Set(retained.map((n) => n.id));
    const tracks = new Set(this.config.tracks.map((t) => t.id)),
      patches = new Set(this.config.patches.map((p) => p.id));
    for (const n of w.notes) {
      if (
        !n.id ||
        n.id.length > 128 ||
        ids.has(n.id) ||
        this.onsetIds.has(n.id) ||
        !tracks.has(n.trackId) ||
        !patches.has(n.patchId) ||
        !Number.isSafeInteger(n.startTick) ||
        n.startTick < w.startTick ||
        n.startTick >= w.endTick ||
        !Number.isSafeInteger(n.durationTicks) ||
        n.durationTicks <= 0 ||
        n.durationTicks >
          (this.config.maxNoteDurationTicksByPatch?.[n.patchId] ?? 3840) ||
        !Number.isInteger(n.pitch) ||
        n.pitch < 0 ||
        n.pitch > 127 ||
        !Number.isFinite(n.velocity) ||
        n.velocity < 0 ||
        n.velocity > 1 ||
        !Number.isFinite(n.gain) ||
        n.gain < 0 ||
        n.gain > 2 ||
        !Number.isFinite(n.pan) ||
        Math.abs(n.pan) > 1 ||
        !Number.isInteger(n.priority) ||
        n.priority < 0 ||
        n.priority > 255 ||
        typeof n.optional !== "boolean"
      )
        return reject("invalid-note");
      const track = this.config.tracks.find((t) => t.id === n.trackId)!;
      if (
        n.patchId !== track.patchId ||
        n.gain !== track.gain ||
        n.pan !== track.pan
      )
        return reject("track-properties");
      ids.add(n.id);
    }
    if (
      retained.length + w.notes.length > 1024 ||
      w.endTick - this.frontier > 3840
    )
      return reject("queue-limit");
    this.notes = [...retained, ...structuredClone(w.notes)].sort(
      (a, b) =>
        a.startTick - b.startTick || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    this.preparedThrough = w.endTick;
    this.revision = w.revision;
    this.ids.set(w.id, { signature, endTick: w.endTick });
    this.identityBytes += signature.length * 2;
    return { epoch: this.epoch, id: w.id, status: "accepted" };
  }
  /** Identities behind the commitment frontier cannot affect a future onset. */
  private prune() {
    for (const [id, entry] of this.ids)
      if (entry.endTick <= this.frontier) {
        this.identityBytes -= entry.signature.length * 2;
        this.ids.delete(id);
      }
    for (const [id, tick] of this.onsetIds)
      if (tick < this.frontier) this.onsetIds.delete(id);
  }
  fork(): StreamQueue {
    const copy = new StreamQueue(this.epoch, this.config);
    Object.assign(copy, this);
    copy.notes = structuredClone(this.notes);
    copy.ids = new Map(this.ids);
    copy.onsetIds = new Map(this.onsetIds);
    return copy;
  }
  recoverAt(tick: number) {
    this.notes = [];
    this.frontier = this.preparedThrough = tick;
    this.prune();
  }
  take(through: number): PerformanceNote[] {
    const ready = this.notes.filter((n) => n.startTick < through);
    this.notes = this.notes.filter((n) => n.startTick >= through);
    for (const n of ready) this.onsetIds.set(n.id, n.startTick);
    // Bound identity retention per epoch; full run capture belongs to the caller.

    this.frontier = Math.max(
      this.frontier,
      Math.min(through, this.preparedThrough),
    );
    this.prune();
    return ready;
  }
}
