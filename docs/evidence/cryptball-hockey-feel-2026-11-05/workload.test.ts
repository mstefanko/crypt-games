import { it, expect } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInitialState, stepState } from '../../../apps/cryptball/sim/session';
import { DeterministicRandom } from '@onepage/game-simulation/random';
import { FIXED as F } from '../../../apps/cryptball/sim/rules';
it('records reproducible possession and loose-puck progress metrics', () => {
 const label=process.env.HOCKEY_WORKLOAD_LABEL??'latest';expect(label).toMatch(/^[a-z0-9-]+$/);
 const rows=[];
 for(const scenario of ['symmetric-faceoff','offset-puck','human-idle'])for(const seed of [42,123,999]){
  const s=createInitialState('match',{},'cryptcheck');if(scenario!=='human-idle')s.controllers=[];if(scenario==='offset-puck')s.ball.y=7*F;
  const rng=new DeterministicRandom([{owner:'cryptball',name:'ai',seed}]);
  let live=0,owned=0,run=0,maxOwned=0,prior:string|null=null,stall=0,maxLooseStall=0,lastX=s.ball.x,lastY=s.ball.y,cluster=0;
  const spans:number[]=[],events:Record<string,number>={},losses:Record<string,number>={};const samples=[];
  for(let i=0;i<3600;i++){
   s.events=[];stepState(s,{},rng);
   for(const e of s.events){events[e.type]=(events[e.type]??0)+1;if(e.type==='possession-lost')losses[String(e.reason)]=(losses[String(e.reason)]??0)+1;}
   if(s.phase!=='play'){stall=0;lastX=s.ball.x;lastY=s.ball.y;continue;}live++;if(s.possessionId)owned++;
   if(s.possessionId&&s.possessionId===prior)run++;else{if(run)spans.push(run);run=s.possessionId?1:0;}prior=s.possessionId;maxOwned=Math.max(maxOwned,run);
   if(!s.possessionId&&s.ball.x===lastX&&s.ball.y===lastY)stall++;else stall=0;maxLooseStall=Math.max(maxLooseStall,stall);lastX=s.ball.x;lastY=s.ball.y;
   if(s.players.filter(p=>Math.hypot(p.x-s.ball.x,p.y-s.ball.y)<30*F).length>=3)cluster++;
   if(i%600===599)samples.push({tick:s.tick,puck:[s.ball.x/F,s.ball.y/F],owner:s.possessionId,players:s.players.map(p=>({id:p.id,x:p.x/F,y:p.y/F,role:p.aiRole}))});
  }
  rows.push({scenario,seed,live,owned,ownedFraction:owned/live,meanCompletedSpan:spans.reduce((a,b)=>a+b,0)/(spans.length||1),maxOwned,maxLooseStall,cluster,score:s.score,events,losses,samples});
 }
 const sourceHashes=Object.fromEntries(['control','actions','ai','index','spec','motion'].map(name=>{const path=`apps/cryptball/sim/modes/cryptcheck/${name}.ts`;return[path,createHash('sha256').update(readFileSync(path)).digest('hex')];}));
 writeFileSync(`docs/evidence/cryptball-hockey-feel-2026-11-05/workload-${label}.json`,JSON.stringify({label,sourceHashes,rows},null,2));
});
