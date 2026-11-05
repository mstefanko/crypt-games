import { RoomClockImpl } from "@colyseus/sdk/RoomClock";
import { TICK_MS, type RoomPhase } from "../../protocol";

/** SDK time is milliseconds on the server monotonic axis; ticks only run in active phases. */
export class NetworkClock {
  private clock = new RoomClockImpl();
  private anchor = { tick: 0, serverTime: 0, phase: "waiting" as RoomPhase };
  private requests = new Map<number, number>();
  private nextId = 0;
  private sampled = false;
  reset() {
    this.clock.reset();
    this.requests.clear();
    this.sampled = false;
    this.anchor = { tick: 0, serverTime: 0, phase: "waiting" };
  }
  /** A match epoch resets simulation ticks, not the connection's monotonic
   * server-time axis. Keep measured offset/RTT; old-epoch replies cannot reanchor. */
  resetTimeline() {
    if (!this.sampled) this.clock.reset();
    this.requests.clear();
    this.anchor = { tick: 0, serverTime: 0, phase: "waiting" };
  }
  ping(now: number) {
    const request = { id: ++this.nextId, sent: now };
    this.requests.set(request.id, now);
    while (this.requests.size > 8)
      this.requests.delete(this.requests.keys().next().value!);
    return request;
  }
  pong(value: unknown, now: number, epoch: number) {
    if (!value || typeof value !== "object") return false;
    const v = value as {
      id: number;
      sent: number;
      serverTime: number;
      tick: number;
      epoch: number;
      phase: RoomPhase;
    };
    if (
      !Number.isSafeInteger(v.id) ||
      !Number.isFinite(v.sent) ||
      !this.requests.has(v.id) ||
      this.requests.get(v.id) !== v.sent ||
      v.epoch !== epoch ||
      !Number.isFinite(v.serverTime) ||
      v.serverTime < 0 ||
      v.serverTime > Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(v.tick) ||
      v.tick < 0 ||
      !["waiting", "countdown", "playing", "results", "closing"].includes(
        v.phase,
      )
    )
      return false;
    this.requests.delete(v.id);
    const elapsed = now - v.sent;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 4000) return false;
    // A large persistent route change must not be permanently rejected as an SDK outlier.
    if (!this.sampled || elapsed > this.rtt * 4) this.clock.reset();
    this.clock.sample(v.serverTime, elapsed);
    this.sampled = true;
    this.anchor = v;
    return true;
  }
  checkpoint(tick: number, serverTime: number, phase: RoomPhase) {
    this.anchor = { tick, serverTime, phase };
    if (!this.sampled) this.clock.sample(serverTime, -1);
  }
  get rtt() {
    return this.clock.smoothedRtt() || 80;
  }
  get fractionalTick() {
    return (
      this.anchor.tick +
      (this.anchor.phase === "playing"
        ? Math.max(
            0,
            (this.clock.serverNow() - this.anchor.serverTime) / TICK_MS,
          )
        : 0)
    );
  }
  get tick() { return Math.floor(this.fractionalTick); }
}
