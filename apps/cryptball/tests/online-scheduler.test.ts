import { expect, it } from "vitest";
import { InputScheduler, replaySchedule } from "../src/online/input-scheduler";
import { Recovery } from "../src/online/recovery";
import { NetworkClock } from "../src/online/clock";
it("paces accumulator catch-up while preserving ordered press and release", () => {
  const s = new InputScheduler();
  s.capture({ strikePressed: true, strikeHeld: true }, 0, false);
  expect(s.allocate(10, 10, 0)?.command.strikePressed).toBe(true);
  s.capture({ strikeReleased: true }, 0, false);
  expect(s.allocate(10, 10, 0)).toBeNull();
  expect(s.allocate(11, 11, 17)?.command.strikeReleased).toBe(true);
  expect(s.queuedEdges).toBe(0);
});
it("increases and decreases lead without rewriting or duplicating slots", () => {
  const s = new InputScheduler();
  expect(s.allocate(10, 10, 0)?.tick).toBe(12);
  s.feedback(1, 1, -2, -2, 100);
  expect(s.lead).toBe(6);
  expect(s.allocate(11, 11, 100)?.tick).toBe(17);
  s.feedback(2, 1, 6, 6, 1200);
  expect(s.lead).toBe(5);
  expect(s.allocate(11, 11, 1200)).toBeNull();
  expect(s.allocate(13, 13, 1217)?.tick).toBe(18);
});
it("expires stale edges and accounts for overflow with bounded storage", () => {
  const s = new InputScheduler();
  s.capture({ strikePressed: true }, 0, false);
  s.capture({}, 101, false);
  expect(s.expired).toBe(1);
  expect(s.allocate(10, 10, 101)?.command.cancel).toBe(true);
  for (let i = 0; i < 9; i++) s.capture({ dash: true }, 110 + i, false);
  expect(s.overflow).toBe(1);
  expect(s.queuedEdges).toBe(0);
});
it("replays assigned ticks and removes confirmed rejections", () => {
  const p = {
    epoch: 1,
    generation: 1,
    revision: 0,
    seq: 1,
    tick: 10,
    command: { dash: true },
  };
  expect(
    replaySchedule(
      [p, { ...p, seq: 2, tick: 11 }],
      [
        { seq: 1, status: "accepted", executionTick: 12 },
        { seq: 2, status: "rejected" },
      ],
    ),
  ).toEqual([{ ...p, tick: 12 }]);
});
it("throttles recovery and satisfies it with newer checkpoint metadata", () => {
  const r = new Recovery();
  expect(r.request(0, 80, 1, 1, 10)?.id).toBe(1);
  expect(r.request(499, 80, 1, 1, 10)).toBeNull();
  expect(r.request(500, 80, 1, 1, 10)?.id).toBe(2);
  expect(r.request(1499, 80, 1, 1, 10)).toBeNull();
  r.satisfy(11);
  expect(r.pending).toBe(false);
});
it("validates outstanding ping identity and stops tick extrapolation in lobby", () => {
  const c = new NetworkClock();
  c.checkpoint(0, 0, "waiting");
  const ping = c.ping(0);
  expect(c.pong({epoch:1,serverTime:10,tick:0,phase:"waiting"},50,1)).toBe(false);
  expect(
    c.pong(
      { ...ping, id: 999, epoch: 1, serverTime: 10, tick: 0, phase: "waiting" },
      50,
      1,
    ),
  ).toBe(false);
  expect(
    c.pong(
      { ...ping, epoch: 1, serverTime: 10, tick: 0, phase: "waiting" },
      50,
      1,
    ),
  ).toBe(true);
  expect(c.rtt).toBe(50);
  expect(c.tick).toBe(0);
});
