/** Bounded projectile lifecycle in fixed-point coordinates (256 units per pixel).
 * Targets provide start/end poses for relative swept collision; ties use stable IDs. */
export interface MovingProjectileTarget {
  id: string;
  x: number;
  y: number;
  nextX: number;
  nextY: number;
  radius: number;
}
export interface DynamicProjectile {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  gravity: number;
  radius: number;
  life: number;
  damage: number;
  originX: number;
  ignoreTargetId?: string;
  homing?: { targetId: string; turnRate: number };
  bounces?: number;
}
export interface ProjectileImpact {
  projectile: DynamicProjectile;
  targetId: string;
  time: number;
}
export class ProjectileOwnerV1 {
  private bodies: DynamicProjectile[] = [];
  readonly limits: Readonly<{
    projectiles: number;
    targets: number;
    maxLifetime: number;
  }>;
  constructor(limits = { projectiles: 4, targets: 32, maxLifetime: 3 }) {
    if (
      !Number.isInteger(limits.projectiles) ||
      limits.projectiles < 1 ||
      limits.projectiles > 256 ||
      !Number.isInteger(limits.targets) ||
      limits.targets < 1 ||
      limits.targets > 1024 ||
      !Number.isFinite(limits.maxLifetime) ||
      limits.maxLifetime <= 0
    )
      throw Error("Invalid projectile limits");
    this.limits = Object.freeze({ ...limits });
  }
  spawn(body: DynamicProjectile): boolean {
    if (this.bodies.length >= this.limits.projectiles) return false;
    if (
      !body.id ||
      this.bodies.some((b) => b.id === body.id) ||
      ![
        body.x,
        body.y,
        body.vx,
        body.vy,
        body.gravity,
        body.radius,
        body.life,
        body.damage,
        body.originX,
      ].every(Number.isFinite) ||
      body.damage < 0 ||
      body.radius <= 0 ||
      body.life <= 0 ||
      body.life > this.limits.maxLifetime
    )
      throw Error("Invalid projectile");
    if (
      body.homing &&
      (!body.homing.targetId ||
        !Number.isFinite(body.homing.turnRate) ||
        body.homing.turnRate < 0)
    )
      throw Error("Invalid projectile homing");
    if (
      body.bounces !== undefined &&
      (!Number.isInteger(body.bounces) || body.bounces < 0 || body.bounces > 32)
    )
      throw Error("Invalid projectile bounce count");
    this.bodies.push({
      ...body,
      ...(body.homing ? { homing: { ...body.homing } } : {}),
    });
    return true;
  }
  step(
    dt: number,
    targets: readonly MovingProjectileTarget[],
    boundary?: (
      x: number,
      y: number,
      radius: number,
    ) => { x: number; y: number; nx: number; ny: number } | undefined,
  ): ProjectileImpact[] {
    if (
      !Number.isFinite(dt) ||
      dt < 0 ||
      dt > 0.1 ||
      targets.length > this.limits.targets
    )
      throw Error("Invalid projectile step");
    if (
      new Set(targets.map((t) => t.id)).size !== targets.length ||
      targets.some(
        (t) =>
          !t.id ||
          ![t.x, t.y, t.nextX, t.nextY, t.radius].every(Number.isFinite) ||
          t.radius <= 0,
      )
    )
      throw Error("Invalid moving targets");
    if (dt === 0) return [];
    const hits: ProjectileImpact[] = [];
    const survivors: DynamicProjectile[] = [];
    for (const b of this.bodies) {
      if (b.homing) {
        const target = targets.find((t) => t.id === b.homing!.targetId);
        if (target) {
          const heading = Math.atan2(b.vy, b.vx),
            desired = Math.atan2(target.y - b.y, target.x - b.x);
          const delta = Math.atan2(
            Math.sin(desired - heading),
            Math.cos(desired - heading),
          );
          const turn = Math.max(
            -b.homing.turnRate * dt,
            Math.min(b.homing.turnRate * dt, delta),
          );
          const speed = Math.hypot(b.vx, b.vy);
          b.vx = Math.cos(heading + turn) * speed;
          b.vy = Math.sin(heading + turn) * speed;
        }
      }
      const elapsed = Math.min(dt, b.life),
        dx = b.vx * elapsed,
        dy = b.vy * elapsed + (b.gravity * elapsed * elapsed) / 2;
      let best: { id: string; t: number } | undefined;
      for (const target of targets) {
        if (target.id === b.ignoreTargetId) continue;
        const x = b.x - target.x,
          y = b.y - target.y,
          rx = dx - ((target.nextX - target.x) * elapsed) / dt,
          ry = dy - ((target.nextY - target.y) * elapsed) / dt,
          r = b.radius + target.radius;
        const a = rx * rx + ry * ry,
          c = x * x + y * y - r * r,
          z = 2 * (x * rx + y * ry),
          disc = z * z - 4 * a * c;
        let t =
          c <= 0
            ? 0
            : a > 0 && disc >= 0
              ? (-z - Math.sqrt(disc)) / (2 * a)
              : Infinity;
        if (
          t >= 0 &&
          t <= 1 &&
          (!best || t < best.t || (t === best.t && target.id < best.id))
        )
          best = { id: target.id, t };
      }
      if (best) {
        hits.push({
          projectile: { ...b, x: b.x + dx * best.t, y: b.y + dy * best.t },
          targetId: best.id,
          time: best.t,
        });
        continue;
      }
      b.x += dx;
      b.y += dy;
      b.vy += b.gravity * elapsed;
      const wall = boundary?.(b.x, b.y, b.radius);
      if (wall) {
        if ((b.bounces ?? 0) <= 0) continue;
        const dot = b.vx * wall.nx + b.vy * wall.ny;
        b.vx -= 2 * dot * wall.nx;
        b.vy -= 2 * dot * wall.ny;
        b.x = wall.x;
        b.y = wall.y;
        b.bounces!--;
      }
      b.life -= dt;
      if (b.life > 0) survivors.push(b);
    }
    this.bodies = survivors;
    return hits;
  }
  capture(): DynamicProjectile[] {
    return this.bodies.map((b) => ({
      ...b,
      ...(b.homing ? { homing: { ...b.homing } } : {}),
    }));
  }
  restore(bodies: DynamicProjectile[]): void {
    const staged = new ProjectileOwnerV1(this.limits);
    for (const b of bodies)
      if (!staged.spawn(b)) throw Error("Projectile restore limit");
    this.bodies = staged.capture();
  }
  clear(): void {
    this.bodies = [];
  }
}
