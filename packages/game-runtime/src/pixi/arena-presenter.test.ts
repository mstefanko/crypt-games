import { afterEach, expect, it, vi } from "vitest";
import { ArenaPresenter } from "./arena-presenter";
import {
  AtlasLoader,
  Container,
  type AtlasManifest,
  type PixiStage,
} from "./index";
import { ArenaSession } from "@onepage/game-simulation/arena-session";
import {
  underworldContent,
  legacyUnderworldContent,
} from "../../../../apps/audio-arcade/src/games/underworld/content";

afterEach(() => vi.restoreAllMocks());
const empty: AtlasManifest = { pages: {}, frames: {}, clips: {} };
async function mountedPresenter() {
  const layers = {
    ground: new Container(),
    actors: new Container(),
    foreground: new Container(),
    effects: new Container(),
    hud: new Container(),
  };
  const stage = {
    layers,
    camera: { zoom: 1, pan: vi.fn() },
    width: 1280,
    height: 720,
  } as unknown as PixiStage;
  vi.spyOn(AtlasLoader.prototype, "loadUrl").mockResolvedValue(empty);
  const presenter = new ArenaPresenter(new ArenaSession(underworldContent, 1), {
    manifestUrl: "featured",
    legacyManifestUrl: "legacy",
    clips: {},
  });
  await presenter.init(stage);
  return { presenter, stage };
}
it("hides actors and reports loading until the selected mode atlas is ready", async () => {
  const { presenter, stage } = await mountedPresenter();
  let resolve!: (value: AtlasManifest) => void;
  vi.mocked(AtlasLoader.prototype.loadUrl).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  presenter.setSession(new ArenaSession(legacyUnderworldContent, 1), true);
  expect(presenter.loading).toBe(true);
  presenter.render(0);
  expect(stage.layers.actors.visible).toBe(false);
  resolve(empty);
  await Promise.resolve();
  await Promise.resolve();
  expect(presenter.loading).toBe(false);
  presenter.dispose();
});
it("releases a failed replacement atlas and exposes a handled retryable load error", async () => {
  const { presenter } = await mountedPresenter();
  const release = vi.spyOn(AtlasLoader.prototype, "dispose");
  vi.mocked(AtlasLoader.prototype.loadUrl).mockRejectedValueOnce(
    new Error("offline"),
  );
  presenter.setSession(new ArenaSession(legacyUnderworldContent, 1), true);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(release).toHaveBeenCalledTimes(1);
  expect(presenter.loadError).toContain("offline");
  expect(presenter.loading).toBe(true);
  presenter.setSession(new ArenaSession(underworldContent, 1), false);
  await Promise.resolve();
  await Promise.resolve();
  expect(presenter.loadError).toBeUndefined();
  expect(presenter.loading).toBe(false);
  presenter.dispose();
});
it("ignores an obsolete load rejection after a newer mode is ready", async () => {
  const { presenter } = await mountedPresenter();
  let reject!: (error: Error) => void;
  vi.mocked(AtlasLoader.prototype.loadUrl).mockImplementationOnce(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  presenter.setSession(new ArenaSession(legacyUnderworldContent, 1), true);
  presenter.setSession(new ArenaSession(underworldContent, 1), false);
  await Promise.resolve();
  await Promise.resolve();
  expect(presenter.loading).toBe(false);
  reject(new Error("obsolete request"));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(presenter.loadError).toBeUndefined();
  expect(presenter.loading).toBe(false);
  presenter.dispose();
});
it("discards future particle samples on restore and session replacement", async () => {
  const { presenter } = await mountedPresenter();
  const { ParticlePool, Texture } = await import("./index");
  const particles = (presenter as unknown as { particles: InstanceType<typeof ParticlePool> }).particles;
  const saved = presenter.snapshot();
  particles.emit(Texture.WHITE, 0, 0, 120, 100, 0.22);
  presenter.restore(saved);
  expect(particles.container.children[0].visible).toBe(false);
  particles.emit(Texture.WHITE, 0, 0, 120, 100, 0.22);
  presenter.setSession(new ArenaSession(underworldContent, 2));
  expect(particles.container.children[0].visible).toBe(false);
  presenter.dispose();
});
