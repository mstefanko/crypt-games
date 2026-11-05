import {
  heldCommand,
  TICK_MS,
  NETWORK_LIMITS,
  type InputPacket,
} from "../../protocol";
import type { CommandFrame, SportId } from "../../sim/contract";
const EDGE_KEYS = [
  "strikePressed",
  "strikeReleased",
  "pass",
  "dash",
  "special",
  "switch",
  "cancel",
  "check",
] as const;
/** Captures ordered intentions independently of host/render cadence and network slots. */
export class InputScheduler {
  private edges: { command: CommandFrame; at: number }[] = [];
  private held: CommandFrame = {};
  private safetyCancel = false;
  private lastTick = -1;
  private lastSent = -Infinity;
  private lastFeedback = -1;
  private feedbackAfterCount = 0;
  private healthySince = 0;
  lead = 2;
  expired = 0;
  overflow = 0;
  reset() {
    this.edges = [];
    this.held = {};
    this.safetyCancel = false;
    this.lastTick = -1;
    this.lastSent = -Infinity;
    this.lastFeedback = -1;
    this.feedbackAfterCount = 0;
    this.healthySince = 0;
    this.lead = 2;
  }
  seed(rtt: number) {
    this.lead = Math.min(
      NETWORK_LIMITS.maxArrivalLead,
      Math.max(this.lead, Math.ceil(rtt / 2 / TICK_MS) + 2),
    );
  }
  capture(command: CommandFrame, now: number, slideIsEdge: boolean, sportId: SportId = "cryptball") {
    this.held = heldCommand(command, sportId);
    if (!slideIsEdge) this.held.slide = command.slide;
    else delete this.held.slide;
    if (EDGE_KEYS.some((k) => command[k]) || (slideIsEdge && command.slide)) {
      if (this.edges.length >= NETWORK_LIMITS.unsentEdges) {
        this.overflow++;
        this.edges = [];
        this.held = {};
        this.safetyCancel = true;
      } else this.edges.push({ command: { ...command }, at: now });
    }
    while (
      this.edges.length &&
      now - this.edges[0].at > NETWORK_LIMITS.captureAgeMs
    ) {
      this.edges.shift();
      this.expired++;
      this.held = { ...this.held, strikeHeld: false, passHeld: false };
      this.safetyCancel = true;
    }
  }
  feedback(
    sampleSeq: number,
    count: number,
    lowMargin: number,
    minimumMargin: number,
    now: number,
  ) {
    if (!count || sampleSeq <= this.lastFeedback) return;
    this.lastFeedback = sampleSeq;
    // Authority reports percentiles over its last 60 receipts. A new snapshot
    // sequence does not mean that window reflects our last lead adjustment.
    // Repeatedly correcting the same old low margin winds lead up to the cap,
    // unnecessarily increasing both input delay and whole-world replay work.
    if (count < this.feedbackAfterCount) return;
    const target = Math.min(
      4,
      Math.max(2, 2 + Math.ceil(Math.max(0, lowMargin - minimumMargin) / 2)),
    );
    if (lowMargin < target) {
      this.lead = Math.min(
        NETWORK_LIMITS.maxArrivalLead,
        this.lead + Math.min(4, Math.ceil(target - lowMargin)),
      );
      this.healthySince = now;
      this.feedbackAfterCount = count + 60;
    } else if (lowMargin > target + 1) {
      if (now - this.healthySince >= 1000) {
        this.lead = Math.max(1, this.lead - 1);
        this.healthySince = now;
        this.feedbackAfterCount = count + 60;
      }
    } else this.healthySince = now;
  }
  allocate(
    serverTick: number,
    checkpointTick: number,
    now: number,
  ): { tick: number; command: CommandFrame } | null {
    // One send per wall-clock slot, including host accumulator catch-up bursts.
    if (now - this.lastSent < TICK_MS - 0.5) return null;
    const tick = Math.floor(serverTick) + this.lead;
    if (
      tick <= this.lastTick ||
      tick > checkpointTick + NETWORK_LIMITS.replayTicks ||
      tick > serverTick + NETWORK_LIMITS.maxFutureTicks
    )
      return null;
    this.lastTick = tick;
    this.lastSent = now;
    if (this.safetyCancel) {
      this.safetyCancel = false;
      return {
        tick,
        command: { ...this.held, strikeHeld: false, passHeld: false, cancel: true },
      };
    }
    const edge = this.edges.shift();
    const command = edge?.command ?? { ...this.held };
    delete this.held.cancel;
    return { tick, command };
  }
  get queuedEdges() {
    return this.edges.length;
  }
}
export function replaySchedule(
  history: InputPacket[],
  dispositions: { seq: number; status: string; executionTick?: number }[],
) {
  const assignments = new Map(dispositions.map((d) => [d.seq, d]));
  return history.flatMap((packet) => {
    const d = assignments.get(packet.seq);
    return d?.status === "rejected"
      ? []
      : [{ ...packet, tick: d?.executionTick ?? packet.tick }];
  });
}
