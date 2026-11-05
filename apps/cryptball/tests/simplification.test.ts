import {expect,it} from 'vitest';
import {createInitialState, SPORT_IDS} from '../sim/session';
import {sportHasSpecials} from '../sim/sports-spec';
import {admitSpecial} from '../sim/specials';
import {finishGuardianBall,moveGuardianBall} from '../sim/modes/crypt-guardian/ball';
import {MatchAuthority} from '../../cryptball-server/src/model';
it('teams cannot activate special moves in any sport',()=>{
  for(const id of SPORT_IDS){
    const s=createInitialState('match',{},id);s.phase='play';
    expect(sportHasSpecials(id)).toBe(false);
    expect(admitSpecial(s,s.players[0],{})).toBe(false);
    expect(s.specials.every(t=>t.active===null)).toBe(true);
  }
});
it('a missed guardian throw becomes collectible beside a player',()=>{
  const s=createInitialState('match',{},'crypt-guardian');s.phase='play';s.tick=100;
  const g=s.guardian!,p=s.players[0];p.x=0;p.y=40*256;
  s.possessionId=null; Object.assign(s.ball,{x:p.x,y:p.y,vx:0,vy:0,lastTouch:p.id,passTick:0});
  for(const orb of g.orbs)orb.possessionId=null;
  g.ballToken={id:1,playerId:p.id,damage:8};
  finishGuardianBall(s);expect(g.ballToken).toBeNull();
  moveGuardianBall(s);expect(s.possessionId).toBe(p.id);
});
it('shuffle changes only at a completed match and visits every competitive mode',()=>{
  const room=new MatchAuthority('shuffle-room',true,'cryptball',true);room.join('a','Ada');room.join('b','Bea');
  const modes=new Set([room.sportId]);
  room.rematch('a');expect(room.sportId).toBe('cryptball');
  for(let i=0;i<4;i++){
    room.phase='results';room.rematch('a');const before=room.sportId;
    room.rematch('b');expect(room.sportId).not.toBe(before);expect(room.phase).toBe('waiting');modes.add(room.sportId);
    expect(room.session.observe().sportId).toBe(room.sportId);
  }
  expect(modes.size).toBe(5);expect(modes.has('crypt-guardian')).toBe(false);
});
