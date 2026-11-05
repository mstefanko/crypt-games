import type { World } from "./types";
import type { PlatformNpcIntent } from "./simulation";
export interface EncounterMind {
  actorId: number;
  role: "lunger" | "shooter" | "hover" | "boss";
  state: "approach" | "telegraph" | "commit" | "recover";
  ticks: number;
  phase: number;
}
export interface EncounterBossPhase {
  healthBelow: number;
  telegraphTicks: number;
  recoveryTicks: number;
  abilityId?: string;
}
export interface EncounterTuning {
  bossPhases?: readonly EncounterBossPhase[];
}
/** Room-sized deterministic acquire/telegraph/commit/recover behavior. Sleeping rooms never call it. */
export function roomEncounterIntents(
  w: World,
  minds: EncounterMind[],
  tuning: EncounterTuning = {},
): Map<number, PlatformNpcIntent> {
  const out = new Map<number, PlatformNpcIntent>(),
    player = w.actors.find((a) => a.slot !== null && a.health > 0);
  if (!player) return out;
  for (const m of minds) {
    const a = w.actors.find((a) => a.id === m.actorId);
    if (!a || a.health <= 0) continue;
    const dx = player.x - a.x,
      range = m.role === "shooter" ? 210 : m.role === "boss" ? 90 : 52;
    const phaseDefinition =
      m.role === "boss"
        ? tuning.bossPhases?.filter((p) => a.health < p.healthBelow).at(-1)
        : undefined;
    if (m.role === "boss")
      m.phase = phaseDefinition
        ? tuning.bossPhases!.indexOf(phaseDefinition) + 1
        : a.health < 90
          ? 2
          : 1;
    a.facing = dx < 0 ? -1 : 1;
    if (m.role === "hover") {
      const goal = player.y - 22 * 256;
      a.vy = Math.max(-384, Math.min(384, Math.trunc((goal - a.y) / 16)));
    }
    m.ticks++;
    if (m.state === "approach" && Math.abs(dx) < range * 256) {
      m.state = "telegraph";
      m.ticks = 0;
    } else if (
      m.state === "telegraph" &&
      m.ticks >= (phaseDefinition?.telegraphTicks ?? (m.phase === 2 ? 23 : 38))
    ) {
      m.state = "commit";
      m.ticks = 0;
    } else if (m.state === "commit" && m.ticks >= 22) {
      m.state = "recover";
      m.ticks = 0;
    } else if (
      m.state === "recover" &&
      m.ticks >= (phaseDefinition?.recoveryTicks ?? (m.phase === 2 ? 23 : 44))
    ) {
      m.state = "approach";
      m.ticks = 0;
    }
    if (
      m.role === "boss" &&
      m.state === "commit" &&
      m.ticks === 1 &&
      m.phase === 2 &&
      w.definitions.abilities.some(
        (d) => d.id === (phaseDefinition?.abilityId ?? "burst"),
      )
    ) {
      a.bufferedAbility = phaseDefinition?.abilityId ?? "burst";
      a.attackBuffer = 8;
    }
    out.set(a.id, {
      axis:
        m.state === "approach" && Math.abs(dx) > range * 256 * 0.7
          ? ((a.facing * 127) as -127 | 127)
          : m.state === "commit" && m.role !== "shooter"
            ? ((a.facing * 127) as -127 | 127)
            : 0,
      attack:
        m.state === "commit" &&
        m.ticks === 1 &&
        !(m.role === "boss" && m.phase === 2),
    });
  }
  return out;
}
