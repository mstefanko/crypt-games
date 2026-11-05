import {
  clearSpecials,
  specialKind,
  playerSpecial,
  specialSuccess,
  stopSpecial,
} from "../specials";
import {
  advanceFixedAxis,
  predictFixedFlightLanding,
  solveFixedFlightLaunch,
  closedSegmentAabbInterval,
} from "@onepage/game-simulation/fixed-flight";
import {
  actionPhase,
  claimActionHit,
} from "@onepage/game-simulation/action-timeline";
import { queryCircleGeometry } from "@onepage/game-simulation/circle-geometry";
import type { Ball, CommandFrame, Player, State, Team } from "../contract";
import {
  admitAction,
  event,
  finishActions,
  recordStat,
  steer,
} from "../actions";
import { movePlayers, type Trajectory } from "../motion";
import { finishMatch } from "../match";
import { aimHeading, FIXED as F, headingVector, length } from "../rules";
import { COURT } from "../spec";
import { SPORT_BALL_PROFILES, VOLLEY_RULES } from "../sports-spec";
import type { DeterministicRandom } from "@onepage/game-simulation/random";

const VOLLEY_FLIGHT = Object.freeze({
  frequency: 240,
  gravityPerStep: (VOLLEY_RULES.gravity * F) / 240,
});
const opposite = (team: Team): Team => (team === 0 ? 1 : 0);
const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  length(a.x - b.x, a.y - b.y);
function volleyClamp(p: Player) {
  p.x =
    p.team === 0 ? clamp(p.x, -159 * F, -10 * F) : clamp(p.x, 10 * F, 159 * F);
  p.y = clamp(p.y, -89 * F, 89 * F);
}
/** Free-flight landing only: no future contacts, walls, or net intervention. */
export function predictVolleyLanding(ball: Ball) {
  return predictFixedFlightLanding(ball, {
    ...VOLLEY_FLIGHT,
    floor: SPORT_BALL_PROFILES["rift-volley"].radius * F,
    maxSteps: 600,
  });
}
function volleyAI(s: State, p: Player, rng: DeterministicRandom): CommandFrame {
  const v = s.volley!,
    b = s.ball,
    side = p.team === 0 ? -1 : 1;
  const server = s.players.find((q) => q.team === v.serveTeam)!;
  if (v.serving) {
    if (p.id === server.id)
      return { aim: p.team === 0 ? 0 : 128, strikePressed: v.serveTicks >= 30 };
    return {};
  }
  const future = predictVolleyLanding(b);
  const mates = s.players.filter(
    (q) => q.team === p.team && q.id !== v.lastContactId,
  );
  const receiver = mates
    .slice()
    .sort(
      (a, c) =>
        distance(a, future) - distance(c, future) ||
        (a.id < c.id ? -1 : a.id > c.id ? 1 : 0),
    )[0];
  const inHalf = (b.x < 0 ? 0 : 1) === p.team;
  let tx = side * (p.id.endsWith("0") || p.id.endsWith("2") ? 105 : 48) * F,
    ty = p.id.endsWith("0") || p.id.endsWith("2") ? -26 * F : 34 * F;
  if (receiver?.id === p.id && (inHalf || side * b.vx < 0)) {
    // Track the current shadow while contact is possible, otherwise intercept its landing.
    tx = inHalf && b.z < 65 * F ? b.x : clamp(future.x, -145 * F, 145 * F);
    ty = inHalf && b.z < 65 * F ? b.y : clamp(future.y, -80 * F, 80 * F);
  }
  tx = side * clamp(side * tx, 12 * F, 150 * F);
  p.aiX = Math.round(tx);
  p.aiY = Math.round(ty);
  p.aiRole = receiver?.id === p.id ? "intercept" : "support";
  const attack =
    v.teamContacts >= 2 ||
    (v.lastContactTeam === p.team &&
      v.teamContacts >= 1 &&
      Math.abs(p.x) < 76 * F);
  const plannedKind: ContactKind = attack
    ? "attack"
    : b.z <= 14 * F
      ? "dig"
      : "set";
  const reach = volleyReach(plannedKind);
  const reachable =
    inHalf &&
    distance(p, b) <= reach.radius &&
    b.z >= SPORT_BALL_PROFILES["rift-volley"].radius * F &&
    b.z <= reach.maxHeight &&
    p.id !== v.lastContactId &&
    s.tick - v.contactTick >= 8;
  if (reachable && attack && s.tick >= p.aiNext) {
    const opponents = s.players.filter((q) => q.team !== p.team);
    const targetX = -side * 125 * F;
    const space = (y: number) =>
      Math.min(...opponents.map((q) => distance(q, { x: targetX, y })));
    const targetY = (space(-70 * F) > space(70 * F) ? -70 : 70) * F;
    p.aiAim =
      (aimHeading(targetX - b.x, targetY - b.y) +
        rng.drawInteger("cryptball", "ai", 7) -
        3 +
        256) %
      256;
    p.aiNext = s.tick + 24;
  }
  return {
    moveX: tx - p.x,
    moveY: ty - p.y,
    aim: reachable && attack ? p.aiAim : p.team === 0 ? 0 : 128,
    strikePressed: reachable && attack,
    pass: reachable && !attack && plannedKind === "set",
    slide: reachable && !attack && plannedKind === "dig",
  };
}
function volleyPoint(s: State, winner: Team, reason: string) {
  const v = s.volley!;
  clearSpecials(s);
  s.score[winner]++;
  const scorer = s.players.find(
    (p) => p.id === s.ball.lastTouch && p.team === winner,
  );
  if (scorer) recordStat(s, scorer, "goals");
  else s.teamStats[winner].goals++;
  s.stats = s.teamStats[0];
  s.goalTeam = winner;
  v.serveTeam = winner;
  v.serving = false;
  v.rally++;
  s.ball.vx = s.ball.vy = s.ball.vz = 0;
  s.ball.rx = s.ball.ry = s.ball.rz = 0;
  event(s, "rally-point", scorer, {
    team: winner,
    reason,
    x: s.ball.x,
    y: s.ball.y,
  });
  if (
    s.mode === "match" &&
    s.score[winner] >= VOLLEY_RULES.target &&
    (s.score[winner] - s.score[opposite(winner)] >= 2 ||
      s.score[winner] >= VOLLEY_RULES.cap)
  ) {
    finishMatch(s);
    return;
  }
  s.phase = "goal";
  s.phaseTicks = 45;
}
type ContactKind = "attack" | "set" | "dig" | "serve";
/** Actor reach surfaces plus the physical ball radius. Height is center-z. */
function volleyReach(kind: ContactKind) {
  const ballRadius = SPORT_BALL_PROFILES["rift-volley"].radius * F;
  return {
    radius:
      (kind === "dig" ? 23 : kind === "attack" ? 21 : 19) * F + ballRadius,
    maxHeight:
      (kind === "dig" ? 11 : kind === "set" ? 45 : 65) * F + ballRadius,
  };
}
function contactKind(s: State, p: Player): ContactKind | null {
  if (p.slideTicks && !p.checked) return "dig";
  if (
    p.action &&
    actionPhase(p.action).phase === "active" &&
    !p.action.hits.includes("ball")
  )
    return s.volley!.serving
      ? "serve"
      : p.action.kind === "pass"
        ? "set"
        : "attack";
  return null;
}
function volleyContact(s: State, p: Player, kind: ContactKind) {
  const v = s.volley!,
    b = s.ball;
  const incoming = { incomingVx: b.vx, incomingVy: b.vy, incomingVz: b.vz };
  if (p.action) claimActionHit(p.action, "ball");
  if (kind === "dig") p.checked = true;
  if (!v.serving && v.lastContactTeam === p.team && v.lastContactId === p.id) {
    volleyPoint(s, opposite(p.team), "double-touch");
    return;
  }
  if (!v.serving && v.lastContactTeam === p.team && v.teamContacts >= 3) {
    volleyPoint(s, opposite(p.team), "four-contacts");
    return;
  }
  const special = playerSpecial(s, p),
    ability = specialKind(s, p);
  if (ability === "gators" && kind === "dig") {
    specialSuccess(s, p, "ball");
    stopSpecial(s, p);
  }
  if (
    ability === "owls" &&
    special &&
    !special.receptionUsed &&
    (kind === "set" || kind === "dig")
  ) {
    special.receptionUsed = true;
    specialSuccess(s, p, "receive");
  }
  const serving = v.serving;
  v.teamContacts = serving
    ? 0
    : v.lastContactTeam === p.team
      ? v.teamContacts + 1
      : 1;
  v.lastContactId = p.id;
  v.lastContactTeam = p.team;
  v.contactTick = s.tick;
  v.serving = false;
  b.lastTouch = p.id;
  s.touchTick = s.tick;
  s.restartTeam = null;
  const mate = s.players.find((q) => q.team === p.team && q.id !== p.id)!;
  let tx: number, ty: number, ticks: number;
  if ((kind === "set" || kind === "dig") && v.teamContacts < 3) {
    tx = clamp(
      mate.x,
      (p.team === 0 ? -145 : 28) * F,
      (p.team === 0 ? -28 : 145) * F,
    );
    ty = clamp(mate.y, -70 * F, 70 * F);
    ticks = kind === "dig" ? 72 : 64;
    recordStat(s, p, "passes");
  } else {
    const aim = headingVector(p.heading);
    const charge = p.action?.charge ?? 0;
    tx = (p.team === 0 ? 1 : -1) * (110 + Math.round((charge * 20) / 24)) * F;
    ty = clamp(
      b.y +
        Math.round(
          aim.x && (p.team === 0 ? aim.x > 0 : aim.x < 0)
            ? ((tx - b.x) * aim.y) / aim.x
            : (aim.y * 70 * F) / 65536,
        ),
      -72 * F,
      72 * F,
    );
    ticks = (b.z > 32 * F ? 48 : 66) - Math.round(charge / 2);
    recordStat(s, p, "shots");
  }
  b.vx = Math.round(((tx - b.x) * 60) / ticks);
  b.vy = Math.round(((ty - b.y) * 60) / ticks);
  b.vz = solveFixedFlightLaunch({
    height: b.z,
    floor: SPORT_BALL_PROFILES["rift-volley"].radius * F,
    steps: ticks * 4,
    ...VOLLEY_FLIGHT,
  });
  b.rx = b.ry = b.rz = 0;
  event(s, "volley-contact", p, {
    kind: serving ? "serve" : kind,
    x: b.x,
    y: b.y,
    height: b.z,
    ...incoming,
    vx: b.vx,
    vy: b.vy,
    vz: b.vz,
    contacts: v.teamContacts,
  });
}
interface VolleyHit {
  t: number;
  priority: number;
  reason?: string;
  player?: Player;
  kind?: ContactKind;
}
/** Swept planar player contacts and net/floor/wall faults share one substep clock.
 * Earliest time wins; world faults win exact ties, then authored athlete order. */
function moveVolleyBall(s: State, paths: Trajectory[]) {
  const b = s.ball,
    v = s.volley!;
  const ballRadius = SPORT_BALL_PROFILES["rift-volley"].radius * F;
  b.vz -= VOLLEY_FLIGHT.gravityPerStep;
  let remaining = 1;
  for (
    let budget = 0;
    budget < 2 && remaining > 0 && s.phase === "play";
    budget++
  ) {
    const xStep = advanceFixedAxis(b.vx, b.rx, 240, remaining),
      yStep = advanceFixedAxis(b.vy, b.ry, 240, remaining),
      zStep = advanceFixedAxis(b.vz, b.rz, 240, remaining);
    const dx = xStep.delta,
      dy = yStep.delta,
      dz = zStep.delta;
    b.rx = xStep.remainder;
    b.ry = yStep.remainder;
    b.rz = zStep.remainder;
    const hits: VolleyHit[] = [];
    if (b.z < ballRadius || (b.z + dz <= ballRadius && dz < 0))
      hits.push({
        t: b.z <= ballRadius ? 0 : clamp((ballRadius - b.z) / dz, 0, 1),
        priority: 0,
        reason: "floor",
      });
    for (const [position, delta, limit] of [
      [b.x, dx, COURT.halfLength * F - ballRadius],
      [b.y, dy, COURT.halfWidth * F - ballRadius],
    ]) {
      if (delta > 0 && position + delta >= limit)
        hits.push({
          t: clamp((limit - position) / delta, 0, 1),
          priority: 0,
          reason: "wall",
        });
      if (delta < 0 && position + delta <= -limit)
        hits.push({
          t: clamp((-limit - position) / delta, 0, 1),
          priority: 0,
          reason: "wall",
        });
    }
    // Intersect the horizontal net slab and the interval below its top. This
    // also catches a vertical drop and a descending graze after a high entry.
    const net = closedSegmentAabbInterval(
      { x: b.x, y: b.z },
      { x: dx, y: dz },
      {
        minX: -ballRadius,
        maxX: ballRadius,
        minY: -ballRadius,
        maxY: VOLLEY_RULES.netHeight * F + ballRadius,
      },
    );
    if (net) hits.push({ t: net.enter, priority: 0, reason: "net" });
    for (const [i, path] of paths.entries()) {
      const p = path.player,
        kind = contactKind(s, p);
      if (!kind) continue;
      const reach = volleyReach(kind),
        ability = specialKind(s, p);
      const radius = reach.radius,
        maxHeight = reach.maxHeight;
      // A directed extension keeps both circle primitives within the geometry
      // kernel's 16px radius limit; enlarging an omnidirectional aura would not.
      const extension =
        ability === "gators" && kind === "dig" ? Math.round(radius * 0.35) : 0;
      const direction = headingVector(p.slideHeading);
      const px =
          path.x +
          path.dx * (1 - remaining) +
          Math.round((direction.x * extension) / 65536),
        py =
          path.y +
          path.dy * (1 - remaining) +
          Math.round((direction.y * extension) / 65536);
      let t: number | undefined;
      if (length(b.x - px, b.y - py) <= radius) t = 0;
      else {
        const contact = queryCircleGeometry(
          [
            {
              bodyId: p.id,
              shapeId: "volley-reach",
              owner: "players",
              category: "actor",
              region: "body",
              sensor: true,
              priority: 1,
              kind: "circle",
              circle: {
                x: Math.round(px),
                y: Math.round(py),
                radius: 16 * F,
              },
            },
          ],
          {
            kind: "sweep",
            circle: { x: b.x, y: b.y, radius: radius - 16 * F },
            delta: {
              x: Math.round(dx - path.dx * remaining),
              y: Math.round(dy - path.dy * remaining),
            },
          },
        ).contacts[0];
        if (contact) t = contact.time.n / contact.time.d;
      }
      if (
        t !== undefined &&
        b.z + dz * t >= 0 &&
        b.z + dz * t <= maxHeight &&
        (b.x + dx * t < 0 ? 0 : 1) === p.team
      )
        hits.push({ t, priority: i + 1, player: p, kind });
    }
    hits.sort((a, c) => a.t - c.t || a.priority - c.priority);
    const hit = hits[0];
    if (!hit) {
      b.x += dx;
      b.y += dy;
      b.z += dz;
      return;
    }
    b.x += Math.round(dx * hit.t);
    b.y += Math.round(dy * hit.t);
    b.z = Math.max(ballRadius, b.z + Math.round(dz * hit.t));
    if (hit.reason) {
      const loser =
        hit.reason === "floor"
          ? b.x < 0
            ? 0
            : 1
          : (v.lastContactTeam ?? v.serveTeam);
      volleyPoint(s, opposite(loser as Team), hit.reason);
      return;
    }
    volleyContact(s, hit.player!, hit.kind!);
    remaining *= 1 - hit.t;
  }
}
export function stepVolley(
  s: State,
  humans: Map<string, CommandFrame>,
  rng: DeterministicRandom,
) {
  const v = s.volley!;
  if (v.serving) v.serveTicks++;
  for (const p of s.players) {
    const c = humans.get(p.id) ?? volleyAI(s, p, rng);
    const previous = p.action;
    admitAction(s, p, c);
    // Forgiveness is additional time for the requested set, never extra reach/contact.
    if (
      p.action &&
      p.action !== previous &&
      p.action.kind === "pass" &&
      specialKind(s, p) === "owls" &&
      !playerSpecial(s, p)?.receptionUsed
    )
      p.action.timing.active += 4;
    steer(p, c, s.config, s);
  }
  for (let sub = 0; sub < 4 && s.phase === "play"; sub++) {
    const paths = movePlayers(s.players);
    for (const path of paths) {
      volleyClamp(path.player);
      path.dx = path.player.x - path.x;
      path.dy = path.player.y - path.y;
    }
    if (v.serving) {
      const server = s.players.find((p) => p.team === v.serveTeam)!;
      s.ball.x = server.x + (server.team === 0 ? 11 : -11) * F;
      s.ball.y = server.y;
      s.ball.z = 14 * F;
      const kind = contactKind(s, server);
      if (kind && kind !== "dig") volleyContact(s, server, "serve");
    }
    if (!v.serving) moveVolleyBall(s, paths);
  }
  if (s.phase !== "play") return;
  if (v.serving && v.serveTicks >= VOLLEY_RULES.serveTimeout) {
    volleyPoint(s, opposite(v.serveTeam), "serve-timeout");
    return;
  }
  finishActions(s);
}
