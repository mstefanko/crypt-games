import {
  actionPhase,
  claimActionHit,
} from "@onepage/game-simulation/action-timeline";
import { advanceFixedAxis } from "@onepage/game-simulation/fixed-flight";
import { DamageOwner } from "@onepage/game-simulation/damage-owner";
import { event, recordStat } from "../../actions";
import type { State, Player } from "../../contract";
import {
  FIXED as F,
  RULES,
  aimHeading,
  headingVector,
  length,
} from "../../rules";
import { clamp, distance, sweepCircle } from "./spec";
import { guardianIsGuarding } from "./boss";
import { guardianLineClear, guardianDamagePlayer } from "./damage";
const orbKeys = [
  "ballToken",
  "ballInside",
  "ballStuckTicks",
  "ballResetTicks",
  "deflectUntil",
  "hostileUntil",
  "reboundCount",
] as const;
export function guardianHeldOrb(
  s: Pick<State, "players" | "guardian" | "possessionId">,
  id: string,
) {
  if (s.possessionId === id)
    return s.guardian!.orbs.find((o) => o.id === s.guardian!.activeOrbId);
  return s.guardian!.orbs.find(
    (o) => o.id !== s.guardian!.activeOrbId && o.possessionId === id,
  );
}
export function withGuardianOrb(
  s: State,
  orb: import("./types").GuardianOrb,
  run: () => void,
) {
  const g = s.guardian!;
  const previous = g.orbs.find((o) => o.id === g.activeOrbId)!;
  previous.ball = s.ball;
  previous.possessionId = s.possessionId;
  for (const key of orbKeys) Object.assign(previous, { [key]: g[key] });
  const load = (o: import("./types").GuardianOrb) => {
    s.ball = o.ball;
    s.possessionId = o.possessionId;
    g.activeOrbId = o.id;
    for (const key of orbKeys) Object.assign(g, { [key]: o[key] });
  };
  load(orb);
  try {
    run();
  } finally {
    orb.ball = s.ball;
    orb.possessionId = s.possessionId;
    for (const key of orbKeys) Object.assign(orb, { [key]: g[key] });
    load(previous);
  }
}
export function guardianPassTarget(
  s: Pick<State, "players" | "guardian" | "possessionId">,
  p: Player,
  heading = p.heading,
) {
  const v = headingVector(heading);
  return s.players
    .filter(
      (q) =>
        q.id !== p.id &&
        !guardianHeldOrb(s, q.id) &&
        s.guardian!.athletes[q.id].status === "active" &&
        guardianLineClear(s, p, q),
    )
    .sort((a, b) => {
      const rank = (q: Player) => {
        const dx = q.x - p.x,
          dy = q.y - p.y,
          d = length(dx, dy) || 1;
        return (dx * v.x + dy * v.y) / d - d / 8;
      };
      return rank(b) - rank(a) || (a.id < b.id ? -1 : 1);
    })[0];
}
export function guardianBallContact(s: State, p: Player, dive = false) {
  const g = s.guardian!,
    b = s.ball,
    a = p.action;
  if (dive || s.possessionId !== p.id) return false;
  if (
    !dive &&
    (!a || actionPhase(a).phase !== "active" || a.hits.includes("ball"))
  )
    return false;
  if (dive && (p.slideBallHit || !p.slideTicks)) return false;
  const heading = dive ? p.slideHeading : (a!.heading ?? p.heading),
    dx = b.x - p.x,
    dy = b.y - p.y,
    d = length(dx, dy);
  if (d > (dive ? 23 : 19) * F || b.z > 18 * F) return false;
  if (!guardianLineClear(s, p, b)) return false;
  if (dive) p.slideBallHit = true;
  else if (!claimActionHit(a!, "ball")) return false;
  const pass = !dive && a!.kind === "pass",
    target = pass ? guardianPassTarget(s, p, heading) : undefined;
  if (pass && !target) return false;
  const assisted =
    b.passTarget === p.id &&
    b.passFrom !== p.id &&
    b.passFrom !== null &&
    s.tick - b.passTick <= 48;
  if (assisted) {
    g.athletes[p.id].assistUntil = s.tick + 48;
    g.athletes[p.id].assistFrom = b.passFrom;
    const from = s.players.find((q) => q.id === b.passFrom);
    if (from) recordStat(s, from, "passes");
    event(s, "pass-complete", p, { passerId: b.passFrom });
  }
  const bossHeading = aimHeading(
    g.descriptor.x - b.x,
    g.descriptor.y - b.y,
  );
  const assistAim = Math.abs(((bossHeading - heading + 384) % 256) - 128) <= 26;
  const h = target
      ? aimHeading(target.x - b.x, target.y - b.y)
      : assistAim
        ? bossHeading
        : heading,
    dir = headingVector(h),
    charge =
      g.athletes[p.id].assistUntil >= s.tick && g.athletes[p.id].assistFrom
        ? RULES.chargeCap
        : dive
          ? 0
          : (a!.charge ?? 0);
  const speed = pass
    ? 210 * F
    : 250 * F + Math.round((130 * F * charge) / RULES.chargeCap);
  s.possessionId = null;
  b.vx = Math.round((dir.x * speed) / 65536);
  b.vy = Math.round((dir.y * speed) / 65536);
  b.rx = b.ry = 0;
  b.lastTouch = p.id;
  s.touchTick = s.tick;
  b.passFrom = pass ? p.id : null;
  b.passTarget = target?.id ?? null;
  b.passTeam = pass ? p.team : null;
  b.passTick = s.tick;
  if (pass) {
    g.ballToken = null;
    event(s, "guardian-pass", p, {
      ballId: g.activeOrbId,
      actionId: a?.id,
      heading: h,
      origin: a?.origin,
      targetId: target?.id,
    });
  } else {
    const ally = g.athletes[p.id],
      assist = ally.assistUntil >= s.tick && ally.assistFrom !== null;
    // A new attack token is admitted only after leaving the boss hurt volume.
    g.ballToken = g.ballInside
      ? null
      : {
          id: dive ? s.nextAction++ : a!.id,
          playerId: p.id,
          damage: (charge >= RULES.chargeCap ? 12 : 8) + (assist ? 4 : 0),
          ...((dive ? p.motionOrigin : a?.origin)
            ? { origin: { ...(dive ? p.motionOrigin : a?.origin)! } }
            : {}),
        };
    ally.assistUntil = 0;
    ally.assistFrom = null;
    recordStat(s, p, "shots");
    event(s, "guardian-throw", p, {
      ballId: g.activeOrbId,
      actionId: a?.id,
      empowered: charge >= RULES.chargeCap,
      charge,
      heading: h,
      origin: dive ? p.motionOrigin : a?.origin,
    });
  }
  return true;
}
function reflect(s: State, nx: number, ny: number) {
  const b = s.ball,
    dot = b.vx * nx + b.vy * ny;
  b.vx = Math.round((b.vx - 2 * dot * nx) * 0.8);
  b.vy = Math.round((b.vy - 2 * dot * ny) * 0.8);
  b.rx = b.ry = 0;
}
export function moveGuardianBall(s: State) {
  const b = s.ball,
    g = s.guardian!,
    d = g.descriptor,
    r = 3 * F;
  if (s.possessionId) {
    const p = s.players.find((p) => p.id === s.possessionId)!;
    if (g.athletes[p.id].status !== "active") s.possessionId = null;
    else {
      const v = headingVector(p.heading);
      b.x = clamp(p.x + Math.round((v.x * 9 * F) / 65536), -163 * F, 163 * F);
      b.y = clamp(p.y + Math.round((v.y * 9 * F) / 65536), -93 * F, 93 * F);
      b.vx = b.vy = b.rx = b.ry = 0;
      return;
    }
  }
  if (g.deflectUntil > s.tick) return;
  if (g.deflectUntil && g.deflectUntil <= s.tick) {
    g.deflectUntil = 0;
    g.hostileUntil = s.tick + 100;
    const target = s.players.find((p) => p.id === b.lastTouch) ?? s.players[0];
    const v = headingVector(aimHeading(target.x - b.x, target.y - b.y));
    b.vx = Math.round((v.x * 125 * F) / 65536);
    b.vy = Math.round((v.y * 125 * F) / 65536);
    event(s, "guardian-deflect", undefined, {
      ballId: g.activeOrbId,
      targetId: target.id,
    });
  }
  const sx = advanceFixedAxis(b.vx, b.rx, 240),
    sy = advanceFixedAxis(b.vy, b.ry, 240),
    dx = sx.delta,
    dy = sy.delta;
  b.rx = sx.remainder;
  b.ry = sy.remainder;
  const hits: {
    t: number;
    kind: "wall" | "cover" | "boss" | "receive";
    id: string;
    nx?: number;
    ny?: number;
  }[] = [];
  for (const [pos, delta, limit, axis] of [
    [b.x, dx, 166 * F - r, 0],
    [b.y, dy, 96 * F - r, 1],
  ])
    if (delta && Math.abs(pos + delta) >= limit)
      hits.push({
        t: clamp(((delta > 0 ? limit : -limit) - pos) / delta, 0, 1),
        kind: "wall",
        id: "wall",
        nx: axis === 0 ? (delta > 0 ? -1 : 1) : 0,
        ny: axis === 1 ? (delta > 0 ? -1 : 1) : 0,
      });
  for (const c of g.cover)
    if (c.hp) {
      const t = sweepCircle(b.x, b.y, dx, dy, c.x, c.y, c.radius + r);
      if (t !== null) hits.push({ t, kind: "cover", id: c.id });
    }
  const hurt = { x: d.x, y: d.y },
    t = sweepCircle(b.x, b.y, dx, dy, hurt.x, hurt.y, d.hurtRadius + r);
  if (t !== null) hits.push({ t, kind: "boss", id: "boss" });
  for (const p of s.players) {
    if (
      g.athletes[p.id].status !== "active" ||
      (guardianHeldOrb(s, p.id) && g.hostileUntil <= s.tick) ||
      (g.hostileUntil > s.tick &&
        (p.dashTicks || (p.slideTicks && guardianHeldOrb(s, p.id)))) ||
      (b.lastTouch === p.id && s.tick - b.passTick < 12) ||
      g.ballToken
    )
      continue;
    const t = sweepCircle(b.x, b.y, dx, dy, p.x, p.y, 12 * F);
    if (t !== null && guardianLineClear(s, b, p))
      hits.push({ t, kind: "receive", id: p.id });
  }
  hits.sort(
    (a, b) =>
      a.t - b.t ||
      (a.kind === "cover"
        ? 0
        : a.kind === "wall"
          ? 1
          : a.kind === "boss"
            ? 2
            : 3) -
        (b.kind === "cover"
          ? 0
          : b.kind === "wall"
            ? 1
            : b.kind === "boss"
              ? 2
              : 3) ||
      (a.id < b.id ? -1 : 1),
  );
  const hit = hits[0];
  if (!hit) {
    b.x += dx;
    b.y += dy;
  } else {
    b.x += Math.round(dx * hit.t);
    b.y += Math.round(dy * hit.t);
    if (hit.kind === "receive") {
      const p = s.players.find((p) => p.id === hit.id)!,
        athlete = g.athletes[p.id];
      if (
        g.hostileUntil > s.tick &&
        (guardianHeldOrb(s, p.id) ||
          (!p.slideTicks && athlete.catchUntil <= s.tick))
      ) {
        guardianDamagePlayer(s, p, s.nextAction++);
        g.hostileUntil = 0;
        b.lastTouch = p.id;
        b.passTick = s.tick;
      } else {
        if (b.passFrom && b.passFrom !== p.id) {
          athlete.assistUntil = s.tick + 48;
          athlete.assistFrom = b.passFrom;
          const from = s.players.find((q) => q.id === b.passFrom);
          if (from) recordStat(s, from, "passes");
          event(s, "pass-complete", p, { passerId: b.passFrom });
        }
        s.possessionId = p.id;
        athlete.catchUntil = 0;
        g.hostileUntil = 0;
        event(s, "guardian-catch", p, { ballId: g.activeOrbId });
      }
      b.vx = b.vy = b.rx = b.ry = 0;
      b.passFrom = b.passTarget = null;
      b.passTeam = null;
    } else if (hit.kind === "boss") {
      if (g.ballToken && !g.ballInside && g.hp > 0) {
        const token = g.ballToken,
          recovery =
            s.tick < g.staggerUntil ||
            (g.attack && actionPhase(g.attack).phase === "recover"),
          damage = Math.floor(token.damage * (recovery ? 1.5 : 1));
        const owner = new DamageOwner([{ id: "boss", hp: g.hp, maxHp: 300 }]);
        const incoming = aimHeading(b.x - hurt.x, b.y - hurt.y);
        const frontal =
          Math.abs(((incoming - g.guardHeading + 384) % 256) - 128) <= 34;
        const guarding = guardianIsGuarding(s);
        const blocked = frontal && guarding && s.tick >= g.staggerUntil;
        if (blocked) {
          g.guard = Math.max(
            0,
            g.guard - (token.damage >= 16 ? 40 : token.damage >= 12 ? 28 : 18),
          );
          event(s, "guardian-block", undefined, {
            ballId: g.activeOrbId,
            x: b.x, y: b.y,
            guard: g.guard,
            heading: g.guardHeading,
          });
          if (!g.guard) {
            g.staggerUntil = s.tick + 120;
            g.attack = null;
            g.projectiles = [];
            event(s, "guardian-stagger");
          }
        } else owner.damage("boss", damage);
        g.hp = owner.get("boss").hp;
        event(
          s,
          "guardian-hit",
          s.players.find((p) => p.id === token.playerId),
          {
            ballId: g.activeOrbId,
            x: b.x, y: b.y,
            damage: blocked ? 0 : damage,
            hp: g.hp,
            tokenId: token.id,
            recovery: !!recovery,
            origin: token.origin,
          },
        );
      }
      g.ballToken = null;
      g.ballInside = true;
      // Bounded authored open returns stay below the body and between pillars.
      g.reboundCount++;
      const h = [42, 54, 64, 74, 86][g.reboundCount % 5],
        v = headingVector(h);
      // Keep the visible point of contact; the return travels from the body.
      const normal = distance(b, hurt) || 1;
      b.x = hurt.x + Math.round((b.x - hurt.x) * (d.hurtRadius + r + 1) / normal);
      b.y = hurt.y + Math.round((b.y - hurt.y) * (d.hurtRadius + r + 1) / normal);
      const outward = v.x * (b.x - hurt.x) + v.y * (b.y - hurt.y) > 0;
      b.vx = outward ? Math.round((v.x * 150 * F) / 65536) : Math.round((b.x-hurt.x)*150*F/(d.hurtRadius+r+1));
      b.vy = outward ? Math.round((v.y * 150 * F) / 65536) : Math.round((b.y-hurt.y)*150*F/(d.hurtRadius+r+1));
      b.rx = b.ry = 0;
      if (g.reboundCount % 4 === 0) {
        g.deflectUntil = s.tick + 36;
        b.vx = b.vy = 0;
        event(s, "guardian-deflect-tell", undefined, {
          ballId: g.activeOrbId,
          until: g.deflectUntil,
        });
      }
    } else if (hit.kind === "cover") {
      const c = g.cover.find((c) => c.id === hit.id)!,
        n = distance(c, b) || 1,
        nx = (b.x - c.x) / n,
        ny = (b.y - c.y) / n;
      b.x = c.x + Math.round(nx * (c.radius + r + 1));
      b.y = c.y + Math.round(ny * (c.radius + r + 1));
      reflect(s, nx, ny);
    } else {
      reflect(s, hit.nx!, hit.ny!);
      b.x = clamp(b.x, -163 * F + 1, 163 * F - 1);
      b.y = clamp(b.y, -93 * F + 1, 93 * F - 1);
    }
  }
  if (distance(b, hurt) > d.hurtRadius + r + F) g.ballInside = false;
}
export function finishGuardianBall(s: State) {
  const g = s.guardian!,
    b = s.ball,
    speed = length(b.vx, b.vy),
    drag = (30 * F) / 60;
  if (speed) {
    const next = Math.max(0, speed - drag);
    b.vx = Math.round((b.vx * next) / speed);
    b.vy = Math.round((b.vy * next) / speed);
  }
  if (
    b.passTarget &&
    (s.tick - b.passTick > 90 || g.athletes[b.passTarget].status !== "active")
  ) {
    b.passFrom = b.passTarget = null;
    b.passTeam = null;
  }
  // A missed attack becomes collectible once it loses its flight energy.
  // Otherwise a stopped token blocks pickup forever while a player is nearby.
  if (g.ballToken && speed < 8 * F) g.ballToken = null;
  if (s.possessionId) {
    g.ballStuckTicks = 0;
    return;
  }
  const inaccessible =
    b.y < -42 * F ||
    g.cover.some((c) => c.hp && distance(c, b) < c.radius + 3 * F) ||
    (!s.players.some(
      (p) => g.athletes[p.id].status === "active" && distance(p, b) < 36 * F,
    ) &&
      speed < 8 * F);
  g.ballStuckTicks = inaccessible ? g.ballStuckTicks + 1 : 0;
  if (g.ballStuckTicks >= 120 && !g.ballResetTicks) {
    g.ballResetTicks = 30;
    event(s, "guardian-ball-reset-tell", undefined, { x: 0, y: 24 * F });
  }
  if (g.ballResetTicks && !--g.ballResetTicks) {
    b.x = 0;
    b.y = 24 * F;
    b.vx = b.vy = b.rx = b.ry = 0;
    g.ballToken = null;
    g.ballInside = false;
    g.ballStuckTicks = 0;
    event(s, "guardian-ball-reset", undefined, { x: b.x, y: b.y });
  }
}
