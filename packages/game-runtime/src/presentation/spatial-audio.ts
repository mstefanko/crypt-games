export interface SpatialGrid {
  width: number;
  height: number;
  walls: ReadonlySet<number>;
}
export interface SpatialPoint {
  x: number;
  y: number;
}
/** Deterministic grid ray; each occluding cell is counted at most once. */
export function spatialAudio(
  source: SpatialPoint,
  listener: SpatialPoint,
  grid: SpatialGrid,
  range = 12,
  mono = false,
): { gain: number; pan: number; occlusion: number; cutoff: number } {
  if (
    ![
      source.x,
      source.y,
      listener.x,
      listener.y,
      range,
      grid.width,
      grid.height,
    ].every(Number.isFinite) ||
    range <= 0 ||
    grid.width < 1 ||
    grid.height < 1
  )
    throw Error("Invalid spatial query");
  const dx = source.x - listener.x,
    dy = source.y - listener.y,
    distance = Math.hypot(dx, dy),
    steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 4),
    hit = new Set<number>();
  for (let i = 1; i < steps; i++) {
    const x = Math.floor(listener.x + (dx * i) / steps),
      y = Math.floor(listener.y + (dy * i) / steps);
    if (
      x >= 0 &&
      y >= 0 &&
      x < grid.width &&
      y < grid.height &&
      grid.walls.has(y * grid.width + x)
    )
      hit.add(y * grid.width + x);
  }
  const occlusion = 1 - Math.pow(0.5, hit.size);
  return {
    gain:
      Math.pow(Math.max(0, 1 - distance / range), 2) * (1 - occlusion * 0.8),
    pan: mono ? 0 : Math.max(-0.8, Math.min(0.8, dx / range)),
    occlusion,
    cutoff: 18000 - occlusion * 16000,
  };
}
