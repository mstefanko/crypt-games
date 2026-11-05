import type { State, Player, CommandFrame } from "../../contract";
import { actionPhase } from "@onepage/game-simulation/action-timeline";
import { FIXED as F, RULES, aimHeading } from "../../rules";
import { distance, segmentDistance, clamp } from "./spec";
import { guardianShapeContains } from "./boss";
import { guardianHeldOrb } from "./ball";
import { guardianLineClear } from "./damage";
export function guardianAI(s: State, p: Player): CommandFrame {
  const g = s.guardian!,
    a = g.athletes[p.id],
    b =
      guardianHeldOrb(s, p.id)?.ball ??
      g.orbs
        .filter((o) => !o.possessionId)
        .slice()
        .sort((a, b) => distance(p, a.ball) - distance(p, b.ball))[0]?.ball ??
      s.ball;
  if (a.status !== "active") return {};
  const active = s.players.filter((q) => g.athletes[q.id].status === "active"),
    down = s.players.filter((q) => g.athletes[q.id].status === "down");
  const rescue = down
    .slice()
    .sort(
      (a, b) => distance(p, a) - distance(p, b) || (a.id < b.id ? -1 : 1),
    )[0];
  const rescuer = rescue
    ? active
        .filter(
          (q) =>
            !s.controllers.some((c) => c.active && c.playerId === q.id) &&
            !guardianHeldOrb(s, q.id),
        )
        .slice()
        .sort(
          (a, b) =>
            distance(a, rescue) - distance(b, rescue) || (a.id < b.id ? -1 : 1),
        )[0]
    : null;
  if (rescue && rescuer?.id === p.id) {
    p.aiRole = "rescue";
    p.aiX = rescue.x;
    p.aiY = rescue.y;
    if (distance(p, rescue) <= 17 * F && guardianLineClear(s, p, rescue))
      return {
        passHeld: true,
        aim: aimHeading(rescue.x - p.x, rescue.y - p.y),
      };
  } else if (s.tick >= p.aiNext) {
    const collector = active
      .filter((q) => !guardianHeldOrb(s, q.id))
      .slice()
      .sort(
        (a, c) => distance(a, b) - distance(c, b) || (a.id < c.id ? -1 : 1),
      )[0];
    const slot = Number(p.id.slice(7));
    p.aiRole = collector?.id === p.id ? "collect" : "outlet";
    p.aiX = collector?.id === p.id ? b.x : ([-92, -35, 35, 92][slot] ?? 0) * F;
    p.aiY = collector?.id === p.id ? b.y : (slot % 2 ? 12 : 40) * F;
    p.aiNext = s.tick + 12;
  }
  let tx = p.aiX,
    ty = p.aiY;
  const carrying = !!guardianHeldOrb(s, p.id);
  if (carrying) {
    tx = p.x < 0 ? -78 * F : 78 * F;
    ty = -24 * F;
  }
  const attack = g.attack;
  // Physical weapon intent becomes readable after commitment, then reaction delay.
  if (
    attack &&
    attack.locked &&
    attack.elapsed >=
      (attack.kind === "slam"
        ? 42
        : attack.kind === "double-slam"
          ? 54
          : attack.timing.tell - 20) +
        12 &&
    actionPhase(attack).phase !== "recover" &&
    attack.shapes.some((sh) => guardianShapeContains(sh, p.x, p.y, 11 * F))
  ) {
    const candidates = [
      { x: p.x - 46 * F, y: p.y },
      { x: p.x + 46 * F, y: p.y },
      { x: p.x, y: p.y + 50 * F },
    ].map((q) => ({
      x: clamp(q.x, -148 * F, 148 * F),
      y: clamp(q.y, -36 * F, 82 * F),
    }));
    const safe = candidates.filter(
      (q) =>
        !attack.shapes.some((sh) =>
          guardianShapeContains(sh, q.x, q.y, 10 * F),
        ),
    );
    const q = (safe.length ? safe : candidates).sort(
      (a, b) => distance(a, p) - distance(b, p),
    )[0];
    tx = q.x;
    ty = q.y;
  }
  // An announced pillar, not hidden future AI state, determines the waypoint.
  for (const c of g.cover)
    if (
      c.hp &&
      segmentDistance(c.x, c.y, p.x, p.y, tx, ty) < c.radius + 10 * F &&
      distance(p, c) < 75 * F
    ) {
      tx = c.x + (p.x <= c.x ? -1 : 1) * (c.radius + 17 * F);
      ty = c.y + (ty < c.y ? -1 : 1) * (c.radius + 17 * F);
    }
  const near = carrying,
    aim = aimHeading(g.descriptor.x - b.x, g.descriptor.y - b.y);
  const line = guardianLineClear(s, b, {
    x: g.descriptor.x,
    y: g.descriptor.y,
  });
  const strike =
    near &&
    line &&
    !p.action &&
    !p.slideRecovery &&
    !p.slideTicks &&
    s.tick % 60 === Number(p.id.slice(7)) * 3;
  if (near && !line) {
    tx = clamp(b.x + (b.x < 0 ? 32 : -32) * F, -140 * F, 140 * F);
    ty = b.y + 12 * F;
  }
  // One in four opportunities uses an available allied outlet. Receiving grants
  // an assist; deterministic cadence avoids omniscient perfect aiming.
  const pass = strike && s.tick % 96 < 24 && active.length > 1;
  return {
    moveX: tx - p.x,
    moveY: ty - p.y,
    aim: (aim + ((Number(p.id.slice(7)) % 3) - 1) * 2 + 256) % 256,
    pointerAim: true,
    strikePressed:
      (strike && !pass) ||
      (!carrying &&
        g.orbs.some(
          (o) => o.hostileUntil > s.tick && distance(p, o.ball) < 35 * F,
        ) &&
        s.tick >= g.athletes[p.id].catchReady),
    strikeHeld:
      carrying &&
      (p.charging ? p.chargeTicks < RULES.chargeCap : strike && !pass),
    strikeReleased: carrying && p.charging && p.chargeTicks >= RULES.chargeCap,
    pass,
  };
}
