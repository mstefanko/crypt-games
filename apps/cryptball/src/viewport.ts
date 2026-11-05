import { VIEW } from "./projection";
import type { PixiStage } from "@onepage/game-runtime/pixi";
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
): void {
  stage.width = VIEW.width;
  stage.height = VIEW.height;
  stage.app.renderer.resolution = 1;
  stage.app.renderer.resize(VIEW.width, VIEW.height);
  stage.app.stage.scale.set(1);
  const r = container.getBoundingClientRect();
  const fit = Math.min(r.width / VIEW.width, r.height / VIEW.height);
  const scale = Math.max(0.1, fit);
  Object.assign(stage.canvas.style, {
    width: `${VIEW.width * scale}px`,
    height: `${VIEW.height * scale}px`,
    imageRendering: "pixelated",
    display: "block",
    margin: "auto",
    flexShrink: "0",
  });
}
