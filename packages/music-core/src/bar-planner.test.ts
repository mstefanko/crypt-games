import { describe, expect, it } from "vitest";
import { validateScore } from "@onepage/project";
import {
  BAR_TICKS,
  createBarCheckpoint,
  createBarFixtureScore,
  planBar,
  prepareTwoBars,
  revisePreparedBars,
  type WeatherObservation,
} from "./bar-planner";

const warm: WeatherObservation = {
  id: "warm",
  front: "warm",
  intensity: 0.5,
  precipitation: 0.6,
  gustiness: 0.1,
};
const cold: WeatherObservation = { ...warm, id: "cold", front: "cold" };
const policy = { seed: 42 };
describe("bounded weather bar decision spike", () => {
  it("provides an original valid fixture and stable replay without mutating inputs", () => {
    expect(validateScore(createBarFixtureScore()).valid).toBe(true);
    const saved = createBarCheckpoint(42),
      before = structuredClone(saved);
    const a = planBar(saved, warm, policy),
      b = planBar(saved, warm, policy);
    expect(a).toEqual(b);
    expect(saved).toEqual(before);
    expect(a.events.length).toBeLessThanOrEqual(20);
    expect(a.trace.work).toBeLessThanOrEqual(32);
    expect(
      a.events.every(
        (n) =>
          n.startTick >= 0 &&
          n.startTick < BAR_TICKS &&
          n.pitch >= 0 &&
          n.pitch <= 127,
      ),
    ).toBe(true);
  });
  it("changes actual note decisions for equal-intensity front identities", () => {
    const saved = createBarCheckpoint(42);
    const a = planBar(saved, warm, policy),
      b = planBar(saved, cold, policy);
    expect(a.tension.activity).toBe(b.tension.activity);
    expect(
      a.events
        .filter((n) => n.trackId === "melody")
        .map((n) => [n.startTick, n.pitch, n.durationTicks]),
    ).not.toEqual(
      b.events
        .filter((n) => n.trackId === "melody")
        .map((n) => [n.startTick, n.pitch, n.durationTicks]),
    );
    expect(a.arrangement.harmony).not.toBe(b.arrangement.harmony);
  });
  it("uses intensity through the activity plan for bounded dynamics without changing pitches", () => {
    const saved = createBarCheckpoint(42);
    const low = planBar(saved, { ...warm, intensity: 0 }, policy);
    const high = planBar(saved, { ...warm, intensity: 1 }, policy);
    expect(high.events.map((n) => n.velocity)).not.toEqual(
      low.events.map((n) => n.velocity),
    );
    expect(high.events.map(({ velocity: _velocity, ...note }) => note)).toEqual(
      low.events.map(({ velocity: _velocity, ...note }) => note),
    );
    expect(high.events.every((n) => n.velocity >= 0 && n.velocity <= 0.8)).toBe(
      true,
    );
  });
  it("retains history and reproduces a suffix independently of prior execution", () => {
    let state = createBarCheckpoint(42);
    const states = [state],
      events = [];
    for (let bar = 0; bar < 12; bar++) {
      const result = planBar(state, bar % 2 ? cold : warm, policy);
      state = result.checkpoint;
      states.push(state);
      events.push(result.events);
    }
    let resumed = states[6]!;
    for (let bar = 6; bar < 12; bar++) {
      const result = planBar(resumed, bar % 2 ? cold : warm, policy);
      expect(result.events).toEqual(events[bar]);
      resumed = result.checkpoint;
    }
    expect(resumed).toEqual(state);
    const alternate = { ...states[6]!, lastFront: "warm" as const };
    expect(planBar(alternate, warm, policy).tension.slope).toBe("hold");
    expect(planBar(states[6]!, warm, policy).tension.slope).toBe("rise");
    expect(state.recentChoices).toHaveLength(8);
    expect(state.consumedObservations.length).toBeLessThanOrEqual(8);
    expect(state.motif).toEqual(states[0]!.motif);
  });
  it("revises only the requested uncommitted suffix, preserving onset-owned tails", () => {
    const initial = createBarCheckpoint(42);
    const prepared = prepareTwoBars(initial, [warm, warm], policy);
    const copy = structuredClone(prepared);
    const revised = revisePreparedBars(prepared, 1, [cold], policy);
    expect(revised.bars[0]).toEqual(prepared.bars[0]);
    expect(revised.bars[1]).toEqual(
      planBar(prepared.bars[0]!.checkpoint, cold, policy),
    );
    expect(prepared).toEqual(copy);
    const tails = prepared.bars[0]!.events.filter(
      (n) => n.startTick + n.durationTicks > BAR_TICKS,
    );
    expect(tails).toHaveLength(3);
    expect(
      revised.bars[1]!.events.filter((n) => n.trackId === "harmony").map(
        (n) => n.startTick,
      ),
    ).toEqual([BAR_TICKS + 240, BAR_TICKS + 240, BAR_TICKS + 240]);
    expect(revised.bars[1]!.checkpoint.chord).toBe(
      prepared.bars[0]!.checkpoint.chord,
    );
    expect(revised.bars[1]!.trace.heldFromPrevious).toEqual(
      tails.map((n) => n.id),
    );
    expect(() => revisePreparedBars(prepared, -1, [cold], policy)).toThrow();
    expect(() =>
      revisePreparedBars(prepared, 1, [cold, warm], policy),
    ).toThrow();
  });
  it("uses a separate cheap generated fallback and requests resync after two bars", () => {
    const initial = createBarCheckpoint(7);
    const first = planBar(initial, cold, { seed: 7, maxEvents: 0 });
    expect(first.status).toBe("fallback");
    expect(first.events.length).toBeLessThanOrEqual(9);
    expect(first.checkpoint.chord).toBe(initial.chord);
    const second = planBar(first.checkpoint, warm, {
      seed: 7,
      forceFallback: true,
    });
    expect(second.status).toBe("fallback");
    const third = planBar(second.checkpoint, cold, {
      seed: 7,
      forceFallback: true,
    });
    expect(third.status).toBe("resync-required");
    expect(third.events).toEqual([]);
    expect(third.checkpoint).toEqual(second.checkpoint);
    expect(
      planBar(second.checkpoint, warm, { seed: 7 }).checkpoint
        .consecutiveFallbacks,
    ).toBe(0);
  });
  it("reaches tonic every eight normal bars and rejects malformed numeric input", () => {
    let state = createBarCheckpoint(9);
    for (let i = 0; i < 24; i++) {
      const result = planBar(state, cold, { seed: 9 });
      state = result.checkpoint;
      if (i % 8 === 7) expect(state.chord).toBe(0);
    }
    expect(() => planBar(state, { ...warm, intensity: NaN }, policy)).toThrow();
    expect(() => planBar(state, warm, { ...policy, topK: 99 })).toThrow();
    expect(() => prepareTwoBars(state, [warm, warm, warm], policy)).toThrow();
  });
});

it("maintains harmony through all 64 bars without retriggering carried onsets", () => {
  let cp = createBarCheckpoint(42);
  for (let bar = 0; bar < 64; bar++) {
    const next = planBar(
      cp,
      {
        id: "trial",
        front: "cold",
        intensity: 0.6,
        precipitation: 0.6,
        gustiness: 0.5,
      },
      { seed: 42 },
    );
    const harmony = [...cp.tails, ...next.events].filter(
      (n) => n.trackId === "harmony",
    );
    for (
      let tick = bar * BAR_TICKS;
      tick < (bar + 1) * BAR_TICKS - 60;
      tick += 60
    )
      expect(
        harmony.filter(
          (n) => n.startTick <= tick && n.startTick + n.durationTicks > tick,
        ),
      ).toHaveLength(3);
    cp = next.checkpoint;
  }
});
