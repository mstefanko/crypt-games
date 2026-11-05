import {
  orderPresentation,
  sampleAtlasAnimation,
  type PresentationDepth,
} from "./sprites";
export interface NamedSpriteFrame {
  id: string;
  source: { x: number; y: number; width: number; height: number };
  pivot: { x: number; y: number };
  durationTicks: number;
  flipX?: boolean;
  flipY?: boolean;
}
export interface NamedSpriteClip {
  id: string;
  frames: readonly NamedSpriteFrame[];
  loop: boolean;
}
export interface NamedSpriteAtlas {
  id: string;
  image: CanvasImageSource;
  clips: Readonly<Record<string, NamedSpriteClip>>;
}
/** Coordinates identify the pivot, rather than the source rectangle's corner. */
export function drawSpriteFrame(
  ctx: CanvasRenderingContext2D,
  atlas: NamedSpriteAtlas,
  frame: NamedSpriteFrame,
  x: number,
  y: number,
  scale = 1,
  flipX = false,
): void {
  const source = frame.source;
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.scale(
    (flipX !== !!frame.flipX ? -1 : 1) * scale,
    (frame.flipY ? -1 : 1) * scale,
  );
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    atlas.image,
    source.x,
    source.y,
    source.width,
    source.height,
    -frame.pivot.x,
    -frame.pivot.y,
    source.width,
    source.height,
  );
  ctx.restore();
}
export function drawSpriteClip(
  ctx: CanvasRenderingContext2D,
  atlas: NamedSpriteAtlas,
  clipId: string,
  tick: number,
  x: number,
  y: number,
  scale = 1,
  flipX = false,
): NamedSpriteFrame | undefined {
  const clip = atlas.clips[clipId];
  const frame = clip && sampleAtlasAnimation(clip.frames, tick, clip.loop);
  if (frame) drawSpriteFrame(ctx, atlas, frame, x, y, scale, flipX);
  return frame;
}
export interface CachedParallaxPlane extends PresentationDepth {
  image: CanvasImageSource;
  width: number;
  height: number;
  x: number;
  y: number;
  parallaxX: number;
  parallaxY: number;
  repeatX?: boolean;
  repeatY?: boolean;
}
/** Tile layers are authored once, then scrolled independently in stable priority order. */
export function drawCachedParallax(
  ctx: CanvasRenderingContext2D,
  planes: readonly CachedParallaxPlane[],
  cameraX: number,
  cameraY: number,
  viewportWidth: number,
  viewportHeight: number,
): void {
  for (const plane of orderPresentation(planes)) {
    if (plane.width <= 0 || plane.height <= 0) continue;
    let x = Math.round(plane.x - cameraX * plane.parallaxX),
      y = Math.round(plane.y - cameraY * plane.parallaxY);
    if (plane.repeatX)
      x = (((x % plane.width) + plane.width) % plane.width) - plane.width;
    if (plane.repeatY)
      y = (((y % plane.height) + plane.height) % plane.height) - plane.height;
    for (
      let py = y;
      py < (plane.repeatY ? viewportHeight : y + 1);
      py += plane.height
    )
      for (
        let px = x;
        px < (plane.repeatX ? viewportWidth : x + 1);
        px += plane.width
      )
        ctx.drawImage(plane.image, px, py, plane.width, plane.height);
  }
}
/** Caller-controlled revision invalidation keeps static pixel construction out of frame loops. */
export class PixelLayerCache {
  private entries = new Map<
    string,
    { revision: string | number; canvas: HTMLCanvasElement }
  >();
  get(
    id: string,
    revision: string | number,
    width: number,
    height: number,
    paint: (ctx: CanvasRenderingContext2D) => void,
  ): HTMLCanvasElement {
    const existing = this.entries.get(id);
    if (
      existing &&
      existing.revision === revision &&
      existing.canvas.width === width &&
      existing.canvas.height === height
    )
      return existing.canvas;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw Error("Canvas 2D is required for pixel layers");
    ctx.imageSmoothingEnabled = false;
    paint(ctx);
    this.entries.set(id, { revision, canvas });
    return canvas;
  }
  clear(): void {
    this.entries.clear();
  }
}
