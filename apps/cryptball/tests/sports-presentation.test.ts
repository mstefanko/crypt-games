import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { athleteAnimation } from "../src/animation";
import { CryptballAudio } from "../src/audio";
import { createCryptballSession } from "../sim/session";

describe("sport presentation contracts", () => {
  it("keeps armed Cryptball clips separate from weapon-free kick and set actions", () => {
    const state = createCryptballSession().observe();
    const p = state.players[0];
    p.action = {kind:"strike",id:1,elapsed:4,charge:0,timing:{tell:4,active:3,recover:9},hits:[],heading:0};
    expect(athleteAnimation(p,state).clip).toBe("strike");
    state.sportId="cryptkick";
    expect(athleteAnimation(p,state).clip).toBe("kick");
    p.action.kind="pass";
    expect(athleteAnimation(p,state).clip).toBe("pass");
    state.sportId="rift-volley";
    expect(athleteAnimation(p,state).clip).toBe("set");
    expect(p.action.elapsed).toBe(4);
  });
  it("uses actual contact kind and tick, freezes with tick, and expires contact poses", () => {
    const state=createCryptballSession({sportId:"rift-volley"}).observe();
    const p=state.players[0]; state.tick=100;
    const event={type:"volley-contact",tick:100,playerId:p.id,kind:"attack"};
    const contact=athleteAnimation(p,state,event);
    expect(contact.clip).toBe("spike");
    expect(contact.phase).toBeGreaterThan(1/3);
    expect(athleteAnimation(p,state,event)).toEqual(contact);
    expect(athleteAnimation(p,state,{...event,kind:"set"}).clip).toBe("set");
    expect(athleteAnimation(p,state,{...event,kind:"dig"}).clip).toBe("dig");
    expect(athleteAnimation(p,state,{...event,height:10*256}).clip).toBe("receive");
    state.tick=119;
    expect(athleteAnimation(p,state,event).clip).toBe("idle");
    state.sportId="cryptkick";
    expect(athleteAnimation(p,state,{type:"trap",tick:119}).clip).toBe("trap");
  });
  it("covers all authored facings and sport actions with generated frames and fixed pivots", () => {
    const manifest=JSON.parse(readFileSync(new URL("../public/assets/cryptball-sports/manifest.json",import.meta.url),"utf8"));
    for(const team of ["ivory","ember","owls","gators","bats","hornets"])
      for(const heading of ["E","SE","S","SW","W","NW","N","NE"])
        for(const action of ["idle","run","slide","slide-recover","trap","pass","kick","receive","set","spike","jump","land","dig","dive","dive-recover"]){
          const frames=manifest.clips[`sports.${team}.${action}.${heading}`];
          expect(frames?.length).toBeGreaterThan(0);
          for(const id of frames){
            expect(manifest.frames[id].pivot).toEqual({x:56,y:70});
            expect(id).toMatch(/^sports\.(ivory|ember|owls|gators|bats|hornets)\./);
          }
        }
    expect(manifest.provenance.authoredFacings).toBe(8);
    expect(manifest.provenance.authoredPosesPerFacing).toBe(20);
  });
  it("samples forearm contact for the visual fixture's real launch-tick dig", () => {
    const session=createCryptballSession({sportId:"rift-volley",seed:7});
    const checkpoint=session.capture(),s=checkpoint.state,p=s.players[0];
    s.phase="play";s.phaseTicks=0;s.volley!.serving=false;
    s.volley!.lastContactId=null;s.volley!.lastContactTeam=null;s.volley!.teamContacts=0;
    p.x=-60*256;p.y=0;p.action=null;p.slideTicks=0;
    Object.assign(s.ball,{x:p.x,y:p.y,z:10*256,vx:0,vy:0,vz:-10*256,rx:0,ry:0,rz:0});
    session.restore(checkpoint);session.step({slide:true});
    const state=session.observe(),event=session.drainEvents().find(e=>e.type==="volley-contact"&&e.kind==="dig");
    expect(event).toBeDefined();expect(state.players[0].slideTicks).toBeGreaterThan(0);
    const animation=athleteAnimation(state.players[0],state,event);
    expect(animation.clip).toBe("dig");expect(animation.phase).toBe(0);
    const manifest=JSON.parse(readFileSync(new URL("../public/assets/cryptball-sports/manifest.json",import.meta.url),"utf8"));
    expect(manifest.clips["sports.ivory.dig.E"][0]).toBe("sports.ivory.dive-contact.E");
  });
  it("shows confirmed dig contact on launch and never rewinds into dive launch", () => {
    const state=createCryptballSession({sportId:"rift-volley"}).observe();
    const p=state.players[0];state.tick=100;p.slideTicks=12;
    const event={type:"volley-contact",kind:"dig",tick:100,playerId:p.id};
    const contact=athleteAnimation(p,state,event);
    expect(contact.clip).toBe("dig");expect(contact.phase).toBe(0);
    expect(athleteAnimation(p,state,event)).toEqual(contact);
    state.tick=106;p.slideTicks=6;
    expect(athleteAnimation(p,state,event).clip).toBe("dig");
    state.tick=107;p.slideTicks=5;
    const settled=athleteAnimation(p,state,event);
    expect(settled.clip).toBe("dive");expect(settled.phase).toBeGreaterThanOrEqual(2/3);
    p.slideTicks=0;p.slideRecovery=8;
    expect(athleteAnimation(p,state,event).clip).toBe("dive-recover");
    state.tick=118;p.slideRecovery=0;
    expect(athleteAnimation(p,state,event).clip).toBe("idle");
  });
  it("uses independently authored hands-first dives only in volleyball", () => {
    const state=createCryptballSession({sportId:"rift-volley"}).observe();
    const p=state.players[0];p.slideTicks=8;
    expect(athleteAnimation(p,state).clip).toBe("dive");
    state.sportId="cryptkick";
    expect(athleteAnimation(p,state).clip).toBe("slide");
    p.slideTicks=0;p.slideRecovery=5;state.sportId="rift-volley";
    expect(athleteAnimation(p,state).clip).toBe("dive-recover");
    const manifest=JSON.parse(readFileSync(new URL("../public/assets/cryptball-sports/manifest.json",import.meta.url),"utf8"));
    for(const heading of ["E","SE","S","SW","W","NW","N","NE"]){
      const slide=manifest.clips[`sports.ivory.slide.${heading}`];
      const dive=manifest.clips[`sports.ivory.dive.${heading}`];
      expect(dive).toHaveLength(3);
      expect(dive.every((id:string)=>!slide.includes(id)&&id.includes("dive-"))).toBe(true);
    }
  });
  it("distinguishes trap, set, spike and dig contact sounds", () => {
    const audio=new CryptballAudio(()=>{});
    const effect=vi.spyOn(audio.engine,"effect").mockImplementation(()=>{});
    const state=createCryptballSession().observe();
    audio.tick(state,[{type:"trap",tick:0},{type:"volley-contact",kind:"set",tick:0},{type:"volley-contact",kind:"attack",tick:0},{type:"volley-contact",kind:"dig",tick:0}]);
    expect(effect.mock.calls.map(call=>call[1].id)).toEqual(["body-thud","owl-glass","ball-strike","keeper-save"]);
    audio.engine.dispose();
  });
});
