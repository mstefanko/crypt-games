import { describe, expect, it } from 'vitest';
import { resolveAabbAxis } from '@onepage/game-simulation/aabb-mover';
import { geometryOverlaps, geometrySweep } from './geometry';
import { arenaOverlaps, sweepArenaContact } from './m3/arena-geometry';
import { caveRectsOverlap } from './cave-motor';
const body = {x: 0, y: 0, width: 2, height: 2};
const wall = {id: 'wall', x: 4, y: 0, width: 2, height: 4};
describe('bounded face-crossing movement contract', () => {
  it('executes the public catalog example and stops a long displacement at the first wall', () => {
    const result = resolveAabbAxis(body, 100, 'x', () => [wall]);
    expect(result).toEqual({displacement: 2, blocked: true, contacts: [wall], tested: 1});
    expect(body.x).toBe(0);
  });
  it('records exact destination contact and lexical ties independently of query order', () => {
    const a = {...wall, id: 'a'}, z = {...wall, id: 'z'};
    for (const candidates of [[z,a], [a,z]])
      expect(resolveAabbAxis(body, 2, 'x', () => candidates)).toEqual({displacement: 2, blocked: false, contacts: [a,z], tested: 2});
  });
  it('does not depenetrate and does not block parallel edge/corner grazing', () => {
    expect(resolveAabbAxis({...body,x:4}, 1, 'x', () => [wall]).displacement).toBe(1);
    expect(resolveAabbAxis({...body,y:4}, 100, 'x', () => [wall]).displacement).toBe(100);
    expect(resolveAabbAxis(body, 0, 'y', () => [{...wall,x:0,y:2}]).contacts).toHaveLength(1);
  });
  it('rejects units, duplicate identity and candidate overflow without mutation', () => {
    const before = {...body};
    for (const n of [NaN, Infinity, 0.5, 2 ** 31]) expect(() => resolveAabbAxis(body,n,'x',()=>[])).toThrow();
    expect(() => resolveAabbAxis(body,1,'x',()=>[wall,wall])).toThrow();
    expect(() => resolveAabbAxis(body,1,'x',()=>Array(4097).fill(wall))).toThrow();
    expect(() => resolveAabbAxis(body,1,"z" as "x",()=>[])).toThrow();
    expect(() => resolveAabbAxis(body,1,"x",()=>[{...wall,id:7 as unknown as string}])).toThrow();
    expect(body).toEqual(before);
  });
  it('matches the original face-crossing loop over a bounded deterministic vector table', () => {
    // Independent before-extraction oracle. Preserve face-crossing, not continuous diagonal sliding.
    for (let x=-4;x<=8;x++) for (let y=-3;y<=5;y++) for (let dx=-8;dx<=8;dx++) {
      const b = {...body,x,y}; let accepted = dx;
      if (!(b.y >= wall.y+wall.height || b.y+b.height <= wall.y)) {
        if(dx>0 && b.x+b.width<=wall.x && b.x+b.width+accepted>=wall.x) accepted=Math.min(accepted,wall.x-b.x-b.width);
        if(dx<0 && b.x>=wall.x+wall.width && b.x+accepted<=wall.x+wall.width) accepted=Math.max(accepted,wall.x+wall.width-b.x);
      }
      expect(resolveAabbAxis(b,dx,'x',()=>[wall]).displacement, `x=${x},y=${y},dx=${dx}`).toBe(accepted);
    }
  });
});
describe('shared compatible open shape vectors', () => {
  it.each([
    [{x:2,y:0,width:2,height:2}, false],
    [{x:2,y:2,width:2,height:2}, false],
    [{x:1,y:1,width:2,height:2}, true],
  ] as const)('retains overlap at %j', (target,expected) => {
    for (const query of [geometryOverlaps, arenaOverlaps,caveRectsOverlap]) expect(query(body,target)).toBe(expected);
  });
  it.each([
    [2,0,wall,{n:2,d:2}],
    [4,4,{...wall,y:-2,height:4},null],
    [0,1,{...wall,x:2},null],
    [1,0,{...wall,x:1},{n:0,d:1}],
  ] as const)('retains sweep dx=%i dy=%i', (dx,dy,target,expected) => {
    expect(geometrySweep(body,{x:dx,y:dy},target)).toEqual(expected);
    expect(sweepArenaContact(body,dx,dy,target)).toEqual(expected);
  });
});
