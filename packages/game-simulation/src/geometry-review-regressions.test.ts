import { expect, it } from 'vitest';
import raw from '../../../examples/game-m1/definitions.json';
import { UNIT, validateDefinitions } from '../../game-project/src/index';
import { resolveAabbAxis } from '@onepage/game-simulation/aabb-mover';
import { body, candidates, moveActor } from './collision';
import { createWorld } from './simulation';
import { restoreCheckpoint, serializeCheckpoint } from './checkpoint';
import { equipCombatActor } from './combat-runtime';
const identity = {rulesBuildId:'review',contentId:'review'};
function tiedCourse(moving = true) {
  const data=structuredClone(raw), level=data.levels[0];
  level.tiles.fill(0); level.rectangles=[]; level.platforms=[];
  level.tiles[5*(level.width/level.tileSize)+3]=2;
  level.spawns[0].y=80*UNIT; data.archetypes[1].ai='none';
  // The actor's 24px body exactly fits between the ceiling and both supports.
  level.rectangles=[{id:'ceiling',x:32*UNIT,y:48*UNIT,width:64*UNIT,height:8*UNIT,oneWay:false}];
  if(moving) level.platforms=[{id:'ride',x:32*UNIT,y:80*UNIT,width:64*UNIT,height:8*UNIT,endX:64*UNIT,speed:UNIT}];
  return createWorld(validateDefinitions(data),identity,undefined,{inputCodec:'platform-input-v2'});
}
it('stationary contacts include both axis faces, excluding penetration and corner-only contact', () => {
  const b={x:2,y:2,width:2,height:2};
  for(const axis of ['x','y'] as const) {
    const negative={id:'negative',x:axis==='x'?0:2,y:axis==='y'?0:2,width:2,height:2};
    const positive={id:'positive',x:axis==='x'?4:2,y:axis==='y'?4:2,width:2,height:2};
    const corner={id:'corner',x:4,y:4,width:2,height:2};
    const penetrating={...b,id:'penetrating'};
    for(const list of [[positive,negative,corner,penetrating],[penetrating,corner,negative,positive]])
      expect(resolveAabbAxis(b,0,axis,()=>list)).toEqual({displacement:0,blocked:false,contacts:[negative,positive],tested:4});
  }
});
it('preserves the original lexical moving-platform versus tile support tie, independently of query order', () => {
  const w=tiedCourse(), actor=w.actors[0];
  const b=body(actor,w.definitions.archetypes.find(d=>d.id===actor.archetypeId)!);
  const queried=candidates(w,b);
  const supports=queried.filter(c=>c.y===b.y+b.height);
  expect(supports.map(c=>c.id)).toEqual(['platform:ride','tile:00000203']);
  for(const list of [supports,[...supports].reverse()])
    expect(resolveAabbAxis(b,0,'y',()=>list).contacts.map(c=>c.id)).toEqual(['platform:ride','tile:00000203']);
  for(const dy of [0,UNIT]) {
    moveActor(w,actor,0,dy);
    expect(actor.grounded).toBe(true); expect(actor.riderId).toBe('ride');
    expect(actor.platformMotion?.supportId).toBe('platform:ride');
    expect(actor.y).toBe(80*UNIT);
  }
});
it('a stationary ceiling contact cannot replace downward tile support', () => {
  const w=tiedCourse(false), actor=w.actors[0];
  moveActor(w,actor,0,0);
  expect(actor.grounded).toBe(true); expect(actor.riderId).toBeNull();
  expect(actor.platformMotion?.supportId).toBe('tile:00000203');
  actor.y=120*UNIT; // head touches the tile underside, feet have no support
  moveActor(w,actor,0,0);
  expect(actor.grounded).toBe(false); expect(actor.platformMotion?.supportId).toBeNull();
});
it('preserves admitted large platform sweeps beyond the public per-query candidate budget', () => {
  const data=structuredClone(raw),level=data.levels[0];
  level.width=2048; level.height=1024; level.rectangles=[]; level.platforms=[];
  level.tiles=Array((level.width/level.tileSize)*(level.height/level.tileSize)).fill(2);
  const w=createWorld(validateDefinitions(data),identity),actor=w.actors[0];
  actor.x=6*UNIT;actor.y=24*UNIT;
  expect(candidates(w,{x:0,y:0,width:2048*UNIT,height:1024*UNIT}).length).toBeGreaterThan(4096);
  // X escapes the tile field before Y; one-way tiles never block the X sweep.
  moveActor(w,actor,2048*UNIT,1024*UNIT);
  expect({x:actor.x,y:actor.y}).toEqual({x:2054*UNIT,y:1048*UNIT});
  const before=structuredClone(actor);
  for(const n of [Infinity,NaN]) expect(()=>moveActor(w,actor,n,0)).toThrow('Invalid AABB movement');
  expect(actor).toEqual(before);
});
it('rejects null checkpoint records through the codec before native key inspection', () => {
  const w=tiedCourse(),actor=w.actors[0],ability=w.definitions.abilities[0].id;
  equipCombatActor(actor,[ability],ability);
  actor.combatState!.cooldowns={[ability]:0}; actor.combatState!.cooldownDeadlines={[ability]:0};actor.combatState!.cooldownTick=0;
  const before=serializeCheckpoint(w);
  const mutations=[
    (_:any)=>null,
    (v:any)=>{v.actors[0]=null;return v;},
    (v:any)=>{v.actors[0].platformMotion=null;return v;},
    (v:any)=>{v.actors[0].combatState=null;return v;},
    (v:any)=>{v.actors[0].combatState.cooldownDeadlines=null;return v;},
  ];
  for(const mutate of mutations) {
    const json=JSON.stringify(mutate(JSON.parse(before)));
    expect(()=>restoreCheckpoint(w.definitions,identity,json)).toThrow('Checkpoint expected object');
    expect(serializeCheckpoint(w)).toBe(before);
  }
});
