import { describe, expect, it } from "vitest";
import { createCryptballSession } from "../sim/session";
import type { BallPoseSample, Observation, SportId } from "../sim/contract";
import { LateLaunchPresentation } from "../src/online/late-launch";

const F = 256;
function fixture(sport: SportId = "cryptkick") {
  const state = createCryptballSession({ sportId: sport }).observe();
  state.phase = "play";
  state.tick = 100;
  state.restartTeam = 1;
  state.restartProtection = 30;
  state.possessionId = null;
  Object.assign(state.ball, {
    x: 70 * F,
    y: 0,
    z: sport === "rift-volley" ? 14 * F : 0,
    vx: 0,
    vy: 0,
    vz: 0,
  });
  if (state.volley) state.volley.serving = true;
  return state;
}
function release(base: Observation, tick: number): Observation {
  const state = structuredClone(base);
  state.tick = tick;
  state.restartProtection = 0;
  if (state.volley) state.volley.serving = false;
  Object.assign(state.ball, {
    x: base.ball.x - (tick - 100) * 4 * F,
    vx: -240 * F,
    lastTouch: "player-2",
  });
  return state;
}
const path = (s: Observation) => [
  s,
  ...Array.from({ length: 15 }, (_, i) => release(s, 101 + i)),
];

describe("recorded late restart launches", () => {
  for (const sport of ["cryptkick", "rift-volley"] as const) {
    it(`${sport} plays the recorded approach forward and catches the live ball`, () => {
      const helper = new LateLaunchPresentation(),
        start = fixture(sport);
      const samples = path(start);
      expect(helper.offer(start, samples, 0)).toBe(false);
      expect(helper.active).toBe(true);
      const first = helper.draw(samples[15], 0).state;
      expect(first.ball.x).toBe(start.ball.x);
      let previous = first.ball.x;
      for (let frame = 1; frame <= 16; frame++) {
        const live = release(start, 115 + frame);
        const drawn = helper.draw(live, (frame * 1000) / 60);
        expect(drawn.fade).toBe(false);
        expect(drawn.state.ball.x).toBeLessThan(previous);
        expect(previous - drawn.state.ball.x).toBeLessThanOrEqual(8 * F + 1);
        previous = drawn.state.ball.x;
      }
      expect(helper.active).toBe(false);
    });
  }
  it("fades at the real pose when the first available sample already crossed the court", () => {
    const helper = new LateLaunchPresentation(),
      start = fixture();
    expect(helper.offer(start, path(start).slice(10), 0)).toBe(true);
    expect(helper.active).toBe(false);
    expect(helper.draw(release(start, 115), 0).state.ball.x).toBe(10 * F);
  });
  it.each(["contact", "phase", "possession", "gap", "reverse"])(
    "abandons a buffered launch on %s",
    (kind) => {
      const helper = new LateLaunchPresentation(),
        start = fixture();
      helper.offer(start, path(start), 0);
      const next = release(start, 116);
      if (kind === "contact") next.ball.lastTouch = "player-3";
      if (kind === "phase") next.phase = "goal";
      if (kind === "possession") next.possessionId = "player-3";
      if (kind === "gap") next.tick = 119;
      if (kind === "reverse") next.ball.vx *= -1;
      expect(helper.draw(next, 16).fade).toBe(true);
      expect(helper.active).toBe(false);
    },
  );
  it("rejects discontinuous recorded samples and ordinary open play", () => {
    const helper = new LateLaunchPresentation(),
      start = fixture();
    const samples: BallPoseSample[] = path(start);
    samples[5].ball.x -= 30 * F;
    expect(helper.offer(start, samples, 0)).toBe(true);
    start.restartProtection = 0;
    expect(helper.candidate(start)).toBe(true);
    start.ball.lastTouch = "player-2";
    expect(helper.candidate(start)).toBe(false);
    helper.reset();
    expect(helper.active).toBe(false);
  });
  it.each(["cryptkick", "rift-volley"] as const)(
    "accepts actual %s simulation release markers",
    (sport) => {
      const session = createCryptballSession({ sportId: sport });
      const cp = session.capture();
      cp.state.phase = "play";
      cp.state.phaseTicks = 0;
      const player = cp.state.players[0];
      if (sport === "cryptkick") {
        cp.state.restartTeam = 0;
        cp.state.restartProtection = 60;
        player.x = -90 * F;
        player.y = 0;
        cp.state.ball.x = -70 * F;
        cp.state.ball.y = 0;
      }
      player.action = {
        id: cp.state.nextAction++,
        kind: "strike",
        elapsed: 3,
        timing: { tell: 3, active: 4, recover: 9 },
        hits: [],
        heading: 0,
        charge: 0,
      };
      // Keep the remaining athletes away from the recorded flight.
      for (const p of cp.state.players.slice(1)) {
        p.x = (p.team === 0 ? -130 : 130) * F;
        p.y = 70 * F;
      }
      session.restore(cp);
      const submitted = session.observe();
      const samples = [session.sampleBallPose()];
      for (let t = 0; t < 12; t++) {
        session.stepParticipants({ local: {} });
        samples.push(session.sampleBallPose());
      }
      expect(samples.some((s) => s.ball.vx !== 0)).toBe(true);
      if (sport === "rift-volley")
        expect(samples.at(-1)!.restartTeam).toBe(null);
      const helper = new LateLaunchPresentation();
      expect(helper.offer(submitted, samples, 0)).toBe(false);
      expect(helper.active).toBe(true);
      expect(helper.draw(session.observe(), 0).state.ball.x).toBe(
        submitted.ball.x,
      );
    },
  );
  it("joins a nearby first recorded flight point, but rejects glancing bounces", () => {
    const start = fixture(),
      helper = new LateLaunchPresentation();
    expect(helper.offer(start, path(start).slice(1), 0)).toBe(false);
    expect(helper.active).toBe(true);
    const next = release(start, 116);
    next.ball.vy = 100 * F;
    expect(helper.draw(next, 16).fade).toBe(true);
  });
  it("retains a forward buffer through repeated unchanged checkpoints and clears on reset", () => {
    const helper = new LateLaunchPresentation(),
      start = fixture();
    helper.offer(start, path(start), 0);
    let previous = start.ball.x;
    for (let frame = 1; frame <= 5; frame++) {
      const checkpoint = path(start);
      expect(helper.offer(start, checkpoint, frame * 16)).toBe(false);
      const draw = helper.draw(release(start, 115 + frame), frame * 16);
      expect(draw.fade).toBe(false);
      expect(draw.state.ball.x).toBeLessThan(previous);
      previous = draw.state.ball.x;
    }
    helper.reset();
    expect(helper.active).toBe(false);
    expect(helper.draw(release(start, 121), 100).state.ball.x).toBe(
      release(start, 121).ball.x,
    );
  });
  it("samples a detached ball without allocating or exposing actor state", () => {
    const session = createCryptballSession({ sportId: "cryptkick" });
    const sample = session.sampleBallPose();
    sample.ball.x += 100;
    sample.score[0]++;
    expect(session.sampleBallPose().ball.x).not.toBe(sample.ball.x);
    expect(session.sampleBallPose().score).toEqual([0, 0]);
    expect(sample).not.toHaveProperty("players");
  });
});
