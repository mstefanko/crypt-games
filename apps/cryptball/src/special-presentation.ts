import { Graphics } from "@onepage/game-runtime/pixi";
import type {
  Observation,
  Player,
  TeamSpecialState,
  SportId,
} from "./contract";
import { SPECIALS, specialTell, flutterFollowup } from "../sim/session";
import { TEAMS, type TeamId } from "../sim/team-identities";
import { headingVector } from "../sim/rules";
import { projectCourt } from "./projection";

/** Pure snapshot-derived phases: rejoining never replays or invents an activation. */
export function specialPhase(
  elapsed: number,
  _duration: number,
  id: TeamId = "rams",
  active?: TeamSpecialState["active"],
  sport?: SportId,
) {
  if (elapsed < specialTell(id)) return "anticipation";
  if (
    (active && active.stoppedTicks >= 0) ||
    (id === "rams" && elapsed >= 30) ||
    (id === "gators" && elapsed >= (sport === "cryptcheck" ? 24 : 30)) ||
    (id === "foxes" && elapsed >= 20)
  )
    return "recovery";
  if (id === "bats" && elapsed >= (active?.burstStart ?? 6) + 10) return "gap";
  return "active";
}
export function specialHud(state: Observation, team: 0 | 1) {
  const id = state.teamIds[team],
    special = state.specials[team],
    meta = SPECIALS[id];
  const active = special.active;
  const activator =
    active?.playerId === state.controlledId
      ? "YOU"
      : `ATHLETE ${state.players.filter((p) => p.team === team).findIndex((p) => p.id === active?.playerId) + 1}`;
  const player = state.players.find((p) => p.id === state.controlledId);
  const followupReady =
    !!player &&
    player.team === team &&
    flutterFollowup(state, player) &&
    !player.staggerTicks &&
    !player.action &&
    !player.charging &&
    !state.hockey?.skaters[player.id]?.check &&
    !state.hockey?.skaters[player.id]?.downTicks;
  return {
    id,
    name: meta.name,
    followupReady,
    actionable: special.cooldownTicks === 0 || followupReady,
    ready: special.cooldownTicks === 0,
    progress: 1 - special.cooldownTicks / special.rechargeTicks,
    text: followupReady
      ? "BURST AGAIN · TAP / B"
      : active
        ? `ACTIVE ${(active.remainingTicks / 60).toFixed(1)}s · ${activator}`
        : special.cooldownTicks
          ? `${Math.ceil(special.cooldownTicks / 60)}s`
          : "READY",
  };
}
export function specialPose(
  p: Player,
  s: Observation,
  fallback: { clip: string; phase: number; instance: string; lift?: number },
) {
  const active = s.specials[p.team].active;
  // Actions and physical recovery retain their authoritative key poses.
  if (
    !active ||
    active.playerId !== p.id ||
    p.action ||
    p.charging ||
    p.slideTicks ||
    p.slideRecovery ||
    p.staggerTicks ||
    s.hockey?.skaters[p.id]?.check ||
    s.hockey?.skaters[p.id]?.downTicks
  )
    return fallback;
  const id = s.teamIds[p.team],
    duration = SPECIALS[id].durationTicks;
  const phase = specialPhase(
    active.elapsedTicks,
    duration,
    id,
    active,
    s.sportId,
  );
  if (
    ((id === "owls" || id === "hornets") && phase !== "anticipation") ||
    phase === "gap"
  )
    return fallback;
  if (s.sportId === "cryptcheck") {
    const clip =
      phase === "anticipation"
        ? "idle"
        : phase === "recovery"
          ? "recover"
          : id === "rams"
            ? "shoulder"
            : id === "gators"
              ? "poke"
              : "burst";
    return {
      clip,
      phase: phase === "anticipation" ? 0 : phase === "recovery" ? 0.2 : 0.4,
      instance: `hockey:special:${s.tick - active.elapsedTicks}:${phase}`,
    };
  }
  const sport = s.sportId !== "cryptball";
  const recoveryStart =
    active.stoppedTicks >= 0
      ? active.stoppedTicks
      : id === "rams"
        ? 30
        : id === "foxes"
          ? 20
          : 30;
  const recoveryLength =
    active.stoppedTicks >= 0
      ? id === "gators"
        ? 6
        : 12
      : id === "gators"
        ? 20
        : id === "foxes"
          ? 4
          : 12;
  const recoveryPhase = Math.max(
    0,
    Math.min(1, (active.elapsedTicks - recoveryStart) / recoveryLength),
  );
  const clip =
    phase === "anticipation"
      ? sport
        ? "idle"
        : "power"
      : phase === "recovery"
        ? sport
          ? "idle"
          : "slide-recover"
        : sport
          ? "run"
          : "sprint";
  return {
    clip,
    phase:
      phase === "anticipation"
        ? (active.elapsedTicks / specialTell(id)) * 0.3
        : phase === "recovery"
          ? recoveryPhase
          : (active.elapsedTicks % 12) / 12,
    instance: `special:${s.tick - active.elapsedTicks}:${phase}`,
  };
}
/** Small ground-level mascot signatures leave the ball and contact silhouettes clear. */
export function renderSpecialEffects(
  g: Graphics,
  s: Observation,
  reducedMotion: boolean,
) {
  g.clear();
  for (const team of [0, 1] as const) {
    const active = s.specials[team].active;
    if (!active) continue;
    const p = s.players.find((p) => p.id === active.playerId);
    if (!p) continue;
    const id: TeamId = s.teamIds[team],
      foot = projectCourt(p.x / 256, p.y / 256);
    const color = Number.parseInt(TEAMS[id].color.slice(1), 16);
    const phase = specialPhase(
      active.elapsedTicks,
      SPECIALS[id].durationTicks,
      id,
      active,
      s.sportId,
    );
    const alpha = phase === "recovery" || phase === "gap" ? 0.3 : 0.65;
    const wave = reducedMotion ? 0 : Math.sin(active.elapsedTicks * 0.5) * 2;
    const x = foot.x,
      y = foot.y + 3;
    g.ellipse(x, y, 13 + wave, 4).stroke({ color, width: 1.5, alpha });
    if (
      active.stoppedTicks >= 0 &&
      active.elapsedTicks - active.stoppedTicks < 6
    )
      g.ellipse(
        x,
        y,
        reducedMotion
          ? 18
          : 15 + (active.elapsedTicks - active.stoppedTicks) * 2,
        6,
      ).stroke({ color: 0xffffff, width: 2, alpha: 0.75 });
    // Horns, forked tail, eyes, jaws, wings and sting are distinct at court scale.
    if (id === "rams")
      for (const side of [-1, 1])
        g.arc(
          x + side * 11,
          y - 2,
          5,
          side < 0 ? 0 : Math.PI,
          side < 0 ? Math.PI * 1.6 : Math.PI * 2.6,
        ).stroke({ color, width: 2, alpha });
    if (id === "foxes")
      g.moveTo(x - 18, y)
        .lineTo(x - 26, y - 4 - wave)
        .lineTo(x - 23, y + 2)
        .lineTo(x - 31, y + 3)
        .stroke({ color, width: 2, alpha });
    if (id === "owls")
      for (const side of [-1, 1])
        g.circle(x + side * 6, y - 5, 3).stroke({ color, width: 1.5, alpha });
    if (id === "gators") {
      const d = headingVector(active.heading),
        reach = projectCourt(
          p.x / 256 + (d.x / 65536) * 22,
          p.y / 256 + (d.y / 65536) * 22,
        );
      g.moveTo(x, y)
        .lineTo(reach.x, reach.y + 3)
        .stroke({ color, width: 8, alpha: alpha * 0.2 });
      g.moveTo(x - 15, y - 6)
        .lineTo(x - 8, y - 3)
        .lineTo(x, y - 6)
        .lineTo(x + 8, y - 3)
        .lineTo(x + 15, y - 6)
        .stroke({ color, width: 2, alpha });
    }
    if (id === "bats")
      for (const side of [-1, 1])
        g.moveTo(x + side * 8, y)
          .lineTo(x + side * 23, y - 7 - wave)
          .lineTo(x + side * 17, y + 1)
          .lineTo(x + side * 12, y - 2)
          .stroke({ color, width: 1.5, alpha });
    if (id === "hornets") {
      for (let i = 0; i < 3; i++)
        g.moveTo(x - 8 + i * 7, y - 5)
          .lineTo(x - 11 + i * 7, y + 3)
          .stroke({ color, width: 2, alpha });
      g.moveTo(x + 15, y)
        .lineTo(x + 23, y)
        .lineTo(x + 18, y + 3)
        .stroke({ color, width: 1.5, alpha });
    }
  }
}
