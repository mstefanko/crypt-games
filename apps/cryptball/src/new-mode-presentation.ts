import type { Observation } from './contract';

export const isNewMode = (sport: string) => sport === 'crypt-dodge' || sport === 'crypt-guardian';
export function guardianPose(s: Observation): string {
  const g = s.guardian;
  if (!g) return 'idle-a';
  if (g.outcome === 'victory') return 'defeat'; // Presenter owns the bounded cosmetic finale clock.
  if (g.staggerUntil > s.tick) return 'stun';
  if (g.elapsed < 30) return 'wake';
  if (g.transitionTicks > 0) return 'roar';
  const a = g.attack;
  if (!a) return Math.floor(s.tick / 24) % 2 ? 'idle-b' : 'idle-a';
  const ranged = a.kind === 'shot' || a.kind === 'fan';
  if (a.elapsed < a.timing.tell) return ranged ? a.locked ? 'ranged-aim' : 'ranged-tell' : 'melee-tell';
  if (a.elapsed >= a.timing.tell + a.timing.active) return ranged ? 'ranged-recover' : 'melee-recover';
  return ranged ? 'ranged-recoil' : a.kind === 'hook' || a.kind === 'sweep' ? 'sweep' : 'slam';
}
export function modeStatus(s: Observation, touch = false) {
  if (s.dodge) {
    const d = s.dodge, mine = d.athletes[s.controlledId];
    if (!mine?.lives) return touch ? 'OUT · TAP AN ALLY RING TO SWITCH' : 'OUT · Q switches to an eligible surviving ally';
    if (d.subphase === 'countdown') return `ROUND ${d.round} · THROWS IN ${Math.max(1, Math.ceil(s.phaseTicks / 60))}`;
    if (d.subphase === 'round-end') return d.roundWinner === 'draw' ? 'DRAWN ROUND · REPLAYING' : `ROUND ${d.round} WON · ${d.roundWinner === 0 ? 'LEFT' : 'RIGHT'} SIDE`;
    if (d.subphase === 'settling') return 'TIME · LAST LIVE THROW';
    if (d.subphase === 'sudden-death') return `SUDDEN DEATH · NEXT DING WINS · ${Math.ceil(d.suddenDeathTicks / 60)}s`;
    const possession = d.possessionDeadline > s.tick ? ` · POSSESSION ${Math.ceil((d.possessionDeadline - s.tick) / 60)}s` : '';
    return `${d.balls.some(ball => !ball.retired && ball.mode.state === 'held' && ball.mode.holderId === s.controlledId) ? touch ? 'HOLD / RELEASE TO THROW · TAP TO PASS' : 'HOLD J / RELEASE TO THROW · K PASSES' : touch ? 'TAP TO CATCH · FLICK TO DIVE' : 'J CATCHES · SHIFT DIVES'}${possession}`;
  }
  if (s.guardian) {
    const g = s.guardian, mine = g.athletes[s.controlledId];
    if (mine?.status === 'out') return touch ? 'OUT · TAP AN ALLY RING TO SWITCH' : 'OUT · ONE REVIVE USED · Q switches to an eligible ally';
    if (mine?.status === 'down') return 'DOWN · AN ALLY CAN REVIVE YOU BY HOLDING NEAR YOUR SOUL';
    const reviving = Object.values(g.athletes).find(p => p.reviveBy === s.controlledId);
    if (reviving) return `REVIVING ${Math.floor(reviving.reviveTicks / 90 * 100)}% · KEEP HOLDING`;
    if (g.ballResetTicks) return 'ORB RETURN · CLEAR THE CENTER LANE';
    if (g.transitionTicks) return 'GUARDIAN ENRAGED · SECOND PATTERN AWAKENS';
    if (s.mode === 'practice' && g.attack) {
      const a = g.attack;
      return `${a.kind.toUpperCase()} · ${a.elapsed < a.timing.tell ? 'TELL' : a.elapsed < a.timing.tell + a.timing.active ? 'ATTACK' : 'RECOVERY'}`;
    }
    return g.orbs.some(orb=>orb.possessionId===s.controlledId) ? touch ? 'HOLD / RELEASE TO THROW · TAP TO PASS' : 'HOLD J / RELEASE TO THROW · K PASSES' : touch ? 'TAP / FLICK TO EVADE · HOLD TO CATCH · HOLD NEAR SOUL TO REVIVE' : 'J CATCHES · COLLECT LOOSE ORBS · SHIFT DIVES · HOLD K NEAR A SOUL TO REVIVE';
  }
  return '';
}

/** Warnings follow each authoritative orb, including an off-primary rebound. */
export function guardianDeflectionCues(s: Observation) {
  return s.guardian?.orbs.filter(orb=>orb.deflectUntil>s.tick).map(orb=>({id:orb.id,x:orb.ball.x,y:orb.ball.y,z:orb.ball.z,until:orb.deflectUntil})) ?? [];
}
/** The lifted maul visibly reaches the collision plane at contact. */
export function maulApproachLift(approach: number) {
  return 30*Math.sin(Math.max(0,Math.min(1,approach))*Math.PI);
}
