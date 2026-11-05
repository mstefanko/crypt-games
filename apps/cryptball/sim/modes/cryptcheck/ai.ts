import type { CommandFrame, Player, State, Team } from "../../contract";
import type { DeterministicRandom } from "@onepage/game-simulation/random";
import { aimHeading, FIXED as F, headingVector, length } from "../../rules";
import { predictBall, clearLane } from "../../prediction";
import { groundBallPhysics } from "../../sports-spec";
import { bladeAnchor, bladeContains } from "./control";
import { HOCKEY } from "./spec";

type Point = { x: number; y: number };
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const dist = (a: Point, b: Point) => length(a.x - b.x, a.y - b.y);
const legal = (point: Point): Point => ({
  x: Math.round(clamp(point.x, -154 * F, 154 * F)),
  y: Math.round(clamp(point.y, -78 * F, 78 * F)),
});
const available = (s: State, p: Player) =>
  !p.action && !p.charging && !p.dashTicks && !p.slideTicks &&
  !p.slideRecovery && !p.staggerTicks && !s.hockey!.skaters[p.id].check &&
  !s.hockey!.skaters[p.id].downTicks;

function segmentDistance(point: Point, from: Point, to: Point) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const t = clamp(((point.x - from.x) * dx + (point.y - from.y) * dy) /
    (dx * dx + dy * dy || 1), 0, 1);
  return dist(point, { x: from.x + dx * t, y: from.y + dy * t });
}
function bodyRoute(s: State, p: Player, to: Point, exclude: string[] = []) {
  return s.players.every((q) => q.id === p.id || exclude.includes(q.id) ||
    segmentDistance(q, p, to) >= 17 * F);
}
/** Approximate arrival includes acceleration, existing approach velocity, facing,
 * unavailable actions and bodies. It ranks intent; movement stays in skate(). */
function arrival(s: State, p: Player, target: Point) {
  const dx = target.x - p.x, dy = target.y - p.y, d = length(dx, dy);
  const closing = d ? (p.vx * dx + p.vy * dy) / d : 0;
  const facing = headingVector(p.heading);
  const alignment = d ? (facing.x * dx + facing.y * dy) / (65536 * d) : 1;
  return Math.max(0, d - HOCKEY.controlOffset * F) * 60 / (HOCKEY.cruise * F) +
    Math.max(0, HOCKEY.cruise * F - closing) * 30 / (HOCKEY.push * F) +
    (1 - alignment) * 4 + (available(s, p) ? 0 : 30) +
    (bodyRoute(s, p, target) ? 0 : 12);
}
function humanPursuing(p: Player, target: Point, frame: CommandFrame | undefined) {
  const dx = target.x - p.x, dy = target.y - p.y;
  if (frame?.moveX || frame?.moveY)
    return (frame.moveX ?? 0) * dx + (frame.moveY ?? 0) * dy > 0;
  return p.vx * dx + p.vy * dy > 12 * F * Math.max(F, length(dx, dy));
}
function collector(s: State, team: Team, humans: Map<string, CommandFrame>, owner: Player | undefined) {
  const intent = s.hockey!.aiTeams[team], target = s.ball;
  const controlled = new Set(s.controllers.filter((c) => c.active).map((c) => c.playerId));
  const candidates = s.players.filter((p) => p.team === team &&
    !(s.mode === "practice" && team === 1) &&
    !s.hockey!.skaters[p.id].downTicks &&
    (!controlled.has(p.id) || humanPursuing(p, target, humans.get(p.id))));
  if (owner?.team === team) {
    // Carrying has no loose-puck collector. Clear the old progress sample so a
    // turnover or new pass is elected from its current geometry immediately.
    intent.collectorId = null;
    intent.until = intent.progressTick = s.tick;
    intent.progressDistance = 0;
    return owner.id;
  }
  let current = candidates.find((p) => p.id === intent.collectorId);
  const distance = current ? dist(current, target) : 0;
  if (current && distance < intent.progressDistance - 3 * F) {
    intent.progressTick = s.tick;
    intent.progressDistance = Math.round(distance);
  }
  const stalled = !!current && s.tick - intent.progressTick >= 30;
  if (current && available(s, current) && !stalled && s.tick < intent.until)
    return current.id;
  if (stalled) intent.approachSide = intent.approachSide === 1 ? -1 : 1;
  // A valid, recent pass offers a small arrival bonus, never a reservation that
  // can prevent the other skater helping a blocked or absent receiver.
  const score = (p: Player) => arrival(s, p, target) -
    (target.passTeam === team && target.passTarget === p.id &&
      s.tick - target.passTick < 36 && available(s, p) ? 8 : 0);
  const alternatives = stalled ? candidates.filter((p) => p.id !== current!.id && available(s, p)) : candidates;
  const ranked = (alternatives.length ? alternatives : candidates).slice().sort((a, b) =>
    score(a) - score(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const chosen = ranked[0];
  if (chosen) {
    // Re-election without progress does not extend the stall timeout.
    if (chosen.id !== intent.collectorId || stalled || !current) {
      intent.progressTick = s.tick;
      intent.progressDistance = Math.round(dist(chosen, target));
    }
    intent.collectorId = chosen.id;
    intent.until = s.tick + 30;
  } else {
    intent.collectorId = null;
    intent.until = s.tick;
  }
  return chosen?.id;
}
function supportTarget(s: State, p: Player, carrier: Player) {
  const direction = p.team === 0 ? 1 : -1, physics = groundBallPhysics("cryptcheck");
  const options = [-1, 1].map((side) => legal({
    x: clamp(carrier.x + direction * 36 * F, -132 * F, 132 * F),
    y: clamp(carrier.y + side * 38 * F, -65 * F, 65 * F),
  }));
  const score = (point: Point) =>
    (clearLane(s.ball, point, s.players, [p.id, carrier.id], physics) ? 100 * F : 0) +
    Math.min(45 * F, ...s.players.filter((q) => q.team !== p.team).map((q) => dist(q, point))) -
    dist(p, point) / 8;
  return options.sort((a, b) => score(b) - score(a))[0];
}
/** Pick a bounded route around the first obstructing body, then separate before
 * physics. Persistent approach side prevents a symmetric left/right oscillation. */
function approach(s: State, p: Player, target: Point) {
  let point = legal(target);
  const dx = point.x - p.x, dy = point.y - p.y, d = length(dx, dy);
  const blockers = s.players.filter((q) => q.id !== p.id &&
    (q.x - p.x) * dx + (q.y - p.y) * dy > 0 &&
    dist(q, p) < d + 8 * F && segmentDistance(q, p, point) < 18 * F)
    .sort((a, b) => dist(a, p) - dist(b, p));
  const blocker = blockers[0];
  if (blocker && d > 0) {
    const side = s.hockey!.aiTeams[p.team].approachSide;
    const options = [side, -side].map((sign) => legal({
      x: blocker.x - dy * sign * 24 * F / d,
      y: blocker.y + dx * sign * 24 * F / d,
    }));
    const cost = (candidate: Point, index: number) =>
      dist(p, candidate) + dist(candidate, point) + index * 6 * F +
      (bodyRoute(s, p, candidate, [blocker.id]) ? 0 : 30 * F) +
      (dist(candidate, blocker) < 20 * F ? 80 * F : 0);
    const ranked = options.map((candidate, index) => ({ candidate, cost: cost(candidate, index) }));
    ranked.sort((a, b) => a.cost - b.cost);
    point = ranked[0].candidate;
  }
  for (const q of s.players) {
    if (q.id === p.id) continue;
    const space = dist(p, q);
    if (space > 0 && space < 19 * F) {
      point.x += (p.x - q.x) * (19 * F - space) / space;
      point.y += (p.y - q.y) * (19 * F - space) / space;
    }
  }
  return legal(point);
}
function escapeTarget(s: State, p: Player) {
  const direction = p.team === 0 ? 1 : -1;
  const options = [
    { x: direction * 36 * F, y: -p.y / 4 },
    { x: direction * 20 * F, y: -34 * F },
    { x: direction * 20 * F, y: 34 * F },
    { x: 0, y: -38 * F }, { x: 0, y: 38 * F },
    { x: -direction * 20 * F, y: -28 * F },
    { x: -direction * 20 * F, y: 28 * F },
  ].map((offset) => legal({ x: p.x + offset.x, y: p.y + offset.y }));
  const score = (point: Point) => {
    const separation = Math.min(50 * F, ...s.players.filter((q) => q.team !== p.team).map((q) => dist(q, point)));
    return separation + direction * (point.x - p.x) / 4 - Math.abs(point.y) / 12 +
      (bodyRoute(s, p, point) ? 70 * F : -70 * F);
  };
  return options.sort((a, b) => score(b) - score(a))[0];
}
/** Role/progress intentions live in canonical hockey state. Human input informs
 * assignment but is never replaced; all actual steering uses ordinary skating. */
export function hockeyAI(s: State, rng: DeterministicRandom, humans = new Map<string, CommandFrame>()) {
  const commands = new Map<string, CommandFrame>(), b = s.ball;
  const physics = groundBallPhysics("cryptcheck");
  const forecast = predictBall(b, 45, s.tick, physics);
  const owner = s.players.find((p) => p.id === s.possessionId);
  const collectors = [collector(s, 0, humans, owner), collector(s, 1, humans, owner)];
  for (const p of s.players) {
    const direction = p.team === 0 ? 1 : -1, skater = s.hockey!.skaters[p.id];
    p.aiRole = owner?.id === p.id ? "feed" : owner?.team === p.team ? "support" :
      collectors[p.team] === p.id ? "intercept" : "defend-lane";
    if (humans.has(p.id)) continue;
    let target: Point = b, aim = aimHeading(b.x - p.x, b.y - p.y);
    let pass = false, strike = false, poke = false, dash = false, check = false;
    if (owner?.id === p.id) {
      const goal = { x: direction * 173 * F, y: 0 };
      const mate = s.players.find((q) => q.team === p.team && q.id !== p.id)!;
      const pressure = s.players.some((q) => q.team !== p.team && dist(q, p) < 32 * F);
      target = pressure ? escapeTarget(s, p) : legal({ x: direction * 142 * F, y: clamp(-p.y / 2, -25 * F, 25 * F) });
      const decision = available(s, p) && s.tick >= p.aiNext && s.tick >= p.actionReady;
      pass = decision && pressure && available(s, mate) && dist(p, mate) > 30 * F &&
        direction * mate.x > direction * p.x - 30 * F &&
        clearLane(b, mate, s.players, [p.id, mate.id], physics);
      strike = decision && !pass &&
        (direction * p.x > 24 * F || (pressure && direction * p.x > -36 * F)) &&
        clearLane(b, goal, s.players, [p.id], physics);
      if (pass) {
        const travel = Math.min(0.2, dist(mate, b) / (HOCKEY.passSpeed * F));
        aim = aimHeading(mate.x + Math.round(mate.vx * travel) - b.x,
          mate.y + Math.round(mate.vy * travel) - b.y);
      } else aim = aimHeading(goal.x - b.x, goal.y - b.y);
      const aligned = dist(bladeAnchor(p, HOCKEY.controlOffset, aim), b) <= 7 * F;
      pass &&= aligned;
      strike &&= aligned;
      dash = pressure && decision && !pass && !strike && !p.dashCooldown &&
        dist(p, target) > 28 * F && bodyRoute(s, p, target);
      if (dash) aim = aimHeading(target.x - p.x, target.y - p.y);
      if (pass || strike) {
        p.aiNext = s.tick + 30 + rng.drawInteger("cryptball", "ai", 20);
        if (strike) {
          aim = aimHeading(goal.x - b.x, (rng.drawInteger("cryptball", "ai", 17) - 8) * F - b.y);
          p.aiAim = aim;
        }
      }
    } else if (owner?.team === p.team) {
      target = supportTarget(s, p, owner);
    } else if (collectors[p.team] !== p.id) {
      target = legal({ x: clamp(b.x - direction * 46 * F, -140 * F, 140 * F), y: clamp(b.y / 2, -42 * F, 42 * F) });
    } else {
      if (!owner) for (const point of forecast) {
        if (arrival(s, p, point) <= point.tick) { target = point; break; }
      }
      const heading = aimHeading(target.x - p.x, target.y - p.y);
      const anchor = bladeAnchor({ ...p, x: 0, y: 0 }, HOCKEY.controlOffset, heading);
      target = legal({ x: target.x - anchor.x, y: target.y - anchor.y });
      poke = !!owner && owner.team !== p.team && available(s, p) &&
        s.tick >= p.aiSlideUntil && s.tick >= p.slideReady && s.tick >= p.actionReady && bladeContains(p, b);
      if (poke) p.aiSlideUntil = s.tick + HOCKEY.pokeTell + HOCKEY.pokeActive + HOCKEY.pokeRecovery + 12;
      if (owner && owner.team !== p.team && available(s, p) && !poke &&
        s.tick >= p.aiNext && s.tick >= p.actionReady && !owner.immunityTicks && dist(p, owner) > 20 * F && dist(p, owner) < 42 * F) {
        const dx = owner.x - p.x, dy = owner.y - p.y, d = length(dx, dy);
        const closing = (p.vx * dx + p.vy * dy) / Math.max(F, d);
        check = closing > 35 * F && bodyRoute(s, p, owner, [owner.id]);
        if (check) { aim = aimHeading(dx, dy); p.aiNext = s.tick + 60; }
      }
      if (!owner && available(s, p) && s.tick >= p.aiNext && s.tick >= p.actionReady && bladeContains(p, b) &&
        length(b.vx, b.vy) > HOCKEY.receiveSpeed * F && direction * p.x > -50 * F) {
        aim = aimHeading(direction * 173 * F - b.x, -b.y);
        strike = true;
        p.aiNext = s.tick + 36;
      }
    }
    // A committed dash/check uses its selected clear direction. Other movement
    // can use local routes without changing blade aim toward the actual puck.
    target = dash || check ? legal(target) : approach(s, p, target);
    const dx = target.x - p.x, dy = target.y - p.y, speed = length(p.vx, p.vy);
    const stopping = speed * speed / (2 * HOCKEY.brake * F);
    const brake = dx * p.vx + dy * p.vy > 0 && length(dx, dy) <= stopping + 3 * F;
    const settled = length(dx, dy) < 3 * F;
    const frame: CommandFrame = {
      moveX: Math.round(clamp(brake || (settled && speed > 3 * F) ? -p.vx : settled ? 0 : dx, -65536, 65536)),
      moveY: Math.round(clamp(brake || (settled && speed > 3 * F) ? -p.vy : settled ? 0 : dy, -65536, 65536)),
      aim, pass, strikePressed: strike, slide: poke, dash, check,
    };
    if (p.charging) {
      frame.aim = p.aiAim;
      frame.pass = frame.slide = frame.strikePressed = frame.dash = frame.check = false;
      frame.strikeHeld = p.chargeTicks < 24;
      frame.strikeReleased = p.chargeTicks >= 24;
      frame.moveX = -p.vx; frame.moveY = -p.vy;
    } else if (strike && owner?.id === p.id && !p.action && speed < 20 * F && direction * p.x > 24 * F) {
      frame.strikeHeld = true;
      frame.moveX = -p.vx; frame.moveY = -p.vy;
    }
    if (skater.downTicks || skater.check) {
      frame.pass = frame.slide = frame.strikePressed = frame.dash = frame.check = false;
    }
    p.aiX = Math.round(target.x); p.aiY = Math.round(target.y);
    commands.set(p.id, frame);
  }
  return commands;
}
