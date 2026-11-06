import { expect, it } from "vitest";
import { InputScheduler, replaySchedule } from "../src/online/input-scheduler";
import { Recovery } from "../src/online/recovery";
import { NetworkClock } from "../src/online/clock";
it("accepts fixed-step catch-up while preserving ordered press and release", () => {
  const s = new InputScheduler();
  s.capture({ strikePressed: true, strikeHeld: true }, 0, false);
  expect(s.allocate(10, 10, 0)?.command.strikePressed).toBe(true);
  s.capture({ strikeReleased: true }, 0, false);
  expect(s.allocate(10, 10, 0)?.command.strikeReleased).toBe(true);
  expect(s.queuedEdges).toBe(0);
});
it("increases and decreases lead without rewriting or duplicating slots", () => {
  const s = new InputScheduler();
  expect(s.allocate(10, 10, 0)?.tick).toBe(12);
  s.feedback(1, 1, -2, -2, 100);
  expect(s.lead).toBe(6);
  expect(s.allocate(11, 11, 100)?.tick).toBe(17);
  expect(s.predictionRate(11)).toBe(1);
  s.feedback(2, 61, 6, 6, 1200);
  expect(s.lead).toBe(5);
  expect(s.allocate(11, 11, 1200)?.tick).toBe(18);
  expect(s.allocate(13, 13, 1217)?.tick).toBe(19);
  s.lead = 1;
  expect(s.predictionRate(10)).toBe(0.98);
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

it("does not repeatedly increase prediction lead from the same rolling receipt window", () => {
  const s = new InputScheduler();
  s.seed(150);
  expect(s.lead).toBe(7);
  s.feedback(10, 10, 0, 0, 1000);
  expect(s.lead).toBe(9);
  for (let count = 11; count < 70; count++)
    s.feedback(count, count, 0, 0, 1000 + count * 20);
  expect(s.lead).toBe(9);
  // A whole window of new receipts can justify another adjustment.
  s.feedback(70, 70, 0, 0, 2500);
  expect(s.lead).toBe(11);
  s.reset();
  s.feedback(1, 1, 0, 0, 2600);
  expect(s.lead).toBe(4);
});

it("allocates all 600 alternating cadence logical steps with consecutive ticks", () => {
  const s = new InputScheduler();
  let now = 0;
  const ticks: number[] = [];
  for (let n = 0; n < 600; n++) {
    now += n % 2 ? 1000 / 30 - 16 : 16;
    const serverTick = now / (1000 / 60);
    const slot = s.allocate(serverTick, Math.floor(serverTick), now);
    expect(slot).not.toBeNull();
    ticks.push(slot!.tick);
  }
  expect(ticks).toEqual(Array.from({ length: 600 }, (_, n) => ticks[0] + n));
});

for (const hz of [30, 59.94, 60, 90, 120, 144]) {
  it(`uses a single fixed-step clock at ${hz}Hz display cadence`, () => {
    const s = new InputScheduler();
    let debt = 0, count = 0, last = -1;
    const dt = 1000 / hz;
    for (let frame = 1; frame <= Math.floor(hz * 10); frame++) {
      const now = frame * dt;
      debt += dt;
      while (debt + 1e-8 >= 1000 / 60) {
        const serverTick = now / (1000 / 60);
        const slot = s.allocate(serverTick, Math.floor(serverTick), now);
        expect(slot).not.toBeNull();
        if (last >= 0) expect(slot!.tick).toBe(last + 1);
        last = slot!.tick;
        count++;
        debt -= 1000 / 60;
      }
    }
    expect(count).toBeGreaterThanOrEqual(599);
    expect(count).toBeLessThanOrEqual(600);
  });
}

it("bounds stalled authority and catch-up bursts without consuming queued release", () => {
  const s = new InputScheduler();
  s.capture({strikePressed:true,strikeHeld:true}, 0, false);
  expect(s.allocate(10, 10, 0)?.command.strikePressed).toBe(true);
  for (let n = 0; n < 22; n++) expect(s.allocate(10, 10, 0)).not.toBeNull();
  s.capture({strikeReleased:true}, 1, false);
  expect(s.allocate(10, 10, 1)).toBeNull();
  expect(s.queuedEdges).toBe(1);
  expect(s.allocate(11, 11, 17)?.command.strikeReleased).toBe(true);
  s.reset();
  expect(s.allocate(100, 100, 5000)?.tick).toBe(102);
  expect(s.queuedEdges).toBe(0);
});

it("allocates after an already predicted world when controller reset clears scheduler slots", () => {
  const s = new InputScheduler();
  s.capture({dash:true}, 0, false);
  const slot = s.allocate(10, 10, 0, 18);
  expect(slot?.tick).toBe(19);
  expect(slot?.command.dash).toBe(true);
  expect(s.allocate(11, 11, 17, 19)?.tick).toBe(20);
});

it("resets an unsampled match timeline without inventing a measured connection clock", () => {
  const clock=new NetworkClock();
  clock.resetTimeline();
  clock.checkpoint(5,100,"waiting");
  expect(clock.tick).toBe(5);
  expect(clock.rtt).toBe(80);
  clock.resetTimeline();
  expect(clock.tick).toBe(0);
  clock.checkpoint(3,200,"waiting");
  expect(clock.tick).toBe(3);
});

it("restores the configured arrival lead immediately after a forward server clock correction", () => {
  const scheduler = new InputScheduler();
  scheduler.seed(150);
  scheduler.capture({strikePressed:true,strikeHeld:true},0,false);
  expect(scheduler.allocate(100,100,0)?.tick).toBe(107);
  scheduler.capture({strikeReleased:true},17,false);
  const corrected=scheduler.allocate(110,110,17,107);
  expect(corrected?.tick).toBe(117);
  expect(corrected?.command.strikeReleased).toBe(true);
  expect(scheduler.allocate(111,111,34,117)).toMatchObject({tick:118});
  expect(scheduler.queuedEdges).toBe(0);
});

it("does not consume an action when the corrected safe target exceeds admission bounds", () => {
  const scheduler = new InputScheduler();
  scheduler.seed(150);
  expect(scheduler.allocate(100,100,0)?.tick).toBe(107);
  scheduler.capture({strikeReleased:true},17,false);
  expect(scheduler.allocate(130,100,17,107)).toBeNull();
  expect(scheduler.queuedEdges).toBe(1);
  expect(scheduler.allocate(130,130,17,107)).toMatchObject({tick:137,command:{strikeReleased:true}});
  expect(scheduler.queuedEdges).toBe(0);
});
