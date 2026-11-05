import { describe, it, expect } from "vitest";
import { DeterministicRandom } from "@onepage/game-simulation/random";
import { createInitialState, createCryptballSession } from "../sim/session";
import {
  resetGuardian,
  guardianStep,
  validateGuardianState,
} from "../sim/modes/crypt-guardian";
import {
  guardianBallContact,
  moveGuardianBall,
  withGuardianOrb,
} from "../sim/modes/crypt-guardian/ball";
import { guardianDamagePlayer } from "../sim/modes/crypt-guardian/damage";
import {
  guardianIsGuarding,
  stepGuardianBoss,
} from "../sim/modes/crypt-guardian/boss";
import { FIXED as F, RULES } from "../sim/rules";
function fixture() {
  const s = createInitialState("match", {}, "crypt-guardian");
  resetGuardian(s, 2);
  s.phase = "play";
  s.tick = 100;
  s.guardian!.nextAttack = 1e6;
  return s;
}
function shot(s: ReturnType<typeof fixture>, assist = false) {
  const p = s.players[0];
  p.x = 0;
  p.y = 10 * F;
  p.heading = 205;
  s.possessionId = p.id;
  s.ball.x = 0;
  s.ball.y = 0;
  p.action = {
    id: s.nextAction++,
    kind: "strike",
    elapsed: 4,
    timing: { tell: 4, active: 3, recover: 9 },
    hits: [],
    heading: 205,
    charge: 0,
  };
  if (assist) {
    s.guardian!.athletes[p.id].assistUntil = s.tick + 48;
    s.guardian!.athletes[p.id].assistFrom = "player-1";
  }
  return guardianBallContact(s, p);
}
describe("Guardian carry and defense", () => {
  it("starts two reachable independent balls", () => {
    const s = fixture();
    expect(s.guardian!.orbs.map((o) => o.id)).toEqual([
      "guardian-0",
      "guardian-1",
    ]);
    expect(s.guardian!.orbs[0].ball.x).toBe(-25 * F);
    expect(s.guardian!.orbs[1].ball.x).toBe(25 * F);
    expect(s.guardian!.orbs[0].ball).not.toBe(s.guardian!.orbs[1].ball);
    validateGuardianState(s);
  });
  it("automatically collects loose balls but never duplicates occupied hands", () => {
    const s = fixture(),
      g = s.guardian!,
      p = s.players[0];
    p.x = 0;
    p.y = 20 * F;
    s.ball.x = p.x;
    s.ball.y = p.y;
    moveGuardianBall(s);
    expect(s.possessionId).toBe(p.id);
    withGuardianOrb(s, g.orbs[1], () => {
      s.ball.x = p.x;
      s.ball.y = p.y;
      moveGuardianBall(s);
      expect(s.possessionId).toBeNull();
    });
    expect(s.possessionId).toBe(p.id);
  });
  it("requires possession for attacks and assists a broad aim only at release", () => {
    const s = fixture();
    expect(shot(s)).toBe(true);
    expect(s.ball.vx).toBe(0);
    expect(s.ball.vy).toBe(-250 * F);
    const vx = s.ball.vx,
      vy = s.ball.vy;
    s.players[0].heading = 0;
    moveGuardianBall(s);
    expect(s.ball.vx).toBe(vx);
    expect(s.ball.vy).toBe(vy);
    expect(guardianBallContact(s, s.players[1])).toBe(false);
  });
  it("consumes one short pass empowerment into bounded full power", () => {
    const s = fixture();
    expect(shot(s, true)).toBe(true);
    expect(s.ball.vy).toBe(-380 * F);
    expect(s.guardian!.ballToken?.damage).toBe(16);
    expect(s.guardian!.athletes[s.players[0].id].assistFrom).toBeNull();
    expect(s.guardian!.athletes[s.players[0].id].assistUntil).toBe(0);
  });
  it("expires pass empowerment", () => {
    const s = fixture();
    s.guardian!.athletes[s.players[0].id].assistFrom = "player-1";
    s.guardian!.athletes[s.players[0].id].assistUntil = s.tick - 1;
    expect(shot(s)).toBe(true);
    expect(s.guardian!.ballToken?.damage).toBe(8);
  });
  it("blocks deterministic frontal shots and bounded guard pressure staggers", () => {
    const s = fixture(),
      g = s.guardian!;
    g.guard = 18;
    shot(s);
    for (let i = 0; i < 64; i++) moveGuardianBall(s);
    expect(g.hp).toBe(300);
    expect(g.guard).toBe(0);
    expect(g.staggerUntil).toBe(s.tick + 120);
    expect(s.events.some((e) => e.type === "guardian-stagger")).toBe(true);
  });
  it("exposes rear hits without random defense", () => {
    const s = fixture(),
      g = s.guardian!;
    g.guardHeading = 192;
    shot(s);
    for (let i = 0; i < 64; i++) moveGuardianBall(s);
    expect(g.hp).toBe(292);
    expect(g.guard).toBe(100);
  });
  it("hostile returns require a deliberate empty-hand catch and only claim one life", () => {
    for (const ready of [false, true]) {
      const s = fixture(),
        g = s.guardian!,
        p = s.players[0];
      p.x = 0;
      p.y = 20 * F;
      s.ball.x = 0;
      s.ball.y = p.y;
      g.hostileUntil = s.tick + 100;
      g.athletes[p.id].catchUntil = ready ? s.tick + 9 : 0;
      for (let i = 0; i < 4; i++) moveGuardianBall(s);
      expect(g.athletes[p.id].hp).toBe(ready ? 5 : 4);
      expect(s.possessionId).toBe(ready ? p.id : null);
    }
  });
  it("downing drops a secondary orb and passes while carrying never channel revive", () => {
    const s = fixture(),
      g = s.guardian!,
      p = s.players[0],
      down = s.players[1];
    g.orbs[1].possessionId = p.id;
    g.athletes[p.id].hp = 1;
    guardianDamagePlayer(s, p, s.nextAction++);
    expect(g.orbs[1].possessionId).toBeNull();
    expect(g.athletes[p.id].status).toBe("down");
    g.athletes[p.id].hp = 5;
    g.athletes[p.id].status = "active";
    g.athletes[p.id].immunityUntil = 0;
    g.athletes[down.id].hp = 0;
    g.athletes[down.id].status = "down";
    down.x = p.x + 15 * F;
    down.y = p.y;
    s.possessionId = p.id;
    s.ball.x = p.x;
    s.ball.y = p.y;
    guardianStep(
      s,
      new Map([[p.id, { pass: true }]]),
      new DeterministicRandom([{ owner: "cryptball", name: "ai", seed: 42 }]),
    );
    expect(g.athletes[down.id].reviveTicks).toBe(0);
  });
  it.each([
    ["tell-front", 50, 64, 0],
    ["active-front", 72, 64, 0],
    ["active-flank", 72, 0, 8],
    ["recover-front", 78, 64, 12],
  ])(
    "keeps committed directional defense in %s",
    (_name, elapsed, heading, damage) => {
      const s = fixture(),
        g = s.guardian!;
      g.guardHeading = Number(heading);
      g.attack = {
        id: s.nextAction++,
        kind: "slam",
        elapsed: Number(elapsed),
        timing: { tell: 72, active: 6, recover: 60 },
        hits: [],
        targetId: "player-0",
        locked: true,
        shapes: [
          { kind: "disk", x: 100 * F, y: 40 * F, radius: 24 * F, at: 0 },
        ],
        released: Number(elapsed) >= 72,
      };
      expect(guardianIsGuarding(s)).toBe(Number(elapsed) < 78);
      shot(s);
      for (let i = 0; i < 64; i++) moveGuardianBall(s);
      expect(g.hp).toBe(300 - Number(damage));
      expect(g.guard).toBe(Number(damage) === 0 ? 82 : 100);
    },
  );
  it("turns guard at a bounded rate before commitment and freezes through active", () => {
    const s = fixture(),
      g = s.guardian!;
    g.guardHeading = 0;
    g.attack = {
      id: s.nextAction++,
      kind: "slam",
      elapsed: 12,
      timing: { tell: 72, active: 6, recover: 60 },
      hits: [],
      targetId: "player-0",
      locked: false,
      shapes: [],
      released: false,
    };
    stepGuardianBoss(s);
    expect(g.guardHeading).toBe(1);
    g.attack!.locked = true;
    g.attack!.elapsed = 72;
    s.players[0].x = -100 * F;
    stepGuardianBoss(s);
    expect(g.guardHeading).toBe(1);
  });
  it("restores two held balls without ownership duplication", () => {
    const a = createCryptballSession({ sportId: "crypt-guardian", seed: 2 });
    a.setParticipants([]);
    for (let i = 0; i < 400; i++) a.step();
    const b = createCryptballSession({ sportId: "crypt-guardian", seed: 0 });
    b.restore(a.capture());
    for (let i = 0; i < 120; i++) {
      a.step();
      b.step();
    }
    expect(b.capture()).toEqual(a.capture());
  });
});


it("uses two allied seats and rejects a third controller",()=>{
  const session=createCryptballSession({sportId:"crypt-guardian"});
  expect(session.observe().players.map(p=>[p.id,p.team])).toEqual([["player-0",0],["player-1",0]]);
  expect(()=>session.setParticipants([{id:"a",team:0,playerId:"player-0"},{id:"b",team:0,playerId:"player-1"},{id:"c",team:1,playerId:"player-2"}])).toThrow();
});
it("reports body contact coordinates and returns continuously from the impact",()=>{
  const s=fixture(),g=s.guardian!;g.guardHeading=192;
  shot(s);
  for(let i=0;i<90 && !s.events.some(e=>e.type==="guardian-hit");i++)moveGuardianBall(s);
  const hit=s.events.find(e=>e.type==="guardian-hit")!;
  expect(hit).toBeDefined();
  expect(Math.hypot(Number(hit.x)-g.descriptor.x,Number(hit.y)-g.descriptor.y)).toBeCloseTo(g.descriptor.hurtRadius+3*F,-1);
  expect(Math.hypot(s.ball.x-Number(hit.x),s.ball.y-Number(hit.y))).toBeLessThan(F);
  expect(hit.damage).toBe(8);
});
