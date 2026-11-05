import { describe, expect, it } from "vitest";
import { DeterministicRandom } from "@onepage/game-simulation/random";
import {
  createCryptballSession,
  createInitialState,
  stepState,
} from "../sim/session";
import type { CommandFrame, State } from "../sim/contract";
import { FIXED as F, headingVector, length } from "../sim/rules";
import { groundBallPhysics } from "../sim/sports-spec";
import { dragBall, moveBall } from "../sim/ball";
import {
  skate,
  controlPuck,
  hockeyContacts,
} from "../sim/modes/cryptcheck/index";
import { admitHockeyAction } from "../sim/modes/cryptcheck/actions";
const random = () =>
  new DeterministicRandom([{ owner: "cryptball", name: "ai", seed: 42 }]);
function fixture() {
  const s = createInitialState("match", {}, "cryptcheck");
  s.phase = "play";
  s.phaseTicks = 0;
  s.controllers = s.players.map((p) => ({
    id: p.id,
    team: p.team,
    playerId: p.id,
    active: true,
    canSwitch: false,
    pendingSwitch: null,
    switchReady: 0,
    revision: 0,
  }));
  s.participantStats = Object.fromEntries(
    s.players.map((p) => [p.id, { shots: 0, passes: 0, goals: 0 }]),
  );
  for (const [i, p] of s.players.entries()) {
    p.x = (i < 2 ? -120 : 120) * F;
    p.y = (i % 2 ? -70 : 70) * F;
  }
  s.players[0].x = s.players[0].y = 0;
  s.ball.x = 14 * F;
  s.ball.y = 0;
  return s;
}
function tick(s: State, frames: Record<string, CommandFrame> = {}, n = 1) {
  const rng = random();
  for (let i = 0; i < n; i++) stepState(s, {}, rng, frames);
}
function action(
  s: State,
  index = 0,
  heading = 0,
  kind: "strike" | "pass" = "strike",
  charge = 0,
) {
  const p = s.players[index];
  p.heading = heading;
  p.action = {
    id: s.nextAction++,
    kind,
    elapsed: 3,
    timing: { tell: 3, active: 3, recover: 8 },
    hits: [],
    heading,
    charge,
  };
}
describe("Cryptcheck skating and ground puck", () => {
  it("accelerates to equal cardinal/diagonal caps, coasts, brakes before reversing and keeps aim separate", () => {
    for (const input of [{ moveX: 1 }, { moveX: 1, moveY: 1 }]) {
      const s = fixture(),
        p = s.players[0];
      for (let i = 0; i < 18; i++) skate(s, p, { ...input, aim: 128 });
      expect(length(p.vx, p.vy)).toBeGreaterThan(119 * F);
      expect(length(p.vx, p.vy)).toBeLessThanOrEqual(120 * F);
      expect(p.heading).toBe(0);
    }
    const s = fixture(),
      p = s.players[0];
    p.vx = 120 * F;
    skate(s, p, {});
    expect(p.vx).toBe(118.75 * F);
    p.vx = 120 * F;
    for (let i = 0; i < 10; i++) skate(s, p, { moveX: -1 });
    expect(p.vx).toBe(0);
    skate(s, p, { moveX: -1 });
    expect(p.vx).toBe(-7 * F);
    p.vx = 120 * F;
    p.vy = 0;
    p.charging = true;
    skate(s, p, { moveX: 1 });
    expect(p.vx).toBe(120 * F);
    p.charging = false;
    for (let i = 0; i < 96; i++) skate(s, p, {});
    expect(p.vx).toBe(0);
  });
  it("bounds energy through changing turn directions and preserves board tangent momentum", () => {
    const s = fixture(),
      p = s.players[0];
    p.vx = 120 * F;
    for (let i = 0; i < 1000; i++) {
      skate(s, p, { moveX: i % 4 < 2 ? 1 : -1, moveY: i % 2 ? 1 : -1 });
      expect(p.vx * p.vx + p.vy * p.vy).toBeLessThanOrEqual((120 * F) ** 2);
    }
    p.x = 159 * F;
    p.y = 50 * F;
    p.vx = 60 * F;
    p.vy = 60 * F;
    tick(s);
    expect(p.vx).toBe(0);
    expect(p.vy).toBeGreaterThan(50 * F);
  });
  it("applies sliding drag once per tick, rests cleanly and retains tangential board energy", () => {
    const s = fixture(),
      b = s.ball,
      physics = groundBallPhysics("cryptcheck");
    b.vx = 100 * F;
    for (let i = 0; i < 60; i++) dragBall(b, physics);
    expect(b.vx).toBe(88 * F);
    b.vx = 0;
    b.vy = F / 2;
    b.rx = 100;
    b.ry = -100;
    dragBall(b, physics);
    expect([b.vx, b.vy, b.rx, b.ry, b.dragCarry]).toEqual([0, 0, 0, 0, 0]);
    b.x = 0;
    b.y = 91 * F;
    b.vx = 40 * F;
    b.vy = 300 * F;
    moveBall(b, [], 1, () => {}, undefined, physics);
    expect(b.vx).toBe(40 * F);
    expect(b.vy).toBe(-264 * F);
  });
});
describe("Cryptcheck stick contacts and assistance", () => {
  it("strikes a stationary puck at its exact blade contact once across four substeps", () => {
    const s = fixture();
    action(s);
    tick(s);
    const hits = s.events.filter((e) => e.type === "puck-contact");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      x: 14 * F,
      y: 0,
      kind: "wrist",
      actionId: 1,
      incomingVx: 0,
      vx: 260 * F,
    });
    expect(s.teamStats[0].shots).toBe(1);
    expect(s.ball.bankBonusRemaining).toBe(0);
  });
  it("releases flat push passes and full slapshots at their authored speeds without powered banks", () => {
    for (const [kind, charge, speed] of [
      ["pass", 0, 180],
      ["strike", 24, 380],
    ] as const) {
      const s = fixture();
      action(s, 0, 0, kind, charge);
      tick(s);
      expect(s.events.find((e) => e.type === "puck-contact")).toMatchObject({
        kind: kind === "pass" ? "pass" : "slap",
        vx: speed * F,
        vy: 0,
      });
      expect([
        s.ball.z,
        s.ball.vz,
        s.ball.rz,
        s.ball.bankBonusRemaining,
      ]).toEqual([0, 0, 0, 0]);
      expect(s.possessionReady).toBe(s.tick);
      expect(s.hockey!.skaters[s.players[0].id].recaptureUntil).toBe(s.tick + 12);
    }
  });
  it("aims a blocked push pass through a restitution-corrected one-bank path", () => {
    for (const side of [-1, 1]) {
      const s = fixture();
      s.ball.x = -70 * F;
      s.ball.y = side * 15 * F;
      s.players[0].x = -84 * F;
      s.players[0].y = s.ball.y;
      s.players[1].x = 70 * F;
      s.players[1].y = side * 15 * F;
      s.players[2].x = 0;
      s.players[2].y = side * 15 * F;
      // Block the longer opposite bank, leaving the authored near board.
      s.players[3].x = 0;
      s.players[3].y = -side * 70 * F;
      admitHockeyAction(s, s.players[0], { pass: true, aim: 0 });
      const heading = s.players[0].action!.heading!;
      const d = headingVector(heading),
        b = { ...s.ball };
      b.vx = Math.round((d.x * 180 * F) / 65536);
      b.vy = Math.round((d.y * 180 * F) / 65536);
      const physics = groundBallPhysics("cryptcheck");
      let banks = 0,
        miss = Infinity;
      for (let tick = 0; tick < 180 && !Number.isFinite(miss); tick++) {
        for (let sub = 0; sub < 4; sub++) {
          const previous = { x: b.x, y: b.y };
          const goal = moveBall(
            b,
            [],
            tick,
            (e) => {
              if (e.type === "board") {
                banks++;
                expect(Math.sign(e.y as number)).toBe(side);
              }
            },
            undefined,
            physics,
          );
          expect(goal).toBeNull();
          if (previous.x <= 70 * F && b.x >= 70 * F) {
            const t = (70 * F - previous.x) / (b.x - previous.x);
            miss = Math.abs(
              previous.y + (b.y - previous.y) * t - side * 15 * F,
            );
            break;
          }
        }
        dragBall(b, physics);
      }
      expect(banks).toBe(1);
      expect(miss).toBeLessThan(4 * F);
    }
  });
  it("sweeps a maximum-speed incoming puck against the active blade before it reaches the body", () => {
    const s = fixture();
    s.ball.x = 25 * F;
    s.ball.vx = -420 * F;
    action(s);
    tick(s);
    expect(s.events.some((e) => e.type === "puck-contact")).toBe(true);
    expect(s.ball.vx).toBeGreaterThan(250 * F);
  });
  it("denies behind-body, through-opponent and through-board strikes", () => {
    for (const setup of [
      (s: State) => {
        s.ball.x = -14 * F;
      },
      (s: State) => {
        s.players[2].x = 11 * F;
        s.players[2].y = 0;
        s.ball.x = 22 * F;
      },
      (s: State) => {
        s.players[0].x = 150 * F;
        s.players[0].y = 50 * F;
        s.ball.x = 174 * F;
        s.ball.y = 50 * F;
      },
    ]) {
      const s = fixture();
      setup(s);
      action(s);
      const p = s.players[0];
      expect(
        hockeyContacts(s, () => {}).query(
          s.ball,
          [{ player: p, x: p.x, y: p.y, dx: 0, dy: 0 }],
          { x: 0, y: 0 },
          0,
          1,
        ),
      ).toHaveLength(0);
    }
  });
  it("leaves an equal-time opponent stick contest neutral with both action receipts consumed", () => {
    const s = fixture();
    s.players[0].x = -14 * F;
    s.players[2].x = 14 * F;
    s.players[2].y = 0;
    s.ball.x = 0;
    action(s, 0);
    action(s, 2, 128);
    tick(s);
    expect(s.events.filter((e) => e.type === "clash")).toHaveLength(1);
    expect(s.events.some((e) => e.type === "puck-contact")).toBe(false);
    expect(s.ball.vx).toBe(0);
    expect(s.possessionId).toBeNull();
    expect(s.players[0].action!.hits).toContain("ball");
    expect(s.players[2].action!.hits).toContain("ball");
  });
  it("controls with bounded velocity correction, retains charge preparation, and refuses high speed or rear pickup", () => {
    const s = fixture(),
      p = s.players[0];
    s.ball.x = 18 * F;
    const x = s.ball.x;
    controlPuck(s, () => {});
    expect(s.possessionId).toBe(p.id);
    expect(s.ball.x).toBe(x);
    expect(Math.abs(s.ball.vx)).toBeLessThanOrEqual(15 * F);
    admitHockeyAction(s, p, { strikePressed: true, strikeHeld: true });
    expect(s.possessionId).toBe(p.id);
    expect(s.possessionReady).toBe(0);
    for (const [position, speed] of [
      [14, 180],
      [-14, 0],
    ]) {
      const q = fixture();
      q.ball.x = position * F;
      q.ball.vx = speed * F;
      controlPuck(q, () => {});
      expect(q.possessionId).toBeNull();
    }
  });
  it("pokes once after its tell without body stun and recognizes a receiving one-timer", () => {
    const s = fixture();
    s.ball.x = 18 * F;
    tick(s, { "player-0": { slide: true } });
    expect(s.events.some((e) => e.type === "puck-contact")).toBe(false);
    tick(s, {}, 3);
    expect(s.events.filter((e) => e.type === "puck-contact")).toHaveLength(1);
    expect(s.events.find((e) => e.type === "puck-contact")?.kind).toBe("poke");
    tick(s, {}, 4);
    expect(s.events.filter((e) => e.type === "puck-contact")).toHaveLength(1);
    expect(s.players.every((p) => p.staggerTicks === 0)).toBe(true);
    const q = fixture();
    q.ball.passFrom = "player-1";
    q.ball.passTarget = "player-0";
    q.ball.passTeam = 0;
    action(q);
    tick(q);
    expect(q.events.find((e) => e.type === "puck-contact")?.kind).toBe(
      "one-timer",
    );
    expect(q.teamStats[0].passes).toBe(1);
  });
});
describe("Cryptcheck faceoffs and authority", () => {
  it("freezes the ready clock, releases symmetrically, alternates goal leads and resets practice centrally", () => {
    const session = createCryptballSession({ sportId: "cryptcheck" });
    for (let i = 0; i < 44; i++)
      session.step({ moveX: 1, strikePressed: true, dash: true });
    expect(session.observe().remainingTicks).toBe(5400);
    expect(session.observe().phase).toBe("ready");
    expect(session.observe().ball.x).toBe(0);
    session.step();
    expect(session.observe().phase).toBe("play");
    expect(session.observe().possessionId).toBeNull();
    const s = fixture();
    s.phase = "goal";
    s.phaseTicks = 1;
    tick(s);
    expect(s.hockey!.faceoffLead).toEqual(["player-1", "player-3"]);
    expect(s.phaseTicks).toBe(45);
    const practice = createInitialState("practice", {}, "cryptcheck");
    expect([practice.ball.x, practice.ball.y]).toEqual([0, 0]);
  });
  it("scores whole puck on the final live tick before expiring the match", () => {
    const s = fixture();
    s.ball.x = 172 * F;
    s.ball.vx = 420 * F;
    s.remainingTicks = 1;
    tick(s);
    expect(s.score).toEqual([1, 0]);
    expect(s.remainingTicks).toBe(0);
    expect(s.phase).toBe("goal");
    tick(s, {}, 54);
    expect(s.phase).toBe("results");
    expect(s.winner).toBe(0);
  });
  it("rejects ineligible control owners including stagger, pokes and stopped phases", () => {
    const session = createCryptballSession({
      mode: "practice",
      sportId: "cryptcheck",
    });
    const cp = session.capture(),
      p = cp.state.players[0];
    cp.state.possessionId = p.id;
    cp.state.ball.lastTouch = p.id;
    for (const mutate of [
      (s: State) => {
        s.players[0].staggerTicks = 1;
      },
      (s: State) => {
        s.phase = "ready";
      },
      (s: State) => {
        s.players[0].slideTicks = 3;
        s.hockey!.pokeActions[p.id] = s.nextAction++;
      },
      (s: State) => {
        s.hockey!.pokeActions[p.id] = s.nextAction;
      },
    ]) {
      const bad = structuredClone(cp);
      mutate(bad.state);
      expect(() => session.restore(bad)).toThrow();
    }
  });
  it("restores future-affecting hockey state atomically and rejects invalid ownership or receipts", () => {
    const session = createCryptballSession({ sportId: "cryptcheck" });
    const cp = session.capture();
    expect(cp.version).toBe(16);
    session.restore(cp);
    for (const mutate of [
      (s: State) => {
        s.hockey!.faceoffLead[0] = "player-2";
      },
      (s: State) => {
        s.hockey!.checkHits["player-0"] = ["player-1"];
      },
      (s: State) => {
        s.hockey!.pokeActions["player-0"] = s.nextAction + 1;
      },
      (s: State) => {
        s.possessionId = "player-0";
      },
      (s: State) => {
        (s.hockey as any).extra = 0;
      },
    ]) {
      const bad = structuredClone(cp);
      mutate(bad.state);
      expect(() => session.restore(bad)).toThrow();
      expect(session.capture()).toEqual(cp);
    }
  });
});

describe("Cryptcheck cosmetic teams", () => {
  for (const teamId of ["rams","foxes","owls","gators","bats","hornets"] as const)
    it(`${teamId} ignores retired special input`, () => {
      const session=createCryptballSession({mode:"practice",sportId:"cryptcheck",teamIds:[teamId,teamId==="rams"?"foxes":"rams"]});
      session.step({special:true,moveX:1});
      expect(session.observe().specials.every(t=>t.active===null)).toBe(true);
      expect(()=>session.restore(session.capture())).not.toThrow();
    });
});
