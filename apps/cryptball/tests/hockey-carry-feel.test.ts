import { describe, expect, it } from "vitest";
import { DeterministicRandom } from "@onepage/game-simulation/random";
import {
  createCryptballSession,
  createInitialState,
  stepState,
} from "../sim/session";
import type { CommandFrame, State } from "../sim/contract";
import { controlPuck, bladeAnchor } from "../sim/modes/cryptcheck/control";
import { admitHockeyAction } from "../sim/modes/cryptcheck/actions";
import { clearLane } from "../sim/prediction";
import { groundBallPhysics } from "../sim/sports-spec";
import { FIXED as F, length } from "../sim/rules";
const rng = () =>
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
    p.x = (i < 2 ? -130 : 130) * F;
    p.y = (i % 2 ? -65 : 65) * F;
  }
  const p = s.players[0];
  p.x = p.y = 0;
  p.heading = 0;
  s.hockey!.skaters[p.id].carryHeading = 0;
  s.ball.x = 14 * F;
  s.ball.y = 0;
  controlPuck(s, () => {});
  return s;
}
function step(s: State, c: CommandFrame = {}) {
  stepState(
    s,
    {},
    rng(),
    Object.fromEntries(s.players.map((p, i) => [p.id, i === 0 ? c : {}])),
  );
}

describe("hockey stable carrying", () => {
  it("skates, brakes and changes travel direction for five seconds without incidental loss", () => {
    const s = fixture(),
      p = s.players[0];
    for (let i = 0; i < 300; i++) {
      const phase = Math.floor(i / 30) % 5;
      const commands: CommandFrame[] = [
        { moveX: 1, aim: 0 },
        { moveY: 1, aim: 64 },
        { moveX: -1, aim: 128 },
        { moveY: -1, aim: 192 },
        {},
      ];
      step(s, commands[phase]);
      expect(s.possessionId).toBe(p.id);
    }
  });
  it("keeps a stationary puck for five seconds and turns its pocket around a solid torso", () => {
    const s = fixture(),
      p = s.players[0];
    for (let i = 0; i < 300; i++) {
      step(s, { aim: i < 60 ? 0 : 128 });
      expect(s.possessionId).toBe(p.id);
      expect(length(s.ball.x - p.x, s.ball.y - p.y)).toBeGreaterThanOrEqual(
        12 * F - 4,
      );
    }
    expect(s.hockey!.skaters[p.id].carryHeading).toBe(128);
    expect(s.ball.x).toBeLessThan(p.x);
  });
  it("retains feasible charge/pass preparation and a directional dash", () => {
    const s = fixture(),
      p = s.players[0];
    admitHockeyAction(s, p, { strikePressed: true, strikeHeld: true });
    expect(s.possessionId).toBe(p.id);
    p.charging = false;
    p.chargeTicks = 0;
    admitHockeyAction(s, p, { pass: true, aim: 0 });
    expect(p.action?.kind).toBe("pass");
    expect(s.possessionId).toBe(p.id);
    p.action = null;
    for (let i = 0; i < 14; i++) {
      step(s, { moveX: 1, aim: 0, dash: i === 0 });
      expect(s.possessionId).toBe(p.id);
    }
  });
  it("retains actual passive touch attribution without treating it as an intentional turnover", () => {
    const s = fixture(),
      p = s.players[0],
      other = s.players[2];
    other.x = 14 * F;
    other.y = 12 * F;
    other.vy = -120 * F;
    step(s, {});
    expect(s.possessionId).toBe(p.id);
    expect(s.ball.lastTouch).toBe(other.id);
    const session = createCryptballSession({ sportId: "cryptcheck" });
    const cp = session.capture();
    cp.state = s;
    cp.state.events = [];
    expect(() => session.restore(cp)).not.toThrow();
  });
  it("allows a slow self graze, but releases for another body obstruction or excessive speed", () => {
    const s = fixture(),
      p = s.players[0];
    p.heading = 2;
    controlPuck(s, () => {});
    expect(s.possessionId).toBe(p.id);
    // Put a different solid body directly in the physical pocket lane.
    s.players[2].x = 12 * F;
    s.players[2].y = 0;
    controlPuck(s, () => {});
    expect(s.possessionId).toBe(null);
    const fast = fixture();
    fast.ball.vx = 180 * F;
    controlPuck(fast, () => {});
    expect(fast.possessionId).toBe(null);
  });
  it("does not admit an immediate far-side shot while its carry pocket is preparing", () => {
    const s = fixture(),
      p = s.players[0];
    for (let i = 0; i < 10; i++) step(s, { aim: 128, strikePressed: i === 0 });
    expect(s.possessionId).toBe(p.id);
    expect(p.action?.elapsed).toBeLessThan(p.action!.timing.tell);
    expect(
      clearLane(
        s.ball,
        bladeAnchor(p),
        s.players,
        [],
        groundBallPhysics("cryptcheck"),
      ),
    ).toBe(false);
    let hit = false;
    for (let i = 0; i < 100 && !hit; i++) {
      step(s, {});
      hit = s.events.some((e) => e.type === "puck-contact");
    }
    expect(hit).toBe(true);
    expect(s.possessionId).toBe(null);
  });
  it("restores carry heading, dash and charge preparation into identical future authority", () => {
    const a = createCryptballSession({ sportId: "cryptcheck" }),
      b = createCryptballSession({ sportId: "cryptcheck" });
    const cp = a.capture();
    cp.state = fixture();
    cp.state.events = [];
    a.restore(cp);
    for (let t = 0; t < 55; t++) {
      const command: CommandFrame = {
        aim: 128,
        moveY: t < 15 ? 1 : 0,
        dash: t === 3,
      };
      if (t === 25) {
        command.strikePressed = true;
        command.strikeHeld = true;
      }
      if (t > 25) command.strikeHeld = true;
      if (t % 7 === 0) b.restore(a.capture());
      a.stepParticipants({ "player-0": command });
      b.stepParticipants({ "player-0": command });
      expect(b.capture()).toEqual(a.capture());
    }
  });
  it("rejects missing/invalid carry state and legacy checkpoints atomically", () => {
    const s = createCryptballSession({ sportId: "cryptcheck" }),
      cp = s.capture();
    for (const mutate of [
      (c: any) => (c.version = 10),
      (c: any) => delete c.state.hockey.skaters["player-0"],
      (c: any) => (c.state.hockey.skaters["player-0"].carryHeading = 256),
    ]) {
      const bad = structuredClone(cp);
      mutate(bad);
      expect(() => s.restore(bad)).toThrow();
      expect(s.capture()).toEqual(cp);
    }
  });
});
