import { describe, expect, it } from "vitest";
import { createCryptballSession, createInitialState } from "../sim/session";
import { dragBall, moveBall } from "../sim/ball";
import { predictBall } from "../sim/prediction";
import { groundBallPhysics, SPORT_BALL_PROFILES } from "../sim/sports-spec";
import { FIXED as F } from "../sim/rules";

describe("mode ball physics", () => {
  it("uses twelve pixel sports balls and keeps a clear football dribble gap", () => {
    expect(SPORT_BALL_PROFILES.cryptkick.radius).toBe(6);
    expect(SPORT_BALL_PROFILES["rift-volley"].radius).toBe(6);
    expect(SPORT_BALL_PROFILES.cryptkick.dribbleOffset).toBe(14);
    expect(SPORT_BALL_PROFILES.cryptball.radius).toBe(3);
  });
  it("keeps legacy defaults exact while soccer rolls shorter and rebounds softer", () => {
    const seed = createInitialState("practice").ball;
    seed.vx = 200 * F;
    const legacy = { ...seed }, explicit = { ...seed }, kick = { ...seed };
    for (let tick = 0; tick < 60; tick++) {
      dragBall(legacy);
      dragBall(explicit, groundBallPhysics("cryptball"));
      dragBall(kick, groundBallPhysics("cryptkick"));
    }
    expect(legacy).toEqual(explicit);
    expect(legacy.vx).toBe(170 * F);
    expect(kick.vx).toBe(164 * F);
    const bank = { ...seed, x: 0, y: 90 * F, vx: 0, vy: 240 * F };
    const a = { ...bank }, b = { ...bank };
    for (let i = 0; i < 6; i++) {
      moveBall(a, [], i, () => {});
      moveBall(b, [], i, () => {}, undefined, groundBallPhysics("cryptkick"));
    }
    expect(a.vy).toBeLessThan(0);
    expect(b.vy).toBeLessThan(0);
    expect(Math.abs(b.vy)).toBeLessThan(Math.abs(a.vy));
    expect(b.y).toBeLessThan(92 * F);
  });
  it("uses the chosen soccer body and drag throughout static prediction", () => {
    const b = createInitialState("practice", {}, "cryptkick").ball;
    b.x = 0; b.y = 90 * F; b.vx = 45 * F; b.vy = 240 * F;
    const physics = groundBallPhysics("cryptkick");
    const forecast = predictBall(b, 45, 0, physics);
    for (let t = 1; t <= 45; t++) {
      for (let sub = 0; sub < 4; sub++) moveBall(b, [], t, () => {}, undefined, physics);
      dragBall(b, physics);
      if (t % 3 === 0) expect(forecast.find((p) => p.tick === t)).toEqual({ x: b.x, y: b.y, tick: t });
    }
  });
  it("keeps a larger soccer ball clear of goal posts while accepting a centered goal", () => {
    const physics = groundBallPhysics("cryptkick");
    const clipped = createInitialState("practice", {}, "cryptkick").ball;
    clipped.x = 162 * F; clipped.y = 27 * F; clipped.vx = 380 * F;
    expect(moveBall(clipped, [], 0, () => {}, undefined, physics)).toBeNull();
    expect(clipped.vx).toBeLessThan(0);
    const centered = createInitialState("practice", {}, "cryptkick").ball;
    centered.x = 168 * F; centered.vx = 380 * F;
    expect(moveBall(centered, [], 0, () => {}, undefined, physics)).toBe(0);
  });
  it("rejects old checkpoints after the center-height rule change", () => {
    // The build gate rejects old peers; checkpoints also reject persisted v5 state.
    const session = createCryptballSession({ sportId: "rift-volley" });
    const old = { ...session.capture(), version: 5 };
    expect(() => session.restore(old)).toThrow("Incompatible checkpoint");
  });
});
