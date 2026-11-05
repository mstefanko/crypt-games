import { kartAngle, queryKartTrack, type KartTrack } from "./kart-track";
export interface KartProfile {
  name: string;
  acceleration: number;
  speed: number;
  grip: number;
  color: string;
}
export const KART_PROFILES: readonly KartProfile[] = [
  {
    name: "Copper Finch",
    acceleration: 75,
    speed: 110,
    grip: 8,
    color: "#efaa52",
  },
  {
    name: "Jade Heron",
    acceleration: 62,
    speed: 121,
    grip: 6.4,
    color: "#62d5b2",
  },
  {
    name: "Violet Moth",
    acceleration: 90,
    speed: 101,
    grip: 10,
    color: "#c194f2",
  },
];
export interface KartBody {
  id: string;
  x: number;
  y: number;
  heading: number;
  vx: number;
  vy: number;
  speed: number;
  slip: number;
  charge: number;
  drift: number;
  boost: number;
  spin: number;
  immune: number;
  z: number;
  vz: number;
  segment: number;
  profile: number;
  stuck: number;
}
export interface KartControl {
  throttle: number;
  brake: number;
  steer: number;
  drift: boolean;
}
export function createKartBody(
  id: string,
  x: number,
  y: number,
  heading: number,
  profile: number,
): KartBody {
  return {
    id,
    x,
    y,
    heading,
    vx: 0,
    vy: 0,
    speed: 0,
    slip: 0,
    charge: 0,
    drift: 0,
    boost: 0,
    spin: 0,
    immune: 0,
    z: 0,
    vz: 0,
    segment: 0,
    profile,
    stuck: 0,
  };
}
export function stepKartBody(
  k: KartBody,
  c: KartControl,
  track: KartTrack,
  dt: number,
): { turbo: boolean; wall: boolean; landed: boolean } {
  const p = KART_PROFILES[k.profile]!,
    wasAir = k.z > 0;
  let turbo = false,
    wall = false;
  k.boost = Math.max(0, k.boost - dt);
  k.spin = Math.max(0, k.spin - dt);
  k.immune = Math.max(0, k.immune - dt);
  let q = queryKartTrack(track, k.x, k.y, k.segment);
  k.segment = q.segment;
  const off = q.distance > q.width / 2,
    forward = k.vx * Math.cos(k.heading) + k.vy * Math.sin(k.heading),
    lateral = -k.vx * Math.sin(k.heading) + k.vy * Math.cos(k.heading);
  if (k.spin > 0) {
    k.heading += dt * 8;
    k.vx *= Math.exp(-dt * 3);
    k.vy *= Math.exp(-dt * 3);
    k.charge = 0;
    k.drift = 0;
  } else {
    if (c.drift && !k.drift && Math.abs(c.steer) > 0.15 && forward > 32)
      k.drift = Math.sign(c.steer);
    if (k.drift && !c.drift) {
      if (k.charge > 0.65) {
        k.boost = k.charge > 1.65 ? 1.4 : 0.8;
        turbo = true;
      }
      k.drift = 0;
      k.charge = 0;
    }
    const steer =
      c.steer * (1.6 + Math.min(1, Math.abs(forward) / 70)) +
      (k.drift ? k.drift * 0.7 : 0);
    k.heading = kartAngle(
      k.heading +
        steer *
          dt *
          Math.min(1, Math.abs(forward) / 24) *
          (forward < 0 ? -1 : 1),
    );
    k.slip = Math.abs(lateral);
    if (k.drift && forward > 45 && k.slip > 5 && Math.abs(c.steer) > 0.12)
      k.charge = Math.min(
        2.4,
        k.charge + dt * (c.steer * k.drift < 0 ? 1.55 : 0.75),
      );
    const cap = p.speed * (off ? 0.46 : 1) * (k.boost > 0 ? 1.55 : 1),
      accel =
        c.throttle * p.acceleration +
        (k.boost > 0 ? 95 : 0) -
        c.brake * (forward > 5 ? 140 : 42);
    let f = forward + accel * dt;
    f *= Math.exp(-dt * (c.throttle === 0 ? 0.65 : 0.16));
    f = Math.max(-30, Math.min(cap, f));
    const lat =
      lateral * Math.exp(-dt * (k.drift ? 1.1 : p.grip)) +
      (k.drift ? -k.drift * Math.abs(f) * 0.62 * dt : 0);
    k.vx = Math.cos(k.heading) * f - Math.sin(k.heading) * lat;
    k.vy = Math.sin(k.heading) * f + Math.cos(k.heading) * lat;
  }
  // Bounded substeps keep boost motion inside the narrowest road boundary.
  const steps = Math.max(1, Math.ceil((Math.hypot(k.vx, k.vy) * dt) / 8));
  for (let i = 0; i < steps; i++) {
    k.x += (k.vx * dt) / steps;
    k.y += (k.vy * dt) / steps;
    q = queryKartTrack(track, k.x, k.y, k.segment);
    k.segment = q.segment;
    const edge = q.width / 2 + 36;
    if (q.distance > edge) {
      const nx = (k.x - q.x) / q.distance,
        ny = (k.y - q.y) / q.distance;
      k.x = q.x + nx * edge;
      k.y = q.y + ny * edge;
      const dot = k.vx * nx + k.vy * ny;
      if (dot > 0) {
        k.vx -= dot * 1.35 * nx;
        k.vy -= dot * 1.35 * ny;
        wall = true;
      }
    }
  }
  if (q.surface === "ramp" && k.z === 0 && forward > 45) {
    k.vz = 35;
    k.z = 0.1;
  }
  if (k.z > 0) {
    k.vz -= 95 * dt;
    k.z = Math.max(0, k.z + k.vz * dt);
    if (k.z === 0) k.vz = 0;
  }
  k.speed = Math.hypot(k.vx, k.vy);
  k.stuck = k.speed < 4 ? k.stuck + dt : 0;
  return { turbo, wall, landed: wasAir && k.z === 0 };
}
export function collideKarts(karts: KartBody[]): void {
  for (let i = 0; i < karts.length; i++)
    for (let j = i + 1; j < karts.length; j++) {
      const a = karts[i]!,
        b = karts[j]!,
        dx = b.x - a.x,
        dy = b.y - a.y,
        d = Math.hypot(dx, dy);
      if (d > 0 && d < 17 && Math.abs(a.z - b.z) < 8) {
        const nx = dx / d,
          ny = dy / d,
          overlap = (17 - d) / 2;
        a.x -= nx * overlap;
        a.y -= ny * overlap;
        b.x += nx * overlap;
        b.y += ny * overlap;
        const speed = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
        if (speed > 0) {
          a.vx -= nx * speed * 0.6;
          a.vy -= ny * speed * 0.6;
          b.vx += nx * speed * 0.6;
          b.vy += ny * speed * 0.6;
        }
      }
    }
}
