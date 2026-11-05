import { DamageOwner } from "@onepage/game-simulation/damage-owner";
import { event } from "../../actions";
import { FIXED as F } from "../../rules";
import type { State, Player } from "../../contract";
import { clamp, distance, segmentDistance } from "./spec";
export function guardianDamagePlayer(s: State, p: Player, attackId: number) {
  const g = s.guardian!,
    a = g.athletes[p.id];
  if (a.status !== "active" || s.tick < a.immunityUntil || g.practice.immortal)
    return false;
  for (const orb of g.orbs)
    if (orb.id !== g.activeOrbId && orb.possessionId === p.id) {
      orb.possessionId = null;
      orb.ball.vx = 0;
      orb.ball.vy = 55 * F;
      orb.ball.passTick = s.tick;
      orb.ball.lastTouch = p.id;
    }
  if (s.possessionId === p.id) {
    s.possessionId = null;
    s.ball.vx = 0;
    s.ball.vy = 55 * F;
    s.ball.passTick = s.tick;
    s.ball.lastTouch = p.id;
  }
  const owner = new DamageOwner([{ id: p.id, hp: a.hp, maxHp: 5 }]);
  owner.damage(p.id, 1);
  a.hp = owner.get(p.id).hp;
  a.immunityUntil = s.tick + 60;
  p.immunityTicks = 60;
  p.staggerTicks = 12;
  p.charging = false;
  p.chargeTicks = 0;
  p.buffer = null;
  p.action = null;
  p.slideTicks = p.dashTicks = 0;
  a.reviveBy = null;
  a.reviveTicks = 0;
  for (const q of Object.values(g.athletes))
    if (q.reviveBy === p.id) {
      q.reviveBy = null;
      q.reviveTicks = 0;
    }
  event(s, "guardian-damage", p, { attackId, hp: a.hp });
  if (a.hp === 0) {
    a.status = a.revives ? "out" : "down";
    p.vx = p.vy = 0;
    p.x = clamp(p.x, -150 * F, 150 * F);
    p.y = clamp(p.y, -36 * F, 80 * F);
    const blockers = [
      ...g.cover.filter((c) => c.hp > 0),
      { ...g.descriptor, radius: g.descriptor.bodyRadius },
    ];
    for (let pass = 0; pass < 2; pass++)
      for (const c of blockers) {
        const n = distance(c, p),
          r = c.radius + 9 * F;
        if (n < r) {
          p.x = c.x + Math.round((n ? (p.x - c.x) / n : 0) * r);
          p.y = c.y + Math.round((n ? (p.y - c.y) / n : 1) * r);
        }
      }
    p.x = clamp(p.x, -150 * F, 150 * F);
    p.y = clamp(p.y, -36 * F, 80 * F);

    event(s, a.status === "down" ? "guardian-down" : "guardian-out", p);
  }
  return true;
}
export function guardianDamageCover(s: State, id: string) {
  const c = s.guardian!.cover.find((c) => c.id === id);
  if (!c || !c.hp) return;
  const owner = new DamageOwner([{ id, hp: c.hp, maxHp: 3 }]);
  owner.damage(id, 1);
  c.hp = owner.get(id).hp;
  event(s, c.hp ? "guardian-cover-crack" : "guardian-cover-break", undefined, {
    coverId: id,
    x: c.x,
    y: c.y,
    hp: c.hp,
  });
}
export function guardianLineClear(
  s: Pick<State, "guardian">,
  a: { x: number; y: number },
  b: { x: number; y: number },
) {
  return !s.guardian!.cover.some(
    (c) =>
      c.hp > 0 &&
      segmentDistance(c.x, c.y, a.x, a.y, b.x, b.y) <= c.radius + 2 * F,
  );
}
/** Revive is a game-owned reconstruction: repair intentionally cannot revive. */
export function guardianRevive(s: State, down: Player, by: Player) {
  const a = s.guardian!.athletes[down.id];
  if (a.status !== "down" || a.revives) return;
  const owner = new DamageOwner([{ id: down.id, hp: 2, maxHp: 5 }]);
  a.hp = owner.get(down.id).hp;
  a.status = "active";
  a.revives = 1;
  a.immunityUntil = s.tick + 90;
  a.reviveBy = null;
  a.reviveTicks = 0;
  down.immunityTicks = 90;
  down.staggerTicks = 0;
  event(s, "guardian-revive", by, { targetId: down.id, hp: 2 });
}
export function resolveGuardianOutcome(s: State) {
  const g = s.guardian!;
  if (g.outcome) return;
  const victory = g.hp === 0;
  if (
    !victory &&
    Object.values(g.athletes).some((a) => a.status === "active") &&
    g.elapsed < 10800
  )
    return;
  g.outcome = victory ? "victory" : "defeat";
  s.phase = "results";
  s.phaseTicks = 0;
  s.winner = victory ? 0 : 1;
  s.score = victory ? [1, 0] : [0, 1];
  g.projectiles = [];
  g.attack = null;
  s.ball.vx = s.ball.vy = 0;
  for (const orb of g.orbs) {
    orb.ball.vx = orb.ball.vy = 0;
    orb.deflectUntil = orb.hostileUntil = 0;
  }
  g.deflectUntil = g.hostileUntil = 0;
  for (const p of s.players) {
    p.vx = p.vy = 0;
    p.action = null;
    p.charging = false;
    p.chargeTicks = 0;
  }
  event(s, "guardian-" + g.outcome, undefined, {
    winner: s.winner,
    reason: victory
      ? "boss-defeated"
      : g.elapsed >= 10800
        ? "timeout"
        : "party-defeated",
  });
  event(s, "match-end", undefined, { winner: s.winner, cooperative: true });
}
export function reviveTarget(
  s: Pick<State, "players" | "guardian">,
  p: Player,
) {
  return s.players
    .filter(
      (q) =>
        s.guardian!.athletes[q.id].status === "down" &&
        distance(p, q) <= 18 * F &&
        guardianLineClear(s, p, q),
    )
    .sort(
      (a, b) =>
        distance(p, a) - distance(p, b) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )[0];
}
