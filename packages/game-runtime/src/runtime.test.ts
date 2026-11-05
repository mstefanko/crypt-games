import { describe, expect, it } from "vitest";
import { FixedScheduler } from "./scheduler.ts";
import { InputQueue } from "./input.ts";
import { interpolatePosition } from "./interpolation.ts";

describe("single fixed scheduler", () => {
  it("produces identical explicit ticks across steady and uneven schedules", () => {
    const count = (schedule: number[]) => {
      let ticks = 0;
      const runner = new FixedScheduler(
        () => ticks++,
        () => {
          throw new Error("unexpected debt");
        },
      );
      runner.resume();
      for (const time of schedule) runner.advance(time);
      return ticks;
    };
    expect(count(Array.from({ length: 61 }, (_, i) => (i * 1000) / 60))).toBe(
      60,
    );
    expect(count([0, 8, 17, 42, 55, 90, 100, 150, 175, 200])).toBe(12);
  });
  it("commits at most five ticks then pauses without skipping debt into a later tick", () => {
    let ticks = 0;
    let pauses = 0;
    const runner = new FixedScheduler(
      () => ticks++,
      () => pauses++,
    );
    runner.resume();
    runner.advance(0);
    runner.advance(1000);
    expect(ticks).toBe(5);
    expect(pauses).toBe(1);
    expect(runner.paused).toBe(true);
    runner.advance(2000);
    expect(ticks).toBe(5);
    runner.resume();
    runner.advance(3000);
    runner.advance(3017);
    expect(ticks).toBe(6);
  });
  it("retains edges across no-step frames and consumes each edge just once during catch-up", () => {
    const queue = new InputQueue();
    const frames: ReturnType<InputQueue["consume"]>[] = [];
    const runner = new FixedScheduler(
      () => frames.push(queue.consume()),
      () => {},
    );
    runner.resume();
    runner.advance(0);
    queue.set("key", 0, "attack", true);
    runner.advance(5);
    expect(frames).toHaveLength(0);
    runner.advance(50);
    expect(frames).toHaveLength(3);
    expect(frames[0].slots[0].edges).toEqual([
      { action: "attack", kind: "pressed" },
    ]);
    expect(frames[1].slots[0].edges).toEqual([]);
    expect(frames[2].slots[0].held.attack).toBe(true);
  });
});

describe("semantic device queue", () => {
  it("retains ordered taps between ticks", () => {
    const queue = new InputQueue();
    queue.set("key", 0, "attack", true);
    queue.set("key", 0, "attack", false);
    expect(queue.consume().slots[0]).toMatchObject({
      held: { attack: false },
      edges: [
        { action: "attack", kind: "pressed" },
        { action: "attack", kind: "released" },
      ],
    });
    expect(queue.consume().slots[0].edges).toEqual([]);
  });
  it("keeps pointer sources independent and cancellation never becomes release", () => {
    const queue = new InputQueue();
    queue.set("pointer:1", 0, "jump", true);
    queue.set("pointer:2", 0, "jump", true);
    queue.consume();
    queue.set("pointer:1", 0, "jump", false, true);
    expect(queue.consume().slots[0]).toMatchObject({
      held: { jump: true },
      edges: [],
    });
    queue.cancelSource("pointer:2");
    expect(queue.consume().slots[0].edges).toEqual([
      { action: "jump", kind: "cancel" },
    ]);
  });
  it("neutralizes opposing digital directions and isolates local slots", () => {
    const queue = new InputQueue();
    queue.set("left", 0, "left", true);
    queue.set("right", 0, "right", true);
    queue.axis("pad", 1, -85);
    const frame = queue.consume();
    expect(frame.slots[0].axes.moveX).toBe(0);
    expect(frame.slots[1].axes.moveX).toBe(-85);
  });
  it("preserves an unconsumed press before ordered cancel and prevents held input on resume", () => {
    const queue = new InputQueue();
    queue.set("key", 0, "heavy", true);
    queue.cancelAll();
    const frame = queue.consume();
    expect(frame.slots[0].edges[0]).toEqual({
      action: "heavy",
      kind: "pressed",
    });
    expect(frame.slots[0].edges).toContainEqual({
      action: "heavy",
      kind: "cancel",
    });
    expect(frame.slots[0].held.heavy).toBe(false);
  });
  it("keeps a consumed hold then queued release valid when blur cancels before the next tick", () => {
    const queue = new InputQueue();
    queue.set("key", 0, "right", true);
    queue.consume();
    queue.set("key", 0, "right", false);
    queue.cancelAll();
    const frame = queue.consume();
    expect(frame.slots[0].held.right).toBe(false);
    expect(frame.slots[0].edges[0]).toEqual({
      action: "right",
      kind: "released",
    });
    expect(frame.slots[0].edges).toContainEqual({
      action: "right",
      kind: "cancel",
    });
  });
  it("cancels checkpoint-held actions even when the browser has no matching held source", () => {
    const queue = new InputQueue();
    queue.cancelAll(true);
    expect(queue.consume().slots[0].edges).toContainEqual({
      action: "heavy",
      kind: "cancel",
    });
  });
  it("fails safe on live overflow instead of dropping a release", () => {
    const errors: string[] = [];
    const queue = new InputQueue((error) => errors.push(error));
    for (let i = 0; i < 33; i++) queue.set("key", 0, "attack", i % 2 === 0);
    const frame = queue.consume();
    expect(errors).toHaveLength(1);
    expect(frame.slots[0].edges.every((edge) => edge.kind === "cancel")).toBe(
      true,
    );
    expect(frame.slots[0].held.attack).toBe(false);
  });
});

describe("interpolation discontinuities", () => {
  const actor = { id: 1, x: 100, y: 200, motionEpoch: 0 };
  it("interpolates detached matching identities", () =>
    expect(interpolatePosition({ ...actor, x: 0 }, actor, 0.5, 1, 1)).toEqual({
      x: 50,
      y: 200,
    }));
  it("snaps on actor replacement, teleport and exact checkpoint restore", () => {
    for (const previous of [
      { ...actor, id: 2 },
      { ...actor, motionEpoch: 1 },
    ])
      expect(interpolatePosition(previous, actor, 0.5, 1, 1)).toEqual({
        x: 100,
        y: 200,
      });
    expect(interpolatePosition({ ...actor, x: 0 }, actor, 0.5, 1, 2)).toEqual({
      x: 100,
      y: 200,
    });
  });
});
