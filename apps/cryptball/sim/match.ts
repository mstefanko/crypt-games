import { clearSpecials } from "./specials";
import { COURT, ROSTER } from "./spec";
import { length } from "./rules";
import type { State, Team, Player } from "./contract";
import { FIXED as F, RULES } from "./rules";
import { event, recordStat } from "./actions";
export function makePlayer(i: number): Player {
  return {
    id: `player-${i}`,
    team: i < ROSTER.teamSize ? 0 : 1,
    role: ROSTER.roles[i % ROSTER.teamSize],
    slideTicks: 0,
    slideBallHit: false,
    slideHeading: 0,
    slideRecovery: 0,
    slideReady: 0,
    actionReady: 0,
    archetype: i % 2 ? "knight" : "warrior",
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    heading: i < ROSTER.teamSize ? 0 : 128,
    action: null,
    chargeTicks: 0,
    charging: false,
    dashTicks: 0,
    dashCooldown: 0,
    dashHeading: 0,
    checked: false,
    staggerTicks: 0,
    immunityTicks: 0,
    distance: 0,
    aiRole: "support",
    aiX: 0,
    aiY: 0,
    aiAim: 0,
    aiNext: 0,
    roleUntil: 0,
    roleTouch: -1,
    aiPass: false,
    aiSlideStart: 0,
    aiSlideUntil: 0,
    buffer: null,
    rx: 0,
    ry: 0,
  };
}
export function resetCourt(s: State, team: Team | null = null) {
  clearSpecials(s);
  const poses = s.players.map((p, i) => {
    const side = p.team === 0 ? -1 : 1;
    const slot = i % ROSTER.teamSize;
    if (p.role === "keeper") return [side * (COURT.halfLength - 16), 0];
    if (team === null)
      return [
        side * (slot === 0 ? 55 : 110),
        slot === 0 ? -24 * side : 38 * side,
      ];
    return [
      side *
        (team === p.team ? (slot === 0 ? 90 : 120) : slot === 0 ? 55 : 105),
      slot === 0 ? 0 : 42 * side,
    ];
  });
  s.players = s.players.map((p, i) => ({
    ...makePlayer(i),
    x: poses[i][0] * F,
    y: poses[i][1] * F,
    distance: p.distance,
    aiNext: s.tick + (i % 3) * 2,
  }));
  s.possessionId = null;
  s.possessionReady = s.tick;
  s.ball = {
    z: 0,
    vz: 0,
    rz: 0,
    x: team === null ? 0 : (team === 0 ? -70 : 70) * F,
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
  };
  s.restartTeam = team;
  s.restartProtection = team === null ? 0 : 60;
  s.pendingSwitch = null;
  for (const controller of s.controllers) controller.pendingSwitch = null;
  s.goalTeam = null;
}
export function finishMatch(s: State) {
  clearSpecials(s);
  if (s.sportId === "cryptcheck") s.possessionId = null;
  s.phase = "results";
  s.phaseTicks = 0;
  s.winner =
    s.score[0] === s.score[1] ? "draw" : s.score[0] > s.score[1] ? 0 : 1;
  event(s, "match-end", undefined, { winner: s.winner });
}
export function expireClock(s: State) {
  if (s.mode === "practice") return;
  if (s.remainingTicks > 0) return;
  if (!s.overtime && s.score[0] === s.score[1]) {
    s.overtime = true;
    s.remainingTicks = RULES.overtimeTicks;
    s.phase = "ready";
    s.phaseTicks = 60;
    resetCourt(s);
    event(s, "overtime");
  } else finishMatch(s);
}
export function scoreGoal(s: State, team: Team) {
  clearSpecials(s);
  s.score[team]++;
  const scorer = s.players.find(
    (p) => p.id === s.ball.lastTouch && p.team === team,
  );
  if (scorer) recordStat(s, scorer, "goals");
  else s.teamStats[team].goals++;
  s.stats = s.teamStats[0];
  s.ball.passFrom = s.ball.passTarget = null;
  s.ball.passTeam = null;
  s.ball.bankBonusRemaining = 0;
  s.ball.powerTeam = null;
  s.ball.powerActionKey = null;
  s.goalTeam = team;
  event(
    s,
    "goal",
    s.players.find((p) => p.id === s.ball.lastTouch),
    { team, x: s.ball.x, y: s.ball.y },
  );
  if (s.overtime && s.mode === "match") {
    finishMatch(s);
    return;
  }
  s.phase = "goal";
  s.phaseTicks = 54;
}
export function advancePhase(s: State) {
  if (s.phase === "results") return;
  if (--s.phaseTicks > 0) return;
  if (s.phase === "goal") {
    if (s.mode === "match" && s.remainingTicks === 0) {
      expireClock(s);
      return;
    }
    const conceding = (s.goalTeam === 0 ? 1 : 0) as Team;
    resetCourt(s, conceding);
    s.phase = "ready";
    s.phaseTicks = 24;
  } else {
    s.phase = "play";
    event(s, "whistle");
  }
}
