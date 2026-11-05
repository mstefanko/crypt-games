/** Checkpoint requests never reset command identity or change ownership. */
export class Recovery {
  private nextId = 0;
  private outstanding?: { id: number; sentAt: number; snapshotSeq: number };
  private retryAt = 0;
  private attempts = 0;
  requested = 0;
  reset() {
    this.outstanding = undefined;
    this.retryAt = 0;
    this.attempts = 0;
  }
  satisfy(snapshotSeq: number) {
    if (this.outstanding && snapshotSeq > this.outstanding.snapshotSeq) {
      this.outstanding = undefined;
      this.attempts = 0;
    }
  }
  request(
    now: number,
    rtt: number,
    epoch: number,
    generation: number,
    lastSnapshotSeq: number,
  ) {
    if (now < this.retryAt) return null;
    const id = ++this.nextId;
    this.outstanding = { id, sentAt: now, snapshotSeq: lastSnapshotSeq };
    this.retryAt =
      now +
      Math.min(
        4000,
        Math.max(500, 2 * rtt + 100) * 2 ** Math.min(this.attempts++, 4),
      );
    this.requested++;
    return { id, epoch, generation, lastSnapshotSeq };
  }
  get pending() {
    return !!this.outstanding;
  }
}
