import { describe, it, expect } from "vitest";
import {
  createCryptballSession,
  SPORT_IDS,
  createInitialState,
  stepState,
} from "../sim/session";
import { DeterministicRandom } from "@onepage/game-simulation/random";
import { admitAction, resolveStrikes, finishActions } from "../sim/actions";
import { moveBall } from "../sim/ball";
import {
  FIXED as F,
  RULES,
  aimHeading,
  headingVector,
  length,
  integerSqrt,
} from "../sim/rules";
const participants = [
  { id: "a", team: 0 as const, playerId: "player-0" },
  { id: "b", team: 1 as const, playerId: "player-2" },
];
const random = () =>
  new DeterministicRandom([{ owner: "cryptball", name: "ai", seed: 42 }]);
function fixture() {
  const s = createInitialState();
  s.phase = "play";
  s.players.forEach((p, i) => {
    p.x = (-100 + i * 60) * F;
    p.y = 60 * F;
  });
  return s;
}
describe("integer root exact refinement", () => {
  it("matches exact BigInt reference around boundaries across the safe domain", () => {
    for (const root of [
      1, 2, 3, 31, 256, 4095, 65536, 1234567, 16777216, 67108864, 94906265,
    ])
      for (const offset of [-1, 0, 1]) {
        const n = root * root + offset;
        if (n < 0 || !Number.isSafeInteger(n)) continue;
        const result = integerSqrt(n),
          big = BigInt(n),
          r = BigInt(result);
        expect(r * r <= big && (r + 1n) * (r + 1n) > big).toBe(true);
      }
  });
});
describe("multiplayer simulation", () => {
  it("advances both teams and cancels only the requesting participant", () => {
    const session = createCryptballSession();
    session.setParticipants(participants);
    const cp = session.capture();
    cp.state.phase = "play";
    cp.state.players[0].charging = cp.state.players[2].charging = true;
    cp.state.players[0].chargeTicks = cp.state.players[2].chargeTicks = 12;
    session.restore(cp);
    session.stepParticipants({
      a: { cancel: true },
      b: { moveX: -1, strikeHeld: true },
    });
    const after = session.capture();
    expect(after.state.tick).toBe(1);
    expect(after.state.players[0].charging).toBe(false);
    expect(after.state.players[2].charging).toBe(true);
    expect(after.state.players[2].chargeTicks).toBe(13);
    expect(after.state.players[2].vx).toBeLessThan(0);
  });
  it("freezes switch privilege and never steals a disconnected human teammate", () => {
    const session = createCryptballSession();
    session.setParticipants([
      ...participants,
      { id: "c", team: 0, playerId: "player-1" },
    ]);
    session.setParticipantActive("c", false);
    session.stepParticipants({ a: { switch: true } });
    expect(session.observeFor("a").controlledId).toBe("player-0");
    expect(
      session.capture().state.controllers.find((c) => c.id === "c")?.playerId,
    ).toBe("player-1");
  });
  it("switches team one to a bot teammate without affecting team zero", () => {
    const session = createCryptballSession();
    session.setParticipants(participants);
    session.stepParticipants({ b: { switch: true } });
    expect(session.observeFor("b").controlledId).toBe("player-3");
    expect(session.observeFor("a").controlledId).toBe("player-0");
  });
  it.each(SPORT_IDS)("%s restores active charge, buffers, AI and RNG for identical continuation", (sportId) => {
    const session = createCryptballSession({ sportId, seed: 42 });
    session.setParticipants(sportId === "crypt-guardian" ? [participants[0], {id:"b",team:0,playerId:"player-1"}] : participants);
    for (let t = 0; t < 78; t++)
      session.stepParticipants({
        a: { strikePressed: t === 65, strikeHeld: t >= 65, moveX: 1 },
        b: { guard: true, aim: 128 },
      });
    const checkpoint = session.capture();
    for (let t = 0; t < 90; t++)
      session.stepParticipants({
        a: { strikeHeld: t < 9, strikeReleased: t === 9 },
        b: { moveY: 1 },
      });
    const expected = session.capture();
    session.restore(checkpoint);
    for (let t = 0; t < 90; t++)
      session.stepParticipants({
        a: { strikeHeld: t < 9, strikeReleased: t === 9 },
        b: { moveY: 1 },
      });
    expect(session.capture()).toEqual(expected);
  });
  it.each(SPORT_IDS)("%s adopts an authoritative seed and continues identical RNG draws", (sportId) => {
    const authority = createCryptballSession({ sportId, seed: 7 }),
      replica = createCryptballSession({ seed: 99 });
    authority.setParticipants(sportId === "crypt-guardian" ? [participants[0], {id:"b",team:0,playerId:"player-1"}] : participants);
    for (let tick = 0; tick < 140; tick++)
      authority.stepParticipants({ a: { moveX: 1 }, b: { moveY: -1 } });
    replica.restore(authority.capture());
    for (let tick = 0; tick < 60; tick++) {
      authority.stepParticipants({ a: { pass: true }, b: { moveX: -1 } });
      replica.stepParticipants({ a: { pass: true }, b: { moveX: -1 } });
    }
    expect(replica.capture()).toEqual(authority.capture());
  });
  it("rejects malformed checkpoint and RNG atomically", () => {
    const session = createCryptballSession();
    const before = session.capture();
    const bad = structuredClone(before);
    bad.state.players[0].x = NaN;
    expect(() => session.restore(bad)).toThrow();
    expect(session.capture()).toEqual(before);
    const badRng = structuredClone(before);
    (badRng.rng.streams[0] as { state: number }).state = 5;
    expect(() => session.restore(badRng)).toThrow();
    expect(session.capture()).toEqual(before);
  });
  it("tracks real pass contact, completes once on receiver body contact and preserves other human ownership", () => {
    const s = fixture(),
      p = s.players[0],
      q = s.players[1];
    p.x = 0;
    p.y = 0;
    q.x = 20 * F;
    q.y = 0;
    s.ball.x = 10 * F;
    s.ball.y = 0;
    p.heading = 0;
    admitAction(s, p, { pass: true });
    p.action!.elapsed = 3;
    resolveStrikes(s);
    expect(s.ball.passFrom).toBe(p.id);
    expect(s.controllers[0].pendingSwitch).toBe(q.id);
    const events: Record<string, unknown>[] = [];
    for (let t = 0; t < 8; t++)
      moveBall(s.ball, [{ player: q, x: q.x, y: q.y, dx: 0, dy: 0 }], t, (e) =>
        events.push(e),
      );
    expect(events.filter((e) => e.type === "pass-complete")).toHaveLength(1);
    expect(s.ball.passFrom).toBeNull();
  });
  it("holds a ready Cryptbreaker until release and cannot release twice", () => {
    const s = fixture(),
      p = s.players[0];
    admitAction(s, p, { strikePressed: true, strikeHeld: true });
    for (let t = 1; t < 24; t++) admitAction(s, p, { strikeHeld: true });
    expect(p.action).toBeNull();
    expect(p.chargeTicks).toBe(24);
    expect(s.events.filter((e) => e.type === "charge-ready")).toHaveLength(1);
    for (let t = 24; t < 600; t++) admitAction(s, p, { strikeHeld: true });
    expect(p.action).toBeNull();
    expect(p.chargeTicks).toBe(24);
    admitAction(s, p, { strikeReleased: true });
    expect(p.action?.charge).toBe(24);
    const id = p.action!.id;
    admitAction(s, p, { strikeHeld: true });
    expect(p.action?.id).toBe(id);
  });
  it("consumes powered restitution only at first long board and player touch clears it", () => {
    const s = fixture(),
      b = s.ball;
    b.y = 92 * F;
    b.vy = 380 * F;
    b.bankBonusRemaining = 1;
    b.powerTeam = 0;
    b.powerActionKey = 7;
    b.powerExpires = 60;
    const events: string[] = [];
    moveBall(b, [], 1, (e) => events.push(e.type));
    expect(events).toContain("power-bank");
    expect(b.bankBonusRemaining).toBe(0);
    expect(b.vy).toBeLessThan(0);
    expect(Math.abs(b.vy)).toBe(Math.round(380 * F * 0.98));
  });
  it("side-board power expiry and opponent pass interception clear the tracked properties", () => {
    const s = fixture(),
      p = s.players[2],
      b = s.ball;
    p.x = p.y = 0;
    b.x = -12 * F;
    b.y = 0;
    b.vx = 250 * F;
    b.passFrom = "player-0";
    b.passTarget = "player-1";
    b.passTeam = 0;
    b.powerTeam = 0;
    b.bankBonusRemaining = 1;
    b.powerActionKey = 1;
    b.powerExpires = 60;
    for (let t = 0; t < 6; t++)
      moveBall(b, [{ player: p, x: 0, y: 0, dx: 0, dy: 0 }], t, () => {});
    expect(b.passFrom).toBeNull();
    expect(b.bankBonusRemaining).toBe(0);
    b.x = 0;
    b.y = 92 * F;
    b.vx = 0;
    b.vy = 380 * F;
    b.bankBonusRemaining = 1;
    b.powerExpires = 60;
    const events: string[] = [];
    moveBall(b, [], 60, (e) => events.push(e.type));
    expect(events).not.toContain("power-bank");
    expect(Math.abs(b.vy)).toBe(Math.round(380 * F * 0.9));
  });
  it("expires pass tracking on the ninetieth tick", () => {
    const s = fixture();
    s.tick = 89;
    s.ball.passFrom = "player-0";
    s.ball.passTarget = "player-1";
    s.ball.passTeam = 0;
    s.ball.passTick = 0;
    stepState(s, {}, random());
    expect(s.tick).toBe(90);
    expect(s.ball.passFrom).toBeNull();
    expect(s.ball.passTarget).toBeNull();
  });
  it("literal headings and roots produce bounded deterministic vectors", () => {
    for (let i = 0; i < 256; i++) {
      const d = headingVector(i);
      expect(aimHeading(d.x, d.y)).toBe(i);
      expect(length(d.x, d.y)).toBeGreaterThan(65534);
    }
  });
});
