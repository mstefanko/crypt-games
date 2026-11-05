import {
  ProjectileOwnerV1,
  type DynamicProjectile,
} from "./dynamic-projectiles";
import { queryKartTrack, trackPointAt, type KartTrack } from "./kart-track";
import type { KartBody } from "./kart-motion";
export type KartItem = "boost" | "oil" | "firework" | "lantern";
export interface KartItemState {
  rng: number;
  sequence: number;
  inventory: Record<string, KartItem | null>;
  boxes: { x: number; y: number; cooldown: number }[];
  oil: { x: number; y: number; life: number; owner: string; armed: number }[];
  projectiles: DynamicProjectile[];
}
export class KartItemOwner {
  state: KartItemState;
  readonly projectiles = new ProjectileOwnerV1({
    projectiles: 32,
    targets: 12,
    maxLifetime: 10,
  });
  constructor(track: KartTrack, seed: number) {
    this.state = {
      rng: (seed ^ 0x691f8c23) >>> 0,
      sequence: 0,
      inventory: {},
      boxes: [0.08, 0.23, 0.43, 0.62, 0.82].flatMap((p) =>
        [-20, 20].map((offset) => {
          const q = trackPointAt(track, track.length * p);
          return {
            x: q.x - Math.sin(q.heading) * offset,
            y: q.y + Math.cos(q.heading) * offset,
            cooldown: 0,
          };
        }),
      ),
      oil: [],
      projectiles: [],
    };
  }
  random(): number {
    let x = this.state.rng || 1;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state.rng = x >>> 0;
    return this.state.rng / 4294967296;
  }
  use(
    k: KartBody,
    ranked: readonly string[],
    karts: readonly KartBody[],
  ): KartItem | null {
    const item = this.state.inventory[k.id];
    if (!item || k.spin > 0) return null;
    this.state.inventory[k.id] = null;
    if (item === "boost") k.boost = 2;
    if (item === "oil")
      this.state.oil.push({
        x: k.x - Math.cos(k.heading) * 22,
        y: k.y - Math.sin(k.heading) * 22,
        life: 17,
        owner: k.id,
        armed: 0.8,
      });
    if (item === "firework" || item === "lantern") {
      const place = ranked.indexOf(k.id),
        targetId = ranked[Math.max(0, place - 1)],
        target = karts.find((r) => r.id === targetId && r !== k);
      this.projectiles.spawn({
        id: `${item}-${++this.state.sequence}`,
        x: k.x + Math.cos(k.heading) * 24,
        y: k.y + Math.sin(k.heading) * 24,
        vx: Math.cos(k.heading) * 165,
        vy: Math.sin(k.heading) * 165,
        gravity: 0,
        radius: 5,
        life: item === "lantern" ? 9 : 5,
        damage: 1,
        originX: k.x,
        ignoreTargetId: k.id,
        bounces: item === "firework" ? 5 : 0,
        ...(item === "lantern" && target
          ? { homing: { targetId: target.id, turnRate: 2.6 } }
          : {}),
      });
    }
    return item;
  }
  step(
    track: KartTrack,
    karts: KartBody[],
    ranked: readonly string[],
    dt: number,
  ): { kind: string; sourceId: string }[] {
    const events: { kind: string; sourceId: string }[] = [];
    for (const box of this.state.boxes) {
      box.cooldown = Math.max(0, box.cooldown - dt);
      if (box.cooldown === 0)
        for (const k of karts)
          if (
            !this.state.inventory[k.id] &&
            Math.hypot(k.x - box.x, k.y - box.y) < 21
          ) {
            const rank = ranked.indexOf(k.id),
              r = this.random();
            this.state.inventory[k.id] =
              rank < 2
                ? r < 0.42
                  ? "oil"
                  : r < 0.76
                    ? "firework"
                    : "boost"
                : r < 0.36
                  ? "boost"
                  : r < 0.67
                    ? "lantern"
                    : r < 0.85
                      ? "firework"
                      : "oil";
            box.cooldown = 6;
            events.push({ kind: "box", sourceId: k.id });
            break;
          }
    }
    for (const o of this.state.oil) {
      o.life -= dt;
      o.armed -= dt;
      for (const k of karts)
        if (
          o.armed <= 0 &&
          k.z < 5 &&
          k.immune <= 0 &&
          Math.hypot(k.x - o.x, k.y - o.y) < 18
        ) {
          this.hit(k);
          o.life = 0;
          events.push({ kind: "spin", sourceId: k.id });
          break;
        }
    }
    this.state.oil = this.state.oil.filter((o) => o.life > 0);
    const hits = this.projectiles.step(
      dt,
      karts
        .filter((k) => k.immune <= 0 && k.z < 8)
        .map((k) => ({
          id: k.id,
          x: k.x,
          y: k.y,
          nextX: k.x,
          nextY: k.y,
          radius: 9,
        })),
      (x, y, r) => {
        const q = queryKartTrack(track, x, y);
        if (q.distance < q.width / 2 - r) return;
        const nx = (x - q.x) / q.distance,
          ny = (y - q.y) / q.distance;
        return {
          x: q.x + nx * (q.width / 2 - r),
          y: q.y + ny * (q.width / 2 - r),
          nx,
          ny,
        };
      },
    );
    for (const hit of hits) {
      const k = karts.find((k) => k.id === hit.targetId)!;
      this.hit(k);
      events.push({ kind: "spin", sourceId: k.id });
    }
    this.state.projectiles = this.projectiles.capture();
    return events;
  }
  hit(k: KartBody): void {
    k.spin = 1.05;
    k.immune = 3;
    k.vx *= 0.45;
    k.vy *= 0.45;
    k.boost = 0;
  }
  capture(): KartItemState {
    return structuredClone({
      ...this.state,
      projectiles: this.projectiles.capture(),
    });
  }
  restore(value: KartItemState): void {
    this.state = structuredClone(value);
    this.projectiles.restore(value.projectiles);
  }
}
