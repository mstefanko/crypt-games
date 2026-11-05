import { describe, expect, it } from 'vitest';
import { pack, unpack } from 'msgpackr';
import { MatchAuthority } from '../../cryptball-server/src/model';
import { encodeSnapshot, decodeSnapshot } from '../protocol';
import { createCryptballSession } from '../sim/session';
import { confirmedCombatPresentation } from '../src/online/confirmed-combat';
import { athleteAnimation } from '../src/animation';
import { guardianDeflectionCues, maulApproachLift, modeStatus } from '../src/new-mode-presentation';

describe('multi-ball presentation and reconnect',()=>{
  for(const sportId of ['crypt-dodge','crypt-guardian'] as const) it(`${sportId} survives transport without shared references and reconnect replay`,()=>{
    const live=createCryptballSession({sportId,mode:'practice',seed:197});
    for(let i=0;i<120;i++)live.step({});
    const transported=unpack(pack(live.capture()));
    const restored=createCryptballSession({sportId,mode:'practice',seed:1});
    restored.restore(transported);
    for(let i=0;i<180;i++) {live.step({});restored.step({});}
    expect(restored.capture()).toEqual(live.capture());
    const state=restored.observe();
    expect(state.dodge?.balls.length ?? state.guardian?.orbs.length).toBe(2);
  });
  for(const sportId of ['crypt-dodge','crypt-guardian'] as const) it(`${sportId} authority snapshot fits the wire budget and restores both balls`,()=>{
    const authority=new MatchAuthority('multi-ball',false,sportId);
    authority.join('a','Ally');authority.join('b','Peer');authority.ready('a');authority.ready('b');authority.start();
    for(let i=0;i<240;i++)authority.advance();
    const decoded=decodeSnapshot(encodeSnapshot(authority.snapshot('a',[])));
    const replica=createCryptballSession({sportId});replica.restore(decoded.checkpoint);
    expect(replica.capture()).toEqual(decoded.checkpoint);
    expect(decoded.checkpoint.state.dodge?.balls.length ?? decoded.checkpoint.state.guardian?.orbs.length).toBe(2);
  });
  it('confirms each secondary Dodge ball independently and renders carry for its holder',()=>{
    const authority=createCryptballSession({sportId:'crypt-dodge'}).observe(),predicted=structuredClone(authority);
    const secondary=authority.dodge!.balls[1],p=authority.players[1];
    secondary.mode.state='held';secondary.mode.holderId=p.id;secondary.mode.throwId++;
    const draw=confirmedCombatPresentation(predicted,authority);
    expect(draw.dodge!.balls[1].mode.holderId).toBe(p.id);
    expect(athleteAnimation(draw.players[1],draw).clip).toBe('carry');
  });
  it('confirms secondary Guardian ownership and guard resources without predicting damage',()=>{
    const authority=createCryptballSession({sportId:'crypt-guardian'}).observe(),predicted=structuredClone(authority),p=authority.players[1];
    authority.guardian!.orbs[1].possessionId=p.id;authority.guardian!.guard=35;authority.guardian!.staggerUntil=authority.tick+40;
    predicted.guardian!.guard=0;
    const draw=confirmedCombatPresentation(predicted,authority);
    expect(draw.guardian!.orbs[1].possessionId).toBe(p.id);expect(draw.guardian!.guard).toBe(35);
    expect(athleteAnimation(draw.players[1],draw).clip).toBe('carry');
    draw.controlledId=p.id;expect(modeStatus(draw)).toContain('RELEASE TO THROW');
    expect(modeStatus(draw)).not.toContain('WARNING');
  });
});

it('warns for secondary-orb deflection independently and lands the maul at contact',()=>{
  const state=createCryptballSession({sportId:'crypt-guardian'}).observe();
  state.tick=80;state.guardian!.deflectUntil=0;
  state.guardian!.orbs[0].deflectUntil=0;state.guardian!.orbs[1].deflectUntil=95;
  expect(guardianDeflectionCues(state)).toEqual([{id:'guardian-1',x:state.guardian!.orbs[1].ball.x,y:state.guardian!.orbs[1].ball.y,z:state.guardian!.orbs[1].ball.z,until:95}]);
  state.tick=95;expect(guardianDeflectionCues(state)).toEqual([]);
  expect(maulApproachLift(0)).toBe(0);expect(maulApproachLift(.5)).toBe(30);expect(maulApproachLift(1)).toBeCloseTo(0);
});
