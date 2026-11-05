import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('@onepage/game-runtime/pixi',async original=>{
  const runtime=await original<typeof import('@onepage/game-runtime/pixi')>();
  return {...runtime,Text:class extends runtime.Container{text='';anchor={set:()=>{}};}};
});
import { Container, Sprite, Texture, type AtlasManifest, type PixiStage } from '@onepage/game-runtime/pixi';
import { CryptballPresenter } from '../src/presenter';
import { createCryptballSession } from '../sim/session';
import { projectCourt } from '../src/projection';
import { spriteHeading } from '../src/animation';
const manifest:AtlasManifest=JSON.parse(readFileSync(new URL('../public/assets/cryptball-new-modes/manifest.json',import.meta.url),'utf8'));
function setup(sport:'crypt-dodge'|'crypt-guardian'){
  const canvas={dataset:{}} as HTMLCanvasElement;
  const stage={canvas,layers:{ground:new Container(),actors:new Container(),effects:new Container(),hud:new Container()},camera:{}} as unknown as PixiStage;
  const presenter=new CryptballPresenter(stage);
  const atlas={manifest,texture:()=>Texture.EMPTY,clip:(id:string)=>({frames:(manifest.clips?.[id]??[]).map(name=>({...manifest.frames[name],texture:Texture.EMPTY})),mirrorable:false}),dispose:()=>{}};
  Object.assign(presenter,{loaded:true,newLoaded:true,sport,newAtlas:atlas});
  return {canvas,presenter,sprites:(presenter as unknown as {sprites:Map<string,Sprite>}).sprites};
}
it('held Dodge ball uses sampled hand coordinates on the same tick, including the catch contact pose',()=>{
  const {presenter,sprites}=setup('crypt-dodge'),s=createCryptballSession({sportId:'crypt-dodge'}).observe(),p=s.players[0];
  s.tick=100;s.phase='play';s.dodge!.ball.state='held';s.dodge!.ball.holderId=p.id;s.dodge!.athletes[p.id].catchKind=null;
  p.slideTicks=p.slideRecovery=p.staggerTicks=0;p.charging=false;
  presenter.render(s);
  let foot=projectCourt(p.x/256,p.y/256),frame=manifest.frames[`new.ivory.carry.${spriteHeading(p.heading)}`];
  expect(sprites.get('ball')!.x).toBe(Math.round(foot.x)+frame.anchors!.hand!.x-frame.pivot!.x);
  expect(sprites.get('ball')!.y).toBe(Math.round(foot.y)+frame.anchors!.hand!.y-frame.pivot!.y);
  presenter.render(s,[{type:'dodge-catch',tick:100,playerId:p.id,epoch:1,counter:1}]);
  frame=manifest.frames[`new.ivory.catch-contact.${spriteHeading(p.heading)}`];
  expect(sprites.get('ball')!.x).toBe(Math.round(foot.x)+frame.anchors!.hand!.x-frame.pivot!.x);
  expect(sprites.get('ball')!.y).toBe(Math.round(foot.y)+frame.anchors!.hand!.y-frame.pivot!.y);
  presenter.dispose();
});
it('guardian modules follow pose sockets at legal sizes and keep broken cover low and nonthreatening',()=>{
  const {presenter,sprites,canvas}=setup('crypt-guardian'),s=createCryptballSession({sportId:'crypt-guardian'}).observe(),g=s.guardian!;
  s.tick=96;s.phase='play';g.elapsed=100;g.attack=null;g.transitionTicks=0;g.descriptor.size=110;
  presenter.render(s);expect(canvas.dataset.guardianPose).toBe('idle-a');
  const frame=manifest.frames[`new.guardian.${g.descriptor.palette}.idle-a`],a=(frame.anchors as unknown as {weapon:{x:number;y:number}}).weapon;
  const foot=projectCourt(g.descriptor.x/256,g.descriptor.y/256),weapon=sprites.get('mode.weapon')!;
  expect(weapon.x).toBe(Math.round(foot.x+(a.x-frame.pivot!.x)*1.1));
  expect(weapon.y).toBe(Math.round(foot.y+(a.y-frame.pivot!.y)*1.1));
  const c=g.cover[0];if(c){c.hp=0;presenter.render(s);expect(sprites.get(`mode.cover.${c.id}`)!.visible).toBe(true);}
  g.outcome='victory';g.hp=0;s.phase='results';presenter.render(s,[],true);
  expect(canvas.dataset.guardianPose).toBe('rubble');expect(sprites.get('mode.weapon')!.visible).toBe(false);
  presenter.dispose();
});
