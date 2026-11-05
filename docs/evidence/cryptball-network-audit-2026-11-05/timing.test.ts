import { it, vi, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
const mock = vi.hoisted(() => ({ rooms: [] as any[] }));
vi.mock('@colyseus/sdk', () => ({ Client: class { async joinOrCreate() { return mock.rooms.shift(); } } }));
import { createOnlineSession } from '../../../apps/cryptball/src/online/session';
import { MatchAuthority } from '../../../apps/cryptball-server/src/model';
import { encodeSnapshot } from '../../../apps/cryptball/protocol';
const results: any[] = [];
it('measures four actual client adapters through ordered simulated links', async () => {
 for (const rtt of [20,80,150,200,250,300]) {
  let now=0, serial=0, accepted=0, rejected=0, resumes=0, inputs=0;
  const rejectionReasons:Record<string,number>={};
  const q: {at:number, run:()=>void, serial:number}[]=[];
  const schedule=(run:()=>void)=>q.push({at:now+rtt/2,run,serial:serial++});
  vi.spyOn(performance,'now').mockImplementation(()=>now);
  vi.stubGlobal('sessionStorage',{getItem:()=>null,setItem:()=>{},removeItem:()=>{}});
  const a=new MatchAuthority('audit');
  for(let i=0;i<4;i++){a.join('p'+i,'Guest');a.ready('p'+i);}
  for(let i=0;i<180;i++) a.advance();
  const clients:any[]=[];
  const handlers:any[]=[];
  for(let i=0;i<4;i++) {
   const id='p'+i, h=new Map(); handlers.push(h);
   const snapshot=()=>{const bytes=encodeSnapshot(a.snapshot(id,[]));schedule(()=>h.get('snapshot')?.(bytes));};
   mock.rooms.push({roomId:'audit',sessionId:id,reconnectionToken:'audit:token',reconnection:{},onMessage:(t:any,f:any)=>h.set(t,f),onDrop:()=>{},onReconnect:()=>{},onLeave:()=>{},onError:()=>{},leave:async()=>{},send:(t:string,v:any)=>{
    if(t==='input')inputs++;if(t==='resume')resumes++;
    schedule(()=>{if(t==='input'){if(a.receive(id,v))accepted++;else {rejected++;const cp=a.session.capture();const reason=v.tick<=cp.state.tick?'late':v.tick>cp.state.tick+12?'future':v.revision!==cp.state.controllers.find(c=>c.id===id)?.revision?'revision':'other';rejectionReasons[reason]=(rejectionReasons[reason]??0)+1;}}else if(t==='resume'){a.suspend(id,false);snapshot();}else if(t==='ping'){const tick=a.session.observe().tick;schedule(()=>h.get('pong')?.({sent:v,tick}));}});
   }});
   const c=createOnlineSession({endpoint:'ws://audit'});await c.connect('quick');clients.push(c);
   h.get('lobby')(a.lobby());snapshot();
  }
  let serverTick=1000/60, clientTick=1000/60;
  const corrections:number[]=[];let inactive=0;
  for(now=0;now<15000;now++){
   q.sort((a,b)=>a.at-b.at||a.serial-b.serial);
   while(q.length&&q[0].at<=now)q.shift()!.run();
   if(now>=serverTick){a.advance();serverTick+=1000/60;
    if(a.tick%3===0)for(let i=0;i<4;i++){const bytes=encodeSnapshot(a.snapshot('p'+i,[]));schedule(()=>handlers[i].get('snapshot')(bytes));}
    if(now>2000)inactive += [...a.peers.values()].filter(p=>!p.active).length;
   }
   if(now>=clientTick){clientTick+=1000/60; for(const c of clients){c.step({moveX:Math.floor(now/1000)%2?1:-1,moveY:0});if(now>2000)corrections.push(c.diagnostics.correctionPx);}}
  }
  corrections.sort((a,b)=>a-b);
  results.push({rttMs:rtt,seconds:15,inputs,accepted,rejected,rejectionReasons,resumes,inactiveSeatTicksAfterWarmup:inactive,correctionPxSampledP95:corrections[Math.floor(corrections.length*.95)]});
  vi.restoreAllMocks();vi.unstubAllGlobals();
 }
 writeFileSync('docs/evidence/cryptball-network-audit-2026-11-05/timing.json',JSON.stringify(results,null,2));
 console.log(JSON.stringify(results));expect(results).toHaveLength(6);
},120000);
it('profiles four-seat authority work and complete snapshot payloads',()=>{
 const report:any[]=[];
 for(const sport of ['cryptball','cryptkick','rift-volley','cryptcheck'] as const){
  const a=new MatchAuthority('benchmark',false,sport);
  for(let i=0;i<4;i++){a.join('p'+i,'Guest');a.ready('p'+i);}
  for(let t=0;t<180;t++)a.advance();
  const times:number[]=[],sizes:number[]=[];
  for(let t=0;t<1200;t++){
   const start=performance.now();
   const cp=a.session.capture();
   for(let i=0;i<4;i++)a.receive('p'+i,{epoch:a.epoch,generation:1,seq:t+1,tick:cp.state.tick+1,revision:cp.state.controllers.find(c=>c.id==='p'+i)!.revision,command:{moveX:Math.floor(t/60)%2?1:-1,moveY:0,aim:0,strikePressed:t%60===0}});
   a.advance();
   if(t%3===0){const events=a.session.drainEvents();for(let i=0;i<4;i++){const bytes=encodeSnapshot(a.snapshot('p'+i,events));if(t>=120)sizes.push(bytes.length);}}
   a.lobby();
   if(t>=120)times.push(performance.now()-start);
  }
  times.sort((a,b)=>a-b);sizes.sort((a,b)=>a-b);
  report.push({sport,p95TickWorkMs:times[Math.floor(times.length*.95)],maxTickWorkMs:times.at(-1),medianSnapshotBytes:sizes[Math.floor(sizes.length/2)],maxSnapshotBytes:sizes.at(-1),estimatedRoomPayloadBytesPerSecond:sizes.reduce((a,b)=>a+b,0)/sizes.length*80});
 }
 writeFileSync('docs/evidence/cryptball-network-audit-2026-11-05/cost.json',JSON.stringify(report,null,2));
 expect(report).toHaveLength(4);
},120000);
