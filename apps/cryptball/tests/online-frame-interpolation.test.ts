import { expect, it, vi } from "vitest";
import { createInitialState } from "../sim/session";
import { FrameInterpolation } from "../src/online/frame-interpolation";
import { extractPoses } from "../src/online/poses";

for (const mode of [
  "cryptball",
  "cryptkick",
  "rift-volley",
  "cryptcheck",
  "crypt-dodge",
  "crypt-guardian",
] as const) {
  it(`${mode}: interpolates adjacent prediction with at most one tick of local delay`, () => {
    const f = new FrameInterpolation(),
      s = createInitialState("match", {}, mode);
    s.phase = "play";
    const p = s.players[0],
      x = p.x;
    f.capture(s);
    s.tick++;
    p.x += 256;
    f.capture(s);
    const drawn = f.draw(s, 16, 0.5);
    expect(drawn.players[0].x).toBe(x + 128);
    expect(p.x).toBe(x + 256);
    expect(f.draw(s, 20, 1).players[0].x).toBe(p.x);
    expect(drawn.tick).toBe(s.tick);
  });
}
it("captures intermediate simulation ticks during catch-up and clamps without extrapolation", () => {
  const f = new FrameInterpolation(),
    s = createInitialState();
  s.phase = "play";
  f.capture(s);
  for (let i = 0; i < 3; i++) {
    s.tick++;
    s.players[0].x += 256;
    f.capture(s);
  }
  expect(f.draw(s, 50, 0.5).players[0].x).toBe(s.players[0].x - 128);
  expect(f.draw(s, 51, 9).players[0].x).toBe(s.players[0].x);
});
it("ownership resets only that ball and keeps held balls attached to rendered holders", () => {
  const f = new FrameInterpolation(),
    s = createInitialState();
  s.phase = "play";
  f.capture(s);
  s.tick++;
  s.players[0].x += 256;
  s.possessionId = s.players[0].id;
  s.ball.x = s.players[0].x + 500;
  const drawn = f.draw(s, 16, 0.5);
  expect(drawn.players[0].x).toBe(s.players[0].x - 128);
  expect(drawn.ball.x - drawn.players[0].x).toBe(500);
});
it("resets scene on scores and long pauses, preserves authoritative values", () => {
  const f = new FrameInterpolation(),
    s = createInitialState();
  s.phase = "play";
  f.capture(s);
  s.tick++;
  s.players[0].x += 256;
  s.score[0]++;
  expect(f.draw(s, 16, 0).players[0].x).toBe(s.players[0].x);
  s.tick++;
  s.players[0].x += 256;
  expect(f.draw(s, 1000, 0).players[0].x).toBe(s.players[0].x);
  s.phase = "goal";
  expect(f.draw(s, 1010, 0)).toBe(s);
});
it("corrects only equal logical times and decays in the sole presentation owner", () => {
  const f = new FrameInterpolation(),
    before = createInitialState();
  before.phase = "play";
  const after = structuredClone(before);
  after.players[0].x += 256;
  f.correct(before, after, 0, "epoch");
  expect(f.draw(after, 0).players[0].x).toBe(before.players[0].x);
  expect(f.draw(after, 65).players[0].x).toBeGreaterThan(before.players[0].x);
  after.tick++;
  f.correct(before, after, 70, "epoch");
  expect(f.draw(after, 70).players[0].x).toBe(after.players[0].x);
});
it("uses all Dodge ball IDs, keeps primary alias, and resets retired/throw entities independently", () => {
  const f = new FrameInterpolation(),
    s = createInitialState("match", {}, "crypt-dodge");
  s.phase = "play";
  for (const b of s.dodge!.balls) {
    b.mode.holderId = null;
    b.mode.state = "dead-loose";
    b.physical.vx = 256;
  }
  f.capture(s);
  s.tick++;
  for (const b of s.dodge!.balls) b.physical.x += 256;
  const b = s.dodge!.balls[1];
  b.mode.throwId++;
  const result = f.draw(s, 16, 0.5);
  expect(result.dodge!.balls[0].physical.x).toBe(
    s.dodge!.balls[0].physical.x - 128,
  );
  expect(result.dodge!.balls[1].physical.x).toBe(b.physical.x);
  expect(result.ball).toBe(result.dodge!.balls[0].physical);
  expect(
    [...extractPoses(s).entities.keys()].filter((k) => k.startsWith("ball:")),
  ).toHaveLength(s.dodge!.balls.length);
});
it("covers Guardian orbs, moving boss and projectiles without changing telegraph timing", () => {
  const f = new FrameInterpolation(),
    s = createInitialState("match", {}, "crypt-guardian"),
    g = s.guardian!;
  s.phase = "play";
  for (const orb of g.orbs) {
    orb.possessionId = null;
    orb.ball.vx = 256;
  }
  g.projectiles.push({
    id: "test",
    x: 0,
    y: 0,
    vx: 256,
    vy: 0,
    radius: 1,
    lifeTicks: 20,
    attackId: 1,
    endX: 100,
    endY: 0,
    rx: 0,
    ry: 0,
  });
  f.capture(s);
  s.tick++;
  g.descriptor.x += 256;
  g.projectiles[0].x += 256;
  for (const orb of g.orbs) orb.ball.x += 256;
  const result = f.draw(s, 16, 0.5),
    drawn = result.guardian!;
  expect(drawn.descriptor.x).toBe(g.descriptor.x - 128);
  expect(drawn.projectiles[0].x).toBe(128);
  for (let i = 0; i < g.orbs.length; i++)
    expect(drawn.orbs[i].ball.x).toBe(g.orbs[i].ball.x - 128);
  expect(result.ball).toBe(
    drawn.orbs.find((o) => o.id === drawn.activeOrbId)!.ball,
  );
  expect(drawn.attack).toBe(g.attack);
  expect(drawn.projectiles[0].lifeTicks).toBe(20);
});
it("snaps rebound/contact direction changes instead of extrapolating through them", () => {
  const f = new FrameInterpolation(),
    s = createInitialState();
  s.phase = "play";
  s.ball.vx = 256;
  f.capture(s);
  s.tick++;
  s.ball.x += 256;
  s.ball.vx = -256;
  expect(f.draw(s, 16, 0.5).ball.x).toBe(s.ball.x);
});
it("periodic zero and nonzero corrections preserve the adjacent render interval", () => {
  const f = new FrameInterpolation(),
    s = createInitialState();
  s.phase = "play";
  f.capture(s);
  for (let tick = 1; tick <= 12; tick++) {
    s.tick++;
    s.players[0].x += 256;
    f.capture(s);
    const before = structuredClone(s);
    if (tick % 3 === 0) {
      if (tick % 6 === 0) s.players[0].x += 128;
      f.correct(before, s, tick * 16, "epoch");
    }
    const a = f.draw(s, tick * 16, 0),
      b = f.draw(s, tick * 16, 0.5),
      c = f.draw(s, tick * 16, 1);
    expect(b.players[0].x - a.players[0].x).toBe(128);
    expect(c.players[0].x - b.players[0].x).toBe(128);
  }
});
it("never carries a correction offset across a ball generation", () => {
  const f = new FrameInterpolation(),
    a = createInitialState();
  a.phase = "play";
  const b = structuredClone(a);
  b.ball.x += 256;
  f.correct(a, b, 0, "epoch");
  const next = structuredClone(b);
  next.possessionId = next.players[0].id;
  f.correct(next, next, 10, "epoch");
  expect(f.draw(next, 10).ball.x).toBe(next.ball.x);
});
it("keeps corrected Volley ball centers above the radius floor", () => {
  const f = new FrameInterpolation(),
    a = createInitialState("match", {}, "rift-volley");
  a.phase = "play";
  a.ball.z = 0;
  const b = structuredClone(a);
  b.ball.z = 1;
  f.correct(a, b, 0, "epoch");
  expect(f.draw(b, 0).ball.z).toBeGreaterThan(1);
});
it("does not retain offsets when confirmed correction pairs already reflect a new scene", () => {
  const f = new FrameInterpolation(),
    a = createInitialState();
  a.phase = "play";
  const b = structuredClone(a);
  b.players[0].x += 256;
  f.correct(a, b, 0, "epoch");
  const round = structuredClone(b);
  round.score[0]++;
  f.correct(round, round, 10, "epoch");
  expect(f.draw(round, 10).players[0].x).toBe(round.players[0].x);
});
it("bounds fast-ball teleport detection using per-tick displacement rather than per-second velocity", () => {
  const f = new FrameInterpolation(),
    s = createInitialState();
  s.phase = "play";
  s.ball.vx = 600 * 256;
  f.capture(s);
  s.tick++;
  s.ball.x += 10 * 256;
  expect(f.draw(s, 16, 0.5).ball.x).toBe(s.ball.x - 5 * 256);
  s.tick++;
  s.ball.x += 100 * 256;
  expect(f.draw(s, 32, 0.5).ball.x).toBe(s.ball.x);
});
it("normal control switches preserve unrelated entity interpolation while explicit ownership resets snap", () => {
  const f = new FrameInterpolation(),
    s = createInitialState();
  s.phase = "play";
  f.capture(s);
  s.tick++;
  s.players[1].x += 256;
  f.capture(s);
  const before = structuredClone(s);
  s.controlledId = s.players[1].id;
  f.correct(before, s, 16, "epoch:generation:participant");
  expect(f.draw(s, 16, 0.5).players[1].x).toBe(s.players[1].x - 128);
  expect(f.draw(s, 17, 1).players[1].x).toBe(s.players[1].x);
  f.correct(s, s, 18, "epoch:generation:participant", true);
  expect(f.draw(s, 18, 0.5).players[1].x).toBe(s.players[1].x);
});
it("captured rendering reuses lifecycle extraction and safely falls back after reset", () => {
  const f = new FrameInterpolation(),
    s = createInitialState();
  s.phase = "play";
  f.capture(s);
  s.tick++;
  s.players[0].x += 256;
  f.capture(s);
  Object.defineProperty(s.ball, "passTick", {
    get() {
      throw Error("duplicate pose extraction");
    },
    enumerable: false,
    configurable: true,
  });
  expect(f.drawCaptured(s, 16, 0.5).players[0].x).toBe(s.players[0].x - 128);
  Object.defineProperty(s.ball, "passTick", { value: 0, configurable: true });
  f.reset();
  expect(f.drawCaptured(s, 32, 0.5).players[0].x).toBe(s.players[0].x);
});
it("generation markers do not serialize entity identities and remain detached", () => {
  const s = createInitialState();
  s.phase = "play";
  s.ball.lastTouch = 'player:[null,"marker"]';
  const frame = extractPoses(s),
    generation = frame.entities.get("ball:primary")!.generation;
  expect(generation).toContain(s.ball.lastTouch);
  s.ball.lastTouch = "different";
  expect(generation).not.toContain("different");
});

it("serializes only the scene key rather than every entity generation", () => {
  const s = createInitialState("match", {}, "crypt-dodge");
  const stringify = vi.spyOn(JSON, "stringify");
  try {
    const pose = extractPoses(s);
    expect(pose.entities.size).toBeGreaterThan(1);
    expect(stringify).toHaveBeenCalledTimes(1);
  } finally {
    stringify.mockRestore();
  }
});
