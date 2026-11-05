import { describe, expect, it } from "vitest";
import {
  compileExpressivePerformance,
  evaluateExpression,
  parsePerformanceTakeV3,
  serializePerformanceTakeV3,
} from "./expressive-performance";
import {
  composeWeatherBar,
  createWeatherComposerCheckpoint,
} from "./weather-composer";
import {
  createWeatherContinuousExpressionState,
  createWeatherExpressionCheckpoint,
  DEFAULT_WEATHER_EXPRESSION,
  expressWeatherNotes,
  observeWeatherExpression,
  weatherExpressionComparison,
  weatherExpressionDocument,
  weatherExpressionNotes,
} from "./weather-expression";
import type { PerformanceNote } from "./performance";
const observation = {
  id: "cold-front",
  front: "cold" as const,
  intensity: 0.6,
  precipitation: 0.5,
  gustiness: 0.8,
  stormStrength: 0.6,
  instability: 0.4,
};
const held = (id: string, trackId = "melody-flute"): PerformanceNote => ({
  id,
  trackId,
  patchId:
    trackId === "bass-foundation"
      ? "weather-low-foundation-v1"
      : "weather-flute",
  startTick: 0,
  durationTicks: 1920,
  pitch: 72,
  velocity: 0.6,
  gain: 0.3,
  pan: 0,
  priority: 10,
  optional: false,
});
describe("weather-song-3 additive expression policy", () => {
  it("adds a held-note linear gain envelope and small eligible scoop without bass controls", () => {
    const notes = [held("lead"), held("low", "bass-foundation")];
    const original = structuredClone(notes);
    const result = expressWeatherNotes(
      notes,
      observation,
      0,
      createWeatherExpressionCheckpoint(617),
    );
    expect(notes).toEqual(original);
    expect(
      result.controls.find((c) => c.parameter === "pitchCents")!.value,
    ).toBeCloseTo(-55);
    expect(
      result.controls.filter((c) => c.parameter === "pitchCents").at(-1)!.value,
    ).toBe(0);
    expect(result.controls.every((c) => c.partId !== "bass-foundation")).toBe(
      true,
    );
    const document = weatherExpressionDocument("held-front", 1920);
    document.notes = weatherExpressionNotes(notes);
    document.controls = result.controls;
    const take = compileExpressivePerformance(document);
    expect(
      evaluateExpression(take, take.notes[0]!, 0.9).expression,
    ).toBeGreaterThan(evaluateExpression(take, take.notes[0]!, 0).expression);
    expect(
      evaluateExpression(take, take.notes.find((n) => n.id === "low")!, 0.1)
        .pitchCents,
    ).toBe(0);
    expect(parsePerformanceTakeV3(serializePerformanceTakeV3(take))).toEqual(
      take,
    );
  });
  it("bypasses expression and preserves note generation/RNG exactly", () => {
    const pair = weatherExpressionComparison(617);
    expect(pair.documents[0].notes).toEqual(pair.documents[1].notes);
    expect(pair.documents[0].controls).toEqual([]);
    expect(pair.documents[1].controls.length).toBeGreaterThan(0);
    expect(weatherExpressionComparison(617)).toEqual(pair);
    const checkpoint = createWeatherComposerCheckpoint(617);
    const before = structuredClone(checkpoint);
    const song = composeWeatherBar(checkpoint, observation);
    expressWeatherNotes(
      song.events,
      observation,
      0,
      createWeatherExpressionCheckpoint(617),
    );
    expect(composeWeatherBar(checkpoint, observation)).toEqual(song);
    expect(checkpoint).toEqual(before);
  });
  it("retains independent expression checkpoint and onset references after renamed revisions", () => {
    const saved = createWeatherExpressionCheckpoint(617);
    const first = expressWeatherNotes([held("lead:r2")], observation, 0, saved);
    expect(first.controls.every((c) => c.noteId === "lead:r2")).toBe(true);
    expect(saved.lastGestureBar).toBe(-2);
    expect(
      expressWeatherNotes(
        [held("next")],
        observation,
        1,
        first.checkpoint,
      ).controls.some((c) => c.parameter === "pitchCents"),
    ).toBe(false);
    expect(
      expressWeatherNotes([held("lead:r2")], observation, 0, saved),
    ).toEqual(first);
    expect(
      expressWeatherNotes([held("lead")], observation, 0, saved, {
        ...DEFAULT_WEATHER_EXPRESSION,
        enabled: false,
      }).controls,
    ).toEqual([]);
  });
  it("bounds continuous observations at 10Hz, coalesces lanes, leaves low foundation stable", () => {
    let state = createWeatherContinuousExpressionState();
    const admitted = [];
    let previousObservation = -1;
    for (let i = 0; i < 300; i++) {
      const at = i / 100;
      const next = observeWeatherExpression(state, observation, at);
      if (next.state !== state) {
        expect(at - previousObservation).toBeGreaterThanOrEqual(0.1 - 1e-8);
        previousObservation = at;
      }
      state = next.state;
      admitted.push(...next.controls);
    }
    expect(admitted.length).toBeLessThanOrEqual(120);
    expect(admitted.length).toBeGreaterThan(0);
    expect(
      admitted.every(
        (c) =>
          c.parameter === "expression" &&
          !c.partId.startsWith("bass") &&
          c.rampSeconds === 1,
      ),
    ).toBe(true);
    expect(
      observeWeatherExpression(
        state,
        observation,
        state.lastSampleSeconds + 0.01,
      ).controls,
    ).toEqual([]);
  });
  it("frozen documents contain every synth resource and self-contained patch", () => {
    const pair = weatherExpressionComparison(7, 4);
    for (const document of pair.documents) {
      expect(
        document.bindings.find((b) => b.id === "weather-flute")?.gmProgram,
      ).toBe(73);
      expect(
        document.bindings.find((b) => b.id === "weather-snare")?.drum,
      ).toBe(true);
      expect(
        document.bindings.find((b) => b.id === "weather-low-foundation-v1")
          ?.gmProgram,
      ).toBeUndefined();
      expect(() => compileExpressivePerformance(document)).not.toThrow();
      expect(
        document.bindings.every((b) =>
          document.resources.some(
            (r) => r.id === b.resourceId && r.patch?.id === b.patchId,
          ),
        ),
      ).toBe(true);
      expect(
        document.parts
          .filter((p) => p.role === "bass")
          .every((p) => p.pan === 0),
      ).toBe(true);
    }
  });
});
