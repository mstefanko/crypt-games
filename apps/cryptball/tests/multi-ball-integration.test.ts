import { describe, expect, it } from 'vitest';
import { pack, unpack } from 'msgpackr';
import { MatchAuthority } from '../../cryptball-server/src/model';
import { encodeSnapshot, decodeSnapshot } from '../protocol';
import { createCryptballSession } from '../sim/session';
import { confirmedCombatPresentation, DodgeFlightPresentation } from '../src/online/confirmed-combat';
import { athleteAnimation } from '../src/animation';
import { guardianDeflectionCues, maulApproachLift, modeStatus } from '../src/new-mode-presentation';

describe('multi-ball presentation and reconnect',()=>{
  for(const sportId of ['crypt-dodge','crypt-guardian'] as const) it(`${sportId} survives transport without shared references and reconnect replay`,()=>{
    const live=createCryptballSession({sportId,mode:'practice',seed:197});
    for(let i=0;i<120;i++)live.step({});
    const transported=unpack(pack(live.capture()));
    const restored=createCryptballSession({sportId,mode:'practice',seed:1});
    restored.restore(transported);
    for(let i=0;i<180;i++) {live.step({});restored.step({});}
    expect(restored.capture()).toEqual(live.capture());
    const state=restored.observe();
    expect(state.dodge?.balls.length ?? state.guardian?.orbs.length).toBe(2);
  });
  for(const sportId of ['crypt-dodge','crypt-guardian'] as const) it(`${sportId} authority snapshot fits the wire budget and restores both balls`,()=>{
    const authority=new MatchAuthority('multi-ball',false,sportId);
    authority.join('a','Ally');authority.join('b','Peer');authority.ready('a');authority.ready('b');authority.start();
    for(let i=0;i<240;i++)authority.advance();
    const decoded=decodeSnapshot(encodeSnapshot(authority.snapshot('a',[])));
    const replica=createCryptballSession({sportId});replica.restore(decoded.checkpoint);
    expect(replica.capture()).toEqual(decoded.checkpoint);
    expect(decoded.checkpoint.state.dodge?.balls.length ?? decoded.checkpoint.state.guardian?.orbs.length).toBe(2);
  });
  it('confirms each secondary Dodge ball independently and renders carry for its holder',()=>{
    const authority=createCryptballSession({sportId:'crypt-dodge'}).observe(),predicted=structuredClone(authority);
    const secondary=authority.dodge!.balls[1],p=authority.players[1];
    secondary.mode.state='held';secondary.mode.holderId=p.id;secondary.mode.throwId++;
    const draw=confirmedCombatPresentation(predicted,authority);
    expect(draw.dodge!.balls[1].mode.holderId).toBe(p.id);
    expect(athleteAnimation(draw.players[1],draw).clip).toBe('carry');
  });
  it('confirms secondary Guardian ownership and guard resources without predicting damage',()=>{
    const authority=createCryptballSession({sportId:'crypt-guardian'}).observe(),predicted=structuredClone(authority),p=authority.players[1];
    authority.guardian!.orbs[1].possessionId=p.id;authority.guardian!.guard=35;authority.guardian!.staggerUntil=authority.tick+40;
    predicted.guardian!.guard=0;
    const draw=confirmedCombatPresentation(predicted,authority);
    expect(draw.guardian!.orbs[1].possessionId).toBe(p.id);expect(draw.guardian!.guard).toBe(35);
    expect(athleteAnimation(draw.players[1],draw).clip).toBe('carry');
    draw.controlledId=p.id;expect(modeStatus(draw)).toContain('RELEASE TO THROW');
    expect(modeStatus(draw)).not.toContain('WARNING');
  });
});

it('warns for secondary-orb deflection independently and lands the maul at contact',()=>{
  const state=createCryptballSession({sportId:'crypt-guardian'}).observe();
  state.tick=80;state.guardian!.deflectUntil=0;
  state.guardian!.orbs[0].deflectUntil=0;state.guardian!.orbs[1].deflectUntil=95;
  expect(guardianDeflectionCues(state)).toEqual([{id:'guardian-1',x:state.guardian!.orbs[1].ball.x,y:state.guardian!.orbs[1].ball.y,z:state.guardian!.orbs[1].ball.z,until:95}]);
  state.tick=95;expect(guardianDeflectionCues(state)).toEqual([]);
  expect(maulApproachLift(0)).toBe(0);expect(maulApproachLift(.5)).toBe(30);expect(maulApproachLift(1)).toBeCloseTo(0);
});

for (const flight of ["friendly-pass", "hostile-flight"] as const)
  it(`keeps the predicted terminal pose for the same confirmed ${flight}`, () => {
    const authority = createCryptballSession({
      sportId: "crypt-dodge",
    }).observe();
    const known = authority.dodge!.balls[1];
    known.mode.state = flight;
    known.mode.holderId = null;
    known.mode.throwId = 9;
    known.mode.releaseTick = 12;
    known.physical.x = 1000;
    const predicted = structuredClone(authority),
      local = predicted.dodge!.balls[1];
    local.mode.state = "dead-loose";
    local.physical.x = 8000;
    const draw = confirmedCombatPresentation(predicted, authority);
    expect(draw.dodge!.balls[1].physical.x).toBe(8000);
    expect(draw.dodge!.balls[1].mode.state).toBe(flight);
    expect(authority.dodge!.balls[1].physical.x).toBe(1000);
    // A different release, throw, holder or reset is a distinct authoritative generation.
    for (const change of [
      () => {
        local.mode.releaseTick++;
      },
      () => {
        local.mode.throwId++;
      },
      () => {
        local.mode.holderId = "other";
      },
      () => {
        local.mode.state = "reset";
      },
    ]) {
      const saved = structuredClone(local.mode);
      change();
      expect(
        confirmedCombatPresentation(predicted, authority).dodge!.balls[1]
          .physical.x,
      ).toBe(1000);
      local.mode = saved;
    }
  });

it("holds final flight frames across checkpoint rewinds until prediction catches up or authority confirms contact", () => {
  const state = createCryptballSession({ sportId: "crypt-dodge" }).observe();
  const ball = state.dodge!.balls[1];
  ball.mode.state = "hostile-flight";
  ball.mode.holderId = null;
  ball.mode.throwId = 5;
  ball.mode.releaseTick = 50;
  ball.physical.x = 1000;
  ball.physical.vx = -100;
  const presentation = new DodgeFlightPresentation();
  presentation.draw(state);
  ball.physical.x = -13000;
  presentation.draw(state);
  // The first reset/catch fallback and subsequent prediction frames behind the held point stay held.
  for (const x of [1000, -5000, -12000]) {
    ball.physical.x = x;
    const drawn = presentation.draw(state);
    expect(drawn.dodge!.balls[1].physical.x).toBe(-13000);
    expect(drawn.dodge!.balls[1].mode.state).toBe("hostile-flight");
    expect(ball.physical.x).toBe(x);
  }
  ball.physical.x = -14000;
  expect(presentation.draw(state).dodge!.balls[1].physical.x).toBe(-14000);
  ball.mode.state = "reset";
  ball.physical.x = 26000;
  expect(presentation.draw(state).dodge!.balls[1].physical.x).toBe(26000);
  ball.mode.state = "hostile-flight";
  ball.mode.throwId++;
  expect(presentation.draw(state).dodge!.balls[1].physical.x).toBe(26000);
});

for (const contact of ["held", "reset"] as const)
  it(`does not rewind or publish predicted ${contact} during a confirmed flight`, () => {
    const authority = createCryptballSession({
      sportId: "crypt-dodge",
    }).observe();
    const known = authority.dodge!.balls[1];
    known.mode.state = "hostile-flight";
    known.mode.holderId = null;
    known.mode.throwId = 5;
    known.mode.releaseTick = 50;
    known.physical.x = 1000;
    known.physical.vx = -100;
    const predicted = structuredClone(authority),
      local = predicted.dodge!.balls[1];
    local.physical.x = -13000;
    const view = new DodgeFlightPresentation();
    view.draw(confirmedCombatPresentation(predicted, authority));
    local.mode.state = contact;
    local.mode.holderId = contact === "held" ? "player-1" : null;
    local.physical.x = 26000;
    const held = view.draw(confirmedCombatPresentation(predicted, authority));
    expect(held.dodge!.balls[1].physical.x).toBe(-13000);
    expect(held.dodge!.balls[1].mode.state).toBe("hostile-flight");
    known.mode.state = contact;
    known.mode.holderId = local.mode.holderId;
    known.physical.x = 26000;
    const confirmed = view.draw(
      confirmedCombatPresentation(predicted, authority),
    );
    expect(confirmed.dodge!.balls[1].mode.state).toBe(contact);
    expect(confirmed.dodge!.balls[1].physical.x).toBe(26000);
  });

it("releases a speculative flight hold when authority catches up or confirms a changed direction", () => {
  for (const changedDirection of [false, true]) {
    const state = createCryptballSession({ sportId: "crypt-dodge" }).observe();
    state.tick = 100;
    const ball = state.dodge!.balls[1];
    ball.mode.state = "hostile-flight";
    ball.mode.holderId = null;
    ball.physical.x = -1000;
    ball.physical.vx = -100;
    const authority = structuredClone(state);
    authority.tick = 90;
    const view = new DodgeFlightPresentation();
    view.draw(state, authority);
    state.tick = 101;
    ball.physical.x = 1000;
    expect(view.draw(state, authority).dodge!.balls[1].physical.x).toBe(-1000);
    if (changedDirection) authority.dodge!.balls[1].physical.vx = 100;
    else authority.tick = 100;
    expect(view.draw(state, authority).dodge!.balls[1].physical.x).toBe(1000);
  }
});
