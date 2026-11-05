import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../m3/view.ts", () => ({ M3View: class {} }));
import {
  ProductionPreview,
  type ProductionPreviewOptions,
  type ProductionPreviewResource,
} from "./preview.ts";
import type { ViewportMapping } from "./viewport.ts";

class Canvas extends EventTarget {
  hidden = false;
  parent?: Surface;
  remove() {
    this.parent?.children.delete(this);
    this.parent = undefined;
  }
}
class Surface {
  clientWidth = 700;
  clientHeight = 440;
  children = new Set<Canvas>();
  append(canvas: Canvas) {
    canvas.parent = this;
    this.children.add(canvas);
  }
}
class Resource {
  canvas = new Canvas();
  logicalSize = { width: 320, height: 180 };
  init = vi.fn(async () => {});
  dispose = vi.fn(() => this.canvas.remove());
  fail = false;
  resizeFail = false;
  states: unknown[] = [];
  viewport?: ViewportMapping;
  arena = vi.fn((state: any) => {
    this.states.push(structuredClone(state));
    state.value = "presenter mutation";
    if (this.fail) throw Error("draw failed");
  });
  board = this.arena;
  platform = this.arena;
  duel = vi.fn((previous: unknown, current: unknown) => this.arena(current));
  adventure = vi.fn((map: unknown, player: number, removed: string[]) =>
    this.arena({ map, player, removed }),
  );
  resizeViewport(mapping: ViewportMapping) {
    if (this.resizeFail) throw Error("resize failed");
    this.viewport = mapping;
  }
  stats() {
    return { submissions: this.states.length, viewport: this.viewport };
  }
}
let surface: Surface,
  resources: Resource[],
  observers: { callback: () => void; disconnect: ReturnType<typeof vi.fn> }[];
function setup(factory = () => new Resource()) {
  return new ProductionPreview(surface as unknown as HTMLElement, {
    skin: {} as ProductionPreviewOptions["skin"],
    duelDefinitions: {} as ProductionPreviewOptions["duelDefinitions"],
    createView: () => {
      const resource = factory();
      resources.push(resource);
      return resource as unknown as ProductionPreviewResource;
    },
  });
}
beforeEach(() => {
  surface = new Surface();
  resources = [];
  observers = [];
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      devicePixelRatio: 2,
      visualViewport: new EventTarget(),
    }),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      disconnect = vi.fn();
      constructor(callback: () => void) {
        observers.push({ callback, disconnect: this.disconnect });
      }
      observe() {}
    },
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => {
      throw Error("preview must not own a clock");
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
describe("production preview ownership", () => {
  it("can publish a supported profile after unsupported-profile cleanup throws", async () => {
    const preview = setup(() => {
      const resource = new Resource();
      if (!resources.length)
        resource.dispose.mockImplementation(() => {
          throw Error("unsupported cleanup failed");
        });
      return resource;
    });
    expect(await preview.present({ profile: "arena", state: {} })).toBe(true);
    expect(await preview.present({ profile: "unknown", state: {} })).toBe(
      false,
    );
    expect(preview.stats()).toMatchObject({
      active: 0,
      pending: 0,
      status: { state: "error" },
    });
    expect(surface.children.size).toBe(0);
    expect(await preview.present({ profile: "grid", state: {} })).toBe(true);
    expect(preview.stats()).toMatchObject({
      active: 1,
      pending: 0,
      status: { state: "ready", profile: "grid" },
    });
    preview.dispose();
  });
  it("removes an attached unpublished canvas even if publication and disposal both throw", async () => {
    const preview = setup(() => {
      const resource = new Resource();
      resource.canvas.addEventListener = () => {
        throw Error("listener allocation failed");
      };
      resource.dispose.mockImplementation(() => {
        throw Error("partial disposal failed");
      });
      return resource;
    });
    expect(await preview.present({ profile: "arena", state: {} })).toBe(false);
    expect(preview.stats()).toMatchObject({
      active: 0,
      pending: 0,
      status: { state: "error" },
    });
    expect(surface.children.size).toBe(0);
    expect(resources[0].dispose).toHaveBeenCalledTimes(1);
    preview.dispose();
  });
  it("retains an adopted replacement if the previous resource's disposal throws", async () => {
    const preview = setup(() => {
      const resource = new Resource();
      if (!resources.length)
        resource.dispose.mockImplementation(() => {
          throw Error("old cleanup failed");
        });
      return resource;
    });
    expect(await preview.present({ profile: "arena", state: {} })).toBe(true);
    expect(
      await preview.present({ profile: "grid", state: { value: 2 } }),
    ).toBe(true);
    expect(preview.stats()).toMatchObject({
      active: 1,
      pending: 0,
      status: { state: "ready", profile: "grid" },
    });
    expect([...surface.children]).toEqual([resources[1].canvas]);
    expect(resources[1].dispose).not.toHaveBeenCalled();
    preview.resize();
    expect(resources[1].states).toEqual([{ value: 2 }, { value: 2 }]);
    expect(
      await preview.present({ profile: "grid", state: { value: 3 } }),
    ).toBe(true);
    expect(resources).toHaveLength(2);
    expect(preview.stats().status.message).toContain("read-only");
    preview.dispose();
    expect(surface.children.size).toBe(0);
  });
  it("contains clone failure and retries the retained detached frame", async () => {
    const preview = setup(),
      scene = { profile: "arena", state: { value: 7 } };
    await preview.present(scene);
    scene.state.value = 99;
    await expect(
      preview.present({ profile: "arena", state: () => {} }),
    ).resolves.toBe(false);
    expect(preview.stats().status.state).toBe("error");
    expect(await preview.refresh()).toBe(true);
    expect(resources[1].states).toEqual([{ value: 7 }]);
    preview.dispose();
  });
  it("finishes teardown and reports disposed even when backend disposal fails", async () => {
    const preview = setup();
    await preview.present({ profile: "arena", state: {} });
    resources[0].dispose.mockImplementation(() => {
      throw Error("cleanup failure");
    });
    expect(() => preview.dispose()).not.toThrow();
    expect(preview.stats()).toMatchObject({
      disposed: true,
      active: 0,
      pending: 0,
      status: { state: "disposed" },
    });
    expect(surface.children.size).toBe(0);
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
    expect(() => preview.dispose()).not.toThrow();
  });
  it("ignores context loss from the old view while its replacement is starting", async () => {
    let finish!: () => void;
    const preview = setup(() => {
      const resource = new Resource();
      if (resources.length)
        resource.init.mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
        );
      return resource;
    });
    await preview.present({ profile: "arena", state: { value: 1 } });
    const pending = preview.present({ profile: "grid", state: { value: 2 } });
    resources[0].canvas.dispatchEvent(
      new Event("webglcontextlost", { cancelable: true }),
    );
    expect(preview.stats().status.state).toBe("error");
    finish();
    expect(await pending).toBe(true);
    expect(preview.stats().status).toMatchObject({
      state: "ready",
      profile: "grid",
    });
    resources[0].canvas.dispatchEvent(
      new Event("webglcontextlost", { cancelable: true }),
    );
    expect(preview.stats().status.state).toBe("ready");
    preview.dispose();
  });
  it("never reads the renderer-backed canvas getter after resource disposal", async () => {
    const preview = setup(() => {
      const resource = new Resource(),
        canvas = resource.canvas;
      let disposed = false;
      resource.dispose.mockImplementation(() => {
        canvas.remove();
        disposed = true;
      });
      Object.defineProperty(resource, "canvas", {
        get() {
          if (disposed) throw Error("renderer cleared by disposal");
          return canvas;
        },
      });
      return resource;
    });
    expect(await preview.present({ profile: "arena", state: {} })).toBe(true);
    expect(await preview.present({ profile: "grid", state: {} })).toBe(true);
    expect(surface.children.size).toBe(1);
    expect(() => preview.dispose()).not.toThrow();
    expect(surface.children.size).toBe(0);
    for (const resource of resources)
      expect(resource.dispose).toHaveBeenCalledTimes(1);
  });
  it("coalesces streaming frames into one pending resource and publishes the latest snapshot", async () => {
    let finish!: () => void;
    const preview = setup(() => {
      const resource = new Resource();
      resource.init.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      return resource;
    });
    const first = preview.present({ profile: "arena", state: { value: 1 } });
    const second = preview.present({ profile: "arena", state: { value: 2 } });
    const third = preview.present({ profile: "arena", state: { value: 3 } });
    expect(resources).toHaveLength(1);
    finish();
    expect(await Promise.all([first, second, third])).toEqual([
      true,
      true,
      true,
    ]);
    expect(resources[0].states).toEqual([{ value: 3 }]);
    expect(preview.stats().pending).toBe(0);
    preview.dispose();
  });
  it("discards rejected init without reading an unavailable canvas", async () => {
    const preview = setup(() => {
      const resource = new Resource();
      Object.defineProperty(resource, "canvas", {
        get() {
          throw Error("canvas not initialized");
        },
      });
      resource.init.mockRejectedValue(Error("renderer initialization failed"));
      resource.dispose.mockImplementation(() => {});
      return resource;
    });
    expect(await preview.present({ profile: "arena", state: {} })).toBe(false);
    expect(preview.stats().status.message).toContain(
      "renderer initialization failed",
    );
    expect(preview.stats().pending).toBe(0);
    expect(resources[0].dispose).toHaveBeenCalledTimes(1);
    preview.dispose();
  });
  it("contains a shared pending initialization rejection for every coalesced caller", async () => {
    let reject!: (reason: Error) => void;
    const preview = setup(() => {
      const resource = new Resource();
      resource.init.mockImplementation(
        () =>
          new Promise<void>((_, fail) => {
            reject = fail;
          }),
      );
      return resource;
    });
    const first = preview.present({ profile: "arena", state: { value: 1 } });
    const second = preview.present({ profile: "arena", state: { value: 2 } });
    reject(Error("shared init failure"));
    expect(await Promise.all([first, second])).toEqual([false, false]);
    expect(preview.stats()).toMatchObject({
      pending: 0,
      active: 0,
      status: { state: "error" },
    });
    expect(resources[0].dispose).toHaveBeenCalledTimes(1);
    preview.dispose();
  });
  it("uses one production resource per profile and redraws retained detached frames on resize without a clock", async () => {
    const preview = setup(),
      scene = { profile: "arena", state: { value: 1 } };
    expect(await preview.present(scene)).toBe(true);
    scene.state.value = 99;
    surface.clientWidth = 160;
    observers[0].callback();
    expect(resources[0].states).toEqual([{ value: 1 }, { value: 1 }]);
    expect(resources[0].viewport?.scale).toBe(0.5);
    for (let i = 0; i < 10; i++)
      await preview.present({ profile: "arena", state: { value: i } });
    expect(resources).toHaveLength(1);
    expect(surface.children.size).toBe(1);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    preview.dispose();
    preview.dispose();
    expect(resources[0].dispose).toHaveBeenCalledTimes(1);
    expect(surface.children.size).toBe(0);
  });
  it("superseded initialization never attaches or draws after a newer resource publishes", async () => {
    let finish!: () => void;
    const preview = setup(() => {
      const resource = new Resource();
      if (!resources.length)
        resource.init.mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
        );
      return resource;
    });
    const first = preview.present({ profile: "arena", state: { value: 1 } });
    expect(
      await preview.present({ profile: "grid", state: { value: 2 } }),
    ).toBe(true);
    finish();
    expect(await first).toBe(false);
    expect(resources[0].states).toEqual([]);
    expect(resources[0].dispose).toHaveBeenCalledTimes(1);
    expect([...surface.children]).toEqual([resources[1].canvas]);
    expect(preview.stats().status.profile).toBe("grid");
    preview.dispose();
  });
  it("disposal during init cancels publication and detaches all resize sources", async () => {
    let finish!: () => void;
    const preview = setup(() => {
      const resource = new Resource();
      resource.init.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      return resource;
    });
    const pending = preview.present({ profile: "arena", state: { value: 1 } });
    preview.dispose();
    finish();
    expect(await pending).toBe(false);
    window.dispatchEvent(new Event("resize"));
    window.visualViewport!.dispatchEvent(new Event("resize"));
    observers[0].callback();
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
    expect(surface.children.size).toBe(0);
    expect(resources[0].states).toEqual([]);
    expect(await preview.present({ profile: "grid", state: {} })).toBe(false);
    expect(preview.stats().status.state).toBe("disposed");
  });
  it("retains the adopted frame when replacement init or first-frame rendering fails", async () => {
    const preview = setup(() => {
      const resource = new Resource();
      if (resources.length === 1)
        resource.init.mockRejectedValue(Error("init failed"));
      if (resources.length === 2) resource.fail = true;
      return resource;
    });
    await preview.present({ profile: "arena", state: { value: 1 } });
    const first = resources[0];
    expect(
      await preview.present({ profile: "grid", state: { value: 2 } }),
    ).toBe(false);
    expect(preview.stats().status.message).toContain("init failed");
    expect(
      await preview.present({ profile: "grid", state: { value: 2 } }),
    ).toBe(false);
    expect(preview.stats().status.message).toContain("draw failed");
    expect(first.dispose).not.toHaveBeenCalled();
    expect([...surface.children]).toEqual([first.canvas]);
    expect(resources[1].dispose).toHaveBeenCalledTimes(1);
    expect(resources[2].dispose).toHaveBeenCalledTimes(1);
    // A later explicit replacement recovers without touching any game authority.
    expect(
      await preview.present({ profile: "grid", state: { value: 3 } }, true),
    ).toBe(true);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    preview.dispose();
  });
  it("contains render/resize failure and malicious mutation, then recovers with a fresh view", async () => {
    const preview = setup(),
      scene = { profile: "arena", state: { value: 7 } };
    await preview.present(scene);
    resources[0].fail = true;
    expect(await preview.present(scene)).toBe(false);
    expect(scene.state).toEqual({ value: 7 });
    expect(preview.stats().status).toMatchObject({ state: "error" });
    expect(await preview.present(scene)).toBe(true);
    resources[1].resizeFail = true;
    expect(() => window.dispatchEvent(new Event("resize"))).not.toThrow();
    expect(preview.stats().status.message).toContain("resize failed");
    preview.dispose();
  });
  it("cleans unsupported profiles and prior context listeners over repeated replacements", async () => {
    const preview = setup();
    for (let i = 0; i < 12; i++) {
      await preview.present(
        { profile: i % 2 ? "grid" : "arena", state: { value: i } },
        true,
      );
      expect(surface.children.size).toBe(1);
    }
    const old = resources[0].canvas;
    expect(
      old.dispatchEvent(new Event("webglcontextlost", { cancelable: true })),
    ).toBe(true);
    expect(preview.stats().status.state).toBe("ready");
    const active = resources.at(-1)!;
    expect(
      active.canvas.dispatchEvent(
        new Event("webglcontextlost", { cancelable: true }),
      ),
    ).toBe(false);
    expect(preview.stats().status.state).toBe("error");
    expect(await preview.present({ profile: "unknown", state: {} })).toBe(
      false,
    );
    expect(preview.stats().status.state).toBe("unsupported");
    expect(surface.children.size).toBe(0);
    expect(await preview.present({ profile: "arena", state: {} })).toBe(true);
    preview.dispose();
    for (const resource of resources)
      expect(resource.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("E2 family presenter adapters", () => {
  it("detaches platform and duel observations and forwards adventure map setup", async () => {
    const preview = setup();
    for (const profile of ["platform", "duel"]) {
      const state = { value: 1 };
      expect(
        await preview.present({
          profile,
          state:
            profile === "duel"
              ? { observation: state, guardSlots: [1] }
              : state,
        }),
      ).toBe(true);
      if (profile === "duel")
        expect(resources.at(-1)!.duel).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          0,
          0,
          [1],
        );
      expect(state).toEqual({ value: 1 });
      expect(resources.at(-1)!.states.at(-1)).toEqual({ value: 1 });
    }
    const state = {
      map: { width: 4, height: 4, walls: [] },
      player: 5,
      removed: ["gift"],
    };
    expect(await preview.present({ profile: "adventure", state })).toBe(true);
    expect(resources.at(-1)!.adventure).toHaveBeenCalledWith(state.map, 5, [
      "gift",
    ]);
    expect(state.map.walls).toEqual([]);
    preview.dispose();
    expect(surface.children.size).toBe(0);
  });
});
