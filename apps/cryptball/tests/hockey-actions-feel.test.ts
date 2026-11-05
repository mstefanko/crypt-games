import { describe, expect, it } from "vitest";
import { DeterministicRandom } from "@onepage/game-simulation/random";
import {
  createCryptballSession,
  createInitialState,
  stepState,
} from "../sim/session";
import type { CommandFrame, State } from "../sim/contract";
import { controlPuck, releaseControl } from "../sim/modes/cryptcheck/control";
import { FIXED as F, length } from "../sim/rules";
import { HOCKEY } from "../sim/modes/cryptcheck/spec";
import { validateInput, heldCommand } from "../protocol";
const random = (seed = 42) =>
  new DeterministicRandom([{ owner: "cryptball", name: "ai", seed }]);
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
  s.players[0].x = s.players[0].y = 0;
  s.players[0].heading = 0;
  s.players[2].x = 28 * F;
  s.players[2].y = 0;
  s.ball.x = -80 * F;
  s.ball.y = 0;
  return s;
}
function tick(s: State, c: Record<string, CommandFrame> = {}, n = 1) {
  const rng = random();
  for (let i = 0; i < n; i++) stepState(s, {}, rng, c);
}
function attack(s: State) {
  for (let i = 0; i < 16 && !s.hockey!.skaters["player-2"].downTicks; i++)
    tick(s, { "player-0": { check: true } });
}
describe("hockey distinct actions and contests", () => {
  it("does not hide an equally eligible opponent behind a tied teammate", () => {
    const s = fixture();
    Object.assign(s.players[0], { x: -14 * F, y: 0, heading: 0 });
    Object.assign(s.players[1], { x: 0, y: -14 * F, heading: 64 });
    Object.assign(s.players[2], { x: 14 * F, y: 0, heading: 128 });
    s.ball.x = s.ball.y = 0;
    controlPuck(s, () => {});
    expect(s.possessionId).toBeNull();
    expect(s.events.filter((e) => e.type === "clash")).toHaveLength(1);
  });
  it("rejects impossible knockdown and check contact receipts atomically", () => {
    const session = createCryptballSession({ sportId: "cryptcheck" });
    const initial = session.capture();
    initial.state.phase = "play";
    session.restore(initial);
    const clean = session.capture();
    for (const scenario of [
      "down",
      "tell-hit",
      "unprotected-hit",
      "concurrent-dash",
    ] as const) {
      const bad = structuredClone(clean),
        h = bad.state.hockey!,
        p = bad.state.players[0];
      if (scenario === "down") h.skaters[p.id].downTicks = 24;
      else {
        h.skaters[p.id].check = {
          id: bad.state.nextAction++,
          heading: 0,
          elapsed: scenario === "tell-hit" ? 2 : 10,
          hits: scenario === "concurrent-dash" ? [] : ["player-2"],
        };
        if (scenario === "concurrent-dash") p.dashTicks = 1;
      }
      expect(() => session.restore(bad)).toThrow();
      expect(session.capture()).toEqual(clean);
    }
  });
  it("allows Check to consume a passive prime while preserving committed special tells", () => {
    for (const kind of ["owls", "hornets", "bats"] as const) {
      const s = fixture();
      s.teamIds = [kind, "rams"];
      s.specials[0].cooldownTicks = 0;
      tick(s, { "player-0": { special: true } });
      const gap = kind === "bats" ? 17 : 7;
      tick(s, {}, gap);
      tick(s, { "player-0": { check: true } });
      expect(s.hockey!.skaters["player-0"].check).not.toBeNull();
      expect(s.specials[0].active).toBeNull();
    }
  });
  it("keeps a board-adjacent check and downed slide inside solid court bounds", () => {
    const s = fixture();
    Object.assign(s.players[0], { x: 145 * F, y: 50 * F });
    Object.assign(s.players[2], { x: 163 * F, y: 50 * F });
    tick(s, { "player-0": { check: true } }, 35);
    expect(s.events.some((e) => e.type === "check")).toBe(true);
    expect(
      s.players.every(
        (p) => Math.abs(p.x) <= 180 * F && Math.abs(p.y) <= 94 * F,
      ),
    ).toBe(true);
  });
  it("checks with a visible tell, real closing contact, one victim receipt and short protected knockdown", () => {
    const s = fixture(),
      h = s.hockey!;
    tick(s, { "player-0": { check: true } });
    expect(h.skaters["player-0"].check?.elapsed).toBe(1);
    expect(h.skaters["player-2"].downTicks).toBe(0);
    attack(s);
    expect(h.skaters["player-2"].downTicks).toBeGreaterThan(0);
    expect(h.skaters["player-2"].downTicks).toBeLessThanOrEqual(24);
    expect(h.skaters["player-0"].check?.hits).toEqual(["player-2"]);
    s.specials[1].cooldownTicks = 0;
    tick(
      s,
      {
        "player-2": {
          cancel: true,
          special: true,
          dash: true,
          check: true,
          strikePressed: true,
        },
      },
      5,
    );
    expect(s.players[2].action).toBeNull();
    expect(s.players[2].dashTicks).toBe(0);
    expect(s.specials[1].active).toBeNull();
    tick(s, { "player-0": { check: true } }, 45);
    expect(h.skaters["player-0"].check).toBeNull();
    expect(s.events.filter((e) => e.type === "check")).toHaveLength(1);
    expect(s.events.filter((e) => e.type === "check-start")).toHaveLength(1);
  });
  it("cannot cancel a committed check, hit two opponents, or chain a protected victim", () => {
    const s = fixture();
    s.players[2].x = 24 * F;
    s.players[2].y = -8 * F;
    s.players[3].x = 24 * F;
    s.players[3].y = 8 * F;
    tick(s, { "player-0": { check: true } });
    tick(s, { "player-0": { cancel: true, dash: true, special: true } });
    expect(s.hockey!.skaters["player-0"].check).not.toBeNull();
    tick(s, {}, 14);
    expect(s.events.filter((e) => e.type === "check")).toHaveLength(1);
    const victim = s.players.find((p) => s.hockey!.skaters[p.id].downTicks)!;
    expect(victim.immunityTicks).toBeGreaterThan(
      s.hockey!.skaters[victim.id].downTicks,
    );
  });
  it.each(["grazing", "retreating", "range"])(
    "recovers from a %s miss without a body attack",
    (kind) => {
      const s = fixture();
      if (kind === "grazing") s.players[2].y = 20 * F;
      if (kind === "retreating") s.players[2].vx = 180 * F;
      if (kind === "range") s.players[2].x = 60 * F;
      tick(s, { "player-0": { check: true } }, 36);
      expect(s.events.filter((e) => e.type === "check")).toHaveLength(0);
      expect(
        s.events.some((e) => e.type === "whiff" && e.kind === "check"),
      ).toBe(true);
    },
  );
  it("edge-triggers poke once per press without knockdown", () => {
    const s = fixture();
    s.players[2].x = 100 * F;
    s.ball.x = 18 * F;
    tick(s, { "player-0": { slide: true } }, 100);
    expect(s.events.filter((e) => e.type === "slide")).toHaveLength(1);
    expect(
      s.events.filter((e) => e.type === "puck-contact" && e.kind === "poke"),
    ).toHaveLength(1);
    expect(s.players.every((p) => !s.hockey!.skaters[p.id].downTicks)).toBe(
      true,
    );
    tick(s);
    tick(s, { "player-0": { slide: true } });
    expect(s.events.filter((e) => e.type === "slide")).toHaveLength(2);
  });
  it("a releasing skater waits while an opponent or receiving teammate collects immediately", () => {
    for (const receiver of [1, 2]) {
      const s = fixture(),
        p = s.players[0],
        q = s.players[receiver];
      s.players[2].x = 100 * F;
      s.ball.x = 14 * F;
      controlPuck(s, () => {});
      expect(s.possessionId).toBe(p.id);
      releaseControl(s, "pass", p.id);
      q.x = 28 * F;
      q.y = 0;
      q.heading = 128;
      // The former carrier moves away, leaving a legal receiving blade lane.
      p.x = -30 * F;
      controlPuck(s, () => {});
      expect(s.possessionId).toBe(q.id);
      expect(s.hockey!.skaters[p.id].recaptureUntil).toBe(
        s.tick + HOCKEY.reacquireTicks,
      );
    }
  });
  it("gives one equal-blade contest a physical outcome with a short receipt", () => {
    const s = fixture();
    s.players[0].x = -14 * F;
    s.players[2].x = 14 * F;
    s.players[2].heading = 128;
    s.ball.x = 0;
    controlPuck(s, () => {});
    expect(s.possessionId).toBeNull();
    expect(Math.abs(s.ball.vy)).toBe(48 * F);
    const until = s.hockey!.contestUntil;
    controlPuck(s, () => {});
    expect(s.hockey!.contestUntil).toBe(until);
    expect(s.events.filter((e) => e.type === "clash")).toHaveLength(1);
    tick(s, {}, 30);
    expect(length(s.ball.x, s.ball.y)).toBeGreaterThan(10 * F);
  });
  it("starts seeded and opposite saved faceoff drops within a second with specials disabled across ten seeds", () => {
    for (const side of [0, -1, 1] as const)
      for (let seed = 0; seed < 10; seed++) {
        const s = createInitialState("match", {}, "cryptcheck");
        s.controllers = [];
        s.hockey!.dropSide = side;
        const rng = random(seed);
        for (let t = 0; t < 105; t++) stepState(s, {}, rng);
        expect(length(s.ball.x, s.ball.y)).toBeGreaterThan(5 * F);
        expect(s.events.some((e) => e.type === "special")).toBe(false);
      }
  });
  it("preserves ordinary carrying for every cosmetic team when special input is ignored", () => {
    for (const kind of ["foxes", "bats", "rams", "gators"] as const) {
      const s = fixture();
      s.teamIds = [kind, kind === "rams" ? "foxes" : "rams"];
      s.players[2].x = 130 * F;
      s.players[2].y = 65 * F;
      s.ball.x = 14 * F;
      controlPuck(s, () => {});
      s.specials[0].cooldownTicks = 0;
      tick(s, { "player-0": { special: true, moveX: 1, aim: 0 } });
      for (let t = 0; t < 12; t++)
        tick(s, { "player-0": { moveX: 1, aim: 0 } });
      expect(s.specials[0].active).toBeNull();
      expect(s.possessionId).toBe("player-0");
    }
  });
  it("restores check tell, active, knockdown, cooldown and contest receipts into identical futures", () => {
    const a = createCryptballSession({ sportId: "cryptcheck" }),
      b = createCryptballSession({ sportId: "cryptcheck" });
    const cp = a.capture();
    cp.state = fixture();
    cp.state.events = [];
    a.restore(cp);
    b.restore(cp);
    for (let t = 0; t < 55; t++) {
      if ([3, 9, 13, 24, 40].includes(t)) b.restore(a.capture());
      const commands = {
        "player-0": { check: t < 40 },
        "player-2": { special: true, dash: true, check: true },
      };
      a.stepParticipants(commands);
      b.stepParticipants(commands);
      expect(a.capture()).toEqual(b.capture());
    }
  });
  it("validates the explicit check transport and drops it from held prediction commands", () => {
    expect(
      validateInput({
        epoch: 1,
        generation: 1,
        seq: 1,
        tick: 1,
        revision: 0,
        command: { check: true },
      })?.command.check,
    ).toBe(true);
    expect(
      validateInput({
        epoch: 1,
        generation: 1,
        seq: 1,
        tick: 1,
        revision: 0,
        command: { check: 1 },
      }),
    ).toBeNull();
    expect(heldCommand({ check: true, slide: true })).not.toHaveProperty(
      "check",
    );
  });
});
