import { expect, it } from 'vitest';
import { ProjectileOwnerV1 } from '@onepage/game-simulation/dynamic-projectiles';
it('proves the dynamic boundary callback cannot occlude an earlier target sweep', () => {
  const owner = new ProjectileOwnerV1();
  owner.spawn({id:'shot',x:0,y:0,vx:100,vy:0,gravity:0,radius:0.1,life:1,damage:1,originX:0});
  let wallQueries=0;
  const hits=owner.step(0.1,[{id:'target',x:8,y:0,nextX:8,nextY:0,radius:0.1}],
    (x,y) => {wallQueries++; return x>=4 ? {x:4,y,nx:-1,ny:0}:undefined;});
  expect(hits.map(h=>h.targetId)).toEqual(['target']);
  expect(hits[0]!.time).toBeCloseTo(0.78);
  expect(wallQueries).toBe(0);
  expect(owner.step(0.1,[])).toEqual([]);
  expect(owner.capture()).toEqual([]);
});
it('dynamic equal-time targets use stable identity, and hit removal is once only', () => {
  for(const ids of [['z','a'],['a','z']]) {
    const owner=new ProjectileOwnerV1();
    owner.spawn({id:'shot',x:0,y:0,vx:100,vy:0,gravity:0,radius:1,life:1,damage:1,originX:0});
    const targets=ids.map(id=>({id,x:8,y:0,nextX:8,nextY:0,radius:1}));
    expect(owner.step(0.1,targets).map(h=>h.targetId)).toEqual(['a']);
    expect(owner.step(0.1,targets)).toEqual([]);
  }
});
