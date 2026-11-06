import { describe, expect, it } from "vitest";
import { DeterministicRandom } from "@onepage/game-simulation/random";
import {
  createCryptballSession,
  createInitialState,
  predictVolleyLanding,
  stepState,
  supportsPassControlTransfer,
} from "../sim/session";
import type { CommandFrame, SportId, State, Team } from "../sim/contract";
import { FIXED as F, headingVector } from "../sim/rules";

const random = () =>
  new DeterministicRandom([{ owner: "cryptball", name: "ai", seed: 42 }]);
function fixture(sportId: SportId) {
  const s = createInitialState("match", {}, sportId);
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
  s.players.forEach((p, i) => {
    p.x = (i < 2 ? -125 : 125) * F;
    p.y = (i % 2 ? -70 : 70) * F;
  });
  return s;
}
function tick(s: State, frames: Record<string, CommandFrame> = {}, n = 1) {
  const rng = random();
  for (let i = 0; i < n; i++) stepState(s, {}, rng, frames);
}
function volleyFixture() {
  const s = fixture("rift-volley");
  s.volley!.serving = false;
  s.ball.z = 35 * F;
  s.ball.x = -65 * F;
  s.ball.y = 0;
  return s;
}
function contact(s: State, index: number, kind: "strike" | "pass" = "strike") {
  const p = s.players[index];
  p.x = s.ball.x;
  p.y = s.ball.y;
  p.action = {
    id: s.nextAction++,
    kind,
    elapsed: 4,
    timing: { tell: 3, active: 4, recover: 9 },
    hits: [],
    heading: p.team === 0 ? 0 : 128,
    charge: 0,
  };
}

describe("shared sport identity and checkpoints", () => {
  it("keeps Cryptball the default and rejects unknown sports", () => {
    const session = createCryptballSession();
    expect(session.observe().sportId).toBe("cryptball");
    expect(session.observe().ball.z).toBe(0);
    expect(session.capture().version).toBe(16);
    expect(() =>
      createCryptballSession({ sportId: "bogus" as SportId }),
    ).toThrow();
  });
  for (const sportId of ["cryptkick", "rift-volley"] as const)
    it(`${sportId} restores and exactly replays mixed input and bot handover`, () => {
      const session = createCryptballSession({ sportId, seed: 419 });
      for (let t = 0; t < 180; t++)
        session.step({
          moveX: t % 90 < 45 ? 1 : -1,
          strikePressed: t % 30 === 0,
          pass: t % 67 === 0,
        });
      const cp = session.capture();
      const frames = Array.from({ length: 240 }, (_, t) => ({
        moveY: t % 80 < 40 ? 1 : -1,
        slide: t % 71 === 0,
        pass: t % 53 === 0,
        strikePressed: t % 29 === 0,
        dash: t % 101 === 0,
      }));
      for (const c of frames) session.step(c);
      const expected = session.capture();
      session.restore(cp);
      for (const c of frames) session.step(c);
      expect(session.capture()).toEqual(expected);
      session.setParticipantActive("local", false);
      session.step();
      session.restore(session.capture());
    });
  it("rejects bad mode state atomically", () => {
    const session = createCryptballSession({ sportId: "rift-volley" });
    const good = session.capture();
    for (const mutate of [
      (s: State) => {
        s.volley!.teamContacts = 4;
      },
      (s: State) => {
        s.ball.z = -1;
      },
      (s: State) => {
        s.volley!.lastContactId = "player-0";
        s.volley!.lastContactTeam = 1;
      },
      (s: State) => {
        s.players[0].x = 1;
      },
      (s: State) => {
        s.possessionId = "player-0";
      },
      (s: State) => {
        s.volley!.serving = 1 as unknown as boolean;
      },
    ]) {
      const bad = structuredClone(good);
      mutate(bad.state);
      expect(() => session.restore(bad)).toThrow();
      expect(session.capture()).toEqual(good);
    }
    const ball = createCryptballSession();
    const bad = ball.capture();
    bad.state.ball.z = F;
    expect(() => ball.restore(bad)).toThrow();
  });
});

describe("Cryptkick possession and commitment", () => {
  it("keeps a mirrored defender between the ball and its own goal", () => {
    for (const defendingTeam of [0, 1] as const) {
      const s = fixture("cryptkick"),
        direction = defendingTeam === 0 ? 1 : -1;
      const owner = s.players[defendingTeam === 0 ? 2 : 0],
        presser = s.players[defendingTeam === 0 ? 0 : 2],
        cover = s.players[defendingTeam === 0 ? 1 : 3];
      owner.x = direction * 50 * F;
      owner.y = direction * 20 * F;
      s.ball.x = direction * 38 * F;
      s.ball.y = direction * 20 * F;
      s.possessionId = owner.id;
      s.ball.lastTouch = owner.id;
      presser.x = direction * 20 * F;
      presser.y = 0;
      cover.x = -direction * 60 * F;
      cover.y = -direction * 50 * F;
      s.controllers = s.controllers.filter((c) => c.playerId !== cover.id);
      const ballX = s.ball.x;
      tick(s);
      expect(cover.aiRole).toBe("defend-lane");
      expect(cover.aiX).toBe(ballX - direction * 48 * F);
      expect(cover.aiY).toBe(direction * 10 * F);
      expect(direction * (cover.aiX - ballX)).toBeLessThan(0);
    }
  });
  it("aims seeded corner shots from the ball's position", () => {
    const s = fixture("cryptkick"),
      p = s.players[0];
    p.x = 132 * F;
    p.y = -76 * F;
    s.ball.x = 143 * F;
    s.ball.y = -73 * F;
    s.ball.lastTouch = p.id;
    s.possessionId = p.id;
    s.controllers = s.controllers.filter((c) => c.playerId !== p.id);
    s.players[3].x = 50 * F;
    s.players[3].y = 70 * F;
    const origin = { x: s.ball.x, y: s.ball.y };
    tick(s);
    expect(p.action?.kind).toBe("strike");
    const aim = headingVector(p.action!.heading!);
    const goalY = origin.y + ((169 * F - origin.x) * aim.y) / aim.x;
    expect(Math.abs(goalY)).toBeLessThanOrEqual(12 * F);
  });
  it("preserves the close-control practice drill after the sport reset", () => {
    const s = createInitialState("practice", {}, "cryptkick");
    expect([
      s.players[0].x,
      s.players[0].y,
      s.ball.x,
      s.players[1].x,
      s.players[1].y,
    ]).toEqual([-24 * F, 0, -8 * F, 56 * F, -34 * F]);
  });

  it("traps a loose ball, dribbles softly and exposes it on sprint", () => {
    const s = fixture("cryptkick"),
      p = s.players[0];
    p.x = -50 * F;
    p.y = 0;
    s.ball.x = -38 * F;
    s.ball.y = 0;
    tick(s);
    expect(s.possessionId).toBe(p.id);
    const before = s.ball.x;
    tick(s, { [p.id]: { moveX: 1 } }, 20);
    expect(s.possessionId).toBe(p.id);
    expect(s.ball.x).toBeGreaterThan(before + 10 * F);
    expect(Math.abs(s.ball.x - p.x)).toBeLessThan(20 * F);
    tick(s, { [p.id]: { moveX: 1, aim: 0, dash: true } });
    expect(s.possessionId).toBeNull();
    expect(
      s.events.some(
        (e) => e.type === "possession-lost" && e.reason === "sprint",
      ),
    ).toBe(true);
    expect(s.ball.vx).toBeGreaterThan(100 * F);
  });
  it("releases its own slide, preserves interception attribution and locks pickups after a tackle", () => {
    const s = fixture("cryptkick"),
      p = s.players[0],
      q = s.players[2];
    p.x = -50 * F;
    p.y = 0;
    s.ball.x = -38 * F;
    s.ball.y = 0;
    tick(s);
    tick(s, { [p.id]: { slide: true, aim: 0 } });
    expect(s.possessionId).toBeNull();
    expect(s.possessionReady).toBeGreaterThan(s.tick);
    const other = fixture("cryptkick");
    other.possessionId = "player-0";
    other.players[0].x = -50 * F;
    other.players[0].y = 0;
    other.ball.x = -38 * F;
    other.ball.y = 0;
    other.ball.lastTouch = q.id;
    tick(other);
    expect(other.possessionId).toBeNull();
    expect(other.ball.lastTouch).toBe(q.id);
    expect(other.events.find((e) => e.type === "possession-lost")?.reason).toBe(
      "interception",
    );
  });
  it("releases passes and kicks as independent loose balls", () => {
    for (const pass of [false, true]) {
      const s = fixture("cryptkick"),
        p = s.players[0];
      p.x = -55 * F;
      p.y = 0;
      s.ball.x = -43 * F;
      s.ball.y = 0;
      tick(s);
      tick(s, {
        [p.id]: pass ? { pass: true, aim: 0 } : { strikePressed: true, aim: 0 },
      });
      tick(s, {}, 6);
      expect(s.possessionId).not.toBe(p.id);
      expect(
        s.events.some(
          (e) => e.type === (pass ? "pass" : "strike") && e.playerId === p.id,
        ),
      ).toBe(true);
      expect(s.ball.bankBonusRemaining).toBe(0);
    }
  });
  it("committed sliding contact frees the carrier's ball", () => {
    const s = fixture("cryptkick"),
      p = s.players[0],
      q = s.players[2];
    p.x = -50 * F;
    p.y = 0;
    s.ball.x = -38 * F;
    s.ball.y = 0;
    tick(s);
    q.x = -38 * F;
    q.y = 26 * F;
    tick(s, { [q.id]: { moveY: -1, slide: true } }, 3);
    expect(s.possessionId).not.toBe(p.id);
    expect(
      s.events.some((e) => e.type === "slide-contact" && e.playerId === q.id),
    ).toBe(true);
    expect(s.ball.lastTouch).toBe(q.id);
    tick(s, {}, 6);
    expect(s.possessionId).toBeNull();
    expect(
      s.events.filter((e) => e.type === "slide-contact" && e.playerId === q.id),
    ).toHaveLength(1);
  });
  it("retains the opponent's interception touch and awards goals on the shared clock", () => {
    const s = fixture("cryptkick");
    s.ball.x = 168 * F;
    s.ball.y = 0;
    s.ball.vx = 240 * F;
    s.ball.lastTouch = "player-0";
    const remaining = s.remainingTicks;
    tick(s);
    expect(s.score).toEqual([1, 0]);
    expect(s.phase).toBe("goal");
    expect(s.remainingTicks).toBe(remaining - 1);
    tick(s, {}, 80);
    expect(s.restartTeam).toBe(1);
    expect(s.phase).toBe("play");
  });
});

describe("Rift Volley deterministic rally rules", () => {
  it("serves through existing strike timing and automatically lofts the ball", () => {
    const s = fixture("rift-volley");
    const server = s.players[0];
    tick(s, { [server.id]: { strikePressed: true } }, 8);
    expect(s.volley!.serving).toBe(false);
    expect(s.ball.vx).toBeGreaterThan(0);
    expect(s.ball.vz).toBeGreaterThan(0);
    expect(
      s.events.some((e) => e.type === "volley-contact" && e.kind === "serve"),
    ).toBe(true);
  });
  it("gives charged attacks a faster trajectory and credits the winning athlete", () => {
    const speeds: number[] = [];
    for (const charge of [0, 24]) {
      const s = volleyFixture();
      contact(s, 0);
      s.players[0].action!.charge = charge;
      tick(s);
      speeds.push(s.ball.vx);
    }
    expect(speeds[1]).toBeGreaterThan(speeds[0]);
    const s = volleyFixture();
    s.ball.x = 50 * F;
    s.ball.z = 1;
    s.ball.vz = -120 * F;
    s.ball.lastTouch = "player-0";
    s.volley!.lastContactId = "player-0";
    s.volley!.lastContactTeam = 0;
    tick(s);
    expect(s.participantStats["player-0"].goals).toBe(1);
  });
  it("lets another teammate touch immediately while one action cannot repeat", () => {
    const s = volleyFixture();
    contact(s, 0, "pass");
    tick(s);
    expect(s.volley!.teamContacts).toBe(1);
    // Explicit next-tick teammate contact is legal; there is no global debounce.
    contact(s, 1, "pass");
    tick(s);
    expect(s.volley!.teamContacts).toBe(2);
    expect(s.phase).toBe("play");
    const count = s.events.filter((e) => e.type === "volley-contact").length;
    tick(s, {}, 2);
    expect(s.events.filter((e) => e.type === "volley-contact")).toHaveLength(
      count,
    );
  });
  it("faults a fresh consecutive touch by the same athlete and a fourth team contact", () => {
    for (const fourth of [false, true]) {
      const s = volleyFixture();
      s.volley!.lastContactId = "player-0";
      s.volley!.lastContactTeam = 0;
      s.volley!.teamContacts = fourth ? 3 : 1;
      contact(s, fourth ? 1 : 0);
      tick(s);
      expect(s.score).toEqual([0, 1]);
      expect(s.events.find((e) => e.type === "rally-point")?.reason).toBe(
        fourth ? "four-contacts" : "double-touch",
      );
    }
  });
  it("clears a high net crossing and faults a low crossing", () => {
    for (const high of [false, true]) {
      const s = volleyFixture();
      s.ball.x = -4 * F;
      s.ball.z = (high ? 40 : 26) * F;
      s.ball.vx = 240 * F;
      s.volley!.lastContactTeam = 0;
      s.volley!.lastContactId = "player-0";
      tick(s);
      expect(s.phase).toBe(high ? "play" : "goal");
      if (high) expect(s.ball.x).toBeGreaterThanOrEqual(0);
      else
        expect(s.events.find((e) => e.type === "rally-point")?.reason).toBe(
          "net",
        );
    }
  });
  it("sweeps vertical drops and descending grazes against the entire net slab", () => {
    for (const [x, z, vx, vz, net] of [
      [0, 30, 0, -240, true],
      [-6, 31, 480, -480, true],
      [4.5, 30, 240, -480, true],
      [6, 31, 480, -480, false],
    ] as const) {
      const s = volleyFixture();
      s.ball.x = x * F;
      s.ball.z = z * F;
      s.ball.vx = vx * F;
      s.ball.vz = vz * F;
      s.volley!.lastContactId = "player-0";
      s.volley!.lastContactTeam = 0;
      tick(s);
      expect(
        s.events.some((e) => e.type === "rally-point" && e.reason === "net"),
      ).toBe(net);
      expect(s.phase).toBe(net ? "goal" : "play");
    }
  });
  it("resolves floor and closed end-wall faults before later player contacts", () => {
    for (const wall of [false, true]) {
      const s = volleyFixture();
      s.ball.x = wall ? 162 * F : 65 * F;
      s.ball.z = wall ? 40 * F : 1;
      s.ball.vx = wall ? 240 * F : 0;
      s.ball.vz = wall ? 0 : -120 * F;
      s.volley!.lastContactTeam = 0;
      s.volley!.lastContactId = "player-0";
      tick(s);
      expect(s.score).toEqual(wall ? [0, 1] : [1, 0]);
      expect(s.events.find((e) => e.type === "rally-point")?.reason).toBe(
        wall ? "wall" : "floor",
      );
    }
    const s = volleyFixture();
    s.ball.z = 0;
    contact(s, 0);
    tick(s);
    expect(s.events.find((e) => e.type === "rally-point")?.reason).toBe(
      "floor",
    );
  });
  it("limits dig height and automatically sets low balls with a committed slide", () => {
    for (const low of [false, true]) {
      const s = volleyFixture();
      s.ball.z = (low ? 10 : 35) * F;
      s.players[0].x = s.ball.x;
      s.players[0].y = s.ball.y;
      tick(s, { "player-0": { slide: true } });
      expect(
        s.events.some((e) => e.type === "volley-contact" && e.kind === "dig"),
      ).toBe(low);
    }
  });
  it("uses win-by-two with a hard cap, and keeps practice playable", () => {
    for (const [score, practice, finished] of [
      [[10, 10], false, false],
      [[10, 8], false, true],
      [[14, 14], false, true],
      [[10, 8], true, false],
    ] as const) {
      const s = volleyFixture();
      s.score = [...score];
      s.mode = practice ? "practice" : "match";
      s.ball.x = 50 * F;
      s.ball.z = 1;
      s.ball.vz = -120 * F;
      tick(s);
      expect(s.phase).toBe(finished ? "results" : "goal");
      if (!finished) {
        tick(s, {}, 70);
        expect(s.phase).toBe("play");
        expect(s.volley!.serving).toBe(true);
      }
    }
  });
  it("faults an idle human serve, and a disconnected server hands control to AI", () => {
    const s = fixture("rift-volley");
    tick(s, {}, 180);
    expect(
      s.events.some(
        (e) => e.type === "rally-point" && e.reason === "serve-timeout",
      ),
    ).toBe(true);
    const session = createCryptballSession({ sportId: "rift-volley" });
    session.setParticipantActive("local", false);
    for (let t = 0; t < 130; t++) session.step();
    expect(
      session
        .drainEvents()
        .some((e) => e.type === "volley-contact" && e.kind === "serve"),
    ).toBe(true);
  });
  for (const sportId of ["cryptkick", "rift-volley"] as const)
    it(`${sportId} bots complete a match and produce sport actions`, () => {
      const session = createCryptballSession({ sportId, seed: 7 });
      session.setParticipants([]);
      const types = new Set<string>();
      let contacts = 0;
      for (let t = 0; t < 30000 && session.observe().phase !== "results"; t++) {
        session.step();
        for (const e of session.drainEvents()) {
          types.add(e.type);
          if (e.type === "volley-contact") contacts++;
        }
        if (t % 97 === 0) session.restore(session.capture());
      }
      const o = session.observe();
      expect(o.phase).toBe("results");
      expect(o.score[0] + o.score[1]).toBeGreaterThan(0);
      if (sportId === "rift-volley") {
        expect(contacts).toBeGreaterThan(20);
        expect(types.has("rally-point")).toBe(true);
      } else expect(types.has("trap")).toBe(true);
    }, 30000);
});

describe("Volley physical size and flight integration", () => {
  it("lands its center at the radius and shares the exact free-flight cue with production", () => {
    const s = volleyFixture();
    s.ball.x = 60 * F;
    s.ball.y = 0;
    s.ball.z = 55 * F;
    s.ball.vx = 10 * F;
    s.ball.vy = 3 * F;
    s.ball.vz = 30 * F;
    s.ball.rx = 37;
    s.ball.ry = -51;
    s.ball.rz = 119;
    const projected = predictVolleyLanding(s.ball);
    expect(projected.landed).toBe(true);
    for (let i = 0; i < 180 && s.phase === "play"; i++) tick(s);
    expect(s.phase).toBe("goal");
    expect(s.ball.z).toBe(6 * F);
    expect(s.ball.x).toBe(projected.x);
    expect(s.ball.y).toBe(projected.y);
  });
  it("faults an embedded center immediately and emits contact at ball height", () => {
    const s = volleyFixture();
    s.ball.x = 60 * F;
    s.ball.z = 4 * F;
    s.ball.vz = 30 * F;
    tick(s);
    expect(s.ball.z).toBe(6 * F);
    expect(
      s.events.some((e) => e.type === "rally-point" && e.reason === "floor"),
    ).toBe(true);
    const receive = volleyFixture();
    contact(receive, 0, "pass");
    const before = { ...receive.ball };
    tick(receive);
    const event = receive.events.find((e) => e.type === "volley-contact")!;
    expect(event.x).toBe(before.x);
    expect(event.y).toBe(before.y);
    expect(event.height).toBeGreaterThan(5 * F);
    expect(typeof event.vz).toBe("number");
  });
});

it.each([
  ["cryptball", true], ["cryptkick", true], ["cryptcheck", true],
  ["rift-volley", false], ["crypt-dodge", false], ["crypt-guardian", false],
] as const)("defines pass control transfer policy for %s", (sportId, expected) => {
  expect(supportsPassControlTransfer(sportId)).toBe(expected);
});
