import { WEATHER_SONG_PATCHES, WEATHER_SONG_TRACKS } from "./orchestration";
import { assertPlayableScore } from "./score-validation";
import { describe, expect, it } from "vitest";
import { createBlankScore } from "@onepage/project";
import { compileScore } from "./runtime";
import {
  assertPerformanceTake,
  parsePerformanceTake,
  performanceToScore,
  roleGainAt,
  serializePerformanceTake,
  type PerformanceTake,
} from "./performance";

function fixture(): PerformanceTake {
  const base = createBlankScore();
  const track = base.tracks[0];
  return {
    version: 1,
    id: "take",
    bpm: 120,
    ppq: 480,
    lengthTicks: 7680,
    tracks: [track],
    patches: base.patches,
    notes: [
      {
        id: "held",
        trackId: track.id,
        patchId: track.patchId,
        startTick: 1440,
        durationTicks: 2880,
        pitch: 60,
        velocity: 0.6,
        gain: track.gain,
        pan: track.pan,
        priority: 100,
        optional: false,
      },
    ],
    automation: [],
    deviations: [],
  };
}
describe("performance capture", () => {
  it("keeps a cross-bar onset once through save/reopen/Score compilation", () => {
    const t = fixture();
    const restored = parsePerformanceTake(serializePerformanceTake(t));
    expect(restored).toEqual(t);
    const result = performanceToScore(restored);
    const notes = compileScore(result.score);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      startTick: 1440,
      durationTicks: 2880,
      pitch: 60,
      velocity: 0.6,
    });
    result.score.patterns[0].notes[0].pitch = 61;
    expect(restored.notes[0].pitch).toBe(60);
  });
  it("labels symbolic-only export and rejects stale track bindings", () => {
    const t = fixture();
    t.automation.push({
      id: "gain",
      role: t.tracks[0].role,
      timeSeconds: 1,
      value: 0.5,
      rampSeconds: 0.1,
    });
    expect(performanceToScore(t).warnings[0]).toContain("Symbolic-only");
    t.notes[0].patchId = "missing";
    expect(() => assertPerformanceTake(t)).toThrow(/track/);
  });
  it("checks bounds and retains interruption evidence instead of silently claiming an exact performance", () => {
    const t = fixture();
    t.deviations.push({
      kind: "interrupted",
      timeSeconds: 1,
      reason: "hidden",
    });
    expect(performanceToScore(t).warnings[0]).toContain("Planned");
    t.notes.push({ ...t.notes[0] });
    expect(() => serializePerformanceTake(t)).toThrow(/duplicate/);
    expect(() => parsePerformanceTake('{"version":9}')).toThrow();
  });
  it("computes interrupted role ramps from the actual current value", () => {
    const events = [
      {
        id: "a",
        role: "melody" as const,
        timeSeconds: 0,
        value: 0,
        rampSeconds: 2,
      },
      {
        id: "b",
        role: "melody" as const,
        timeSeconds: 1,
        value: 1,
        rampSeconds: 1,
      },
    ];
    expect(roleGainAt(events, "melody", 0.5)).toBe(0.75);
    expect(roleGainAt(events, "melody", 1)).toBe(0.5);
    expect(roleGainAt(events, "melody", 1.5)).toBe(0.75);
    expect(roleGainAt(events, "bass", 1.5)).toBe(1);
  });
});

describe("acoustic performance envelope", () => {
  it("keeps v2 identities and effective contexts independently of regeneration", () => {
    const legacy = fixture();
    const patchId = legacy.tracks[0].patchId;
    const take: PerformanceTake = {
      ...legacy,
      version: 2,
      acoustic: {
        renderingProfile: "native-recorded",
        palette: {
          version: 1,
          id: "test",
          hash: "a".repeat(64),
          resources: [],
          maxReleaseSeconds: 1,
          profile: {
            id: "compact",
            maxVoices: 32,
            maxPackagedBytes: 1024,
            maxDecodedBytes: 2048,
            worklets: 2,
          },
          bindings: [
            {
              patchId,
              instrumentId: "flute",
              articulationId: "sustain",
              playable: [0, 127],
              tessitura: [48, 84],
              attackSeconds: 0.01,
              releaseSeconds: 0.1,
              maxSustainSeconds: 4,
              calibratedGain: 1,
              velocityPolicy: "single-layer",
              nativeInstrument: "flute",
              soundfontProgram: 73,
              gmProgram: 73,
              synthApproximation: "sine",
            },
          ],
        },
      },
      timeline: [
        {
          tick: 0,
          tonic: 0,
          mode: "ionian",
          ensemble: "light",
          partIds: [legacy.tracks[0].id],
        },
        {
          tick: 3840,
          tonic: 0,
          mode: "aeolian",
          ensemble: "dark",
          partIds: [legacy.tracks[0].id],
        },
      ],
    };
    expect(parsePerformanceTake(serializePerformanceTake(take))).toEqual(take);
    expect(performanceToScore(take).warnings.join(" ")).toContain("palette");
    expect(performanceToScore(take).score.scale.mode).toBe("chromatic");
    if (take.version !== 2) throw Error("fixture");
    take.timeline[0].tick = 1;
    expect(() => assertPerformanceTake(take)).toThrow(/timeline/);
    take.timeline[0].tick = 0;
    take.acoustic.palette = { ...take.acoustic.palette, bindings: [] };
    expect(() => assertPerformanceTake(take)).toThrow(/binding/);
  });
});

it("roundtrips song catalog decay through take and portable Score validation", () => {
  const take = { ...fixture(), tracks: structuredClone(WEATHER_SONG_TRACKS), patches: structuredClone(WEATHER_SONG_PATCHES), notes: [] };
  expect(take.patches.some(patch=>patch.decaySeconds !== undefined)).toBe(true);
  const restored=parsePerformanceTake(serializePerformanceTake(take));
  expect(restored.patches).toEqual(take.patches);
  const score=JSON.parse(JSON.stringify(performanceToScore(restored).score));
  expect(()=>assertPlayableScore(score)).not.toThrow();
  expect(()=>compileScore(score)).not.toThrow();
  for(const invalid of [0.019,10.01,NaN,Infinity,"0.8",null]) {
    const malformed=structuredClone(score);
    malformed.patches[0].decaySeconds=invalid;
    expect(()=>assertPlayableScore(malformed)).toThrow();
    const badTake=structuredClone(take);
    (badTake.patches[0] as any).decaySeconds=invalid;
    expect(()=>serializePerformanceTake(badTake)).toThrow();
  }
});
