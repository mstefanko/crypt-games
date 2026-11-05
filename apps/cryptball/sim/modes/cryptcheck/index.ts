import type { CommandFrame, State } from "../../contract";
import type { DeterministicRandom } from "@onepage/game-simulation/random";
import { event, recordStat } from "../../actions";
import { dragBall, moveBall } from "../../ball";
import { movePlayers } from "../../motion";
import { resetCourt, scoreGoal, expireClock } from "../../match";
import { groundBallPhysics } from "../../sports-spec";
import { FIXED as F } from "../../rules";
import { HOCKEY } from "./spec";
import { skate } from "./motion";
import { controlPuck } from "./control";
import {
  admitHockeyAction,
  finishHockeyActions,
  hockeyChecks,
  hockeyContacts,
} from "./actions";
import { hockeyAI } from "./ai";
export { HOCKEY } from "./spec";
export { skate } from "./motion";
export { bladeAnchor, bladeContains, controlPuck } from "./control";
export { hockeyContacts } from "./actions";
/** Faceoff lead order is canonical authority state and alternates after goals. */
export function resetHockey(s: State) {
  s.hockey ??= {
    faceoffLead: ["player-0", "player-2"],
    checkHits: {},
    pokeActions: {},
    skaters: {},
    aiTeams: [
      {
        collectorId: null,
        until: 0,
        progressTick: 0,
        progressDistance: 0,
        approachSide: -1,
      },
      {
        collectorId: null,
        until: 0,
        progressTick: 0,
        progressDistance: 0,
        approachSide: 1,
      },
    ],
    contestUntil: 0,
    contestSide: 1,
    dropSide: 0,
  };
  s.hockey.checkHits = {};
  s.hockey.pokeActions = {};
  s.hockey.skaters = {};
  s.hockey.contestUntil = s.tick;
  s.hockey.aiTeams = [
    {
      collectorId: null,
      until: 0,
      progressTick: s.tick,
      progressDistance: 0,
      approachSide: -1,
    },
    {
      collectorId: null,
      until: 0,
      progressTick: s.tick,
      progressDistance: 0,
      approachSide: 1,
    },
  ];
  s.possessionId = null;
  s.possessionReady = s.tick;
  s.ball.x = s.ball.y = 0;
  s.restartTeam = null;
  s.restartProtection = 0;
  for (const p of s.players) {
    const side = p.team === 0 ? -1 : 1,
      lead = s.hockey.faceoffLead[p.team] === p.id;
    p.x = side * (lead ? 24 : 64) * F;
    p.y = (lead ? 0 : 34 * side) * F;
    p.heading = p.team === 0 ? 0 : 128;
    s.hockey.skaters[p.id] = {
      carryHeading: p.heading,
      receiveUntil: 0,
      recaptureUntil: 0,
      pokeHeld: false,
      checkHeld: false,
      check: null,
      downTicks: 0,
      downHeading: p.heading,
    };
  }
  if (s.mode === "match") s.phaseTicks = HOCKEY.readyTicks;
}
export function advanceHockeyPhase(s: State, rng?: DeterministicRandom) {
  if (s.phase === "results" || --s.phaseTicks > 0) return;
  if (s.phase === "goal") {
    if (s.mode === "match" && s.remainingTicks === 0) {
      expireClock(s);
      return;
    }
    s.hockey!.faceoffLead = [
      s.hockey!.faceoffLead[0] === "player-0" ? "player-1" : "player-0",
      s.hockey!.faceoffLead[1] === "player-2" ? "player-3" : "player-2",
    ];
    resetCourt(s);
    resetHockey(s);
    s.phase = "ready";
    s.phaseTicks = HOCKEY.readyTicks;
  } else {
    s.phase = "play";
    // An alternating lateral drop breaks the static symmetric faceoff without
    // awarding control to either ID or side. The initial side uses saved RNG;
    // subsequent drops alternate from the persisted side after every goal.
    const h = s.hockey!;
    const side: -1 | 1 =
      h.dropSide === 0
        ? rng?.drawInteger("cryptball", "ai", 2)
          ? 1
          : -1
        : h.dropSide === 1
          ? -1
          : 1;
    h.dropSide = side;
    h.contestSide = side;
    s.ball.vy = side * 52 * F;
    event(s, "whistle");
  }
}
export function stepHockey(
  s: State,
  humans: Map<string, CommandFrame>,
  rng: DeterministicRandom,
) {
  const physics = groundBallPhysics("cryptcheck"),
    commands = hockeyAI(s, rng, humans);
  for (const [id, command] of humans) commands.set(id, command);
  const emit = (e: import("../../contract").CryptballEvent) => {
    if (e.type === "pass-complete" && typeof e.passerId === "string") {
      const p = s.players.find((q) => q.id === e.passerId);
      if (p) recordStat(s, p, "passes");
    }
    s.events.push({ ...e, epoch: s.epoch, counter: s.nextEvent++ });
  };
  for (const p of s.players) {
    if (s.mode === "practice" && p.team === 1) {
      p.vx = p.vy = 0;
      continue;
    }
    const c = commands.get(p.id) ?? {};
    admitHockeyAction(s, p, c);
    skate(s, p, c);
  }
  controlPuck(s, emit);
  const contacts = hockeyContacts(s, emit);
  for (let sub = 0; sub < 4; sub++) {
    const active =
      s.mode === "practice" ? s.players.filter((p) => p.team === 0) : s.players;
    const paths = movePlayers(active, undefined, s.tick, emit, physics);
    hockeyChecks(s, paths);
    const team = moveBall(
      s.ball,
      paths,
      s.tick,
      emit,
      undefined,
      physics,
      contacts,
      s,
    );
    if (team !== null) {
      s.possessionId = null;
      if (s.mode === "match")
        s.remainingTicks = Math.max(0, s.remainingTicks - 1);
      scoreGoal(s, team);
      return;
    }
  }
  dragBall(s.ball, physics);
  if (s.ball.passFrom && s.tick - s.ball.passTick >= 90) {
    s.ball.passFrom = s.ball.passTarget = null;
    s.ball.passTeam = null;
  }
  finishHockeyActions(s);
  if (s.mode === "match") {
    s.remainingTicks = Math.max(0, s.remainingTicks - 1);
    expireClock(s);
    if (s.phase === "ready") {
      resetHockey(s);
      s.phaseTicks = HOCKEY.readyTicks;
    }
  }
}
