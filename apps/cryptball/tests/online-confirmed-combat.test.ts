import { expect, it } from 'vitest';
import { createCryptballSession } from '../sim/session';
import { confirmedCombatPresentation } from '../src/online/confirmed-combat';
import { eligibleTouchTeammates } from '../src/control-events';

it('delayed authority withholds predicted Dodge life loss, out teleport and caught possession',()=>{
  const authority=createCryptballSession({sportId:'crypt-dodge'}).observe(),predicted=structuredClone(authority),p=predicted.players[0],known=authority.players[0];
  authority.dodge!.ball.state='hostile-flight';authority.dodge!.ball.holderId=null;authority.possessionId=null;
  predicted.dodge!.athletes[p.id].lives=0;p.y=86*256;p.staggerTicks=12;p.immunityTicks=45;
  predicted.dodge!.ball.state='held';predicted.dodge!.ball.holderId=p.id;predicted.possessionId=p.id;
  const before=structuredClone(predicted),draw=confirmedCombatPresentation(predicted,authority);
  expect(draw.dodge!.athletes[p.id].lives).toBe(3);expect(draw.players[0].y).toBe(known.y);expect(draw.players[0].staggerTicks).toBe(known.staggerTicks);
  expect(draw.dodge!.ball.state).toBe('hostile-flight');expect(draw.dodge!.ball.holderId).toBeNull();expect(draw.possessionId).toBeNull();expect(draw.ball).toEqual(authority.ball);
  expect(predicted).toEqual(before);
  authority.dodge!.ball.state='held';authority.dodge!.ball.holderId=p.id;authority.possessionId=p.id;authority.dodge!.athletes[p.id].lives=2;
  const confirmed=confirmedCombatPresentation(predicted,authority);
  expect(confirmed.dodge!.ball.holderId).toBe(p.id);expect(confirmed.possessionId).toBe(p.id);expect(confirmed.dodge!.athletes[p.id].lives).toBe(2);
});

it('delayed Guardian damage and phase transitions keep HP, cover and attack confirmation authoritative while movement stays predicted',()=>{
  const authority=createCryptballSession({sportId:'crypt-guardian'}).observe(),predicted=structuredClone(authority),p=predicted.players[0];
  p.x+=12*256;p.charging=true;p.chargeTicks=10;
  predicted.guardian!.hp=100;predicted.guardian!.stage=2;predicted.guardian!.transitionTicks=60;
  predicted.guardian!.athletes[p.id].hp=2;p.staggerTicks=12;p.immunityTicks=60;
  const cover=predicted.guardian!.cover[0];if(cover)cover.hp=0;
  const original=structuredClone(predicted),draw=confirmedCombatPresentation(predicted,authority);
  expect(draw.guardian!.hp).toBe(300);expect(draw.guardian!.stage).toBe(1);expect(draw.guardian!.transitionTicks).toBe(0);expect(draw.guardian!.attack).toEqual(authority.guardian!.attack);
  expect(draw.guardian!.athletes[p.id].hp).toBe(5);expect(draw.players[0].x).toBe(p.x);expect(draw.players[0].charging).toBe(true);expect(draw.players[0].chargeTicks).toBe(10);
  expect(draw.players[0].staggerTicks).toBe(authority.players[0].staggerTicks);expect(draw.guardian!.cover).toEqual(authority.guardian!.cover);expect(predicted).toEqual(original);
  authority.guardian!.hp=100;authority.guardian!.stage=2;authority.guardian!.transitionTicks=60;
  authority.guardian!.athletes[p.id].hp=2;
  const confirmed=confirmedCombatPresentation(predicted,authority);expect(confirmed.guardian!.hp).toBe(100);expect(confirmed.guardian!.stage).toBe(2);expect(confirmed.guardian!.athletes[p.id].hp).toBe(2);
});

it('revive channels never show a completed rescue before the confirming checkpoint',()=>{
  const authority=createCryptballSession({sportId:'crypt-guardian'}).observe(),predicted=structuredClone(authority),p=predicted.players[1];
  Object.assign(authority.guardian!.athletes[p.id],{status:'down',hp:0,reviveBy:predicted.players[0].id,reviveTicks:45});
  Object.assign(predicted.guardian!.athletes[p.id],{status:'active',hp:2,revives:1,reviveBy:null,reviveTicks:0});p.charging=true;p.slideTicks=10;
  const draw=confirmedCombatPresentation(predicted,authority);
  expect(draw.guardian!.athletes[p.id]).toMatchObject({status:'down',hp:0,revives:0,reviveTicks:45});expect(draw.players[1].charging).toBe(false);expect(draw.players[1].slideTicks).toBe(0);
  Object.assign(authority.guardian!.athletes[p.id],{status:'active',hp:2,revives:1,reviveBy:null,reviveTicks:0});
  expect(confirmedCombatPresentation(predicted,authority).guardian!.athletes[p.id]).toMatchObject({status:'active',hp:2,revives:1});
});

it('current checkpoint controller ownership reserves switched actors instead of the original lobby seat',()=>{
  const s=createCryptballSession({sportId:'crypt-guardian'}).observe(),[p0,p1]=s.players;s.controlledId=p1.id;
  expect(s.players).toHaveLength(2);
  const owners=[{id:'me',team:p0.team,playerId:p1.id},{id:'peer',team:p0.team,playerId:p0.id}];
  const targets=eligibleTouchTeammates(s,owners,'me').map(p=>p.id);
  expect(targets).toEqual([]);
  expect(eligibleTouchTeammates(s,owners.slice(0,1),'me').map(p=>p.id)).toEqual([p0.id]);
});

it('Guardian attack danger timing and projectile lifecycle stay authoritative between HP changes',()=>{
  const authority=createCryptballSession({sportId:'crypt-guardian'}).observe(),predicted=structuredClone(authority);
  predicted.guardian!.projectiles.push({id:'unconfirmed',attackId:4,x:256,y:0,vx:256,vy:0,radius:10,lifeTicks:30,endX:1000,endY:0,rx:0,ry:0});
  const draw=confirmedCombatPresentation(predicted,authority);
  expect(draw.guardian!.attack).toEqual(authority.guardian!.attack);
  expect(draw.guardian!.projectiles).toEqual([]);
  authority.guardian!.projectiles.push({...predicted.guardian!.projectiles[0],x:0});
  const confirmed=confirmedCombatPresentation(predicted,authority);
  expect(confirmed.guardian!.projectiles[0].x).toBe(256);
  expect(confirmed.guardian!.projectiles[0].lifeTicks).toBe(30);
});
