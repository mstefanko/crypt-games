import { describe, expect, it } from "vitest";
import { CueDeliveryGuard, CUE_DELIVERY_LIMITS } from "./cues";
import { TimedEncounterFixture } from "@onepage/game-simulation/timed-fixture";
import type { RulesCue } from "@onepage/game-simulation/time-policy";

const cue = (
  sequence: number,
  runEpoch = 0,
  runId = "cue-proof",
): RulesCue => ({
  runId,
  runEpoch,
  sequence,
  tick: sequence * 3,
  kind: "reward",
});
const config = {
  runId: "timed-cues",
  runEpoch: 2,
  seeds: { encounter: 0, loot: 0 },
};

describe("M8a presentation cue delivery epochs and at-most-once attempts", () => {
  it("consumes cues from actual committed fixture outcomes and suppresses rewind duplicates without changing rewards", () => {
    const fixture = new TimedEncounterFixture(config),
      guard = new CueDeliveryGuard();
    const initial = fixture.capture();
    fixture.command({
      revision: 0,
      runEpoch: 2,
      kind: "order",
      action: "scout",
    });
    fixture.command({
      revision: 1,
      runEpoch: 2,
      kind: "order",
      action: "claim",
    });
    const effects: string[] = [];
    for (let tick = 0; tick < 6; tick++)
      for (const cue of fixture.step().emitted)
        expect(guard.deliver(cue, 0, (_, id) => effects.push(id))).toBe(
          "delivered",
        );
    const final = fixture.capture();
    expect(final.state.loot.coins).toBe(4);
    expect(effects).toEqual(["timed-cues:2:1", "timed-cues:2:2"]);
    const replayEpoch = guard.beginSession("resimulate");
    fixture.restore(initial);
    for (const operation of final.operations) {
      if (operation.kind === "command") fixture.command(operation.command);
      else
        for (const cue of fixture.step().emitted)
          expect(
            guard.deliver(cue, replayEpoch, (_, id) => effects.push(id)),
          ).toBe("duplicate");
    }
    expect(fixture.capture()).toEqual(final);
    expect(effects).toHaveLength(2);
    const liveEpoch = guard.beginSession("live");
    for (const cue of fixture.observe().cues)
      expect(guard.deliver(cue, liveEpoch, (_, id) => effects.push(id))).toBe(
        "duplicate",
      );
    expect(effects).toHaveLength(2);
  });

  it.each(["replay", "resimulate"] as const)(
    "suppresses new %s observations without consuming unseen live effects",
    (mode) => {
      const guard = new CueDeliveryGuard(),
        calls: string[] = [];
      const epoch = guard.beginSession(mode);
      expect(guard.deliver(cue(1), epoch, (_, id) => calls.push(id))).toBe(
        "suppressed",
      );
      const live = guard.beginSession("live");
      expect(guard.deliver(cue(1), live, (_, id) => calls.push(id))).toBe(
        "delivered",
      );
      expect(guard.deliver(cue(2), live, (_, id) => calls.push(id))).toBe(
        "delivered",
      );
      expect(calls).toEqual(["cue-proof:0:1", "cue-proof:0:2"]);
    },
  );

  it("invalidates stale session work without consuming current cue identity", () => {
    const guard = new CueDeliveryGuard(),
      before = guard.inspect();
    const live = guard.beginSession("live");
    expect(live).not.toBe(before.epoch);
    const current = guard.inspect();
    expect(
      guard.deliver(cue(1), 0, () => {
        throw Error("must not run");
      }),
    ).toBe("stale");
    expect(guard.inspect()).toEqual(current);
    expect(guard.deliver(cue(1), live, () => {})).toBe("delivered");
  });

  it("never re-emits an evicted old cue or an out-of-order skipped sequence", () => {
    const guard = new CueDeliveryGuard();
    for (let sequence = 1; sequence <= 100; sequence++)
      expect(guard.deliver(cue(sequence), 0, () => {})).toBe("delivered");
    expect(guard.inspect().recent).toHaveLength(CUE_DELIVERY_LIMITS.recent);
    expect(guard.inspect().recent).not.toContain("cue-proof:0:1");
    expect(
      guard.deliver(cue(1), 0, () => {
        throw Error("evicted cue must not run");
      }),
    ).toBe("duplicate");
    expect(guard.deliver(cue(105), 0, () => {})).toBe("delivered");
    expect(
      guard.deliver(cue(103), 0, () => {
        throw Error("skipped old cue must not run");
      }),
    ).toBe("duplicate");
  });

  it("keeps run epochs distinct and refuses new runs at its cap without evicting protection", () => {
    const guard = new CueDeliveryGuard();
    for (let runEpoch = 0; runEpoch < CUE_DELIVERY_LIMITS.runs; runEpoch++)
      expect(guard.deliver(cue(1, runEpoch), 0, () => {})).toBe("delivered");
    const before = guard.inspect();
    expect(
      guard.deliver(cue(1, 16), 0, () => {
        throw Error("must not deliver");
      }),
    ).toBe("capacity");
    expect(guard.inspect()).toEqual(before);
    expect(
      guard.deliver(cue(1, 0), 0, () => {
        throw Error("old run must not run");
      }),
    ).toBe("duplicate");
    expect(guard.deliver(cue(2, 0), 0, () => {})).toBe("delivered");
  });

  it("marks identity before callback failure, so retry cannot duplicate effects or rerun rules rewards", () => {
    const fixture = new TimedEncounterFixture(config),
      guard = new CueDeliveryGuard();
    fixture.command({
      revision: 0,
      runEpoch: 2,
      kind: "order",
      action: "scout",
    });
    fixture.command({
      revision: 1,
      runEpoch: 2,
      kind: "order",
      action: "claim",
    });
    for (let tick = 0; tick < 6; tick++) fixture.step();
    const before = fixture.capture(),
      reward = before.state.cues[1];
    let calls = 0;
    expect(() =>
      guard.deliver(reward, 0, () => {
        calls++;
        throw Error("audio/device unavailable");
      }),
    ).toThrow(/unavailable/);
    expect(
      guard.deliver(reward, 0, () => {
        calls++;
      }),
    ).toBe("duplicate");
    expect(calls).toBe(1);
    expect(fixture.capture()).toEqual(before);
    expect(fixture.observe().loot.coins).toBe(4);
  });

  it("rejects invalid headers, epochs, modes and callbacks atomically and detaches inspection", () => {
    const guard = new CueDeliveryGuard(),
      before = guard.inspect();
    for (const patch of [
      { sequence: 0 },
      { tick: NaN },
      { runEpoch: -1 },
      { kind: "unknown" },
      { extra: 1 },
    ]) {
      expect(() =>
        guard.deliver({ ...cue(1), ...patch } as RulesCue, 0, () => {}),
      ).toThrow();
      expect(guard.inspect()).toEqual(before);
    }
    expect(() => guard.deliver(cue(1), NaN, () => {})).toThrow();
    expect(() => guard.deliver(cue(1), 0, undefined as never)).toThrow();
    expect(() => guard.beginSession("unknown" as never)).toThrow();
    expect(guard.inspect()).toEqual(before);
    guard.deliver(cue(1), 0, () => {});
    const detached = guard.inspect() as unknown as {
      recent: string[];
      runs: { highwater: number }[];
    };
    detached.recent.length = 0;
    detached.runs[0].highwater = 0;
    expect(guard.inspect()).toMatchObject({
      recent: ["cue-proof:0:1"],
      runs: [{ highwater: 1 }],
    });
  });
});
