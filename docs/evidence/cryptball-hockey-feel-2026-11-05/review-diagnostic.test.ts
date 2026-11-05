import { it, vi, expect } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInitialState, stepState } from '../../../apps/cryptball/sim/session';
import { DeterministicRandom } from '@onepage/game-simulation/random';
import { FIXED as F, length } from '../../../apps/cryptball/sim/rules';
import { clearLane } from '../../../apps/cryptball/sim/prediction';
import { groundBallPhysics } from '../../../apps/cryptball/sim/sports-spec';
import * as control from '../../../apps/cryptball/sim/modes/cryptcheck/control';
import { HOCKEY } from '../../../apps/cryptball/sim/modes/cryptcheck/spec';
it('measures original retention failures without changing simulation', () => {
 const rows=[]; const original=control.controlPuck;let inspected=0;
 for(const scenario of ['symmetric-faceoff','offset-puck','human-idle'])for(const seed of [42,123,999]) {
  const s=createInitialState('match',{},'cryptcheck');if(scenario!=='human-idle')s.controllers=[];if(scenario==='offset-puck')s.ball.y=7*F;
  const rng=new DeterministicRandom([{owner:'cryptball',name:'ai',seed}]);
  const losses:Record<string,number>={}, failures:Record<string,number>={},turns={large:0,small:0,other:0};let live=0,owned=0,spans:number[]=[],run=0,prior:string|null=null,maxStall=0,stall=0,lastX=s.ball.x,lastY=s.ball.y;
  let previousHeading=new Map(s.players.map(p=>[p.id,p.heading]));
  const spy=vi.spyOn(control,'controlPuck').mockImplementation((state,emit)=>{
   const p=state.players.find(p=>p.id===state.possessionId);const b=state.ball;const eventStart=state.events.length;
   const checks=p?{
    distance:length(p.x-b.x,p.y-b.y)>HOCKEY.controlBreak*F,
    relativeSpeed:length(b.vx-p.vx,b.vy-p.vy)>HOCKEY.receiveSpeed*F,
    puckToBlade:!clearLane(b,control.bladeAnchor(p),state.players,[],groundBallPhysics('cryptcheck')),
    ownerOrStatic:!clearLane(b,control.bladeAnchor(p),[p],[],groundBallPhysics('cryptcheck')),
    staticOnly:!clearLane(b,control.bladeAnchor(p),[],[],groundBallPhysics('cryptcheck')),
    puckToBladeWithoutOwner:!clearLane(b,control.bladeAnchor(p),state.players,[p.id],groundBallPhysics('cryptcheck')),
    bodyToPuck:!clearLane(p,b,state.players,[p.id],groundBallPhysics('cryptcheck')),
   }:{};
   const turn=p?Math.abs(((p.heading-(previousHeading.get(p.id)??p.heading)+384)%256)-128)*360/256:0;
   original(state,emit);inspected++;
   if(state.events.slice(eventStart).some(e=>e.type==='possession-lost'&&e.reason==='unreachable')){
    for(const [name,bad] of Object.entries(checks))if(bad)failures[name]=(failures[name]??0)+1;
    if(checks.puckToBlade&&!checks.puckToBladeWithoutOwner)failures.ownerOnly=(failures.ownerOnly??0)+1;
    if(turn>76)turns.large++;else if(turn<45)turns.small++;else turns.other++;
   }
  });
  for(let t=0;t<3600;t++){
   previousHeading=new Map(s.players.map(p=>[p.id,p.heading]));s.events=[];stepState(s,{},rng);
   for(const e of s.events)if(e.type==='possession-lost')losses[String(e.reason)]=(losses[String(e.reason)]??0)+1;
   if(s.phase!=='play')continue;live++;if(s.possessionId)owned++;
   if(s.possessionId&&s.possessionId===prior)run++;else{if(run)spans.push(run);run=s.possessionId?1:0;}prior=s.possessionId;
   if(s.ball.x===lastX&&s.ball.y===lastY)stall++;else stall=0;maxStall=Math.max(maxStall,stall);lastX=s.ball.x;lastY=s.ball.y;
  }
  spy.mockRestore();rows.push({scenario,seed,live,owned,meanCompletedSpan:spans.reduce((a,b)=>a+b,0)/(spans.length||1),maxStall,losses,failures,turns});
 }
 expect(inspected).toBeGreaterThan(30000);
 const source='apps/cryptball/sim/modes/cryptcheck/control.ts';
 writeFileSync('docs/evidence/cryptball-hockey-feel-2026-11-05/review-diagnostic-before.json',JSON.stringify({sourceHash:createHash('sha256').update(readFileSync(source)).digest('hex'),rows},null,2));
});
