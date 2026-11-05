/** Reliable ordered delivery: jitter can delay later messages, never overtake. */
export class OrderedLink {
  private tail = 0;
  private queue: { at: number; run: () => void }[] = [];
  constructor(
    private readonly delay: (sent: number, ordinal: number) => number,
  ) {}
  private ordinal = 0;
  send(now: number, run: () => void) {
    this.tail = Math.max(
      this.tail,
      now + Math.max(0, this.delay(now, this.ordinal++)),
    );
    this.queue.push({ at: this.tail, run });
  }
  deliver(now: number) {
    while (this.queue.length && this.queue[0]!.at <= now)
      this.queue.shift()!.run();
  }
  get pending() {
    return this.queue.length;
  }
}
