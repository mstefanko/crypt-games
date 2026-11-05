import { describe, it, expect } from "vitest";
import { WEATHER_TRACKS } from "./orchestration";
const role = (id: string) => WEATHER_TRACKS.find((t) => t.id === id)?.role;
import { BAR_TICKS, BAR_PATCHES } from "./bar-planner";
import {
  createWeatherComposerCheckpoint,
  composeWeatherBar as adaptiveComposeWeatherBar,
  prepareWeatherBars,
  reviseWeatherBars,
  type ComposerWeatherObservation,
} from "./legacy-weather-chamber-6/weather-composer";
const composeWeatherBar: typeof adaptiveComposeWeatherBar = (s, w, p = {}) =>
  adaptiveComposeWeatherBar(s, w, {
    adaptiveTonality: false,
    adaptiveInstruments: false,
    ...p,
  });
const warm: ComposerWeatherObservation = {
  id: "warm",
  front: "warm",
  intensity: 0.5,
  precipitation: 0.6,
  gustiness: 0.1,
  moisture: 0.8,
};
const cold: ComposerWeatherObservation = {
  ...warm,
  id: "cold",
  front: "cold",
  instability: 0.8,
};
describe("weather chamber composer", () => {
  it("reproduces ongoing original pieces without mutating checkpoints or inputs", () => {
    let a = createWeatherComposerCheckpoint(82),
      b = createWeatherComposerCheckpoint(82);
    const motif = [...a.motif];
    for (let i = 0; i < 96; i++) {
      const w = i % 7 < 3 ? warm : cold,
        before = structuredClone(a);
      const x = composeWeatherBar(a, w),
        y = composeWeatherBar(b, w);
      expect(x).toEqual(y);
      expect(a).toEqual(before);
      a = x.checkpoint;
      b = y.checkpoint;
      expect(a.motif).toEqual(motif);
      expect(a.bar - a.lastArrivalBar).toBeLessThanOrEqual(4);
    }
    expect(a.bar).toBe(96);
  });
  it("enforces harmony, voice ranges, bounded work/events, real rests and resolution through reversals", () => {
    let s = createWeatherComposerCheckpoint(12);
    const chords = [
      [0, 4, 7],
      [5, 9, 0],
      [7, 11, 2],
      [9, 0, 4],
    ];
    for (let i = 0; i < 64; i++) {
      const bar = composeWeatherBar(s, i % 2 ? warm : cold);
      expect(bar.events.length).toBeLessThanOrEqual(24);
      expect(bar.trace.work).toBeLessThan(50000);
      expect(bar.trace.rests).toBeGreaterThan(0);
      expect(bar.checkpoint.voices[0]).toBeLessThan(bar.checkpoint.voices[1]!);
      expect(bar.checkpoint.voices[1]).toBeLessThan(bar.checkpoint.voices[2]!);
      for (const n of bar.events) {
        expect(n.startTick).toBeGreaterThanOrEqual(i * BAR_TICKS);
        expect(n.startTick).toBeLessThan((i + 1) * BAR_TICKS);
        expect(n.durationTicks).toBeLessThanOrEqual(2 * BAR_TICKS);
        if (role(n.trackId) === "melody")
          expect(chords[bar.trace.choice]).toContain(n.pitch % 12);
      }
      if (i % 4 === 3) {
        expect(bar.trace.choice).toBe(0);
        expect(bar.trace.resolution).toBe(true);
        expect(bar.checkpoint.obligation).toBeNull();
      }
      s = bar.checkpoint;
    }
    expect(BAR_PATCHES.every((p) => p.release <= 1)).toBe(true);
  });
  it("changes symbolic decisions at matched intensity and retains weather history", () => {
    const s = createWeatherComposerCheckpoint(3),
      a = composeWeatherBar(s, warm),
      b = composeWeatherBar(s, cold);
    expect(a.events).not.toEqual(b.events);
    expect(a.arrangement.harmony).not.toBe(b.arrangement.harmony);
    const showers = composeWeatherBar(s, {
      ...warm,
      precipitationPattern: "showers",
    });
    expect(showers.events).not.toEqual(a.events);
    const afterWarm = composeWeatherBar(a.checkpoint, { ...cold, id: "same" }),
      afterCold = composeWeatherBar(b.checkpoint, { ...cold, id: "same" });
    expect(afterWarm.events).not.toEqual(afterCold.events);
  });
  it("preserves prefix and original cross-boundary onsets on suffix revision", () => {
    const s = createWeatherComposerCheckpoint(7),
      prepared = prepareWeatherBars(s, [warm, warm]);
    const revised = reviseWeatherBars(prepared, 1, [cold]);
    expect(revised.bars[0]).toEqual(prepared.bars[0]);
    expect(revised.bars[1]!.trace.heldFromPrevious).toEqual(
      prepared.bars[0]!.checkpoint.tails.map((n) => n.id),
    );
    const tails = prepared.bars[0]!.checkpoint.tails;
    expect(tails.length).toBe(3);
    expect(
      revised.bars[1]!.events.every((n) => !tails.some((t) => t.id === n.id)),
    ).toBe(true);
    expect(revised.bars[1]!.trace.choice).toBe(0);
    expect(() => reviseWeatherBars(prepared, -1, [cold])).toThrow();
    expect(() => prepareWeatherBars(s, [warm, warm, warm])).toThrow();
  });
  it("resolves dominant in fallback, stops after two and can resume normal planning", () => {
    let s = createWeatherComposerCheckpoint(2);
    for (let i = 0; i < 3; i++) s = composeWeatherBar(s, cold).checkpoint;
    expect(s.obligation).not.toBeNull();
    const first = composeWeatherBar(s, warm, { forceFallback: true });
    expect(first.trace.resolution).toBe(true);
    expect(first.trace.choice).toBe(0);
    const second = composeWeatherBar(first.checkpoint, warm, {
      forceFallback: true,
    });
    const third = composeWeatherBar(second.checkpoint, warm, {
      forceFallback: true,
    });
    expect(third.status).toBe("resync-required");
    expect(third.events).toEqual([]);
    expect(third.checkpoint.bar).toBe(second.checkpoint.bar);
    expect(
      composeWeatherBar(second.checkpoint, warm).checkpoint
        .consecutiveFallbacks,
    ).toBe(0);
  });
  it("retains theme returns and admits transitions only at phrase boundaries with earlier pickups", () => {
    let s = createWeatherComposerCheckpoint(5),
      previous: ReturnType<typeof composeWeatherBar> | undefined;
    for (let i = 0; i < 32; i++) {
      const b = composeWeatherBar(s, cold);
      if (b.trace.transition) {
        expect(i % 4).toBe(0);
        expect(b.trace.transition.leadInTicks).toBe(480);
        expect(
          previous!.events.some(
            (n) =>
              role(n.trackId) === "melody" &&
              n.startTick === i * BAR_TICKS - 480,
          ),
        ).toBe(true);
      }
      if (i % 16 >= 12 && i % 4 !== 3)
        expect(b.trace.transformation).toBe("recall");
      previous = b;
      s = b.checkpoint;
    }
  });
  it("rejects malformed weather and checkpoints", () => {
    const s = createWeatherComposerCheckpoint(1);
    expect(() => composeWeatherBar(s, { ...warm, instability: NaN })).toThrow();
    expect(() => composeWeatherBar({ ...s, bar: -1 }, warm)).toThrow();
    expect(() => composeWeatherBar(s, warm, { maxEvents: 129 })).toThrow();
  });
  it("retains four real front identities, answers interactions, and retires only inactive motifs", () => {
    let s = createWeatherComposerCheckpoint(5);
    const observation = {
      ...cold,
      activeFrontIds: ["front-a", "front-b", "front-c", "front-d"],
      interaction: true,
    };
    for (let i = 0; i < 8; i++)
      s = composeWeatherBar(s, observation).checkpoint;
    const retained = structuredClone(s.frontMotifs);
    expect(retained.map((m) => m.frontId)).toEqual(observation.activeFrontIds);
    expect(new Set(retained.map((m) => JSON.stringify(m.degrees))).size).toBe(
      4,
    );
    const bar = composeWeatherBar(s, observation);
    expect(bar.trace.motifIds).toEqual(["front-a", "front-b"]);
    expect(bar.checkpoint.frontMotifs.map((m) => m.degrees)).toEqual(
      retained.map((m) => m.degrees),
    );
    const interaction = composeWeatherBar(
      composeWeatherBar(bar.checkpoint, observation).checkpoint,
      observation,
    );
    const solo = composeWeatherBar(
      composeWeatherBar(bar.checkpoint, observation).checkpoint,
      { ...observation, interaction: false },
    );
    // Phrase observations are frozen: revising current weather cannot rewrite their motif dependencies.
    expect(interaction.events).toEqual(solo.events);
    s = bar.checkpoint;
    while (s.bar % 4) s = composeWeatherBar(s, observation).checkpoint;
    const changed = composeWeatherBar(s, {
      ...cold,
      activeFrontIds: ["front-b", "front-c", "front-d", "front-e"],
    });
    expect(changed.checkpoint.frontMotifs.map((m) => m.frontId).sort()).toEqual(
      ["front-b", "front-c", "front-d", "front-e"],
    );
    expect(changed.checkpoint.motifHistory.at(-1)).toEqual({
      frontId: "front-a",
      retiredBar: s.bar,
    });
    for (const m of retained.slice(1))
      expect(
        changed.checkpoint.frontMotifs.find((n) => n.frontId === m.frontId)!
          .degrees,
      ).toEqual(m.degrees);
    expect(s.frontMotifs).toEqual(
      retained.map((m) => ({ ...m, lastUsedBar: 8 })),
    );
  });
  it("uses front identity beyond character parity and freezes caller arrays", () => {
    let s = createWeatherComposerCheckpoint(41);
    for (let i = 0; i < 4; i++) s = composeWeatherBar(s, cold).checkpoint;
    const ids = ["front-a"];
    const a = composeWeatherBar(s, { ...cold, activeFrontIds: ids });
    const b = composeWeatherBar(s, { ...cold, frontId: "front-c" });
    expect(a.checkpoint.frontMotifs[0]!.degrees).not.toEqual(
      b.checkpoint.frontMotifs[0]!.degrees,
    );
    expect(a.events.filter((n) => role(n.trackId) === "melody")).not.toEqual(
      b.events.filter((n) => role(n.trackId) === "melody"),
    );
    ids[0] = "mutated";
    expect(a.checkpoint.phraseWeather.activeFrontIds).toEqual(["front-a"]);
  });
  it("defers a transition after a pickup was omitted, then admits a prepared entry", () => {
    let s = createWeatherComposerCheckpoint(9);
    for (let i = 0; i < 3; i++) s = composeWeatherBar(s, cold).checkpoint;
    s = composeWeatherBar(s, cold, { forceFallback: true }).checkpoint;
    const deferred = composeWeatherBar(s, cold);
    expect(deferred.trace.transition).toBeNull();
    expect(deferred.trace.section).toBe("establish");
    s = deferred.checkpoint;
    for (let i = 5; i < 8; i++) s = composeWeatherBar(s, cold).checkpoint;
    expect(composeWeatherBar(s, cold).trace.transition).not.toBeNull();
  });
  it("enforces even tiny fallback budgets without advancing an unschedulable checkpoint", () => {
    const s = createWeatherComposerCheckpoint(1);
    for (const maxEvents of [0, 1, 3]) {
      const bar = composeWeatherBar(s, warm, { maxEvents });
      expect(bar.events.length).toBeLessThanOrEqual(maxEvents);
      expect(bar.status).toBe("resync-required");
      expect(bar.checkpoint).toEqual(s);
    }
    expect(() =>
      composeWeatherBar(s, {
        ...warm,
        activeFrontIds: ["a", "b", "c", "d", "e"],
      }),
    ).toThrow();
    expect(() =>
      composeWeatherBar(s, { ...warm, interaction: Infinity }),
    ).toThrow();
  });
  it("completes sixteen-bar form and protects thematic return across boundary revisions", () => {
    let s = createWeatherComposerCheckpoint(25);
    const sections: string[] = [];
    for (let i = 0; i < 16; i++) {
      const b = composeWeatherBar(s, { ...warm, frontId: "warm-one" });
      sections.push(b.trace.section);
      if (i >= 12) expect(b.trace.motifIds).toEqual(["theme"]);
      if (i % 4 === 3) {
        expect(b.trace.arrival).toBe(true);
        expect(b.trace.choice).toBe(0);
        expect(b.checkpoint.obligation).toBeNull();
      }
      s = b.checkpoint;
    }
    expect(sections).toEqual([
      ...Array(4).fill("establish"),
      ...Array(4).fill("approach"),
      ...Array(4).fill("develop"),
      ...Array(4).fill("return"),
    ]);
    const prepared = prepareWeatherBars(s, [cold, cold]);
    const revised = reviseWeatherBars(prepared, s.bar, [warm, warm]);
    expect(revised.bars[0]!.trace.motifIds).toEqual(["theme"]);
    expect(prepared.checkpoint).toEqual(s);
  });

  it("generates distinct sentence, period and bounded-extension constraints", () => {
    let s = createWeatherComposerCheckpoint(17);
    const bars = [];
    for (let i = 0; i < 16; i++) {
      const b = composeWeatherBar(s, { ...cold, instability: 0 });
      bars.push(b);
      s = b.checkpoint;
    }
    expect(bars[1]!.trace.phraseRole).toBe("repetition");
    expect(bars[5]!.trace.phraseRole).toBe("question-ending");
    expect(bars[6]!.trace.phraseRole).toBe("answer");
    expect(bars[9]!.trace.phraseRole).toBe("extension");
    expect(
      bars[1]!.events.filter((n) => role(n.trackId) === "melody"),
    ).toHaveLength(4);
    expect(
      bars[5]!.events.filter((n) => role(n.trackId) === "melody"),
    ).toHaveLength(2);
    expect(
      bars[9]!.events.filter((n) => role(n.trackId) === "melody"),
    ).toHaveLength(5);
    expect(bars[11]!.trace.arrival).toBe(true);
  });
  it("replaces an uncommitted destination while keeping the generated lead-in immutable", () => {
    let s = createWeatherComposerCheckpoint(6);
    for (let i = 0; i < 3; i++) s = composeWeatherBar(s, cold).checkpoint;
    const prepared = prepareWeatherBars(s, [cold, cold]);
    const revised = reviseWeatherBars(
      prepared,
      4,
      [{ ...warm, instability: 0 }],
      { hold: true },
    );
    expect(revised.bars[0]).toEqual(prepared.bars[0]);
    expect(prepared.bars[1]!.trace.transition!.destination).toBe("peak");
    expect(revised.bars[1]!.trace.transition!.destination).toBe("hold");
    expect(
      revised.bars[1]!.events.some((n) =>
        n.id.startsWith("weather-composer:3:"),
      ),
    ).toBe(false);
  });
  it("enumerates scored candidates with measured work and lets tension change harmony", () => {
    const s = composeWeatherBar(createWeatherComposerCheckpoint(31), {
      ...cold,
      instability: 0,
    }).checkpoint;
    const calm = composeWeatherBar(s, { ...cold, instability: 0 });
    const tense = composeWeatherBar(s, {
      ...cold,
      instability: 1,
      frontPassage: true,
    });
    expect(calm.trace.choice).not.toBe(tense.trace.choice);
    expect(tense.tension.realized).toBeGreaterThan(calm.tension.realized);
    expect(calm.trace.candidateCount).toBe(6);
    for (const bar of [calm, tense]) {
      expect(bar.trace.candidateScores).toHaveLength(bar.trace.candidateCount);
      expect(bar.trace.eligibleCount).toBeGreaterThan(0);
      expect(bar.trace.eligibleCount).toBeLessThanOrEqual(3);
      const selected = bar.trace.candidateScores.find(
        (c) => c.chord === bar.trace.choice,
      )!;
      expect(selected.cost).toBeLessThanOrEqual(
        bar.trace.candidateScores[0]!.cost + 90,
      );
      expect(bar.trace.work).toBeGreaterThan(bar.events.length);
      expect(bar.trace.work).toBeLessThan(50000);
    }
    const arrival = composeWeatherBar(
      composeWeatherBar(calm.checkpoint, cold).checkpoint,
      cold,
    );
    expect(arrival.trace.candidateCount).toBe(2);
    expect(arrival.trace.work).toBeLessThan(calm.trace.work);
    expect(arrival.trace.choice).toBe(0);
  });
  it("makes foreground, headroom and harmony texture audible in actual note dynamics/onsets", () => {
    let s = createWeatherComposerCheckpoint(22);
    for (let i = 0; i < 4; i++) s = composeWeatherBar(s, warm).checkpoint;
    const connected = composeWeatherBar(s, warm);
    const accented = composeWeatherBar(s, cold);
    expect(connected.arrangement.foreground).toBe("harmony");
    expect(accented.arrangement.foreground).toBe("melody");
    expect(
      connected.events.find((n) => role(n.trackId) === "harmony")!.velocity,
    ).toBeGreaterThan(
      connected.events.find((n) => role(n.trackId) === "melody")!.velocity,
    );
    expect(
      accented.events.filter((n) => role(n.trackId) === "harmony"),
    ).toHaveLength(6);
    expect(
      connected.events.filter((n) => role(n.trackId) === "harmony"),
    ).toHaveLength(3);
    const hold = composeWeatherBar(s, warm, { hold: true });
    expect(hold.trace.transition!.rule).toBe("hold");
    expect(hold.arrangement.foreground).toBe("bass");
    expect(hold.events.some((n) => role(n.trackId) === "drums")).toBe(false);
    expect(hold.arrangement.headroom).not.toBe(accented.arrangement.headroom);
  });
  it("uses explicit transition rules with safe tonic entry and retained lead-in", () => {
    let s = createWeatherComposerCheckpoint(15);
    const rules = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const bar = composeWeatherBar(s, { ...warm, instability: 0 });
      if (bar.trace.transition) {
        rules.add(bar.trace.transition.rule);
        expect(bar.trace.transition.entryTick).toBe(i * BAR_TICKS);
        expect(bar.trace.transition.tailPolicy).toBe("preserve");
        expect(bar.trace.choice).toBe(0);
        if (bar.trace.transition.rule === "clear")
          expect(bar.events.some((n) => role(n.trackId) === "drums")).toBe(
            false,
          );
      }
      s = bar.checkpoint;
    }
    expect([...rules].sort()).toEqual(["clear", "connect", "contrast"]);
  });
});

describe("expanded weather orchestration", () => {
  it("spaces fog, articulates chill and animates heat without losing cadence safety", () => {
    const base = {
      ...warm,
      front: "clear" as const,
      precipitation: 0,
      intensity: 0.2,
    };
    const checkpoint = createWeatherComposerCheckpoint(91);
    const plain = composeWeatherBar(checkpoint, base);
    const fog = composeWeatherBar(checkpoint, { ...base, fog: 0.8 });
    const chill = composeWeatherBar(checkpoint, {
      ...base,
      thermalBand: "chilly",
    });
    const heat = composeWeatherBar(checkpoint, { ...base, thermalBand: "hot" });
    expect(fog.arrangement.harmony).toBe("held");
    expect(
      fog.events.filter((n) => role(n.trackId) === "melody").length,
    ).toBeLessThan(
      plain.events.filter((n) => role(n.trackId) === "melody").length,
    );
    expect(
      chill.events
        .filter((n) => role(n.trackId) === "melody")
        .every((n) => n.durationTicks === 120),
    ).toBe(true);
    expect(
      heat.events
        .filter((n) => role(n.trackId) === "melody")
        .map((n) => n.pitch),
    ).not.toEqual(
      plain.events
        .filter((n) => role(n.trackId) === "melody")
        .map((n) => n.pitch),
    );
    expect(() =>
      composeWeatherBar(checkpoint, { ...base, fog: NaN }),
    ).toThrow();
  });
  it("uses storm strength for accented activity while preserving four-bar arrival", () => {
    let s = createWeatherComposerCheckpoint(4);
    for (let i = 0; i < 4; i++) {
      const bar = composeWeatherBar(s, { ...cold, stormStrength: 0.8 });
      expect(bar.arrangement.drums).toBe(i < 2 ? "sparse" : "active");
      s = bar.checkpoint;
      if (i === 3) expect(bar.trace.choice).toBe(0);
    }
  });
});

describe("coordinated weather transitions and featured lead", () => {
  const settled: ComposerWeatherObservation = {
    id: "settled",
    front: "clear",
    intensity: 0,
    precipitation: 0,
    gustiness: 0,
  };
  const storm: ComposerWeatherObservation = {
    ...cold,
    intensity: 1,
    precipitation: 1,
    gustiness: 1,
    stormStrength: 1,
  };
  it("writes a complete common-tone bridge and staggers harmony before melody", () => {
    let state = createWeatherComposerCheckpoint(9);
    state = adaptiveComposeWeatherBar(state, settled).checkpoint;
    const bars = [];
    for (let i = 0; i < 5; i++) {
      const bar = adaptiveComposeWeatherBar(state, storm);
      bars.push(bar);
      state = bar.checkpoint;
    }
    expect(bars[0]!.arrangement.drums).toBe("sparse");
    const bridge = bars.find((b) => b.checkpoint.tonalTransition)!;
    expect(bridge.bar).toBe(4);
    expect(
      bridge.events
        .filter((n) => role(n.trackId) !== "drums")
        .every((n) => [0, 7].includes(n.pitch % 12)),
    ).toBe(true);
    expect(bridge.events.some((n) => n.trackId === "harmony-violin")).toBe(
      true,
    );
    expect(
      bridge.events
        .filter((n) => role(n.trackId) === "melody")
        .map((n) => n.trackId),
    ).toEqual(["melody-flute", "melody-flute"]);
    expect(bars.at(-1)!.events.some((n) => n.trackId === "melody-violin")).toBe(
      true,
    );
    expect(adaptiveComposeWeatherBar(bridge.checkpoint, storm)).toEqual(
      bars.at(-1),
    );
  });
  it("cancels and retargets pending destinations and releases percussion before clear arrival", () => {
    let state = adaptiveComposeWeatherBar(
      createWeatherComposerCheckpoint(8),
      settled,
    ).checkpoint;
    state = adaptiveComposeWeatherBar(state, storm).checkpoint;
    expect(state.pendingMode?.mode).toBe("aeolian");
    state = adaptiveComposeWeatherBar(state, settled).checkpoint;
    expect(state.pendingMode).toBeNull();
    state = adaptiveComposeWeatherBar(state, {
      ...settled,
      fog: 0.8,
    }).checkpoint;
    expect(state.pendingMode?.mode).toBe("dorian");
    for (let i = 0; i < 12; i++)
      state = adaptiveComposeWeatherBar(state, storm).checkpoint;
    const clearing = adaptiveComposeWeatherBar(state, settled);
    expect(clearing.checkpoint.intensity.precipitation).toBe(0.5);
    expect(clearing.checkpoint.intensity.activity).toBeGreaterThan(0.5);
    expect(clearing.checkpoint.tonalContext.mode).toBe("aeolian");
  });
  it("features one shaped playable violin lead after establishment and enforces cooldown", () => {
    let state = createWeatherComposerCheckpoint(72);
    const featured = [];
    for (let i = 0; i < 64; i++) {
      const before = structuredClone(state);
      const bar = adaptiveComposeWeatherBar(state, storm);
      expect(adaptiveComposeWeatherBar(before, storm)).toEqual(bar);
      state = bar.checkpoint;
      if (bar.trace.transformation.startsWith("solo-")) {
        featured.push(bar);
        const lead = bar.events.filter((n) => role(n.trackId) === "melody");
        expect(lead.length).toBe(
          bar.trace.transformation === "solo-answer" ||
            bar.trace.transformation === "solo-climax"
            ? 3
            : 2,
        );
        expect(
          lead.every(
            (n) =>
              n.trackId === "melody-violin" &&
              n.pitch >= 55 &&
              n.pitch <= 79 &&
              n.durationTicks >= 480,
          ),
        ).toBe(true);
        expect(state.pendingMode).toBeNull();
        expect(state.stormBars).toBeGreaterThanOrEqual(8);
      }
    }
    const starts = featured.filter(
      (b) => b.trace.transformation === "solo-statement",
    );
    expect(starts.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < starts.length; i++)
      expect(starts[i]!.bar - starts[i - 1]!.bar).toBeGreaterThanOrEqual(32);
    expect(featured.slice(0, 4).map((b) => b.trace.transformation)).toEqual([
      "solo-statement",
      "solo-answer",
      "solo-climax",
      "solo-resolution",
    ]);
  });
  it("defers bridges under obligations, hold and fallback, and preserves admitted bridges on retarget", () => {
    let state = createWeatherComposerCheckpoint(11);
    for (let i = 0; i < 4; i++)
      state = adaptiveComposeWeatherBar(state, i ? storm : settled).checkpoint;
    expect(state.bar).toBe(4);
    for (const policy of [{ hold: true }, { forceFallback: true }]) {
      const bar = adaptiveComposeWeatherBar(state, storm, policy);
      expect(bar.checkpoint.tonalTransition).toBeNull();
      expect(bar.checkpoint.tonalContext.mode).toBe("ionian");
    }
    const obligated = {
      ...state,
      obligation: {
        kind: "dominant-to-tonic" as const,
        createdBar: 3,
        deadlineBar: 4,
      },
    };
    const resolution = adaptiveComposeWeatherBar(obligated, storm);
    expect(resolution.trace.resolution).toBe(true);
    expect(resolution.checkpoint.tonalTransition).toBeNull();
    const bridge = adaptiveComposeWeatherBar(state, storm);
    const protectedNotes = structuredClone(bridge.events);
    const reversed = adaptiveComposeWeatherBar(bridge.checkpoint, settled);
    expect(reversed.checkpoint.tonalContext.mode).toBe("aeolian");
    expect(reversed.checkpoint.pendingMode?.mode).toBe("ionian");
    expect(bridge.events).toEqual(protectedNotes);
  });
  it("keeps solo notes playable for all twelve tonics and cancels explicit disabling", () => {
    for (let tonic = 0; tonic < 12; tonic++) {
      let state = createWeatherComposerCheckpoint(6);
      const phrases = [];
      for (let i = 0; i < 28; i++) {
        const bar = adaptiveComposeWeatherBar(state, storm, { tonic });
        state = bar.checkpoint;
        if (!bar.trace.transformation.startsWith("solo-")) continue;
        const lead = bar.events.filter((n) => role(n.trackId) === "melody");
        expect(
          lead.every(
            (n) =>
              n.pitch >= 55 &&
              n.pitch <= 79 &&
              n.durationTicks >= 480 &&
              n.durationTicks <= 1200,
          ),
        ).toBe(true);
        phrases.push(lead);
        if (bar.trace.transformation === "solo-statement") {
          expect(
            adaptiveComposeWeatherBar(state, storm, {
              tonic,
              featuredEpisodes: false,
            }).checkpoint.featuredEpisode,
          ).toBeNull();
          expect(
            adaptiveComposeWeatherBar(state, storm, { tonic, hold: true })
              .checkpoint.featuredEpisode,
          ).toBeNull();
          expect(
            adaptiveComposeWeatherBar(state, storm, {
              tonic,
              forceFallback: true,
            }).checkpoint.featuredEpisode,
          ).toBeNull();
        }
        if (bar.trace.transformation === "solo-resolution")
          expect(lead.at(-1)!.pitch % 12).toBe(tonic);
      }
      expect(phrases).toHaveLength(4);
      expect(phrases[0]!.map((n) => n.durationTicks)).not.toEqual(
        phrases[1]!.map((n) => n.durationTicks),
      );
      expect(
        Math.max(...phrases[2]!.map((n) => n.pitch)),
      ).toBeGreaterThanOrEqual(Math.max(...phrases[0]!.map((n) => n.pitch)));
    }
  });
});
