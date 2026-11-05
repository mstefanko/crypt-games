import { describe, expect, it } from "vitest";
import { createInitialState, createCryptballSession } from "../sim/session";
import { moveBall, dragBall } from "../sim/ball";
import { groundBallPhysics } from "../sim/sports-spec";
import { skate } from "../sim/modes/cryptcheck/motion";
import { FIXED as F } from "../sim/rules";

const physics = groundBallPhysics("cryptcheck");
describe("independent hockey boundary review", () => {
  it("counts a goal only after the trailing edge crosses, symmetrically", () => {
    for (const side of [-1, 1]) {
      const b = createInitialState("practice", {}, "cryptcheck").ball;
      b.x = side * 169 * F; b.y = 0; b.vx = side * 240 * F; b.vy = 0;
      for (let i = 0; i < 3; i++) expect(moveBall(b, [], 0, () => {}, undefined, physics)).toBeNull();
      expect(moveBall(b, [], 0, () => {}, undefined, physics)).toBe(side === 1 ? 0 : 1);
    }
  });
  it("cannot turn repeated stationary-board rebounds into extra energy", () => {
    const b = createInitialState("practice", {}, "cryptcheck").ball;
    b.x = 0; b.y = 75 * F; b.vx = 180 * F; b.vy = 370 * F;
    let previous = b.vx*b.vx+b.vy*b.vy;
    for(let t=0;t<240;t++) {
      for(let sub=0;sub<4;sub++) {
        const goal=moveBall(b,[],t,()=>{},undefined,physics);
        const energy=b.vx*b.vx+b.vy*b.vy;
        expect(energy).toBeLessThanOrEqual(previous + 2 * F);
        previous=energy;
        if(goal!==null)return;
      }
      dragBall(b,physics); previous=b.vx*b.vx+b.vy*b.vy;
    }
  });
  it("coasts when aim changes and reverses only after braking", () => {
    const s=createInitialState("practice",{},"cryptcheck"),p=s.players[0];
    p.vx=120*F;p.vy=0;
    skate(s,p,{aim:128});
    expect(p.vx).toBeGreaterThan(110*F);expect(p.vy).toBe(0);
    skate(s,p,{moveX:-1,aim:128});
    expect(p.vx).toBeGreaterThan(0);
    for(let t=0;t<30;t++)skate(s,p,{moveX:-1,aim:128});
    expect(p.vx).toBeLessThan(0);
  });
  it("does not pump unbounded skating speed by alternating directions", () => {
    const s=createInitialState("practice",{},"cryptcheck"),p=s.players[0];
    p.vx=p.vy=0;
    const inputs=[[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
    for(let t=0;t<1200;t++) {
      const [moveX,moveY]=inputs[Math.floor(t/12)%inputs.length];
      skate(s,p,{moveX,moveY});
      expect(Math.hypot(p.vx,p.vy)).toBeLessThanOrEqual(120*F+2);
    }
  });
  it("restores authority during mixed skating, shots and specials", () => {
    const a=createCryptballSession({sportId:"cryptcheck",seed:999}),b=createCryptballSession({sportId:"cryptcheck",seed:999});
    const participants=[{id:"a",team:0 as const,playerId:"player-0"}];
    a.setParticipants(participants);b.setParticipants(participants);
    for(let tick=0;tick<1000;tick++) {
      const commands={a:{moveX:tick%100<50?1:-1,moveY:tick%83<40?1:-1,aim:tick*7%256,strikePressed:tick%90===0,strikeHeld:tick%90<26,strikeReleased:tick%90===26,pass:tick%151===0,dash:tick%177===0,slide:tick%131===0,special:tick%181===0}};
      a.stepParticipants(commands);b.stepParticipants(commands);
      expect(a.drainEvents()).toEqual(b.drainEvents());
      if(tick%97===0)b.restore(a.capture());
      expect(b.capture()).toEqual(a.capture());
    }
  });
});
