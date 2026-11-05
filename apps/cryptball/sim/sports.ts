import type { CommandFrame, State, Team } from "./contract";
import type { DeterministicRandom } from "@onepage/game-simulation/random";
import { resetCourt, advancePhase } from "./match";
import { event } from "./actions";
import { FIXED as F } from "./rules";
import { stepKick } from "./modes/cryptkick";
import { stepVolley } from "./modes/rift-volley";
import {
  resetHockey,
  advanceHockeyPhase,
  stepHockey,
} from "./modes/cryptcheck/index";
import { resetDodge, advanceDodge, stepDodge } from "./modes/crypt-dodge/index";
import {
  resetGuardian,
  advanceGuardian,
  guardianStep,
} from "./modes/crypt-guardian/index";
export { predictVolleyLanding } from "./modes/rift-volley";
/** Shared sport reset uses the same four athletes, court and controller ownership. */
export function resetSport(s: State, team: Team | null = null, seed?: number) {
  resetCourt(s, team);
  if (s.sportId === "crypt-dodge") {
    resetDodge(s, seed);
    return;
  }
  if (s.sportId === "crypt-guardian") {
    resetGuardian(s, seed);
    return;
  }
  if (s.sportId === "cryptcheck") {
    resetHockey(s);
    return;
  }
  if (s.sportId !== "rift-volley") return;
  const serveTeam = team ?? s.volley?.serveTeam ?? 0;
  const rally = s.volley?.rally ?? 0;
  s.volley = {
    serveTeam,
    serving: true,
    teamContacts: 0,
    lastContactId: null,
    lastContactTeam: null,
    rally,
    contactTick: s.tick - 100,
    serveTicks: 0,
  };
  for (const [i, p] of s.players.entries()) {
    const side = p.team === 0 ? -1 : 1;
    p.x = side * (i % 2 === 0 ? 112 : 58) * F;
    p.y = (i % 2 === 0 ? -26 : 34) * F;
  }
  const server = s.players.find((p) => p.team === serveTeam)!;
  s.ball.x = server.x + (serveTeam === 0 ? 11 : -11) * F;
  s.ball.y = server.y;
  s.ball.z = 14 * F;
  s.restartTeam = serveTeam;
  s.restartProtection = 0;
  s.touchTick = s.tick - 100;
}

export function advanceSportPhase(s: State, rng?: DeterministicRandom) {
  if (s.sportId === "crypt-dodge") {
    advanceDodge(s);
    return;
  }
  if (s.sportId === "crypt-guardian") {
    advanceGuardian(s, rng);
    return;
  }
  if (s.sportId === "cryptcheck") {
    advanceHockeyPhase(s, rng);
    return;
  }
  if (s.sportId !== "rift-volley") {
    advancePhase(s);
    return;
  }
  if (s.phase === "results" || --s.phaseTicks > 0) return;
  if (s.phase === "goal") {
    resetSport(s, s.volley!.serveTeam);
    s.phase = "ready";
    s.phaseTicks = 24;
  } else {
    s.phase = "play";
    event(s, "whistle");
  }
}

/** Exhaustive dispatch: the legacy combat tick remains in session.ts. */
export function stepSport(
  s: State,
  humans: Map<string, CommandFrame>,
  rng: DeterministicRandom,
) {
  switch (s.sportId) {
    case "crypt-dodge":
      return stepDodge(s, humans, rng);
    case "crypt-guardian":
      return guardianStep(s, humans, rng);
    case "cryptkick":
      return stepKick(s, humans, rng);
    case "rift-volley":
      return stepVolley(s, humans, rng);
    case "cryptcheck":
      return stepHockey(s, humans, rng);
    case "cryptball":
      throw Error("Cryptball uses the legacy session tick");
    default: {
      const impossible: never = s.sportId;
      throw Error(`Unsupported sport ${impossible}`);
    }
  }
}
