import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createInitialState, stepState } from '../../../apps/cryptball/sim/session';
import { DeterministicRandom } from '@onepage/game-simulation/random';
import { FIXED as F } from '../../../apps/cryptball/sim/rules';
it('records hockey feel baselines without asserting balance', () => {
 const results=[];
 for(const scenario of ['symmetric-faceoff','offset-puck','human-idle']) {
  const s=createInitialState('match',{},'cryptcheck');
  if(scenario!=='human-idle')s.controllers=[];
  if(scenario==='offset-puck')s.ball.y=7*F;
  const rng=new DeterministicRandom([{owner:'cryptball',name:'ai',seed:42}]);
  let live=0,owned=0,cluster=0,run=0,maxRun=0,prevOwner=null;
  const events:Record<string,number>={},reasons:Record<string,number>={},spans:number[]=[];
  const samples=[];
  for(let i=0;i<3600;i++) {
   s.events=[]; stepState(s,{},rng);
   for(const e of s.events){events[e.type]=(events[e.type]??0)+1;if(e.type==='possession-lost')reasons[String(e.reason)]=(reasons[String(e.reason)]??0)+1;}
   if(s.phase!=='play')continue;
   live++; if(s.possessionId)owned++;
   if(s.players.filter(p=>Math.hypot(p.x-s.ball.x,p.y-s.ball.y)<30*F).length>=3)cluster++;
   if(s.possessionId && s.possessionId===prevOwner)run++;else {if(run)spans.push(run);run=s.possessionId?1:0;}prevOwner=s.possessionId;maxRun=Math.max(maxRun,run);
   if(i%600===599)samples.push({tick:s.tick,puck:[s.ball.x/F,s.ball.y/F],owner:s.possessionId,players:s.players.map(p=>({id:p.id,x:p.x/F,y:p.y/F,role:p.aiRole,action:p.action?.kind,slide:p.slideTicks}))});
  }
  results.push({scenario,live,owned,cluster,maxRun,meanPossession:spans.reduce((a,b)=>a+b,0)/(spans.length||1),score:s.score,events,reasons,samples});
 }
 writeFileSync('docs/evidence/cryptball-hockey-feel-2026-11-05/baseline.json',JSON.stringify(results,null,2));
 console.log(JSON.stringify(results.map(({samples,...r})=>r),null,2));
});
