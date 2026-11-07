import { VIEW } from "./projection";
import type { PixiStage } from "@onepage/game-runtime/pixi";
import type { SportId } from "./session";

/** The near court is y=305; extra clearance preserves actors and effects.
 * Aerial modes retain y=0 so existing lob/set headroom is unchanged. */
export const SPORT_FRAME_HEIGHT: Record<SportId, number> = {
  cryptball: 348,
  cryptkick: 348,
  "rift-volley": 368,
  cryptcheck: 348,
  "crypt-dodge": 360,
  "crypt-guardian": 368,
};
export const SPORT_FRAME_TOP: Record<SportId, number> = {
  cryptball: 32, cryptkick: 32, cryptcheck: 32, "rift-volley": 0, "crypt-dodge": 0, "crypt-guardian": 0,
};
export function cryptballFrame(width: number, height: number, sport: SportId, playing: boolean) {
  const tight = playing && width / height >= 1.8;
  const y = tight ? SPORT_FRAME_TOP[sport] : 0;
  return { width: VIEW.width, y, height: tight ? SPORT_FRAME_HEIGHT[sport] - y : VIEW.height };
}
/** Prefer an integer step only when it uses at least90% of the available fit.
 * Otherwise nearest-neighbor CSS scaling fills the useful viewport. */
export function fitCryptballScale(width: number, height: number) {
  const fit = Math.max(0.1, Math.min(width / VIEW.width, height / VIEW.height));
  const integer = Math.floor(fit);
  return integer >= 1 && integer / fit >= 0.9 ? integer : fit;
}
/** Keep device pixels and game pixels separate: pointer uses these logical bounds. */
export function resizeCryptball(
  stage: PixiStage,
  container: HTMLElement,
  frameHeight: number = VIEW.height,
  frameTop = 0,
): void {
  stage.width = VIEW.width;
  stage.height = VIEW.height;
  stage.app.renderer.resolution = 1;
  stage.app.renderer.resize(VIEW.width, VIEW.height);
  stage.app.stage.scale.set(1);
  stage.canvas.dataset.frameHeight = String(frameHeight);
  stage.canvas.dataset.frameTop = String(frameTop);
  const r = container.getBoundingClientRect();
  const fit = Math.min(r.width / VIEW.width, r.height / frameHeight);
  const scale = Math.max(0.1, fit);
  Object.assign(stage.canvas.style, {
    width: `${VIEW.width * scale}px`,
    height: `${VIEW.height * scale}px`,
    imageRendering: "pixelated",
    display: "block",
    margin: "0",
    alignSelf: "start",
    transform: `translateY(${-frameTop * scale}px)`,
    flexShrink: "0",
  });
}
