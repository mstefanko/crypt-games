import type { CryptballEvent } from "../../sim/contract";
type Origin = {
  epoch: number;
  generation: number;
  participantId: string;
  seq: number;
  eventKind: string;
  ordinal: number;
};
const keyOf = (event: CryptballEvent) => {
  const origin = event.origin as Origin | undefined;
  return origin
    ? `${origin.epoch}:${origin.generation}:${origin.participantId}:${origin.seq}:${origin.eventKind}:${origin.ordinal}`
    : undefined;
};
/** Only low-risk local onset cues can be predicted. Contact, score and opponents stay authoritative. */
export class CosmeticLedger {
  private entries = new Map<
    string,
    { seq: number; at: number; confirmed: boolean }
  >();
  confirmed = 0;
  expired = 0;
  reset() {
    this.entries.clear();
  }
  predict(event: CryptballEvent, participantId: string, now: number) {
    const origin = event.origin as Origin | undefined;
    if (
      !origin ||
      origin.participantId !== participantId ||
      !["swing", "dash"].includes(event.type)
    )
      return false;
    const key = keyOf(event)!;
    if (this.entries.has(key)) return false;
    this.entries.set(key, { seq: origin.seq, at: now, confirmed: false });
    this.prune(now);
    return true;
  }
  /** A successful action-start origin confirms prediction; transport acceptance alone cannot. */
  authority(event: CryptballEvent, now: number) {
    const key = keyOf(event),
      entry = key ? this.entries.get(key) : undefined;
    this.prune(now);
    if (!entry) return true;
    if (!entry.confirmed) {
      entry.confirmed = true;
      this.confirmed++;
    }
    return false;
  }
  reject(seq: number) {
    for (const entry of this.entries.values())
      if (entry.seq === seq && !entry.confirmed) {
        entry.confirmed = true;
        this.expired++;
      }
  }
  private prune(now: number) {
    for (const [key, entry] of this.entries)
      if (now - entry.at > 2000) {
        if (!entry.confirmed) this.expired++;
        this.entries.delete(key);
      }
    while (this.entries.size > 128) {
      const key = this.entries.keys().next().value!,
        entry = this.entries.get(key)!;
      if (!entry.confirmed) this.expired++;
      this.entries.delete(key);
    }
  }
  get size() {
    return this.entries.size;
  }
}
