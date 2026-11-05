import { CIRCLE_LIMITS, circleInteger, queryCircleGeometry, validateGeometryCircle } from "./circle-geometry";
import type { CircleGeometryShape, GeometryCircle } from "./circle-geometry";
import type { GeometryVector } from "./geometry";

export const BALLISTIC_LIMITS = Object.freeze({
  bodies: 8, targets: 32, ticks: 256, substeps: 4,
  velocity: 2048, acceleration: 128, radius: 1024,
  bounces: 4, predictionTicks: 256, restSpeed: 16,
});
export interface BallisticBodyDefinition extends GeometryCircle {
  readonly id: string;
  /** Fixed units per tick. Acceleration is fixed units per tick squared. */
  readonly vx: number;
  readonly vy: number;
  readonly impact: "stop" | "bounce";
  readonly restitution: number;
  readonly maxBounces: number;
  readonly catchable: boolean;
}
export interface BallisticTarget {
  readonly shape: CircleGeometryShape;
  readonly response: "solid" | "catch";
}
export interface BallisticConfiguration {
  readonly acceleration: GeometryVector;
  readonly bodies: readonly BallisticBodyDefinition[];
  readonly targets: readonly BallisticTarget[];
}
export interface BallisticBodyState extends GeometryCircle {
  x: number;
  y: number;
  id: string;
  vx: number;
  vy: number;
  /** Signed division carries for velocity and position, all in [-3,3]. */
  velocityRemainderX: number;
  velocityRemainderY: number;
  positionRemainderX: number;
  positionRemainderY: number;
  status: "flying" | "stopped" | "caught";
  bounceCount: number;
}
export interface BallisticEvent {
  readonly tick: number;
  readonly substep: number;
  readonly bodyId: string;
  readonly targetId: string;
  readonly shapeId: string;
  readonly kind: "stop" | "bounce" | "catch";
  readonly time: number;
}
export interface BallisticState {
  tick: number;
  bodies: BallisticBodyState[];
  /** Current tick only, ordered by body identity then substep/contact order. */
  events: BallisticEvent[];
}
export interface BallisticCheckpoint {
  readonly format: "p1-ballistics-v1";
  readonly configuration: BallisticConfiguration;
  readonly state: BallisticState;
}
export interface BallisticPrediction {
  readonly states: readonly BallisticState[];
  readonly checkpoint: BallisticCheckpoint;
}
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) throw Error("Invalid ballistic fields");
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number") throw Error("Invalid ballistic integer");
  circleInteger(value, min, max); return value;
}
function identity(value: unknown): string {
  if (typeof value !== "string" || value.length > 96 || !/^[A-Za-z0-9][A-Za-z0-9:_.\/-]*$/.test(value)) throw Error("Invalid ballistic identity");
  return value;
}
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
/** Bounded strict plain-data codec. No cycles, sparse arrays, exotic prototypes,
 * unknown fields, coercions or non-finite values pass through restoration. */
export function canonicalBallisticData(value: unknown): string {
  let nodes = 0;
  function normalize(v: unknown, depth: number): unknown {
    if (++nodes > 8192 || depth > 10) throw Error("Ballistic checkpoint data cap");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") { if (!Number.isSafeInteger(v) || Object.is(v, -0)) throw Error("Invalid ballistic number"); return v; }
    if (typeof v === "string") { if (v.length > 96) throw Error("Ballistic string cap"); return v; }
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype || v.length > 256 || Reflect.ownKeys(v).length !== v.length + 1) throw Error("Ballistic array cap/prototype");
      const result: unknown[] = [];
      for (let i = 0; i < v.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(v, String(i));
        if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) throw Error("Invalid ballistic array property");
        result.push(normalize(descriptor.value, depth + 1));
      }
      return result;
    }
    if (!v || typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype) throw Error("Invalid ballistic data");
    const ownKeys = Reflect.ownKeys(v);
    if (ownKeys.some(key => typeof key !== "string")) throw Error("Invalid ballistic symbol key");
    const keys = (ownKeys as string[]).sort();
    if (keys.length > 24) throw Error("Ballistic object cap");
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (key.length > 64 || key === "__proto__") throw Error("Invalid ballistic key");
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) throw Error("Invalid ballistic data property");
      result[key] = normalize(descriptor.value, depth + 1);
    }
    return result;
  }
  const result = JSON.stringify(normalize(value, 0));
  if (result.length > 65536) throw Error("Ballistic checkpoint character cap");
  return result;
}
function configuration(value: unknown): BallisticConfiguration {
  canonicalBallisticData(value);
  const root = fields(value, ["acceleration", "bodies", "targets"]);
  const a = fields(root.acceleration, ["x", "y"]);
  const acceleration = { x: integer(a.x, -128, 128), y: integer(a.y, -128, 128) };
  if (!Array.isArray(root.bodies) || root.bodies.length > BALLISTIC_LIMITS.bodies || !Array.isArray(root.targets) || root.targets.length > BALLISTIC_LIMITS.targets) throw Error("Ballistic body/target cap");
  const bodies = root.bodies.map(value => {
    const b = fields(value, ["id", "x", "y", "radius", "vx", "vy", "impact", "restitution", "maxBounces", "catchable"]);
    const body: BallisticBodyDefinition = {
      id: identity(b.id), x: integer(b.x, -262144, 262144), y: integer(b.y, -262144, 262144), radius: integer(b.radius, 1, 1024),
      vx: integer(b.vx, -2048, 2048), vy: integer(b.vy, -2048, 2048),
      impact: b.impact as BallisticBodyDefinition["impact"], restitution: integer(b.restitution, 0, 256), maxBounces: integer(b.maxBounces, 0, 4), catchable: b.catchable as boolean,
    };
    validateGeometryCircle(body);
    if ((body.impact !== "stop" && body.impact !== "bounce") || typeof body.catchable !== "boolean") throw Error("Unsupported ballistic impact policy");
    if (body.vx * body.vx + body.vy * body.vy > 2048 * 2048) throw Error("Ballistic speed cap");
    return body;
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (let i = 1; i < bodies.length; i++) if (bodies[i - 1].id === bodies[i].id) throw Error("Duplicate ballistic body");
  const targets = root.targets.map(value => {
    const t = fields(value, ["shape", "response"]);
    if (t.response !== "solid" && t.response !== "catch") throw Error("Unsupported ballistic target response");
    const s = t.shape as CircleGeometryShape;
    fields(s, ["bodyId", "shapeId", "owner", "category", "region", "sensor", "priority", "kind", s?.kind === "circle" ? "circle" : "rect"]);
    fields(s.kind === "circle" ? s.circle : s.rect, s.kind === "circle" ? ["x", "y", "radius"] : ["x", "y", "width", "height"]);
    if (s.region !== "body" || (s.sensor && t.response !== "catch")) throw Error("Ballistics requires body regions and explicit catch sensors");
    if (bodies.some(b => b.id === s.bodyId)) throw Error("Moving ballistic bodies cannot also be static targets");
    return { shape: copy(s), response: t.response } as BallisticTarget;
  });
  // Shared query validates every target, identity/owner conflicts included.
  queryCircleGeometry(targets.map(t => t.shape), { kind: "overlap", circle: { x: 0, y: 0, radius: 1 } }, { sensors: "include" });
  targets.sort((a, b) => a.shape.bodyId < b.shape.bodyId ? -1 : a.shape.bodyId > b.shape.bodyId ? 1 : a.shape.shapeId < b.shape.shapeId ? -1 : a.shape.shapeId > b.shape.shapeId ? 1 : 0);
  return { acceleration, bodies, targets };
}
function divideCarry(value: number): [number, number] {
  const whole = Math.trunc(value / BALLISTIC_LIMITS.substeps);
  return [whole, value - whole * BALLISTIC_LIMITS.substeps];
}
function reflect(v: GeometryVector, n: GeometryVector, restitution: number): GeometryVector {
  const nx = BigInt(n.x), ny = BigInt(n.y), dot = BigInt(v.x) * nx + BigInt(v.y) * ny;
  const denominator = nx * nx + ny * ny;
  if (dot >= 0n || denominator === 0n) return { x: 0, y: 0 };
  // Quantize reflection and damping toward zero, avoiding a speed increase.
  const x = (BigInt(v.x) * denominator - 2n * dot * nx) * BigInt(restitution) / (denominator * 256n);
  const y = (BigInt(v.y) * denominator - 2n * dot * ny) * BigInt(restitution) / (denominator * 256n);
  return { x: Number(x), y: Number(y) };
}
/** Pure production step. No body/body solver, moving-target collision, rotating
 * colliders, residual-time bounce iteration, drag or hidden random state. */
function stepBallistics(config: BallisticConfiguration, state: BallisticState): BallisticState {
  if (state.tick >= BALLISTIC_LIMITS.ticks) throw Error("Ballistic tick cap");
  const staged = copy(state);
  staged.tick++; staged.events = [];
  for (let index = 0; index < staged.bodies.length; index++) {
    const body = staged.bodies[index], definition = config.bodies[index];
    if (body.status !== "flying") continue;
    const targets = config.targets.filter(t => t.response !== "catch" || definition.catchable);
    for (let substep = 0; substep < BALLISTIC_LIMITS.substeps; substep++) {
      const [ax, axr] = divideCarry(config.acceleration.x + body.velocityRemainderX);
      const [ay, ayr] = divideCarry(config.acceleration.y + body.velocityRemainderY);
      body.velocityRemainderX = axr; body.velocityRemainderY = ayr;
      body.vx += ax; body.vy += ay;
      if (body.vx * body.vx + body.vy * body.vy > 2048 * 2048) throw Error("Ballistic speed cap; step rejected");
      const [dx, xr] = divideCarry(body.vx + body.positionRemainderX);
      const [dy, yr] = divideCarry(body.vy + body.positionRemainderY);
      body.positionRemainderX = xr; body.positionRemainderY = yr;
      const delta = { x: dx, y: dy };
      const hit = queryCircleGeometry(targets.map(t => t.shape), { kind: "sweep", circle: body, delta }, { sensors: "include" }).contacts[0];
      if (!hit) { body.x += dx; body.y += dy; continue; }
      const target = targets.find(t => t.shape.bodyId === hit.bodyId && t.shape.shapeId === hit.shapeId)!;
      // Independent coordinate truncation can put a rounded-corner contact
      // inside a target. Check the quantized position against every candidate,
      // retreating by at least one unit along the dominant axis until clear.
      // At most 512 retreats under the velocity/substep cap; the start remains
      // the fallback for initial penetration (which follows the stop policy).
      let time = Math.max(0, hit.time.n - 1);
      const retreat = Math.ceil(CIRCLE_LIMITS.timeScale / Math.max(1, Math.abs(dx), Math.abs(dy)));
      let position = { ...body };
      while (true) {
        position = { ...body, x: body.x + Math.trunc(dx * time / CIRCLE_LIMITS.timeScale), y: body.y + Math.trunc(dy * time / CIRCLE_LIMITS.timeScale) };
        if (time === 0 || queryCircleGeometry(targets.map(t => t.shape), { kind: "overlap", circle: position }, { sensors: "include" }).contacts.length === 0) break;
        time = Math.max(0, time - retreat);
      }
      body.x = position.x;
      body.y = position.y;
      let kind: BallisticEvent["kind"] = target.response === "catch" ? "catch" : "stop";
      if (kind !== "catch" && definition.impact === "bounce" && body.bounceCount < definition.maxBounces && hit.time.n > 0) {
        const velocity = reflect({ x: body.vx, y: body.vy }, hit.normal, definition.restitution);
        if (velocity.x * velocity.x + velocity.y * velocity.y > BALLISTIC_LIMITS.restSpeed * BALLISTIC_LIMITS.restSpeed) {
          body.vx = velocity.x; body.vy = velocity.y; body.bounceCount++; kind = "bounce";
        }
      }
      body.velocityRemainderX = body.velocityRemainderY = body.positionRemainderX = body.positionRemainderY = 0;
      if (kind !== "bounce") { body.vx = body.vy = 0; body.status = kind === "catch" ? "caught" : "stopped"; }
      staged.events.push({ tick: staged.tick, substep, bodyId: body.id, targetId: hit.bodyId, shapeId: hit.shapeId, kind, time: hit.time.n });
      // Explicitly discard unused tick motion at the first impact. At most one
      // response/body/tick, no implicit unbounded corner/contact iterations.
      break;
    }
  }
  return staged;
}

export class BallisticWorld {
  private readonly configuration: BallisticConfiguration;
  private state: BallisticState;
  constructor(value: BallisticConfiguration) {
    this.configuration = configuration(value);
    this.state = { tick: 0, events: [], bodies: this.configuration.bodies.map(b => ({
      id: b.id, x: b.x, y: b.y, radius: b.radius, vx: b.vx, vy: b.vy,
      velocityRemainderX: 0, velocityRemainderY: 0, positionRemainderX: 0, positionRemainderY: 0,
      status: "flying", bounceCount: 0,
    })) };
  }
  step(): BallisticState {
    // The production step stages the whole tick before publication.
    this.state = stepBallistics(this.configuration, this.state);
    return this.observe();
  }
  observe(): BallisticState { return copy(this.state); }
  /** Detached branch for consumers staging a larger atomic gameplay tick. No
   * replay or publication occurs; both branches retain their exact carry state. */
  fork(): BallisticWorld {
    const branch = new BallisticWorld(this.configuration);
    branch.state = this.observe();
    return branch;
  }
  capture(): BallisticCheckpoint { return { format: "p1-ballistics-v1", configuration: copy(this.configuration), state: this.observe() }; }
  restore(value: unknown): void {
    const normalized = canonicalBallisticData(value);
    const root = fields(value, ["format", "configuration", "state"]);
    if (root.format !== "p1-ballistics-v1" || canonicalBallisticData(root.configuration) !== canonicalBallisticData(this.configuration)) throw Error("Incompatible ballistic checkpoint");
    const s = fields(root.state, ["tick", "bodies", "events"]);
    const tick = integer(s.tick, 0, BALLISTIC_LIMITS.ticks);
    // Bounded replay verifies every future-affecting carry, ordering and contact
    // receipt. Validation is staged; any rejection preserves the live world.
    const staged = new BallisticWorld(this.configuration);
    for (let i = 0; i < tick; i++) staged.step();
    if (normalized !== canonicalBallisticData(staged.capture())) throw Error("Inconsistent ballistic checkpoint");
    this.state = staged.state;
  }
  predict(ticks: number): BallisticPrediction {
    circleInteger(ticks, 0, BALLISTIC_LIMITS.predictionTicks);
    if (this.state.tick + ticks > BALLISTIC_LIMITS.ticks) throw Error("Ballistic prediction tick cap");
    let projected = this.observe();
    const states: BallisticState[] = [];
    for (let i = 0; i < ticks; i++) { projected = stepBallistics(this.configuration, projected); states.push(copy(projected)); }
    return { states, checkpoint: { format: "p1-ballistics-v1", configuration: copy(this.configuration), state: copy(projected) } };
  }
}
