import { actionPhase } from '@onepage/game-simulation/action-timeline';
import type { Observation } from './contract';
import type { CryptScoreId, CryptStingKind } from './audio-score';

export interface MusicStamp { matchId: string; epoch: number; generation: number; snapshotSeq: number }
export interface MusicIntent { scene: CryptScoreId; pressure: number; alert: boolean; attackTell: boolean }
/** Presentation only. All inputs must be confirmed observations, never prediction. */
export function musicIntent(s: Observation): MusicIntent {
  const base = { scene: s.phase === 'results' ? 'results' as const : s.sportId, pressure: 0, alert: false, attackTell: false };
  if (s.phase === 'results' || s.mode === 'practice') return base;
  if (s.sportId === 'rift-volley') {
    const point = s.score.some((n, i) => (n + 1 >= 11 && n + 1 - s.score[1 - i]! >= 2) || n + 1 >= 15);
    return { ...base, pressure: point ? 1 : 0, alert: point };
  }
  if (s.sportId === 'crypt-dodge' && s.dodge) {
    const lives = [0, 0];
    for (const p of s.players) lives[p.team]! += s.dodge.athletes[p.id]?.lives ?? 0;
    const decisive = s.score.some(n => n >= 1) || lives.some(n => n > 0 && n <= 2) || s.dodge.subphase === 'sudden-death';
    return { ...base, pressure: s.dodge.subphase === 'round-end' ? 0 : decisive ? 1 : 0 };
  }
  if (s.sportId === 'crypt-guardian' && s.guardian) {
    const g = s.guardian;
    const crisis = g.hp <= g.maxHp * .25 || Object.values(g.athletes).some(a => a.status === 'down') || s.remainingTicks <= 30 * 60;
    return { ...base, pressure: crisis ? 1 : g.stage === 2 ? .5 : 0, attackTell: !!g.attack && actionPhase(g.attack).phase === 'tell' };
  }
  const pressure = s.overtime || (s.remainingTicks <= 20 * 60 && Math.abs(s.score[0] - s.score[1]) <= 1);
  return { ...base, pressure: pressure ? 1 : 0, alert: s.overtime };
}
export interface MusicObservation { stamp?: MusicStamp; tick: number; phase: Observation['phase']; score: readonly number[]; intent: MusicIntent; guardianOutcome: 'victory'|'defeat'|null }
export function musicObservation(s: Observation, stamp?: MusicStamp): MusicObservation {
  return { stamp: stamp && { ...stamp }, tick: s.tick, phase: s.phase, score: [...s.score], intent: musicIntent(s), guardianOutcome: s.guardian?.outcome ?? null };
}
export function continuousMusic(before: MusicObservation, next: MusicObservation): boolean {
  if (next.tick < before.tick) return false;
  const a = before.stamp, b = next.stamp;
  if (!!a !== !!b) return false;
  if (a && b) return a.matchId === b.matchId && a.epoch === b.epoch && a.generation === b.generation && b.snapshotSeq > a.snapshotSeq;
  return next.tick > before.tick;
}
export function transitionSting(before: MusicObservation, next: MusicObservation, state: Observation, controlledTeam: 0|1|null): CryptStingKind | null {
  if (!continuousMusic(before, next)) return null;
  if (next.phase === 'results' && before.phase !== 'results') {
    if (next.guardianOutcome) return next.guardianOutcome;
    if (controlledTeam === null || state.winner === null || state.winner === 'draw') return null;
    return state.winner === controlledTeam ? 'victory' : 'defeat';
  }
  if (before.phase === 'ready' && next.phase === 'play') return 'start';
  if (next.intent.alert && !before.intent.alert) return 'match-point';
  if (next.phase !== 'results' && next.score.some((n,i) => n > before.score[i]!)) return 'point';
  return null;
}
