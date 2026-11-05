import { CueDeliveryGuard, type CueDeliveryMode } from "./cues.ts";
import type { RulesCue } from "@onepage/game-simulation/time-policy";

/** Implementation budgets, not measured simultaneous-workload guarantees. */
export const COSMETIC_LIMITS = Object.freeze({
  emitters: 16,
  particles: 512,
  tweens: 64,
  lifetimeMs: 5000,
  ratePerSecond: 128,
  deltaMs: 100,
});
export type CosmeticAdmission =
  | "accepted"
  | "capacity"
  | "duplicate"
  | "reduced-motion"
  | "disposed";
export interface CosmeticEmitter {
  id: string;
  priority: number;
  x: number;
  y: number;
  burst: number;
  ratePerSecond: number;
  durationMs: number;
  lifetimeMs: number;
  speed: number;
  radius: number;
  color: number;
}
export interface CosmeticTween {
  id: string;
  priority: number;
  from: number;
  to: number;
  durationMs: number;
}
export interface CosmeticParticle {
  id: number;
  emitterId: string;
  priority: number;
  x: number;
  y: number;
  radius: number;
  color: number;
  alpha: number;
}
interface Particle extends CosmeticParticle {
  vx: number;
  vy: number;
  age: number;
  lifetime: number;
  order: number;
}
interface Emitter extends CosmeticEmitter {
  age: number;
  credit: number;
  order: number;
}
interface Tween extends CosmeticTween {
  age: number;
  order: number;
}
const bounded = (n: number, low: number, high: number) =>
  Number.isFinite(n) && n >= low && n <= high;
const idValid = (id: string) =>
  typeof id === "string" && /^[a-zA-Z0-9:._-]{1,128}$/.test(id);
const priorityValid = (priority: number) =>
  Number.isInteger(priority) && bounded(priority, 0, 255);

/** Explicit private cosmetic seed. This never imports or consumes rules RNG. */
export class CosmeticRandom {
  private state: number;
  constructor(seed: number) {
    if (!Number.isInteger(seed) || !bounded(seed, 0, 0xffffffff))
      throw new RangeError("Invalid cosmetic seed");
    this.state = seed;
  }
  next(): number {
    // Mulberry32, deliberately separate from the rules algorithm/streams.
    let n = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    n = Math.imul(n ^ (n >>> 15), n | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 0x100000000;
  }
}

/** Data-only cosmetic owner: no callbacks, renderer, timers or authoritative writes.
 * Larger priorities win; equal priority retains earlier admitted work. Each pool
 * evicts its lowest-priority newest entry, or drops incoming work if it cannot win.
 * Invalid requests reject before admission or RNG consumption. */
export class CosmeticEffects {
  private rng: CosmeticRandom;
  private particles: Particle[] = [];
  private emitters: Emitter[] = [];
  private tweens: Tween[] = [];
  private serial = 0;
  private disposed = false;
  private reducedMotion = false;
  private readonly guard = new CueDeliveryGuard();
  private dropped = { emitters: 0, particles: 0, tweens: 0 };
  constructor(seed: number, reducedMotion = false) {
    this.rng = new CosmeticRandom(seed);
    this.setReducedMotion(reducedMotion);
  }
  setReducedMotion(value: boolean): void {
    if (typeof value !== "boolean")
      throw new RangeError("Invalid reduced-motion setting");
    this.reducedMotion = value;
    if (value) this.clear();
  }
  /** Snapshot effects may be resampled from an observation; cue history survives. */
  reset(seed?: number): void {
    const rng = seed === undefined ? this.rng : new CosmeticRandom(seed);
    this.clear();
    this.rng = rng;
  }
  beginSession(mode: CueDeliveryMode): number {
    if (this.disposed) throw new Error("Cosmetic effects disposed");
    const epoch = this.guard.beginSession(mode);
    this.clear();
    return epoch;
  }
  deliver(cue: RulesCue, epoch: number, emitter: CosmeticEmitter) {
    this.validateEmitter(emitter);
    if (this.disposed) return "disposed" as const;
    return this.guard.deliver(cue, epoch, () => {
      this.emit(emitter);
    });
  }
  emit(spec: CosmeticEmitter): CosmeticAdmission {
    this.validateEmitter(spec);
    if (this.disposed) return "disposed";
    if (this.reducedMotion) return "reduced-motion";
    if (this.emitters.some((entry) => entry.id === spec.id)) return "duplicate";
    const emitter = { ...spec, age: 0, credit: 0, order: this.nextOrder() };
    if (
      !this.admit(this.emitters, emitter, COSMETIC_LIMITS.emitters, "emitters")
    )
      return "capacity";
    this.spawn(emitter, spec.burst);
    return "accepted";
  }
  tween(spec: CosmeticTween): CosmeticAdmission {
    if (
      !idValid(spec.id) ||
      !priorityValid(spec.priority) ||
      !bounded(spec.from, -1e6, 1e6) ||
      !bounded(spec.to, -1e6, 1e6) ||
      !bounded(spec.durationMs, 1, COSMETIC_LIMITS.lifetimeMs)
    )
      throw new RangeError("Invalid cosmetic tween");
    if (this.disposed) return "disposed";
    if (this.reducedMotion) return "reduced-motion";
    if (this.tweens.some((entry) => entry.id === spec.id)) return "duplicate";
    return this.admit(
      this.tweens,
      { ...spec, age: 0, order: this.nextOrder() },
      COSMETIC_LIMITS.tweens,
      "tweens",
    )
      ? "accepted"
      : "capacity";
  }
  /** Explicit bounded presentation delta. Caller passes zero on paused/resize redraws. */
  advance(deltaMs: number): void {
    if (!bounded(deltaMs, 0, COSMETIC_LIMITS.deltaMs))
      throw new RangeError("Cosmetic delta must be in [0, 100]ms");
    if (this.disposed || deltaMs === 0) return;
    for (const particle of this.particles) {
      particle.age += deltaMs;
      particle.x += (particle.vx * deltaMs) / 1000;
      particle.y += (particle.vy * deltaMs) / 1000;
      particle.alpha = Math.max(0, 1 - particle.age / particle.lifetime);
    }
    this.particles = this.particles.filter((p) => p.age < p.lifetime);
    for (const emitter of this.emitters) {
      const activeDelta = Math.min(
        deltaMs,
        Math.max(0, emitter.durationMs - emitter.age),
      );
      emitter.age += deltaMs;
      emitter.credit += (activeDelta * emitter.ratePerSecond) / 1000;
      const count = Math.floor(emitter.credit);
      emitter.credit -= count;
      this.spawn(emitter, count);
    }
    this.emitters = this.emitters.filter((e) => e.age < e.durationMs);
    this.tweens = this.tweens.filter((t) => t.age < t.durationMs);
    for (const tween of this.tweens)
      tween.age = Math.min(tween.durationMs, tween.age + deltaMs);
    // Completed samples remain observable until the following nonzero advance.
  }
  inspect() {
    return {
      disposed: this.disposed,
      reducedMotion: this.reducedMotion,
      emitters: this.emitters.map((e) => ({
        id: e.id,
        priority: e.priority,
        ageMs: e.age,
      })),
      particles: this.particles.map(
        ({ id, emitterId, priority, x, y, radius, color, alpha }) => ({
          id,
          emitterId,
          priority,
          x,
          y,
          radius,
          color,
          alpha,
        }),
      ),
      tweens: this.tweens.map((t) => ({
        id: t.id,
        value: t.from + ((t.to - t.from) * t.age) / t.durationMs,
      })),
      dropped: { ...this.dropped },
      cue: this.guard.inspect(),
    };
  }
  dispose(): void {
    this.disposed = true;
    this.clear();
  }
  private clear(): void {
    this.emitters = [];
    this.particles = [];
    this.tweens = [];
    this.serial = 0;
  }
  private nextOrder(): number {
    if (this.serial >= Number.MAX_SAFE_INTEGER)
      throw new RangeError("Cosmetic sequence exhausted");
    return ++this.serial;
  }
  private validateEmitter(spec: CosmeticEmitter): void {
    if (
      !idValid(spec.id) ||
      !priorityValid(spec.priority) ||
      !bounded(spec.x, -1e6, 1e6) ||
      !bounded(spec.y, -1e6, 1e6) ||
      !Number.isInteger(spec.burst) ||
      !bounded(spec.burst, 0, COSMETIC_LIMITS.particles) ||
      !bounded(spec.ratePerSecond, 0, COSMETIC_LIMITS.ratePerSecond) ||
      !bounded(spec.durationMs, 0, COSMETIC_LIMITS.lifetimeMs) ||
      !bounded(spec.lifetimeMs, 1, COSMETIC_LIMITS.lifetimeMs) ||
      !bounded(spec.speed, 0, 256) ||
      !bounded(spec.radius, 0.25, 16) ||
      !Number.isInteger(spec.color) ||
      !bounded(spec.color, 0, 0xffffff)
    )
      throw new RangeError("Invalid cosmetic emitter");
  }
  private admit<T extends { priority: number; order: number }>(
    pool: T[],
    value: T,
    limit: number,
    kind: keyof typeof this.dropped,
  ): boolean {
    if (pool.length < limit) {
      pool.push(value);
      return true;
    }
    let worst = 0;
    for (let i = 1; i < pool.length; i++)
      if (
        pool[i].priority < pool[worst].priority ||
        (pool[i].priority === pool[worst].priority &&
          pool[i].order > pool[worst].order)
      )
        worst = i;
    this.dropped[kind]++;
    if (value.priority <= pool[worst].priority) return false;
    pool.splice(worst, 1);
    pool.push(value);
    return true;
  }
  private spawn(emitter: Emitter, count: number): void {
    for (let i = 0; i < count; i++) {
      const order = this.nextOrder();
      // Each admitted/rejected particle consumes the same two cosmetic draws.
      const angle = this.rng.next() * Math.PI * 2;
      const speed = emitter.speed * (0.5 + this.rng.next() * 0.5);
      this.admit(
        this.particles,
        {
          id: order,
          emitterId: emitter.id,
          priority: emitter.priority,
          x: emitter.x,
          y: emitter.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          radius: emitter.radius,
          color: emitter.color,
          alpha: 1,
          age: 0,
          lifetime: emitter.lifetimeMs,
          order,
        },
        COSMETIC_LIMITS.particles,
        "particles",
      );
    }
  }
}
