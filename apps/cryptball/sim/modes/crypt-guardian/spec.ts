import { DeterministicRandom } from "@onepage/game-simulation/random";
import { circleSweepCircle } from "@onepage/game-simulation/circle-geometry";
import { FIXED as F, length } from "../../rules";
import type {
  CryptGuardianState,
  GuardianDescriptor,
  GuardianWeapon,
} from "./types";
export const GUARDIAN_RULES = Object.freeze({
  hp: 300,
  projectileSpeed: 195 * F,
  health: 5,
  immunity: 60,
  reviveTicks: 90,
  reviveRange: 18 * F,
  hardLimit: 10800,
  escalation: 7200,
});
const WEAPONS: GuardianWeapon[] = ["cannon", "hook", "maul"];
/** Separate, serialized gameplay stream: cosmetic generation never consumes it. */
export function guardianRandom(
  g: Pick<CryptGuardianState, "rng">,
  bound: number,
) {
  const owner = new DeterministicRandom(
    g.rng.streams.map(({ owner, name, seed }) => ({ owner, name, seed })),
  );
  owner.restore(g.rng);
  const value = owner.drawInteger("cryptball", "guardian", bound);
  g.rng = owner.capture();
  return value;
}
export function guardianDescriptor(seed = 0xc7ba11): GuardianDescriptor {
  const n = ((Math.trunc(seed) % 4294967296) + 4294967296) % 4294967296;
  const weapon = WEAPONS[n % 3],
    size = ([90, 100, 110] as const)[Math.floor(n / 9) % 3];
  return {
    generatorVersion: 1,
    seed: n,
    weapon,
    size,
    palette: (["violet", "verdigris", "ember"] as const)[Math.floor(n / 3) % 3],
    name: [
      "Vark, the Hollow Warden",
      "Brakka, Keeper of Embers",
      "Ossa, the Chainbound",
    ][Math.floor(n / 27) % 3],
    layout: weapon === "maul" ? "open" : "pillars",
    x: 0,
    y: -68 * F,
    bodyRadius: Math.round((20 * F * size) / 100),
    hurtRadius: Math.round((17 * F * size) / 100),
  };
}
export const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));
export const distance = (
  a: { x: number; y: number },
  b: { x: number; y: number },
) => length(a.x - b.x, a.y - b.y);
/** Minkowski radius is split across two legal engine circles. Boss radii
 * exceed one 16-unit primitive, but every combined radius remains below32.
 * Long warning rays use bounded32-unit segments; gameplay motion fits one. */
export function sweepCircle(
  x: number,
  y: number,
  dx: number,
  dy: number,
  cx: number,
  cy: number,
  r: number,
): number | null {
  x = Math.round(x);
  y = Math.round(y);
  dx = Math.round(dx);
  dy = Math.round(dy);
  r = Math.round(r);
  const radius = Math.min(4096, Math.floor(r / 2)),
    targetRadius = r - radius;
  const steps = Math.max(1, Math.ceil(length(dx, dy) / (31 * F)));
  for (let i = 0; i < steps; i++) {
    const ox = Math.round((dx * i) / steps),
      oy = Math.round((dy * i) / steps);
    const ex = Math.round((dx * (i + 1)) / steps),
      ey = Math.round((dy * (i + 1)) / steps);
    const t = circleSweepCircle(
      { x: x + ox, y: y + oy, radius },
      { x: ex - ox, y: ey - oy },
      { x: Math.round(cx), y: Math.round(cy), radius: targetRadius },
    );
    if (t !== null) return (i + t / 65536) / steps;
  }
  return null;
}
export function segmentDistance(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
) {
  const dx = bx - ax,
    dy = by - ay,
    d = dx * dx + dy * dy,
    t = d ? clamp(((x - ax) * dx + (y - ay) * dy) / d, 0, 1) : 0;
  return length(x - ax - dx * t, y - ay - dy * t);
}
