import type { SpriteProjectionRecipe } from "@onepage/asset-library/sprite-atlas";
/** Shared continuous ground projection. Simulation coordinates remain authoritative. */
export function projectIsometric(
  x: number,
  y: number,
  z = 0,
  tileWidth = 64,
  tileHeight = 32,
) {
  return { x: ((x - y) * tileWidth) / 2, y: ((x + y) * tileHeight) / 2 - z };
}
export function unprojectIsometric(
  x: number,
  y: number,
  tileWidth = 64,
  tileHeight = 32,
) {
  return {
    x: x / tileWidth + y / tileHeight,
    y: y / tileHeight - x / tileWidth,
  };
}
export function feetDepth(x: number, y: number, layer = 0) {
  return (x + y) * 1024 + layer;
}
export function occluderAlpha(
  actor: { x: number; y: number },
  occluder: { x: number; y: number; width: number; height: number },
  faded = 0.35,
) {
  return actor.x >= occluder.x &&
    actor.x <= occluder.x + occluder.width &&
    actor.y >= occluder.y &&
    actor.y <= occluder.y + occluder.height
    ? faded
    : 1;
}

/** Shared actor/room bake projection: elevation is asin(tileHeight/tileWidth). */
export const UNDERWORLD_PROJECTION = {
  id: "underworld-owned-v2",
  tileWidth: 50,
  tileHeight: 30,
  origin: { x: 640, y: 90 },
  pixelsPerWorldUnit: 50 / Math.SQRT2,
  cameraElevationDegrees: (Math.asin(30 / 50) * 180) / Math.PI,
  orthographicScale: 4.2,
} as const;
export function projectWithRecipe(
  x: number,
  y: number,
  recipe: SpriteProjectionRecipe = UNDERWORLD_PROJECTION,
) {
  const point = projectIsometric(x, y, 0, recipe.tileWidth, recipe.tileHeight);
  return { x: point.x + recipe.origin.x, y: point.y + recipe.origin.y };
}
export function unprojectWithRecipe(
  x: number,
  y: number,
  recipe: SpriteProjectionRecipe = UNDERWORLD_PROJECTION,
) {
  return unprojectIsometric(
    x - recipe.origin.x,
    y - recipe.origin.y,
    recipe.tileWidth,
    recipe.tileHeight,
  );
}
