import { expect, it } from "vitest";
import { createInitialState } from "../sim/session";
import { CoveredViewBuffer } from "../src/online/covered-view-buffer";

function sample(tick: number) {
  const s = createInitialState("match", {}, "crypt-dodge");
  s.phase = "play";
  s.tick = tick;
  s.players[0].x = tick * 256;
  for (const b of s.dodge!.balls) {
    b.mode.holderId = s.players[0].id;
    b.mode.state = "held";
    b.physical.x = s.players[0].x + 500;
  }
  return s;
}

it("buffers 100ms by server tick and interpolates all players and held balls coherently", () => {
  const f = new CoveredViewBuffer();
  for (let tick = 0; tick <= 12; tick += 3) f.ingest(sample(tick), tick * 1000 / 60, "epoch");
  const drawn = f.draw(225)!;
  expect(drawn.tick).toBeCloseTo(7.5);
  expect(drawn.state.players[0].x).toBe(7.5 * 256);
  for (const b of drawn.state.dodge!.balls)
    expect(b.physical.x - drawn.state.players[0].x).toBe(500);
  expect(drawn.state.ball).toBe(drawn.state.dodge!.balls[0].physical);
});

it("holds on underrun, grows delay to 150ms once per stall, and never reverses", () => {
  const f = new CoveredViewBuffer();
  f.ingest(sample(0), 0, "epoch");
  f.ingest(sample(3), 50, "epoch");
  expect(f.draw(200)!.tick).toBe(3);
  expect(f.draw(230)!.tick).toBe(3);
  expect(f.diagnostics.coveredBufferUnderruns).toBe(1);
  expect(f.diagnostics.coveredBufferDelayMs).toBe(125);
  f.ingest(sample(18), 300, "epoch");
  expect(f.draw(300)!.tick).toBeGreaterThanOrEqual(3);
  expect(f.draw(600)!.tick).toBe(18);
  expect(f.diagnostics.coveredBufferDelayMs).toBe(150);
  expect(f.draw(900)!.state.players[0].x).toBe(18 * 256);
});

it("ignores duplicate ticks and resets scene, epoch and backwards timelines", () => {
  const f = new CoveredViewBuffer(), s = sample(6);
  f.ingest(s, 100, "epoch");
  f.ingest(sample(6), 101, "epoch");
  expect(f.draw(110)!.state.players[0].x).toBe(6 * 256);
  const goal = sample(9);
  goal.score[0]++;
  f.ingest(goal, 150, "epoch");
  expect(f.draw(151)!.state.score[0]).toBe(goal.score[0]);
  expect(f.draw(151)!.tick).toBe(9);
  f.ingest(sample(0), 160, "epoch");
  expect(f.draw(161)!.tick).toBe(0);
  f.ingest(sample(20), 170, "new epoch");
  expect(f.draw(171)!.tick).toBe(20);
  f.reset();
  expect(f.draw(200)).toBeNull();
});

it("keeps ownership and all discrete state on the sampled timeline", () => {
  const f = new CoveredViewBuffer(), a = sample(0), b = sample(6);
  b.dodge!.balls[1].mode.holderId = null;
  b.dodge!.balls[1].mode.state = "dead-loose";
  b.dodge!.balls[1].physical.x = 9999;
  f.ingest(a, 0, "epoch");
  f.ingest(b, 100, "epoch");
  const middle = f.draw(150)!;
  expect(middle.tick).toBeCloseTo(3);
  expect(middle.state.dodge!.balls[1].mode.holderId).toBe(a.players[0].id);
  expect(middle.state.dodge!.balls[1].physical.x - middle.state.players[0].x).toBe(500);
  const end = f.draw(200)!;
  expect(end.state.dodge!.balls[1].mode.holderId).toBeNull();
  expect(end.state.dodge!.balls[1].physical.x).toBe(9999);
});

it("plays through bursty arrivals at a steady tick rate and reanchors long hidden gaps", () => {
  const f = new CoveredViewBuffer();
  f.ingest(sample(0), 0, "epoch");
  f.ingest(sample(3), 50, "epoch");
  f.ingest(sample(6), 100, "epoch");
  expect(f.draw(150)!.tick).toBeCloseTo(3);
  f.ingest(sample(9), 160, "epoch");
  f.ingest(sample(12), 160, "epoch");
  expect(f.draw(160)!.tick).toBeCloseTo(3.6);
  expect(f.draw(170)!.tick).toBeCloseTo(4.2);
  f.ingest(sample(180), 3000, "epoch");
  expect(f.draw(3001)!.tick).toBe(180);
});
