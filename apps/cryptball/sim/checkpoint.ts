import {
  specialBurst,
  specialKind,
  SPECIALS,
  SPECIAL_COOLDOWN_TICKS,
} from "./specials";
import { validateTeamSelection } from "./team-identities";
import { ROSTER, validateMatchConfig } from "./spec";
import { isSportId } from "./sports-spec";
import { validateDodgeState } from "./modes/crypt-dodge/index";
import { validateGuardianState } from "./modes/crypt-guardian/index";
import { isCooperativeSport, sportHasSpecials } from "./sports-spec";
import { HOCKEY } from "./modes/cryptcheck/spec";
import {
  DeterministicRandom,
  type RandomSnapshot,
} from "@onepage/game-simulation/random";
import type { Checkpoint } from "./contract";
/** Validate the entire detached candidate before either state or RNG is committed. */
export function validateCheckpoint(
  value: unknown,
  configured: RandomSnapshot,
): Checkpoint {
  if (!value || typeof value !== "object") throw Error("Invalid checkpoint");
  const checkpoint = structuredClone(value) as Checkpoint;
  if (checkpoint.version !== 16 || !checkpoint.state || !checkpoint.rng)
    throw Error("Incompatible checkpoint");
  const s = checkpoint.state;
  validateMatchConfig(s.config);
  validateTeamSelection(s.teamIds);
  const bounded = (n: unknown, min: number, max: number) => {
    if (!Number.isSafeInteger(n) || (n as number) < min || (n as number) > max)
      throw Error("Invalid checkpoint integer");
  };
  function origin(value: unknown) {
    if (value === undefined) return;
    const o = value as import("./contract").CommandOrigin;
    if (
      !o ||
      typeof o.participantId !== "string" ||
      !o.participantId ||
      o.participantId.length > 96 ||
      ![o.epoch, o.generation, o.seq].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      )
    )
      throw Error("Invalid command origin");
  }
  let nodes = 0;
  function finite(v: unknown, depth = 0): void {
    if (++nodes > 4096 || depth > 12) throw Error("Checkpoint bounds exceeded");
    if (typeof v === "number") {
      if (!Number.isFinite(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER)
        throw Error("Invalid checkpoint number");
    } else if (typeof v === "string") {
      if (v.length > 96) throw Error("Checkpoint string too long");
    } else if (v && typeof v === "object") {
      if (Array.isArray(v) && v.length > 64)
        throw Error("Checkpoint array too long");
      for (const x of Object.values(v)) finite(x, depth + 1);
    } else if (v !== null && v !== undefined && typeof v !== "boolean")
      throw Error("Invalid checkpoint value");
  }
  finite(s);
  for (const team of s.specials) origin(team.active?.origin);
  if (s.hockey)
    for (const skater of Object.values(s.hockey.skaters))
      origin(skater.check?.origin);
  bounded(s.tick, 0, 10_000_000);
  bounded(s.epoch, 1, 0x7fffffff);
  bounded(s.nextAction, 1, 10_000_000);
  bounded(s.nextEvent, 0, 100_000_000);
  if (
    !isSportId(s.sportId) ||
    !["match", "practice"].includes(s.mode) ||
    !["ready", "play", "goal", "results"].includes(s.phase) ||
    !Array.isArray(s.players) ||
    s.players.length !== (s.sportId === "crypt-guardian" ? 2 : ROSTER.playerCount) ||
    !Array.isArray(s.controllers) ||
    s.controllers.length > s.players.length ||
    !Array.isArray(s.events) ||
    s.events.length !== 0
  )
    throw Error("Invalid checkpoint state");
  bounded(s.remainingTicks, 0, s.sportId === "crypt-guardian" ? 10800 : 7200);
  bounded(s.phaseTicks, 0, 1800);
  bounded(s.score?.[0], 0, 10000);
  bounded(s.score?.[1], 0, 10000);
  if (
    s.score.length !== 2 ||
    typeof s.overtime !== "boolean" ||
    ![0, 1, "draw", null].includes(s.winner) ||
    ![0, 1, null].includes(s.restartTeam) ||
    ![0, 1, null].includes(s.goalTeam)
  )
    throw Error("Invalid match fields");
  bounded(s.restartProtection, 0, 60);
  bounded(s.switchReady, 0, 10_000_100);
  bounded(s.touchTick, -100, 10_000_000);
  const ids = s.players.map((p) => p.id);
  for (const [i, p] of s.players.entries()) {
    if (
      p.id !== `player-${i}` ||
      p.team !== (i < ROSTER.teamSize ? 0 : 1) ||
      p.role !== ROSTER.roles[i % ROSTER.teamSize] ||
      !["warrior", "knight"].includes(p.archetype)
    )
      throw Error("Invalid athlete");
    for (const key of ["x", "y", "vx", "vy", "rx", "ry"] as const)
      bounded(p[key], -200_000, 200_000);
    for (const flag of [p.charging, p.checked, p.aiPass, p.slideBallHit])
      if (typeof flag !== "boolean") throw Error("Invalid athlete flag");
    if (
      typeof p.aiRole !== "string" ||
      ![
        "support",
        "intercept",
        "defend-lane",
        "feed",
        "keeper",
        ...(s.sportId === "crypt-guardian"
          ? ["rescue", "collect", "outlet"]
          : []),
      ].includes(p.aiRole)
    )
      throw Error("Invalid AI role");
    for (const n of [p.aiX, p.aiY]) bounded(n, -200_000, 200_000);
    bounded(p.aiAim, 0, 255);
    bounded(p.dashHeading, 0, 255);
    bounded(p.slideHeading, 0, 255);
    bounded(p.slideTicks, 0, 24);
    bounded(p.slideRecovery, 0, 15);
    bounded(p.slideReady, 0, 10_000_100);
    bounded(p.actionReady, 0, 10_000_100);
    bounded(p.distance, 0, 1_000_000_000);
    bounded(p.roleTouch, -100, 10_000_000);
    bounded(p.heading, 0, 255);
    bounded(p.chargeTicks, 0, 42);
    for (const key of [
      "dashTicks",
      "dashCooldown",
      "staggerTicks",
      "immunityTicks",
      "aiNext",
      "aiSlideStart",
      "aiSlideUntil",
      "roleUntil",
    ] as const)
      bounded(p[key], 0, 10_000_100);
    origin(p.motionOrigin);
    origin(p.chargeOrigin);
    origin(p.action?.origin);
    origin(p.buffer?.origin);
    if (p.buffer) {
      if (!["strike", "pass"].includes(p.buffer.kind))
        throw Error("Invalid action buffer");
      bounded(p.buffer.until, 0, 10_000_100);
      bounded(p.buffer.charge, 0, 24);
    }
    if (p.action) {
      if (
        !["strike", "pass"].includes(p.action.kind) ||
        !Array.isArray(p.action.hits) ||
        p.action.hits.length > 5 ||
        p.action.hits.some((h) => typeof h !== "string")
      )
        throw Error("Invalid action");
      if (
        Object.keys(p.action.timing).sort().join(",") !== "active,recover,tell"
      )
        throw Error("Invalid timing");
      if (p.action.heading !== undefined) bounded(p.action.heading, 0, 255);
      if (p.action.charge !== undefined) bounded(p.action.charge, 0, 24);
      if (p.action.prepareUntil !== undefined) {
        if (s.sportId !== "cryptcheck")
          throw Error("Invalid hockey preparation");
        bounded(p.action.prepareUntil, 0, 10_000_100);
      }
      bounded(p.action.id, 1, s.nextAction);
      bounded(p.action.elapsed, 0, 100);
      for (const n of Object.values(p.action.timing)) bounded(n, 0, 100);
      if (p.action.targetId && !ids.includes(p.action.targetId))
        throw Error("Invalid action target");
    }
  }
  if (!Array.isArray(s.specials) || s.specials.length !== 2)
    throw Error("Invalid team specials");
  for (const [team, special] of s.specials.entries()) {
    if (
      !special ||
      Object.keys(special).sort().join(",") !==
        "active,cooldownTicks,rechargeTicks"
    )
      throw Error("Invalid special fields");
    bounded(special.cooldownTicks, 0, SPECIAL_COOLDOWN_TICKS);
    if (
      ![720, SPECIAL_COOLDOWN_TICKS].includes(special.rechargeTicks) ||
      special.cooldownTicks > special.rechargeTicks
    )
      throw Error("Invalid recharge");
    const active = special.active;
    if (active !== null) {
      if (
        !active ||
        Object.keys(active)
          .filter((key) => key !== "origin")
          .sort()
          .join(",") !==
          "burstStart,contactUsed,elapsedTicks,heading,playerId,receptionUsed,remainingTicks,secondBurstAvailable,stoppedTicks" ||
        !s.players.some((p) => p.id === active.playerId && p.team === team) ||
        s.phase !== "play" ||
        s.volley?.serving
      )
        throw Error("Invalid active special");
      const duration = SPECIALS[s.teamIds[team]].durationTicks;
      bounded(active.elapsedTicks, 0, duration - 1);
      bounded(active.remainingTicks, 1, duration);
      bounded(active.heading, 0, 255);
      bounded(active.burstStart, 6, 63);
      bounded(active.stoppedTicks, -1, active.elapsedTicks);
      for (const flag of [
        active.contactUsed,
        active.receptionUsed,
        active.secondBurstAvailable,
      ])
        if (typeof flag !== "boolean") throw Error("Invalid special flag");
      if (
        s.teamIds[team] !== "bats" &&
        (active.secondBurstAvailable || active.burstStart !== 6)
      )
        throw Error("Invalid special burst");
      if (
        s.teamIds[team] === "bats" &&
        ((!active.secondBurstAvailable && active.burstStart < 16) ||
          (active.secondBurstAvailable && active.burstStart !== 6))
      )
        throw Error("Invalid Flutter stage");
      const kind = s.teamIds[team];
      if (
        active.burstStart > Math.max(6, active.elapsedTicks) ||
        (active.stoppedTicks >= 0 &&
          (!["rams", "gators"].includes(kind) ||
            active.stoppedTicks < (kind === "rams" ? 9 : 6))) ||
        (active.receptionUsed && kind !== "owls") ||
        (active.contactUsed && !["rams", "gators"].includes(kind))
      )
        throw Error("Invalid special stage");
      if (
        active.elapsedTicks + active.remainingTicks !== duration ||
        special.cooldownTicks !== SPECIAL_COOLDOWN_TICKS - active.elapsedTicks
      )
        throw Error("Invalid special clock");
    }
  }
  bounded(s.possessionReady, 0, 10_000_100);
  if (s.possessionId !== null && !ids.includes(s.possessionId))
    throw Error("Invalid possession reference");
  for (const key of ["z", "vz", "rz"] as const)
    bounded(s.ball[key], key === "z" ? 0 : -200_000, 200_000);
  bounded(s.ball.rz, -239, 239);
  if (
    s.sportId !== "cryptkick" &&
    s.sportId !== "cryptcheck" &&
    s.sportId !== "crypt-dodge" &&
    s.sportId !== "crypt-guardian" &&
    s.possessionId !== null
  )
    throw Error("Possession belongs to a ground control sport");
  if (s.sportId === "cryptcheck") {
    const h = s.hockey;
    if (
      !h ||
      Object.keys(h).sort().join(",") !==
        "aiTeams,checkHits,contestSide,contestUntil,dropSide,faceoffLead,pokeActions,skaters" ||
      !Array.isArray(h.faceoffLead) ||
      h.faceoffLead.length !== 2 ||
      !s.players.some((p) => p.team === 0 && p.id === h.faceoffLead[0]) ||
      !s.players.some((p) => p.team === 1 && p.id === h.faceoffLead[1]) ||
      !h.checkHits ||
      typeof h.checkHits !== "object" ||
      Array.isArray(h.checkHits) ||
      !h.pokeActions ||
      typeof h.pokeActions !== "object" ||
      Array.isArray(h.pokeActions) ||
      !h.skaters ||
      typeof h.skaters !== "object" ||
      Array.isArray(h.skaters) ||
      Object.keys(h.skaters).sort().join(",") !== [...ids].sort().join(",") ||
      !Array.isArray(h.aiTeams) ||
      h.aiTeams.length !== 2 ||
      s.restartProtection !== 0 ||
      s.restartTeam !== null ||
      s.ball.bankBonusRemaining !== 0 ||
      s.ball.powerTeam !== null ||
      s.ball.powerActionKey !== null
    )
      throw Error("Invalid hockey state");
    bounded(h.contestUntil, 0, 10_000_100);
    if (![-1, 1].includes(h.contestSide) || ![-1, 0, 1].includes(h.dropSide))
      throw Error("Invalid hockey contest side");
    for (const [team, intent] of h.aiTeams.entries()) {
      if (
        !intent ||
        Object.keys(intent).sort().join(",") !==
          "approachSide,collectorId,progressDistance,progressTick,until" ||
        ![-1, 1].includes(intent.approachSide) ||
        (intent.collectorId !== null &&
          !s.players.some(
            (p) => p.id === intent.collectorId && p.team === team,
          ))
      )
        throw Error("Invalid hockey collector");
      bounded(intent.until, 0, 10_000_100);
      bounded(intent.progressTick, 0, 10_000_100);
      bounded(intent.progressDistance, 0, 400_000);
    }
    for (const [id, skater] of Object.entries(h.skaters)) {
      if (
        !skater ||
        Object.keys(skater).sort().join(",") !==
          "carryHeading,check,checkHeld,downHeading,downTicks,pokeHeld,recaptureUntil,receiveUntil" ||
        typeof skater.pokeHeld !== "boolean" ||
        typeof skater.checkHeld !== "boolean"
      )
        throw Error("Invalid hockey skater");
      bounded(skater.carryHeading, 0, 255);
      bounded(skater.downHeading, 0, 255);
      bounded(skater.downTicks, 0, 24);
      bounded(skater.receiveUntil, 0, 10_000_100);
      bounded(skater.recaptureUntil, 0, 10_000_100);
      const p = s.players.find((p) => p.id === id)!;
      if (
        (skater.downTicks &&
          (p.staggerTicks !== skater.downTicks ||
            p.immunityTicks < skater.downTicks ||
            p.action ||
            p.charging ||
            p.dashTicks ||
            p.slideTicks ||
            skater.check ||
            s.specials[p.team].active?.playerId === id)) ||
        (skater.check &&
          (p.action ||
            p.charging ||
            p.dashTicks ||
            p.slideTicks ||
            p.slideRecovery ||
            p.staggerTicks ||
            s.specials[p.team].active?.playerId === id))
      )
        throw Error("Invalid committed hockey action");
      if (skater.check !== null) {
        const check = skater.check;
        if (
          !check ||
          Object.keys(check)
            .filter((key) => key !== "origin")
            .sort()
            .join(",") !== "elapsed,heading,hits,id" ||
          !Array.isArray(check.hits) ||
          check.hits.length > 2 ||
          new Set(check.hits).size !== check.hits.length ||
          check.hits.length > 1 ||
          check.hits.some(
            (hitId) =>
              !s.players.some(
                (p) =>
                  p.id === hitId &&
                  p.team !== s.players.find((q) => q.id === id)!.team,
              ),
          )
        )
          throw Error("Invalid hockey check");
        bounded(check.id, 1, s.nextAction - 1);
        bounded(check.heading, 0, 255);
        bounded(check.elapsed, 0, 34);
        if (
          check.hits.length &&
          (check.elapsed < HOCKEY.checkTell ||
            check.hits.some(
              (id) => !s.players.find((p) => p.id === id)!.immunityTicks,
            ))
        )
          throw Error("Invalid hockey check contact receipt");
      }
    }
    for (const [id, hits] of Object.entries(h.checkHits)) {
      const player = s.players.find((p) => p.id === id);
      if (
        !player ||
        !Array.isArray(hits) ||
        hits.length > 2 ||
        new Set(hits).size !== hits.length ||
        hits.some(
          (hit) =>
            !s.players.some((p) => p.id === hit && p.team !== player.team),
        )
      )
        throw Error("Invalid hockey check receipt");
    }
    for (const [id, actionId] of Object.entries(h.pokeActions)) {
      if (!ids.includes(id)) throw Error("Invalid hockey poke owner");
      bounded(actionId, 1, s.nextAction - 1);
    }
    if (s.players.some((p) => p.slideTicks > 0 && !h.pokeActions[p.id]))
      throw Error("Missing hockey poke receipt");
    if (
      s.possessionId !== null &&
      !s.players.some(
        (p) =>
          p.id === s.possessionId &&
          s.phase === "play" &&
          !p.slideTicks &&
          !p.slideRecovery &&
          !p.staggerTicks &&
          !h.skaters[p.id].downTicks &&
          !h.skaters[p.id].check &&
          (!specialBurst(s, p) ||
            ["foxes", "bats"].includes(specialKind(s, p) ?? "")) &&
          specialKind(s, p) !== "gators",
      )
    )
      throw Error("Invalid hockey control");
  } else if (s.hockey !== null)
    throw Error("Hockey state belongs to Cryptcheck");
  if (s.sportId !== "rift-volley") {
    if (
      s.volley !== null ||
      (s.sportId !== "crypt-dodge" && s.ball.z !== 0) ||
      (s.sportId !== "crypt-dodge" && s.ball.vz !== 0) ||
      (s.sportId !== "crypt-dodge" && s.ball.rz !== 0)
    )
      throw Error("Invalid ground sport state");
  } else {
    const v = s.volley;
    if (
      !v ||
      Object.keys(v).sort().join(",") !==
        "contactTick,lastContactId,lastContactTeam,rally,serveTeam,serveTicks,serving,teamContacts" ||
      ![0, 1].includes(v.serveTeam) ||
      typeof v.serving !== "boolean" ||
      ![0, 1, null].includes(v.lastContactTeam) ||
      (v.lastContactId !== null && !ids.includes(v.lastContactId)) ||
      (v.lastContactId === null) !== (v.lastContactTeam === null) ||
      (v.lastContactId !== null &&
        s.players.find((p) => p.id === v.lastContactId)?.team !==
          v.lastContactTeam)
    )
      throw Error("Invalid volley state");
    bounded(v.teamContacts, 0, 3);
    bounded(v.rally, 0, 100_000);
    bounded(v.contactTick, -100, s.tick);
    bounded(v.serveTicks, 0, 180);
    if (
      (v.teamContacts > 0 && v.lastContactId === null) ||
      (v.serving &&
        (v.teamContacts !== 0 ||
          v.lastContactId !== null ||
          s.ball.vx !== 0 ||
          s.ball.vy !== 0 ||
          s.ball.vz !== 0)) ||
      s.players.some((p) =>
        p.team === 0 ? p.x > -10 * 256 : p.x < 10 * 256,
      ) ||
      (s.score.some((n) => n > 15) && s.mode === "match")
    )
      throw Error("Invalid volley invariant");
  }
  if (
    s.possessionId !== null &&
    s.sportId !== "crypt-dodge" &&
    s.sportId !== "crypt-guardian" &&
    ((s.sportId !== "cryptcheck" && s.ball.lastTouch !== s.possessionId) ||
      !s.players.some(
        (p) =>
          p.id === s.possessionId &&
          !p.slideTicks &&
          (s.sportId === "cryptcheck" || !p.dashTicks),
      ))
  )
    throw Error("Invalid possession invariant");
  const used = new Set<string>(),
    participants = new Set<string>();
  for (const c of s.controllers) {
    if (
      typeof c.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(c.id) ||
      participants.has(c.id) ||
      used.has(c.playerId) ||
      !s.players.some(
        (p) =>
          p.id === c.playerId &&
          (isCooperativeSport(s.sportId) || p.team === c.team),
      ) ||
      typeof c.active !== "boolean" ||
      typeof c.canSwitch !== "boolean"
    )
      throw Error("Invalid controller");
    participants.add(c.id);
    used.add(c.playerId);
    bounded(c.revision, 0, 10_000_000);
    bounded(c.switchReady, 0, 10_000_100);
    if (
      c.pendingSwitch &&
      !s.players.some(
        (p) =>
          p.id === c.pendingSwitch &&
          (isCooperativeSport(s.sportId) || p.team === c.team),
      )
    )
      throw Error("Invalid switch");
  }
  for (const key of ["x", "y", "vx", "vy", "rx", "ry"] as const)
    bounded(s.ball[key], -200_000, 200_000);
  if (
    ![0, 1, null].includes(s.ball.passTeam) ||
    ![0, 1, null].includes(s.ball.powerTeam)
  )
    throw Error("Invalid ball team");
  bounded(s.ball.passTick, 0, 10_000_000);
  bounded(s.ball.powerExpires, 0, 10_000_100);
  bounded(s.ball.bankBonusRemaining, 0, 1);
  bounded(s.ball.dragCarry, 0, 100_000);
  if (s.ball.powerActionKey !== null)
    bounded(s.ball.powerActionKey, 1, s.nextAction);
  if (!ids.includes(s.controlledId)) throw Error("Invalid controlled athlete");
  for (const ref of [
    s.ball.lastTouch,
    s.ball.passFrom,
    s.ball.passTarget,
    s.pendingSwitch,
  ])
    if (ref !== null && !ids.includes(ref))
      throw Error("Invalid ball reference");
  if (!Array.isArray(s.teamStats) || s.teamStats.length !== 2)
    throw Error("Invalid statistics");
  if (
    Object.keys(s.participantStats).sort().join(",") !==
    [...participants].sort().join(",")
  )
    throw Error("Invalid participant statistics");
  for (const stats of [...s.teamStats, ...Object.values(s.participantStats)])
    for (const n of [stats.shots, stats.goals, stats.passes])
      bounded(n, 0, 100_000);
  validateDodgeState(s);
  validateGuardianState(s);
  if (!sportHasSpecials(s.sportId) && s.specials.some((t) => t.active !== null))
    throw Error("Specials disabled for this mode");
  // Reuse the engine's exact seed/name/state/draw consistency validation in a
  // temporary owner, so failed validation never changes the live RNG.
  if (
    !Array.isArray(checkpoint.rng.streams) ||
    checkpoint.rng.streams.length !== configured.streams.length ||
    checkpoint.rng.streams.some(
      (stream, i) =>
        stream.name !== configured.streams[i].name ||
        stream.owner !== configured.streams[i].owner,
    )
  )
    throw Error("Invalid random ownership");
  const stagedRng = new DeterministicRandom(
    checkpoint.rng.streams.map(({ owner, name, seed }) => ({
      owner,
      name,
      seed,
    })),
  );
  stagedRng.restore(checkpoint.rng);
  return checkpoint;
}
