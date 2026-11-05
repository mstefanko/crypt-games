/** Test-only authored start positions; every check/fall follows normal commands. */
import { createCryptballSession } from "../../sim/session";
import { headingVector } from "../../sim/rules";
import { HOCKEY } from "../../sim/modes/cryptcheck/spec";
import type { CommandFrame } from "../../sim/contract";
import { DIRECTIONS, type Direction, type Packet } from "./capture";

export function captureHockeyCheck(direction: Direction, hit = true) {
  const heading = DIRECTIONS.indexOf(direction) * 32, d = headingVector(heading);
  const dx = d.x / 65536, dy = d.y / 65536;
  const session = createCryptballSession({sportId:"cryptcheck",mode:"match",seed:73});
  const players = session.observe().players;
  session.setParticipants(players.map((p,i)=>({id:`check-fixture-${i}`,team:p.team,playerId:p.id})));
  const checkpoint = session.capture(), s = checkpoint.state, p = s.players[0];
  const victimIndex = s.players.findIndex(q=>q.team!==p.team), victim = s.players[victimIndex];
  s.phase="play";s.phaseTicks=0;s.restartTeam=null;s.restartProtection=0;
  s.possessionId=null;s.possessionReady=0;
  for (const [i,q] of s.players.entries()) {
    q.x = i === 0 ? 0 : i === victimIndex ? Math.round((dx * 28 - (hit ? 0 : dy * 50))*256) : (i % 2 ? -120 : 120)*256;
    q.y = i === 0 ? 0 : i === victimIndex ? Math.round((dy * 28 + (hit ? 0 : dx * 50))*256) : (i < 2 ? -65 : 65)*256;
    q.vx=q.vy=q.rx=q.ry=0;q.heading=heading;
    s.hockey!.skaters[q.id].carryHeading=heading;
    s.hockey!.skaters[q.id].downHeading=heading;
  }
  Object.assign(s.ball,{x:-85*256,y:55*256,vx:0,vy:0,rx:0,ry:0,z:0,vz:0,rz:0,dragCarry:0});
  session.restore(checkpoint);
  const initial=session.observe(),packets:Packet[]=[];
  const duration=HOCKEY.checkTell+HOCKEY.checkActive+HOCKEY.checkRecovery+HOCKEY.downFall+HOCKEY.downHold+HOCKEY.downGetup;
  for(let age=0;age<=duration;age++) {
    const command:CommandFrame={aim:heading,pointerAim:true,check:age===0,moveX:age<HOCKEY.checkTell+HOCKEY.checkActive?dx:0,moveY:age<HOCKEY.checkTell+HOCKEY.checkActive?dy:0};
    session.stepParticipants(Object.fromEntries(players.map((q,i)=>[`check-fixture-${i}`,q.id===p.id?command:{}])));
    packets.push({state:session.observe(),events:session.drainEvents()});
  }
  const contactIndex=packets.findIndex(packet=>packet.events.some(e=>e.type==="check"&&e.playerId===p.id&&e.targetId===victim.id));
  if(hit&&contactIndex<0) throw Error(`No real check contact for ${direction}`);
  if(!hit&&contactIndex>=0) throw Error(`Miss fixture unexpectedly hit for ${direction}`);
  if(!packets.some(packet=>packet.state.hockey!.skaters[p.id].check)) throw Error("Check was not admitted");
  return {direction,heading,hit,initial,packets,contactIndex,playerId:p.id,victimId:victim.id};
}
