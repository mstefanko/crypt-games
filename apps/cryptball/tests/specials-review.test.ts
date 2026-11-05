import { it, expect } from "vitest";
import { createCryptballSession } from "../sim/session";
import { TEAM_IDS } from "../sim/team-identities";
it("round trips an active special through the regulation final whistle", () => {
 for(const sportId of ["cryptball","cryptkick"] as const) for(const team of TEAM_IDS) {
  const session=createCryptballSession({sportId,mode:"match",teamIds:[team,team==="rams"?"foxes":"rams"]});
  const start=session.capture();
  start.state.phase="play";start.state.phaseTicks=0;start.state.remainingTicks=1;start.state.score=[1,0];
  start.state.specials[0].cooldownTicks=0;
  session.restore(start);
  session.step({special:true});
  expect(session.observe().phase).toBe("results");
  const final=session.capture();
  expect(()=>session.restore(final)).not.toThrow();
  expect(session.observe().specials.every(s=>s.active===null)).toBe(true);
 }
});
it("restores after switching, cancellation and disconnect during every club effect", () => {
 for(const sportId of ["cryptball","cryptkick","rift-volley"] as const)for(const team of TEAM_IDS) {
  const session=createCryptballSession({sportId,mode:"practice",teamIds:[team,team==="rams"?"foxes":"rams"]});
  session.setParticipants([{id:"a",team:0,playerId:"player-0"}]);
  const start=session.capture();start.state.specials[0].cooldownTicks=0;
  if(start.state.volley)start.state.volley.serving=false;
  session.restore(start);session.stepParticipants({a:{special:true,moveY:1}});
  for(let i=0;i<105;i++){
   if(i===12)session.setParticipantActive("a",false);
   if(i===15)session.setParticipantActive("a",true);
   session.stepParticipants({a:{moveX:1,moveY:1,switch:i===8,cancel:i===20}});
   const checkpoint=session.capture();
   expect(()=>session.restore(checkpoint),`${sportId} ${team} tick ${i}`).not.toThrow();
   expect(session.capture()).toEqual(checkpoint);
  }
 }
});
