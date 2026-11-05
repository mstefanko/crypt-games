import { expect, it } from "vitest";
import { ownControlSwitched, eligibleTouchTeammates } from "../src/control-events";
import type { CryptballEvent } from "../src/contract";

it("only disarms online controls for the local participant's confirmed switch", () => {
  const event = (participantId: string): CryptballEvent => ({ id: "test", type: "switch", tick: 100, participantId });
  expect(ownControlSwitched([event("opponent"), event("teammate")], "me")).toBe(false);
  expect(ownControlSwitched([event("opponent"), event("me")], "me")).toBe(true);
  expect(ownControlSwitched([event("local")])).toBe(true);
  expect(ownControlSwitched([], "me")).toBe(false);
});

it("advertises online bot switching only for the lone local human on that team", async () => {
  const { touchSwitchAvailable } = await import("../src/control-events");
  const me = { id: "me", team: 0 as const }, opponent = { id: "opponent", team: 1 as const };
  expect(touchSwitchAvailable([me, opponent], "me", 0)).toBe(true);
  // A reserved disconnected peer remains a seat and still disables switching.
  expect(touchSwitchAvailable([me, opponent, { id: "reserved-peer", team: 0 }], "me", 0)).toBe(false);
  expect(touchSwitchAvailable([opponent], "me", 0)).toBe(false);
  expect(touchSwitchAvailable([me], "other", 0)).toBe(false);
});


it("cooperative touch switching excludes reserved humans and downed/out athletes across cosmetic teams", async()=>{
  const {createCryptballSession}=await import("../sim/session");
  const s=createCryptballSession({sportId:"crypt-guardian"}).observe();
  const [me,bot]=s.players;s.controlledId=me.id;
  const seats=[{id:"me",team:me.team,playerId:me.id}];
  expect(eligibleTouchTeammates(s,[...seats,{id:"peer",team:bot.team,playerId:bot.id}],"me")).toEqual([]);
  expect(eligibleTouchTeammates(s,seats,"me").map(p=>p.id)).toEqual([bot.id]);
  s.guardian!.athletes[bot.id].status="out";expect(eligibleTouchTeammates(s,seats,"me")).toEqual([]);
  const dodge=createCryptballSession({sportId:"crypt-dodge"}).observe();
  dodge.dodge!.athletes[dodge.players[1].id].lives=0;
  expect(eligibleTouchTeammates(dodge).every(p=>p.team===dodge.players[0].team&&dodge.dodge!.athletes[p.id].lives>0)).toBe(true);
});
