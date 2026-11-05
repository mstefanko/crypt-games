import { describe, it, expect } from "vitest";
import { MatchAuthority } from "../../cryptball-server/src/model";
import {
  encodeSnapshot,
  decodeSnapshot,
  validateInput,
  quantizeCommand,
  resolveSportId,
} from "../protocol";
import {
  SPORT_IDS,
  type SportId,
  createCryptballSession,
} from "../sim/session";
function playing(count = 2, sportId: SportId = "cryptball") {
  const m = new MatchAuthority("test", false, sportId);
  for (let i = 0; i < count; i++) {
    m.join(`p${i}`, `Guest ${i}`);
    m.ready(`p${i}`);
  }
  if (count < 4) m.start();
  for (let i = 0; i < 180; i++) m.advance();
  return m;
}
function packet(
  m: MatchAuthority,
  id = "p0",
  seq = 1,
  tick = m.session.observe().tick + 1,
) {
  return {
    epoch: m.epoch,
    generation: m.peers.get(id)!.generation,
    seq,
    tick,
    revision: m.session.capture().state.controllers.find((c) => c.id === id)!
      .revision,
    command: { moveX: 1 },
  };
}
describe("online authority", () => {
  it("assigns opposing teams then fills four field seats in 2v2 and starts only ready humans", () => {
    const m = new MatchAuthority("test");
    m.join("a", "a");
    expect(m.session.observeFor("a").controlledId).toBe("player-0");
    m.ready("a");
    expect(m.start()).toBe(false);
    m.join("b", "b");
    expect(m.start()).toBe(false);
    m.ready("b");
    expect(m.start()).toBe(true);
    expect(m.lobby().seats.map((p) => p.team)).toEqual([0, 1]);
    const four = playing(4);
    expect(four.phase).toBe("playing");
    expect(four.lobby().seats.map((p) => p.playerId)).toEqual([
      "player-0",
      "player-2",
      "player-1",
      "player-3",
    ]);
    expect(() => four.join("fifth", "5")).toThrow();
  });
  it("preserves private field seats through drop, reconnect and vacancies", () => {
    const m = new MatchAuthority("private", true);
    for (let i = 0; i < 4; i++) {
      m.join(`p${i}`, `Guest ${i}`);
      m.ready(`p${i}`);
    }
    expect(m.phase).toBe("countdown");
    expect(m.capacity).toBe(4);
    expect(m.lobby().seats.every((p) => p.role === "field")).toBe(true);
    for (let i = 0; i < 180; i++) m.advance();
    m.drop("p2");
    expect(
      m.session.capture().state.controllers.find((c) => c.id === "p2")?.active,
    ).toBe(false);
    m.reconnect("p2");
    m.suspend("p2", false);
    expect(m.peers.get("p2")?.playerId).toBe("player-1");
    const waiting = new MatchAuthority("waiting");
    waiting.join("a", "a");
    waiting.join("b", "b");
    waiting.join("c", "c");
    waiting.remove("a");
    expect(waiting.peers.get("c")?.playerId).toBe("player-1");
    expect(waiting.join("d", "d").playerId).toBe("player-0");
  });
  it("cancels countdown on departure and preserves server tick under flooding", () => {
    const m = playing();
    const tick = m.session.observe().tick;
    for (let i = 1; i <= 1000; i++) m.receive("p0", packet(m, "p0", i));
    expect(m.session.observe().tick).toBe(tick);
    expect(m.peers.get("p0")!.queue.length).toBeLessThanOrEqual(16);
    m.advance();
    expect(m.session.observe().tick).toBe(tick + 1);
  });
  it("rejects stale generation, revision, epoch and invalid inputs", () => {
    const m = playing(),
      p = packet(m);
    expect(m.receive("p0", { ...p, epoch: 0 })).toBe(false);
    expect(m.receive("p0", { ...p, revision: 99 })).toBe(false);
    expect(m.receive("p0", { ...p, generation: 99 })).toBe(false);
    expect(m.receive("p0", { ...p, tick: -1 })).toBe(false);
    expect(m.receive("p0", p)).toBe(true);
    expect(m.receive("p0", p)).toBe(false);
    expect(validateInput({ ...p, command: { moveX: NaN } })).toBeNull();
    expect(
      validateInput({ ...p, command: { playerId: "player-3" } }),
    ).toBeNull();
  });
  it("covers silence and menu with a bot and requires fresh generation after reconnect", () => {
    const m = playing();
    for (let i = 0; i < 31; i++) m.advance();
    expect(m.peers.get("p0")!.active).toBe(false);
    m.suspend("p0", false);
    expect(m.peers.get("p0")!.active).toBe(true);
    m.suspend("p0", true);
    expect(m.peers.get("p0")!.active).toBe(false);
    const generation = m.peers.get("p0")!.generation;
    m.drop("p0");
    m.reconnect("p0");
    expect(m.peers.get("p0")!.generation).toBe(generation + 1);
    expect(m.peers.get("p0")!.suspended).toBe(true);
  });
  it("atomically encodes tick, checkpoint, ack and RNG within the target budget", () => {
    const m = playing();
    m.receive("p0", packet(m));
    m.advance();
    const snapshot = m.snapshot("p0", m.session.drainEvents()),
      bytes = encodeSnapshot(snapshot),
      decoded = decodeSnapshot(bytes);
    expect(decoded.tick).toBe(decoded.checkpoint.state.tick);
    expect(decoded.ack).toBe(1);
    expect(decoded.checkpoint.rng).toEqual(snapshot.checkpoint.rng);
    expect(bytes.byteLength).toBeLessThanOrEqual(6144);
    const before = m.session.capture();
    expect(() =>
      m.session.restore({
        ...decoded.checkpoint,
        state: { ...decoded.checkpoint.state, tick: -1 },
      }),
    ).toThrow();
    expect(m.session.capture()).toEqual(before);
  });
  it("preserves quantized projected movement and rejects stale queued ownership", () => {
    const m = playing();
    const input = {
      ...packet(m),
      command: quantizeCommand({ moveX: 0.707106, moveY: -0.707106 }),
    };
    expect(validateInput(input)).not.toBeNull();
    expect(input.command.moveX).toBeGreaterThan(0.7);
    expect(m.receive("p0", input)).toBe(true);
    const before = m.session
      .observeFor("p0")
      .players.find((p) => p.id === "player-0")!.x;
    m.session.setParticipantActive("p0", false);
    m.session.setParticipantActive("p0", true);
    m.advance();
    expect(
      m.session.observeFor("p0").players.find((p) => p.id === "player-0")!.x,
    ).toBe(before);
  });
  it("resets epoch and input generations on a unanimous rematch", () => {
    const m = playing();
    m.phase = "results";
    const old = m.epoch;
    m.rematch("p0");
    expect(m.phase).toBe("results");
    m.rematch("p1");
    expect(m.phase).toBe("waiting");
    expect(m.epoch).toBe(old + 1);
    expect(m.snapshot("p0", []).checkpoint.state.epoch).toBe(m.epoch);
    expect(m.peers.get("p0")!.queue).toEqual([]);
    expect(m.peers.get("p0")!.ready).toBe(false);
  });
});

describe("sport-specific online authority", () => {
  it("retains a frozen neutral hockey faceoff after the room countdown", () => {
    const match = playing(2, "cryptcheck");
    const faceoff = match.session.capture();
    expect(faceoff.state.phase).toBe("ready");
    expect(faceoff.state.hockey?.faceoffLead).toHaveLength(2);
    expect(faceoff.state.possessionId).toBeNull();
    expect(faceoff.state.restartProtection).toBe(0);
    expect(faceoff.state.ball.x).toBe(0);
    expect(faceoff.state.ball.y).toBe(0);
    expect(
      match.receive("p0", {
        ...packet(match),
        command: {
          moveX: 1,
          strikePressed: true,
          strikeHeld: true,
          special: true,
          slide: true,
        },
      }),
    ).toBe(true);
    match.advance();
    const after = match.session.capture();
    expect(after.state.remainingTicks).toBe(faceoff.state.remainingTicks);
    expect(after.state.players.map(({ x, y }) => [x, y])).toEqual(
      faceoff.state.players.map(({ x, y }) => [x, y]),
    );
    expect(
      after.state.players.every(
        (player) => !player.action && !player.charging && !player.slideTicks,
      ),
    ).toBe(true);
    expect(
      after.state.specials.every((special) => special.active === null),
    ).toBe(true);
  });
  it("defaults to Cryptball and rejects unknown sports", () => {
    expect(resolveSportId(undefined)).toBe("cryptball");
    for (const invalid of [null, "soccer", "", 1, {}])
      expect(() => resolveSportId(invalid)).toThrow("Unknown sport");
    expect(
      () => new MatchAuthority("bad", false, "soccer" as SportId),
    ).toThrow();
  });
  it.each(SPORT_IDS)(
    "preserves %s through authority, bot coverage, checkpoint replay, reconnect and rematch",
    (sportId) => {
      const match = playing(2, sportId);
      expect(match.lobby().sportId).toBe(sportId);
      expect(match.session.observe().sportId).toBe(sportId);
      const owned = match.peers.get("p0")!.playerId;
      match.drop("p0");
      for (let tick = 0; tick < 120; tick++) match.advance();
      expect(match.peers.get("p0")!.active).toBe(false);
      const snapshot = decodeSnapshot(encodeSnapshot(match.snapshot("p1", [])));
      expect(snapshot.sportId).toBe(sportId);
      const replay = createCryptballSession();
      replay.restore(snapshot.checkpoint);
      expect(replay.observe().sportId).toBe(sportId);
      expect(replay.observe().ball.z).toBe(snapshot.checkpoint.state.ball.z);
      match.reconnect("p0");
      match.suspend("p0", false);
      expect(match.peers.get("p0")!.playerId).toBe(owned);
      expect(match.session.observeFor("p0").sportId).toBe(sportId);
      match.suspend("p0", true);
      match.suspend("p1", true);
      const restored = createCryptballSession();
      restored.restore(match.session.capture());
      for (let tick = 0; tick < 60; tick++) {
        match.advance();
        restored.stepParticipants({});
      }
      expect(restored.capture()).toEqual(match.session.capture());
      match.phase = "results";
      match.rematch("p0");
      match.rematch("p1");
      expect(match.session.observe().sportId).toBe(sportId);
      expect(match.lobby().sportId).toBe(sportId);
    },
  );
  it("rejects a checkpoint envelope with a mismatched sport", () => {
    const match = playing(2, "cryptkick");
    const snapshot = match.snapshot("p0", []);
    expect(() =>
      decodeSnapshot(encodeSnapshot({ ...snapshot, sportId: "rift-volley" })),
    ).toThrow("Invalid checkpoint envelope");
  });
});
