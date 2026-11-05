import type { Player, Observation, CryptballEvent } from "./contract";
import { TUNING } from "../sim/spec";
import { projectCourt } from "./projection";
import { HOCKEY } from "../sim/modes/cryptcheck/spec";
const headings = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];
/** Source camera directions are selected from screen facing, never raw world axes. */
export function spriteHeading(heading: number): string {
  const a = (heading * Math.PI) / 128,
    p = projectCourt(Math.cos(a), Math.sin(a)),
    o = projectCourt(0, 0);
  return headings[
    (Math.round((Math.atan2(p.y - o.y, p.x - o.x) * 4) / Math.PI) + 8) % 8
  ];
}
/** The rendered stick follows the physical carry pocket and committed contacts. */
export function athleteHeading(p: Player, s: Observation): number {
  const prepared = s.dodge?.athletes[p.id]?.pendingThrow;
  if (prepared) return prepared.heading;
  const skater = s.sportId === "cryptcheck" ? s.hockey?.skaters[p.id] : undefined;
  if (skater?.downTicks) return skater.downHeading;
  if (skater?.check) return skater.check.heading;
  if (p.slideTicks > 0) return p.slideHeading;
  if (p.action) {
    // During preparation the real pocket is still catching up with aim. Contact
    // and follow-through use the locked action heading, matching swept physics.
    if (s.sportId === "cryptcheck" && s.possessionId === p.id && skater && p.action.elapsed < p.action.timing.tell)
      return skater.carryHeading;
    return p.action.heading ?? p.heading;
  }
  if (s.sportId === "cryptcheck" && s.possessionId === p.id && skater) return skater.carryHeading;
  return p.heading;
}
export function athleteAnimation(
  p: Player,
  s: Observation,
  contact?: CryptballEvent,
): { clip: string; phase: number; instance: string; lift?: number } {
  switch (s.sportId) {
    case "crypt-dodge": return dodgeAnimation(p, s, contact);
    case "crypt-guardian": return dodgeAnimation(p, s, contact);
    case "cryptcheck": return hockeyAnimation(p, s, contact);
    case "cryptkick":
    case "rift-volley": return sportAnimation(p, s, contact);
    case "cryptball": break;
    default: {
      const unreachable: never = s.sportId;
      throw Error(`Missing athlete animation policy: ${unreachable}`);
    }
  }
  let clip = "idle",
    phase = (s.tick % 120) / 120,
    instance = "idle";
  if (p.staggerTicks > 0) {
    clip = "recoil";
    const t = (10 - p.staggerTicks) / 10;
    phase = (t < 0.5 ? t * 2 : (1 - t) * 2) * 0.9;
    instance = "recoil";
  } else if (s.phase === "goal" && s.ball.lastTouch === p.id) {
    clip = "celebrate";
    phase = (s.tick % 40) / 40;
    instance = "celebrate";
  } else if (p.action) {
    clip =
      p.action.kind === "pass"
        ? "pass"
        : (p.action.charge ?? 0) >= 24
          ? "power"
          : "strike";
    const a = p.action,
      t = a.elapsed;
    phase =
      t < a.timing.tell
        ? (t / a.timing.tell) * 0.375
        : t < a.timing.tell + a.timing.active
          ? 0.375 + ((t - a.timing.tell) / a.timing.active) * 0.375
          : 0.75 +
            ((t - a.timing.tell - a.timing.active) / a.timing.recover) * 0.249;
    instance = `attack:${a.id}`;
  } else if (p.charging) {
    clip = p.chargeTicks >= 24 ? "power" : "strike";
    phase = 0.17;
    instance = "charge";
  } else if (p.slideTicks > 0) {
    const duration = p.role === "keeper" ? TUNING.diveTicks : TUNING.slideTicks;
    const elapsed = duration - p.slideTicks;
    clip = p.role === "keeper" ? "keeper-dive" : elapsed < 3 ? "slide-launch" : "slide";
    phase = elapsed / duration;
    instance = `${clip}:${s.tick - elapsed}`;
  } else if (p.slideRecovery > 0) {
    clip = "slide-recover";
    phase = 1 - p.slideRecovery / TUNING.slideRecovery;
    instance = "slide-recover";
  } else if (p.dashTicks > 0 || Math.hypot(p.vx, p.vy) > 256) {
    clip = p.role === "keeper" ? "keeper-shuffle" : "sprint";
    phase = (p.distance / (256 * 48)) % 1;
    instance = "walk";
  }
  return { clip, phase, instance };
}

/** Key poses follow semantic action phases. Contact cues also survive action recovery. */
function sportAnimation(p: Player, s: Observation, contact?: CryptballEvent) {
  const volley = s.sportId === "rift-volley";
  const age = contact ? s.tick - contact.tick : 99;
  const recent = age >= 0 && age < 18;
  let clip = "idle", phase = (s.tick % 120) / 120, instance = "idle", lift = 0;
  const digContact = volley && recent && contact?.type === "volley-contact" && contact.kind === "dig";
  // A confirmed forearm contact is visible immediately, even on the launch tick.
  if (digContact && age < 7) {
    clip = "dig";
    phase = 0;
    instance = `contact:${contact?.tick}`;
  } else if (p.slideTicks > 0) {
    clip = volley ? "dive" : "slide";
    phase = Math.max(digContact ? 2 / 3 : 0, 1 - p.slideTicks / TUNING.slideTicks);
    instance = `slide:${s.tick + p.slideTicks}`;
  } else if (p.slideRecovery > 0 || p.staggerTicks > 0) {
    clip = volley ? "dive-recover" : "slide-recover";
    phase = 1 - (p.slideRecovery || p.staggerTicks) / TUNING.slideRecovery;
    instance = "recover";
  } else if (volley && recent && contact?.type === "volley-contact") {
    const kind = contact.kind;
    clip = kind === "set" ? "set" : kind === "dig" ? "dig"
      : kind === "attack" && typeof contact.height === "number" && contact.height < 20 * 256 ? "receive" : "spike";
    // The event is the authoritative contact instant: start at the contact pose.
    phase = clip === "dig" ? 1 / 3 + (age - 7) / 11 * 2 / 3
      : age < 7 ? (clip === "spike" ? .4 : .3) : .72 + (age - 7) / 40;
    lift = clip === "spike" && age < 10 ? Math.sin((age + 4) / 14 * Math.PI) * 8 : 0;
    instance = `contact:${contact?.tick}`;
  } else if (p.action) {
    const a = p.action, t = a.elapsed, activeEnd = a.timing.tell + a.timing.active;
    clip = volley ? a.kind === "pass" ? "set" : "spike" : a.kind === "pass" ? "pass" : "kick";
    phase = t < a.timing.tell ? t / a.timing.tell * .333
      : t < activeEnd ? .334 + (t - a.timing.tell) / a.timing.active * .331
      : .667 + (t - activeEnd) / a.timing.recover * .332;
    if (volley && a.kind === "strike" && t < activeEnd) lift = Math.sin(Math.min(1, t / activeEnd) * Math.PI) * 8;
    instance = `action:${a.id}`;
  } else if (p.charging) {
    clip = volley ? "jump" : "kick";
    phase = 0;
    instance = "charge";
  } else if (!volley && recent && contact?.type === "trap") {
    clip = "trap"; phase = age / 18; instance = `trap:${contact?.tick}`;
  } else if (volley && s.volley?.lastContactId === p.id && s.tick - s.volley.contactTick < 10) {
    clip = "receive"; phase = (s.tick - s.volley.contactTick) / 10; instance = `receive:${s.volley.contactTick}`;
  } else if (p.dashTicks > 0 || Math.hypot(p.vx, p.vy) > 256) {
    clip = "run"; phase = (p.distance / (256 * 48)) % 1; instance = "run";
  }
  return {clip, phase, instance, lift};
}

/** Generated stick-bearing poses follow authority phases, including held windups.
 * A contact receipt pins the actual contact pose even after prediction recovery. */
function hockeyAnimation(p: Player, s: Observation, contact?: CryptballEvent) {
  const age = contact ? s.tick - contact.tick : 99;
  const skater = s.hockey?.skaters[p.id];
  let clip = "idle", phase = 0, instance = "hockey:idle";
  if (skater?.downTicks) {
    const remaining = skater.downTicks, total = HOCKEY.downFall + HOCKEY.downHold + HOCKEY.downGetup;
    clip = remaining > HOCKEY.downHold + HOCKEY.downGetup ? "knockdown-fall"
      : remaining > HOCKEY.downGetup ? "knockdown" : "get-up";
    phase = clip === "knockdown-fall" ? (total - remaining) / HOCKEY.downFall
      : clip === "get-up" ? 1 - remaining / HOCKEY.downGetup : 0;
    instance = `hockey:down:${s.tick + remaining}:${clip}`;
  } else if (skater?.check) {
    const check = skater.check, activeEnd = HOCKEY.checkTell + HOCKEY.checkActive;
    clip = "shoulder";
    phase = check.elapsed < activeEnd ? 0 : .5 + .499 * (check.elapsed - activeEnd) / HOCKEY.checkRecovery;
    instance = `hockey:check:${check.id}`;
  } else if (p.staggerTicks > 0) {
    clip = "recoil"; instance = "hockey:recoil";
  } else if (contact?.type === "puck-contact" && age >= 0 && age < 3) {
    clip = contact.kind === "slap" ? "slap" : contact.kind === "poke" ? "poke" : contact.kind === "pass" ? "pass" : "wrist";
    phase = clip === "slap" ? .5 : 1 / 3;
    instance = `hockey:contact:${contact.actionId ?? contact.tick}`;
  } else if (p.action) {
    const a = p.action, t = a.elapsed, end = a.timing.tell + a.timing.active;
    const slap = a.kind === "strike" && (a.charge ?? 0) >= 24;
    clip = a.kind === "pass" ? "pass" : slap ? "slap" : "wrist";
    const contactPhase = slap ? .5 : 1 / 3, recoveryPhase = slap ? .75 : 2 / 3;
    phase = t < a.timing.tell ? t / a.timing.tell * contactPhase
      : t < end ? contactPhase + (t - a.timing.tell) / a.timing.active * (recoveryPhase - contactPhase)
      : recoveryPhase + (t - end) / a.timing.recover * (.999 - recoveryPhase);
    instance = `hockey:action:${a.id}`;
  } else if (p.charging) {
    clip = p.chargeTicks >= 24 ? "slap-hold" : "wrist";
    instance = "hockey:charge";
  } else if (p.slideTicks > 0) {
    const elapsed = HOCKEY.pokeTell + HOCKEY.pokeActive - p.slideTicks;
    clip = "poke"; phase = elapsed < HOCKEY.pokeTell ? 0 : 1 / 3;
    instance = `hockey:poke:${s.tick + p.slideTicks}`;
  } else if (p.slideRecovery > 0) {
    clip = "recover"; phase = 1 - p.slideRecovery / HOCKEY.pokeRecovery; instance = "hockey:recover";
  } else if (contact?.type === "check" && age >= 0 && age < 6) {
    clip = "shoulder"; phase = age / 12; instance = `hockey:check:${contact?.tick}`;
  } else if (s.possessionId === p.id && !p.dashTicks) {
    clip = skater && skater.receiveUntil > s.tick ? "receive" : "stickhandle";
    phase = clip === "receive" ? 1 - (skater!.receiveUntil - s.tick) / HOCKEY.receiveTicks : (s.tick % 24) / 24;
    instance = `hockey:${clip}`;
  } else if (contact?.type === "ice-stop" && age >= 0 && age < 9) {
    clip = "stop"; phase = age / 18; instance = `hockey:stop:${contact?.tick}`;
  } else if (contact?.type === "skate-push" && age >= 0 && age < 12) {
    clip = "skate"; phase = age / 12; instance = `hockey:push:${contact?.tick}`;
  } else if (p.dashTicks > 0) {
    clip = "burst"; phase = p.distance / (256 * 28) % 1; instance = "hockey:burst";
  } else if (contact?.type === "trap" && age >= 0 && age < 10) {
    clip = "receive"; phase = age / 10; instance = `hockey:receive:${contact?.tick}`;
  } else if (Math.hypot(p.vx, p.vy) > 256) {
    clip = "glide"; instance = "hockey:glide";
  }
  return { clip, phase, instance, lift: 0 };
}

/** Release poses are pinned to authority receipts; possession never waits on art. */
function dodgeAnimation(p: Player, s: Observation, contact?: CryptballEvent) {
  const d = s.dodge?.athletes[p.id], age = contact ? s.tick - (typeof contact.presentationTick === "number" ? contact.presentationTick : contact.tick) : 999;
  let clip = "idle", phase = 0, instance = "dodge:idle";
  if (p.staggerTicks > 0 || d?.lives === 0) { clip = "hit-recoil"; instance = "dodge:hit"; }
  else if (p.slideTicks || p.slideRecovery) { clip = p.slideTicks ? "dive" : "dive-recover"; phase = p.slideTicks ? 1 - p.slideTicks / 18 : 1 - p.slideRecovery / 15; instance = `dodge:dive:${s.tick + p.slideTicks}`; }
  else if (age >= 0 && age < 12 && ["dodge-catch", "guardian-catch"].includes(contact?.type ?? "")) { clip = "catch-contact"; instance = `dodge:catch:${contact?.tick}`; }
  else if (d?.pendingThrow || p.charging) { clip = "throw-windup"; instance = "dodge:windup"; }
  else if (age >= 0 && age < 16 && ["dodge-throw", "guardian-throw"].includes(contact?.type ?? "")) { clip = age < 4 ? "throw-release" : "throw-follow"; instance = `dodge:throw:${contact?.tick}`; }
  else if (age >= 0 && age < 10 && ["dodge-pass", "guardian-pass"].includes(contact?.type ?? "")) { clip = "pass-release"; instance = `dodge:pass:${contact?.tick}`; }
  else if (s.guardian?.athletes[p.id].catchUntil && s.guardian.athletes[p.id].catchUntil > s.tick) { clip = "catch-ready"; instance = `guardian:ready:${s.guardian.athletes[p.id].catchUntil}`; }
  else if (d?.catchKind && s.tick - d.catchStart < 32) { clip = s.tick - d.catchStart < 14 ? "catch-ready" : "catch-contact"; instance = `dodge:ready:${d.catchStart}`; }
  else if (s.dodge?.balls.some(ball => !ball.retired && ball.mode.holderId === p.id) || s.guardian?.orbs.some(orb=>orb.possessionId===p.id)) { clip = "carry"; instance = "dodge:carry"; }
  else if (p.dashTicks || Math.hypot(p.vx, p.vy) > 256) { clip = "run"; phase = p.distance / (256 * 48) % 1; instance = "dodge:run"; }
  return { clip, phase, instance, lift: 0 };
}
