import { describe, it, expect } from "vitest";
import { createCryptballSession, createInitialState } from "../sim/session";
import { admitAction, finishActions } from "../sim/actions";
import { admitHockeyAction } from "../sim/modes/cryptcheck/actions";
import type { CommandOrigin, SportId } from "../sim/contract";
const origin: CommandOrigin = {
  epoch: 1,
  generation: 2,
  participantId: "human",
  seq: 7,
};
describe("deterministic cosmetic origins", () => {
  for (const sportId of [
    "cryptball",
    "cryptkick",
    "rift-volley",
    "cryptcheck",
  ] as SportId[]) {
    it(`preserves buffered origin through checkpoint and delayed admission in ${sportId}`, () => {
      const state = createInitialState(undefined, undefined, sportId),
        p = state.players[0];
      state.phase = "play";
      const admit = sportId === "cryptcheck" ? admitHockeyAction : admitAction;
      admit(state, p, { pass: true, origin: { ...origin, seq: 6 } });
      expect(p.action).not.toBeNull();
      p.action!.elapsed =
        p.action!.timing.tell +
        p.action!.timing.active +
        p.action!.timing.recover -
        1;
      admit(state, p, { pass: true, origin });
      expect(p.buffer?.origin).toEqual(origin);
      origin.seq = 8;
      expect(p.buffer?.origin?.seq).toBe(7);
      origin.seq = 7;
      state.events = [];
      const session = createCryptballSession({ sportId });
      session.restore({ ...session.capture(), state });
      const restored = session.capture().state,
        q = restored.players[0];
      expect(q.buffer?.origin).toEqual(origin);
      finishActions(restored);
      restored.tick++;
      admit(restored, q, {});
      expect(q.action?.origin).toEqual(origin);
      expect(restored.events.find((e) => e.type === "swing")?.origin).toEqual({
        ...origin,
        eventKind: "swing",
        ordinal: 0,
      });
    });
  }
  it("expires a buffered intention without claiming admission", () => {
    const state = createInitialState(),
      p = state.players[0];
    p.buffer = { kind: "pass", charge: 0, until: 0, origin };
    state.tick = 1;
    admitAction(state, p, {});
    expect(p.buffer).toBeNull();
    expect(state.events).toEqual([]);
  });
  it("retains origin on hockey check admission", () => {
    const state = createInitialState(undefined, undefined, "cryptcheck");
    state.phase = "play";
    admitHockeyAction(state, state.players[0], { check: true, origin });
    expect(state.events.find((e) => e.type === "check-start")?.origin).toEqual({
      ...origin,
      eventKind: "check-start",
      ordinal: 0,
    });
  });
  it("validates metadata atomically", () => {
    const session = createCryptballSession(),
      cp = session.capture();
    cp.state.players[0].motionOrigin = { ...origin, seq: NaN };
    expect(() => session.restore(cp)).toThrow();
    expect(session.capture().state.players[0].motionOrigin).toBeUndefined();
  });
});

it("rejects special admission and restores hockey checks with optional origins", () => {
  const session = createCryptballSession({ sportId: "cryptcheck" });
  const cp = session.capture();
  cp.state.phase = "play";
  const state = cp.state;
  state.specials[0].cooldownTicks = 0;
  admitHockeyAction(state, state.players[0], { special: true, origin });
  cp.state.events = [];
  session.restore(cp);
  expect(session.capture().state.specials[0].active).toBeNull();
  const check = session.capture();
  check.state.specials[0].active = null;
  check.state.players[0].actionReady = 0;
  admitHockeyAction(check.state, check.state.players[0], {
    check: true,
    origin,
  });
  check.state.events = [];
  session.restore(check);
  expect(
    session.capture().state.hockey!.skaters["player-0"].check?.origin,
  ).toEqual(origin);
});
