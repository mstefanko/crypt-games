import { actionPhase } from "@onepage/game-simulation/action-timeline";
import { advanceFixedAxis } from "@onepage/game-simulation/fixed-flight";
import {
  DeterministicRandom,
  deriveRandomSeed,
} from "@onepage/game-simulation/random";
import type { State, CommandFrame, Player } from "../../contract";
import { admitAction, event, finishActions, steer } from "../../actions";
import { FIXED as F, length, integerSqrt } from "../../rules";
import { clearSpecials } from "../../specials";
import {
  guardianDescriptor,
  clamp,
  distance,
  sweepCircle,
  GUARDIAN_RULES,
} from "./spec";
import { stepGuardianBoss } from "./boss";
import { guardianAI } from "./ai";
import {
  guardianBallContact,
  finishGuardianBall,
  moveGuardianBall,
  guardianPassTarget,
  withGuardianOrb,
  guardianHeldOrb,
} from "./ball";
import { guardianRevive, resolveGuardianOutcome, reviveTarget } from "./damage";
import { moveGuardianProjectiles } from "./projectiles";
export type * from "./types";
export { guardianDescriptor, GUARDIAN_RULES } from "./spec";
export { guardianShapeContains } from "./boss";
export function resetGuardian(s: State, seed?: number) {
  const old = s.guardian,
    descriptor = guardianDescriptor(seed ?? old?.descriptor.seed);
  s.guardian = {
    kind: "crypt-guardian",
    orbs: [],
    activeOrbId: "guardian-0",
    descriptor,
    rng: new DeterministicRandom([
      {
        owner: "cryptball",
        name: "guardian",
        seed: deriveRandomSeed(descriptor.seed, "guardian"),
      },
    ]).capture(),
    hp: 300,
    guardHeading: 64,
    guard: 100,
    staggerUntil: 0,
    deflectUntil: 0,
    hostileUntil: 0,
    reboundCount: 0,
    maxHp: 300,
    elapsed: 0,
    stage: 1,
    transitionTicks: 0,
    attack: null,
    nextAttack: s.tick + 90,
    previousAttack: null,
    lastTarget: null,
    targetStreak: 0,
    athletes: Object.fromEntries(
      s.players.map((p) => [
        p.id,
        {
          hp: 5,
          catchUntil: 0,
          catchReady: 0,
          nearTicks: 0,
          status: "active",
          revives: 0,
          reviveBy: null,
          reviveTicks: 0,
          immunityUntil: 0,
          assistUntil: 0,
          assistFrom: null,
        },
      ]),
    ),
    cover:
      descriptor.layout === "pillars"
        ? [-65, 65].map((x, i) => ({
            id: `pillar-${i}`,
            x: x * F,
            y: 0,
            radius: 11 * F,
            hp: 3,
          }))
        : [],
    projectiles: [],
    ballToken: null,
    ballInside: false,
    ballStuckTicks: 0,
    ballResetTicks: 0,
    outcome: null,
    practice: { weapon: null, immortal: false },
  };
  clearSpecials(s);
  s.possessionId = null;
  s.remainingTicks = GUARDIAN_RULES.hardLimit;
  s.overtime = false;
  s.winner = null;
  s.score = [0, 0];
  s.restartTeam = null;
  s.restartProtection = 0;
  for (const [i, p] of s.players.entries()) {
    p.x = ([-48, 48][i] ?? 0) * F;
    p.y = (i % 2 ? 56 : 38) * F;
    p.vx = p.vy = p.rx = p.ry = 0;
    p.heading = 192;
    p.action = null;
    p.charging = false;
    p.chargeTicks = 0;
    p.aiNext = 0;
    p.aiX = p.x;
    p.aiY = p.y;
    p.slideTicks =
      p.slideRecovery =
      p.dashTicks =
      p.staggerTicks =
      p.immunityTicks =
        0;
  }
  s.ball.x = 0;
  s.ball.y = 24 * F;
  s.ball.z = s.ball.vz = s.ball.rz = 0;
  s.ball.vx = s.ball.vy = s.ball.rx = s.ball.ry = 0;
  s.ball.lastTouch = null;
  s.ball.passFrom = s.ball.passTarget = null;
  s.ball.passTeam = null;
  s.guardian!.orbs = [0, 1].map((i) => ({
    id: i === 0 ? "guardian-0" : "guardian-1",
    ball: { ...s.ball, x: (i === 0 ? -25 : 25) * F },
    possessionId: null,
    ballToken: null,
    ballInside: false,
    ballStuckTicks: 0,
    ballResetTicks: 0,
    deflectUntil: 0,
    hostileUntil: 0,
    reboundCount: i * 2,
  }));
  s.ball = s.guardian!.orbs[0].ball;
}
export function advanceGuardian(s: State, _rng?: DeterministicRandom) {
  if (s.phase === "results") return;
  if (--s.phaseTicks > 0) return;
  s.phase = "play";
  s.phaseTicks = 0;
  event(s, "whistle");
}
function circles(s: State) {
  const d = s.guardian!.descriptor;
  return [
    ...s.guardian!.cover.filter((c) => c.hp > 0),
    { x: d.x, y: d.y, radius: d.bodyRadius },
  ];
}
export function clampGuardianPlayer(s: State, p: Player) {
  const maxX = 159 * F,
    maxY = 89 * F;
  p.x = clamp(Math.round(p.x), -maxX, maxX);
  p.y = clamp(Math.round(p.y), -maxY, maxY);
  const ceilRoot = (n: number) => {
    const v = integerSqrt(Math.max(0, n));
    return v * v < n ? v + 1 : v;
  };
  for (let pass = 0; pass < 2; pass++)
    for (const c of circles(s)) {
      const dx = p.x - c.x,
        dy = p.y - c.y,
        n = length(dx, dy),
        r = c.radius + 7 * F;
      if (n >= r) continue;
      const projectedX = c.x + Math.round((n ? dx / n : 0) * r),
        projectedY = c.y + Math.round((n ? dy / n : 1) * r);
      p.x = clamp(projectedX, -maxX, maxX);
      p.y = clamp(projectedY, -maxY, maxY);
      // Boss meets the north wall: clamping a radial projection back into the
      // court can reinsert an athlete. Resolve the circle/wall intersection,
      // preserving the original side, instead of accepting that overlap.
      if (projectedY !== p.y) {
        const offset = ceilRoot(r * r - (p.y - c.y) * (p.y - c.y));
        p.x = c.x + (dx < 0 ? -offset : offset);
      }
      if (projectedX !== p.x && Math.abs(projectedX) > maxX) {
        const offset = ceilRoot(r * r - (p.x - c.x) * (p.x - c.x));
        p.y = c.y + (dy < 0 ? -offset : offset);
      }
      p.x = clamp(p.x, -maxX, maxX);
      p.y = clamp(p.y, -maxY, maxY);
    }
}

function movePlayer(s: State, p: Player) {
  const start = { x: p.x, y: p.y };
  const sx = advanceFixedAxis(p.vx, p.rx, 240),
    sy = advanceFixedAxis(p.vy, p.ry, 240);
  p.rx = sx.remainder;
  p.ry = sy.remainder;
  let dx = sx.delta,
    dy = sy.delta;
  for (let pass = 0; pass < 2; pass++) {
    const hits = circles(s)
      .map((c) => ({
        c,
        t: sweepCircle(p.x, p.y, dx, dy, c.x, c.y, c.radius + 7 * F),
      }))
      .filter((h) => h.t !== null)
      .sort((a, b) => a.t! - b.t!);
    const hit = hits[0];
    if (!hit) {
      p.x += dx;
      p.y += dy;
      break;
    }
    const t = hit.t!;
    p.x += Math.round(dx * t);
    p.y += Math.round(dy * t);
    const n = distance(p, hit.c) || 1,
      nx = (p.x - hit.c.x) / n,
      ny = (p.y - hit.c.y) / n,
      dot = dx * nx + dy * ny;
    dx = Math.round((dx - Math.min(0, dot) * nx) * (1 - t));
    dy = Math.round((dy - Math.min(0, dot) * ny) * (1 - t));
    p.x = hit.c.x + Math.round(nx * (hit.c.radius + 7 * F + 1));
    p.y = hit.c.y + Math.round(ny * (hit.c.radius + 7 * F + 1));
  }
  clampGuardianPlayer(s, p);
  p.distance += Math.round(distance(p, start));
}
export function guardianStep(
  s: State,
  humans: Map<string, CommandFrame>,
  _rng: DeterministicRandom,
) {
  const g = s.guardian!;
  if (g.outcome) return;
  g.elapsed++;
  s.remainingTicks = Math.max(0, 10800 - g.elapsed);
  clearSpecials(s);
  if (g.elapsed === 7200) event(s, "guardian-escalation");
  if (g.elapsed === 9000)
    event(s, "guardian-countdown", undefined, { seconds: 30 });
  const starts = new Map(s.players.map((p) => [p.id, { x: p.x, y: p.y }]));
  const channels = new Map<string, Player>();
  for (const p of s.players) {
    const a = g.athletes[p.id];
    if (a.status !== "active") {
      p.vx = p.vy = 0;
      p.action = null;
      p.charging = false;
      continue;
    }
    a.nearTicks =
      distance(p, g.descriptor) < 50 * F ? Math.min(60, a.nearTicks + 1) : 0;
    const raw = humans.get(p.id) ?? guardianAI(s, p),
      target =
        (raw.pass || raw.passHeld) && !guardianHeldOrb(s, p.id)
          ? reviveTarget(s, p)
          : undefined;
    if (
      !guardianHeldOrb(s, p.id) &&
      raw.strikePressed &&
      s.tick >= a.catchReady
    ) {
      a.catchUntil = s.tick + 9;
      a.catchReady = s.tick + 33;
      event(s, "guardian-catch-ready", p, { until: a.catchUntil });
    }
    let c = { ...raw, special: false, check: false, pointerAim: true };
    if (target) {
      channels.set(p.id, target);
      c = {
        ...c,
        pass: false,
        passHeld: false,
        strikePressed: false,
        strikeReleased: false,
        strikeHeld: false,
        dash: false,
        slide: false,
        guard: false,
        moveX: 0,
        moveY: 0,
      };
      p.action = null;
      p.buffer = null;
      p.charging = false;
      p.vx = p.vy = 0;
    }
    // Empty hands collect automatically; actions require possession.
    if (!guardianHeldOrb(s, p.id))
      c = {
        ...c,
        strikePressed: false,
        strikeHeld: false,
        strikeReleased: false,
        pass: false,
      };
    admitAction(s, p, c);
    if (p.action?.kind === "pass") {
      const target = guardianPassTarget(s, p, p.action.heading);
      p.action.targetId = target?.id;
      if (target) {
        p.action.heading = aimHeadingFor(target.x - p.x, target.y - p.y);
        p.heading = p.action.heading;
      }
    }
    steer(p, c, s.config, s);
  }
  stepGuardianBoss(s);
  for (const p of s.players)
    if (g.athletes[p.id].status === "active") clampGuardianPlayer(s, p);
  for (let sub = 0; sub < 4; sub++) {
    for (const orb of g.orbs)
      withGuardianOrb(s, orb, () => {
        for (const p of s.players)
          if (g.athletes[p.id].status === "active")
            guardianBallContact(s, p, !!p.slideTicks);
      });
    for (const p of s.players)
      if (g.athletes[p.id].status === "active") movePlayer(s, p);
    // Friendly bodies do not check or damage. Soft separation preserves space.
    for (let i = 0; i < s.players.length; i++)
      for (let j = i + 1; j < s.players.length; j++) {
        const a = s.players[i],
          b = s.players[j];
        if (
          g.athletes[a.id].status !== "active" ||
          g.athletes[b.id].status !== "active"
        )
          continue;
        const dx = b.x - a.x,
          dy = b.y - a.y,
          d = length(dx, dy);
        if (d < 14 * F) {
          const push = (14 * F - d) / 2,
            nx = d ? dx / d : 1,
            ny = d ? dy / d : 0;
          a.x -= Math.round(nx * push);
          a.y -= Math.round(ny * push);
          b.x += Math.round(nx * push);
          b.y += Math.round(ny * push);
          clampGuardianPlayer(s, a);
          clampGuardianPlayer(s, b);
        }
      }
    for (const orb of g.orbs)
      withGuardianOrb(s, orb, () => moveGuardianBall(s));
  }
  moveGuardianProjectiles(s, starts);
  for (const down of s.players) {
    const a = g.athletes[down.id];
    if (a.status !== "down") continue;
    const helpers = s.players
      .filter(
        (p) =>
          channels.get(p.id)?.id === down.id &&
          g.athletes[p.id].status === "active" &&
          p.staggerTicks === 0 &&
          reviveTarget(s, p)?.id === down.id,
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const by = helpers[0];
    if (!by) {
      a.reviveTicks = 0;
      a.reviveBy = null;
    } else {
      a.reviveTicks = a.reviveBy === by.id ? a.reviveTicks + 1 : 1;
      a.reviveBy = by.id;
      if (a.reviveTicks >= 90) guardianRevive(s, down, by);
    }
  }
  for (const orb of g.orbs)
    withGuardianOrb(s, orb, () => finishGuardianBall(s));
  finishActions(s);
  resolveGuardianOutcome(s);
}
import { aimHeading as aimHeadingFor } from "../../rules";
export { validateGuardianState } from "./validation";

/** Practice options apply at a restart so changing family cannot spawn cover
 * beneath an active athlete or mutate the scored encounter. */
export function configureGuardianPractice(
  s: State,
  options: { weapon?: import("./types").GuardianWeapon; immortal?: boolean },
) {
  if (s.sportId !== "crypt-guardian" || s.mode !== "practice")
    throw Error("Guardian practice only");
  const weapons = ["cannon", "hook", "maul"];
  if (
    (options.weapon !== undefined && !weapons.includes(options.weapon)) ||
    (options.immortal !== undefined && typeof options.immortal !== "boolean")
  )
    throw Error("Invalid guardian practice options");
  let seed = s.guardian!.descriptor.seed;
  if (options.weapon)
    seed = seed - (seed % 3) + weapons.indexOf(options.weapon);
  if (seed > 4294967295) seed -= 3;
  resetGuardian(s, seed);
  s.guardian!.practice = {
    weapon: options.weapon ?? null,
    immortal: options.immortal ?? false,
  };
  s.phase = "play";
  s.phaseTicks = 0;
}
