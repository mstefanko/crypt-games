import { sportHasSpecials } from "./sports-spec";
import type {
  Ball,
  CommandFrame,
  CommandOrigin,
  Player,
  State,
} from "./contract";
import { aimHeading, headingVector, length, RULES } from "./rules";
import type { TeamId } from "./team-identities";
export const SPECIAL_OPENING_TICKS = 720;
export const SPECIAL_COOLDOWN_TICKS = 1440;
export const SPECIAL_TELL_TICKS = 6;
export const SPECIALS = Object.freeze({
  rams: {
    name: "Charge",
    description:
      "A straight rush. One body hit stops it; a miss leaves recovery.",
    durationTicks: 42,
  },
  foxes: {
    name: "Sidestep",
    description:
      "Steer a fast cut, resist checks, and keep an existing dribble.",
    durationTicks: 24,
  },
  owls: {
    name: "Focus",
    description:
      "Move freely through charge and strike; control one reception.",
    durationTicks: 186,
  },
  gators: {
    name: "Snap",
    description:
      "A long defensive lunge. Ball contact brakes and recovers quickly.",
    durationTicks: 50,
  },
  bats: {
    name: "Flutter",
    description:
      "Burst, then press special again within 0.8s for a new direction.",
    durationTicks: 74,
  },
  hornets: {
    name: "Sting",
    description:
      "Prime one quick release and recovery; charged power stays ordinary.",
    durationTicks: 186,
  },
});
export const specialTell = (id: TeamId) => (id === "rams" ? 9 : 6);
export function clearSpecials(s: State) {
  for (const special of s.specials) special.active = null;
}
function emit(
  s: State,
  p: Player,
  type: string,
  extra: Record<string, unknown> = {},
) {
  s.events.push({
    type,
    tick: s.tick,
    epoch: s.epoch,
    counter: s.nextEvent++,
    playerId: p.id,
    team: p.team,
    x: p.x,
    y: p.y,
    kind: s.teamIds[p.team],
    ...extra,
    ...(extra.origin
      ? {
          origin: {
            ...(extra.origin as CommandOrigin),
            eventKind: type,
            ordinal: 0,
          },
        }
      : {}),
  });
}
/** Advance only on authority live-play ticks; stopped clocks never charge. */
export function advanceSpecials(s: State) {
  for (const [index, team] of s.specials.entries()) {
    team.cooldownTicks = Math.max(0, team.cooldownTicks - 1);
    const a = team.active;
    if (!a) continue;
    a.remainingTicks--;
    a.elapsedTicks++;
    const kind = s.teamIds[index];
    const recovered =
      a.stoppedTicks >= 0 &&
      a.elapsedTicks >= a.stoppedTicks + (kind === "gators" ? 6 : 12);
    const missedFollowup =
      kind === "bats" && a.secondBurstAvailable && a.elapsedTicks >= 64;
    const finishedFollowup =
      kind === "bats" &&
      !a.secondBurstAvailable &&
      a.elapsedTicks >= a.burstStart + 10;
    if (!a.remainingTicks || recovered || missedFollowup || finishedFollowup)
      team.active = null;
  }
}
export function playerSpecial(s: State | undefined, p: Player) {
  const a = s?.specials[p.team].active;
  return a?.playerId === p.id ? a : null;
}
export function specialKind(s: State | undefined, p: Player): TeamId | null {
  const a = playerSpecial(s, p);
  return a && a.elapsedTicks >= specialTell(s!.teamIds[p.team])
    ? s!.teamIds[p.team]
    : null;
}
export function flutterFollowup(
  s: Pick<State, "specials" | "teamIds">,
  p: Pick<Player, "team" | "id">,
) {
  const a = s.specials[p.team].active;
  return (
    s.teamIds[p.team] === "bats" &&
    a?.playerId === p.id &&
    a.secondBurstAvailable &&
    a.elapsedTicks >= 16 &&
    a.elapsedTicks < 64
  );
}
const inputHeading = (p: Player, c: CommandFrame) =>
  c.moveX || c.moveY
    ? aimHeading(c.moveX ?? 0, c.moveY ?? 0)
    : c.aim !== undefined
      ? ((Math.round(c.aim) % 256) + 256) % 256
      : p.heading;
/** Canonical athlete order is the tie breaker when teammates request together. */
export function admitSpecial(s: State, p: Player, c: CommandFrame) {
  if (!sportHasSpecials(s.sportId)) return false;
  const team = s.specials[p.team],
    kind = s.teamIds[p.team];
  const bot = !s.controllers.some((q) => q.active && q.team === p.team);
  // Bots deliberately request the follow-up only after reassessing a nearby ball.
  const botFollowup =
    bot &&
    flutterFollowup(s, p) &&
    length(p.x - s.ball.x, p.y - s.ball.y) < 96 * 256 &&
    s.tick % 12 === 0;
  if (
    (c.special || botFollowup) &&
    flutterFollowup(s, p) &&
    !p.action &&
    !p.charging &&
    !p.staggerTicks &&
    !c.cancel
  ) {
    const a = team.active!;
    a.secondBurstAvailable = false;
    a.burstStart = a.elapsedTicks;
    a.heading = inputHeading(p, c);
    emit(s, p, "special-burst", { stage: 2, origin: c.origin });
    return;
  }
  const request =
    c.special ||
    (bot &&
      length(p.x - s.ball.x, p.y - s.ball.y) < 72 * 256 &&
      (s.tick + Number(p.id.split("-")[1])) % 12 === 0);
  if (
    !request ||
    team.cooldownTicks ||
    team.active ||
    s.phase !== "play" ||
    s.volley?.serving ||
    p.action ||
    (p.charging && kind !== "owls") ||
    p.dashTicks ||
    p.slideTicks ||
    p.slideRecovery ||
    p.staggerTicks ||
    s.tick < p.actionReady ||
    c.cancel
  )
    return;
  team.cooldownTicks = team.rechargeTicks = SPECIAL_COOLDOWN_TICKS;
  team.active = {
    ...(c.origin ? { origin: { ...c.origin } } : {}),
    playerId: p.id,
    remainingTicks: SPECIALS[kind].durationTicks,
    elapsedTicks: 0,
    heading: inputHeading(p, c),
    burstStart: 6,
    secondBurstAvailable: kind === "bats",
    contactUsed: false,
    receptionUsed: false,
    stoppedTicks: -1,
  };
  p.buffer = null;
  p.checked = false;
  emit(s, p, "special", { origin: c.origin });
}
export function specialBurst(s: State, p: Player) {
  const a = playerSpecial(s, p),
    kind = specialKind(s, p);
  if (!a || a.stoppedTicks >= 0 || p.staggerTicks) return false;
  return (
    (kind === "rams" && a.elapsedTicks < 30) ||
    (kind === "foxes" && a.elapsedTicks < 20) ||
    (kind === "bats" &&
      a.elapsedTicks >= a.burstStart &&
      a.elapsedTicks < a.burstStart + 10)
  );
}
export function sidestepResists(s: State, p: Player) {
  return specialKind(s, p) === "foxes" && specialBurst(s, p);
}
/** Returns true while a committed movement owns the athlete's action input. */
export function specialOwnsAction(s: State, p: Player): boolean {
  const a = playerSpecial(s, p);
  if (!a) return false;
  const kind = s.teamIds[p.team];
  // Focus can be admitted during a charge without suspending held/release input.
  if (kind === "owls" && p.charging) return false;
  if (kind === "bats") return a.elapsedTicks < 6 || specialBurst(s, p);
  return (
    a.elapsedTicks < specialTell(kind) ||
    kind === "rams" ||
    kind === "gators" ||
    kind === "foxes"
  );
}
export function specialVelocity(
  s: State | undefined,
  p: Player,
  c: CommandFrame,
): boolean {
  const a = playerSpecial(s, p);
  if (!a || p.staggerTicks) return false;
  const kind = s!.teamIds[p.team],
    elapsed = a.elapsedTicks - specialTell(kind);
  if (elapsed < 0) {
    if (kind === "owls" && p.charging) return false;
    p.vx = Math.round(p.vx * 0.7);
    p.vy = Math.round(p.vy * 0.7);
    return true;
  }
  let multiplier = 0,
    heading = a.heading;
  if (kind === "rams") {
    multiplier = specialBurst(s!, p) ? 2.2 : 0.3;
    p.dashHeading = heading;
  }
  if (kind === "foxes") multiplier = elapsed < 14 ? 2 : 0.3;
  if (kind === "gators") {
    if (elapsed === 0) {
      p.slideHeading = heading;
      p.heading = heading;
      p.slideTicks = s!.sportId === "cryptcheck" ? 18 : 24;
      p.slideBallHit = false;
      p.checked = false;
    }
    if (elapsed < 4 && (c.moveX || c.moveY)) {
      const desired = inputHeading(p, c),
        difference = ((desired - a.heading + 384) % 256) - 128;
      a.heading =
        (a.heading + Math.max(-3, Math.min(3, difference)) + 256) % 256;
      heading = p.slideHeading = p.heading = a.heading;
    }
    if (s!.sportId === "cryptcheck" && a.stoppedTicks < 0 && elapsed < 18)
      multiplier = 1.7;
    if (
      a.stoppedTicks >= 0 ||
      elapsed >= (s!.sportId === "cryptcheck" ? 18 : 24)
    )
      multiplier = 0.3;
  }
  if (kind === "bats" && specialBurst(s!, p)) multiplier = 2.2;
  if (!multiplier) return false;
  if (kind === "foxes" && elapsed < 14 && (c.moveX || c.moveY))
    heading = inputHeading(p, c);
  const v = headingVector(heading);
  p.vx = Math.round((v.x * RULES.runSpeed * multiplier) / 65536);
  p.vy = Math.round((v.y * RULES.runSpeed * multiplier) / 65536);
  return true;
}
export function specialSuccess(
  s: State,
  p: Player,
  contact: "body" | "ball" | "receive",
) {
  emit(s, p, "special-success", {
    contact,
    origin: playerSpecial(s, p)?.origin,
  });
}
export function stopSpecial(s: State, p: Player) {
  const a = playerSpecial(s, p);
  if (!a || a.stoppedTicks >= 0) return;
  a.stoppedTicks = a.elapsedTicks;
  p.vx = Math.round(p.vx * 0.25);
  p.vy = Math.round(p.vy * 0.25);
  if (s.teamIds[p.team] === "gators") {
    p.slideTicks = 0;
    p.slideRecovery = 6;
  }
}
/** Physical contact only: no remote catches and no added shot power. */
export function specialBallContact(
  s: State,
  p: Player,
  b: Ball,
  incomingSpeed: number,
) {
  const a = playerSpecial(s, p),
    kind = specialKind(s, p);
  if (!a) return;
  if (kind === "owls" && !a.receptionUsed) {
    a.receptionUsed = true;
    b.vx = Math.round(b.vx * 0.45);
    b.vy = Math.round(b.vy * 0.45);
    specialSuccess(s, p, "receive");
  }
  if (
    (kind === "rams" && specialBurst(s, p)) ||
    (kind === "gators" && p.slideTicks)
  ) {
    const first = !a.contactUsed;
    a.contactUsed = true;
    const speed = length(b.vx, b.vy),
      cap = Math.min(
        RULES.passSpeed,
        Math.max(incomingSpeed, kind === "rams" ? 90 * 256 : 0),
      );
    if (speed > cap) {
      b.vx = Math.round((b.vx * cap) / speed);
      b.vy = Math.round((b.vy * cap) / speed);
    }
    if (first) specialSuccess(s, p, "ball");
    if (kind === "gators") {
      p.slideBallHit = true;
      stopSpecial(s, p);
    }
  }
}
