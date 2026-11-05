import { describe, expect, it } from "vitest";
import { WeatherNarrativeLiveComposer, narrativeRequestFromWeather, type NarrativeLiveSegment } from "./weather-narrative-live";
import { createWeatherState, observeWeather } from "./weather-model";
import { createTempoMap, compileExpressivePerformance, type PerformanceDocumentV1 } from "./expressive-performance";
import { createWeatherNarrativeDocument, type NarrativeDocumentMetadataV1 } from "./weather-narrative";

const clock = (nowSeconds: number, protection = nowSeconds + .1) => ({ nowSeconds, committedThroughSeconds: protection, protectedThroughSeconds: protection });
const meta = (doc: PerformanceDocumentV1) => doc.provenance.weatherNarrative as NarrativeDocumentMetadataV1;
function initial(family: "clear" | "fog" | "rain" | "storm" | "clearing" = "clear", settleSeconds = 0) {
  const composer = new WeatherNarrativeLiveComposer({ seed: 17, initialFamily: family, settleSeconds });
  const segment = composer.plan(clock(0, 0))!;
  composer.admit(segment);
  return { composer, segment };
}
function required(segment: NarrativeLiveSegment | null) { expect(segment).not.toBeNull(); return segment!; }

describe("live narrative observation, planning and actual hearing", () => {
  it("retains the existing sixteen-bar authored cue and deterministic seeds", () => {
    const a = initial("storm"), b = initial("storm");
    expect(a.segment).toEqual(b.segment);
    expect(a.segment.document.notes).toEqual(createWeatherNarrativeDocument({ family: "storm", seed: 17 }).notes);
    expect(meta(a.segment.document).bars).toBe(16);
    expect(a.composer.getSnapshot().heard).toBeNull();
    expect(a.composer.getSnapshot().memory.pending).toHaveLength(0);
    a.composer.advanceHeard(.1);
    expect(a.composer.getSnapshot().heard?.family).toBe("storm");
  });
  it("keeps raw requests separate from stable requests for eight elapsed seconds", () => {
    const { composer } = initial("clear", 8);
    composer.advanceHeard(1);
    composer.observe({ family: "rain", mode: "aeolian", intensity: .8 }, 1);
    expect(composer.getSnapshot().rawRequest.family).toBe("rain");
    expect(composer.getSnapshot().stableRequest.family).toBe("clear");
    expect(composer.plan(clock(8.99))).toBeNull();
    const segment = required(composer.plan(clock(9)));
    expect(segment.family).toBe("rain");
    expect(segment.mode).toBe("aeolian");
    expect(segment.transition?.stableAtSeconds).toBe(9);
    expect(segment.transition?.observedAtSeconds).toBe(1);
    expect(segment.transition?.budgetMet).toBe(true);
    expect(composer.getSnapshot().admitted?.family).toBe("clear");
    composer.admit(segment);
    expect(composer.getSnapshot().admitted?.family).toBe("rain");
    expect(composer.getSnapshot().heard?.family).toBe("clear");
    composer.advanceHeard(segment.startSeconds);
    expect(composer.getSnapshot().heard?.mode).toBe("aeolian");
    expect(composer.getSnapshot().heard?.tempoBpm).toBe(81);
  });
  it("does not promote an oscillating family at a different frame rate", () => {
    const { composer } = initial("clear", 8);
    for (let second = 1; second <= 20; second++) {
      composer.observe({ family: second % 2 ? "rain" : "fog" }, second);
      expect(composer.plan(clock(second))).toBeNull();
    }
    expect(composer.getSnapshot().stableRequest.family).toBe("clear");
  });
  it("uses breath fallback within the actual time and source-bar budgets for slow fog", () => {
    const { composer, segment: fog } = initial("fog");
    composer.advanceHeard(8);
    composer.observe({ family: "rain" }, 8);
    const rain = required(composer.plan(clock(8, 8.2)));
    expect(rain.transition?.strategy).toBe("breath-pickup");
    expect(rain.transition?.responseSeconds).toBeLessThanOrEqual(8);
    expect(rain.startSeconds - rain.replaceFromSeconds).toBeCloseTo(.25);
    expect(rain.startSeconds).toBeLessThan(fog.endSeconds);
    expect(rain.transition?.seam.pitch).toBe("released");
    composer.admit(rain);
    const oldEvent = composer.getSnapshot().memory.admitted.find((e) => e.id.includes(":remember"));
    expect(oldEvent).toBeUndefined();
  });
  it("reports a real deadline miss when protected held-note releases consume the budget", () => {
    const { composer } = initial("rain");
    composer.observe({ family: "storm", urgent: true }, 1);
    const storm = required(composer.plan(clock(1, 3.5)));
    expect(storm.transition?.strategy).toBe("urgent-accent");
    expect(storm.transition?.budgetMet).toBe(false);
    expect(storm.replaceFromSeconds).toBeGreaterThanOrEqual(3.5);
    expect(storm.startSeconds).toBeGreaterThan(3.5);
  });
  it("uses next uncommitted beat for urgent entry, bypassing ordinary settle and dwell", () => {
    const { composer } = initial("clear", 8);
    composer.observe({ family: "storm", urgent: true }, 1);
    const storm = required(composer.plan(clock(1, 1.1)));
    expect(storm.transition?.budgetMet).toBe(true);
    expect(storm.startSeconds).toBeLessThan(2);
    expect(storm.family).toBe("storm");
  });
  it("never re-admits an identical destination on repeated ticks before its future entry", () => {
    const { composer } = initial("clear");
    composer.advanceHeard(8);
    composer.observe({ family: "storm" }, 8);
    const storm = required(composer.plan(clock(8, 8.1)));
    composer.admit(storm);
    for (let now = 8; now < storm.startSeconds - .11; now += .025) {
      composer.observe({ family: "storm" }, now);
      expect(composer.plan(clock(now))).toBeNull();
    }
    expect(composer.getSnapshot().admitted?.revision).toBe(storm.revision);
    expect(composer.getSnapshot().admittedSegments).toBe(2);
  });
  it("cancels a rapid reversal before an uncommitted destination can impose phantom dwell", () => {
    const { composer } = initial("clear");
    composer.advanceHeard(8);
    composer.observe({ family: "storm" }, 8);
    const storm = required(composer.plan(clock(8, 8.1)));
    composer.admit(storm);
    expect(storm.startSeconds).toBeGreaterThan(8.2);
    composer.observe({ family: "clear" }, 8.2);
    const reverted = required(composer.plan(clock(8.2, 8.25)));
    expect(reverted.family).toBe("clear");
    expect(reverted.transition?.edgeId).toBe("clear->clear");
    expect(reverted.startSeconds).toBeLessThan(storm.startSeconds);
    composer.admit(reverted);
    composer.advanceHeard(storm.startSeconds + .1);
    expect(composer.getSnapshot().heard?.family).toBe("clear");
    expect(composer.getSnapshot().memory.pending.some((p) => p.sourceFamily === "storm")).toBe(false);
  });
  it("does not renew on intensity jitter and cannot starve the final authored phrase", () => {
    const { composer, segment } = initial("storm");
    for (let second = 1; second < Math.floor(segment.endSeconds) - 1; second++) {
      composer.advanceHeard(second);
      composer.observe({ family: "storm", intensity: second % 2 ? .1 : .95 }, second);
      expect(composer.plan(clock(second))).toBeNull();
    }
    const next = required(composer.plan(clock(segment.endSeconds - 1)));
    expect(next.startSeconds).toBeCloseTo(segment.endSeconds);
    expect(meta(next.document).seed).toBe(118);
  });
  it("requires two actual phrase observations before modal change and preserves phrase timing", () => {
    const { composer, segment } = initial("rain");
    const phraseSeconds = segment.endSeconds / 4;
    composer.observe({ family: "rain", mode: "aeolian" }, 1);
    composer.advanceHeard(phraseSeconds);
    expect(composer.getSnapshot().modeBoundary?.committed).toBe("dorian");
    expect(composer.plan(clock(phraseSeconds))).toBeNull();
    composer.advanceHeard(phraseSeconds * 2);
    expect(composer.getSnapshot().modeBoundary?.committed).toBe("aeolian");
    const change = required(composer.plan(clock(phraseSeconds * 3 - 1)));
    expect(change.startSeconds).toBeCloseTo(phraseSeconds * 3);
    expect(change.mode).toBe("aeolian");
    expect(meta(change.document).committedMode).toBe("aeolian");
    expect(compileExpressivePerformance(change.document).tempoMap[0].microsecondsPerBeat).toBeCloseTo(60000000 / 81);
  });
  it("continues after a late pump without silently ending the indefinitely adaptive stream", () => {
    const { composer, segment } = initial("fog");
    composer.advanceHeard(segment.endSeconds + .05);
    const next = required(composer.plan(clock(segment.endSeconds + .05)));
    expect(next.startSeconds).toBeGreaterThanOrEqual(segment.endSeconds + .15);
    composer.admit(next);
    expect(composer.getSnapshot().admitted?.family).toBe("fog");
  });
});

describe("live memory is admitted, cancelled and promoted by actual frontier", () => {
  it("never hears a planned or rejected final ending", () => {
    const composer = new WeatherNarrativeLiveComposer({ seed: 1, initialFamily: "storm" });
    const draft = composer.plan(clock(0, 0))!;
    expect(composer.getSnapshot().memory.admitted).toHaveLength(0);
    composer.admit(draft);
    expect(composer.getSnapshot().memory.pending).toHaveLength(0);
    composer.cancelRevision(draft.revision, 0);
    composer.advanceHeard(draft.endSeconds);
    expect(composer.getSnapshot().memory.pending).toHaveLength(0);
    const resumed = required(composer.plan(clock(draft.endSeconds)));
    expect(resumed.revision).toBe(draft.revision + 1);
  });
  it("stores an interrupted actually emitted motif only once its transition cutoff sounds", () => {
    const { composer, segment } = initial("storm");
    composer.advanceHeard(8);
    composer.observe({ family: "clearing" }, 8);
    const clearing = required(composer.plan(clock(8)));
    expect(meta(clearing.document).recall).toBeNull();
    composer.admit(clearing);
    expect(composer.getSnapshot().memory.pending).toHaveLength(0);
    expect(composer.getSnapshot().memory.admitted.some((e) => e.id.endsWith(":interruption"))).toBe(true);
    composer.advanceHeard(clearing.replaceFromSeconds);
    const phrase = composer.getSnapshot().memory.pending[0];
    expect(phrase.sourceFamily).toBe("storm");
    const occurrence = meta(segment.document).signatureOccurrences[0];
    expect(phrase.motifDegrees).toEqual(occurrence.degrees);
    expect(phrase.motifGaps).toEqual(occurrence.onsetPulses.slice(1).map((n, i) => n - occurrence.onsetPulses[i]));
    expect(phrase.status).toBe("interrupted");
    expect(phrase.intendedClosure).toBe("home-return");
    expect(composer.getSnapshot().memory.fulfilled).toBeNull();
    const phraseSeconds = clearing.endSeconds - clearing.startSeconds;
    composer.advanceHeard(clearing.startSeconds + .1);
    const recalled = required(composer.plan(clock(clearing.startSeconds + phraseSeconds / 4 - 1)));
    expect(meta(recalled.document).recall?.phraseId).toBe(phrase.phraseId);
    composer.admit(recalled);
    expect(composer.getSnapshot().memory.fulfilled).toBeNull();
    const resolutionTime = recalled.startSeconds + createTempoMap(recalled.document.ppq, recalled.document.tempoMap).tickToSeconds(meta(recalled.document).recall!.resolutionTick);
    composer.advanceHeard(resolutionTime - .01);
    expect(composer.getSnapshot().memory.fulfilled).toBeNull();
    composer.advanceHeard(resolutionTime);
    expect(composer.getSnapshot().memory.fulfilled?.phraseId).toBe(phrase.phraseId);
  });
  it("cancels the interrupted phrase if the destination cutoff was never heard", () => {
    const { composer } = initial("storm");
    composer.observe({ family: "clearing" }, 8);
    const clearing = required(composer.plan(clock(8)));
    composer.admit(clearing);
    composer.cancelRevision(clearing.revision, 8);
    composer.advanceHeard(clearing.startSeconds + 1);
    expect(composer.getSnapshot().memory.pending).toHaveLength(0);
  });
  it("keeps memory bounded and uses copies for caller-visible snapshots", () => {
    const { composer } = initial("clear");
    for (let second = 8; second <= 240; second += 8) {
      composer.advanceHeard(second);
      composer.observe({ family: second % 16 ? "fog" : "storm", urgent: true }, second);
      const segment = required(composer.plan(clock(second)));
      composer.admit(segment);
    }
    const snapshot = composer.getSnapshot();
    expect(snapshot.memory.pending.length).toBeLessThanOrEqual(4);
    expect(snapshot.memory.admitted.length).toBeLessThanOrEqual(3);
    expect(snapshot.admittedSegments).toBeLessThanOrEqual(3);
    snapshot.rawRequest.family = "rain";
    snapshot.memory.pending.length = 0;
    expect(composer.getSnapshot().rawRequest.family).not.toBe("rain");
  });
  it("validates clocks, families, provenance and quantized acknowledged times", () => {
    const composer = new WeatherNarrativeLiveComposer({ seed: 17 });
    expect(() => composer.observe({ family: "rain", mode: "lydian" }, 0)).toThrow();
    expect(() => composer.plan(clock(NaN))).toThrow();
    const segment = composer.plan(clock(0, 0))!;
    expect(() => composer.admit({ ...segment, family: "rain" })).toThrow(/modified/);
    expect(() => composer.admit(segment, { startSeconds: .1, replaceFromSeconds: 0 })).toThrow(/acknowledgement/);
    composer.admit(segment, { startSeconds: .001, replaceFromSeconds: 0 });
    composer.advanceHeard(1);
    expect(() => composer.advanceHeard(.5)).toThrow(/monotonically/);
    expect(() => composer.observe({ family: "rain" }, .5)).toThrow(/monotone/);
    expect(() => composer.cancelRevision(1, .5)).toThrow(/cancellation/);
  });
});

describe("local weather mapping", () => {
  it("uses local weather independently from manual musical intensity and handles clearing history", () => {
    const weather = observeWeather(createWeatherState(17));
    const dry = { ...weather, stormStrength: 0, convection: 0, precipitation: 0, fog: 0, lightning: false, clearingDuration: 10 };
    expect(narrativeRequestFromWeather({ ...dry, intensity: 1 }).family).toBe("clear");
    expect(narrativeRequestFromWeather({ ...dry, intensity: 0 }, "storm").family).toBe("clearing");
    expect(narrativeRequestFromWeather({ ...dry, clearingDuration: 46 }, "clearing").family).toBe("clear");
    expect(narrativeRequestFromWeather({ ...dry, fog: .5 }).family).toBe("fog");
    expect(narrativeRequestFromWeather({ ...dry, precipitation: .2 }).family).toBe("rain");
    expect(narrativeRequestFromWeather({ ...dry, lightning: true }).urgent).toBe(true);
    expect(narrativeRequestFromWeather({ ...dry, stormStrength: .7 }).mode).toBe("phrygian");
    expect(() => narrativeRequestFromWeather({ ...dry, fog: NaN })).toThrow(/Nonfinite/);
  });
});
