/** Internal compatible shape math. Adapters must validate their own units,
 * bounds and work budgets before calling; no coordinate quantization occurs. */
export interface OpenAabb { x: number; y: number; width: number; height: number }
export interface RationalTime { n: number; d: number }
export function openAabbOverlaps(a: OpenAabb, b: OpenAabb): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x &&
    a.y < b.y + b.height && a.y + a.height > b.y;
}
const cross = (a: RationalTime, b: RationalTime) => a.n * b.d - b.n * a.d;
/** Open interior slab: initial penetration t=0, face entry at t=1 included,
 * parallel tangency and zero-duration corner grazing excluded. Caller proves
 * rational products fit exact integer arithmetic. */
export function openAabbSweep(body: OpenAabb, delta: {x: number; y: number}, target: OpenAabb): RationalTime | null {
  let enter = { n: 0, d: 1 }, leave: RationalTime | null = null;
  for (const [origin, v, min, max] of [
    [body.x, delta.x, target.x - body.width, target.x + target.width],
    [body.y, delta.y, target.y - body.height, target.y + target.height],
  ]) {
    if (v === 0) { if (origin <= min || origin >= max) return null; continue; }
    const d = Math.abs(v);
    const near = {n: v > 0 ? min - origin : origin - max, d};
    const far = {n: v > 0 ? max - origin : origin - min, d};
    if (cross(near, enter) > 0) enter = near;
    if (!leave || cross(far, leave) < 0) leave = far;
    if (cross(enter, leave) >= 0) return null;
  }
  return cross(enter, {n: 1, d: 1}) > 0 ? null : enter;
}
