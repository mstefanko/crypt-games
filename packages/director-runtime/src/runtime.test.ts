import { describe, it, expect, vi } from "vitest";
import { createDemoScene, sceneDuration } from "../../director-core/src";
import {
  createPlaybackController,
  renderScene,
  createAudioHost,
} from "./index";
describe("reading and outcomes", () => {
  it("stops at a reading gate even when stepping across it", () => {
    const p = createPlaybackController(createDemoScene());
    p.play();
    p.step(800);
    expect(p.getState()).toMatchObject({
      tick: 779,
      playing: false,
      gate: "line-keeper",
    });
    p.advance();
    expect(p.getState().tick).toBe(780);
    p.step(400);
    expect(p.getState().ended).toBe(true);
  });
  it("first advance reveals, second continues", () => {
    const p = createPlaybackController(createDemoScene());
    p.seek(457);
    p.play();
    p.advance();
    p.step(20);
    expect(p.getState()).toMatchObject({
      tick: 457,
      revealed: true,
      playing: false,
    });
    p.advance();
    expect(p.getState()).toMatchObject({
      tick: 780,
      revealed: false,
      playing: true,
    });
  });
  it("emits exactly one outcome and disposal prevents late completion", () => {
    const complete = vi.fn(),
      skip = vi.fn(),
      p = createPlaybackController(createDemoScene(), {
        onComplete: complete,
        onSkip: skip,
      });
    p.skip();
    p.advance();
    expect(p.getState().playing).toBe(false);
    p.skip();
    p.play();
    p.step(1000);
    expect(skip).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    const q = createPlaybackController(createDemoScene(), {
      onComplete: complete,
    });
    q.seek(sceneDuration(createDemoScene()) - 1);
    q.play();
    q.step();
    q.skip();
    expect(complete).toHaveBeenCalledTimes(1);
    const disposed = createPlaybackController(createDemoScene(), {
      onComplete: complete,
      onSkip: skip,
    });
    disposed.dispose();
    disposed.play();
    disposed.advance();
    disposed.skip();
    disposed.step(9999);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(skip).toHaveBeenCalledTimes(1);
  });
});

it("direct rendering is deterministic after arbitrary seeks and rain is layered", () => {
  const calls: unknown[] = [];
  const gradient = {
    addColorStop: (...args: unknown[]) => calls.push(["stop", ...args]),
  };
  const context = new Proxy(
    {},
    {
      get(_target, key) {
        if (key === "createRadialGradient" || key === "createLinearGradient")
          return (...args: unknown[]) => {
            calls.push([key, ...args]);
            return gradient;
          };
        if (key === "measureText")
          return (text: string) => ({ width: text.length * 4 });
        return (...args: unknown[]) => calls.push([key, ...args]);
      },
      set(_target, key, value) {
        calls.push([key, value]);
        return true;
      },
    },
  );
  const canvas = {
      width: 768,
      height: 528,
      getContext: () => context,
    } as unknown as HTMLCanvasElement,
    scene = createDemoScene();
  renderScene(canvas, scene, 120);
  const first = JSON.stringify(calls);
  calls.length = 0;
  renderScene(canvas, scene, 800);
  calls.length = 0;
  renderScene(canvas, scene, 120);
  expect(JSON.stringify(calls)).toBe(first);
});

it("allows explicit seek to begin a new playthrough but disposal is terminal", () => {
  const scene = createDemoScene(),
    onComplete = vi.fn(),
    p = createPlaybackController(scene, { onComplete });
  p.seek(sceneDuration(scene) - 1);
  p.play();
  p.step();
  p.seek(sceneDuration(scene) - 1);
  expect(onComplete).toHaveBeenCalledTimes(1);
  p.play();
  p.step();
  expect(onComplete).toHaveBeenCalledTimes(2);
  p.dispose();
  p.seek(0);
  p.play();
  expect(p.getState().playing).toBe(false);
});
it("keeps audio and dialogue identities separate", () => {
  const sources: string[] = [];
  class FakeAudio {
    paused = true;
    volume = 1;
    duration = 100;
    currentTime = 0;
    constructor(source: string) {
      sources.push(source);
    }
    pause() {
      this.paused = true;
    }
    play() {
      this.paused = false;
      return Promise.resolve();
    }
    removeAttribute() {}
    load() {}
  }
  vi.stubGlobal("Audio", FakeAudio);
  try {
    const scene = createDemoScene();
    scene.media = [
      {
        id: "music",
        name: "a",
        mime: "audio/wav",
        dataUrl: "data:audio/wav;base64,YQ==",
        source: "Original",
        license: "MIT",
      },
      {
        id: "voice",
        name: "b",
        mime: "audio/wav",
        dataUrl: "data:audio/wav;base64,Yg==",
        source: "Original",
        license: "MIT",
      },
    ];
    scene.audio = [
      {
        id: "collision",
        kind: "music",
        title: "Music",
        mediaId: "music",
        start: 0,
        duration: 100,
        volume: 1,
      },
    ];
    scene.dialogue = [
      {
        ...scene.dialogue[0],
        shotId: scene.shots[0].id,
        id: "collision",
        start: 0,
        duration: 100,
        voiceMediaId: "voice",
      },
    ];
    const host = createAudioHost(scene);
    host.sync(1, true);
    expect(sources).toEqual(scene.media.map((m) => m.dataUrl));
    host.dispose();
  } finally {
    vi.unstubAllGlobals();
  }
});
it("separates editor Show from runtime Output", () => {
  const scene = createDemoScene();
  scene.actors = [];
  scene.dialogue = [];
  scene.layers = [
    {
      id: "sky",
      name: "Sky",
      kind: "sky",
      x: 0,
      y: 0,
      z: 0,
      visible: false,
      output: true,
      opacity: 1,
    },
  ];
  let fills = 0;
  const ctx = new Proxy(
    {},
    {
      get(_t, key) {
        if (key === "fillRect") return () => fills++;
        return () => {};
      },
      set() {
        return true;
      },
    },
  );
  const canvas = {
    width: 256,
    height: 176,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
  renderScene(canvas, scene, 0, { preview: true });
  const previewFills = fills;
  fills = 0;
  renderScene(canvas, scene, 0);
  expect(fills).toBeGreaterThan(previewFills + 20);
  scene.layers[0].visible = true;
  scene.layers[0].output = false;
  fills = 0;
  renderScene(canvas, scene, 0);
  const outputFills = fills;
  fills = 0;
  renderScene(canvas, scene, 0, { preview: true });
  expect(fills).toBeGreaterThan(outputFills + 20);
});
it("renders an empty scene without inventing station layers or actors", () => {
  const scene = createDemoScene();
  scene.style = "realistic";
  scene.layers = [];
  scene.actors = [];
  scene.motions = [];
  scene.dialogue = [];
  let fills = 0;
  const context = new Proxy(
    {},
    {
      get(_t, key) {
        if (key === "fillRect") return () => fills++;
        return () => {};
      },
      set() {
        return true;
      },
    },
  );
  renderScene(
    {
      width: 256,
      height: 176,
      getContext: () => context,
    } as unknown as HTMLCanvasElement,
    scene,
    0,
  );
  expect(fills).toBe(1);
});

it("disposal is terminal for changes and non-finite seeks/steps cannot corrupt time", () => {
  const onChange = vi.fn(),
    p = createPlaybackController(createDemoScene(), { onChange });
  p.play();
  p.step(12);
  p.seek(NaN);
  p.step(NaN);
  expect(p.getState().tick).toBe(12);
  p.dispose();
  onChange.mockClear();
  p.play();
  p.pause();
  p.seek(0);
  p.advance();
  p.skip();
  p.step();
  expect(onChange).not.toHaveBeenCalled();
  expect(p.getState()).toMatchObject({ playing: false, ended: true, tick: 12 });
});
it("scopes image hydration and ignores/cancels late media after disposal", async () => {
  const { hydrateSceneMedia } = await import("./index");
  const loaded: FakeImage[] = [];
  class FakeImage {
    naturalWidth = 24;
    naturalHeight = 32;
    src = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      loaded.push(this);
    }
  }
  vi.stubGlobal("Image", FakeImage);
  try {
    const scene = createDemoScene();
    scene.media = [
      {
        id: "image",
        name: "Image",
        mime: "image/png",
        dataUrl: "data:image/png;base64,YQ==",
        source: "Original",
        license: "MIT",
      },
    ];
    const images = new Map<string, HTMLImageElement>(),
      abort = new AbortController();
    const pending = hydrateSceneMedia(scene, { images, signal: abort.signal });
    const late = loaded[0].onload!;
    abort.abort();
    await pending;
    late();
    expect(images.size).toBe(0);
    expect(loaded[0].src).toBe("");
    const second = hydrateSceneMedia(scene, { images });
    loaded[1].onload!();
    await second;
    expect(images.size).toBe(1);
    images.clear();
    const isolated = new Map<string, HTMLImageElement>();
    const third = hydrateSceneMedia(scene, { images: isolated });
    expect(loaded.length).toBe(3);
    loaded[2].onload!();
    await third;
    expect(isolated.size).toBe(1);
    expect(images.size).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});
