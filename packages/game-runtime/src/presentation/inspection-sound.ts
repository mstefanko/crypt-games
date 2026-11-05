import type { InspectionShiftEvent } from "@onepage/game-simulation/inspection-shift-session";
import { PresentationQueue } from "./event-queue";
/** Cosmetic speech pulses never advance rules or case generation. */
export class InspectionSoundPresentation {
  private queue = new PresentationQueue(128);
  private pending: InspectionShiftEvent[] = [];
  private sequence = 0;
  private source = "";
  private tick = 0;
  consume(
    events: readonly InspectionShiftEvent[],
    dt: number,
    source: string,
    tick: number,
  ) {
    this.source = source;
    this.tick = tick;
    for (const event of events) {
      if (event.kind !== "utterance")
        this.pending.push({ ...event, sequence: ++this.sequence });
      else {
        const count = Math.min(
          10,
          Math.max(3, Math.ceil((event.payload.text?.length ?? 20) / 12)),
        );
        for (let i = 0; i < count; i++)
          this.queue.enqueue({
            id: `speech:${event.sequence}:${i}`,
            delay: i * 0.12,
            run: () => {
              if (this.source === event.sourceId)
                this.pending.push({
                  sequence: ++this.sequence,
                  tick: this.tick,
                  sourceId: event.sourceId,
                  kind: "speech",
                  payload: {
                    gain: 0.8,
                    pitch: 0.92 + (event.sequence % 6) * 0.06,
                  },
                });
            },
          });
      }
    }
    this.queue.update(dt);
  }
  drain() {
    const events = this.pending;
    this.pending = [];
    return events;
  }
  clear() {
    this.queue.cancelEpoch();
    this.pending = [];
  }
}
