import { COURT } from "../sim/spec";
import { describe, it, expect } from "vitest";
import { DeterministicRandom } from "@onepage/game-simulation/random";
import {
  createInitialState,
  stepState,
  createCryptballSession,
} from "../src/session";
import { movePlayers } from "../src/motion";
import { moveBall } from "../src/ball";
import { admitAction, resolveStrikes, resolveChecks } from "../src/actions";
import {
  projectCourt,
  unprojectCourt,
  screenVectorToWorld,
} from "../src/projection";
import { FIXED as F, RULES } from "../src/rules";
const random = () =>
  new DeterministicRandom([{ owner: "cryptball", name: "ai", seed: 42 }]);
function fixture() {
  const s = createInitialState("match");
  s.phase = "play";
  s.players.forEach((p, i) => {
    p.x = (-100 + i * 60) * F;
    p.y = 60 * F;
  });
  return s;
}
describe("Cryptball authority", () => {
  it("banks at equal reflection angle with board restitution", () => {
    const s = fixture(),
      b = s.ball;
    b.x = 0;
    b.y = (92.9 * F) | 0;
    b.vx = 120 * F;
    b.vy = 120 * F;
    moveBall(b, [], 0, () => {});
    expect(b.vx).toBe(120 * F);
    expect(b.vy).toBe(-108 * F);
  });
  it("sweeps a post at max speed without tunnelling", () => {
    const s = fixture(),
      b = s.ball;
    b.x = 160 * F;
    b.y = 30 * F;
    b.vx = RULES.maxBallSpeed;
    moveBall(b, [], 0, () => {});
    expect(b.vx).toBeLessThan(0);
    expect(b.x).toBeLessThan(160 * F);
  });
  it("escapes a moving-player corner pinch without exhausting contacts", () => {
    const s = fixture(),
      p = s.players[0],
      b = s.ball;
    p.x = -135.5 * F;
    p.y = Math.round(68.47 * F);
    p.vx = 30 * F;
    p.vy = 92 * F;
    b.x = Math.round(-140.95 * F);
    b.y = Math.round(92.98 * F);
    b.vx = -44 * F;
    b.vy = 69 * F;
    const events: string[] = [];
    for (let i = 0; i < 480; i++) {
      p.vx = 30 * F;
      p.vy = 92 * F;
      const paths = movePlayers([p], b);
      moveBall(b, paths, i, (e) => events.push(e.type));
    }
    expect(events).not.toContain("diagnostic");
    expect(b.x).toBeLessThanOrEqual((COURT.halfLength - 3) * F + 1);
    expect(b.y).toBeLessThanOrEqual((COURT.halfWidth - 3) * F + 1);
    b.vx = 250 * F;
    b.vy = -100 * F;
    for (let i = 0; i < 120; i++)
      moveBall(b, movePlayers([p], b), i, (e) => events.push(e.type));
    expect(events).not.toContain("diagnostic");
    expect(Math.hypot(b.x + 140.95 * F, b.y - 92.98 * F)).toBeGreaterThan(
      10 * F,
    );
    const a = s.players[1],
      q = s.players[2];
    a.x = Math.round(-108.035 * F);
    a.y = Math.round(13.039 * F);
    q.x = Math.round(-93.953 * F);
    q.y = Math.round(27.512 * F);
    b.x = Math.round(-100.105 * F);
    b.y = Math.round(19.414 * F);
    b.vx = -220 * F;
    b.vy = -100 * F;
    events.length = 0;
    for (let i = 0; i < 240; i++) {
      a.vx = 11 * F;
      a.vy = 71 * F;
      q.vx = -19 * F;
      q.vy = -70 * F;
      moveBall(b, movePlayers([a, q], b), i, (e) => events.push(e.type));
    }
    expect(events).not.toContain("diagnostic");
  });
  it("scores whole-ball crossing once and excludes post clipping", () => {
    const s = fixture(),
      b = s.ball;
    b.x = 168 * F;
    b.y = 0;
    b.vx = RULES.maxBallSpeed;
    expect(moveBall(b, [], 0, () => {})).toBe(0);
    const t = fixture();
    t.ball.x = 162 * F;
    t.ball.y = 27 * F;
    t.ball.vx = RULES.maxBallSpeed;
    expect(moveBall(t.ball, [], 0, () => {})).toBeNull();
    expect(t.ball.vx).toBeLessThan(0);
    const rng = random();
    s.ball.x = 168 * F;
    stepState(s, {}, rng);
    expect(s.score).toEqual([1, 0]);
    for (let i = 0; i < 5; i++) stepState(s, {}, rng);
    expect(s.score).toEqual([1, 0]);
  });
  it("credits own goals by the goal entered", () => {
    const s = fixture();
    s.ball.x = -168 * F;
    s.ball.vx = -350 * F;
    s.ball.lastTouch = "player-0";
    stepState(s, {}, random());
    expect(s.score).toEqual([0, 1]);
  });
  it("counts final-tick goals, enters overtime on tie, and ends sudden death", () => {
    const s = fixture();
    s.remainingTicks = 1;
    s.ball.x = 168 * F;
    s.ball.vx = 350 * F;
    const rng = random();
    stepState(s, {}, rng);
    expect(s.score[0]).toBe(1);
    expect(s.remainingTicks).toBe(0);
    for (let i = 0; i < 54; i++) stepState(s, {}, rng);
    expect(s.phase).toBe("results");
    const t = fixture();
    t.remainingTicks = 1;
    stepState(t, {}, rng);
    expect(t.overtime).toBe(true);
    expect(t.phase).toBe("ready");
    for (let i = 0; i < 60; i++) stepState(t, {}, rng);
    t.ball.x = 168 * F;
    t.ball.vx = RULES.maxBallSpeed;
    stepState(t, {}, rng);
    expect(t.phase).toBe("results");
    expect(t.winner).toBe(0);
  });
  it("claims the ball only once per swing", () => {
    const s = fixture(),
      p = s.players[0];
    p.x = 0;
    p.y = 0;
    p.heading = 0;
    s.ball.x = 15 * F;
    s.ball.y = 0;
    admitAction(s, p, { strikePressed: true, strikeReleased: true });
    p.action!.elapsed = 4;
    resolveStrikes(s);
    expect(s.stats.shots).toBe(1);
    s.ball.vx = 0;
    resolveStrikes(s);
    expect(s.stats.shots).toBe(1);
    expect(s.ball.vx).toBe(0);
  });
  it("holds full charge indefinitely and releases exactly once on input", () => {
    const s = fixture(), p = s.players[0];
    admitAction(s, p, { strikePressed: true, strikeHeld: true });
    for (let i = 1; i < 3600; i++) admitAction(s, p, { strikeHeld: true });
    expect(p.action).toBeNull();
    expect(p.charging).toBe(true);
    expect(p.chargeTicks).toBe(RULES.chargeCap);
    expect(s.events.filter((e) => e.type === "charge-ready")).toHaveLength(1);
    admitAction(s, p, { strikeReleased: true });
    expect(p.action?.charge).toBe(RULES.chargeCap);
    const id = p.action!.id;
    admitAction(s, p, {});
    expect(p.action?.id).toBe(id);
    expect(s.events.filter((e) => e.type === "swing")).toHaveLength(1);
  });
  it("gives switch priority over dash, pass and strike and dash over pass", () => {
    const s = fixture();
    stepState(
      s,
      {
        switch: true,
        dash: true,
        pass: true,
        strikePressed: true,
        strikeReleased: true,
      },
      random(),
    );
    const p = s.players.find((p) => p.id === s.controlledId)!;
    expect(s.controlledId).toBe("player-1");
    expect(p.dashTicks).toBe(0);
    expect(p.action).toBeNull();
    const t = fixture(),
      q = t.players[0];
    admitAction(t, q, { dash: true, pass: true, strikePressed: true });
    expect(q.dashTicks).toBe(10);
    expect(q.action).toBeNull();
  });
  it("switches after a successful pass while leaving a whiff alone", () => {
    const s = fixture(),
      p = s.players[0],
      q = s.players[1];
    p.x = 0;
    p.y = 0;
    q.x = 60 * F;
    q.y = 0;
    s.ball.x = 15 * F;
    s.ball.y = 0;
    admitAction(s, p, { pass: true });
    p.action!.elapsed = 4;
    resolveStrikes(s);
    expect(s.controllers[0].pendingSwitch).toBe(q.id);
    stepState(s, {}, random());
    expect(s.controlledId).toBe(q.id);
    const t = fixture();
    admitAction(t, t.players[0], { pass: true });
    t.players[0].action!.elapsed = 4;
    resolveStrikes(t);
    expect(t.pendingSwitch).toBeNull();
  });
  it("checks one opponent and respects team and immunity", () => {
    const s = fixture(),
      p = s.players[0];
    p.x = p.y = 0;
    p.dashTicks = 10;
    p.dashHeading = 0;
    s.players[1].x = s.players[1].y = 0;
    for (const q of s.players.slice(2)) {
      q.x = 10 * F;
      q.y = 0;
    }
    resolveChecks(s);
    expect(s.players[1].staggerTicks).toBe(0);
    expect(s.players.filter((q) => q.staggerTicks > 0)).toHaveLength(1);
    p.checked = false;
    resolveChecks(s);
    expect(s.players[2].immunityTicks).toBe(36);
    expect(s.players[3].staggerTicks).toBe(10);
    s.players[2].staggerTicks = 0;
    p.checked = false;
    s.players[3].immunityTicks = 36;
    resolveChecks(s);
    expect(s.players[2].staggerTicks).toBe(0);
  });
  it("round trips projection and maps screen up visually up", () => {
    for (const [x, y] of [
      [-144, -80],
      [0, 0],
      [144, 80],
      [31, -19],
    ]) {
      const p = projectCourt(x, y),
        q = unprojectCourt(p.x, p.y);
      expect(q.x).toBeCloseTo(x);
      expect(q.y).toBeCloseTo(y);
    }
    const n = screenVectorToWorld(0, -1),
      a = projectCourt(0, 0),
      b = projectCourt(n.x, n.y);
    expect(b.y).toBeLessThan(a.y);
    expect(b.x).toBeCloseTo(a.x);
    const session = createCryptballSession();
    const o = session.observe();
    o.players[0].x = 999;
    expect(session.observe().players[0].x).not.toBe(999);
  });
});
