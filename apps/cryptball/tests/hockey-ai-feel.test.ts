import { describe, expect, it } from "vitest";
import { DeterministicRandom } from "@onepage/game-simulation/random";
import { createCryptballSession, createInitialState, stepState } from "../sim/session";
import type { CommandFrame, State } from "../sim/contract";
import { hockeyAI } from "../sim/modes/cryptcheck/ai";
import { FIXED as F, length } from "../sim/rules";

const random = (seed = 42) =>
  new DeterministicRandom([{ owner: "cryptball", name: "ai", seed }]);
function fixture() {
  const s = createInitialState("match", {}, "cryptcheck");
  s.phase = "play";
  s.phaseTicks = 0;
  s.tick = 100;
  s.controllers = [];
  for (const [i, p] of s.players.entries()) {
    p.x = (i < 2 ? -100 : 100) * F;
    p.y = (i % 2 ? -60 : 60) * F;
    p.vx = p.vy = 0;
  }
  s.ball.x = s.ball.y = 0;
  s.ball.vx = s.ball.vy = 0;
  return s;
}
function human(s: State, index = 0) {
  const p = s.players[index];
  s.controllers = [{ id: "human", team: p.team, playerId: p.id, active: true,
    canSwitch: false, pendingSwitch: null, switchReady: 0, revision: 0 }];
  return p;
}
function mirror(s: State) {
  for (const p of s.players) {
    p.x *= -1;
    p.y *= -1;
    p.vx *= -1;
    p.vy *= -1;
    p.team = p.team === 0 ? 1 : 0;
    p.heading = (p.heading + 128) % 256;
  }
  s.ball.x *= -1;
  s.ball.y *= -1;
  s.ball.vx *= -1;
  s.ball.vy *= -1;
  s.hockey!.aiTeams.reverse();
  for (const intent of s.hockey!.aiTeams)
    intent.approachSide = intent.approachSide === 1 ? -1 : 1;
}

describe("hockey pursuit and spacing", () => {
  it("collects around an idle nearer human instead of reserving pursuit for them", () => {
    const s = fixture(), p = human(s), bot = s.players[1];
    p.x = -24 * F; p.y = 0; p.heading = 128;
    bot.x = -65 * F; bot.y = 0;
    const rng = random();
    let progressed = false;
    for (let t = 0; t < 60; t++) {
      stepState(s, {}, rng, { human: {} });
      progressed ||= s.possessionId === bot.id || length(s.ball.x, s.ball.y) > 10 * F;
    }
    expect(progressed).toBe(true);
  });
  it("respects deliberate human pursuit but hands off after a blocked commitment", () => {
    const s = fixture(), p = human(s), mate = s.players[1], rng = random();
    p.x = -30 * F; p.y = 0;
    mate.x = -60 * F; mate.y = 20 * F;
    const humans = new Map<string, CommandFrame>([[p.id, { moveX: 1 }]]);
    hockeyAI(s, rng, humans);
    expect(s.hockey!.aiTeams[0].collectorId).toBe(p.id);
    // Holding into an obstacle is still input; lack of physical progress ends
    // its claim so the other skater can help without steering the human.
    for (let t = 0; t < 32; t++) { s.tick++; hockeyAI(s, rng, humans); }
    expect(s.hockey!.aiTeams[0].collectorId).toBe(mate.id);
  });
  it("holds a collector through small distance changes rather than swapping every tick", () => {
    const s = fixture(), a = s.players[0], b = s.players[1], rng = random();
    a.x = -50 * F; a.y = 0; b.x = -51 * F; b.y = 0;
    hockeyAI(s, rng);
    const collector = s.hockey!.aiTeams[0].collectorId;
    a.x = -52 * F; b.x = -49 * F; s.tick++;
    hockeyAI(s, rng);
    expect(s.hockey!.aiTeams[0].collectorId).toBe(collector);
  });
  it("elects a fresh receiver after carrying instead of retaining a stale collection commitment", () => {
    const s = fixture(), carrier = s.players[0], receiver = s.players[1], rng = random();
    carrier.x = -30 * F; carrier.y = 0;
    receiver.x = -70 * F; receiver.y = 0;
    hockeyAI(s, rng);
    expect(s.hockey!.aiTeams[0].collectorId).toBe(carrier.id);
    s.possessionId = carrier.id; s.tick += 100;
    hockeyAI(s, rng);
    s.possessionId = null;
    receiver.x = 50 * F; receiver.y = 0;
    s.ball.x = 64 * F;
    s.ball.passTeam = 0; s.ball.passTarget = receiver.id;
    s.ball.passTick = s.tick++;
    hockeyAI(s, rng);
    expect(s.hockey!.aiTeams[0].collectorId).toBe(receiver.id);
  });
  it("uses the open support lane irrespective of player ID and remains goal-side without collection", () => {
    const s = fixture(), carrier = s.players[0], support = s.players[1];
    carrier.x = -20 * F; carrier.y = 0;
    support.x = -60 * F; support.y = 0;
    s.possessionId = carrier.id; s.ball.x = -6 * F;
    // Block the old ID-derived positive-y lane.
    s.players[2].x = 0; s.players[2].y = 30 * F;
    s.players[3].x = 100 * F; s.players[3].y = 60 * F;
    hockeyAI(s, random());
    expect(support.aiRole).toBe("support");
    expect(support.aiY).toBeLessThan(0);
    const defender = s.players.find((p) => p.team === 1 && p.aiRole === "defend-lane")!;
    expect(defender).toBeDefined();
    expect(defender.aiX).toBeGreaterThan(s.ball.x);
  });
  it("chooses legal corner approaches and makes loose-puck progress for mirrored teams across seeds", () => {
    for (const mirrored of [false, true]) for (let seed = 0; seed < 10; seed++) {
      const s = fixture(), p = s.players[0];
      p.x = 112 * F; p.y = 76 * F; p.heading = 0;
      s.players[1].x = -60 * F; s.players[1].y = -50 * F;
      s.players[2].x = 130 * F; s.players[2].y = 76 * F;
      s.players[3].x = -80 * F; s.players[3].y = -50 * F;
      s.ball.x = 146 * F; s.ball.y = 78 * F;
      if (mirrored) mirror(s);
      const start = { x: s.ball.x, y: s.ball.y }, rng = random(seed);
      let progressed = false;
      for (let t = 0; t < 60; t++) {
        stepState(s, {}, rng);
        progressed ||= s.possessionId !== null || length(s.ball.x - start.x, s.ball.y - start.y) > 8 * F;
        for (const skater of s.players) {
          expect(Math.abs(skater.aiX)).toBeLessThanOrEqual(154 * F);
          expect(Math.abs(skater.aiY)).toBeLessThanOrEqual(78 * F);
        }
      }
      expect(progressed, `mirror=${mirrored}, seed=${seed}`).toBe(true);
    }
  });
});

describe("hockey carrier decisions", () => {
  it("escapes pressure with a clear lateral dash instead of driving through a defender", () => {
    const s = fixture(), p = s.players[0];
    p.x = -70 * F; p.y = 0; p.heading = 0;
    s.ball.x = -56 * F; s.possessionId = p.id;
    s.players[1].x = -130 * F; s.players[1].y = -60 * F;
    s.players[2].x = -47 * F; s.players[2].y = 0;
    s.players[3].x = 90 * F; s.players[3].y = 60 * F;
    const command = hockeyAI(s, random()).get(p.id)!;
    expect(command.dash).toBe(true);
    expect(Math.abs(command.moveY ?? 0)).toBeGreaterThan(10 * F);
    expect(command.strikePressed || command.pass || command.check).toBeFalsy();
  });
  it("honors shot cooldown and schedules one poke edge followed by reassessment", () => {
    const s = fixture(), p = s.players[0], opponent = s.players[2], rng = random();
    p.x = 50 * F; p.y = 0; p.heading = 0;
    s.ball.x = 64 * F; s.possessionId = p.id; p.aiNext = s.tick + 40;
    expect(hockeyAI(s, rng).get(p.id)!.strikePressed).toBe(false);
    s.possessionId = opponent.id;
    opponent.x = 78 * F; opponent.y = 0;
    const first = hockeyAI(s, rng).get(p.id)!;
    expect(first.slide).toBe(true);
    s.tick++;
    expect(hockeyAI(s, rng).get(p.id)!.slide).toBe(false);
  });
  it("commits a closing check separately from poke and avoids checking a retreating approach", () => {
    const s = fixture(), defender = s.players[0], carrier = s.players[2];
    defender.x = -30 * F; defender.y = 0; defender.heading = 0;
    defender.vx = 90 * F;
    carrier.x = 0; carrier.y = 0;
    s.ball.x = 14 * F; s.possessionId = carrier.id;
    const command = hockeyAI(s, random()).get(defender.id)!;
    expect(command.check).toBe(true);
    expect(command.slide || command.dash).toBeFalsy();
    defender.aiNext = 0; defender.vx = -90 * F; s.tick++;
    expect(hockeyAI(s, random()).get(defender.id)!.check).toBe(false);
  });
  it("restores committed pursuit and escape decisions deterministically", () => {
    const session = createCryptballSession({ sportId: "cryptcheck", seed: 999 });
    session.setParticipants([]);
    for (let t = 0; t < 100; t++) session.step();
    const checkpoint = session.capture();
    for (let t = 0; t < 180; t++) session.step();
    const expected = session.capture();
    session.restore(checkpoint);
    for (let t = 0; t < 180; t++) session.step();
    expect(session.capture()).toEqual(expected);
  });
});
