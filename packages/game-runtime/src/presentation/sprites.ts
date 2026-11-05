/** Stable total ordering independent of asynchronous texture creation/insertion. */
export interface PresentationDepth {
  id: string;
  layer: number;
  depth: number;
}
export const PRESENTATION_LAYERS = Object.freeze({
  terrain: 0,
  props: 10,
  actors: 20,
  effects: 30,
  hud: 100,
});
export function orderPresentation<T extends PresentationDepth>(
  items: readonly T[],
): T[] {
  if (items.length > 4096)
    throw new RangeError("Presentation order cap exceeded");
  const ids = new Set<string>();
  for (const item of items) {
    if (
      typeof item.id !== "string" ||
      !item.id.length ||
      item.id.length > 256 ||
      ids.has(item.id) ||
      !Number.isFinite(item.layer) ||
      !Number.isFinite(item.depth)
    )
      throw new RangeError("Invalid presentation depth");
    ids.add(item.id);
  }
  return [...items].sort(
    (a, b) =>
      a.layer - b.layer ||
      a.depth - b.depth ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
export interface AtlasAnimationFrame {
  id: string;
  durationTicks: number;
}
/** Samples authored durations without owning or advancing a gameplay/render clock. */
export function sampleAtlasAnimation<T extends AtlasAnimationFrame>(
  frames: readonly T[],
  tick: number,
  loop = true,
): T | undefined {
  if (!Number.isFinite(tick) || frames.length < 1 || frames.length > 256)
    return undefined;
  let duration = 0;
  for (const frame of frames) {
    if (
      !Number.isSafeInteger(frame.durationTicks) ||
      frame.durationTicks < 1 ||
      frame.durationTicks > 36000
    )
      return undefined;
    duration += frame.durationTicks;
  }
  let local = loop
    ? ((Math.floor(tick) % duration) + duration) % duration
    : Math.max(0, Math.min(duration - 1, Math.floor(tick)));
  for (const frame of frames) {
    if (local < frame.durationTicks) return frame;
    local -= frame.durationTicks;
  }
  return undefined;
}
