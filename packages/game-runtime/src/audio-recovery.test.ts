import { afterEach, expect, it, vi } from "vitest";
import { AudioRecoveryControl } from "./audio-recovery";
import type { M2Audio } from "./m2-audio";
afterEach(() => vi.unstubAllGlobals());
function control(enabled: () => boolean = () => true) {
  const button = Object.assign(new EventTarget(), {
    dataset: {},
    textContent: "",
    hidden: true,
    disabled: false,
  });
  vi.stubGlobal("document", { createElement: () => button });
  const state = { muted: false, error: "resume denied" as string | null };
  let resolve!: (enabled: boolean) => void;
  const unlock = vi.fn(
    () =>
      new Promise<boolean>((done) => {
        resolve = done;
      }),
  );
  const audio = { stats: () => state, unlock } as unknown as M2Audio;
  const abort = new AbortController(),
    message = vi.fn();
  const recovery = new AudioRecoveryControl(
    { append: vi.fn() } as unknown as HTMLElement,
    audio,
    abort.signal,
    message,
    enabled,
  );
  recovery.sync();
  return {
    button,
    state,
    unlock,
    abort,
    message,
    settle: async (enabled: boolean) => {
      resolve(enabled);
      await Promise.resolve();
    },
    recovery,
  };
}
it("one explicit pending retry cannot be duplicated and completion never unmutes", async () => {
  const c = control();
  c.button.dispatchEvent(new Event("click"));
  c.button.dispatchEvent(new Event("click"));
  expect(c.unlock).toHaveBeenCalledOnce();
  expect(c.button.disabled).toBe(true);
  c.state.muted = true;
  c.state.error = null;
  await c.settle(true);
  expect(c.button.hidden).toBe(true);
  expect(c.state.muted).toBe(true);
  expect(c.message).not.toHaveBeenCalled();
});
it("late device completion after unmount cannot update status or retry controls", async () => {
  const c = control();
  c.button.dispatchEvent(new Event("click"));
  c.abort.abort();
  c.state.error = null;
  await c.settle(true);
  expect(c.message).not.toHaveBeenCalled();
  expect(c.button.disabled).toBe(true);
});

it("policy disabled during pending unlock keeps retry disabled and suppresses completion", async () => {
  let enabled = true;
  const c = control(() => enabled);
  c.button.dispatchEvent(new Event("click"));
  expect(c.unlock).toHaveBeenCalledOnce();
  enabled = false;
  c.recovery.sync();
  await c.settle(true);
  expect(c.button.disabled).toBe(true);
  expect(c.message).not.toHaveBeenCalled();
  c.button.dispatchEvent(new Event("click"));
  expect(c.unlock).toHaveBeenCalledOnce();
  c.recovery.report("late failure");
  expect(c.message).not.toHaveBeenCalled();
  enabled = true;
  c.recovery.sync();
  expect(c.button.disabled).toBe(false);
});
