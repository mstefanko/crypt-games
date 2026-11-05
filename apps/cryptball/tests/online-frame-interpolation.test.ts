import { expect, it } from "vitest";
import { createInitialState } from "../sim/session";
import { FrameInterpolation } from "../src/online/frame-interpolation";
import { TICK_MS } from "../protocol";
it("renders movement on intervening frames when input allocation advances every other frame", () => {
  const f = new FrameInterpolation(),
    s = createInitialState("match", {}, "rift-volley");
  s.phase = "play";
  s.tick = 100;
  s.ball.x = 0;
  const positions: number[] = [];
  for (let frame = 0; frame < 60; frame++) {
    s.tick = 100 + Math.floor(frame / 2) * 2;
    s.ball.x = (s.tick - 100) * 256;
    const before = s.ball.x,
      draw = f.draw(s, frame * TICK_MS);
    expect(s.ball.x).toBe(before);
    if (frame > 5) positions.push(draw.ball.x);
  }
  for (let i = 1; i < positions.length; i++)
    expect(positions[i] - positions[i - 1]).toBeGreaterThan(150);
  for (let i = 1; i < positions.length; i++)
    expect(positions[i] - positions[i - 1]).toBeLessThan(350);
});
it("resets across scores, rallies, ownership changes and long browser pauses", () => {
  const f = new FrameInterpolation(),
    s = createInitialState("match", {}, "rift-volley");
  s.phase = "play";
  f.draw(s, 0);
  s.tick = 2;
  s.ball.x += 1000;
  f.draw(s, 33);
  for (const change of [
    () => s.score[0]++,
    () => s.volley!.rally++,
    () => (s.controlledId = "player-1"),
    () => (s.tick = 0),
  ]) {
    change();
    s.ball.x += 1000;
    expect(f.draw(s, 50).ball.x).toBe(s.ball.x);
  }
  s.tick = 10;
  s.ball.x += 1000;
  expect(f.draw(s, 1000).ball.x).toBe(s.ball.x);
});
it("keeps authoritative values and does not interpolate through a goal transition", () => {
  const f = new FrameInterpolation(),
    s = createInitialState();
  s.phase = "play";
  f.draw(s, 0);
  s.tick = 2;
  s.phase = "goal";
  s.score = [1, 0];
  s.ball.x = 9000;
  const result = f.draw(s, 33);
  expect(result).toBe(s);
  expect(result.score).toEqual([1, 0]);
});
