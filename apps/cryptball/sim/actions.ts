import {
  admitSpecial,
  playerSpecial,
  specialKind,
  specialOwnsAction,
  specialVelocity,
  specialBurst,
  sidestepResists,
  stopSpecial,
  specialSuccess,
} from "./specials";
import { groundBallPhysics, groundContactReach } from "./sports-spec";
import { COURT, TUNING, matchConfig, type MatchConfig } from "./spec";
import { length } from "./rules";
import {
  actionPhase,
  claimActionHit,
} from "@onepage/game-simulation/action-timeline";
import type { Player, State, CommandFrame, CommandOrigin } from "./contract";
import { clearLane } from "./prediction";
import {
  RULES,
  FIXED as F,
  headingVector,
  aimHeading,
  normalized,
} from "./rules";
export function event(
  s: State,
  type: string,
  p?: Player,
  extra: Record<string, unknown> = {},
) {
  const origin =
    (extra.origin as CommandOrigin | undefined) ??
    ([
      "strike",
      "pass",
      "whiff",
      "clash",
      "volley-contact",
      "puck-contact",
    ].includes(type)
      ? (p?.action?.origin ??
        (type === "whiff"
          ? s.hockey?.skaters[p?.id ?? ""]?.check?.origin
          : undefined))
      : type === "check"
        ? (s.hockey?.skaters[p?.id ?? ""]?.check?.origin ?? p?.motionOrigin)
        : type === "slide-recover" || type === "slide-contact"
          ? p?.motionOrigin
          : undefined);
  s.events.push({
    type,
    tick: s.tick,
    epoch: s.epoch,
    counter: s.nextEvent++,
    ...(p ? { playerId: p.id, team: p.team, x: p.x, y: p.y } : {}),
    ...extra,
    ...(origin
      ? {
          origin: {
            ...origin,
            eventKind: type,
            ordinal:
              type === "check" && typeof extra.targetId === "string"
                ? Number(extra.targetId.slice(7)) + 1
                : 0,
          },
        }
      : {}),
  });
}
export function selectPassTarget(s: State, p: Player, heading = p.heading) {
  const v = headingVector(heading);
  const mates = s.players.filter((q) => q.team === p.team && q.id !== p.id);
  const ranked = mates.map((q) => {
    const dx = q.x - p.x,
      dy = q.y - p.y,
      d = length(dx, dy);
    const alignment = d ? (dx * v.x + dy * v.y) / d : 65536;
    return {
      q,
      d,
      alignment,
      clear: clearLane(
        p,
        q,
        s.players,
        [p.id, q.id],
        groundBallPhysics(s.sportId),
      ),
    };
  });
  const cone = ranked.filter((q) => q.alignment >= 32768);
  return (
    cone.length
      ? cone.sort(
          (a, b) =>
            b.alignment +
              (b.clear ? 16384 : 0) -
              b.d / 8 -
              (a.alignment + (a.clear ? 16384 : 0) - a.d / 8) ||
            (a.q.id < b.q.id ? -1 : a.q.id > b.q.id ? 1 : 0),
        )
      : ranked.sort(
          (a, b) =>
            a.d - b.d || (a.q.id < b.q.id ? -1 : a.q.id > b.q.id ? 1 : 0),
        )
  )[0]?.q;
}
function swing(
  s: State,
  p: Player,
  kind: "strike" | "pass",
  charge: number,
  origin?: CommandOrigin,
) {
  // A quick press stays an ordinary uncharged shot, including recognized touch holds.
  if (specialKind(s, p) === "hornets" && charge <= 6) charge = 0;
  const target = selectPassTarget(s, p);
  if (kind === "pass" && target) {
    p.heading = aimHeading(
      Math.max(
        -(COURT.halfLength - 7) * F,
        Math.min(
          (COURT.halfLength - 7) * F,
          target.x +
            Math.max(
              -24 * F,
              Math.min(
                24 * F,
                target.vx *
                  Math.min(
                    0.2,
                    length(target.x - p.x, target.y - p.y) / RULES.passSpeed,
                  ),
              ),
            ),
        ),
      ) - p.x,
      Math.max(
        -(COURT.halfWidth - 7) * F,
        Math.min(
          (COURT.halfWidth - 7) * F,
          target.y +
            Math.max(
              -24 * F,
              Math.min(
                24 * F,
                target.vy *
                  Math.min(
                    0.2,
                    length(target.x - p.x, target.y - p.y) / RULES.passSpeed,
                  ),
              ),
            ),
        ),
      ) - p.y,
    );
    event(s, "pass-target", target);
  }
  p.action = {
    ...(origin ? { origin: { ...origin } } : {}),
    id: s.nextAction++,
    elapsed: 0,
    timing: {
      tell: kind === "pass" ? 3 : charge > 0 ? 6 : 4,
      active: kind === "pass" ? 2 : 3,
      recover:
        kind === "pass"
          ? 6
          : charge >= RULES.chargeCap
            ? 16
            : charge > 0
              ? 12
              : 9,
    },
    hits: [],
    heading: p.heading,
    kind,
    charge,
    targetId: kind === "pass" ? target?.id : undefined,
  };
  if (specialKind(s, p) === "hornets") {
    if (!charge) p.action.timing.tell = 2;
    p.action.timing.recover = Math.max(
      1,
      Math.ceil(p.action.timing.recover / 2),
    );
    event(s, "special-release", p, {
      origin,
      kind: "hornets",
      action: kind,
      heading: p.heading,
    });
    s.specials[p.team].active = null;
  }
  p.charging = false;
  p.chargeTicks = 0;
  event(s, "swing", p, { kind, charge, origin });
}
export function admitAction(s: State, p: Player, c: CommandFrame) {
  admitSpecial(s, p, c);
  if (playerSpecial(s, p) && (c.cancel || p.staggerTicks))
    s.specials[p.team].active = null;
  const special = playerSpecial(s, p);
  if (
    special &&
    s.teamIds[p.team] === "bats" &&
    !specialOwnsAction(s, p) &&
    (c.pass || c.strikePressed || c.strikeReleased)
  )
    s.specials[p.team].active = null;
  if (specialOwnsAction(s, p)) return;
  if (c.cancel) {
    if (p.slideTicks) p.slideRecovery = TUNING.slideRecovery;
    p.slideTicks = 0;
    p.charging = false;
    p.chargeTicks = 0;
    p.buffer = null;
    return;
  }
  if (c.aim !== undefined && !p.action && !p.dashTicks && !p.slideTicks) {
    const heading = ((Math.round(c.aim) % 256) + 256) % 256;
    p.heading = heading;
  }
  if (p.staggerTicks) {
    p.charging = false;
    p.chargeTicks = 0;
    return;
  }
  if (
    c.dash &&
    !p.dashCooldown &&
    !p.action &&
    !p.slideTicks &&
    !p.slideRecovery &&
    s.tick >= p.actionReady
  ) {
    p.charging = false;
    p.chargeTicks = 0;
    p.actionReady = s.tick + TUNING.actionLockout;
    p.dashTicks = RULES.dashTicks;
    p.dashCooldown = RULES.dashReuse;
    p.dashHeading = p.heading;
    p.checked = false;
    p.buffer = null;
    p.motionOrigin = c.origin ? { ...c.origin } : undefined;
    event(s, "dash", p, { origin: c.origin });
    return;
  }
  if (c.dash) return;
  if (
    (c.slide || c.guard) &&
    !p.action &&
    !p.dashTicks &&
    !p.slideTicks &&
    !p.slideRecovery &&
    s.tick >= p.slideReady &&
    s.tick >= p.actionReady
  ) {
    const moving = c.moveX || c.moveY;
    let heading =
      c.pointerAim && c.aim !== undefined
        ? ((Math.round(c.aim) % 256) + 256) % 256
        : moving
          ? aimHeading(c.moveX ?? 0, c.moveY ?? 0)
          : p.heading;
    if (p.role === "keeper" && !c.pointerAim)
      heading = (c.moveY ?? 0) < 0 || (!moving && s.ball.y < p.y) ? 192 : 64;
    p.slideBallHit = false;
    p.slideHeading = heading;
    p.heading = p.slideHeading;
    p.slideTicks = p.role === "keeper" ? TUNING.diveTicks : TUNING.slideTicks;
    p.slideReady = s.tick + TUNING.slideReuse;
    p.actionReady = s.tick + TUNING.actionLockout;
    p.charging = false;
    p.chargeTicks = 0;
    p.buffer = null;
    p.checked = false;
    p.motionOrigin = c.origin ? { ...c.origin } : undefined;
    event(s, p.role === "keeper" ? "keeper-dive" : "slide", p, {
      origin: c.origin,
    });
    return;
  }
  if (p.slideTicks || p.slideRecovery) return;
  if (c.pass) {
    if (c.aim === undefined && (c.moveX || c.moveY))
      p.heading = aimHeading(c.moveX ?? 0, c.moveY ?? 0);
    if (!p.action && !p.dashTicks) swing(s, p, "pass", 0, c.origin);
    else
      p.buffer = {
        kind: "pass",
        charge: 0,
        until: s.tick + 6,
        ...(c.origin ? { origin: { ...c.origin } } : {}),
      };
    return;
  }
  if (c.strikePressed && !p.action && !p.dashTicks) {
    p.chargeOrigin = c.origin ? { ...c.origin } : undefined;
    p.charging = true;
    p.chargeTicks = 0;
  }
  if (p.charging) {
    if (c.strikeHeld && p.chargeTicks < RULES.chargeCap) {
      p.chargeTicks++;
      if (p.chargeTicks === RULES.chargeCap)
        event(s, "charge-ready", p, { origin: p.chargeOrigin });
    }
    if (c.strikeReleased || !c.strikeHeld) {
      if (
        s.controllers.some((q) => q.active && q.playerId === p.id) &&
        !c.pointerAim
      ) {
        const goal = {
            x: (p.team === 0 ? COURT.goalLine : -COURT.goalLine) * F,
            y: 0,
          },
          h = aimHeading(goal.x - p.x, goal.y - p.y),
          difference = Math.abs(((h - p.heading + 384) % 256) - 128);
        if (
          difference <= 8 &&
          clearLane(
            s.ball,
            goal,
            s.players,
            [p.id],
            groundBallPhysics(s.sportId),
          )
        )
          p.heading = h;
      }
      swing(
        s,
        p,
        "strike",
        Math.min(RULES.chargeCap, p.chargeTicks),
        c.origin ?? p.chargeOrigin,
      );
    }
  } else if (c.strikeReleased && p.action)
    p.buffer = {
      kind: "strike",
      charge: 0,
      until: s.tick + 6,
      ...(c.origin ? { origin: { ...c.origin } } : {}),
    };
  if (p.buffer) {
    if (p.buffer.until < s.tick) p.buffer = null;
    else if (!p.action && !p.dashTicks) {
      swing(s, p, p.buffer.kind, p.buffer.charge, p.buffer.origin);
      p.buffer = null;
    }
  }
}
export function resolveStrikes(s: State) {
  const b = s.ball;
  const candidates = s.players
    .filter(
      (p) =>
        p.action &&
        actionPhase(p.action).phase === "active" &&
        !p.action.hits.includes("ball"),
    )
    .filter((p) => {
      const dx = b.x - p.x,
        dy = b.y - p.y,
        d = length(dx, dy),
        v = headingVector(p.action!.heading ?? p.heading);
      return (
        d <= groundContactReach(s.sportId, RULES.reach) &&
        (d === 0 || (dx * v.x + dy * v.y) / (d * 65536) >= 0.64279)
      );
    })
    .sort(
      (a, b) =>
        length(a.x - s.ball.x, a.y - s.ball.y) -
          length(b.x - s.ball.x, b.y - s.ball.y) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  if (!candidates.length) return;
  const p = candidates[0],
    a = p.action!,
    other = candidates[1];
  if (
    other &&
    other.team !== p.team &&
    Math.abs(
      length(p.x - b.x, p.y - b.y) - length(other.x - b.x, other.y - b.y),
    ) <= 1
  ) {
    claimActionHit(a, "ball");
    claimActionHit(other.action!, "ball");
    const n = normalized(p.x - other.x, p.y - other.y),
      dot = b.vx * n.x + b.vy * n.y;
    b.vx = Math.round(b.vx - dot * n.x);
    b.vy = Math.round(b.vy - dot * n.y);
    event(s, "clash", p);
    return;
  }
  if (!claimActionHit(a, "ball")) return;
  const v = headingVector(a.heading ?? p.heading),
    speed =
      a.kind === "pass"
        ? RULES.passSpeed
        : RULES.shotSpeed +
          Math.round(
            ((RULES.maxBallSpeed - RULES.shotSpeed) * (a.charge ?? 0)) /
              RULES.chargeCap,
          );
  b.vx = Math.round((v.x * speed) / 65536);
  b.vy = Math.round((v.y * speed) / 65536);
  b.rx = b.ry = 0;
  if (b.passFrom && b.passTarget === p.id) {
    const from = s.players.find((q) => q.id === b.passFrom);
    if (from) recordStat(s, from, "passes");
    event(s, "pass-complete", p, { passerId: b.passFrom });
  }
  b.lastTouch = p.id;
  b.passFrom = a.kind === "pass" ? p.id : null;
  b.passTarget = a.kind === "pass" ? (a.targetId ?? null) : null;
  s.touchTick = s.tick;
  s.restartProtection = 0;
  b.passTeam = a.kind === "pass" ? p.team : null;
  b.passTick = s.tick;
  b.bankBonusRemaining =
    a.kind === "strike" && (a.charge ?? 0) >= RULES.chargeCap ? 1 : 0;
  b.powerTeam = b.bankBonusRemaining ? p.team : null;
  b.powerActionKey = b.bankBonusRemaining ? a.id : null;
  b.powerExpires = s.tick + 60;
  if (a.kind === "pass" && a.targetId) {
    const controller = s.controllers.find(
      (c) => c.playerId === p.id && c.active && c.canSwitch,
    );
    if (
      controller &&
      s.players.find((q) => q.id === a.targetId)?.role !== "keeper" &&
      !s.controllers.some((c) => c.playerId === a.targetId)
    )
      controller.pendingSwitch = a.targetId;
  }
  if (a.kind === "strike") recordStat(s, p, "shots");
  event(s, a.kind, p, { charge: a.charge ?? 0, heading: a.heading });
}
export function recordStat(
  s: State,
  p: Player,
  key: "shots" | "passes" | "goals",
) {
  s.teamStats[p.team][key]++;
  s.stats = s.teamStats[0];
  const controller = s.controllers.find((c) => c.playerId === p.id);
  if (controller && s.participantStats[controller.id])
    s.participantStats[controller.id][key]++;
}
export function resolveChecks(
  s: State,
  paths: import("./motion").Trajectory[] = [],
) {
  const sweptDistance = (p: Player, q: Player) => {
    const a = paths.find((path) => path.player === p),
      b = paths.find((path) => path.player === q);
    if (!a || !b) return length(p.x - q.x, p.y - q.y);
    const x = a.x - b.x,
      y = a.y - b.y,
      dx = a.dx - b.dx,
      dy = a.dy - b.dy;
    const squared = dx * dx + dy * dy;
    const t = squared
      ? Math.max(0, Math.min(1, -(x * dx + y * dy) / squared))
      : 0;
    return length(x + dx * t, y + dy * t);
  };
  for (const p of s.players) {
    const charge = specialKind(s, p) === "rams" && specialBurst(s, p);
    if ((!p.dashTicks && !p.slideTicks && !charge) || p.checked) continue;
    for (const q of s.players) {
      if (
        q.team === p.team ||
        q.immunityTicks ||
        sidestepResists(s, q) ||
        sweptDistance(p, q) > 2 * RULES.playerRadius + F
      )
        continue;
      p.checked = true;
      if (q.slideTicks) q.slideRecovery = TUNING.slideRecovery;
      q.slideTicks = 0;
      q.staggerTicks = RULES.staggerTicks;
      q.immunityTicks = RULES.immunityTicks;
      q.charging = false;
      q.chargeTicks = 0;
      q.buffer = null;
      if (q.action && actionPhase(q.action).phase === "tell") q.action = null;
      const v = headingVector(p.slideTicks ? p.slideHeading : p.dashHeading);
      const displacement = charge ? 72 : 48;
      q.vx += Math.round((v.x * displacement * F) / 65536);
      q.vy += Math.round((v.y * displacement * F) / 65536);
      if (charge) {
        specialSuccess(s, p, "body");
        stopSpecial(s, p);
      }
      event(s, "check", p, { targetId: q.id });
      break;
    }
  }
}
export function finishActions(s: State) {
  for (const p of s.players) {
    if (p.action) {
      p.action.elapsed++;
      if (actionPhase(p.action).phase === "done") {
        if (!p.action.hits.length)
          event(s, "whiff", p, { kind: p.action.kind });
        p.action = null;
      }
    }
    if (p.slideTicks) {
      p.slideTicks--;
      if (!p.slideTicks) {
        p.slideRecovery = TUNING.slideRecovery + 1;
        event(s, "slide-recover", p);
      }
    }
    p.slideRecovery = Math.max(0, p.slideRecovery - 1);
    p.dashTicks = Math.max(0, p.dashTicks - 1);
    p.dashCooldown = Math.max(0, p.dashCooldown - 1);
    p.staggerTicks = Math.max(0, p.staggerTicks - 1);
    p.immunityTicks = Math.max(0, p.immunityTicks - 1);
  }
}
export function steer(
  p: Player,
  c: CommandFrame,
  config: MatchConfig = matchConfig(),
  state?: State,
) {
  if (specialVelocity(state, p, c)) return;
  let n = normalized(c.moveX ?? 0, c.moveY ?? 0),
    speed = RULES.runSpeed;
  if (p.staggerTicks) speed *= 0.35;
  else if (
    p.action &&
    !(playerSpecial(state, p) && state?.teamIds[p.team] === "owls")
  )
    speed *= 0.75;
  else if (
    p.charging &&
    !(playerSpecial(state, p) && state?.teamIds[p.team] === "owls")
  )
    speed *= p.chargeTicks >= RULES.chargeCap ? 0.45 : 0.65;
  else if (p.dashCooldown > 50 && p.dashCooldown <= 56) speed *= 0.75;
  if (p.slideTicks) {
    const d = headingVector(p.slideHeading),
      duration =
        specialKind(state, p) === "gators"
          ? 24
          : p.role === "keeper"
            ? TUNING.diveTicks
            : TUNING.slideTicks;
    speed =
      (config.slideEndSpeed +
        Math.round(
          ((config.slideLaunchSpeed - config.slideEndSpeed) * p.slideTicks) /
            duration,
        )) *
      F;
    p.vx = Math.round((d.x * speed) / 65536);
    p.vy = Math.round((d.y * speed) / 65536);
    return;
  }
  if (p.slideRecovery) speed *= 0.3;
  if (p.role === "keeper") {
    n = { x: n.x * 0.8, y: n.y * 1.1 };
  }
  if (p.dashTicks) {
    const d = headingVector(p.dashHeading);
    n = { x: d.x / 65536, y: d.y / 65536 };
    speed = RULES.dashSpeed;
    p.vx = Math.round(n.x * speed);
    p.vy = Math.round(n.y * speed);
    return;
  }
  const target = { x: Math.round(n.x * speed), y: Math.round(n.y * speed) },
    delta = normalized(target.x - p.vx, target.y - p.vy),
    amount =
      RULES.runSpeed /
      (playerSpecial(state, p) &&
      state?.teamIds[p.team] === "owls" &&
      (p.charging || p.action) &&
      !p.staggerTicks &&
      !p.slideRecovery
        ? 3
        : n.x || n.y
          ? 6
          : 4),
    distance = length(target.x - p.vx, target.y - p.vy);
  p.vx = Math.round(p.vx + delta.x * Math.min(amount, distance));
  p.vy = Math.round(p.vy + delta.y * Math.min(amount, distance));
  if (c.aim === undefined && !p.action && !p.charging && (n.x || n.y))
    p.heading = aimHeading(n.x, n.y);
}
