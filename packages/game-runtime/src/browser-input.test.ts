import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserInput } from "./input.ts";

function setup(getGamepads: () => (Gamepad | null)[] = () => []) {
  const events = new EventTarget();
  vi.stubGlobal("window", events);
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("navigator", { getGamepads });
  const input = new BrowserInput(
    { querySelectorAll: () => [] } as unknown as HTMLElement,
    () => {},
  );
  const key = (
    type: string,
    code: string,
    modifiers: Record<string, boolean> = {},
  ) => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      code,
      repeat: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      ...modifiers,
    });
    events.dispatchEvent(event);
    return event;
  };
  return { input, key };
}
afterEach(() => vi.unstubAllGlobals());
describe("browser device boundaries", () => {
  it("preserves browser shortcuts and cancels a held key when Command suppresses its keyup", () => {
    const { input, key } = setup();
    key("keydown", "KeyX");
    input.queue.consume();
    expect(key("keydown", "MetaLeft", { metaKey: true }).defaultPrevented).toBe(
      false,
    );
    expect(key("keydown", "KeyC", { metaKey: true }).defaultPrevented).toBe(
      false,
    );
    const frame = input.queue.consume().slots[0];
    expect(frame.held.attack).toBe(false);
    expect(frame.held.heavy).toBe(false);
    expect(frame.edges).toEqual([{ action: "attack", kind: "cancel" }]);
    key("keyup", "MetaLeft");
    expect(input.queue.consume().slots[0].held.attack).toBe(false);
    input.dispose();
  });
  it("ignores Control and Alt chords without preventing their native action", () => {
    const { input, key } = setup();
    for (const modifier of ["ctrlKey", "altKey"]) {
      expect(
        key("keydown", "KeyX", { [modifier]: true }).defaultPrevented,
      ).toBe(false);
    }
    expect(input.queue.consume().slots[0].edges).toEqual([]);
    input.dispose();
  });
  it("reports controller permission failure once and keeps keyboard input available", () => {
    const denied = vi.fn(() => {
      throw new Error("Permissions Policy denies gamepad");
    });
    const { input, key } = setup(denied);
    expect(() => input.poll()).toThrow("Gamepad input unavailable");
    input.poll();
    input.poll();
    expect(denied).toHaveBeenCalledTimes(1);
    key("keydown", "ArrowRight");
    expect(input.queue.consume().slots[0].held.right).toBe(true);
    input.dispose();
  });
});
