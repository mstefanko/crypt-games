import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { athleteAnimation, athleteHeading } from "../src/animation";
import { ballVisual, isBallContact } from "../src/ball-presentation";
import { athleteClipId, SPORT_ART_PROFILES } from "../src/sport-presentation";
import { CryptballAudio } from "../src/audio";
import { specialPose } from "../src/special-presentation";
import { createCryptballSession } from "../sim/session";
import { HOCKEY } from "../sim/modes/cryptcheck/spec";

const manifest = JSON.parse(readFileSync(new URL("../public/assets/cryptball-hockey/manifest.json", import.meta.url), "utf8"));
const sports = JSON.parse(readFileSync(new URL("../public/assets/cryptball-sports/manifest.json", import.meta.url), "utf8"));
const frameAt = (clip: string, phase: number) => {
  const frames = manifest.clips[`hockey.ivory.${clip}.E`];
  return frames[Math.floor(Math.max(0, Math.min(.999999,phase))*frames.length)];
};

describe("Cryptcheck presentation", () => {
  it("uses an explicit hockey profile and covers eight facings and six material palettes", () => {
    expect(SPORT_ART_PROFILES.cryptcheck.athletes).toBe("hockey");
    expect(athleteClipId("cryptcheck","ivory","warrior","wrist","E")).toBe("hockey.ivory.wrist.E");
    for (const team of ["ivory","ember","owls","gators","bats","hornets"])
      for (const heading of ["E","SE","S","SW","W","NW","N","NE"])
        for (const action of ["idle","glide","skate","burst","stickhandle","wrist","pass","slap","slap-hold","poke","shoulder","stop","recover","receive","recoil"])
          for (const id of manifest.clips[`hockey.${team}.${action}.${heading}`]) {
            const frame = manifest.frames[id];
            expect(frame.pivot).toEqual({x:56,y:70});
            expect(frame.originalSize.width).toBe(112);
            expect([80,96]).toContain(frame.originalSize.height);
            expect(frame.trim.x).toBeGreaterThan(0);
            expect(frame.trim.x+frame.width).toBeLessThan(112);
            expect(frame.trim.y).toBeGreaterThan(0);
            expect(frame.trim.y+frame.height).toBeLessThan(frame.originalSize.height);
            expect(id.startsWith("hockey.")).toBe(true);
          }
    expect(manifest.provenance.authoredFacings).toBe(8);
    expect(manifest.provenance.authoredPosesPerFacing).toBe(16);
  });
  it("selects actual wrist/slap contact on the authority active tick, with held windups", () => {
    const s=createCryptballSession({sportId:"cryptcheck"}).observe(),p=s.players[0];
    p.action={id:1,kind:"strike",elapsed:2,charge:0,heading:0,hits:[],timing:{tell:3,active:2,recover:8}};
    let a=athleteAnimation(p,s);
    expect(frameAt(a.clip,a.phase)).toContain("wrist-windup");
    p.action.elapsed=3;a=athleteAnimation(p,s);
    expect(frameAt(a.clip,a.phase)).toContain("wrist-contact");
    p.action.elapsed=5;a=athleteAnimation(p,s);
    expect(frameAt(a.clip,a.phase)).toContain("wrist-follow");
    Object.assign(p.action,{charge:24,elapsed:6,timing:{tell:6,active:3,recover:16}});
    a=athleteAnimation(p,s);expect(frameAt(a.clip,a.phase)).toContain("slap-contact");
    p.action=null;p.charging=true;p.chargeTicks=24;
    a=athleteAnimation(p,s);expect(frameAt(a.clip,a.phase)).toContain("slap-windup");
  });
  it("separates glide, skate push, poke, stop, receive and recovery from running and kicking", () => {
    const s=createCryptballSession({sportId:"cryptcheck"}).observe(),p=s.players[0];
    s.tick=100;p.vx=120*256;
    expect(athleteAnimation(p,s).clip).toBe("glide");
    expect(athleteAnimation(p,s,{type:"skate-push",tick:100}).clip).toBe("skate");
    expect(athleteAnimation(p,s,{type:"ice-stop",tick:100}).clip).toBe("stop");
    expect(athleteAnimation(p,s,{type:"check",tick:100}).clip).toBe("shoulder");
    expect(athleteAnimation(p,s,{type:"trap",tick:100}).clip).toBe("receive");
    p.slideTicks=6;expect(frameAt(athleteAnimation(p,s).clip,athleteAnimation(p,s).phase)).toContain("ready");
    p.slideTicks=3;expect(frameAt(athleteAnimation(p,s).clip,athleteAnimation(p,s).phase)).toContain("poke-check");
    p.slideTicks=0;p.slideRecovery=12;expect(athleteAnimation(p,s).clip).toBe("recover");
    expect(athleteAnimation(p,s)).toEqual(athleteAnimation(p,s));
  });
  it("pins confirmed one-timer and slap contacts to the contact pose during correction", () => {
    const s=createCryptballSession({sportId:"cryptcheck"}).observe(),p=s.players[0];s.tick=100;
    let a=athleteAnimation(p,s,{type:"puck-contact",kind:"one-timer",tick:100});
    expect(frameAt(a.clip,a.phase)).toContain("wrist-contact");
    a=athleteAnimation(p,s,{type:"puck-contact",kind:"slap",tick:100});
    expect(frameAt(a.clip,a.phase)).toContain("slap-contact");
    s.tick=104;expect(athleteAnimation(p,s,{type:"puck-contact",kind:"slap",tick:100}).clip).toBe("idle");
  });
  it("selects receive then existing stickhandle from possession without moving the puck", () => {
    const s = createCryptballSession({sportId:"cryptcheck"}).observe(), p = s.players[0], skater = s.hockey!.skaters[p.id];
    s.tick = 100; s.possessionId = p.id; skater.receiveUntil = 102; skater.carryHeading = 64; p.heading = 128;
    const ball = structuredClone(s.ball);
    expect(athleteAnimation(p,s).clip).toBe("receive");
    s.tick = 108;
    const a = athleteAnimation(p,s);
    expect(a.clip).toBe("stickhandle");
    expect(frameAt(a.clip,a.phase)).toContain("receive");
    expect(athleteHeading(p,s)).toBe(64);
    expect(s.ball).toEqual(ball);
    p.action={id:1,kind:"strike",heading:128,elapsed:2,hits:[],timing:{tell:3,active:2,recover:8}};
    expect(athleteHeading(p,s)).toBe(64);
    p.action.elapsed=3;
    expect(athleteHeading(p,s)).toBe(128);
    p.action=null;
    s.possessionId = null;
    expect(athleteHeading(p,s)).toBe(128);
  });
  it("shows committed shoulder tell, misses and recovery without a contact receipt", () => {
    const s = createCryptballSession({sportId:"cryptcheck"}).observe(), p = s.players[0], skater = s.hockey!.skaters[p.id];
    skater.check = {id:8,heading:96,elapsed:0,hits:[]};
    p.heading = 0;
    for (const elapsed of [0, HOCKEY.checkTell, HOCKEY.checkTell + HOCKEY.checkActive - 1]) {
      skater.check.elapsed = elapsed;
      const a = athleteAnimation(p,s);
      expect(frameAt(a.clip,a.phase)).toContain("shoulder-check");
      expect(a.instance).toBe("hockey:check:8");
      expect(athleteHeading(p,s)).toBe(96);
    }
    skater.check.elapsed = HOCKEY.checkTell + HOCKEY.checkActive;
    const a = athleteAnimation(p,s);
    expect(frameAt(a.clip,a.phase)).toContain("recover");
  });
  it("uses matched loaded sports fall/get-up poses in every facing and palette", () => {
    const s = createCryptballSession({sportId:"cryptcheck"}).observe(), p = s.players[0], skater = s.hockey!.skaters[p.id];
    skater.downHeading = 32;
    const stages = [
      [HOCKEY.downFall + HOCKEY.downHold + HOCKEY.downGetup, "knockdown-fall", "slide-launch"],
      [HOCKEY.downHold + HOCKEY.downGetup, "knockdown", "slide"],
      [HOCKEY.downGetup, "get-up", "slide-recover"],
      [1, "get-up", "slide-recover"],
    ] as const;
    for (const [remaining, clip, source] of stages) {
      skater.downTicks = remaining;
      const a = athleteAnimation(p,s);
      expect(a.clip).toBe(clip);
      expect(athleteHeading(p,s)).toBe(32);
      for (const team of ["ivory","ember","owls","gators","bats","hornets"])
        for (const heading of ["E","SE","S","SW","W","NW","N","NE"]) {
          const id = athleteClipId("cryptcheck",team,p.archetype,a.clip,heading);
          expect(id).toBe(`sports.${team}.${source}.${heading}`);
          for (const frame of sports.clips[id]) expect(sports.frames[frame].pivot).toEqual({x:56,y:70});
        }
    }
    skater.downTicks = 0;
    expect(athleteAnimation(p,s).clip).toBe("idle");
  });
  it("keeps check and victim phases visible through every team special", () => {
    for (const id of ["rams","foxes","owls","gators","bats","hornets"] as const) {
      const s=createCryptballSession({sportId:"cryptcheck",teamIds:[id,id==="rams"?"foxes":"rams"]}).observe(),p=s.players[0],skater=s.hockey!.skaters[p.id];
      s.specials[0].active={playerId:p.id,elapsedTicks:8,remainingTicks:10,heading:0,burstStart:6,secondBurstAvailable:id==="bats",contactUsed:false,receptionUsed:false,stoppedTicks:-1};
      skater.check={id:1,heading:64,elapsed:2,hits:[]};
      let a=athleteAnimation(p,s); expect(specialPose(p,s,a)).toEqual(a);
      skater.check=null;skater.downTicks=12;
      a=athleteAnimation(p,s); expect(specialPose(p,s,a)).toEqual(a);
    }
  });
  it("never deforms or lifts the puck, and freezes scuff motion under reduced motion", () => {
    for (const type of ["strike","pass","trap","board","post","puck-contact"])
      for (let age=0;age<12;age++) {
        const v=ballVisual("cryptcheck",age*7,100+age,{type,tick:100});
        expect(v.frame).toMatch(/^hockey\.puck\.[0-3]$/);expect(v.groundLift).toBe(0);expect(v.radius).toBe(4);
        const f=manifest.frames[v.frame];expect(f.originalSize).toEqual({width:12,height:8});expect(f.pivot).toEqual({x:6,y:5});
      }
    expect(ballVisual("cryptcheck",1000,100,{type:"puck-contact",tick:100},true).frame).toBe("hockey.puck.0");
    expect(isBallContact({type:"puck-contact",tick:100})).toBe(true);
  });
  it("keeps active team specials stick-bearing in hockey", () => {
    for (const id of ["rams","foxes","owls","gators","bats","hornets"] as const) {
      const s=createCryptballSession({sportId:"cryptcheck",teamIds:[id,id==="rams"?"foxes":"rams"]}).observe(),p=s.players[0];
      s.specials[0].active={playerId:p.id,elapsedTicks:8,remainingTicks:10,heading:0,burstStart:6,secondBurstAvailable:id==="bats",contactUsed:false,receptionUsed:false,stoppedTicks:-1};
      const a=specialPose(p,s,{clip:"glide",phase:0,instance:"glide"});
      expect(manifest.clips[`hockey.ivory.${a.clip}.E`]?.length).toBeGreaterThan(0);
      expect(["run","kick","slide","sprint"].includes(a.clip)).toBe(false);
    }
  });
  it("plays restrained hockey contacts and deduplicates confirmed receipts across render ticks", () => {
    const audio=new CryptballAudio(()=>{}),effect=vi.spyOn(audio.engine,"effect").mockImplementation(()=>{});
    const s=createCryptballSession({sportId:"cryptcheck"}).observe();s.tick=100;
    const events=[{type:"puck-contact",tick:100,epoch:1,counter:1},{type:"ice-stop",tick:100,epoch:1,counter:2},{type:"board",tick:100,epoch:1,counter:3}];
    audio.tick(s,events);expect(effect.mock.calls.map(c=>c[1].id)).toEqual(["stick-tick","gator-scrape","puck-board"]);
    s.tick=101;audio.tick(s,events);expect(effect).toHaveBeenCalledTimes(3);
    audio.tick(s,[{type:"strike",tick:101},{type:"pass",tick:101}]);expect(effect).toHaveBeenCalledTimes(3);
    audio.resetMatch();audio.tick(s,[events[0]]);expect(effect).toHaveBeenCalledTimes(3); // Restore does not replay a historical contact.
    audio.engine.dispose();
  });
});
