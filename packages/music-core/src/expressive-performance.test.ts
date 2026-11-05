import { createBlankScore } from "@onepage/project";
import { describe, it, expect } from "vitest";
import {
  assertPerformanceDocument,
  assertPerformanceTakeV3,
  compileExpressivePerformance,
  createTempoMap,
  createExpressionEvaluator,
  evaluateExpression,
  evaluateExpressionLane,
  midiControllerGain,
  scoreToExpressiveDocument,
  commonExpressivePpq,
  rescaleExpressiveDocument,
  expressiveTakeToDocument,
  parsePerformanceTakeV3,
  serializePerformanceTakeV3,
  type PerformanceDocumentV1,
  type ExpressiveControlEvent,
} from "./expressive-performance";
function document(): PerformanceDocumentV1 {
  return {
    version: 1,
    kind: "expressive-performance",
    id: "phrase",
    ppq: 480,
    lengthTicks: 1920,
    tempoMap: [{ tick: 0, microsecondsPerBeat: 500000 }],
    meterMap: [{ tick: 0, numerator: 4, denominator: 4 }],
    parts: [{ id: "lead", name: "Lead", role: "melody", gain: 0.8, pan: -0.2 }],
    bindings: [{ id: "synth", kind: "synth" }],
    resources: [],
    notes: [
      {
        id: "held",
        partId: "lead",
        bindingId: "synth",
        startTick: 0,
        keyReleaseTick: 1440,
        endTick: 1920,
        pitch: 60,
        velocity: 0.75,
        priority: 128,
        optional: false,
      },
    ],
    controls: [],
    instruments: [],
    provenance: { gainCurve: "cc-square-v1", diagnostics: [] },
  };
}
const c = (
  id: string,
  parameter: ExpressiveControlEvent["parameter"],
  timeSeconds: number,
  value: number,
  rampSeconds = 0,
  noteId?: string,
): ExpressiveControlEvent => ({
  id,
  partId: "lead",
  parameter,
  timeSeconds,
  value,
  rampSeconds,
  noteId,
});
describe("expressive performance core", () => {
  it("maps source PPQ and piecewise tempos continuously without tick rounding", () => {
    const map = createTempoMap(96, [
      { tick: 0, microsecondsPerBeat: 500000 },
      { tick: 96, microsecondsPerBeat: 1000000 },
    ]);
    expect(map.tickToSeconds(48)).toBe(0.25);
    expect(map.tickToSeconds(192)).toBe(1.5);
    expect(map.secondsToTick(0.501)).toBeCloseTo(96.096, 10);
    for (const tick of [0, 0.2, 48, 95.99, 96, 192, 999])
      expect(map.secondsToTick(map.tickToSeconds(tick))).toBeCloseTo(tick, 8);
    expect(() =>
      createTempoMap(480, [{ tick: 4, microsecondsPerBeat: 500000 }]),
    ).toThrow();
  });
  it("composes note+part pitch, independent linear gains and absolute note pan once", () => {
    const d = document();
    d.controls = [
      c("v", "volume", 0, 0.5),
      c("e", "expression", 0, 0.4),
      c("np", "pitchCents", 0, 25, 0, "held"),
      c("p", "pitchCents", 0, 100),
      c("nv", "volume", 0, 0.6, 0, "held"),
      c("pan", "pan", 0, 0.7, 0, "held"),
    ];
    const take = compileExpressivePerformance(d),
      state = evaluateExpression(take, take.notes[0], 1);
    expect(state.pitchCents).toBe(125);
    expect(state.gain).toBeCloseTo(0.8 * 0.5 * 0.4 * 0.6);
    expect(state.pan).toBe(0.7);
    expect(midiControllerGain(64)).toBeCloseTo((64 / 127) ** 2);
  });
  it("retargets ramps from effective interpolated state and preserves off-grid times in serialization", () => {
    const d = document();
    d.controls = [
      c("up", "expression", 0, 0, 0),
      c("ramp", "expression", 0.01, 1, 1),
      c("retarget", "expression", 0.51, 0, 0.5),
    ];
    const t = compileExpressivePerformance(d);
    expect(evaluateExpression(t, t.notes[0], 0.51).expression).toBeCloseTo(0.5);
    expect(evaluateExpression(t, t.notes[0], 0.76).expression).toBeCloseTo(
      0.25,
    );
    expect(
      evaluateExpressionLane(t.controls, "expression", 0.76, 1).value,
    ).toBeCloseTo(0.25);
    const frozen = parsePerformanceTakeV3(serializePerformanceTakeV3(t));
    expect(frozen.controls[2].timeSeconds).toBe(0.51);
    expect(frozen.controls[2].rampSeconds).toBe(0.5);
    expect(frozen.notes[0].endSeconds).toBe(2);
    d.notes[0].pitch = 99;
    expect(frozen.notes[0].pitch).toBe(60);
  });
  it("prepared expression evaluator agrees across interrupted ramps and equal time order", () => {
    const d = document();
    d.controls = [
      { ...c("z", "pitchCents", 0, 50), order: 0 },
      { ...c("a", "pitchCents", 0, 100), order: 1 },
      c("ramp", "volume", 0, 0.2, 1),
      c("replace", "volume", 0.25, 0.8, 0.5),
      c("note", "volume", 0.1, 0.3, 0.7, "held"),
    ];
    const t = compileExpressivePerformance(d),
      read = createExpressionEvaluator(t, t.notes[0]);
    for (const at of [0, 0.1, 0.25, 0.3, 0.75, 1]) {
      expect(read(at).volume).toBeCloseTo(
        evaluateExpressionLane(
          t.controls.filter((c) => !c.noteId),
          "volume",
          at,
          1,
        ).value *
          evaluateExpressionLane(
            t.controls.filter((c) => c.noteId),
            "volume",
            at,
            1,
          ).value,
      );
      expect(read(at).pitchCents).toBe(100);
    }
  });
  it("rejects invalid references, NaNs, inconsistent compiled time and excessive events", () => {
    const d = document();
    d.controls = [c("bad", "volume", 0, NaN)];
    expect(() => assertPerformanceDocument(d)).toThrow();
    d.controls = [c("bad", "volume", 0, 1, 0, "unknown")];
    expect(() => assertPerformanceDocument(d)).toThrow(/scope/);
    d.controls = [];
    const take = compileExpressivePerformance(d);
    take.notes[0].endSeconds = 3;
    expect(() => assertPerformanceTakeV3(take)).toThrow(/compiled/);
    const bad = structuredClone(d);
    bad.parts = null as never;
    expect(() => assertPerformanceDocument(bad)).toThrow();
    d.controls = Array.from({ length: 65537 }, (_, i) =>
      c(`${i}`, "volume", 0, 1),
    );
    expect(() => assertPerformanceDocument(d)).toThrow(/limit/);
  });
  it("requires one exact bounded PPQ or explicit quantization when combining sources", () => {
    expect(commonExpressivePpq([96, 480, 1000])).toBe(12000);
    expect(() => commonExpressivePpq([32749, 32719])).toThrow(/quantization/);
    const d = document();
    const exact = rescaleExpressiveDocument(d, 96);
    expect(exact.document.notes[0].endTick).toBe(384);
    expect(exact.warnings).toEqual([]);
    d.notes[0].startTick = 1;
    expect(() => rescaleExpressiveDocument(d, 96)).toThrow(/quantization/);
    const rounded = rescaleExpressiveDocument(d, 96, "nearest");
    expect(rounded.document.notes[0].startTick).toBe(0);
    expect(rounded.warnings).toHaveLength(1);
    expect(expressiveTakeToDocument(compileExpressivePerformance(d))).toEqual(
      d,
    );
  });
  it("bridges Score v1 notes, exact BPM, mix and self-contained synth patches without changing authoring metadata", () => {
    const score = createBlankScore("Score bridge");
    score.bpm = 123;
    score.patterns[0].notes = [
      {
        id: "source-note",
        startTick: 120,
        durationTicks: 1080,
        pitch: 67,
        velocity: 0.6,
      },
    ];
    score.tracks[0].pan = 0.4;
    const d = scoreToExpressiveDocument(score),
      t = compileExpressivePerformance(d);
    expect(t.notes[0]).toMatchObject({
      startTick: 120,
      endTick: 1200,
      pitch: 67,
      velocity: 0.6,
      startSeconds: (120 * 60) / (480 * 123),
    });
    expect(t.parts[0]).toMatchObject({ gain: score.tracks[0].gain, pan: 0.4 });
    expect(t.resources[0].patch).toEqual(score.patches[0]);
    expect(t.provenance.scoreV1).toEqual(score);
    score.patches[0].brightness = 0;
    expect(t.resources[0].patch!.brightness).toBe(0.55);
  });
});

it("expression evaluator can reuse output storage without mutating previous default results", () => {
  const authored = document();
  authored.controls = [c("reuse-ramp", "expression", 0.5, 0.25, 0.5)];
  const take = compileExpressivePerformance(authored, "test");
  const evaluate = createExpressionEvaluator(take, take.notes[0]);
  const first = evaluate(0), snapshot = { ...first };
  const storage = evaluate(0);
  expect(evaluate(1, storage)).toBe(storage);
  expect(storage).toEqual(evaluate(1));
  expect(first).toEqual(snapshot);
});
