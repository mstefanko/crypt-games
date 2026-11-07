export * from "./specials";
import { advanceSpecials } from "./specials";
export * from "./team-identities";
import {
  DEFAULT_TEAM_IDS,
  validateTeamSelection,
  type TeamSelection,
} from "./team-identities";
export { COURT, ROSTER, TUNING, SPEC_VERSION } from "./spec";
import { ROSTER, matchConfig, type MatchConfig } from "./spec";
import { validateCheckpoint } from "./checkpoint";
import { DeterministicRandom } from "@onepage/game-simulation/random";
import { validateTick } from "@onepage/game-simulation/tick-deadline";
import type {
  State,
  CommandFrame,
  Observation,
  CryptballSession,
} from "./contract";
import { RULES } from "./rules";
import {
  makePlayer,
  resetCourt,
  advancePhase,
  scoreGoal,
  expireClock,
} from "./match";
import {
  recordStat,
  admitAction,
  steer,
  resolveStrikes,
  resolveChecks,
  finishActions,
  event,
} from "./actions";
import { movePlayers } from "./motion";
import { moveBall, dragBall } from "./ball";
import { aiCommands } from "./team-ai";
import { resetSport, stepSport, advanceSportPhase } from "./sports";
import { configureGuardianPractice } from "./modes/crypt-guardian/index";
import type { GuardianWeapon } from "./modes/crypt-guardian/types";
import { isSportId, isCooperativeSport, sportHasSpecials, supportsPassControlTransfer } from "./sports-spec";
import type { SportId } from "./contract";
export {
  SPORTS,
  SPORT_IDS,
  VOLLEY_RULES,
  isSportId,
  isCooperativeSport,
  sportHasSpecials,
  supportsPassControlTransfer,
  athletesAreAllies,
} from "./sports-spec";
export type * from "./contract";
function eligibleAthlete(s: State, id: string): boolean {
  if (s.sportId === "crypt-dodge") return !!s.dodge?.athletes[id]?.lives;
  if (s.sportId === "crypt-guardian")
    return s.guardian?.athletes[id]?.status === "active";
  return true;
}
export function createInitialState(
  mode: "match" | "practice" = "match",
  config: Partial<Omit<MatchConfig, "version">> = {},
  sportId: SportId = "cryptball",
  teamIds: TeamSelection = DEFAULT_TEAM_IDS,
  seed?: number,
): State {
  if (!isSportId(sportId)) throw Error("Invalid sport");
  validateTeamSelection(teamIds);
  const s: State = {
    specials: [
      { cooldownTicks: 720, rechargeTicks: 720, active: null },
      { cooldownTicks: 720, rechargeTicks: 720, active: null },
    ],
    teamIds: [...teamIds],
    sportId,
    possessionId: null,
    possessionReady: 0,
    volley: null,
    hockey: null,
    dodge: null,
    guardian: null,
    config: matchConfig(config),
    tick: 0,
    epoch: 1,
    nextEvent: 0,
    controllers: [
      {
        id: "local",
        team: 0,
        playerId: "player-0",
        active: true,
        canSwitch: true,
        pendingSwitch: null,
        switchReady: 0,
        revision: 0,
      },
    ],
    teamStats: [
      { shots: 0, goals: 0, passes: 0 },
      { shots: 0, goals: 0, passes: 0 },
    ],
    participantStats: { local: { shots: 0, goals: 0, passes: 0 } },
    mode,
    phase: mode === "practice" ? "play" : "ready",
    phaseTicks: mode === "practice" ? 0 : 60,
    remainingTicks: RULES.regulationTicks,
    overtime: false,
    score: [0, 0],
    controlledId: "player-0",
    players: Array.from({ length: sportId === "crypt-guardian" ? 2 : ROSTER.playerCount }, (_, i) =>
      makePlayer(i),
    ),
    ball: {
      z: 0,
      vz: 0,
      rz: 0,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      rx: 0,
      ry: 0,
      dragCarry: 0,
      lastTouch: null,
      passFrom: null,
      passTarget: null,
      passTeam: null,
      passTick: 0,
      powerTeam: null,
      powerActionKey: null,
      bankBonusRemaining: 0,
      powerExpires: 0,
    },
    stats: { shots: 0, goals: 0, passes: 0 },
    winner: null,
    restartTeam: null,
    restartProtection: 0,
    pendingSwitch: null,
    switchReady: 0,
    nextAction: 1,
    events: [],
    goalTeam: null,
    touchTick: -100,
  };
  resetCourt(s);
  if (sportId !== "cryptball") resetSport(s, null, seed);
  if (
    mode === "practice" &&
    sportId !== "rift-volley" &&
    sportId !== "cryptcheck" &&
    sportId !== "crypt-dodge" &&
    sportId !== "crypt-guardian"
  ) {
    s.players[0].x = -24 * 256;
    s.players[0].y = 0;
    s.players[1].x = 56 * 256;
    s.players[1].y = -34 * 256;
    s.ball.x = -8 * 256;
  }
  return s;
}
/** Headless authority tick, also exported for collision fixtures. */
export function stepState(
  s: State,
  c: CommandFrame,
  rng: DeterministicRandom,
  participantCommands?: Record<string, CommandFrame>,
  policy: { automaticSwitches?: boolean } = {},
) {
  validateTick(s.tick + 1);
  const frames = participantCommands ?? {
    [s.controllers[0]?.id ?? "local"]: c,
  };
  const allowed = [
    "origin",
    "moveX",
    "moveY",
    "aim",
    "pointerAim",
    "strikePressed",
    "strikeHeld",
    "strikeReleased",
    "pass",
    "passHeld",
    "dash",
    "special",
    "switch",
    "switchTarget",
    "cancel",
    "slide",
    "guard",
    "check",
  ];
  for (const frame of Object.values(frames)) {
    if (
      !frame ||
      typeof frame !== "object" ||
      Array.isArray(frame) ||
      Object.keys(frame).some((key) => !allowed.includes(key))
    )
      throw Error("Invalid command");
    if (
      frame.switchTarget !== undefined &&
      (typeof frame.switchTarget !== "string" ||
        !/^player-[0-5]$/.test(frame.switchTarget))
    )
      throw Error("Invalid switch target");
    if (
      frame.origin !== undefined &&
      (!frame.origin ||
        !Number.isSafeInteger(frame.origin.epoch) ||
        frame.origin.epoch < 0 ||
        !Number.isSafeInteger(frame.origin.generation) ||
        frame.origin.generation < 0 ||
        !Number.isSafeInteger(frame.origin.seq) ||
        frame.origin.seq < 0 ||
        typeof frame.origin.participantId !== "string" ||
        !frame.origin.participantId ||
        frame.origin.participantId.length > 96)
    )
      throw Error("Invalid command origin");
    for (const [key, value] of Object.entries(frame))
      if (
        !["moveX", "moveY", "aim", "switchTarget", "origin"].includes(key) &&
        value !== undefined &&
        typeof value !== "boolean"
      )
        throw Error("Invalid command flag");
  }
  for (const frame of Object.values(frames))
    for (const n of [frame.moveX, frame.moveY, frame.aim])
      if (n !== undefined && (!Number.isFinite(n) || Math.abs(n) > 65536))
        throw Error("Invalid command");
  s.tick++;
  const humanCommands = new Map<string, CommandFrame>();
  for (const controller of s.controllers) {
    if (!controller.active) continue;
    let frame = frames[controller.id] ?? {};
    const commandOrigin = frame.origin;
    if (policy.automaticSwitches !== false && !eligibleAthlete(s, controller.playerId) && controller.canSwitch) {
      const replacement = s.players.find(
        (p) =>
          eligibleAthlete(s, p.id) &&
          (isCooperativeSport(s.sportId) || p.team === controller.team) &&
          !s.controllers.some((c) => c !== controller && c.playerId === p.id),
      );
      if (replacement) {
        controller.playerId = replacement.id;
        controller.revision++;
        controller.pendingSwitch = null;
        frame = { moveX: frame.moveX, moveY: frame.moveY, aim: frame.aim };
        event(s, "switch", replacement, {
          origin: commandOrigin,
          participantId: controller.id,
          revision: controller.revision,
          automatic: true,
        });
      }
    }
    const old = s.players.find((p) => p.id === controller.playerId)!;
    const committedHockey =
      s.sportId === "cryptcheck" &&
      !!(
        s.hockey!.skaters[old.id].check || s.hockey!.skaters[old.id].downTicks
      );
    const committedDodge =
      s.sportId === "crypt-dodge" && !!(old.slideTicks || old.slideRecovery);
    if (frame.cancel) {
      if (!committedHockey && !committedDodge) {
        old.charging = false;
        old.chargeTicks = 0;
        old.buffer = null;
        old.slideTicks = 0;
        old.slideRecovery = 15;
      }
      frame = { cancel: true };
    } else if (
      frame.switch &&
      !committedHockey &&
      !committedDodge &&
      controller.canSwitch &&
      s.tick >= controller.switchReady
    ) {
      controller.pendingSwitch =
        s.players.find(
          (p) =>
            (!frame.switchTarget || p.id === frame.switchTarget) &&
            (isCooperativeSport(s.sportId) || p.team === controller.team) &&
            eligibleAthlete(s, p.id) &&
            p.role !== "keeper" &&
            p.id !== controller.playerId &&
            !s.controllers.some((q) => q.playerId === p.id),
        )?.id ?? null;
      controller.switchReady = s.tick + 18;
      frame = { moveX: frame.moveX, moveY: frame.moveY, aim: frame.aim };
    }
    if (controller.pendingSwitch) {
      const target = s.players.find(
        (p) =>
          p.id === controller.pendingSwitch &&
          (isCooperativeSport(s.sportId) || p.team === controller.team) &&
          eligibleAthlete(s, p.id) &&
          p.role !== "keeper",
      );
      if (
        target &&
        !s.controllers.some((q) => q !== controller && q.playerId === target.id)
      ) {
        old.charging = false;
        old.chargeTicks = 0;
        old.buffer = null;
        old.slideTicks = 0;
        old.slideRecovery = 15;
        controller.playerId = target.id;
        controller.revision++;
        frame = { moveX: frame.moveX, moveY: frame.moveY, aim: frame.aim };
        event(s, "switch", target, {
          origin: commandOrigin,
          participantId: controller.id,
          revision: controller.revision,
        });
      }
      controller.pendingSwitch = null;
    }
    humanCommands.set(controller.playerId, frame);
  }
  s.controlledId = s.controllers[0]?.playerId ?? "player-0";
  if (s.phase !== "play") {
    if (s.sportId === "cryptball") advancePhase(s);
    else advanceSportPhase(s, rng);
    return;
  }
  if (sportHasSpecials(s.sportId)) advanceSpecials(s);
  if (s.sportId !== "cryptball") {
    stepSport(s, humanCommands, rng);
    return;
  }
  const commands = aiCommands(s, rng);
  for (const [id, frame] of humanCommands) commands.set(id, frame);
  for (const p of s.players) {
    if (s.mode === "practice" && p.team === 1) {
      p.vx = p.vy = 0;
      continue;
    }
    const input = commands.get(p.id) ?? {};
    admitAction(s, p, input);
    steer(p, input, s.config, s);
    if (s.restartProtection && s.restartTeam !== p.team) {
      if (p.team === 0 && p.x >= -RULES.playerRadius && p.vx > 0) p.vx = 0;
      if (p.team === 1 && p.x <= RULES.playerRadius && p.vx < 0) p.vx = 0;
    }
  }
  let goal = false;
  for (let sub = 0; sub < 4; sub++) {
    resolveStrikes(s);
    const active =
      s.mode === "practice" ? s.players.filter((p) => p.team === 0) : s.players;
    const emit = (e: import("./contract").CryptballEvent) => {
      if (e.type === "pass-complete" && typeof e.passerId === "string") {
        const passer = s.players.find((p) => p.id === e.passerId);
        if (passer) recordStat(s, passer, "passes");
      }
      s.events.push({ ...e, epoch: s.epoch, counter: s.nextEvent++ });
    };
    const paths = movePlayers(active, s.ball, s.tick, emit, undefined, s);
    resolveChecks(s, paths);
    const team = moveBall(
      s.ball,
      paths,
      s.tick,
      emit,
      undefined,
      undefined,
      undefined,
      s,
    );
    if (team !== null) {
      if (s.mode === "match")
        s.remainingTicks = Math.max(0, s.remainingTicks - 1);
      scoreGoal(s, team);
      goal = true;
      break;
    }
  }
  if (!goal) {
    dragBall(s.ball);
    if (s.ball.passFrom && s.tick - s.ball.passTick >= 90) {
      s.ball.passFrom = s.ball.passTarget = null;
      s.ball.passTeam = null;
    }
    if (s.tick >= s.ball.powerExpires) {
      s.ball.bankBonusRemaining = 0;
      s.ball.powerTeam = null;
      s.ball.powerActionKey = null;
    }
    finishActions(s);
    s.restartProtection = Math.max(0, s.restartProtection - 1);
    if (s.mode === "match") {
      s.remainingTicks = Math.max(0, s.remainingTicks - 1);
      expireClock(s);
    }
  }
}
export function createCryptballSession(
  options: {
    sportId?: SportId;
    teamIds?: TeamSelection;
    mode?: "match" | "practice";
    seed?: number;
    config?: Partial<Omit<MatchConfig, "version">>;
    guardianPractice?: { weapon?: GuardianWeapon; immortal?: boolean };
  } = {},
): CryptballSession {
  let state = createInitialState(
    options.mode,
    options.config,
    options.sportId,
    options.teamIds,
    options.seed,
  );
  if (options.guardianPractice)
    configureGuardianPractice(state, options.guardianPractice);
  let rng = new DeterministicRandom([
    {
      owner: "cryptball",
      name: "ai",
      seed:
        ((Math.trunc(options.seed ?? 0xc7ba11) % 4294967296) + 4294967296) %
        4294967296,
    },
  ]);
  return {
    step(c = {}) {
      stepState(state, c, rng);
    },
    stepParticipants(commands = {}, policy = {}) {
      stepState(state, {}, rng, commands, policy);
    },
    setParticipants(participants) {
      if (
        participants.length > state.players.length ||
        new Set(participants.map((p) => p.id)).size !== participants.length ||
        new Set(participants.map((p) => p.playerId)).size !==
          participants.length
      )
        throw Error("Invalid participants");
      for (const p of participants)
        if (
          !/^[a-zA-Z0-9_-]{1,64}$/.test(p.id) ||
          !state.players.some((q) => q.id === p.playerId && q.team === p.team)
        )
          throw Error("Invalid participant ownership");
      state.controllers = participants.map((p) => ({
        ...p,
        active: p.active ?? true,
        canSwitch:
          state.players.find((q) => q.id === p.playerId)?.role !== "keeper" &&
          (isCooperativeSport(state.sportId) ||
            participants.filter((q) => q.team === p.team).length === 1),
        pendingSwitch: null,
        switchReady: state.tick,
        revision: 0,
      }));
      state.participantStats = Object.fromEntries(
        participants.map((p) => [p.id, { shots: 0, goals: 0, passes: 0 }]),
      );
      state.controlledId = participants[0]?.playerId ?? "player-0";
    },
    setParticipantActive(id, active) {
      const controller = state.controllers.find((p) => p.id === id);
      if (!controller) throw Error("Unknown participant");
      if (controller.active !== active) {
        controller.active = active;
        controller.revision++;
        controller.pendingSwitch = null;
        const p = state.players.find((p) => p.id === controller.playerId)!;
        p.charging = false;
        p.chargeTicks = 0;
        p.buffer = null;
        if (state.sportId !== "cryptcheck" || p.slideTicks)
          p.slideRecovery = state.sportId === "cryptcheck" ? 12 : 15;
        p.slideTicks = 0;
      }
    },
    sampleBallPose() {
      return { tick: state.tick, sportId: state.sportId, phase: state.phase,
        score: [...state.score] as [number, number], ball: { ...state.ball },
        possessionId: state.possessionId, restartTeam: state.restartTeam,
        restartProtection: state.restartProtection,
        volley: state.volley ? { ...state.volley } : null };
    },
    getTick() {
      return state.tick;
    },
    getControllerTransfer(id) {
      const controller = state.controllers.find(c => c.id === id);
      if (!controller) return undefined;
      const player = state.players.find(p => p.id === controller.playerId);
      return { canSwitch: controller.canSwitch, pending: !!controller.pendingSwitch ||
        (controller.canSwitch && supportsPassControlTransfer(state.sportId) && player?.action?.kind === "pass") };
    },
    getControllerRevision(id) {
      return state.controllers.find((c) => c.id === id)?.revision;
    },
    getPhase() {
      return state.phase;
    },
    capture() {
      const snapshot = structuredClone(state);
      snapshot.events = [];
      return { version: 16, state: snapshot, rng: rng.capture() };
    },
    restore(value) {
      const staged = validateCheckpoint(value, rng.capture());
      const stagedRng = new DeterministicRandom(
        staged.rng.streams.map(({ owner, name, seed }) => ({
          owner,
          name,
          seed,
        })),
      );
      stagedRng.restore(staged.rng);
      rng = stagedRng;
      state = staged.state;
    },
    observeFor(id) {
      const snapshot = this.observe();
      const controller = state.controllers.find((p) => p.id === id);
      if (!controller) throw Error("Unknown participant");
      snapshot.controlledId = controller.playerId;
      snapshot.stats = structuredClone(state.teamStats[controller.team]);
      return snapshot;
    },
    observe() {
      const {
        pendingSwitch,
        switchReady,
        nextAction,
        events,
        goalTeam,
        touchTick,
        ...observation
      } = state;
      return structuredClone(observation) as Observation;
    },
    drainEvents() {
      return state.events.splice(0);
    },
  };
}

export { predictVolleyLanding } from "./sports";
