import { describe, expect, it } from "vitest";
import {
  BehaviorEncounterFixture,
  BEHAVIOR_LIMITS,
  BEHAVIOR_DESCRIPTORS,
  createBehaviorActor,
  stepBehavior,
} from "./behavior";

describe("B0 saved typed behavior", () => {
  it("gives the two roles different range, windup and damage behavior", () => {
    const fixture = new BehaviorEncounterFixture();
    for (let tick = 0; tick < 12; tick++)
      fixture.step({ target: 0, threatened: false });
    const state = fixture.capture();
    expect(state.targetHealth).toBeLessThan(1000);
    expect(state.actors.map((actor) => actor.position)).toEqual([-1, 4]);
    expect(state.actors.every((actor) => actor.attacks > 0)).toBe(true);
    expect(state.actors[0].attacks).not.toBe(state.actors[1].attacks);
  });
  it("prioritizes threats over expiring attacks and takes only one transition", () => {
    const actor = {
      ...createBehaviorActor("bruiser"),
      state: "windup" as const,
      timer: 1,
    };
    const result = stepBehavior(actor, { target: -5, threatened: true });
    expect(result.damage).toBe(0);
    expect(result.actor).toMatchObject({
      state: "retreat",
      timer: 2,
      transitions: 1,
      attacks: 0,
    });
    const expired = stepBehavior(
      { ...actor, state: "recover", timer: 1 },
      { target: -5, threatened: false },
    );
    expect(expired.actor.state).toBe("approach");
    expect(expired.actor.transitions).toBe(1);
  });
  it("validates public runner inputs without mutation", () => {
    const actor = createBehaviorActor("bruiser");
    for (const invalid of [
      { ...actor, timer: -1 },
      { ...actor, state: "unknown" },
      { ...actor, role: "unknown" },
      { ...actor, position: 33 },
      { ...actor, attacks: 0.5 },
      { ...actor, transitions: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() =>
        stepBehavior(invalid as any, { target: -5, threatened: true }),
      ).toThrow();
    }
    for (const invalid of [
      { target: 0.5, threatened: false },
      { target: 0, threatened: 1 },
      { target: -0, threatened: false },
      { target: 0, threatened: false, extra: true },
    ]) {
      expect(() => stepBehavior(actor, invalid as any)).toThrow();
    }
    expect(actor).toEqual(createBehaviorActor("bruiser"));
  });
  it.each(["bruiser", "ranger"] as const)(
    "keeps %s retreating through sustained threat, then finishes the timer",
    (role) => {
      let actor = createBehaviorActor(role);
      const duration = BEHAVIOR_DESCRIPTORS[role].retreat;
      for (let tick = 0; tick < 40; tick++) {
        const previous = actor;
        const result = stepBehavior(actor, { target: 0, threatened: true });
        actor = result.actor;
        expect(actor.state).toBe("retreat");
        expect(actor.timer).toBe(duration - (tick % duration));
        expect(Math.abs(actor.position)).toBeGreaterThanOrEqual(
          Math.abs(previous.position),
        );
        expect(actor.transitions).toBe(1);
        expect(result.damage).toBe(0);
      }
      const remaining = actor.timer;
      for (let tick = 1; tick <= remaining; tick++) {
        actor = stepBehavior(actor, { target: 0, threatened: false }).actor;
        expect(actor.state).toBe(tick === remaining ? "approach" : "retreat");
      }
      expect(actor.transitions).toBe(2);
    },
  );
  it.each(["bruiser", "ranger"] as const)(
    "runs %s beyond the fixture counter limits",
    (role) => {
      let actor = createBehaviorActor(role);
      for (let tick = 0; tick < 4096; tick++)
        actor = stepBehavior(actor, { target: 0, threatened: false }).actor;
      expect(actor.attacks).toBeGreaterThan(256);
      expect(actor.transitions).toBeGreaterThan(256);
      let threatened = createBehaviorActor(role);
      for (let tick = 0; tick < 4096; tick++)
        threatened = stepBehavior(threatened, {
          target: 0,
          threatened: tick % (BEHAVIOR_DESCRIPTORS[role].retreat + 1) === 0,
        }).actor;
      expect(threatened.transitions).toBeGreaterThan(256);
    },
  );
  it("saturates diagnostic counters at the safe integer limit without stopping behavior", () => {
    const actor = {
      ...createBehaviorActor("bruiser"),
      state: "windup" as const,
      timer: 1,
      attacks: Number.MAX_SAFE_INTEGER,
      transitions: Number.MAX_SAFE_INTEGER,
    };
    const result = stepBehavior(actor, { target: 0, threatened: false });
    expect(result.damage).toBe(BEHAVIOR_DESCRIPTORS.bruiser.damage);
    expect(result.actor).toMatchObject({
      state: "recover",
      attacks: Number.MAX_SAFE_INTEGER,
      transitions: Number.MAX_SAFE_INTEGER,
    });
    expect(actor.state).toBe("windup");
  });
  it("resumes through an interrupted windup and recovery with no phantom hit", () => {
    const live = new BehaviorEncounterFixture();
    for (let tick = 0; tick < 5; tick++)
      live.step({ target: 0, threatened: false });
    expect(live.capture().actors[0].state).toBe("windup");
    const attacks = live.capture().actors[0].attacks;
    live.step({ target: 0, threatened: true });
    expect(live.capture().actors[0]).toMatchObject({
      state: "retreat",
      attacks,
    });
    const restored = new BehaviorEncounterFixture();
    restored.restore(live.capture());
    for (let tick = 0; tick < 20; tick++)
      expect(restored.step({ target: 0, threatened: false })).toEqual(
        live.step({ target: 0, threatened: false }),
      );
    expect(live.capture().actors[0].attacks).toBeGreaterThan(attacks);
  });
  it("continues exactly from every state/timer boundary", () => {
    const live = new BehaviorEncounterFixture();
    for (let tick = 0; tick < 80; tick++) {
      const restored = new BehaviorEncounterFixture();
      restored.restore(JSON.parse(JSON.stringify(live.capture())));
      const intent = { target: (tick % 11) - 5, threatened: tick % 9 === 0 };
      expect(restored.step(intent)).toEqual(live.step(intent));
      expect(
        live.capture().actors.every((actor) => actor.transitions <= tick + 1),
      ).toBe(true);
    }
  });
  it("rejects forged future state and malformed envelopes without mutation", () => {
    const fixture = new BehaviorEncounterFixture();
    fixture.step({ target: 0, threatened: false });
    const before = fixture.capture();
    for (const edit of [
      (value: any) => {
        value.actors[0].timer++;
      },
      (value: any) => {
        value.actors.reverse();
      },
      (value: any) => {
        value.targetHealth--;
      },
      (value: any) => {
        value.tick++;
      },
      (value: any) => {
        value.extra = true;
      },
      (value: any) => {
        value.inputs[0].target = 0.5;
      },
      (value: any) => {
        value.inputs[0].extra = true;
      },
      (value: any) => {
        value.actors[0].position = -0;
      },
    ]) {
      const value = structuredClone(before);
      edit(value);
      expect(() => fixture.restore(value)).toThrow();
      expect(fixture.capture()).toEqual(before);
    }
    const sparse = { ...before, inputs: new Array(1) };
    expect(() => fixture.restore(sparse)).toThrow();
  });
  it("enforces intake/work caps and detached observations", () => {
    const fixture = new BehaviorEncounterFixture();
    for (let tick = 0; tick < BEHAVIOR_LIMITS.ticks; tick++)
      fixture.step({ target: 32, threatened: true });
    const before = fixture.capture();
    expect(() => fixture.step({ target: 0, threatened: false })).toThrow(/cap/);
    expect(() => fixture.step({ target: 33, threatened: false })).toThrow();
    const restored = new BehaviorEncounterFixture();
    restored.restore(before);
    expect(restored.capture()).toEqual(before);
    expect(fixture.capture()).toEqual(before);
    (before.actors[0] as { timer: number }).timer = 999;
    expect(fixture.capture().actors[0].timer).not.toBe(999);
  });
});
