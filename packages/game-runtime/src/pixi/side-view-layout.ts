/** Pixel side-view letterbox and camera policy shared by traversal and combat. */
export function sideViewLayout(
  width: number,
  height: number,
  view: { width: number; height: number; maxScale?: number },
) {
  const fit = Math.min((width - 40) / view.width, (height - 186) / view.height);
  const scale =
    fit >= 1
      ? Math.min(view.maxScale ?? 4, Math.floor(fit))
      : Math.max(0.1, fit);
  return {
    scale,
    offset: {
      x: Math.round((width - view.width * scale) / 2),
      y: Math.round(82 + (height - 186 - view.height * scale) / 2),
    },
  };
}
export function sideViewCamera(
  playerX: number,
  worldWidth: number,
  viewportWidth: number,
  lead = 0.4,
) {
  return Math.max(
    0,
    Math.min(
      Math.max(0, worldWidth - viewportWidth),
      playerX - viewportWidth * lead,
    ),
  );
}
