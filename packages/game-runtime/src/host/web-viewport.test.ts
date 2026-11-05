import { afterEach, expect, it, vi } from "vitest";
import { WebHost } from "./web.ts";
afterEach(() => vi.unstubAllGlobals());
it("rearms DPR observation without CSS resize, and releases every viewport listener", () => {
  const queries: (EventTarget & { query: string })[] = [];
  const browser = Object.assign(new EventTarget(), {
    innerWidth: 700,
    innerHeight: 440,
    devicePixelRatio: 1,
    visualViewport: Object.assign(new EventTarget(), {
      width: 700,
      height: 440,
    }),
    screen: { orientation: new EventTarget() },
    matchMedia: (query: string) => {
      const value = Object.assign(new EventTarget(), { query });
      queries.push(value);
      return value;
    },
  });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", {
    documentElement: { append: vi.fn() },
    createElement: () => ({ style: {}, remove: vi.fn() }),
  });
  vi.stubGlobal("getComputedStyle", () => ({
    paddingTop: "11px",
    paddingRight: "12px",
    paddingBottom: "13px",
    paddingLeft: "14px",
  }));
  const host = new WebHost({} as HTMLElement);
  const listener = vi.fn();
  host.observeViewport(listener);
  expect(listener).toHaveBeenCalledOnce();
  expect(queries[0].query).toBe("(resolution: 1dppx)");
  browser.devicePixelRatio = 2;
  queries[0].dispatchEvent(new Event("change"));
  expect(listener).toHaveBeenCalledTimes(2);
  expect(queries[1].query).toBe("(resolution: 2dppx)");
  queries[0].dispatchEvent(new Event("change"));
  expect(listener).toHaveBeenCalledTimes(2);
  browser.visualViewport.dispatchEvent(new Event("resize"));
  expect(listener).toHaveBeenCalledTimes(3);
  host.dispose();
  queries[1].dispatchEvent(new Event("change"));
  browser.dispatchEvent(new Event("resize"));
  browser.visualViewport.dispatchEvent(new Event("resize"));
  browser.screen.orientation.dispatchEvent(new Event("change"));
  expect(listener).toHaveBeenCalledTimes(3);
});
