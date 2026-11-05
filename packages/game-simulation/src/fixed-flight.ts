/** Integer coordinates; velocity is coordinate units/second. Gravity is the
 * velocity decrement per substep, not units/second². No collision policy. */
export interface FixedFlightState {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  rx: number; ry: number; rz: number;
}
export interface FixedFlightConfig { frequency: number; gravityPerStep: number }
const LIMIT = 1_000_000_000;
function integer(n: number, min = -LIMIT, max = LIMIT): void {
  if (!Number.isSafeInteger(n) || n < min || n > max) throw Error("Invalid fixed-flight integer");
}
function config(c: FixedFlightConfig): void {
  integer(c.frequency, 1, 4096); integer(c.gravityPerStep, 0, 1_000_000);
}
function validateState(s: FixedFlightState, frequency: number): void {
  for (const n of [s.x, s.y, s.z, s.vx, s.vy, s.vz]) integer(n);
  for (const n of [s.rx, s.ry, s.rz]) integer(n, -frequency + 1, frequency - 1);
}
function axis(velocity: number, remainder: number, frequency: number, interval = 1): { delta: number; remainder: number } {
  const accumulated = remainder + Math.round(velocity * interval);
  const delta = Math.trunc(accumulated / frequency);
  return { delta, remainder: accumulated - delta * frequency };
}
/** Signed carry uses truncation toward zero. Fractional intervals deliberately
 * round velocity contribution once, matching bounded residual contact stepping. */
export function advanceFixedAxis(velocity: number, remainder: number, frequency: number, interval = 1): { delta: number; remainder: number } {
  integer(velocity); integer(frequency, 1, 4096); integer(remainder, -frequency + 1, frequency - 1);
  if (!Number.isFinite(interval) || interval < 0 || interval > 1) throw Error("Invalid fixed-flight interval");
  return axis(velocity, remainder, frequency, interval);
}
export function stepFixedFlight(state: FixedFlightState, c: FixedFlightConfig): FixedFlightState {
  config(c); validateState(state, c.frequency);
  return step(state, c);
}
function step(state: FixedFlightState, c: FixedFlightConfig): FixedFlightState {
  const vz = state.vz - c.gravityPerStep;
  integer(vz);
  const x = axis(state.vx, state.rx, c.frequency);
  const y = axis(state.vy, state.ry, c.frequency);
  const z = axis(vz, state.rz, c.frequency);
  const result = { x: state.x + x.delta, y: state.y + y.delta, z: state.z + z.delta, vx: state.vx, vy: state.vy, vz, rx: x.remainder, ry: y.remainder, rz: z.remainder };
  integer(result.x); integer(result.y); integer(result.z);
  return result;
}
/** Free flight only. Landing coordinates interpolate the same integer segment
 * tested by live swept floor contact; steps includes its fractional final step. */
export function predictFixedFlightLanding(state: FixedFlightState, c: FixedFlightConfig & { floor: number; maxSteps: number }): { x: number; y: number; z: number; steps: number; landed: boolean } {
  config(c); integer(c.floor); integer(c.maxSteps, 0, 4096);
  validateState(state, c.frequency);
  if (state.z < c.floor || (state.z === c.floor && state.vz - c.gravityPerStep <= 0)) return { x: state.x, y: state.y, z: c.floor, steps: 0, landed: true };
  let current = state;
  for (let i = 0; i < c.maxSteps; i++) {
    const next = step(current, c);
    if (next.z <= c.floor && next.z < current.z) {
      const t = (c.floor - current.z) / (next.z - current.z);
      return { x: current.x + Math.round((next.x - current.x) * t), y: current.y + Math.round((next.y - current.y) * t), z: c.floor, steps: i + t, landed: true };
    }
    current = next;
  }
  return { x: current.x, y: current.y, z: current.z, steps: c.maxSteps, landed: false };
}
/** Integer launch velocity minimizing discrete target-height error near the
 * ideal displacement solution. Equal errors prefer velocity nearest that ideal,
 * then the smaller velocity. Carries are included. */
export function solveFixedFlightLaunch(c: FixedFlightConfig & { height: number; floor: number; steps: number; remainder?: number }): number {
  config(c); integer(c.height); integer(c.floor); integer(c.steps, 1, 4096);
  const remainder = c.remainder ?? 0;
  integer(remainder, -c.frequency + 1, c.frequency - 1);
  const estimate = (c.floor - c.height) * c.frequency / c.steps + c.gravityPerStep * (c.steps + 1) / 2 - remainder / c.steps;
  // Signed truncation can differ at zero crossings. Evaluate nearby velocities
  // with the actual integrator rather than assume telescoping truncations.
  let best = 0, error = Infinity, distance = Infinity;
  for (let velocity = Math.floor(estimate) - 2; velocity <= Math.ceil(estimate) + 2; velocity++) {
    integer(velocity);
    let z = c.height, vz = velocity, rz = remainder;
    for (let i = 0; i < c.steps; i++) {
      vz -= c.gravityPerStep;
      integer(vz);
      const movement = axis(vz, rz, c.frequency);
      z += movement.delta; rz = movement.remainder; integer(z);
    }
    const difference = Math.abs(z - c.floor);
    const idealDistance = Math.abs(velocity - estimate);
    if (difference < error || (difference === error && idealDistance < distance)) {
      best = velocity; error = difference; distance = idealDistance;
    }
  }
  return best;
}
/** Closed bounds: boundary/corner tangency hits, including stationary points.
 * Radius expansion is caller policy; an expanded box is conservative at corners. */
export function closedSegmentAabbInterval(origin: { x: number; y: number }, delta: { x: number; y: number }, bounds: { minX: number; maxX: number; minY: number; maxY: number }): { enter: number; exit: number } | null {
  for (const n of [origin.x, origin.y, delta.x, delta.y, bounds.minX, bounds.maxX, bounds.minY, bounds.maxY]) {
    if (!Number.isFinite(n) || Math.abs(n) > LIMIT) throw Error("Invalid closed segment bounds");
  }
  if (bounds.minX > bounds.maxX || bounds.minY > bounds.maxY) throw Error("Inverted closed segment bounds");
  let enter = 0, exit = 1;
  for (const [p, d, min, max] of [[origin.x, delta.x, bounds.minX, bounds.maxX], [origin.y, delta.y, bounds.minY, bounds.maxY]]) {
    if (!d) { if (p < min || p > max) return null; continue; }
    const a = (min - p) / d, b = (max - p) / d;
    enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
    if (enter > exit) return null;
  }
  return { enter, exit };
}
