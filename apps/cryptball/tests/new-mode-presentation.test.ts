import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createCryptballSession } from '../sim/session';
import { athleteAnimation } from '../src/animation';
import { athleteClipId, SPORT_ART_PROFILES } from '../src/sport-presentation';
import { ballVisual } from '../src/ball-presentation';
import { guardianIsGuarding } from '../sim/modes/crypt-guardian/boss';
import { guardianPose, modeStatus } from '../src/new-mode-presentation';
import { eventCue } from '../src/audio-effects';
import { CourtTouchControls } from '../src/touch-controls';
import { resolveCourtAction } from '../src/court-intent';
import { InputScheduler } from '../src/online/input-scheduler';

const manifest=JSON.parse(readFileSync(new URL('../public/assets/cryptball-new-modes/manifest.json',import.meta.url),'utf8'));
const headings=['E','SE','S','SW','W','NW','N','NE'];
const poses=['catch-ready','catch-contact','carry','throw-windup','throw-release','throw-follow','pass-release','hit-recoil'];
describe('new mode presentation',()=>{
  it('packs every source pose, material variant and cosmetic socket in legal nearest pages',()=>{
    expect(manifest.provenance.sourceFrames).toBe(96);
    expect(manifest.sampling).toBe('nearest');
    expect(Object.keys(manifest.frames)).toHaveLength(448);
    for(const team of ['ivory','ember','owls','gators','bats','hornets'])for(const heading of headings)for(const pose of poses){
      const id=athleteClipId('crypt-dodge',team,'warrior',pose,heading),f=manifest.frames[id];
      expect(manifest.clips[id]).toEqual([id]);expect(f.pivot).toEqual({x:56,y:70});
      expect(f.anchors.hand.x).toBeGreaterThan(20);expect(f.anchors.hand.x).toBeLessThan(90);
      expect(f.anchors.hand.y).toBeGreaterThan(20);expect(f.anchors.hand.y).toBeLessThan(70);
    }
    for(const palette of ['violet','verdigris','ember'])for(const pose of ['idle-a','idle-b','wake','roar','ranged-tell','ranged-aim','ranged-recoil','ranged-recover','melee-tell','sweep','slam','melee-recover','hit','stun','defeat','rubble'])expect(manifest.frames[`new.guardian.${palette}.${pose}`].anchors.weapon).toBeDefined();
    for(const weapon of ['cannon','hook','maul'])expect(manifest.frames[`new.object.${weapon}`].anchors.grip).toBeDefined();
    for(const f of Object.values(manifest.frames) as {x:number;y:number;width:number;height:number;pageId:string}[]){expect(manifest.pages[f.pageId]).toBeDefined();expect(f.x+f.width).toBeLessThan(1024);expect(f.y+f.height).toBeLessThan(1024);}
  });
  it('shares weapon-free carry and release poses with Guardian',()=>{
    expect(SPORT_ART_PROFILES['crypt-guardian'].athletes).toBe('dodge');
    expect(athleteClipId('crypt-guardian','ivory','warrior','carry','E')).toBe('new.ivory.carry.E');
    expect(athleteClipId('crypt-guardian','ivory','warrior','throw-release','E')).toBe('new.ivory.throw-release.E');
    expect(athleteClipId('crypt-guardian','ivory','warrior','dive','E')).toBe('sports.ivory.dive.E');
    expect(athleteClipId('crypt-dodge','ivory','warrior','run','E')).toBe('sports.ivory.run.E');
  });
  it('uses catch, carry and authoritative release poses without waiting for animation completion',()=>{
    const s=createCryptballSession({sportId:'crypt-dodge'}).observe(),p=s.players[0],d=s.dodge!.athletes[p.id];
    s.tick=100;s.dodge!.ball.holderId=p.id;p.slideTicks=0;p.slideRecovery=0;p.charging=false;d.catchKind=null;d.pendingThrow=null;
    expect(athleteAnimation(p,s).clip).toBe('carry');
    expect(athleteAnimation(p,s,{type:'dodge-catch',tick:100}).clip).toBe('catch-contact');
    expect(athleteAnimation(p,s,{type:'dodge-catch',tick:80,presentationTick:100}).clip).toBe('catch-contact');
    expect(athleteAnimation(p,s,{type:'dodge-throw',tick:100}).clip).toBe('throw-release');
    s.tick=105;expect(athleteAnimation(p,s,{type:'dodge-throw',tick:100}).clip).toBe('throw-follow');
    p.charging=true;expect(athleteAnimation(p,s).clip).toBe('throw-windup');p.charging=false;
    p.slideTicks=12;expect(athleteAnimation(p,s).clip).toBe('dive');p.slideTicks=0;
    d.lives=0;expect(athleteAnimation(p,s).clip).toBe('hit-recoil');expect(modeStatus(s)).toContain('OUT');
  });
  it('shows every guardian attack phase from the same locked authoritative timeline',()=>{
    const s=createCryptballSession({sportId:'crypt-guardian'}).observe(),g=s.guardian!;g.elapsed=100;s.tick=100;
    g.attack={id:7,kind:'shot',elapsed:0,timing:{tell:48,active:1,recover:72},hits:[],targetId:s.players[0].id,locked:false,shapes:[],released:false};
    expect(guardianPose(s)).toBe('ranged-tell');g.attack.locked=true;expect(guardianPose(s)).toBe('ranged-aim');
    g.attack.elapsed=48;expect(guardianPose(s)).toBe('ranged-recoil');g.attack.elapsed=49;expect(guardianPose(s)).toBe('ranged-recover');
    g.attack.kind='sweep';g.attack.elapsed=48;expect(guardianPose(s)).toBe('sweep');g.attack.kind='slam';expect(guardianPose(s)).toBe('slam');
    g.attack=null;g.transitionTicks=60;expect(guardianPose(s)).toBe('roar');g.transitionTicks=0;g.outcome='victory';expect(guardianPose(s)).toBe('defeat');
  });
  it('shows frontal guard through tells and active attacks and drops it for recovery or stagger',()=>{
    const state=createCryptballSession({sportId:'crypt-guardian'}).observe(),g=state.guardian!;
    state.tick=100;g.elapsed=100;g.staggerUntil=0;g.transitionTicks=0;
    g.attack={id:1,kind:'shot',elapsed:0,timing:{tell:48,active:1,recover:54},hits:[],targetId:state.players[0].id,locked:false,shapes:[],released:false};
    expect(guardianIsGuarding(state)).toBe(true);
    g.attack.elapsed=48;expect(guardianIsGuarding(state)).toBe(true);
    g.attack.elapsed=49;expect(guardianIsGuarding(state)).toBe(false);
    g.attack=null;expect(guardianIsGuarding(state)).toBe(true);
    g.staggerUntil=101;expect(guardianIsGuarding(state)).toBe(false);
  });
  it('uses distinct dodge spin/contact art and synthesis for catches, damage, revives and each warning family',()=>{
    expect(ballVisual('crypt-dodge',0,1).frame).toBe('new.object.ball-a');expect(ballVisual('crypt-dodge',4,1).frame).toBe('new.object.ball-b');
    expect(ballVisual('crypt-dodge',4,10,{type:'dodge-ding',tick:10}).frame).toBe('new.object.ball-squash');
    for(const type of ['dodge-catch','dodge-ding','dodge-out','guardian-damage','guardian-down','guardian-revive','guardian-cover-crack','guardian-cover-break','guardian-victory','guardian-throw','guardian-pass','guardian-catch','guardian-block','guardian-stagger','guardian-deflect-tell','guardian-deflect'])expect(eventCue({type,tick:1},'crypt-guardian')?.voices.length).toBeGreaterThan(0);
    const rhythm=(kind:string)=>eventCue({type:'guardian-tell',kind,tick:1},'crypt-guardian')!.voices.map(v=>[v.patch.id,v.delay]);
    expect(rhythm('shot')).not.toEqual(rhythm('hook'));expect(rhythm('hook')).not.toEqual(rhythm('slam'));
  });
});

describe('contextual touch and online held channels',()=>{
  it('catches immediately, permits a committed flick and disarms the same thumb across possession',()=>{
    const c=new CourtTouchControls(intent => resolveCourtAction(createCryptballSession({sportId:'crypt-dodge'}).observe(),intent).press);c.setContext({catch:true,revive:false});c.down(1,100,100,0);c.down(2,400,100,1);
    expect(c.consume(2)).toMatchObject({edges:{strikePressed:true},strikeHeld:false});
    expect(c.consume(300)).toMatchObject({edges:{},strikeHeld:false});
    c.setContext({catch:false,revive:false});expect(c.consume(500).strikeHeld).toBe(false);c.up(2,400,100,510);expect(c.consume(520).edges).toEqual({});
    c.setContext({catch:true,revive:false});c.down(3,400,100,600);c.consume(601);c.movePointer(3,445,100,620);expect(c.consume(621).edges).toEqual({slide:true});
  });
  it('holds revival without releasing a pass, stops on range loss and cancels prepared throws on movement lift',()=>{
    const c=new CourtTouchControls(intent => resolveCourtAction(createCryptballSession({sportId:'crypt-dodge'}).observe(),intent).press);c.setContext({catch:false,revive:true});c.down(1,100,100,0);c.down(2,400,100,1);
    expect(c.consume(2)).toMatchObject({edges:{},passHeld:true,strikeHeld:false});expect(c.consume(2000).passHeld).toBe(true);
    c.setContext({catch:false,revive:false});expect(c.consume(2010)).toMatchObject({edges:{},passHeld:false});c.up(2,400,100,2020);expect(c.consume(2030).edges).toEqual({});
    c.down(3,400,100,2100);c.consume(2300);c.up(1,100,100,2310);expect(c.consume(2320)).toMatchObject({edges:{},strikeHeld:true});
  });
  it('retains guardian passHeld over repeated network slots and releases it; new slides never repeat',()=>{
    const scheduler=new InputScheduler();scheduler.capture({passHeld:true,slide:true},0,true,'crypt-guardian');
    expect(scheduler.allocate(10,10,0)?.command).toMatchObject({passHeld:true,slide:true});
    scheduler.capture({passHeld:true},17,true,'crypt-guardian');const held=scheduler.allocate(11,11,17)?.command;expect(held?.passHeld).toBe(true);expect(held?.slide).toBeUndefined();
    scheduler.capture({passHeld:false},34,true,'crypt-guardian');expect(scheduler.allocate(12,12,34)?.command.passHeld).toBe(false);
  });
});

it('both-finger lift cancels a prepared Dodge throw inside the grace window',()=>{
  const c=new CourtTouchControls(intent => resolveCourtAction(createCryptballSession({sportId:'crypt-dodge'}).observe(),intent).press);c.down(1,100,100,0);c.down(2,400,100,1);c.consume(200);c.up(2,400,100,210);
  expect(c.consume(211).edges).toEqual({});
  c.setContext({catch:false,revive:false,preparedThrow:true});
  c.up(1,100,100,212);expect(c.consume(213).edges).toEqual({cancel:true});
});
