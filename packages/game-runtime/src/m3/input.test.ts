import { afterEach, expect, it, vi } from "vitest";
import { M3Input } from "./input";
class Control extends EventTarget {
  dataset = { control: "attack", slot: "0" };
  captures = new Set<number>();
  closest() {
    return this;
  }
  setPointerCapture(id: number) {
    this.captures.add(id);
  }
  hasPointerCapture(id: number) {
    return this.captures.has(id);
  }
  releasePointerCapture(id: number) {
    this.captures.delete(id);
  }
}
afterEach(() => vi.unstubAllGlobals());
it("two pointer sources sharing one action cancel independently and dispose releases capture", () => {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("HTMLElement", Control);
  vi.stubGlobal("Element", Control);
  const root = new Control();
  const input = new M3Input(
    root as unknown as HTMLElement,
    () => "arena",
    () => {},
  );
  input.setActive(true);
  const pointer = (type: string, pointerId: number) =>
    root.dispatchEvent(
      Object.assign(new Event(type, { cancelable: true }), { pointerId }),
    );
  pointer("pointerdown", 1);
  pointer("pointerdown", 2);
  expect(input.consume().fire).toBe(true);
  pointer("pointercancel", 1);
  expect(input.consume().fire).toBe(true);
  pointer("lostpointercapture", 2);
  const frame = input.consume();
  expect(frame.fire).toBe(false);
  expect(frame.edges).toEqual([{ action: "fire", kind: "cancel" }]);
  pointer("pointerdown", 3);
  input.dispose();
  expect(root.captures.has(3)).toBe(false);
  expect(input.consume().fire).toBe(false);
});
