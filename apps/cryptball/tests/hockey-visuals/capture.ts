/** Deterministic validated setups followed only by normal command admission. */
import { createCryptballSession } from "../../sim/session";
import { bladeAnchor } from "../../sim/modes/cryptcheck/control";
import { spriteHeading } from "../../src/animation";
import type { CommandFrame, CryptballEvent, Observation } from "../../sim/contract";

export const DIRECTIONS = ["E","SE","S","SW","W","NW","N","NE"] as const;
export const CONTACT_KINDS = ["wrist","slap","poke"] as const;
export type Direction = typeof DIRECTIONS[number];
export type ContactKind = typeof CONTACT_KINDS[number];
export type Packet = { state: Observation; events: CryptballEvent[] };
export function captureHockeyContact(direction: Direction, kind: ContactKind) {
  const heading = DIRECTIONS.indexOf(direction) * 32;
  if (spriteHeading(heading) !== direction) throw Error(`Source-facing mismatch: ${direction}`);
  const session = createCryptballSession({sportId:"cryptcheck",mode:"practice",seed:73});
  session.setParticipants(session.observe().players.map((p,i)=>({id:`fixture-${i}`,team:p.team,playerId:p.id})));
  const checkpoint = session.capture(),s = checkpoint.state,p = s.players[0];
  s.phase="play";s.phaseTicks=0;s.restartTeam=null;s.restartProtection=0;
  s.possessionId=null;s.possessionReady=0;
  for (const [i,q] of s.players.entries()) {
    q.x = i === 0 ? 0 : (i % 2 ? -120 : 120)*256;
    q.y = i === 0 ? 0 : (i < 2 ? -65 : 65)*256;
    q.vx=q.vy=q.rx=q.ry=0;q.heading=heading;
  }
  const anchor = bladeAnchor(p);
  Object.assign(s.ball,{x:anchor.x,y:anchor.y,vx:0,vy:0,rx:0,ry:0,z:0,vz:0,rz:0,dragCarry:0});
  session.restore(checkpoint); // Real authority validation, including mode state.
  const initial = session.observe(), packets: Packet[] = [];
  let contactIndex = -1;
  for (let age=0;age<80;age++) {
    let command: CommandFrame = {aim:heading,pointerAim:true};
    if (kind === "poke") command = {...command,slide:age===0};
    else if (kind === "slap") command = {...command,strikePressed:age===0,strikeHeld:age<24,strikeReleased:age===24};
    else command = {...command,strikePressed:age===0,strikeReleased:age===0};
    session.stepParticipants({"fixture-0":command,"fixture-1":{},"fixture-2":{},"fixture-3":{}});
    const packet = {state:session.observe(),events:session.drainEvents()};packets.push(packet);
    if (contactIndex<0 && packet.events.some(e=>e.type==="puck-contact" && e.playerId===p.id && e.kind===kind)) contactIndex=packets.length-1;
    if (contactIndex>=0 && packets.length-contactIndex>=20) break;
  }
  if (contactIndex<0) throw Error(`No real ${kind} contact for ${direction}`);
  return {direction,kind,heading,initial,packets,contactIndex,contact:packets[contactIndex].events.find(e=>e.type==="puck-contact")!};
}
