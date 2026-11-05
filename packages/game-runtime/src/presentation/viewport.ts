/** All dimensions are presentation-only; no camera or simulation coordinates. */
export interface Point {
  readonly x: number;
  readonly y: number;
}
export interface CssBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
export interface SafeArea {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}
export interface ViewportOptions {
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly devicePixelRatio?: number;
  /** Integer CSS scaling when at least one logical pixel fits; fractional below 1. */
  readonly integerScale?: boolean;
  /** Insets local to this surface. Omit when an ancestor already consumes them. */
  readonly safeArea?: Partial<SafeArea>;
}
export interface ViewportMapping {
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly safeArea: Readonly<SafeArea>;
  readonly content: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  readonly scale: number;
  readonly pixelRatio: number;
  /** Renderer resolution per logical pixel, including CSS scale and bounded DPR. */
  readonly resolution: number;
  readonly backbuffer: Readonly<{ width: number; height: number }>;
}
export const MAX_VIEWPORT_DPR = 3;
export const MAX_BACKBUFFER_EDGE = 8192;
const MAX_CSS_EDGE = 32768;
function dimension(value: number, name: string, max: number, zero = false) {
  if (!Number.isFinite(value) || value < (zero ? 0 : 1) || value > max)
    throw new RangeError(`Invalid viewport ${name}`);
  return value;
}
/** A zero-sized/fully inset surface is valid, invisible and cannot be picked. */
export function createViewportMapping(
  options: ViewportOptions,
): ViewportMapping {
  const logicalWidth = dimension(
      options.logicalWidth,
      "logical width",
      MAX_BACKBUFFER_EDGE,
    ),
    logicalHeight = dimension(
      options.logicalHeight,
      "logical height",
      MAX_BACKBUFFER_EDGE,
    ),
    cssWidth = dimension(options.cssWidth, "CSS width", MAX_CSS_EDGE, true),
    cssHeight = dimension(options.cssHeight, "CSS height", MAX_CSS_EDGE, true);
  const inset = (edge: keyof SafeArea, max: number) =>
    Math.min(
      max,
      dimension(
        options.safeArea?.[edge] ?? 0,
        `safe area ${edge}`,
        MAX_CSS_EDGE,
        true,
      ),
    );
  const left = inset("left", cssWidth),
    top = inset("top", cssHeight),
    safeArea = Object.freeze({
      left,
      top,
      right: inset("right", cssWidth - left),
      bottom: inset("bottom", cssHeight - top),
    }),
    width = cssWidth - left - safeArea.right,
    height = cssHeight - top - safeArea.bottom;
  let scale = Math.min(width / logicalWidth, height / logicalHeight);
  if (options.integerScale && scale >= 1) scale = Math.floor(scale);
  const center = (space: number) =>
    options.integerScale && scale >= 1 ? Math.floor(space / 2) : space / 2;
  const content = Object.freeze({
    x: left + center(width - logicalWidth * scale),
    y: top + center(height - logicalHeight * scale),
    width: logicalWidth * scale,
    height: logicalHeight * scale,
  });
  const requestedDpr = options.devicePixelRatio ?? 1;
  if (!Number.isFinite(requestedDpr) || requestedDpr <= 0)
    throw new RangeError("Invalid viewport device pixel ratio");
  const pixelRatio = Math.min(
      MAX_VIEWPORT_DPR,
      requestedDpr,
      content.width ? MAX_BACKBUFFER_EDGE / content.width : MAX_VIEWPORT_DPR,
      content.height ? MAX_BACKBUFFER_EDGE / content.height : MAX_VIEWPORT_DPR,
    ),
    resolution = scale * pixelRatio;
  return Object.freeze({
    logicalWidth,
    logicalHeight,
    cssWidth,
    cssHeight,
    safeArea,
    content,
    scale,
    pixelRatio,
    resolution,
    backbuffer: Object.freeze({
      width: Math.round(logicalWidth * resolution),
      height: Math.round(logicalHeight * resolution),
    }),
  });
}
function validBounds(bounds: CssBounds) {
  return (
    [bounds.left, bounds.top, bounds.width, bounds.height].every(
      Number.isFinite,
    ) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}
/** Bounds are the outer surface's current client rect; supports axis-aligned CSS scale. */
export function clientToLogical(
  mapping: ViewportMapping,
  bounds: CssBounds,
  point: Point,
): Point | null {
  if (
    !validBounds(bounds) ||
    mapping.scale <= 0 ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y)
  )
    return null;
  const x =
      ((point.x - bounds.left) * mapping.cssWidth) / bounds.width -
      mapping.content.x,
    y =
      ((point.y - bounds.top) * mapping.cssHeight) / bounds.height -
      mapping.content.y;
  // Half-open bounds agree with cells/pixels: the right/bottom edge is outside.
  if (
    x < 0 ||
    y < 0 ||
    x >= mapping.content.width ||
    y >= mapping.content.height
  )
    return null;
  return { x: x / mapping.scale, y: y / mapping.scale };
}
export function logicalToClient(
  mapping: ViewportMapping,
  bounds: CssBounds,
  point: Point,
): Point | null {
  if (
    !validBounds(bounds) ||
    mapping.scale <= 0 ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y)
  )
    return null;
  return {
    x:
      bounds.left +
      ((mapping.content.x + point.x * mapping.scale) * bounds.width) /
        mapping.cssWidth,
    y:
      bounds.top +
      ((mapping.content.y + point.y * mapping.scale) * bounds.height) /
        mapping.cssHeight,
  };
}
/** Use for both the game canvas and any aligned cinematic overlay. */
export function applyViewportStyle(
  canvas: HTMLCanvasElement,
  mapping: ViewportMapping,
): void {
  Object.assign(canvas.style, {
    position: "absolute",
    left: `${mapping.content.x}px`,
    top: `${mapping.content.y}px`,
    width: `${mapping.content.width}px`,
    height: `${mapping.content.height}px`,
  });
}
