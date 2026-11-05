/** Cosmetic scheduling for committed results. Consumers: card reveals, narrative checks,
 * arena feedback and settlement notices. Callbacks must never apply gameplay effects. */
export interface PresentationEvent {
  id: string;
  transactionId?: string | number;
  kind?: string;
  payload?: Readonly<Record<string, unknown>>;
  lane?: string;
  epoch?: number;
  delay?: number;
  duration?: number;
  blocking?: boolean;
  blockable?: boolean;
  timeout?: number;
  condition?: () => boolean;
  run?: (skipped?: boolean) => void;
  ease?: (phase: number) => void;
  cancel?: () => void;
}
export interface PresentationQueueSnapshot {
  epoch: number;
  paused: string[];
  seen: string[];
  pending: { id: string; time: number; started: boolean }[];
}
interface Pending {
  event: PresentationEvent;
  time: number;
  started: boolean;
}
export class PresentationQueue {
  private queue: Pending[] = [];
  private seen = new Set<string>();
  private paused = new Set<string>();
  private epoch = 0;
  constructor(readonly capacity = 256) {}
  enqueue(event: PresentationEvent, speed = 1): boolean {
    if (
      this.seen.has(event.id) ||
      (event.epoch !== undefined && event.epoch !== this.epoch)
    )
      return false;
    if (this.queue.length >= this.capacity) return false;
    this.seen.add(event.id);
    if (this.seen.size > 4096)
      this.seen.delete(this.seen.values().next().value!);
    this.queue.push({
      event: {
        ...event,
        delay: Math.max(0, event.delay ?? 0) / Math.max(0.1, speed),
        duration: Math.max(0, event.duration ?? 0) / Math.max(0.1, speed),
      },
      time: 0,
      started: false,
    });
    return true;
  }
  pause(lane = "*") {
    this.paused.add(lane);
  }
  resume(lane = "*") {
    this.paused.delete(lane);
  }
  update(dt: number) {
    const blocked = new Set<string>();
    const keep: Pending[] = [];
    for (const item of this.queue) {
      const e = item.event,
        lane = e.lane ?? "main";
      if (
        this.paused.has("*") ||
        this.paused.has(lane) ||
        (blocked.has(lane) && e.blockable !== false)
      ) {
        keep.push(item);
        continue;
      }
      item.time += Math.max(0, Number.isFinite(dt) ? dt : 0);
      if (e.condition && !e.condition()) {
        if (item.time >= (e.timeout ?? 5)) {
          e.cancel?.();
          continue;
        }
        if (e.blocking) blocked.add(lane);
        keep.push(item);
        continue;
      }
      if (item.time < (e.delay ?? 0)) {
        if (e.blocking) blocked.add(lane);
        keep.push(item);
        continue;
      }
      if (!item.started) {
        item.started = true;
        e.run?.(false);
      }
      const phase = Math.min(
        1,
        (item.time - (e.delay ?? 0)) / Math.max(0.00001, e.duration ?? 0),
      );
      e.ease?.(phase);
      if (phase < 1) {
        if (e.blocking) blocked.add(lane);
        keep.push(item);
      }
    }
    this.queue = keep;
  }
  fastForward(lane?: string) {
    this.queue = this.queue.filter(({ event, started }) => {
      if (lane && (event.lane ?? "main") !== lane) return true;
      if (!started) event.run?.(true);
      event.ease?.(1);
      return false;
    });
  }
  snapshot(): PresentationQueueSnapshot {
    return {
      epoch: this.epoch,
      paused: [...this.paused],
      seen: [...this.seen],
      pending: this.queue.map(({ event, time, started }) => ({
        id: event.id,
        time,
        started,
      })),
    };
  }
  /** Rebind descriptors from the committed trace; never serialize closures. */
  restore(
    snapshot: PresentationQueueSnapshot,
    descriptors: readonly PresentationEvent[],
  ) {
    this.clear();
    this.epoch = snapshot.epoch;
    this.paused = new Set(snapshot.paused);
    this.seen = new Set(snapshot.seen);
    const byId = new Map(descriptors.map((event) => [event.id, event]));
    this.queue = snapshot.pending.slice(0, this.capacity).flatMap((item) => {
      const event = byId.get(item.id);
      return event
        ? [{ event, time: Math.max(0, item.time), started: item.started }]
        : [];
    });
  }
  cancelEpoch(nextEpoch = this.epoch + 1) {
    this.clear();
    this.seen.clear();
    this.epoch = nextEpoch;
  }
  clear() {
    for (const { event } of this.queue) event.cancel?.();
    this.queue = [];
  }
  dispose() {
    this.clear();
    this.seen.clear();
    this.paused.clear();
  }
}

/** Detached serialized queue validation; descriptor callbacks are rebound separately. */
export function validatePresentationQueueSnapshot(
  value: unknown,
): PresentationQueueSnapshot {
  const q = structuredClone(value) as PresentationQueueSnapshot;
  const dense = (v: unknown): v is unknown[] =>
    Array.isArray(v) && Object.keys(v).length === v.length;
  if (
    !q ||
    !Number.isSafeInteger(q.epoch) ||
    q.epoch < 0 ||
    !dense(q.paused) ||
    q.paused.length > 256 ||
    !dense(q.seen) ||
    q.seen.length > 4096 ||
    !dense(q.pending) ||
    q.pending.length > 256 ||
    q.paused.some((v) => typeof v !== "string") ||
    q.seen.some((v) => typeof v !== "string") ||
    new Set(q.paused).size !== q.paused.length ||
    new Set(q.seen).size !== q.seen.length ||
    q.pending.some(
      (v) =>
        !v ||
        typeof v.id !== "string" ||
        !Number.isFinite(v.time) ||
        v.time < 0 ||
        typeof v.started !== "boolean",
    ) ||
    new Set(q.pending.map((v) => v.id)).size !== q.pending.length
  )
    throw Error("Invalid presentation queue checkpoint");
  return q;
}
