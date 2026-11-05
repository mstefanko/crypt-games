import {
  compileExpressivePerformance,
  type PerformanceTakeV3,
} from "@onepage/music-core/expressive-performance";
/** Generated independently of MIDI: one onset with known held pitch, gain and stereo changes. */
export function createExpressiveAudioFixture(): PerformanceTakeV3 {
  return compileExpressivePerformance(
    {
      version: 1,
      kind: "expressive-performance",
      id: "expressive-held-synth-fixture",
      ppq: 480,
      lengthTicks: 3840,
      tempoMap: [{ tick: 0, microsecondsPerBeat: 500000 }],
      meterMap: [{ tick: 0, numerator: 4, denominator: 4 }],
      parts: [
        { id: "lead", name: "Held lead", role: "melody", gain: 0.7, pan: 0 },
      ],
      bindings: [{ id: "tone", kind: "synth", resourceId: "sine" }],
      resources: [
        {
          id: "sine",
          kind: "synth",
          patch: {
            id: "sine",
            name: "Sine fixture",
            waveform: "sine",
            attack: 0.005,
            release: 0.08,
            brightness: 1,
            duty: 0.5,
          },
        },
      ],
      notes: [
        {
          id: "held",
          partId: "lead",
          bindingId: "tone",
          startTick: 96,
          keyReleaseTick: 2880,
          endTick: 2880,
          pitch: 69,
          velocity: 0.8,
          priority: 128,
          optional: false,
        },
      ],
      controls: [
        {
          id: "bend",
          partId: "lead",
          noteId: "held",
          parameter: "pitchCents",
          timeSeconds: 0.6,
          value: 1200,
          rampSeconds: 0.2,
        },
        {
          id: "swell",
          partId: "lead",
          parameter: "expression",
          timeSeconds: 1.4,
          value: 0.25,
          rampSeconds: 0.2,
        },
        {
          id: "pan",
          partId: "lead",
          parameter: "pan",
          timeSeconds: 2.1,
          value: -1,
          rampSeconds: 0.1,
        },
      ],
      instruments: [],
      provenance: {
        source: "generated-acoustic-fixture",
        gainCurve: "cc-square-v1",
        diagnostics: [],
      },
    },
    "expressive-synth-v1",
  );
}
