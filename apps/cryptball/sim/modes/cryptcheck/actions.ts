import {
  actionPhase,
  claimActionHit,
} from "@onepage/game-simulation/action-timeline";
import { queryCircleGeometry } from "@onepage/game-simulation/circle-geometry";
import type { CommandFrame, Player, State } from "../../contract";
import { admitAction, event, finishActions, recordStat } from "../../actions";
import {
  touchBall,
  type GroundContact,
  type GroundContactProvider,
} from "../../ball";
import { aimHeading, FIXED as F, headingVector, length } from "../../rules";
import {
  playerSpecial,
  specialKind,
  specialBurst,
  sidestepResists,
  specialSuccess,
  stopSpecial,
  specialOwnsAction,
  SPECIAL_TELL_TICKS,
} from "../../specials";
import { groundBallPhysics } from "../../sports-spec";
import { clearLane } from "../../prediction";
import { COURT } from "../../spec";
import type { Trajectory } from "../../motion";
import { bladeAnchor, deflectContest, releaseControl } from "./control";
import { HOCKEY } from "./spec";

export function admitHockeyAction(s: State, p: Player, c: CommandFrame) {
  const skater = s.hockey!.skaters[p.id];
  const pokeHeld = !!(c.slide || c.guard),
    pokePressed = pokeHeld && !skater.pokeHeld;
  const checkPressed = !!c.check && !skater.checkHeld;
  skater.pokeHeld = pokeHeld;
  skater.checkHeld = !!c.check;
  if (skater.downTicks || skater.check) {
    p.charging = false;
    p.chargeTicks = 0;
    p.buffer = null;
    return;
  }
  if (
    checkPressed &&
    !p.action &&
    !p.charging &&
    !p.dashTicks &&
    !p.slideTicks &&
    !p.slideRecovery &&
    !p.staggerTicks &&
    !specialOwnsAction(s, p) &&
    s.tick >= p.actionReady
  ) {
    const heading =
      c.aim !== undefined
        ? ((Math.round(c.aim) % 256) + 256) % 256
        : c.moveX || c.moveY
          ? aimHeading(c.moveX ?? 0, c.moveY ?? 0)
          : p.heading;
    skater.check = {
      ...(c.origin ? { origin: { ...c.origin } } : {}),
      id: s.nextAction++,
      heading,
      elapsed: 0,
      hits: [],
    };
    if (playerSpecial(s, p)) s.specials[p.team].active = null;
    p.heading = heading;
    p.buffer = null;
    p.actionReady =
      s.tick + HOCKEY.checkTell + HOCKEY.checkActive + HOCKEY.checkRecovery;
    if (s.possessionId === p.id) releaseControl(s, "check-preparation");
    event(s, "check-start", p, {
      heading,
      actionId: skater.check.id,
      origin: c.origin,
    });
    return;
  }
  const previous = p.action,
    dash = p.dashTicks,
    poke = p.slideTicks;
  const sting = specialKind(s, p) === "hornets";
  admitAction(s, p, { ...c, slide: pokePressed, guard: false });
  if (p.action && p.action !== previous) {
    const a = p.action,
      full = (a.charge ?? 0) >= 24;
    a.prepareUntil = s.tick + 90;
    a.timing = {
      tell: full ? 6 : 3,
      active: full ? 3 : 2,
      recover: a.kind === "pass" ? 6 : full ? 16 : 8,
    };
    if (sting) {
      if (!(a.charge ?? 0)) a.timing.tell = 2;
      a.timing.recover = Math.max(1, Math.ceil(a.timing.recover / 2));
    }
    if (a.kind === "pass" && a.targetId) {
      const target = s.players.find((q) => q.id === a.targetId)!;
      const travel = Math.min(
        0.2,
        length(target.x - s.ball.x, target.y - s.ball.y) /
          (HOCKEY.passSpeed * F),
      );
      const to = {
        x: Math.round(target.x + target.vx * travel),
        y: Math.round(target.y + target.vy * travel),
      };
      let heading = aimHeading(to.x - s.ball.x, to.y - s.ball.y);
      const physics = groundBallPhysics("cryptcheck");
      if (!clearLane(s.ball, to, s.players, [p.id, target.id], physics)) {
        // A board preserves tangent speed but scales the normal speed by e.
        // Unfold the outgoing leg by 1/e, so the chosen incoming slope lands
        // on the target after the actual damped bounce. Constant-magnitude
        // drag preserves the line on either side of the bank.
        let bestDistance = Infinity;
        for (const side of [-1, 1]) {
          const wall = side * (COURT.halfWidth * F - physics.radius);
          const mirrorY = wall + (wall - to.y) / physics.boardRestitution;
          const t = (wall - s.ball.y) / (mirrorY - s.ball.y);
          if (!(t > 0 && t < 1)) continue;
          const bank = {
            x: Math.round(s.ball.x + (to.x - s.ball.x) * t),
            // Clearance ends just inside the intended board; its exact terminal
            // contact is the bank itself, rather than an obstructed lane.
            y: wall - side * 2,
          };
          const d =
            length(bank.x - s.ball.x, bank.y - s.ball.y) +
            length(to.x - bank.x, to.y - bank.y);
          if (
            d < bestDistance &&
            clearLane(s.ball, bank, s.players, [p.id, target.id], physics) &&
            clearLane(bank, to, s.players, [p.id, target.id], physics)
          ) {
            heading = aimHeading(to.x - s.ball.x, mirrorY - s.ball.y);
            bestDistance = d;
          }
        }
      }
      a.heading = p.heading = heading;
    }
  }
  if (p.dashTicks && !dash) {
    p.dashHeading =
      c.moveX || c.moveY
        ? aimHeading(c.moveX ?? 0, c.moveY ?? 0)
        : length(p.vx, p.vy) > 8 * F
          ? aimHeading(p.vx, p.vy)
          : p.heading;
  }
  if (p.slideTicks && !poke) {
    p.slideTicks = HOCKEY.pokeTell + HOCKEY.pokeActive;
    p.slideHeading = p.heading;
    p.slideBallHit = false;
    s.hockey!.pokeActions[p.id] = s.nextAction++;
  }
  const special = playerSpecial(s, p);
  if (
    specialKind(s, p) === "gators" &&
    special?.elapsedTicks === SPECIAL_TELL_TICKS
  ) {
    p.slideTicks = 18;
    p.slideHeading = special.heading;
    p.heading = special.heading;
    p.slideBallHit = false;
    s.hockey!.pokeActions[p.id] = s.nextAction++;
  }
  if (specialKind(s, p) === "rams" && special?.elapsedTicks === 9)
    s.hockey!.checkHits[p.id] = [];
  if (s.possessionId === p.id && (p.slideTicks || specialKind(s, p) === "rams"))
    releaseControl(s, "action");
}
function activeContact(
  s: State,
  p: Player,
): Omit<GroundContact, "t" | "player"> | null {
  if (
    p.staggerTicks ||
    s.hockey!.skaters[p.id].downTicks ||
    s.hockey!.skaters[p.id].check ||
    (s.mode === "practice" && p.team === 1)
  )
    return null;
  if (
    p.action &&
    actionPhase(p.action).phase === "active" &&
    !p.action.hits.includes("ball")
  )
    return {
      actionId: p.action.id,
      heading: p.action.heading ?? p.heading,
      kind:
        p.action.kind === "pass"
          ? "pass"
          : (p.action.charge ?? 0) >= 24
            ? "slap"
            : "wrist",
    };
  const extended = specialKind(s, p) === "gators";
  if (
    p.slideTicks &&
    !p.slideBallHit &&
    (extended ? p.slideTicks <= 15 : p.slideTicks <= HOCKEY.pokeActive)
  )
    return {
      actionId: s.hockey!.pokeActions[p.id],
      heading: p.slideHeading,
      kind: "poke",
    };
  return null;
}
/** Low blade chain, sampled against piecewise skater movement in the common
 * swept contact clock. Its short forward capsule never forms a circular aura. */
export function hockeyContacts(
  s: State,
  emit: Parameters<typeof touchBall>[3],
): GroundContactProvider {
  return {
    query(ball, paths, delta, elapsed, remaining) {
      const hits: GroundContact[] = [];
      for (const path of paths) {
        const p = path.player,
          active = activeContact(s, p);
        if (!active) continue;
        const d = headingVector(active.heading);
        const offsets =
          active.kind === "poke"
            ? specialKind(s, p) === "gators"
              ? [13, 18, 23, 29, 31]
              : [13, 17, 21]
            : [11, 14, 17];
        const shapes = offsets.map((offset, i) => ({
          bodyId: p.id,
          shapeId: `blade-${i}`,
          owner: "players",
          category: "actor" as const,
          region: "body" as const,
          sensor: true,
          priority: 1,
          kind: "circle" as const,
          circle: {
            x: Math.round(
              path.x + path.dx * elapsed + (d.x * offset * F) / 65536,
            ),
            y: Math.round(
              path.y + path.dy * elapsed + (d.y * offset * F) / 65536,
            ),
            radius: 3 * F,
          },
        }));
        const hit = queryCircleGeometry(
          shapes,
          {
            kind: "sweep",
            circle: { x: ball.x, y: ball.y, radius: 4 * F },
            delta: {
              x: Math.round(delta.x - path.dx * remaining),
              y: Math.round(delta.y - path.dy * remaining),
            },
          },
          { sensors: "include" },
        ).contacts[0];
        if (hit) {
          const t = hit.time.n / hit.time.d;
          const contact = {
            x: Math.round(ball.x + delta.x * t),
            y: Math.round(ball.y + delta.y * t),
          };
          const body = {
            x: Math.round(path.x + path.dx * (elapsed + remaining * t)),
            y: Math.round(path.y + path.dy * (elapsed + remaining * t)),
          };
          if (
            clearLane(
              body,
              contact,
              s.players,
              [p.id],
              groundBallPhysics("cryptcheck"),
            )
          )
            hits.push({ ...active, player: p, t });
        }
      }
      return hits;
    },
    resolve(ball, contacts) {
      const first = contacts[0],
        opponent = contacts.find((q) => q.player.team !== first.player.team);
      const claim = (h: GroundContact) =>
        h.kind === "poke"
          ? (h.player.slideBallHit = true)
          : claimActionHit(h.player.action!, "ball");
      const incoming = { incomingVx: ball.vx, incomingVy: ball.vy };
      if (opponent) {
        for (const h of contacts) claim(h);
        // Neither athlete owns an equal-time contest; remove only the closing
        // component so an incoming pass can still escape along the tangent.
        const dx = first.player.x - opponent.player.x,
          dy = first.player.y - opponent.player.y,
          n = length(dx, dy);
        if (n) {
          const dot = (ball.vx * dx + ball.vy * dy) / (n * n);
          ball.vx = Math.round(ball.vx - dot * dx);
          ball.vy = Math.round(ball.vy - dot * dy);
        }
        releaseControl(s, "clash");
        deflectContest(s, first.player, opponent.player);
        ball.passFrom = ball.passTarget = null;
        ball.passTeam = null;
        event(s, "clash", first.player, {
          x: ball.x,
          y: ball.y,
          actionId: first.actionId,
          ...incoming,
          vx: ball.vx,
          vy: ball.vy,
        });
        return;
      }
      claim(first);
      if (first.kind === "poke" && specialKind(s, first.player) === "gators") {
        playerSpecial(s, first.player)!.contactUsed = true;
        specialSuccess(s, first.player, "ball");
        stopSpecial(s, first.player);
      }
      const p = first.player,
        a = p.action;
      const oneTimer =
        first.kind !== "poke" &&
        first.kind !== "pass" &&
        ball.passTarget === p.id &&
        ball.passTeam === p.team;
      touchBall(ball, p, s.tick, emit);
      s.touchTick = s.tick;
      const speed =
        (first.kind === "poke"
          ? 110
          : first.kind === "pass"
            ? HOCKEY.passSpeed
            : first.kind === "slap"
              ? HOCKEY.slapSpeed
              : oneTimer
                ? 300
                : HOCKEY.wristSpeed) * F;
      const d = headingVector(first.heading);
      ball.vx = Math.round((d.x * speed) / 65536);
      ball.vy = Math.round((d.y * speed) / 65536);
      ball.rx = ball.ry = 0;
      ball.passFrom = first.kind === "pass" ? p.id : null;
      ball.passTarget = first.kind === "pass" ? (a?.targetId ?? null) : null;
      ball.passTeam = first.kind === "pass" ? p.team : null;
      ball.passTick = s.tick;
      ball.powerTeam = null;
      ball.powerActionKey = null;
      ball.bankBonusRemaining = 0;
      releaseControl(s, first.kind, p.id);
      if (first.kind !== "poke" && first.kind !== "pass")
        recordStat(s, p, "shots");
      if (first.kind === "pass" && a?.targetId) {
        const controller = s.controllers.find(
          (q) => q.active && q.canSwitch && q.playerId === p.id,
        );
        if (controller && !s.controllers.some((q) => q.playerId === a.targetId))
          controller.pendingSwitch = a.targetId;
      }
      event(
        s,
        first.kind === "poke"
          ? "slide-contact"
          : first.kind === "pass"
            ? "pass"
            : "strike",
        p,
        {
          x: ball.x,
          y: ball.y,
          origin: first.kind === "poke" ? p.motionOrigin : a?.origin,
          heading: first.heading,
          charge: a?.charge ?? 0,
        },
      );
      event(s, "puck-contact", p, {
        origin: first.kind === "poke" ? p.motionOrigin : a?.origin,
        x: ball.x,
        y: ball.y,
        kind: oneTimer ? "one-timer" : first.kind,
        actionId: first.actionId,
        heading: first.heading,
        ...incoming,
        vx: ball.vx,
        vy: ball.vy,
      });
    },
  };
}
export function hockeyChecks(s: State, paths: Trajectory[]) {
  for (const path of paths) {
    const p = path.player,
      active = playerSpecial(s, p);
    const check = s.hockey!.skaters[p.id].check;
    const charge =
      specialKind(s, p) === "rams" &&
      specialBurst(s, p) &&
      (active?.elapsedTicks ?? 0) >= 9;
    const checking =
      check &&
      check.elapsed >= HOCKEY.checkTell &&
      check.elapsed < HOCKEY.checkTell + HOCKEY.checkActive;
    if (!checking && !charge) continue;
    if (checking && check.hits.length) continue;
    if (charge && p.checked) continue;
    const receipts = checking
      ? check.hits
      : (s.hockey!.checkHits[p.id] ?? (s.hockey!.checkHits[p.id] = []));
    for (const other of paths) {
      const q = other.player;
      if (
        q.team === p.team ||
        q.immunityTicks ||
        sidestepResists(s, q) ||
        receipts.includes(q.id)
      )
        continue;
      const x = path.x - other.x,
        y = path.y - other.y,
        dx = path.dx - other.dx,
        dy = path.dy - other.dy;
      const squared = dx * dx + dy * dy,
        t = squared
          ? Math.max(0, Math.min(1, -(x * dx + y * dy) / squared))
          : 0;
      const heading = checking ? check.heading : p.dashHeading;
      const facing = headingVector(heading);
      const forward = (-x * facing.x - y * facing.y) / 65536;
      const closing = (dx * facing.x + dy * facing.y) / 65536;
      if (
        forward <= 0 ||
        forward < length(x, y) * 0.45 ||
        closing < F / 30 ||
        length(x + dx * t, y + dy * t) > 15 * F
      )
        continue;
      receipts.push(q.id);
      p.checked = true;
      const victim = s.hockey!.skaters[q.id];
      victim.downTicks = HOCKEY.downFall + HOCKEY.downHold + HOCKEY.downGetup;
      victim.downHeading = heading;
      victim.check = null;
      q.staggerTicks = victim.downTicks;
      q.immunityTicks = victim.downTicks + 12;
      q.charging = false;
      q.chargeTicks = 0;
      q.buffer = null;
      q.slideTicks = 0;
      q.dashTicks = 0;
      q.action = null;
      if (playerSpecial(s, q)) s.specials[q.team].active = null;
      const d = headingVector(heading);
      q.vx += Math.round((d.x * (charge ? 72 : 48) * F) / 65536);
      q.vy += Math.round((d.y * (charge ? 72 : 48) * F) / 65536);
      if (charge) {
        specialSuccess(s, p, "body");
        stopSpecial(s, p);
      }
      if (s.possessionId === q.id) releaseControl(s, "check");
      event(s, "check", p, { targetId: q.id });
      break;
    }
  }
}
export function finishHockeyActions(s: State) {
  const ending = s.players.filter((p) => p.slideTicks === 1);
  const preparing = s.players.filter((p) => {
    const action = p.action;
    if (
      s.possessionId !== p.id ||
      !action ||
      s.tick >= (action.prepareUntil ?? 0) ||
      actionPhase(action).phase !== "tell" ||
      action.elapsed < action.timing.tell - 1
    )
      return false;
    const pocket = bladeAnchor(
      p,
      HOCKEY.controlOffset,
      action.heading ?? p.heading,
    );
    return length(pocket.x - s.ball.x, pocket.y - s.ball.y) > 7 * F;
  });
  finishActions(s);
  // A responsive aim reversal cannot fire a blade on the far side of the torso.
  // Keep the tell visible until the real puck is within its swept blade pocket.
  for (const p of preparing) if (p.action) p.action.elapsed--;
  for (const p of ending) p.slideRecovery = HOCKEY.pokeRecovery;
  for (const p of s.players) {
    const skater = s.hockey!.skaters[p.id];
    skater.downTicks = Math.max(0, skater.downTicks - 1);
    if (
      skater.check &&
      ++skater.check.elapsed >=
        HOCKEY.checkTell + HOCKEY.checkActive + HOCKEY.checkRecovery
    ) {
      if (!skater.check.hits.length)
        event(s, "whiff", p, { kind: "check", actionId: skater.check.id });
      skater.check = null;
    }
  }
}
