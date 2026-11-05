import { NarrativeSession, type NarrativeDefinition } from "./narrative";
import { canonicalJson } from "./session-protocol";
import type {
  CommandMetadata,
  OrderedSessionEvent,
  SessionProtocol,
} from "./session-protocol";
export type NarrativeCommand = CommandMetadata &
  (
    | { kind: "choose"; id: string }
    | { kind: "walk"; cell: number; hotspot?: string }
    | { kind: "invest"; skill: string }
    | { kind: "wear"; id: string }
    | { kind: "profile"; id: string }
    | { kind: "recover"; stat: "health" | "morale" }
    | { kind: "continue" | "roll" | "leave" }
  );
export type NarrativeProtocolSnapshot = {
  kind: "narrative-protocol";
  version: 1;
  tick: number;
  sequence: number;
  cueCursor: number;
  events: OrderedSessionEvent[];
  owner: unknown;
};
/** Bounded narrative adapter: event acknowledgement and command sequencing are checkpointed. */
export class NarrativeProtocol
  implements
    SessionProtocol<
      NarrativeCommand,
      NarrativeSession["state"],
      OrderedSessionEvent,
      NarrativeProtocolSnapshot
    >
{
  readonly session: NarrativeSession;
  #tick = 0;
  #sequence = 0;
  #cueCursor = 0;
  #events: OrderedSessionEvent[] = [];
  constructor(definition: NarrativeDefinition, seed: number) {
    this.session = new NarrativeSession(definition, seed);
    this.capture();
  }
  command(c: NarrativeCommand): boolean {
    const before = this.session.state;
    if (
      (c.sequence !== undefined &&
        (!Number.isSafeInteger(c.sequence) || c.sequence <= this.#sequence)) ||
      (c.revision !== undefined && c.revision !== before.revision)
    )
      return false;
    const beforeOwner = canonicalJson(this.session.snapshot());
    switch (c.kind) {
      case "choose":
        this.session.choose(c.id, c.revision);
        break;
      case "walk":
        this.session.walk(c.cell, c.hotspot);
        break;
      case "invest":
        this.session.invest(c.skill);
        break;
      case "wear":
        this.session.wear(c.id);
        break;
      case "profile":
        this.session.profile(c.id);
        break;
      case "recover":
        this.session.recover(c.stat);
        break;
      case "continue":
        this.session.continue();
        break;
      case "roll":
        this.session.roll();
        break;
      case "leave":
        this.session.leaveConversation();
        break;
      default:
        return false;
    }
    const accepted = canonicalJson(this.session.snapshot()) !== beforeOwner;
    if (accepted) {
      if (c.sequence !== undefined) this.#sequence = c.sequence;
      this.capture();
    }
    return accepted;
  }
  step(dt: number) {
    this.session.update(dt);
    this.#tick++;
    this.capture();
  }
  observe() {
    return this.session.state;
  }
  private capture(): void {
    const events = this.session.state.cues
      .filter((c) => c.id > this.#cueCursor)
      .map((c) => ({
        sequence: c.id,
        tick: this.#tick,
        sourceId: "narrative",
        kind: c.kind,
      }));
    if (events.length) this.#cueCursor = events[events.length - 1].sequence;
    this.#events.push(...events);
  }
  drainEvents(): OrderedSessionEvent[] {
    return this.#events.splice(0);
  }
  snapshot(): NarrativeProtocolSnapshot {
    return {
      kind: "narrative-protocol",
      version: 1,
      tick: this.#tick,
      sequence: this.#sequence,
      cueCursor: this.#cueCursor,
      events: structuredClone(this.#events),
      owner: this.session.snapshot(),
    };
  }
  restore(value: unknown) {
    canonicalJson(value);
    const v = structuredClone(value) as NarrativeProtocolSnapshot;
    if (
      !v ||
      v.kind !== "narrative-protocol" ||
      v.version !== 1 ||
      [v.tick, v.sequence, v.cueCursor].some(
        (n) => !Number.isSafeInteger(n) || n < 0,
      )
    )
      throw Error("Invalid narrative protocol checkpoint");
    if (
      !Array.isArray(v.events) ||
      v.events.some(
        (e, i) =>
          !e ||
          !Number.isSafeInteger(e.sequence) ||
          e.sequence < 1 ||
          e.sequence > v.cueCursor ||
          !Number.isSafeInteger(e.tick) ||
          e.tick < 0 ||
          e.tick > v.tick ||
          typeof e.kind !== "string" ||
          e.sourceId !== "narrative" ||
          (i > 0 && e.sequence <= v.events[i - 1].sequence),
      )
    )
      throw Error("Invalid narrative events");
    const owner = v.owner as { state?: { nextCue?: number } };
    if (
      !owner?.state ||
      typeof owner.state.nextCue !== "number" ||
      v.cueCursor !== owner.state.nextCue - 1
    )
      throw Error("Invalid narrative event cursor");
    this.session.restore(v.owner);
    this.#tick = v.tick;
    this.#sequence = v.sequence;
    this.#cueCursor = v.cueCursor;
    this.#events = structuredClone(v.events);
  }
}
