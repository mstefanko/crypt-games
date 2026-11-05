import {it,expect} from "vitest";
import {createCryptballSession,SPORT_IDS,TEAM_IDS} from "../sim/session";
it("retired special inputs produce identical futures for every cosmetic team and activity",()=>{
 for(const sportId of SPORT_IDS)for(const team of TEAM_IDS){
  const options={sportId,teamIds:[team,team==="rams"?"foxes":"rams"] as [typeof team,typeof team]};
  const a=createCryptballSession(options),b=createCryptballSession(options);
  for(let i=0;i<150;i++) {a.step({moveY:1,special:true});b.step({moveY:1});}
  expect(a.capture()).toEqual(b.capture());
 }
});
