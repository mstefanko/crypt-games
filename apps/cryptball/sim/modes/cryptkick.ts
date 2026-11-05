import {
  specialBurst,
  specialKind,
  specialBallContact,
  stopSpecial,
  specialSuccess,
} from "../specials";
import {
  groundContactReach,
  groundBallPhysics,
  SPORT_BALL_PROFILES,
} from "../sports-spec";
import type { CommandFrame, Player, State } from "../contract";
import {
  admitAction,
  event,
  finishActions,
  recordStat,
  resolveChecks,
  resolveStrikes,
  steer,
} from "../actions";
import { dragBall, moveBall, touchBall } from "../ball";
import { movePlayers } from "../motion";
import { expireClock, scoreGoal } from "../match";
import { aimHeading, FIXED as F, headingVector, length, RULES } from "../rules";
import { COURT } from "../spec";
import type { DeterministicRandom } from "@onepage/game-simulation/random";

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  length(a.x - b.x, a.y - b.y);
const emitter = (s: State) => (e: import("../contract").CryptballEvent) => {
  if (e.type === "pass-complete" && typeof e.passerId === "string") {
    const p = s.players.find((p) => p.id === e.passerId);
    if (p) recordStat(s, p, "passes");
  }
  s.events.push({ ...e, epoch: s.epoch, counter: s.nextEvent++ });
};

function kickAI(s: State, p: Player, rng: DeterministicRandom): CommandFrame {
  const b = s.ball,
    direction = p.team === 0 ? 1 : -1;
  const carrier = s.players.find((q) => q.id === s.possessionId);
  const mates = s.players.filter((q) => q.team === p.team);
  const nearest = mates
    .slice()
    .sort(
      (a, c) =>
        distance(a, b) - distance(c, b) ||
        (a.id < c.id ? -1 : a.id > c.id ? 1 : 0),
    )[0];
  let tx = b.x,
    ty = b.y;
  if (carrier?.id === p.id) {
    tx = direction * COURT.goalLine * F;
    ty = 0;
    const pressure = s.players.some(
      (q) => q.team !== p.team && distance(q, p) < 26 * F,
    );
    const mate = mates.find((q) => q.id !== p.id)!;
    if (
      !p.action &&
      s.tick >= p.aiNext &&
      distance(p, mate) > 30 * F &&
      (pressure || (direction * p.x < 0 && s.tick % 61 === 0))
    ) {
      p.aiNext = s.tick + 90 + rng.drawInteger("cryptball", "ai", 31);
      return {
        pass: true,
        moveX: direction,
        aim: aimHeading(mate.x - p.x, mate.y - p.y),
      };
    }
    if (direction * p.x > 34 * F || (pressure && direction * p.x > -30 * F)) {
      if (!p.action && !p.charging) {
        // Aim from the moving ball, since a dribble can sit on either side of
        // the athlete. Small seeded placements avoid repeating a fixed restart.
        const targetY = (rng.drawInteger("cryptball", "ai", 17) - 8) * F;
        p.aiAim = aimHeading(tx - b.x, targetY - b.y);
      }
      return {
        strikePressed: true,
        aim: p.aiAim,
        moveX: direction,
        moveY: -Math.sign(p.y),
      };
    }
  } else if (b.passTarget === p.id && b.passTeam === p.team) {
    tx = clamp(b.x + Math.round(b.vx / 8), -150 * F, 150 * F);
    ty = clamp(b.y + Math.round(b.vy / 8), -80 * F, 80 * F);
  } else if (carrier?.team === p.team || b.passTeam === p.team) {
    tx = clamp((carrier?.x ?? b.x) + direction * 48 * F, -125 * F, 125 * F);
    ty = (p.id.endsWith("1") || p.id.endsWith("3") ? 40 : -40) * direction * F;
  } else if (nearest.id !== p.id) {
    // The second defender covers the goal side of the ball while the nearest
    // athlete presses. Attacking support here would leave both defenders ahead.
    tx = clamp(b.x - direction * 48 * F, -135 * F, 135 * F);
    ty = clamp(Math.round(b.y / 2), -42 * F, 42 * F);
  }
  const dx = tx - p.x,
    dy = ty - p.y;
  p.aiX = Math.round(tx);
  p.aiY = Math.round(ty);
  p.aiRole =
    nearest.id === p.id
      ? "intercept"
      : carrier?.team === p.team || b.passTeam === p.team
        ? "support"
        : "defend-lane";
  return {
    moveX: dx,
    moveY: dy,
    aim: aimHeading(dx, dy),
    slide:
      carrier?.team !== p.team && !!carrier && distance(p, carrier) < 25 * F,
  };
}

function losePossession(s: State, reason: string) {
  const p = s.players.find((p) => p.id === s.possessionId);
  if (!p) {
    s.possessionId = null;
    return;
  }
  s.possessionId = null;
  s.possessionReady = s.tick + 12;
  s.touchTick = s.tick;
  event(s, "possession-lost", p, { reason });
}
function trapBall(s: State) {
  if (
    s.possessionId ||
    s.tick < s.possessionReady ||
    length(s.ball.vx, s.ball.vy) > 175 * F
  )
    return;
  const p = s.players
    .filter(
      (p) =>
        !(s.mode === "practice" && p.team === 1) &&
        !p.slideTicks &&
        !p.dashTicks &&
        !p.staggerTicks &&
        !p.slideRecovery &&
        !specialBurst(s, p) &&
        !(s.ball.lastTouch === p.id && s.tick - s.touchTick < 12) &&
        !(s.restartProtection && s.restartTeam !== p.team) &&
        distance(p, s.ball) <= groundContactReach(s.sportId, 15 * F),
    )
    .sort(
      (a, b) =>
        distance(a, s.ball) - distance(b, s.ball) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )[0];
  if (!p) return;
  specialBallContact(s, p, s.ball, length(s.ball.vx, s.ball.vy));
  touchBall(s.ball, p, s.tick, emitter(s));
  s.possessionId = p.id;
  s.touchTick = s.tick;
  event(s, "trap", p);
}
export function stepKick(
  s: State,
  humans: Map<string, CommandFrame>,
  rng: DeterministicRandom,
) {
  const physics = groundBallPhysics("cryptkick");
  const baseEmit = emitter(s);
  const emit = (e: import("../contract").CryptballEvent) => {
    if (e.type === "slide-contact") {
      const p = s.players.find((p) => p.id === e.playerId);
      if (p?.slideBallHit) return;
      if (p) p.slideBallHit = true;
    }
    baseEmit(e);
  };
  for (const p of s.players) {
    if (s.mode === "practice" && p.team === 1) {
      p.vx = p.vy = 0;
      continue;
    }
    const c = humans.get(p.id) ?? kickAI(s, p, rng);
    admitAction(s, p, c);
    steer(p, c, s.config, s);
    if (
      s.possessionId === p.id &&
      (p.dashTicks ||
        p.slideTicks ||
        (specialBurst(s, p) && specialKind(s, p) !== "foxes"))
    ) {
      losePossession(s, p.slideTicks ? "slide" : "sprint");
      const v =
        specialBurst(s, p) && !p.slideTicks && !p.dashTicks
          ? {
              x: Math.round((p.vx * 65536) / Math.max(1, length(p.vx, p.vy))),
              y: Math.round((p.vy * 65536) / Math.max(1, length(p.vx, p.vy))),
            }
          : headingVector(p.slideTicks ? p.slideHeading : p.dashHeading);
      s.ball.vx = Math.round((v.x * 155 * F) / 65536);
      s.ball.vy = Math.round((v.y * 155 * F) / 65536);
    }
    if (s.restartProtection && s.restartTeam !== p.team) {
      if (p.team === 0 && p.x >= -RULES.playerRadius && p.vx > 0) p.vx = 0;
      if (p.team === 1 && p.x <= RULES.playerRadius && p.vx < 0) p.vx = 0;
    }
  }
  let scored = false;
  for (let sub = 0; sub < 4; sub++) {
    resolveStrikes(s);
    if (
      s.touchTick === s.tick &&
      s.possessionId &&
      s.ball.lastTouch === s.possessionId
    ) {
      // A resolved kick/pass releases the spring before ball integration.
      const p = s.players.find((p) => p.id === s.possessionId)!;
      if (p.action?.hits.includes("ball"))
        losePossession(s, p.action.kind === "pass" ? "pass" : "kick");
    }
    s.ball.bankBonusRemaining = 0;
    s.ball.powerTeam = null;
    s.ball.powerActionKey = null;
    const active =
      s.mode === "practice" ? s.players.filter((p) => p.team === 0) : s.players;
    const paths = movePlayers(
      active,
      s.possessionId ? undefined : s.ball,
      s.tick,
      emit,
      physics,
      s,
    );
    resolveChecks(s, paths);
    const owner = s.players.find((p) => p.id === s.possessionId);
    if (owner) {
      const tackle = s.players.find((p) => {
        if (p.team === owner.team || !p.slideTicks || p.slideBallHit)
          return false;
        const path = paths.find((q) => q.player.id === p.id);
        if (!path) return false;
        const x = path.x - s.ball.x,
          y = path.y - s.ball.y;
        const dx = path.dx - s.ball.vx / 240,
          dy = path.dy - s.ball.vy / 240;
        const squared = dx * dx + dy * dy;
        const t = squared ? clamp(-(x * dx + y * dy) / squared, 0, 1) : 0;
        return (
          length(x + dx * t, y + dy * t) <=
          groundContactReach(
            s.sportId,
            (specialKind(s, p) === "gators" ? 31 : 23) * F,
          )
        );
      });
      if (tackle || owner.staggerTicks || distance(owner, s.ball) > 30 * F) {
        losePossession(
          s,
          tackle ? "tackle" : owner.staggerTicks ? "contact" : "stretched",
        );
        const v = headingVector(tackle?.slideHeading ?? owner.heading);
        s.ball.vx = Math.round((v.x * 110 * F) / 65536);
        s.ball.vy = Math.round((v.y * 110 * F) / 65536);
        if (tackle) {
          touchBall(s.ball, tackle, s.tick, emit);
          s.touchTick = s.tick;
          if (specialKind(s, tackle) === "gators") {
            specialSuccess(s, tackle, "ball");
            stopSpecial(s, tackle);
          }
          tackle.slideBallHit = true;
          baseEmit({
            type: "slide-contact",
            tick: s.tick,
            playerId: tackle.id,
            team: tackle.team,
            x: s.ball.x,
            y: s.ball.y,
          });
        }
      } else {
        const v = headingVector(owner.heading);
        const tx =
            owner.x +
            Math.round(
              (v.x * SPORT_BALL_PROFILES.cryptkick.dribbleOffset * F) / 65536,
            ),
          ty =
            owner.y +
            Math.round(
              (v.y * SPORT_BALL_PROFILES.cryptkick.dribbleOffset * F) / 65536,
            );
        s.ball.vx = Math.round(owner.vx + (tx - s.ball.x) * 16);
        s.ball.vy = Math.round(owner.vy + (ty - s.ball.y) * 16);
        // The ball is an independent body: a board or opponent can break control.
      }
    }
    const team = moveBall(
      s.ball,
      paths.filter(
        (p) =>
          p.player.id !== s.possessionId &&
          !(p.player.slideTicks && p.player.slideBallHit),
      ),
      s.tick,
      emit,
      // A committed slide contacts the ball once, including within one swept interval.
      (p) => !!p.slideTicks && p.slideBallHit,
      physics,
      undefined,
      s,
    );
    if (team !== null) {
      if (s.mode === "match")
        s.remainingTicks = Math.max(0, s.remainingTicks - 1);
      s.possessionId = null;
      scoreGoal(s, team);
      scored = true;
      break;
    }
    if (s.possessionId && s.ball.lastTouch !== s.possessionId)
      losePossession(s, "interception");
    trapBall(s);
  }
  if (!scored) {
    if (!s.possessionId) dragBall(s.ball, physics);
    if (s.ball.passFrom && s.tick - s.ball.passTick >= 90) {
      s.ball.passFrom = s.ball.passTarget = null;
      s.ball.passTeam = null;
    }
    finishActions(s);
    s.restartProtection = Math.max(0, s.restartProtection - 1);
    if (s.mode === "match") {
      s.remainingTicks = Math.max(0, s.remainingTicks - 1);
      expireClock(s);
    }
  }
}
