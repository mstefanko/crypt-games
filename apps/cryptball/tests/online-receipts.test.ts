import { describe, it, expect } from "vitest";
import { MatchAuthority } from "../../cryptball-server/src/model";
import { decodeSnapshot, encodeSnapshot } from "../protocol";
function fixture() {
  const m = new MatchAuthority("receipts");
  for (const id of ["a", "b"]) {
    m.join(id, id);
    m.ready(id);
  }
  m.start();
  for (let i = 0; i < 180; i++) m.advance();
  return m;
}
function input(m: MatchAuthority, seq: number, tick: number, command = {}) {
  return {
    epoch: m.epoch,
    generation: m.peers.get("a")!.generation,
    revision: m.session.getControllerRevision("a")!,
    seq,
    tick,
    command,
  };
}
describe("protocol 11 authority receipts", () => {
  it("retimes ordered late frames without acknowledging future execution", () => {
    const m = fixture();
    for (let i = 0; i < 3; i++) m.advance();
    const tick = m.session.getTick();
    expect(
      m.receive(
        "a",
        input(m, 1, tick - 1, { strikePressed: true, strikeHeld: true }),
      ),
    ).toBe(true);
    expect(m.receive("a", input(m, 2, tick, { strikeReleased: true }))).toBe(
      true,
    );
    const snapshot = m.snapshot("a", []);
    expect(snapshot.terminalSeq).toBe(0);
    expect(snapshot.dispositions.map((d) => d.executionTick)).toEqual([
      tick + 1,
      tick + 2,
    ]);
    expect(decodeSnapshot(encodeSnapshot(snapshot)).receivedSeq).toBe(2);
    m.advance();
    expect(m.snapshot("a", []).terminalSeq).toBe(1);
    m.advance();
    expect(m.snapshot("a", []).terminalSeq).toBe(2);
  });
  it("keeps rejection behind an accepted frame until the terminal prefix advances", () => {
    const m = fixture(),
      tick = m.session.getTick();
    expect(m.receive("a", input(m, 1, tick + 4))).toBe(true);
    expect(m.receive("a", input(m, 2, tick + 25))).toBe(false);
    const s = m.snapshot("a", []);
    expect(s.terminalSeq).toBe(0);
    expect(s.dispositions[1]).toMatchObject({
      status: "rejected",
      reason: "future",
    });
    for (let i = 0; i < 4; i++) m.advance();
    expect(m.snapshot("a", []).terminalSeq).toBe(2);
  });
  it("heartbeat preserves human ownership while stale controls neutralize", () => {
    const m = fixture();
    m.receive(
      "a",
      input(m, 1, m.session.getTick() + 1, { moveX: 1, strikeHeld: true }),
    );
    for (let i = 0; i < 60; i++) {
      if (i % 6 === 0) m.heartbeat("a", input(m, 2, 1));
      m.advance();
    }
    const p = m.peers.get("a")!;
    expect(p.active).toBe(true);
    expect(p.effective).toEqual({ cancel: true });
    expect(m.snapshot("a", []).feedback.neutralizations).toBeGreaterThan(0);
  });
  it("assigns newer snapshot sequences at an unchanged simulation tick", () => {
    const m = fixture();
    const a = m.snapshot("a", []),
      b = m.snapshot("a", []);
    expect(b.tick).toBe(a.tick);
    expect(b.snapshotSeq).toBeGreaterThan(a.snapshotSeq);
  });
});

describe("bounded stream safety", () => {
  it("records gaps behind unresolved commands and advances through a contiguous terminal prefix", () => {
    const m = fixture(),
      tick = m.session.getTick();
    expect(m.receive("a", input(m, 1, tick + 3))).toBe(true);
    expect(m.receive("a", input(m, 4, tick + 4))).toBe(true);
    const s = m.snapshot("a", []);
    expect(s.terminalSeq).toBe(0);
    expect(s.dispositions.map((d) => [d.seq, d.status, d.reason])).toEqual([
      [1, "accepted", undefined],
      [2, "rejected", "sequence-gap"],
      [3, "rejected", "sequence-gap"],
      [4, "accepted", undefined],
    ]);
    expect(decodeSnapshot(encodeSnapshot(s)).dispositions).toHaveLength(4);
    for (let i = 0; i < 3; i++) m.advance();
    expect(m.snapshot("a", []).terminalSeq).toBe(3);
    m.advance();
    expect(m.snapshot("a", []).terminalSeq).toBe(4);
    expect(m.receive("a", input(m, 2, tick + 5))).toBe(false);
  });
  it("caps the combined gap and pending ledger before modifying receipt state", () => {
    const m = fixture(),
      tick = m.session.getTick();
    m.receive("a", input(m, 1, tick + 20));
    expect(m.receive("a", input(m, 130, tick + 21))).toBe(false);
    expect(m.snapshot("a", []).receivedSeq).toBe(1);
  });
  it("accounts for admitted upcoming controls before neutralizing held state", () => {
    const m = fixture(),
      tick = m.session.getTick();
    m.receive("a", input(m, 1, tick + 1, { moveX: 1 }));
    m.advance();
    m.receive("a", input(m, 2, tick + 12, { moveX: 0 }));
    for (let i = 0; i < 9; i++) {
      if (i === 5) m.heartbeat("a", input(m, 3, 1));
      m.advance();
    }
    expect(m.peers.get("a")!.effective.moveX).toBe(1);
    m.advance();
    m.advance();
    expect(m.peers.get("a")!.effective.moveX).toBe(0);
  });
  it("does not let an older recovered release cancel newer controls", () => {
    const m = fixture(),
      tick = m.session.getTick();
    m.receive("a", input(m, 2, tick + 1, { moveX: 1, strikeHeld: true }));
    m.advance();
    expect(m.receive("a", input(m, 1, 0, { strikeReleased: true }))).toBe(
      false,
    );
    m.advance();
    expect(m.peers.get("a")!.effective.strikeHeld).toBe(true);
  });
});

describe("room catch-up efficiency", () => {
  it("broadcasts one latest checkpoint while preserving all catch-up events", async () => {
    const { CryptballRoom } = await import("../../cryptball-server/src/room");
    const m = fixture();
    m.tick = 2;
    const room = Object.create(CryptballRoom.prototype) as any;
    Object.assign(room, {
      authority: m,
      last: performance.now() - 70,
      debt: 0,
      stableSince: 0,

      clients: [{}, {}],
      emptyAt: null,
    });
    Object.defineProperty(room, "locked", { value: true });
    const sent: any[] = [];
    room.sendSnapshot = (
      _client: unknown,
      events: unknown[],
      checkpoint: unknown,
    ) => sent.push({ events, checkpoint });
    room.sendLobby = () => {};
    const original = m.advance.bind(m);
    m.advance = () => {
      original();
      events.push({ type: "catchup", tick: m.session.getTick() });
    };
    // Preexisting undrained events and events generated during catch-up must share the broadcast.
    const events = [{ type: "fixture", tick: 0 }];
    m.session.drainEvents = () => events;
    room.pump();
    expect(sent).toHaveLength(2);
    expect(sent[0].checkpoint).toBe(sent[1].checkpoint);
    expect(sent[0].events).toBe(events);
    expect(sent[0].events).toHaveLength(5);
    expect(sent[0].checkpoint.state.tick).toBe(m.session.getTick());
    expect(m.tick).toBe(6);
  });
});

it("confirms admitted retimed actions with server-owned command origins", () => {
  const m = fixture();
  for (let i = 0; i < 3; i++) m.advance();
  const tick = m.session.getTick();
  expect(m.receive("a", input(m, 1, tick - 1, { pass: true }))).toBe(true);
  m.advance();
  const events = m.session.drainEvents();
  const event = events.find(
    (e) => e.type === "swing" && e.origin?.participantId === "a",
  );
  expect(event?.origin).toEqual({
    epoch: m.epoch,
    generation: m.peers.get("a")!.generation,
    participantId: "a",
    seq: 1,
    eventKind: "swing",
    ordinal: 0,
  });
  expect(
    decodeSnapshot(encodeSnapshot(m.snapshot("a", events))).events.find(
      (e) => e.origin,
    )?.origin,
  ).toEqual(event?.origin);
  expect(
    m.receive("a", {
      ...input(m, 2, tick + 2),
      command: {
        pass: true,
        origin: { epoch: 1, generation: 1, participantId: "spoof", seq: 2 },
      },
    }),
  ).toBe(false);
});

it("executes a rejected release as a safety cancel and invalidates older queued holds", () => {
  const m = fixture(),
    tick = m.session.getTick();
  m.receive(
    "a",
    input(m, 1, tick + 1, { strikePressed: true, strikeHeld: true }),
  );
  m.advance();
  const current = m.session.getTick();
  expect(m.session.capture().state.players[0].charging).toBe(true);
  expect(
    m.receive(
      "a",
      input(m, 2, current + 24, { strikePressed: true, strikeHeld: true }),
    ),
  ).toBe(true);
  expect(
    m.receive("a", input(m, 3, current + 25, { strikeReleased: true })),
  ).toBe(false);
  expect(m.peers.get("a")!.queue).toHaveLength(0);
  expect(m.receive("a", input(m, 4, current + 26, { moveX: 1 }))).toBe(false);
  m.advance();
  const state = m.session.capture().state;
  expect(state.players[0].charging).toBe(false);
  expect(m.peers.get("a")!.effective).toEqual({ cancel: true });
  expect(
    m.session
      .drainEvents()
      .some((e) => e.type === "swing" && e.playerId === "player-0"),
  ).toBe(false);
  for (let i = 0; i < 25; i++) {
    if (i % 6 === 0) m.heartbeat("a", input(m, 5, 1));
    m.advance();
  }
  expect(m.session.capture().state.players[0].charging).toBe(false);
});

it("resets arrival feedback identity across rematch generations", () => {
  const m = fixture(),
    tick = m.session.getTick();
  m.receive("a", input(m, 100, tick + 2));
  expect(m.snapshot("a", []).feedback.sampleSeq).toBe(100);
  const generation = m.peers.get("a")!.generation;
  m.phase = "results";
  m.rematch("a");
  m.rematch("b");
  expect(m.snapshot("a", []).feedback).toMatchObject({
    sampleSeq: 0,
    sampleCount: 0,
    minimumMargin: 0,
    lowMargin: 0,
  });
  expect(m.peers.get("a")!.generation).toBe(generation + 1);
  m.ready("a");
  m.ready("b");
  m.start();
  for (let i = 0; i < 180; i++) m.advance();
  expect(m.receive("a", input(m, 1, m.session.getTick() + 2))).toBe(true);
  expect(m.snapshot("a", []).feedback).toMatchObject({
    sampleSeq: 1,
    sampleCount: 1,
  });
});

it("reports bounded reason counters and rejects malformed feedback", () => {
  const m = fixture(),
    tick = m.session.getTick();
  m.receive("a", input(m, 2, tick + 24, { strikeHeld: true }));
  m.receive("a", input(m, 3, tick + 25, { strikeReleased: true }));
  const snapshot = m.snapshot("a", []);
  expect(snapshot.feedback.rejectionReasons).toMatchObject({
    "sequence-gap": 1,
    future: 1,
    cancelled: 1,
  });
  expect(
    Object.values(snapshot.feedback.rejectionReasons).reduce(
      (sum, n) => sum + n,
      0,
    ),
  ).toBe(snapshot.feedback.rejections);
  snapshot.feedback.rejectionReasons.future = 100;
  expect(m.snapshot("a", []).feedback.rejectionReasons.future).toBe(1);
  const malformed = m.snapshot("a", []);
  (malformed.feedback.rejectionReasons as any).unknown = 1;
  expect(() => decodeSnapshot(encodeSnapshot(malformed))).toThrow(
    "Invalid checkpoint envelope",
  );
});

it("bounds worst retained receipt payloads with every available special and player action active", () => {
  const m = new MatchAuthority("payload-budget");
  for (const id of ["a", "b", "c", "d"]) {
    m.join(id, id);
    m.ready(id);
  }
  for (let i = 0; i < 180; i++) m.advance();
  const cp = m.session.capture();
  // Specials are team-owned: this four-player game has exactly two simultaneous slots.
  for (let team = 0; team < 2; team++)
    cp.state.specials[team as 0 | 1].active = {
      playerId: cp.state.players[team * 2].id,
      remainingTicks: 42,
      elapsedTicks: 0,
      heading: 0,
      burstStart: 6,
      secondBurstAvailable: true,
      contactUsed: false,
      receptionUsed: false,
      stoppedTicks: -1,
      origin: {
        epoch: m.epoch,
        generation: 1,
        participantId: "participant-long-identity-0123456789",
        seq: 1234567,
      },
    };
  for (const p of cp.state.players) {
    p.motionOrigin = {
      epoch: m.epoch,
      generation: 1,
      participantId: "participant-long-identity-0123456789",
      seq: 1234567,
    };
    p.chargeOrigin = { ...p.motionOrigin };
    p.action = {
      id: 1234567,
      elapsed: 1,
      timing: { tell: 4, active: 3, recover: 9 },
      hits: [],
      heading: 255,
      kind: "strike",
      charge: 24,
      origin: { ...p.motionOrigin },
    };
    p.buffer = {
      kind: "strike",
      charge: 24,
      until: cp.state.tick + 6,
      origin: { ...p.motionOrigin },
    };
  }
  for (const peer of m.peers.values()) {
    peer.lastSeq = 128;
    peer.ack = 0;
    // Conservative storage-cap fixture: normal 24-tick admission admits fewer than32 future slots.
    peer.ledger = Array.from({ length: 128 }, (_, i) =>
      i < 32
        ? {
            seq: i + 1,
            requestedTick: cp.state.tick + i + 1,
            executionTick: cp.state.tick + i + 1,
            status: "accepted" as const,
          }
        : {
            seq: i + 1,
            requestedTick: cp.state.tick + i + 1,
            status: "rejected" as const,
            reason: "capacity" as const,
          },
    );
  }
  const payloads = [...m.peers.keys()].map((id) =>
    encodeSnapshot(m.snapshot(id, [], cp)),
  );
  for (const payload of payloads)
    expect(payload.byteLength).toBeLessThanOrEqual(16384);
  const overflow = m.snapshot("a", [], cp);
  overflow.events = Array.from({ length: 200 }, (_, i) => ({
    type: "fixture",
    tick: i,
    payload: "x".repeat(100),
  }));
  expect(() => encodeSnapshot(overflow)).toThrow(
    "Checkpoint exceeds wire budget",
  );
});

it("interrupts explicitly when an encoded checkpoint exceeds the wire limit", async () => {
  const { CryptballRoom } = await import("../../cryptball-server/src/room");
  const m = fixture(),
    room = Object.create(CryptballRoom.prototype) as any;
  Object.assign(room, {
    authority: m,
    debt: 0,
    resync: new Map(),
    backlogSince: new Map(),
  });
  const interruptions: unknown[] = [];
  room.broadcast = (...args: unknown[]) => interruptions.push(args);
  let sends = 0;
  room.sendSnapshot(
    { sessionId: "a", ref: { bufferedAmount: 0 }, sendBytes: () => sends++ },
    Array.from({ length: 200 }, (_, i) => ({
      type: "fixture",
      tick: i,
      payload: "x".repeat(100),
    })),
  );
  expect(sends).toBe(0);
  expect(m.phase).toBe("closing");
  expect(interruptions).toEqual([
    ["interrupted", "Match checkpoint exceeded its limit."],
  ]);
});

it("restores a real authority checkpoint during an origin-bearing active special", () => {
  const m = fixture(),
    cp = m.session.capture();
  cp.state.specials[0].cooldownTicks = 0;
  m.session.restore(cp);
  expect(
    m.receive("a", input(m, 1, m.session.getTick() + 1, { special: true })),
  ).toBe(true);
  m.advance();
  const snapshot = m.snapshot("a", m.session.drainEvents());
  expect(snapshot.checkpoint.state.specials[0].active?.origin).toMatchObject({
    participantId: "a",
    seq: 1,
  });
  const replica = fixture().session;
  replica.restore(decodeSnapshot(encodeSnapshot(snapshot)).checkpoint);
  expect(replica.capture()).toEqual(snapshot.checkpoint);
});

it("coalesces repeated resumes into one lifecycle revision and no immediate checkpoints", async () => {
  const { CryptballRoom } = await import("../../cryptball-server/src/room");
  const m = fixture();
  m.suspend("a", true);
  const revision = m.session.getControllerRevision("a")!,
    dirty = m.lobbyRevision;
  const room = Object.create(CryptballRoom.prototype) as any;
  room.authority = m;
  let captures = 0,
    sends = 0;
  const original = m.session.capture.bind(m.session);
  m.session.capture = () => {
    captures++;
    return original();
  };
  room.sendSnapshot = () => sends++;
  for (let i = 0; i < 60; i++) room.resumePeer({ sessionId: "a" });
  expect(captures).toBe(0);
  expect(sends).toBe(0);
  expect(m.session.getControllerRevision("a")).toBe(revision + 1);
  expect(m.lobbyRevision).toBe(dirty + 1);
  expect(m.peers.get("a")!.active).toBe(true);
});
