import { describe, expect, it } from "vitest";
import { ActionMap, HeldKeyState } from "./action-map";
import { InputQueue } from "./input";

describe("shared physical mapping", () => {
  const map = new ActionMap([
    { code: "KeyA", action: "left" },
    { code: "ArrowLeft", action: "left" },
  ]);
  it("projects rapid taps and semantic pulses without creating held keys", () => {
    const frame = map.project(
      {
        held: new Set(),
        pressed: new Set(["KeyA"]),
        released: new Set(["KeyA"]),
      },
      ["left"],
    );
    expect([...frame.pressed]).toEqual(["left"]);
    expect([...frame.released]).toEqual(["left"]);
    expect(frame.held.size).toBe(0);
    expect(
      map.project({ held: new Set(), pressed: new Set() }).pressed.size,
    ).toBe(0);
  });
  it("validates bounded configuration", () => {
    expect(() => new ActionMap([{ code: "", action: "left" }])).toThrow();
    expect(() => new InputQueue(undefined, { actions: ["x", "x"] })).toThrow();
  });
  it("rearms only after release and suppresses repeats", () => {
    const state = new HeldKeyState();
    expect(state.press("KeyA")).toBe(true);
    expect(state.press("KeyA")).toBe(false);
    state.cancel();
    expect(state.press("KeyA")).toBe(false);
    state.release("KeyA");
    expect(state.press("KeyA")).toBe(true);
  });
});
describe("existing ordered queue compatibility", () => {
  it("aggregates aliases and consumes transitions once across grouped ticks", () => {
    const queue = new InputQueue(undefined, {
      actions: ["left", "right"],
      slots: 1,
    });
    queue.set("KeyA", 0, "left", true);
    queue.set("ArrowLeft", 0, "left", true);
    queue.set("KeyA", 0, "left", false);
    queue.set("KeyD", 0, "right", true);
    const first = queue.consume().slots[0];
    expect(first.edges).toEqual([
      { action: "left", kind: "pressed" },
      { action: "right", kind: "pressed" },
    ]);
    expect(first.axes.moveX).toBe(0);
    expect(first.held.left).toBe(true);
    expect(queue.consume().slots[0].edges).toEqual([]);
    queue.set("ArrowLeft", 0, "left", false);
    expect(queue.consume().slots[0].edges).toEqual([
      { action: "left", kind: "released" },
    ]);
  });
  it("keeps rapid press/release order until consumption and cancels overflow", () => {
    const diagnostics: string[] = [];
    const queue = new InputQueue((message) => diagnostics.push(message));
    queue.set("tap", 0, "jump", true);
    queue.set("tap", 0, "jump", false);
    expect(queue.consume().slots[0].edges.map((e) => e.kind)).toEqual([
      "pressed",
      "released",
    ]);
    for (let i = 0; i < 34; i++) queue.set("tap", 0, "jump", i % 2 === 0);
    expect(diagnostics).toHaveLength(1);
    expect(queue.consume().slots[0].held.jump).toBe(false);
  });
});
