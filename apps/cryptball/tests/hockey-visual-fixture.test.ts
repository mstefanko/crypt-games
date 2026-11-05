import { describe, expect, it } from "vitest";
import { captureHockeyContact, DIRECTIONS, CONTACT_KINDS } from "./hockey-visuals/capture";
import { athleteAnimation } from "../src/animation";
import { captureHockeyCheck } from "./hockey-visuals/check-capture";
import { HOCKEY } from "../sim/modes/cryptcheck/spec";
describe("real hockey contact visual setups",()=>{
  for(const direction of DIRECTIONS)for(const kind of CONTACT_KINDS)it(`${direction} ${kind} produces the actual authority contact and matching semantic pose`,()=>{
    const capture=captureHockeyContact(direction,kind),packet=capture.packets[capture.contactIndex];
    expect(capture.contact.type).toBe("puck-contact");expect(capture.contact.kind).toBe(kind);
    expect(capture.contact.tick).toBe(packet.state.tick);
    expect(capture.initial.ball.vx).toBe(0);expect(capture.initial.ball.vy).toBe(0);
    expect(capture.contact.incomingVx).toBe(0);expect(capture.contact.incomingVy).toBe(0);
    expect(capture.contact.actionId).toBeGreaterThan(0);
    const animation=athleteAnimation(packet.state.players[0],packet.state,capture.contact);
    expect(animation.clip).toBe(kind);expect(animation.phase).toBe(kind==="slap"?.5:1/3);
    expect(packet.state.ball.z).toBe(0);expect(packet.state.ball.vz).toBe(0);
  });
});

describe("real hockey check visual setups",()=>{
  for(const direction of DIRECTIONS) for(const hit of [true,false]) it(`${direction} check ${hit?"hit":"miss"} shows authority tells and recovery`,()=>{
    const capture=captureHockeyCheck(direction,hit);
    const first=capture.packets[0],p=first.state.players.find(p=>p.id===capture.playerId)!;
    expect(athleteAnimation(p,first.state).clip).toBe("shoulder");
    const attackerRecovery=capture.packets.find(packet=>{
      const check=packet.state.hockey!.skaters[p.id].check;
      return check&&check.elapsed>=HOCKEY.checkTell+HOCKEY.checkActive;
    })!;
    expect(attackerRecovery).toBeDefined();
    expect(athleteAnimation(attackerRecovery.state.players.find(q=>q.id===p.id)!,attackerRecovery.state).phase).toBeGreaterThanOrEqual(.5);
    if(hit) {
      const phases=capture.packets.map(packet=>athleteAnimation(packet.state.players.find(p=>p.id===capture.victimId)!,packet.state).clip);
      expect(phases).toContain("knockdown-fall");expect(phases).toContain("knockdown");expect(phases).toContain("get-up");
      const last=capture.packets.at(-1)!;
      expect(last.state.hockey!.skaters[capture.victimId].downTicks).toBe(0);
    } else expect(capture.contactIndex).toBe(-1);
  });
});
