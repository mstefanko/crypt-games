import { advanceFixedAxis } from "@onepage/game-simulation/fixed-flight";
import { claimActionHit } from "@onepage/game-simulation/action-timeline";
import type { State } from "../../contract";
import { FIXED as F } from "../../rules";
import { guardianDamageCover, guardianDamagePlayer } from "./damage";
import { clamp, distance, sweepCircle } from "./spec";
/** Fixed-point mode lifecycle uses reviewed engine sweeps. ProjectileOwnerV1's
 * end-pose boundary hook cannot order world/cover before moving players, and its
 * full runtime includes libm/homing paths outside the simulation purity policy.
 * Keep that unsupported primitive boundary explicit rather than claim adoption. */
export function moveGuardianProjectiles(
  s: State,
  starts: Map<string, { x: number; y: number }>,
) {
  const g = s.guardian!,
    survivors = [];
  for (const p of g.projectiles) {
    const sx = advanceFixedAxis(p.vx, p.rx, 60),
      sy = advanceFixedAxis(p.vy, p.ry, 60),
      dx = p.lifeTicks <= 1 ? p.endX - p.x : sx.delta,
      dy = p.lifeTicks <= 1 ? p.endY - p.y : sy.delta;
    const contacts: {
      t: number;
      id: string;
      kind: "wall" | "cover" | "player";
    }[] = [];
    for (const [pos, delta, limit] of [
      [p.x, dx, 166 * F - p.radius],
      [p.y, dy, 96 * F - p.radius],
    ]) {
      if (delta && Math.abs(pos + delta) >= limit)
        contacts.push({
          t: clamp(((delta > 0 ? limit : -limit) - pos) / delta, 0, 1),
          id: "0-wall",
          kind: "wall",
        });
    }
    for (const c of g.cover)
      if (c.hp) {
        const t = sweepCircle(p.x, p.y, dx, dy, c.x, c.y, c.radius + p.radius);
        if (t !== null) contacts.push({ t, id: c.id, kind: "cover" });
      }
    for (const q of s.players)
      if (g.athletes[q.id].status === "active") {
        const start = starts.get(q.id) ?? q,
          t = sweepCircle(
            p.x,
            p.y,
            dx - (q.x - start.x),
            dy - (q.y - start.y),
            start.x,
            start.y,
            7 * F + p.radius,
          );
        if (t !== null) contacts.push({ t, id: q.id, kind: "player" });
      }
    contacts.sort(
      (a, b) =>
        a.t - b.t ||
        (a.kind === "player" ? 1 : 0) - (b.kind === "player" ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const hit = contacts[0];
    if (hit) {
      if (hit.kind === "cover") guardianDamageCover(s, hit.id);
      else if (hit.kind === "player") {
        const a = g.attack;
        if (!a || a.id !== p.attackId || claimActionHit(a, hit.id))
          guardianDamagePlayer(
            s,
            s.players.find((q) => q.id === hit.id)!,
            p.attackId,
          );
      }
      continue;
    }
    if (p.lifeTicks <= 1) {
      const c = g.cover.find(
        (c) =>
          c.hp > 0 &&
          distance(c, { x: p.endX, y: p.endY }) <= c.radius + p.radius + 2,
      );
      if (c) guardianDamageCover(s, c.id);
      continue;
    }
    survivors.push({
      ...p,
      x: p.x + dx,
      y: p.y + dy,
      rx: sx.remainder,
      ry: sy.remainder,
      lifeTicks: p.lifeTicks - 1,
    });
  }
  g.projectiles = survivors;
}
