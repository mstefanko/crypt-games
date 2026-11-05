import { remainingTicks } from "./tick-deadline";
import type { ActorState, World, TickEvent } from "./types";
export function equipCombatActor(
  actor: ActorState,
  weapons: string[],
  skill: string,
  maxHealth = actor.health,
): void {
  actor.combatState = {
    weapons: [...weapons],
    equipped: 0,
    skill,
    damageBonus: 0,
    maxHealth,
    healCharges: 2,
    healTicks: 0,
    invulnerableTicks: 0,
    rollTick: -1,
    rollCooldown: 0,
    skillCooldown: 0,
    jumps: 0,
    combo: 0,
  };
}
export const COMBAT_DEFENSE_TUNING = Object.freeze({
  rollTicks: 21,
  rollInvulnerableStart: 3,
  rollInvulnerableEnd: 15,
  rollCooldownTicks: 42,
  postHitTicks: 38,
  healWindupTicks: 54,
});
export function isCombatInvulnerable(a: ActorState, w?: World): boolean {
  const s = a.combatState,
    execution = a.execution,
    window =
      execution &&
      w?.definitions.abilities.find((d) => d.id === execution.abilityId)
        ?.invulnerableWindow;
  return (
    (!!s &&
      (s.invulnerableTicks > 0 ||
        (s.rollTick >= COMBAT_DEFENSE_TUNING.rollInvulnerableStart &&
          s.rollTick < COMBAT_DEFENSE_TUNING.rollInvulnerableEnd))) ||
    (!!execution &&
      !!window &&
      execution.tick >= window[0] &&
      execution.tick < window[1])
  );
}
/** Actions use existing execution and contact resolution; cooldowns use simulation ticks. */
export function combatAction(
  w: World,
  actorId: number,
  action: "roll" | "heal" | "swap" | "skill" | "attack",
): boolean {
  const a = w.actors.find((a) => a.id === actorId),
    s = a?.combatState;
  if (!a || !s || a.health <= 0 || a.stunTicks || a.freezeTicks) return false;
  if (action === "swap") {
    s.equipped = (s.equipped + 1) % s.weapons.length;
    return true;
  }
  const execution = a.execution,
    definition =
      execution &&
      w.definitions.abilities.find((d) => d.id === execution.abilityId);
  const late =
    !execution ||
    (!!definition &&
      execution.tick >=
        (definition.cancelAfterTick ??
          definition.startup +
            definition.active +
            Math.floor(definition.recovery / 2)));
  if (
    definition?.invulnerableWindow &&
    execution &&
    execution.tick >= definition.invulnerableWindow[0] &&
    execution.tick < definition.invulnerableWindow[1]
  )
    s.invulnerableTicks = Math.max(s.invulnerableTicks, 1);
  if (action === "roll" && !s.rollCooldown && late) {
    a.execution = null;
    s.healTicks = 0;
    s.rollTick = 0;
    s.rollCooldown = 42;
    return true;
  }
  if (s.rollTick >= 0 || s.healTicks) return false;
  if (
    action === "heal" &&
    !execution &&
    s.healCharges &&
    a.health < s.maxHealth
  ) {
    s.healTicks = 54;
    return true;
  }
  if (action === "skill" && !s.skillCooldown && late) {
    const definition = w.definitions.abilities.find((d) => d.id === s.skill);
    if (
      definition?.tags?.includes("stationary") &&
      w.definitions.archetypes.some((d) => d.id === "spark-trap")
    ) {
      const trap: ActorState = {
        ...structuredClone(a),
        id: w.nextEntityId++,
        spawnId: `trap-${w.tick}-${a.id}`,
        archetypeId: "spark-trap",
        slot: null,
        x: a.x + a.facing * 20 * 256,
        vx: 0,
        vy: 0,
        health: 1,
        combatState: undefined,
        execution: {
          id: w.nextExecutionId++,
          abilityId: s.skill,
          tick: 0,
          hits: [],
        },
        ai: { direction: a.facing, decisionTicks: 0 },
      };
      delete trap.combatState;
      w.actors.push(trap);
    } else {
      a.execution = null;
      a.bufferedAbility = s.skill;
      a.attackBuffer = 8;
    }
    s.skillCooldown = 240;
    return true;
  }
  if (action === "attack" && late) {
    const weapon = s.weapons[s.equipped]!;
    if (
      (s.cooldownDeadlines?.[weapon] !== undefined
        ? remainingTicks(s.cooldownTick ?? 0, s.cooldownDeadlines[weapon]!)
        : (s.cooldowns?.[weapon] ?? 0)) > 0
    )
      return false;
    a.execution = null;
    s.combo = (s.combo + 1) % 3;
    a.bufferedAbility = weapon === "sword" ? `sword${s.combo}` : weapon;
    a.attackBuffer = 10;
    return true;
  }
  return false;
}
/** External projectile owners call the same defensive/damage semantics, never own actor health. */
export function applyCombatImpact(
  w: World,
  sourceId: number,
  targetId: number,
  damage: number,
): TickEvent[] {
  const a = w.actors.find((a) => a.id === sourceId),
    b = w.actors.find((a) => a.id === targetId);
  if (!b || b.health <= 0 || isCombatInvulnerable(b, w) || a?.team === b.team)
    return [];
  b.health = Math.max(0, b.health - damage);
  b.execution = null;
  b.stunTicks = 9;
  b.freezeTicks = 3;
  if (b.combatState) {
    b.combatState.invulnerableTicks = 38;
    b.combatState.healTicks = 0;
  }
  return [
    { type: "hit", tick: w.tick, actorId: sourceId, targetId },
    ...(b.health
      ? []
      : [{ type: "death" as const, tick: w.tick, actorId: targetId }]),
  ];
}
