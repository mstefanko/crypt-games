/** Test-only deterministic captured-playback harness. No authority state edits. */
import { PixiStage } from "@onepage/game-runtime/pixi";
import { CryptballPresenter } from "../../src/presenter";
import { createCryptballSession } from "../../sim/session";
import { resizeCryptball } from "../../src/viewport";
import type { Observation, CryptballEvent, SportId } from "../../sim/contract";

type Packet = { state: Observation; events: CryptballEvent[] };
const captures = new Map<string, Packet[]>();
const origins = new Map<string,string>();
for (const sport of ["cryptball", "cryptkick", "rift-volley"] as const) {
  for (const seed of [7, 19, 73]) {
    const session=createCryptballSession({sportId:sport,seed});
    session.setParticipants([]);
    const active: { key:string; packets:Packet[] }[]=[];
    for (let tick=0;tick<30000;tick++) {
      session.step();
      const state=session.observe(), events=session.drainEvents();
      for (const capture of active) if(capture.packets.length<11) capture.packets.push({state,events});
      const keys:string[]=[];
      if(state.phase==="play" && Math.hypot(state.ball.vx,state.ball.vy)>10*256) keys.push(sport);
      for(const event of events) if(event.type==="volley-contact") keys.push(`${sport}:${event.kind}`);
      for(const key of keys) if(!captures.has(key)) {
        const packets=[{state,events}];captures.set(key,packets);origins.set(key,`seeded bot play (seed ${seed})`);active.push({key,packets});
      }
      const complete=sport!=="rift-volley" ? captures.has(sport)
        : [sport,`${sport}:set`,`${sport}:attack`].every(key=>captures.has(key));
      if(complete && active.every(c=>c.packets.length===11)) break;
      if(state.phase==="results") break;
    }
    if(sport!=="rift-volley" || ["set","attack"].every(kind=>captures.has(`${sport}:${kind}`))) break;
  }
}
// Bots seldom choose a low dig. Author a validated checkpoint to exercise that
// real rule path, then use normal inputs/stepping and only captured outcomes.
if(!captures.has("rift-volley:dig")) {
  const session=createCryptballSession({sportId:"rift-volley",seed:7});
  const checkpoint=session.capture(), s=checkpoint.state, p=s.players[0];
  s.phase="play";s.phaseTicks=0;s.volley!.serving=false;
  s.volley!.lastContactId=null;s.volley!.lastContactTeam=null;s.volley!.teamContacts=0;
  p.x=-60*256;p.y=0;p.action=null;p.slideTicks=0;
  Object.assign(s.ball,{x:p.x,y:p.y,z:10*256,vx:0,vy:0,vz:-10*256,rx:0,ry:0,rz:0});
  session.restore(checkpoint);
  const packets:Packet[]=[];
  for(let age=0;age<30;age++) {
    session.step(age===0?{slide:true}:{});
    packets.push({state:session.observe(),events:session.drainEvents()});
  }
  if(!packets[0].events.some(e=>e.type==="volley-contact"&&e.kind==="dig")) throw Error("Authored dig fixture failed to produce real contact");
  captures.set("rift-volley:dig",packets);origins.set("rift-volley:dig","validated authored low-ball checkpoint + real slide input");
}
// Capture the same normal defensive input for a feet-first comparison.
for (const sport of ["cryptball", "cryptkick"] as const) {
  const session=createCryptballSession({sportId:sport,seed:7,teamIds:["owls","hornets"]});
  const checkpoint=session.capture();
  checkpoint.state.phase="play"; checkpoint.state.phaseTicks=0;
  session.restore(checkpoint);
  const packets:Packet[]=[];
  for(let age=0;age<30;age++) {
    session.step(age===0?{slide:true}:{});
    packets.push({state:session.observe(),events:session.drainEvents()});
  }
  captures.set(`${sport}:defense`,packets);
  origins.set(`${sport}:defense`,"validated play checkpoint + real slide input");
}
const canvas=document.querySelector("canvas")!;
const stage=new PixiStage(canvas);
await stage.init();
resizeCryptball(stage,document.querySelector("#stage")!);
let presenter:CryptballPresenter|undefined;
async function show({sport="rift-volley",kind,age=0,reduced=false}:{sport?:SportId;kind?:string;age?:number;reduced?:boolean}={}) {
  const key=kind?`${sport}:${kind}`:sport;
  const packets=captures.get(key);
  if(!packets) throw Error(`No real captured contact: ${key}`);
  presenter?.dispose();
  presenter=new CryptballPresenter(stage);
  await presenter.init();
  const end=Math.min(Math.max(0,Math.trunc(age)),packets.length-1);
  for(let i=0;i<=end;i++) presenter.render(packets[i].state,packets[i].events,reduced);
  stage.render(0);
  const packet=packets[end];
  document.querySelector("#status")!.textContent=`${key} · age ${end} · authority tick ${packet.state.tick} · reduced ${reduced} · ${canvas.dataset.ballFrame} · ${origins.get(key)}`;
  return {key,origin:origins.get(key),age:end,tick:packet.state.tick,frame:canvas.dataset.ballFrame,radius:canvas.dataset.ballRadius,events:packets[0].events,ball:packet.state.ball};
}
const fixture={keys:[...captures.keys()],show};
Object.assign(window,{ballVisualFixture:fixture});
await show();
document.body.dataset.ready="true";
