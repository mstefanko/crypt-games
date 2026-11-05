import type { CryptballEvent, SportId } from "./contract";
import { SPORT_ART_PROFILES } from "./sport-presentation";
import { SPORT_BALL_PROFILES } from "../sim/sports-spec";

/** Game art policy. Radius comes from the same authored profile as collisions. */
export function ballVisual(sport: SportId, travel: number, tick: number, contact?: CryptballEvent, reducedMotion = false) {
  const radius = SPORT_BALL_PROFILES[sport].radius;
  const profile = SPORT_ART_PROFILES[sport];
  if (profile.ball === "puck") return {
    radius, frame: `hockey.puck.${reducedMotion ? 0 : Math.floor(travel / 12) % 4}`,
    groundLift: 0, locatorRadius: radius + 2, trailRadius: 1,
    shadowScale: radius / 7,
  };
  if (profile.ball === "dodge") {
    const age = contact ? tick - contact.tick : 99;
    return { radius, frame: `new.object.${!reducedMotion && age >= 0 && age < 8 ? age < 3 ? "ball-squash" : "ball-stretch" : reducedMotion || Math.floor(travel / 4) % 2 === 0 ? "ball-a" : "ball-b"}`, groundLift: 0, locatorRadius: radius + 1, trailRadius: 1.5, shadowScale: radius / 7 };
  }
  const legacy = profile.ball === "orb";
  const style = profile.ball;
  const age = contact ? tick - contact.tick : -1;
  const deform = !legacy && !reducedMotion && age >= 0 && age < 10;
  const gentle = contact?.type === "trap" || contact?.kind === "set";
  return {
    radius,
    frame: legacy ? `orb.${Math.floor(travel / 4) % 4}`
      : deform ? `balls.${style}.contact.${age < 2 ? gentle ? 1 : 0 : age < 4 ? 1 : age < 7 ? 2 : 3}`
      : `balls.${style}.spin.${reducedMotion ? 0 : Math.floor(travel / (radius * .65)) % 8}`,
    // Legacy orb intentionally retains its original composition.
    groundLift: legacy ? 2 : sport === "cryptkick" ? radius : 0,
    locatorRadius: legacy ? 4 : radius + 1,
    trailRadius: legacy ? 2 : radius * .55,
    shadowScale: legacy ? .5 : radius / 7,
  };
}

/** Contacts delivered by authority are the sole source of transient deformation. */
export function isBallContact(event: CryptballEvent): boolean {
  return ["guardian-catch", "guardian-throw", "guardian-pass", "guardian-block", "guardian-deflect", "dodge-catch", "dodge-ding", "dodge-pass", "dodge-throw", "strike", "pass", "trap", "volley-contact", "board", "post", "save", "block", "perfect-block", "slide-contact", "puck-contact"].includes(event.type);
}

export function volleyContactKind(event: CryptballEvent): "set" | "dig" | "attack" {
  return event.kind === "set" ? "set" : event.kind === "dig" ? "dig" : "attack";
}
