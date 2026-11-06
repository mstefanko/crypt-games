import { expect, it, vi } from "vitest";
import { BrowserLifecycle } from "../../../packages/game-runtime/src/session/browser-lifecycle";

function fixture(releaseWhileVisible = false, hidden = false) {
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { hidden });
  const cancelInput = vi.fn(), onInputSuspension = vi.fn(), onPause = vi.fn();
  const lifecycle = new BrowserLifecycle({
    tick() {}, frame() {}, cancelInput, onPause, onDebt() {}, onPageExit() {},
    interruptionPolicy: "suspend-input", releaseInputWhileVisible: () => releaseWhileVisible, onInputSuspension,
  }, { window, document, requestFrame: () => 1, cancelFrame() {} });
  lifecycle.resume();
  return { window, document, lifecycle, cancelInput, onInputSuspension };
}

it("releases visible blur without suspending, then suspends hidden until focus returns", () => {
  const f = fixture(true);
  f.window.dispatchEvent(new Event("blur"));
  expect(f.cancelInput).toHaveBeenCalledOnce();
  expect(f.lifecycle.inputSuspended).toBe(false);
  expect(f.lifecycle.paused).toBe(false);
  expect(f.onInputSuspension).not.toHaveBeenCalled();
  f.document.hidden = true;
  f.document.dispatchEvent(new Event("visibilitychange"));
  expect(f.lifecycle.inputSuspended).toBe(true);
  f.document.hidden = false;
  f.document.dispatchEvent(new Event("visibilitychange"));
  expect(f.lifecycle.inputSuspended).toBe(true);
  f.window.dispatchEvent(new Event("focus"));
  expect(f.lifecycle.inputSuspended).toBe(false);
  expect(f.onInputSuspension.mock.calls.map(([s]) => s)).toEqual([true, false]);
  f.lifecycle.dispose();
});

it("preserves default blur interruption for existing hosts", () => {
  const f = fixture();
  f.window.dispatchEvent(new Event("blur"));
  expect(f.lifecycle.inputSuspended).toBe(true);
  f.lifecycle.dispose();
});

it("releases visible rotation for opted-in hosts but suspends hidden rotation", () => {
  const f = fixture(true);
  f.window.dispatchEvent(new Event("orientationchange"));
  expect(f.cancelInput).toHaveBeenCalledOnce();
  expect(f.onInputSuspension).not.toHaveBeenCalled();
  expect(f.lifecycle.paused).toBe(false);
  f.document.hidden = true;
  f.window.dispatchEvent(new Event("orientationchange"));
  expect(f.lifecycle.inputSuspended).toBe(true);
  f.lifecycle.dispose();
});

it("keeps the default visible orientation interruption", () => {
  const f = fixture();
  f.window.dispatchEvent(new Event("orientationchange"));
  expect(f.onInputSuspension.mock.calls.map(([s]) => s)).toEqual([true, false]);
  f.lifecycle.dispose();
});

it("reports a visible return when mounted in an already hidden document", () => {
  const f = fixture(true, true);
  expect(f.lifecycle.inputSuspended).toBe(true);
  f.document.hidden = false;
  f.document.dispatchEvent(new Event("visibilitychange"));
  expect(f.onInputSuspension).toHaveBeenCalledWith(false, undefined);
  f.lifecycle.dispose();
});
