import type {
  CommandFrame,
  CommandOrigin,
  Player,
  State,
  Team,
} from "../../contract";
import {
  DeterministicRandom,
  deriveRandomSeed,
} from "@onepage/game-simulation/random";
import { circleSweepCircle } from "@onepage/game-simulation/circle-geometry";
import {
  aimHeading,
  headingVector,
  length,
  normalized,
  FIXED as F,
} from "../../rules";
import { event, recordStat } from "../../actions";
import { makePlayer } from "../../match";
import { DODGE } from "./spec";
export { DODGE } from "./spec";
export interface DodgeAthlete {
  lives: number;
  aiThrowId: number;
  catchStart: number;
  catchOrigin?: CommandOrigin;
  catchKind: "standing" | "dive" | null;
  catchReady: number;
  primaryHeld: boolean;
  needsRelease: boolean;
  collectAfter: number;
  passAssistUntil: number;
  pendingThrow: {
    releaseTick: number;
    heading: number;
    charge: number;
    origin?: CommandOrigin;
  } | null;
}
export interface CryptDodgeState {
  kind: "crypt-dodge";
  aiSeed: number;
  subphase: "countdown" | "live" | "settling" | "sudden-death" | "round-end";
  round: number;
  openingTeam: Team;
  roundWinner: Team | "draw" | null;
  drawnRounds: number;
  suddenDeathTicks: number;
  settleTicks: number;
  athletes: Record<string, DodgeAthlete>;
  balls: DodgeBall[];
  ball: {
    powered: boolean;
    origin?: CommandOrigin;
    state: "held" | "friendly-pass" | "hostile-flight" | "dead-loose" | "reset";
    holderId: string | null;
    attackingTeam: Team | null;
    throwId: number;
    releaseTick: number;
    hitClaim: string | null;
    receivingTeam: Team;
    passTarget: string | null;
    passerId: string | null;
    unreachableTicks: number;
    lastX: number;
    lastY: number;
  };
  possessionTeam: Team | null;
  possessionDeadline: number;
  transferAt: number;
}
export interface DodgeBall {
  id: string;
  physical: State["ball"];
  mode: CryptDodgeState["ball"];
  possessionTeam: Team | null;
  possessionDeadline: number;
  transferAt: number;
  retired: boolean;
}
function occupied(s: State, id: string) {
  return s.dodge!.balls.some(b => !b.retired && b.mode.state === "held" && b.mode.holderId === id);
}
function bind(s: State, b: DodgeBall) {
  const d = s.dodge!;
  d.ball = b.mode; s.ball = b.physical;
  s.possessionId = b.mode.holderId;
  d.possessionTeam = b.possessionTeam;
  d.possessionDeadline = b.possessionDeadline; d.transferAt = b.transferAt;
}
function save(s: State, b: DodgeBall) {
  const d = s.dodge!;
  b.possessionTeam = d.possessionTeam;
  b.possessionDeadline = d.possessionDeadline; b.transferAt = d.transferAt;
}
function primary(s: State) { bind(s, s.dodge!.balls[0]); }
function ballEvent(s: State, type: Parameters<typeof event>[1], p?: Player, detail: Record<string, unknown> = {}) {
  event(s, type, p, { ...detail, ballId: s.dodge?.balls.find(b => b.mode === s.dodge!.ball)?.id });
}
function athlete(): DodgeAthlete {
  return {
    lives: DODGE.lives,
    aiThrowId: -1,
    catchStart: -1,
    catchKind: null,
    catchReady: 0,
    primaryHeld: false,
    needsRelease: false,
    collectAfter: 0,
    passAssistUntil: 0,
    pendingThrow: null,
  };
}
function living(s: State, p: Player) {
  return !!s.dodge?.athletes[p.id]?.lives;
}
export function clampDodgePlayer(p: Player) {
  p.x = Math.round(
    p.team === 0
      ? Math.max(-159 * F, Math.min(-DODGE.halfStrip, p.x))
      : Math.max(DODGE.halfStrip, Math.min(159 * F, p.x)),
  );
  p.y = Math.round(Math.max(-89 * F, Math.min(89 * F, p.y)));
}
function socket(s: State, p: Player) {
  const v = headingVector(p.slideTicks ? p.slideHeading : p.heading);
  const reach = (p.slideTicks || p.slideRecovery ? 14 : 11) * F;
  s.ball.x = p.x + Math.round((v.x * reach) / 65536);
  s.ball.y = p.y + Math.round((v.y * reach) / 65536);
  s.ball.z = (p.slideTicks || p.slideRecovery ? 4 : 12) * F;
  s.ball.vx = s.ball.vy = s.ball.vz = s.ball.rx = s.ball.ry = s.ball.rz = 0;
}
function hold(s: State, p: Player, caught = false) {
  const d = s.dodge!,
    b = d.ball;
  const priorTeam = d.possessionTeam;
  b.state = "held";
  b.holderId = p.id;
  b.attackingTeam = null;
  b.receivingTeam = p.team;
  b.unreachableTicks = 0;
  s.possessionId = p.id;
  s.ball.lastTouch = p.id;
  s.ball.passFrom = s.ball.passTarget = null;
  s.ball.passTeam = null;
  if (priorTeam !== p.team || !d.possessionDeadline) {
    d.possessionTeam = p.team;
    d.possessionDeadline = s.tick + DODGE.possessionTicks;
    d.transferAt = 0;
  }
  if (caught) {
    d.athletes[p.id].needsRelease = true;
    p.charging = false;
    p.chargeTicks = 0;
  }
  socket(s, p);
}
function dead(s: State, team: Team, x = s.ball.x, y = s.ball.y) {
  x = Math.max(-161 * F, Math.min(161 * F, x));
  y = Math.max(-91 * F, Math.min(91 * F, y));
  const b = s.dodge!.ball;
  b.state = "dead-loose";
  b.holderId = null;
  b.attackingTeam = null;
  b.receivingTeam = team;
  b.passTarget = null;
  b.passerId = null;
  b.unreachableTicks = 0;
  b.lastX = x;
  b.lastY = y;
  s.possessionId = null;
  s.ball.x = x;
  s.ball.y = y;
  s.ball.z = s.ball.vz = s.ball.rz = 0;
  s.ball.passFrom = s.ball.passTarget = null;
  s.ball.passTeam = null;
}
function restart(s: State, team: Team, preservePossession = false) {
  const d = s.dodge!;
  const retainDeadline =
    preservePossession && d.possessionTeam === team && d.possessionDeadline > 0;
  for (const p of s.players) if (p.id === d.ball.holderId) {
    p.charging = false;
    p.chargeTicks = 0;
    d.athletes[p.id].pendingThrow = null;
  }
  dead(s, team, (team === 0 ? -116 : 116) * F, 0);
  d.ball.state = "reset";
  d.ball.releaseTick = s.tick;
  d.possessionTeam = preservePossession && d.possessionTeam === null ? null : team;
  if (!retainDeadline && d.possessionTeam !== null) {
    d.possessionDeadline = s.tick + DODGE.possessionTicks;
    d.transferAt = 0;
  }
  s.ball.vx = s.ball.vy = 0;
  if (!preservePossession)
    ballEvent(s, "dodge-possession-transfer", undefined, {
      team,
      x: s.ball.x,
      y: s.ball.y,
    });
}
export function resetDodge(s: State, seed?: number) {
  const old = s.dodge;
  const openingTeam: Team = old
    ? old.openingTeam === 0
      ? 1
      : 0
    : ((((Math.trunc(seed ?? 0xc7ba11) % 2) + 2) % 2) as Team);
  s.dodge = {
    kind: "crypt-dodge",
    aiSeed:
      old?.aiSeed ??
      ((Math.trunc(seed ?? 0xc7ba11) % 4294967296) + 4294967296) % 4294967296,
    subphase: s.mode === "practice" ? "live" : "countdown",
    round: old ? old.round + (old.roundWinner === "draw" ? 0 : 1) : 1,
    openingTeam,
    roundWinner: null,
    drawnRounds: old?.drawnRounds ?? 0,
    suddenDeathTicks: 0,
    settleTicks: 0,
    athletes: Object.fromEntries(s.players.map((p) => [p.id, athlete()])),
    balls: [],
    ball: {
      powered: false,
      state: "held",
      holderId: null,
      attackingTeam: null,
      throwId: old?.ball.throwId ?? 0,
      releaseTick: s.tick,
      hitClaim: null,
      receivingTeam: openingTeam,
      passTarget: null,
      passerId: null,
      unreachableTicks: 0,
      lastX: 0,
      lastY: 0,
    },
    possessionTeam: null,
    possessionDeadline: 0,
    transferAt: 0,
  };
  s.players = s.players.map((p, i) => ({
    ...makePlayer(i),
    x: (p.team === 0 ? -1 : 1) * (i % 2 ? 104 : 114) * F,
    y: (i % 2 ? 36 : -30) * F,
    distance: p.distance,
  }));
  s.remainingTicks = DODGE.roundTicks;
  s.overtime = false;
  s.restartProtection = 0;
  s.restartTeam = null;
  s.goalTeam = null;
  s.phase = s.mode === "practice" ? "play" : "ready";
  s.phaseTicks = s.mode === "practice" ? 0 : DODGE.countdown;
  const d = s.dodge;
  d.balls = ([0, 1] as const).map(team => ({
    id: `dodge-${team}`, physical: { ...s.ball },
    mode: { ...d.ball, state: "dead-loose", holderId: null, receivingTeam: team },
    possessionTeam: null, possessionDeadline: 0, transferAt: 0, retired: false,
  }));
  for (const b of d.balls) {
    bind(s, b);
    dead(s, b.mode.receivingTeam, (b.mode.receivingTeam === 0 ? -1 : 1) * DODGE.halfStrip,
      (b.mode.receivingTeam === 0 ? -18 : 18) * F);
    s.ball.vx = s.ball.vy = 0;
    save(s, b);
  }
  primary(s);
}
export function advanceDodge(s: State) {
  if (s.phase === "results" || --s.phaseTicks > 0) return;
  if (s.phase === "goal") {
    resetDodge(s);
    return;
  }
  s.phase = "play";
  s.dodge!.subphase = "live";
  ballEvent(s, "whistle");
}
function finishRound(s: State, winner: Team | "draw") {
  if (s.dodge!.subphase === "round-end" || s.phase === "results") return;
  const d = s.dodge!;
  d.roundWinner = winner;
  d.subphase = "round-end";
  for (const p of s.players) {
    p.charging = false;
    p.chargeTicks = 0;
    p.vx = p.vy = 0;
    d.athletes[p.id].pendingThrow = null;
  }
  if (winner === "draw") d.drawnRounds++;
  else s.score[winner]++;
  ballEvent(s, "dodge-round-end", undefined, { winner, round: d.round });
  if (winner !== "draw" && s.score[winner] >= 2) {
    s.phase = "results";
    s.phaseTicks = 0;
    s.winner = winner;
    ballEvent(s, "match-end", undefined, { winner });
  } else {
    s.phase = "goal";
    s.phaseTicks = DODGE.roundPause;
  }
}
function compare(s: State): Team | null {
  const totals = [0, 0],
    count = [0, 0];
  for (const p of s.players) {
    const n = s.dodge!.athletes[p.id].lives;
    totals[p.team] += n;
    if (n) count[p.team]++;
  }
  if (count[0] !== count[1]) return count[0] > count[1] ? 0 : 1;
  if (totals[0] !== totals[1]) return totals[0] > totals[1] ? 0 : 1;
  return null;
}
function catchActive(s: State, p: Player) {
  if (occupied(s, p.id)) return false;
  const a = s.dodge!.athletes[p.id],
    elapsed = s.tick - a.catchStart;
  return a.catchKind === "standing"
    ? elapsed >= DODGE.catchTell &&
        elapsed < DODGE.catchTell + DODGE.catchActive &&
        (!s.dodge!.ball.powered || (elapsed >= DODGE.catchTell + 2 && elapsed < DODGE.catchTell + 5))
    : a.catchKind === "dive" && elapsed >= 2 && elapsed < 11 &&
      !s.dodge!.ball.powered;
}
function facesBall(p: Player, x: number, y: number, dive: boolean) {
  const v = headingVector(dive ? p.slideHeading : p.heading),
    dx = x - p.x,
    dy = y - p.y;
  const n = length(dx, dy);
  return !n || dx * v.x + dy * v.y >= n * 65536 * (dive ? 0.64279 : 0.5);
}
function release(
  s: State,
  p: Player,
  pass: boolean,
  heading: number,
  charge: number,
  origin?: CommandOrigin,
) {
  const d = s.dodge!,
    b = d.ball;
  if (b.state !== "held" || b.holderId !== p.id) return;
  socket(s, p);
  s.ball.x = Math.max(-161 * F, Math.min(161 * F, s.ball.x));
  s.ball.y = Math.max(-91 * F, Math.min(91 * F, s.ball.y));
  const target = pass
    ? s.players.find((q) => q.team === p.team && q.id !== p.id && living(s, q) && !occupied(s, q.id))
    : undefined;
  if (pass && !target) {
    d.athletes[p.id].collectAfter = s.tick + 18;
    p.charging = false; p.chargeTicks = 0;
    dead(s, p.team);
    s.ball.vx = s.ball.vy = 0;
    return;
  }
  const empowered = !pass && s.tick <= d.athletes[p.id].passAssistUntil && d.athletes[p.id].passAssistUntil > 0;
  if (empowered) charge = DODGE.chargeTicks;
  b.powered = !pass && charge >= DODGE.chargeTicks;
  if (!pass) d.athletes[p.id].passAssistUntil = 0;
  const h = target
    ? aimHeading(target.x - s.ball.x, target.y - s.ball.y)
    : heading;
  const v = headingVector(h),
    speed = pass
      ? DODGE.passSpeed
      : DODGE.quickSpeed +
        Math.round(
          ((DODGE.chargedSpeed - DODGE.quickSpeed) * charge) /
            DODGE.chargeTicks,
        );
  b.state = pass ? "friendly-pass" : "hostile-flight";
  b.holderId = null;
  b.throwId = Math.max(...d.balls.map(b => b.mode.throwId)) + 1;
  b.origin = origin;
  b.attackingTeam = pass ? null : p.team;
  b.releaseTick = s.tick;
  b.hitClaim = null;
  b.receivingTeam = pass ? p.team : p.team === 0 ? 1 : 0;
  b.passTarget = target?.id ?? null;
  b.passerId = p.id;
  s.possessionId = null;
  s.ball.vx = Math.round((v.x * speed) / 65536);
  s.ball.vy = Math.round((v.y * speed) / 65536);
  s.ball.z = (pass ? 5 : 12) * F;
  s.ball.vz = pass ? 0 : Math.round(38 * F);
  s.ball.rz = 0;
  s.ball.lastTouch = p.id;
  s.ball.passFrom = pass ? p.id : null;
  s.ball.passTarget = target?.id ?? null;
  s.ball.passTeam = pass ? p.team : null;
  s.ball.passTick = s.tick;
  d.athletes[p.id].collectAfter = s.tick + 18;
  p.charging = false;
  p.chargeTicks = 0;
  recordStat(s, p, pass ? "passes" : "shots");
  ballEvent(s, pass ? "dodge-pass" : "dodge-throw", p, {
    heading: h,
    charge,
    origin,
    throwId: b.throwId,
    powered: b.powered,
  });
}
function input(s: State, p: Player, c: CommandFrame) {
  const a = s.dodge!.athletes[p.id];
  if (c.cancel) c = { cancel: true };
  if (!living(s, p)) {
    p.vx = p.vy = 0;
    return;
  }
  if (c.aim !== undefined) p.heading = ((Math.round(c.aim) % 256) + 256) % 256;
  else if (c.moveX || c.moveY)
    p.heading = aimHeading(c.moveX ?? 0, c.moveY ?? 0);
  // A caught ball cannot inherit the held catch button as a new offensive press.
  const pressed = !!c.strikePressed && !a.primaryHeld;
  if (!c.strikeHeld && !c.strikePressed) {
    a.primaryHeld = false;
    a.needsRelease = false;
  } else if (c.strikeHeld || c.strikePressed) a.primaryHeld = true;
  const held =
    s.dodge!.ball.state === "held" && s.dodge!.ball.holderId === p.id;
  if (c.cancel) {
    p.charging = false;
    p.chargeTicks = 0;
    a.pendingThrow = null;
  }
  if (
    c.slide &&
    !p.slideTicks &&
    !p.slideRecovery &&
    s.tick >= p.slideReady &&
    !p.staggerTicks
  ) {
    p.motionOrigin = c.origin ? { ...c.origin } : undefined;
    p.slideTicks = DODGE.diveTicks;
    p.slideReady = s.tick + DODGE.diveReuse;
    p.slideHeading = p.heading;
    a.catchKind = held ? null : "dive";
    a.catchStart = s.tick;
    a.catchOrigin = c.origin;
    a.catchReady = s.tick + DODGE.diveTicks + DODGE.diveRecovery;
    p.charging = false;
    p.chargeTicks = 0;
    a.pendingThrow = null;
    if (held) {
      dead(s, p.team, p.x, p.y);
      s.ball.vx = s.ball.vy = 0;
      a.collectAfter = s.tick + DODGE.diveTicks + DODGE.diveRecovery;
    }
    ballEvent(s, "slide", p, { origin: c.origin });
  }
  if (
    c.dash &&
    !p.dashCooldown &&
    !p.slideTicks &&
    !p.slideRecovery &&
    !p.staggerTicks
  ) {
    p.motionOrigin = c.origin ? { ...c.origin } : undefined;
    ballEvent(s, "dash", p, { origin: c.origin });
    p.dashTicks = 10;
    p.dashCooldown = 66;
    p.dashHeading = p.heading;
  }
  if (!p.slideTicks && !p.slideRecovery && !p.staggerTicks && !a.pendingThrow) {
    if (!occupied(s, p.id) && pressed && s.tick >= a.catchReady) {
      a.catchKind = "standing";
      a.catchStart = s.tick;
      a.catchOrigin = c.origin;
      a.catchReady =
        s.tick + DODGE.catchTell + DODGE.catchActive + DODGE.catchRecovery;
      ballEvent(s, "dodge-catch-ready", p, { origin: c.origin });
    } else if (held && !a.needsRelease && s.dodge!.subphase !== "settling") {
      if (c.pass) release(s, p, true, p.heading, 0, c.origin);
      else {
        if (pressed) {
          p.charging = true;
          p.chargeTicks = 0;
          p.chargeOrigin = c.origin;
        }
        if (p.charging) {
          if (c.strikeHeld)
            p.chargeTicks = Math.min(DODGE.chargeTicks, p.chargeTicks + 1);
          if (c.strikeReleased || !c.strikeHeld) {
            a.pendingThrow = {
              releaseTick:
                s.tick +
                (s.tick <= a.passAssistUntil
                  ? DODGE.assistedTell
                  : DODGE.throwTell),
              heading: p.heading,
              charge: p.chargeTicks,
              ...((c.origin ?? p.chargeOrigin)
                ? { origin: c.origin ?? p.chargeOrigin }
                : {}),
            };
            p.charging = false;
          }
        }
      }
    }
  }
  if (a.pendingThrow && s.tick >= a.pendingThrow.releaseTick) {
    const throwAction = a.pendingThrow;
    a.pendingThrow = null;
    release(
      s,
      p,
      false,
      throwAction.heading,
      throwAction.charge,
      throwAction.origin,
    );
  }
  const n = normalized(c.moveX ?? 0, c.moveY ?? 0);
  let speed = (p.charging || a.pendingThrow ? 0.7 : 1) * 96 * F;
  let v = n;
  if (p.staggerTicks) speed *= 0.35;
  if (p.dashTicks) {
    v = headingVector(p.dashHeading);
    v = { x: v.x / 65536, y: v.y / 65536 };
    speed = 192 * F;
  }
  if (p.slideTicks) {
    v = headingVector(p.slideHeading);
    v = { x: v.x / 65536, y: v.y / 65536 };
    speed = (120 + (180 * p.slideTicks) / 18) * F;
  } else if (p.slideRecovery) speed *= 0.4;
  p.vx = Math.round(v.x * speed);
  p.vy = Math.round(v.y * speed);
}
interface Path {
  player: Player;
  x: number;
  y: number;
  dx: number;
  dy: number;
}
function movement(s: State): Path[] {
  const paths: Path[] = [];
  for (const p of s.players) {
    if (!living(s, p)) continue;
    const x = p.x,
      y = p.y;
    p.rx += p.vx;
    p.ry += p.vy;
    const dx = Math.trunc(p.rx / 240),
      dy = Math.trunc(p.ry / 240);
    p.rx -= dx * 240;
    p.ry -= dy * 240;
    p.x += dx;
    p.y += dy;
    clampDodgePlayer(p);
    paths.push({ player: p, x, y, dx: p.x - x, dy: p.y - y });
    p.distance += Math.round(length(p.x - x, p.y - y));
  }
  // Keep friendly bodies distinct without allowing correction to cross center.
  for (let i = 0; i < paths.length; i++)
    for (let j = i + 1; j < paths.length; j++) {
      const p = paths[i].player,
        q = paths[j].player;
      if (p.team !== q.team) continue;
      const dx = q.x - p.x,
        dy = q.y - p.y,
        n = length(dx, dy),
        r = 14 * F;
      if (n >= r) continue;
      const nx = n ? dx / n : 0,
        ny = n ? dy / n : 1,
        push = (r - n) / 2;
      p.x -= Math.round(nx * push);
      p.y -= Math.round(ny * push);
      q.x += Math.round(nx * push);
      q.y += Math.round(ny * push);
      clampDodgePlayer(p);
      clampDodgePlayer(q);
    }
  for (const path of paths) {
    path.dx = path.player.x - path.x;
    path.dy = path.player.y - path.y;
  }
  return paths;
}
function ding(s: State, p: Player) {
  const d = s.dodge!,
    a = d.athletes[p.id];
  if (d.ball.hitClaim !== null) return;
  d.ball.hitClaim = p.id;
  const damaged = !p.immunityTicks;
  if (damaged) {
    a.lives--;
    p.immunityTicks = DODGE.immunity;
    p.staggerTicks = 12;
    a.collectAfter = s.tick + DODGE.collectionLockout;
    p.charging = false;
    p.chargeTicks = 0;
    a.pendingThrow = null;
    p.slideTicks = 0;
    p.slideRecovery = 0;
    a.catchKind = null;
    ballEvent(s, "dodge-ding", p, {
      lives: a.lives,
      throwId: d.ball.throwId,
      origin: d.ball.origin,
    });
    if (!a.lives) {
      p.vx = p.vy = 0;
      p.y = (p.id.endsWith("1") || p.id.endsWith("3") ? 86 : -86) * F;
      ballEvent(s, "dodge-out", p);
    }
  }
  dead(s, p.team, p.x + (p.team === 0 ? -10 : 10) * F, p.y);
  s.ball.vx = (p.team === 0 ? -28 : 28) * F;
  s.ball.vy = 0;
  if (damaged && d.subphase === "sudden-death")
    finishRound(s, p.team === 0 ? 1 : 0);
}
function ballStep(s: State, paths: Path[]) {
  const d = s.dodge!,
    db = d.ball,
    b = s.ball;
  if (db.state === "held") {
    const p = s.players.find((p) => p.id === db.holderId);
    if (p && living(s, p)) socket(s, p);
    else dead(s, db.receivingTeam);
    return;
  }
  if (db.state === "reset") {
    if (s.tick - db.releaseTick < 24) return;
    db.state = "dead-loose";
  }
  b.rx += b.vx;
  b.ry += b.vy;
  const dx = Math.trunc(b.rx / 240),
    dy = Math.trunc(b.ry / 240);
  b.rx -= dx * 240;
  b.ry -= dy * 240;
  const start = { x: b.x, y: b.y },
    contacts: {
      t: number;
      priority: number;
      p?: Player;
      kind: "catch" | "body" | "receive" | "wall" | "floor";
    }[] = [];
  const verticalDelta =
    db.state === "hostile-flight" ? Math.trunc((b.rz + b.vz) / 240) : 0;
  if (
    db.state === "hostile-flight" &&
    verticalDelta < 0 &&
    b.z + verticalDelta <= DODGE.ballRadius
  ) {
    const t = Math.max(
      0,
      Math.ceil(((DODGE.ballRadius - b.z) * 65536) / verticalDelta),
    );
    contacts.push({ t, priority: 0, kind: "floor" });
  }
  const heightAt = (t: number) => b.z + Math.round((verticalDelta * t) / 65536);
  const wallX = 161 * F,
    wallY = 91 * F;
  for (const [pos, speed, limit] of [
    [b.x, dx, wallX],
    [b.y, dy, wallY],
  ]) {
    if (speed && Math.abs(pos + speed) >= limit) {
      const edge = speed > 0 ? limit : -limit;
      const t = Math.ceil(((edge - pos) * 65536) / speed);
      if (t >= 0 && t <= 65536) contacts.push({ t, priority: 0, kind: "wall" });
    }
  }
  if (db.state === "hostile-flight" || db.state === "friendly-pass")
    for (const path of paths) {
      const p = path.player,
        a = d.athletes[p.id];
      if (!living(s,p)) continue;
      if (db.state === "hostile-flight" && p.team === db.attackingTeam)
        continue;
      if (
        db.state === "friendly-pass" &&
        (p.id !== db.passTarget || p.team !== db.receivingTeam)
      )
        continue;
      const relative = { x: dx - path.dx, y: dy - path.dy };
      if (db.state === "friendly-pass") {
        if (
          !occupied(s, p.id) &&
          !p.slideTicks &&
          !p.slideRecovery &&
          !p.staggerTicks &&
          s.tick >= a.collectAfter
        ) {
          const t = circleSweepCircle({ ...start, radius: 5 * F }, relative, {
            x: path.x,
            y: path.y,
            radius: 10 * F,
          });
          if (t !== null) contacts.push({ t, priority: 1, p, kind: "receive" });
        }
        continue;
      }
      if (catchActive(s, p)) {
        const queryBallRadius =
          a.catchKind === "dive" ? 9 * F : DODGE.ballRadius;
        const radius =
          (a.catchKind === "dive" ? DODGE.diveReach : DODGE.catchReach) -
          queryBallRadius;
        const t = circleSweepCircle(
          { ...start, radius: queryBallRadius },
          relative,
          { x: path.x, y: path.y, radius },
        );
        if (t !== null) {
          const x = start.x + Math.round((dx * t) / 65536),
            y = start.y + Math.round((dy * t) / 65536);
          const pose = {
            ...p,
            x: path.x + Math.round((path.dx * t) / 65536),
            y: path.y + Math.round((path.dy * t) / 65536),
          };
          if (
            heightAt(t) <= 24 * F &&
            facesBall(pose, x, y, a.catchKind === "dive")
          )
            contacts.push({ t, priority: 1, p, kind: "catch" });
        }
      }
      {
        const t = circleSweepCircle(
          { ...start, radius: DODGE.ballRadius },
          relative,
          { x: path.x, y: path.y, radius: DODGE.bodyRadius },
        );
        if (t !== null && heightAt(t) <= 22 * F)
          contacts.push({ t, priority: 2, p, kind: "body" });
      }
    }
  contacts.sort(
    (a, b) =>
      a.t - b.t ||
      a.priority - b.priority ||
      ((a.p?.id ?? "") < (b.p?.id ?? "") ? -1 : 1),
  );
  const contact = contacts[0];
  if (contact) {
    b.x += Math.round((dx * contact.t) / 65536);
    b.y += Math.round((dy * contact.t) / 65536);
    if (contact.kind === "catch" || contact.kind === "receive") {
      const p = contact.p!,
        passer = db.passerId,
        diving = d.athletes[contact.p!.id].catchKind === "dive";
      if (db.hitClaim !== null) return;
      db.hitClaim = p.id;
      hold(s, p, contact.kind === "catch");
      if (contact.kind === "receive") {
        d.athletes[p.id].passAssistUntil = s.tick + DODGE.assistTicks;
        ballEvent(s, "pass-complete", p, { passerId: passer });
      } else
        ballEvent(s, "dodge-catch", p, {
          throwId: db.throwId,
          diving,
          origin: d.athletes[p.id].catchOrigin,
        });
    } else if (contact.kind === "body") ding(s, contact.p!);
    else if (contact.kind === "floor") {
      dead(s, b.x === 0 ? db.receivingTeam : b.x < 0 ? 0 : 1);
      b.vx = Math.round(b.vx * 0.35);
      b.vy = Math.round(b.vy * 0.35);
    } else {
      if (db.state !== "dead-loose")
        dead(s, b.x === 0 ? db.receivingTeam : b.x < 0 ? 0 : 1);
      if (Math.abs(b.x) >= wallX - 1) b.vx = -Math.round(b.vx * 0.45);
      if (Math.abs(b.y) >= wallY - 1) b.vy = -Math.round(b.vy * 0.45);
      b.x = Math.max(-wallX, Math.min(wallX, b.x));
      b.y = Math.max(-wallY, Math.min(wallY, b.y));
    }
  } else {
    b.x += dx;
    b.y += dy;
  }
  if (db.state === "hostile-flight") {
    b.rz += b.vz;
    const dz = Math.trunc(b.rz / 240);
    b.rz -= dz * 240;
    b.z += dz;
    b.vz -= Math.round((150 * F) / 240);
    if (b.z <= DODGE.ballRadius) {
      dead(s, b.x === 0 ? db.receivingTeam : b.x < 0 ? 0 : 1);
      b.vx = Math.round(b.vx * 0.35);
      b.vy = Math.round(b.vy * 0.35);
    }
  } else if (db.state === "friendly-pass") {
    if (!s.players.some((p) => p.id === db.passTarget && living(s, p))) {
      dead(s, db.receivingTeam);
    }
  }
  if (db.state === "dead-loose") {
    b.z = b.vz = b.rz = 0;
    const side: Team = b.x === 0 ? db.receivingTeam : b.x < 0 ? 0 : 1;
    const candidates = s.players
      .filter(
        (p) =>
          living(s, p) &&
          !occupied(s, p.id) &&
          s.phase === "play" &&
          p.team === side &&
          !p.slideTicks &&
          !p.staggerTicks &&
          s.tick >= d.athletes[p.id].collectAfter &&
          length(p.x - b.x, p.y - b.y) <= 17 * F,
      )
      .sort(
        (a, b) =>
          length(a.x - s.ball.x, a.y - s.ball.y) -
            length(b.x - s.ball.x, b.y - s.ball.y) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    if (candidates.length) hold(s, candidates[0]);
  }
}
/** A throw and side-local roster slot identify one immutable bot decision.
 * Separate seeded owners keep this independent of tick cadence and other bots.
 * Mirroring the court preserves response delay/choice and reverses aim error. */
export function dodgeAIResponse(seed: number, throwId: number, slot: number) {
  const owner = new DeterministicRandom([
    {
      owner: "cryptball",
      name: "dodge-response",
      seed: deriveRandomSeed(seed, `dodge.throw-${throwId}.slot-${slot}`),
    },
  ]);
  return {
    catch: owner.drawInteger("cryptball", "dodge-response", 100) < 55,
    reactionTicks: 10 + owner.drawInteger("cryptball", "dodge-response", 10),
    aimError: owner.drawInteger("cryptball", "dodge-response", 11) - 5,
    dive: owner.drawInteger("cryptball", "dodge-response", 5) === 0,
  };
}
export function dodgeAI(
  s: State,
  humans: Map<string, CommandFrame>,
): Map<string, CommandFrame> {
  const out = new Map<string, CommandFrame>(),
    d = s.dodge!;
  for (const p of s.players) {
    if (humans.has(p.id) || !living(s, p)) continue;
    const selected = d.balls.filter(b => !b.retired).sort((a,b) => {
      const rank = (b: DodgeBall) => b.mode.holderId === p.id ? -1e9 :
        b.mode.state === "hostile-flight" && b.mode.attackingTeam !== p.team ? -1e8 + length(b.physical.x-p.x,b.physical.y-p.y) :
        (b.mode.passTarget === p.id || (b.mode.state === "dead-loose" && (b.physical.x < 0 ? 0 : 1) === p.team)) ? length(b.physical.x-p.x,b.physical.y-p.y) : 1e9;
      return rank(a)-rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    })[0];
    bind(s, selected);
    const db = d.ball;
    const a = d.athletes[p.id],
      holder = db.holderId === p.id,
      slot = Number(p.id.slice(-1)) % 2,
      response = dodgeAIResponse(d.aiSeed, db.throwId, slot);
    let x = p.team === 0 ? -76 * F : 76 * F,
      y = (Number(p.id.slice(-1)) % 2 ? 1 : -1) * 37 * F;
    let c: CommandFrame = {};
    if (holder) {
      const targets = s.players
        .filter((q) => q.team !== p.team && living(s, q))
        .sort(
          (a, b) =>
            length(a.x - p.x, a.y - p.y) - length(b.x - p.x, b.y - p.y) ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
      const target =
        targets[
          (db.throwId + Number(p.id.slice(-1))) % Math.max(1, targets.length)
        ];
      x = p.team === 0 ? -42 * F : 42 * F;
      // Separate throwing lanes prevent two holders fighting the body solver.
      y = (slot ? 1 : -1) * 28 * F;
      c.aim = target
        ? (aimHeading(target.x - p.x, target.y - p.y) +
            (p.team === 0 ? response.aimError : -response.aimError) +
            256) %
          256
        : p.heading;
      const wait = s.tick - db.releaseTick;
      if (wait > 18 && !a.needsRelease && !a.pendingThrow) {
        if (!p.charging) c.strikePressed = true;
        // A lone opponent must still face deliberate powered-shot pressure.
        const duel = s.players.filter(q => living(s,q)).length === 2;
        const chargeTarget = duel && db.throwId % 3 !== 1 ? DODGE.chargeTicks : 14 + (db.throwId % 17);
        c.strikeHeld = p.chargeTicks < chargeTarget;
        if (p.charging && !c.strikeHeld) c.strikeReleased = true;
        const mate = s.players.find(
          (q) => q.team === p.team && q.id !== p.id && living(s, q),
        );
        if (
          mate &&
          !occupied(s, mate.id) &&
          !p.charging &&
          db.throwId % 4 === 1 &&
          d.possessionDeadline - s.tick > 90 &&
          s.tick > a.passAssistUntil
        ) {
          c = { pass: true, aim: c.aim };
        }
      }
    } else if (
      db.state === "dead-loose" ||
      db.state === "reset" ||
      (db.state === "friendly-pass" && db.passTarget === p.id)
    ) {
      const side =
        db.state === "friendly-pass"
          ? db.receivingTeam
          : s.ball.x === 0
            ? db.receivingTeam
            : s.ball.x < 0
              ? 0
              : 1;
      if (p.team === side) {
        const mates = s.players
          .filter((q) => q.team === p.team && living(s, q) && !occupied(s, q.id))
          .sort(
            (a, b) =>
              length(a.x - s.ball.x, a.y - s.ball.y) -
              length(b.x - s.ball.x, b.y - s.ball.y),
          );
        if (mates[0] === p || db.passTarget === p.id) {
          x = s.ball.x;
          y = s.ball.y;
        }
      }
    } else if (db.state === "hostile-flight" && p.team !== db.attackingTeam) {
      c.aim = aimHeading(s.ball.x - p.x, s.ball.y - p.y);
      const dist = length(s.ball.x - p.x, s.ball.y - p.y);
      // One deliberate response per live throw, after a bounded reaction delay.
      // Global athlete IDs cannot skew one side's observation clock.
      if (
        response.catch &&
        a.aiThrowId !== db.throwId &&
        s.tick - db.releaseTick >= response.reactionTicks &&
        dist <
          DODGE.catchReach + Math.round(length(s.ball.vx, s.ball.vy) / 10) &&
        s.tick >= a.catchReady
      ) {
        a.aiThrowId = db.throwId;
        if (!db.powered && dist < 38 * F && s.tick >= p.slideReady && response.dive)
          c.slide = true;
        else {
          c.strikePressed = true;
          c.strikeHeld = true;
        }
      }
      if (dist < 45 * F && s.tick < a.catchReady && !catchActive(s, p)) {
        y = p.y + (s.ball.vy >= 0 ? -30 : 30) * F;
        c.dash = !p.dashCooldown;
      }
    }
    const threat = d.balls.filter(b => !b.retired && b.mode.state === "hostile-flight" && b.mode.attackingTeam !== p.team)
      .sort((a,b) => length(a.physical.x-p.x,a.physical.y-p.y)-length(b.physical.x-p.x,b.physical.y-p.y))[0];
    if (holder && threat && s.tick-threat.mode.releaseTick >= response.reactionTicks && length(threat.physical.x-p.x,threat.physical.y-p.y)<55*F) {
      y=p.y+(threat.physical.vy >= 0 ? -30 : 30)*F;
      c.dash = !p.dashCooldown;
    }
    // Route around a teammate instead of pushing indefinitely into their body.
    const blocker = s.players.find(q => q.id !== p.id && q.team === p.team && living(s,q) &&
      length(q.x-p.x,q.y-p.y) < 22*F && (q.x-p.x)*(x-p.x)+(q.y-p.y)*(y-p.y)>0);
    if (blocker) {
      const lane = Number(p.id.slice(-1)) % 2 ? 1 : -1;
      y = Math.max(-78*F, Math.min(78*F, blocker.y + lane * 26 * F));
    }
    const n = normalized(x - p.x, y - p.y);
    c.moveX = Math.abs(x - p.x) > 3 * F ? n.x : 0;
    c.moveY = Math.abs(y - p.y) > 3 * F ? n.y : 0;
    out.set(p.id, c);
  }
  primary(s);
  return out;
}
export function stepDodge(
  s: State,
  humans: Map<string, CommandFrame>,
  _rng: DeterministicRandom,
) {
  const d = s.dodge!,
    commands = dodgeAI(s, humans);
  for (const [id, c] of humans) commands.set(id, c);
  for (const p of s.players) {
    const b = d.balls.find(b => !b.retired && b.mode.holderId === p.id) ?? d.balls[0];
    bind(s,b); input(s, p, commands.get(p.id) ?? {}); save(s,b);
  }
  for (let sub = 0; sub < 4 && s.phase === "play"; sub++) {
    const paths = movement(s);
    for (const b of d.balls) if (!b.retired) { bind(s,b); ballStep(s, paths); save(s,b); }
  }
  primary(s);
  for (const p of s.players) {
    if (p.slideTicks) {
      p.slideTicks--;
      if (!p.slideTicks) {
        p.slideRecovery = DODGE.diveRecovery + 1;
        ballEvent(s, "slide-recover", p);
      }
    }
    p.slideRecovery = Math.max(0, p.slideRecovery - 1);
    p.dashTicks = Math.max(0, p.dashTicks - 1);
    p.dashCooldown = Math.max(0, p.dashCooldown - 1);
    p.staggerTicks = Math.max(0, p.staggerTicks - 1);
    p.immunityTicks = Math.max(0, p.immunityTicks - 1);
    if (d.athletes[p.id].catchKind && s.tick >= d.athletes[p.id].catchReady)
      d.athletes[p.id].catchKind = null;
  }
  if (s.phase !== "play") return;
  for (const team of [0, 1] as const)
    if (!s.players.some((p) => p.team === team && living(s, p))) {
      finishRound(s, team === 0 ? 1 : 0);
      return;
    }
  for (const record of d.balls) {
  if (record.retired) continue;
  bind(s,record);
  const b = d.ball;
  if (b.state === "dead-loose") {
    const speed = length(s.ball.vx, s.ball.vy),
      next = Math.max(0, speed - (48 * F) / 60);
    if (speed) {
      s.ball.vx = Math.round((s.ball.vx * next) / speed);
      s.ball.vy = Math.round((s.ball.vy * next) / speed);
    }
    const unreachable =
      Math.abs(s.ball.x) < DODGE.halfStrip - 17 * F ||
      length(s.ball.x - b.lastX, s.ball.y - b.lastY) < F / 4;
    b.unreachableTicks = unreachable ? b.unreachableTicks + 1 : 0;
    b.lastX = s.ball.x;
    b.lastY = s.ball.y;
    if (b.unreachableTicks >= DODGE.stuckTicks) {
      const side: Team =
        s.ball.x === 0 ? b.receivingTeam : s.ball.x < 0 ? 0 : 1;
      restart(s, side, true);
      ballEvent(s, "dodge-reset", undefined, { team: side });
    }
  }
  if (
    d.possessionTeam !== null &&
    s.tick >= d.possessionDeadline - DODGE.warningTicks &&
    b.state !== "hostile-flight"
  ) {
    if (!d.transferAt) {
      d.transferAt = d.possessionDeadline;
      ballEvent(s, "dodge-possession-warning", undefined, {
        team: d.possessionTeam,
      });
    }
    if (s.tick >= d.transferAt) restart(s, d.possessionTeam === 0 ? 1 : 0);
  }
  save(s,record);
  }
  const oneEach = ([0,1] as const).every(team => s.players.filter(p => p.team === team && living(s,p)).length === 1);
  if (oneEach && d.balls.filter(b => !b.retired).length > 1) {
    const retire = d.balls.find(b => !b.retired && (b.mode.state === "dead-loose" || b.mode.state === "reset"));
    if (retire) { retire.retired = true; bind(s,retire); ballEvent(s,"dodge-ball-retired"); }
  }
  primary(s);
  const b = d.ball;
  const hostile = () => d.balls.some(b => !b.retired && b.mode.state === "hostile-flight");
  if (s.mode === "practice") return;
  if (d.subphase === "live") {
    s.remainingTicks = Math.max(0, s.remainingTicks - 1);
    if (!s.remainingTicks) {
      d.subphase = "settling";
      d.settleTicks = hostile() ? DODGE.settleTicks : 0;
    }
  }
  if (d.subphase === "settling") {
    if (hostile() && d.settleTicks > 0) d.settleTicks--;
    else {
      for (const record of d.balls) if (record.mode.state === "hostile-flight") { bind(s,record); dead(s, record.mode.receivingTeam); save(s,record); }
      primary(s);
      const winner = compare(s);
      if (winner !== null) finishRound(s, winner);
      else {
        d.subphase = "sudden-death";
        d.suddenDeathTicks = DODGE.suddenDeathTicks;
        s.overtime = true;
        ballEvent(s, "overtime");
      }
    }
  } else if (d.subphase === "sudden-death") {
    d.suddenDeathTicks--;
    s.remainingTicks = d.suddenDeathTicks;
    if (!d.suddenDeathTicks) finishRound(s, "draw");
  }
}

/** Strict bounded mode state, including lifecycle consistency and legal restores. */
function validateSingleDodgeState(s: State) {
  const d = s.dodge;
  if (s.sportId !== "crypt-dodge") {
    if (d !== null) throw Error("Dodge state belongs to Crypt Dodge");
    return;
  }
  const integer = (n: unknown, min: number, max: number) => {
    if (!Number.isSafeInteger(n) || (n as number) < min || (n as number) > max)
      throw Error("Invalid Dodge integer");
  };
  const keys = (v: object, k: string, optional: string[] = []) => {
    if (
      !v ||
      typeof v !== "object" ||
      Array.isArray(v) ||
      Object.keys(v)
        .filter((key) => !optional.includes(key))
        .sort()
        .join(",") !== k.split(",").sort().join(",")
    )
      throw Error("Invalid Dodge fields");
  };
  const origin = (o: CommandOrigin | undefined) => {
    if (
      o !== undefined &&
      (!o ||
        Object.keys(o).sort().join(",") !==
          "epoch,generation,participantId,seq" ||
        !Number.isSafeInteger(o.epoch) ||
        o.epoch < 0 ||
        !Number.isSafeInteger(o.generation) ||
        o.generation < 0 ||
        !Number.isSafeInteger(o.seq) ||
        o.seq < 0 ||
        typeof o.participantId !== "string" ||
        !o.participantId ||
        o.participantId.length > 96)
    )
      throw Error("Invalid Dodge origin");
  };
  if (
    !d ||
    d.kind !== "crypt-dodge" ||
    !["countdown", "live", "settling", "sudden-death", "round-end"].includes(
      d.subphase,
    ) ||
    ![0, 1].includes(d.openingTeam) ||
    ![0, 1, "draw", null].includes(d.roundWinner) ||
    ![0, 1, null].includes(d.possessionTeam)
  )
    throw Error("Invalid Dodge state");
  keys(
    d,
    "kind,aiSeed,subphase,round,openingTeam,roundWinner,drawnRounds,suddenDeathTicks,settleTicks,athletes,balls,ball,possessionTeam,possessionDeadline,transferAt",
  );
  integer(d.aiSeed, 0, 4294967295);
  integer(d.round, 1, 10000);
  integer(d.drawnRounds, 0, 10000);
  integer(d.suddenDeathTicks, 0, 1800);
  integer(d.settleTicks, 0, 120);
  integer(d.possessionDeadline, 0, 10000100);
  integer(d.transferAt, 0, 10000100);
  keys(d.athletes, s.players.map((p) => p.id).join(","));
  for (const p of s.players) {
    const a = d.athletes[p.id];
    keys(
      a,
      "lives,aiThrowId,catchStart,catchKind,catchReady,primaryHeld,needsRelease,collectAfter,passAssistUntil,pendingThrow",
      ["catchOrigin"],
    );
    origin(a.catchOrigin);
    integer(a.lives, 0, 3);
    integer(a.aiThrowId, -1, Math.max(...d.balls.map(b => b.mode.throwId)));
    integer(a.catchStart, -1, s.tick);
    integer(a.catchReady, 0, 10000100);
    integer(a.collectAfter, 0, 10000100);
    integer(a.passAssistUntil, 0, 10000100);
    if (
      ![null, "standing", "dive"].includes(a.catchKind) ||
      typeof a.primaryHeld !== "boolean" ||
      typeof a.needsRelease !== "boolean"
    )
      throw Error("Invalid Dodge catch");
    if (p.team === 0 ? p.x > -DODGE.halfStrip : p.x < DODGE.halfStrip)
      throw Error("Dodge athlete crossed center");
    if (Math.abs(p.x) > 159 * F || Math.abs(p.y) > 89 * F)
      throw Error("Dodge athlete outside court");
    if (a.pendingThrow) {
      keys(a.pendingThrow, "releaseTick,heading,charge", ["origin"]);
      integer(a.pendingThrow.releaseTick, s.tick, 10000100);
      integer(a.pendingThrow.heading, 0, 255);
      integer(a.pendingThrow.charge, 0, 30);
      origin(a.pendingThrow.origin);
    }
  }
  const b = d.ball;
  keys(
    b,
    "powered,state,holderId,attackingTeam,throwId,releaseTick,hitClaim,receivingTeam,passTarget,passerId,unreachableTicks,lastX,lastY",
    ["origin"],
  );
  origin(b.origin);
  if (
    ![
      "held",
      "friendly-pass",
      "hostile-flight",
      "dead-loose",
      "reset",
    ].includes(b.state) ||
    ![0, 1, null].includes(b.attackingTeam) ||
    ![0, 1].includes(b.receivingTeam)
  )
    throw Error("Invalid Dodge ball");
  for (const id of [b.holderId, b.hitClaim, b.passTarget, b.passerId])
    if (id !== null && !s.players.some((p) => p.id === id))
      throw Error("Invalid Dodge reference");
  integer(b.throwId, 0, 10000000);
  integer(b.releaseTick, 0, s.tick);
  integer(b.unreachableTicks, 0, 90);
  integer(b.lastX, -200000, 200000);
  integer(b.lastY, -200000, 200000);
  if (
    (b.state === "held") !== (b.holderId !== null) ||
    s.possessionId !== b.holderId ||
    (b.state === "hostile-flight") !== (b.attackingTeam !== null)
  )
    throw Error("Invalid Dodge ball lifecycle");
  if (
    b.holderId &&
    (!d.athletes[b.holderId].lives ||
      s.ball.lastTouch !== b.holderId ||
      s.ball.vx ||
      s.ball.vy ||
      s.ball.vz ||
      s.players.find((p) => p.id === b.holderId)!.team !== d.possessionTeam ||
      d.possessionTeam !== b.receivingTeam)
  )
    throw Error("Invalid Dodge holder");
  if (
    Math.abs(s.ball.x) > (b.state === "held" ? 173 : 161) * F ||
    Math.abs(s.ball.y) > (b.state === "held" ? 103 : 91) * F
  )
    throw Error("Dodge ball outside court");
  if (
    b.state === "friendly-pass" &&
    (!b.passTarget ||
      !b.passerId ||
      s.players.find((p) => p.id === b.passTarget)!.team !== b.receivingTeam ||
      s.players.find((p) => p.id === b.passerId)!.team !== b.receivingTeam ||
      b.passTarget === b.passerId)
  )
    throw Error("Invalid Dodge pass");
  if (s.specials.some((t) => t.active)) throw Error("Dodge specials disabled");
  if (s.score.some((n) => n > 2)) throw Error("Invalid Dodge rounds");
}

export function validateDodgeState(s: State) {
  const d = s.dodge;
  if (s.sportId !== "crypt-dodge") return validateSingleDodgeState(s);
  if (!d || !Array.isArray(d.balls) || d.balls.length !== 2) throw Error("Invalid Dodge balls");
  if (JSON.stringify(d.ball) !== JSON.stringify(d.balls[0].mode) || JSON.stringify(s.ball) !== JSON.stringify(d.balls[0].physical) || s.possessionId !== d.balls[0].mode.holderId || d.possessionTeam !== d.balls[0].possessionTeam || d.possessionDeadline !== d.balls[0].possessionDeadline || d.transferAt !== d.balls[0].transferAt) throw Error("Invalid Dodge primary alias");
  const holders = new Set<string>();
  for (const [i,b] of d.balls.entries()) {
    if (!b || Object.keys(b).sort().join(",") !== "id,mode,physical,possessionDeadline,possessionTeam,retired,transferAt" || b.id !== `dodge-${i}` || typeof b.retired !== "boolean" || typeof b.mode?.powered !== "boolean") throw Error("Invalid Dodge ball identity");
    if (b.retired && !["dead-loose","reset"].includes(b.mode.state)) throw Error("Retired live Dodge ball");
    if (b.mode.holderId) { if (holders.has(b.mode.holderId)) throw Error("Duplicate Dodge holder"); holders.add(b.mode.holderId); }
    if (!b.physical || Object.keys(b.physical).sort().join(",") !== Object.keys(d.balls[0].physical).sort().join(",") || Object.values(b.physical).some(v => typeof v === "number" && (!Number.isSafeInteger(v) || Math.abs(v) > 100000000))) throw Error("Invalid Dodge physics");
    for (const key of ["x","y","z","vx","vy","vz","rx","ry","rz","dragCarry","passTick","bankBonusRemaining","powerExpires"] as const) {
      if (!Number.isSafeInteger(b.physical[key])) throw Error("Invalid Dodge physics number");
    }
    for (const key of ["lastTouch","passFrom","passTarget"] as const) {
      if (b.physical[key] !== null && !s.players.some(p => p.id === b.physical[key])) throw Error("Invalid Dodge physical reference");
    }
    for (const key of ["passTeam","powerTeam"] as const) if (![null,0,1].includes(b.physical[key])) throw Error("Invalid Dodge physical team");
    if (b.physical.z < 0 || b.physical.z > 36*F || Math.abs(b.physical.vx)>360*F || Math.abs(b.physical.vy)>360*F) throw Error("Invalid Dodge flight bounds");
    const candidate = { ...s, dodge: { ...d } };
    bind(candidate,b); validateSingleDodgeState(candidate);
  }
  if (d.balls.every(b => b.retired)) throw Error("No active Dodge ball");
  primary(s);
}
