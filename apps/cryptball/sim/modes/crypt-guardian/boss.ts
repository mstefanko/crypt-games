import {
  actionPhase,
  claimActionHit,
} from "@onepage/game-simulation/action-timeline";
import { event } from "../../actions";
import type { State } from "../../contract";
import { FIXED as F, aimHeading, headingVector } from "../../rules";
import {
  GUARDIAN_RULES,
  clamp,
  distance,
  guardianRandom,
  segmentDistance,
  sweepCircle,
} from "./spec";
import { guardianDamageCover, guardianDamagePlayer } from "./damage";
import type {
  GuardianAttack,
  GuardianAttackKind,
  GuardianShape,
} from "./types";
export const GUARDIAN_ATTACK_TIMES: Record<
  GuardianAttackKind,
  [number, number, number]
> = {
  shot: [42, 180, 42],
  fan: [54, 180, 48],
  hook: [54, 48, 42],
  sweep: [60, 24, 48],
  slam: [66, 6, 48],
  "double-slam": [78, 42, 54],
  proximity: [60, 6, 60],
};
function floorDisk(
  s: State,
  x: number,
  y: number,
  at: number,
  previous?: GuardianShape,
): GuardianShape {
  const requested = {
    x: clamp(x, -130 * F, 130 * F),
    y: clamp(y, -28 * F, 64 * F),
  };
  const down = s.players.filter(
    (p) => s.guardian!.athletes[p.id].status === "down",
  );
  const candidates = [
    requested,
    ...[-120, -60, 0, 60, 120].flatMap((x) =>
      [-24, 24, 64].map((y) => ({ x: x * F, y: y * F })),
    ),
  ];
  const legal = candidates.filter(
    (q) =>
      down.every((p) => distance(p, q) >= 48 * F) &&
      (!previous || distance(previous, q) >= 56 * F),
  );
  // At most three markers share this broad arena. The authored candidate table
  // leaves a legal floor disk without a random retry or a covered rescue lane.
  const chosen = legal.sort(
    (a, b) =>
      distance(a, requested) - distance(b, requested) || a.x - b.x || a.y - b.y,
  )[0];
  if (!chosen) throw Error("No legal guardian floor telegraph");
  return {
    kind: "disk",
    x: Math.round(chosen.x),
    y: Math.round(chosen.y),
    radius: 32 * F,
    at,
  };
}
export function guardianAttackShapes(s: State, a: GuardianAttack) {
  const g = s.guardian!,
    d = g.descriptor,
    p = s.players.find((p) => p.id === a.targetId)!;
  const origin = { x: d.x, y: d.y + Math.round((14 * F * d.size) / 100) };
  if (a.kind === "slam" || a.kind === "double-slam") {
    const first = floorDisk(s, p.x, p.y, 0);
    a.shapes = [first];
    if (a.kind === "double-slam")
      a.shapes.push(
        floorDisk(s, p.x + (p.x <= 0 ? 70 : -70) * F, p.y + 12 * F, 36, first),
      );
    return;
  }
  if (a.kind === "proximity") {
    a.shapes = [
      { kind: "disk", x: d.x, y: d.y + 24 * F, radius: 33 * F, at: 0 },
    ];
    return;
  }
  if (a.kind === "sweep") {
    a.shapes = [
      { kind: "arc", ...origin, radius: 125 * F, innerRadius: 20 * F, at: 0 },
    ];
    return;
  }
  const h = aimHeading(p.x - origin.x, p.y - origin.y),
    offsets = a.kind === "fan" ? [-22, 0, 22] : [0];
  a.shapes = offsets.map((offset) => {
    const v = headingVector((h + offset + 256) % 256),
      max = (a.kind === "hook" ? 185 : 300) * F;
    let t = 1;
    // Clip warning lanes to arena and pillars using the exact same sweep as contact.
    const dx = Math.round((v.x * max) / 65536),
      dy = Math.round((v.y * max) / 65536);
    for (const [pos, delta, limit] of [
      [origin.x, dx, 160 * F],
      [origin.y, dy, 90 * F],
    ])
      if (delta)
        t = Math.min(
          t,
          clamp(((delta > 0 ? limit : -limit) - pos) / delta, 0, 1),
        );
    for (const c of g.cover)
      if (c.hp) {
        const hit = sweepCircle(
          origin.x,
          origin.y,
          dx,
          dy,
          c.x,
          c.y,
          c.radius + 5 * F,
        );
        if (hit !== null) t = Math.min(t, hit);
      }
    return {
      kind: "lane" as const,
      ...origin,
      endX: origin.x + Math.round(dx * t),
      endY: origin.y + Math.round(dy * t),
      radius: (a.kind === "hook" ? 9 : 5) * F,
      at: 0,
    };
  });
}
function startAttack(s: State) {
  const g = s.guardian!,
    active = s.players.filter((p) => g.athletes[p.id].status === "active");
  if (!active.length) return;
  const targets = active.filter(
    (p) => !(g.targetStreak >= 2 && p.id === g.lastTarget && active.length > 1),
  );
  const target = targets[guardianRandom(g, targets.length)];
  g.targetStreak = target.id === g.lastTarget ? g.targetStreak + 1 : 1;
  g.lastTarget = target.id;
  const family = g.practice.weapon ?? g.descriptor.weapon;
  const kinds: GuardianAttackKind[] =
    family === "cannon"
      ? ["shot", ...(g.stage === 2 ? ["fan" as const] : [])]
      : family === "hook"
        ? ["hook", ...(g.stage === 2 ? ["sweep" as const] : [])]
        : ["slam", ...(g.stage === 2 ? ["double-slam" as const] : [])];
  if (active.some((p) => g.athletes[p.id].nearTicks >= 30))
    kinds.push("proximity");
  // Before the second pattern unlocks, a distant party leaves only one legal
  // attack. Repeating it is preferable to an unannounced idle-floor slam.
  const alternatives = kinds.filter((k) => k !== g.previousAttack);
  const choices = alternatives.length ? alternatives : kinds;
  const kind = choices[guardianRandom(g, choices.length)];
  const [tell, activeTicks, recover] = GUARDIAN_ATTACK_TIMES[kind];
  g.attack = {
    id: s.nextAction++,
    kind,
    elapsed: 0,
    timing: {
      tell,
      active: activeTicks,
      recover: g.elapsed >= 7200 ? Math.ceil(recover * 0.85) : recover,
    },
    hits: [],
    targetId: target.id,
    locked: false,
    shapes: [],
    released: false,
  };
  guardianAttackShapes(s, g.attack);
  g.previousAttack = kind;
  event(s, "guardian-tell", undefined, {
    attackId: g.attack.id,
    kind,
    targetId: target.id,
    x: target.x,
    y: target.y,
  });
}
export function guardianShapeContains(
  shape: GuardianShape,
  x: number,
  y: number,
  radius = 0,
) {
  if (shape.kind === "disk")
    return distance(shape, { x, y }) <= shape.radius + radius;
  if (shape.kind === "lane")
    return (
      segmentDistance(x, y, shape.x, shape.y, shape.endX, shape.endY) <=
      shape.radius + radius
    );
  const d = distance(shape, { x, y });
  return (
    y >= shape.y - radius &&
    d <= shape.radius + radius &&
    d >= shape.innerRadius - radius
  );
}
export function guardianIsGuarding(s: Pick<State, "guardian" | "tick">) {
  const g = s.guardian;
  return (
    !!g &&
    g.hp > 0 &&
    s.tick >= g.staggerUntil &&
    !g.transitionTicks &&
    (!g.attack || actionPhase(g.attack).phase !== "recover")
  );
}
export function stepGuardianBoss(s: State) {
  const g = s.guardian!;
  const holder =
    s.players.find((p) => p.id === g.attack?.targetId) ??
    s.players.find((p) => g.orbs.some((o) => o.possessionId === p.id)) ??
    s.players.find((p) => g.athletes[p.id].status === "active");
  if (
    (!g.attack || !g.attack.locked) &&
    holder &&
    s.tick >= g.staggerUntil &&
    !g.transitionTicks
  ) {
    const desired = aimHeading(
      holder.x - g.descriptor.x,
      holder.y - g.descriptor.y,
    );
    const delta = ((desired - g.guardHeading + 384) % 256) - 128;
    g.guardHeading =
      (g.guardHeading + Math.max(-1, Math.min(1, delta)) + 256) % 256;
  }
  if (s.tick < g.staggerUntil) return;
  if (g.guard === 0) g.guard = 100;
  if (g.stage === 1 && g.hp <= 150) {
    g.stage = 2;
    g.transitionTicks = 60;
    g.attack = null;
    g.projectiles = [];
    event(s, "guardian-phase", undefined, { stage: 2 });
  }
  if (g.transitionTicks) {
    g.transitionTicks--;
    return;
  }
  if (!g.attack) {
    if (s.tick >= g.nextAttack) startAttack(s);
    return;
  }
  const a = g.attack,
    phase = actionPhase(a).phase;
  if (phase === "tell") {
    const lockAt =
      a.kind === "slam"
        ? 42
        : a.kind === "double-slam"
          ? 54
          : Math.max(12, a.timing.tell - 20);
    if (!a.locked) {
      guardianAttackShapes(s, a);
      if (a.elapsed >= lockAt) {
        a.locked = true;
        event(s, "guardian-lock", undefined, {
          attackId: a.id,
          targetId: a.targetId,
        });
      }
    }
  } else if (phase === "active") {
    const activeTick = a.elapsed - a.timing.tell;
    if (!a.released) {
      a.released = true;
      a.locked = true;
      event(s, "guardian-release", undefined, { attackId: a.id, kind: a.kind });
      if (a.kind === "shot" || a.kind === "fan")
        for (const [i, shape] of a.shapes.entries())
          if (shape.kind === "lane") {
            const h = aimHeading(shape.endX - shape.x, shape.endY - shape.y),
              v = headingVector(h);
            g.projectiles.push({
              id: `boss-${a.id}-${i}`,
              attackId: a.id,
              endX: shape.endX,
              endY: shape.endY,
              x: shape.x,
              y: shape.y,
              vx: Math.round((v.x * GUARDIAN_RULES.projectileSpeed) / 65536),
              vy: Math.round((v.y * GUARDIAN_RULES.projectileSpeed) / 65536),
              rx: 0,
              ry: 0,
              radius: 5 * F,
              lifeTicks: Math.max(
                1,
                Math.min(
                  180,
                  Math.ceil(
                    (distance(shape, { x: shape.endX, y: shape.endY }) * 60) /
                      GUARDIAN_RULES.projectileSpeed,
                  ),
                ),
              ),
            });
          }
      if (a.kind === "hook") {
        const lane = a.shapes[0];
        if (lane?.kind === "lane")
          for (const c of g.cover)
            if (
              c.hp &&
              distance(c, { x: lane.endX, y: lane.endY }) <= c.radius + 6 * F
            )
              guardianDamageCover(s, c.id);
      }
    }
    for (const p of s.players) {
      if (g.athletes[p.id].status !== "active" || a.hits.includes(p.id))
        continue;
      let shapes = a.shapes.filter(
        (sh) =>
          activeTick >= sh.at &&
          activeTick <
            sh.at +
              (a.kind === "double-slam" ||
              a.kind === "slam" ||
              a.kind === "proximity"
                ? 6
                : a.timing.active),
      );
      if (a.kind === "shot" || a.kind === "fan") continue;
      if (a.kind === "hook")
        shapes = shapes.map((sh) =>
          sh.kind === "lane"
            ? {
                ...sh,
                endX:
                  sh.x +
                  Math.round(
                    (sh.endX - sh.x) *
                      (activeTick < 24
                        ? (activeTick + 1) / 24
                        : (48 - activeTick) / 24),
                  ),
                endY:
                  sh.y +
                  Math.round(
                    (sh.endY - sh.y) *
                      (activeTick < 24
                        ? (activeTick + 1) / 24
                        : (48 - activeTick) / 24),
                  ),
              }
            : sh,
        );
      if (
        shapes.some((sh) => guardianShapeContains(sh, p.x, p.y, 7 * F)) &&
        claimActionHit(a, p.id)
      ) {
        const damaged = guardianDamagePlayer(s, p, a.id);
        if (
          a.kind === "hook" &&
          damaged &&
          g.athletes[p.id].status === "active"
        ) {
          const v = headingVector(
            aimHeading(g.descriptor.x - p.x, g.descriptor.y - p.y),
          );
          // Sweep the displacement itself: endpoint projection could pull an
          // athlete through a pillar and exceed the promised twenty units.
          const dx = Math.round((v.x * 20 * F) / 65536),
            dy = Math.round((v.y * 20 * F) / 65536);
          let fraction = 1;
          for (const c of [
            ...g.cover.filter((c) => c.hp > 0),
            { ...g.descriptor, radius: g.descriptor.bodyRadius },
          ]) {
            const t = sweepCircle(p.x, p.y, dx, dy, c.x, c.y, c.radius + 7 * F);
            if (t !== null)
              fraction = Math.min(fraction, Math.max(0, t - 1 / 65536));
          }
          for (const [pos, delta, limit] of [
            [p.x, dx, 159 * F],
            [p.y, dy, 89 * F],
          ])
            if (delta)
              fraction = Math.min(
                fraction,
                clamp(((delta > 0 ? limit : -limit) - pos) / delta, 0, 1),
              );
          p.x += Math.round(dx * fraction);
          p.y += Math.round(dy * fraction);
        }
      }
    }
    if (
      (a.kind === "shot" || a.kind === "fan") &&
      a.released &&
      !g.projectiles.length
    )
      a.elapsed = a.timing.tell + a.timing.active - 1;
  }
  a.elapsed++;
  if (actionPhase(a).phase === "done") {
    g.attack = null;
    g.nextAttack = s.tick + 6;
  }
}
