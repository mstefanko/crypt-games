import { aiCommands } from "../sim/team-ai";
import { predictBall } from "../sim/prediction";
import { DeterministicRandom } from "@onepage/game-simulation/random";
import { describe, it, expect } from "vitest";
import { createCryptballSession, createInitialState } from "../sim/session";
import {
  admitAction,
  finishActions,
  selectPassTarget,
  resolveChecks,
} from "../sim/actions";
import { moveBall } from "../sim/ball";
import { COURT, ROSTER } from "../sim/spec";
import {
  FIXED as F,
  RULES,
  headingVector,
  length,
  normalized,
} from "../sim/rules";

describe("next pass simulation", () => {
  it("fills two field players per team and switches to the only teammate", () => {
    const s = createCryptballSession();
    expect(s.observe().players.map((p) => [p.team, p.role])).toEqual([
      [0, "field"],
      [0, "field"],
      [1, "field"],
      [1, "field"],
    ]);
    for (let i = 0; i < 80; i++) s.step({ switch: true });
    expect(
      s.observe().players.find((p) => p.id === s.observe().controlledId)?.role,
    ).toBe("field");
    expect(ROSTER.seatOrder).toEqual([0, 2, 1, 3]);
  });
  it("accepts four human seats and atomically rejects old six-player checkpoints", () => {
    const session = createCryptballSession();
    const roster = session.observe().players;
    session.setParticipants(
      roster.map((p) => ({ id: p.id, playerId: p.id, team: p.team })),
    );
    expect(session.capture().state.controllers).toHaveLength(4);
    expect(session.capture().version).toBe(16);
    const before = session.capture(),
      old = structuredClone(before) as unknown as { version: number };
    old.version = 3;
    expect(() => session.restore(old)).toThrow("Incompatible checkpoint");
    expect(session.capture()).toEqual(before);
    const bad = structuredClone(before);
    bad.state.players[2].role = "keeper";
    expect(() => session.restore(bad)).toThrow("Invalid athlete");
    expect(session.capture()).toEqual(before);
  });
  it("locks slide heading, enforces recovery and shares the dash lockout", () => {
    const s = createInitialState(),
      p = s.players[0];
    admitAction(s, p, { slide: true, moveY: 1 });
    expect(p.slideTicks).toBe(18);
    expect(p.slideHeading).toBe(64);
    admitAction(s, p, { aim: 128, dash: true, pass: true });
    expect(p.slideHeading).toBe(64);
    expect(p.dashTicks).toBe(0);
    expect(p.action).toBeNull();
    for (let i = 0; i < 18; i++) {
      s.tick++;
      finishActions(s);
    }
    expect(p.slideRecovery).toBe(15);
    admitAction(s, p, { pass: true, dash: true });
    expect(p.action).toBeNull();
    expect(p.dashTicks).toBe(0);
    const q = s.players[1];
    admitAction(s, q, { dash: true });
    q.dashTicks = 0;
    s.tick += 10;
    admitAction(s, q, { slide: true });
    expect(q.slideTicks).toBe(0);
  });
  it("intercepts max-speed shots across every authored slide heading", () => {
    for (let heading = 0; heading < 256; heading++) {
      const s = createInitialState(),
        p = s.players[0],
        b = s.ball,
        v = headingVector(heading),
        normal = headingVector(heading + 64);
      p.x = p.y = 0;
      p.slideHeading = heading;
      p.slideTicks = 18;
      // Cross the leading circle from a perpendicular shot, away from body center.
      const cx = Math.round((v.x * 8 * F) / 65536),
        cy = Math.round((v.y * 8 * F) / 65536);
      b.x = cx + Math.round((normal.x * 12 * F) / 65536);
      b.y = cy + Math.round((normal.y * 12 * F) / 65536);
      b.vx = -Math.round((normal.x * RULES.maxBallSpeed) / 65536);
      b.vy = -Math.round((normal.y * RULES.maxBallSpeed) / 65536);
      const events: string[] = [];
      for (let i = 0; i < 12; i++)
        moveBall(b, [{ player: p, x: 0, y: 0, dx: 0, dy: 0 }], i, (e) =>
          events.push(e.type),
        );
      expect(events, `heading ${heading}`).toContain("slide-contact");
      expect(length(b.vx, b.vy)).toBeLessThanOrEqual(160 * F + 1);
    }
  });
  it("never creates ball energy on a slow slide contact", () => {
    const s = createInitialState(),
      p = s.players[0],
      b = s.ball;
    p.x = p.y = 0;
    p.slideHeading = 0;
    p.slideTicks = 18;
    b.x = 8 * F;
    b.y = 8 * F;
    b.vy = -20 * F;
    const before = b.vy * b.vy;
    for (let i = 0; i < 5; i++)
      moveBall(b, [{ player: p, x: 0, y: 0, dx: 0, dy: 0 }], i, () => {});
    expect(b.vx * b.vx + b.vy * b.vy).toBeLessThanOrEqual(before);
  });
  it("does not kick a resting orb when sliding through the full authority tick", () => {
    const session = createCryptballSession();
    session.setParticipants(
      session
        .observe()
        .players.map((p) => ({ id: p.id, playerId: p.id, team: p.team })),
    );
    const cp = session.capture();
    cp.state.phase = "play";
    const p = cp.state.players[0];
    p.x = 0;
    p.y = 0;
    p.heading = 0;
    cp.state.ball.x = 12 * F;
    cp.state.ball.y = 0;
    session.restore(cp);
    for (let i = 0; i < 5; i++)
      session.stepParticipants({ "player-0": { slide: i === 0, moveX: 1 } });
    expect(length(session.observe().ball.vx, session.observe().ball.vy)).toBe(
      0,
    );
  });
  it("resolves simultaneous sliding contacts in stable player order without a motor", () => {
    function run() {
      const s = createInitialState(),
        a = s.players[0],
        b = s.players[3];
      a.x = -10 * F;
      a.y = 0;
      a.slideTicks = 18;
      a.slideHeading = 0;
      a.vx = 300 * F;
      b.x = 10 * F;
      b.y = 0;
      b.slideTicks = 18;
      b.slideHeading = 128;
      b.vx = -300 * F;
      s.ball.x = 0;
      s.ball.y = 7 * F;
      s.ball.vy = -20 * F;
      const events: string[] = [];
      for (let i = 0; i < 16; i++)
        moveBall(
          s.ball,
          [
            { player: a, x: a.x, y: a.y, dx: 0, dy: 0 },
            { player: b, x: b.x, y: b.y, dx: 0, dy: 0 },
          ],
          i,
          (e) => events.push(`${e.type}:${e.playerId}`),
        );
      expect(length(s.ball.vx, s.ball.vy)).toBeLessThanOrEqual(20 * F);
      expect(events.some((e) => e.startsWith("slide-contact"))).toBe(true);
      return { ball: s.ball, events };
    }
    expect(run()).toEqual(run());
  });
  it("passes to the only teammate regardless of aim and never selects an opponent", () => {
    const s = createInitialState(),
      p = s.players[0],
      teammate = s.players[1];
    p.x = p.y = 0;
    teammate.x = 60 * F;
    teammate.y = 0;
    s.players[2].x = 0;
    s.players[2].y = 10 * F;
    for (const heading of [0, 64, 128, 192])
      expect(selectPassTarget(s, p, heading)?.id).toBe(teammate.id);
    admitAction(s, p, { pass: true, aim: 64 });
    expect(p.action?.targetId).toBe(teammate.id);
  });
  it("launches bot slides toward the predicted intercept rather than a tactical waypoint", () => {
    const s = createInitialState(),
      p = s.players[1];
    s.tick = 100;
    p.x = 50 * F;
    p.y = 0;
    p.aiNext = 0;
    s.ball.x = 0;
    s.ball.y = 0;
    s.ball.vx = 200 * F;
    const predicted = predictBall(s.ball, 45, s.tick).find(
      (f) =>
        f.tick >= 6 &&
        f.tick <= 20 &&
        length(p.x - f.x, p.y - f.y) <
          (18 + (s.config.slideLaunchSpeed * f.tick) / 60) * F,
    )!;
    const expected = normalized(predicted.x - p.x, predicted.y - p.y);
    const c = aiCommands(
      s,
      new DeterministicRandom([{ owner: "cryptball", name: "ai", seed: 42 }]),
    ).get(p.id)!;
    expect(c.slide).toBe(true);
    expect(c.moveX).toBe(expected.x);
    expect(c.moveY).toBe(expected.y);
    admitAction(s, p, c);
    expect(p.slideHeading).toBe(128);
  });
  it("keeps a close strike available instead of launching a bot slide", () => {
    const s = createInitialState(),
      p = s.players[1];
    s.tick = 100;
    p.aiNext = 0;
    p.x = 0;
    p.y = 0;
    s.ball.x = 15 * F;
    s.ball.y = 0;
    s.ball.vx = -200 * F;
    const c = aiCommands(
      s,
      new DeterministicRandom([{ owner: "cryptball", name: "ai", seed: 42 }]),
    ).get(p.id)!;
    expect(c.slide).toBe(false);
    expect(c.strikePressed || c.pass).toBe(true);
  });
  it("adds slide recovery only when a check interrupts an active slide", () => {
    const s = createInitialState(),
      p = s.players[0],
      q = s.players[3];
    p.x = p.y = q.y = 0;
    q.x = 10 * F;
    p.dashTicks = 10;
    resolveChecks(s);
    expect(q.slideRecovery).toBe(0);
    expect(q.staggerTicks).toBe(RULES.staggerTicks);
    p.checked = false;
    q.immunityTicks = 0;
    q.slideTicks = 10;
    resolveChecks(s);
    expect(q.slideTicks).toBe(0);
    expect(q.slideRecovery).toBe(15);
  });
  it("uses swept relative player paths for slide checks", () => {
    const s = createInitialState(),
      p = s.players[0],
      q = s.players[3];
    p.slideTicks = 18;
    p.slideHeading = 0;
    p.x = 30 * F;
    p.y = 0;
    q.x = 0;
    q.y = 0;
    resolveChecks(s, [
      { player: p, x: -30 * F, y: 0, dx: 60 * F, dy: 0 },
      { player: q, x: 0, y: 0, dx: 0, dy: 0 },
    ]);
    expect(q.staggerTicks).toBe(RULES.staggerTicks);
  });
  it("serializes tuning for identical replay and rejects invalid overrides atomically", () => {
    const a = createCryptballSession({ config: { slideLaunchSpeed: 240 } }),
      b = createCryptballSession();
    a.step({ slide: true });
    b.restore(a.capture());
    for (let i = 0; i < 120; i++) {
      a.step({ moveX: 1, slide: i === 70 });
      b.step({ moveX: 1, slide: i === 70 });
    }
    expect(a.capture()).toEqual(b.capture());
    const before = b.capture(),
      bad = structuredClone(before);
    bad.state.config.slideLaunchSpeed = 999;
    expect(() => b.restore(bad)).toThrow();
    expect(b.capture()).toEqual(before);
    expect(() =>
      createCryptballSession({ config: { slideEndSpeed: 301 } }),
    ).toThrow();
  });
});
