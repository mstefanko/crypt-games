import { expect, it } from 'vitest';
import { createCryptballSession } from '../sim/session';
import { guardianDamagePlayer } from '../sim/modes/crypt-guardian/damage';
import { confirmedCombatPresentation } from '../src/online/confirmed-combat';
const predictionPolicy={automaticSwitches:false};
function guardian(){
  const s=createCryptballSession({sportId:'crypt-guardian'}),players=s.observe().players;
  // Solo Guardian has two allies; leave the second available for survival/manual switches.
  s.setParticipants([{id:'me',playerId:players[0].id,team:players[0].team}]);
  const cp=s.capture();cp.state.phase='play';cp.state.phaseTicks=0;s.restore(cp);return s;
}
it('predicted incoming damage never automatically changes controlled identity or packet revision before its checkpoint',()=>{
  const prediction=guardian(),cp=prediction.capture(),p=cp.state.players[0];
  cp.state.guardian!.athletes[p.id].hp=1;prediction.restore(cp);
  const authority=prediction.observeFor('me'),revision=prediction.getControllerRevision('me');
  guardianDamagePlayer(cp.state,p,123);expect(cp.state.guardian!.athletes[p.id].status).toBe('down');cp.state.events=[];
  prediction.restore(cp);prediction.drainEvents();prediction.stepParticipants({},predictionPolicy);
  expect(prediction.observeFor('me').controlledId).toBe(p.id);expect(prediction.getControllerRevision('me')).toBe(revision);
  expect(prediction.drainEvents().filter(e=>e.type==='switch')).toEqual([]);
  const display=confirmedCombatPresentation(prediction.observeFor('me'),authority);
  expect(display.controlledId).toBe(p.id);expect(display.guardian!.athletes[p.id]).toMatchObject({status:'active',hp:1});
  // The actual authority still performs its normal automatic survival switch.
  const server=guardian();server.restore(cp);server.drainEvents();server.stepParticipants({});
  expect(server.observeFor('me').controlledId).not.toBe(p.id);expect(server.getControllerRevision('me')).toBe(revision!+1);
  expect(server.drainEvents().some(e=>e.type==='switch'&&e.automatic===true)).toBe(true);
});
it('manual Q targeting remains predicted and revises ownership normally',()=>{
  const prediction=guardian(),server=guardian(),target=prediction.observe().players[1].id;
  const command={me:{switch:true,switchTarget:target}};
  prediction.stepParticipants(command,predictionPolicy);server.stepParticipants(command);
  expect(prediction.observeFor('me').controlledId).toBe(target);expect(prediction.getControllerRevision('me')).toBe(1);
  expect(server.observeFor('me').controlledId).toBe(target);expect(server.getControllerRevision('me')).toBe(1);
  expect(prediction.drainEvents().some(e=>e.type==='switch'&&e.automatic!==true)).toBe(true);
});
it('predicted Dodge elimination also keeps the current controller until authority switches',()=>{
  const prediction=createCryptballSession({sportId:'crypt-dodge'}),cp=prediction.capture(),p=cp.state.players[0];
  cp.state.phase='play';cp.state.phaseTicks=0;cp.state.dodge!.subphase='live';cp.state.dodge!.athletes[p.id].lives=0;
  if(cp.state.dodge!.ball.holderId===p.id){cp.state.dodge!.ball.holderId=null;cp.state.dodge!.ball.state='dead-loose';cp.state.possessionId=null;}
  prediction.restore(cp);prediction.stepParticipants({},predictionPolicy);
  expect(prediction.observe().controlledId).toBe(p.id);expect(prediction.getControllerRevision('local')).toBe(0);
  const server=createCryptballSession({sportId:'crypt-dodge'});server.restore(cp);server.stepParticipants({});
  expect(server.observe().controlledId).not.toBe(p.id);
});
