import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { GameDefinitions } from "../../game-project/src/types.ts";
import type { PreparedSkin } from "./m2-assets.ts";
import copperData from "../../../examples/game-m2/prepared-assets/copper.json";
import moonData from "../../../examples/game-m2/prepared-assets/moon.json";
const owned = vi.hoisted(() => ({
  textures: [] as any[],
  frameCount: 0,
  throwFrame: 0,
}));
vi.mock("pixi.js", () => {
  class Node {
    addChild = vi.fn();
    destroy = vi.fn();
    position = { set: vi.fn() };
  }
  class Texture {
    source: any;
    destroy = vi.fn();
    constructor(options?: any) {
      if (options && ++owned.frameCount === owned.throwFrame)
        throw Error("texture setup failed");
      this.source = options?.source ?? {};
      owned.textures.push(this);
    }
    static from() {
      return new Texture();
    }
  }
  return {
    Application: class {
      stage = new Node();
    },
    Container: Node,
    Graphics: Node,
    BitmapText: Node,
    Sprite: Node,
    Texture,
    Rectangle: class {
      constructor(..._values: any[]) {}
    },
    BitmapFont: class {},
    Cache: {},
  };
});
import { M2View } from "./m2-view.ts";
type Skin = PreparedSkin & { atlasUrl: string };
const copper = {
  ...copperData,
  atlasUrl: "https://assets.invalid/copper.png",
} as unknown as Skin;
const moon = {
  ...moonData,
  atlasUrl: "https://assets.invalid/moon.png",
} as unknown as Skin;
const pngs = {
  copper: readFileSync(
    new URL(
      "../../../examples/game-m2/prepared-assets/copper.png",
      import.meta.url,
    ),
  ),
  moon: readFileSync(
    new URL(
      "../../../examples/game-m2/prepared-assets/moon.png",
      import.meta.url,
    ),
  ),
};
function response(skin: "copper" | "moon") {
  return new Response(new Uint8Array(pngs[skin]));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function bitmap(skin: Skin) {
  return {
    width: skin.atlas.width,
    height: skin.atlas.height,
    close: vi.fn(),
  } as unknown as ImageBitmap;
}
let fetchMock: ReturnType<typeof vi.fn>, decodeMock: ReturnType<typeof vi.fn>;
const views: M2View[] = [];
const bitmaps: ImageBitmap[] = [];
function view() {
  const value = new M2View({} as GameDefinitions, copper);
  views.push(value);
  return value;
}
beforeEach(() => {
  owned.textures = [];
  owned.frameCount = 0;
  owned.throwFrame = 0;
  bitmaps.length = 0;
  fetchMock = vi.fn(async (url: string) =>
    response(url.includes("moon") ? "moon" : "copper"),
  );
  decodeMock = vi.fn(async (blob: Blob) => {
    const image = bitmap(blob.size === moon.atlas.bytes ? moon : copper);
    bitmaps.push(image);
    return image;
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("createImageBitmap", decodeMock);
});
afterEach(() => {
  for (const instance of views.splice(0)) instance.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("keeps the old skin and all displayed textures on HTTP or hash failure", async () => {
  const instance = view();
  await instance.setSkin(copper);
  const old = owned.textures.slice();
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
  await expect(instance.setSkin(moon)).rejects.toThrow("503");
  const stale = structuredClone(moon);
  stale.atlas.sha256 = "0".repeat(64);
  await expect(instance.setSkin(stale)).rejects.toThrow("hash differs");
  expect(instance.skinId).toBe("copper");
  expect(instance.metrics.activeTextures).toBe(64);
  expect(instance.metrics.skinLoading).toBe(false);
  for (const texture of old) expect(texture.destroy).not.toHaveBeenCalled();
  expect(bitmaps[0].close).not.toHaveBeenCalled();
  expect(decodeMock).toHaveBeenCalledTimes(1);
});
it("destroys partially staged textures and bitmap without touching the displayed skin", async () => {
  const instance = view();
  await instance.setSkin(copper);
  const old = owned.textures.slice(),
    oldBitmap = bitmaps[0];
  owned.throwFrame = owned.frameCount + 4;
  await expect(instance.setSkin(moon)).rejects.toThrow("texture setup failed");
  expect(instance.skinId).toBe("copper");
  expect(instance.metrics.activeTextures).toBe(64);
  for (const texture of old) expect(texture.destroy).not.toHaveBeenCalled();
  for (const texture of owned.textures.slice(old.length))
    expect(texture.destroy).toHaveBeenCalledOnce();
  expect(oldBitmap.close).not.toHaveBeenCalled();
  expect(bitmaps[1].close).toHaveBeenCalledOnce();
});
it("aborts a superseded fetch and never installs an out-of-order response", async () => {
  const instance = view();
  await instance.setSkin(copper);
  const pending = deferred<Response>();
  let signal!: AbortSignal;
  fetchMock.mockImplementationOnce((_url, options) => {
    signal = options.signal;
    return pending.promise;
  });
  const old = instance.setSkin(moon);
  await instance.setSkin(copper);
  expect(signal.aborted).toBe(true);
  pending.resolve(response("moon"));
  expect(await old).toBe(false);
  expect(instance.skinId).toBe("copper");
  expect(decodeMock).toHaveBeenCalledTimes(2);
  expect(instance.metrics.skinLoadsCancelled).toBe(1);
});
it("cancels a pending stream read before any superseded hash or decode", async () => {
  const instance = view();
  await instance.setSkin(copper);
  const cancel = vi.fn();
  let pulls = 0;
  fetchMock.mockResolvedValueOnce(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(pngs.moon.subarray(0, 4)));
        },
        pull() {
          pulls++;
        },
        cancel,
      }),
    ),
  );
  const old = instance.setSkin(moon);
  await vi.waitFor(() => expect(pulls).toBeGreaterThan(0));
  await instance.setSkin(copper);
  expect(await old).toBe(false);
  expect(cancel).toHaveBeenCalled();
  expect(decodeMock).toHaveBeenCalledTimes(2);
  expect(instance.skinId).toBe("copper");
});
it("does not start decode after a superseded hash completes", async () => {
  const instance = view();
  await instance.setSkin(copper);
  const pending = deferred<ArrayBuffer>(),
    original = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest")
    .mockImplementationOnce(() => pending.promise)
    .mockImplementation(original);
  const old = instance.setSkin(moon);
  await vi.waitFor(() => expect(crypto.subtle.digest).toHaveBeenCalledTimes(1));
  await instance.setSkin(copper);
  pending.resolve(await original("SHA-256", new Uint8Array(pngs.moon)));
  expect(await old).toBe(false);
  expect(decodeMock).toHaveBeenCalledTimes(2);
  expect(instance.skinId).toBe("copper");
});
it.each(["supersede", "dispose"] as const)(
  "settles %s promptly during decode and closes its eventual bitmap",
  async (mode) => {
    const instance = view();
    await instance.setSkin(copper);
    const pending = deferred<ImageBitmap>(),
      late = bitmap(moon);
    decodeMock.mockImplementationOnce(() => pending.promise);
    const old = instance.setSkin(moon);
    await vi.waitFor(() => expect(decodeMock).toHaveBeenCalledTimes(2));
    if (mode === "dispose") instance.dispose();
    else await instance.setSkin(copper);
    expect(await old).toBe(false);
    expect(late.close).not.toHaveBeenCalled();
    pending.resolve(late);
    await Promise.resolve();
    expect(late.close).toHaveBeenCalledOnce();
    expect(instance.metrics.activeTextures).toBe(mode === "dispose" ? 0 : 64);
    expect(instance.skinId).toBe("copper");
    if (mode === "dispose") {
      const calls = fetchMock.mock.calls.length;
      expect(await instance.setSkin(moon)).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(calls);
    }
  },
);
it("still rejects an initial unavailable skin when no displayed resources exist", async () => {
  const instance = view();
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
  await expect(instance.setSkin(copper)).rejects.toThrow("404");
  expect(instance.metrics.activeTextures).toBe(0);
});
