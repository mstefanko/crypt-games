import { expect, it, vi } from "vitest";
import rawScene from "../../../examples/game-m2/cinematic.json";
import pack from "../../../examples/game-m2/prepared-assets/director-pack.json";
const sceneData = { ...rawScene, assets: pack.assets, media: pack.media };
import { M2Director, readM2Scene } from "./m2-director";
import type { hydrateSceneMedia } from "@onepage/director-runtime";
const slot = { instanceId: "slot-1", flowEpoch: 4 };
function director(
  hydrate: typeof hydrateSceneMedia = async (scene, options) => {
    for (const item of scene.media)
      options?.images?.set(item.dataUrl, {} as HTMLImageElement);
  },
) {
  const render = vi.fn(),
    onDialogue = vi.fn(),
    onError = vi.fn();
  const instance = new M2Director({
    canvas: {} as HTMLCanvasElement,
    scene: readM2Scene(sceneData),
    render,
    hydrate,
    onDialogue,
    onError,
  });
  return { instance, render, onDialogue, onError };
}
it("uses host ticks, stops at reading gate, reveals/advances, completes once with slot identity", async () => {
  const { instance, render, onDialogue } = director();
  const outcome = vi.fn();
  await instance.start(slot, outcome);
  instance.step(300);
  expect(instance.getState()).toMatchObject({
    tick: 209,
    gate: "arrival-line",
    playing: false,
  });
  expect(outcome).not.toHaveBeenCalled();
  expect(onDialogue).toHaveBeenCalledWith("arrival-line");
  instance.advanceDialogue();
  instance.step(100);
  instance.skip();
  instance.advanceDialogue();
  expect(outcome).toHaveBeenCalledExactlyOnceWith("complete", slot);
  expect(render).toHaveBeenCalled();
  expect(instance.stats().rafOwned).toBe(0);
  instance.dispose();
});
it("early/late skip and repeated calls consume each active slot once", async () => {
  const { instance } = director();
  const outcome = vi.fn();
  await instance.start(slot, outcome);
  instance.skip();
  instance.skip();
  await instance.start({ ...slot, instanceId: "slot-2" }, outcome);
  instance.step(208);
  instance.skip();
  instance.step(200);
  expect(outcome.mock.calls).toEqual([
    ["skip", slot],
    ["skip", { ...slot, instanceId: "slot-2" }],
  ]);
  instance.dispose();
});
it("preview seek never commits outcomes, even after later step/skip/advance", async () => {
  const { instance } = director();
  const outcome = vi.fn();
  await instance.start(slot, outcome);
  instance.seek(300);
  instance.step(999);
  instance.skip();
  instance.advanceDialogue();
  expect(instance.getState().tick).toBe(300);
  expect(outcome).not.toHaveBeenCalled();
  await instance.start(slot, outcome);
  instance.skip();
  expect(outcome).toHaveBeenCalledOnce();
  instance.dispose();
});
it("late hydration cannot attach after dispose/restart; skip works while loading", async () => {
  const pending: (() => void)[] = [];
  const { instance, render } = director(
    () => new Promise<void>((done) => pending.push(done)),
  );
  const first = vi.fn(),
    second = vi.fn();
  const load1 = instance.start(slot, first);
  const load2 = instance.start({ ...slot, instanceId: "slot-2" }, second);
  pending[0]();
  expect(await load1).toBe(false);
  expect(render).not.toHaveBeenCalled();
  instance.skip();
  instance.skip();
  expect(second).toHaveBeenCalledExactlyOnceWith("skip", {
    ...slot,
    instanceId: "slot-2",
  });
  pending[1]();
  expect(await load2).toBe(false);
  const load3 = instance.start(slot, first);
  instance.dispose();
  pending[2]();
  expect(await load3).toBe(false);
  expect(first).not.toHaveBeenCalled();
  expect(instance.stats()).toMatchObject({
    images: 0,
    active: false,
    disposed: true,
  });
});
it("pause freezes host ticks and resume preserves a dialogue gate", async () => {
  const { instance } = director();
  await instance.start(slot, vi.fn());
  instance.step(30);
  instance.pause();
  instance.step(20);
  expect(instance.getState().tick).toBe(30);
  instance.resume();
  instance.step(300);
  instance.pause();
  instance.resume();
  instance.step(20);
  expect(instance.getState().tick).toBe(209);
  instance.dispose();
});
it("rejects invalid scene at construction and contains hydration failures", async () => {
  expect(() => readM2Scene({})).toThrow("Cinematic rejected");
  const { instance, onError } = director(async () => {
    throw new Error("decode failed");
  });
  expect(await instance.start(slot, vi.fn())).toBe(false);
  expect(onError).toHaveBeenCalledWith(
    expect.stringContaining("decode failed"),
  );
  expect(instance.stats().active).toBe(false);
  instance.dispose();
});
