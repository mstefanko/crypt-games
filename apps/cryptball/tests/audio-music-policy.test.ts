import { describe, it, expect } from 'vitest';
import { createInitialState } from '../sim/session';
import { createCryptballSession } from '../sim/session';
import { musicIntent, musicObservation, transitionSting } from '../src/audio-music-policy';
describe('confirmed music policy', () => {
  it('makes timed pressure depend on both time and close score', () => {
    const s = createInitialState(); s.phase = 'play'; s.remainingTicks = 1200;
    expect(musicIntent(s).pressure).toBe(1);
    s.score = [4, 0]; expect(musicIntent(s).pressure).toBe(0);
    s.overtime = true; expect(musicIntent(s).pressure).toBe(1);
  });
  it('handles Volley win by two and the hard cap', () => {
    const s = createInitialState(); s.sportId = 'rift-volley';
    for (const [score, pressure] of [[[10, 10], 0], [[11, 10], 1], [[14, 14], 1], [[9, 8], 0], [[10, 8], 1]] as const) {
      s.score = [...score]; expect(musicIntent(s).pressure).toBe(pressure);
    }
  });
  it('reduces Dodge round pauses and distinguishes round from final victory', () => {
    const s = createCryptballSession({ sportId: 'crypt-dodge' }).observe();
    s.phase = 'play'; s.score = [1, 0]; expect(musicIntent(s).pressure).toBe(1);
    const before = musicObservation(s);
    s.tick++; s.phase = 'goal'; s.dodge!.subphase = 'round-end'; s.score = [1, 1];
    expect(musicIntent(s).pressure).toBe(0);
    expect(transitionSting(before, musicObservation(s), s, 0)).toBe('point');
  });
  it('escalates Guardian stage, health, ally down and time; shared results avoid a false win', () => {
    const s = createCryptballSession({ sportId: 'crypt-guardian' }).observe();
    s.phase = 'play'; s.remainingTicks = 3600; s.guardian!.stage = 2;
    expect(musicIntent(s).pressure).toBe(.5);
    s.guardian!.hp = 75; expect(musicIntent(s).pressure).toBe(1);
    s.guardian!.hp = 300; Object.values(s.guardian!.athletes)[0]!.status = 'down'; expect(musicIntent(s).pressure).toBe(1);
    Object.values(s.guardian!.athletes)[0]!.status = 'active'; s.remainingTicks = 1800; expect(musicIntent(s).pressure).toBe(1);
    const ordinary = createInitialState(); ordinary.phase = 'play'; const before = musicObservation(ordinary);
    ordinary.tick++; ordinary.phase = 'results'; ordinary.winner = 0;
    expect(transitionSting(before, musicObservation(ordinary), ordinary, null)).toBe(null);
    expect(transitionSting(before, musicObservation(ordinary), ordinary, 1)).toBe('defeat');
  });
});
