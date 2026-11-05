import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { SoundBankLoader } from "spessasynth_core";
import {
  assertPerformanceTakeV3,
  expressiveTakeToDocument,
} from "@onepage/music-core/expressive-performance";
import { createExpressiveAudioFixture } from "./expressive-fixture";
import {
  compileNarrativeSoundfontTake,
  createNarrativeSoundfontDocument,
  NARRATIVE_GM_PROGRAMS,
} from "./narrative-soundfont";
import manifest from "../../../apps/weather-fronts/src/generaluser-manifest.json";

const bank = {
  id: manifest.id,
  uri: `./instruments/generaluser/${manifest.file}`,
  sha256: manifest.sha256,
  license: manifest.license,
};
const document = () => {
  const d = expressiveTakeToDocument(createExpressiveAudioFixture());
  d.bindings[0].id = "narrative-clear-lead";
  d.notes[0].bindingId = d.bindings[0].id;
  return d;
};

it("freezes an all-GM arrangement without changing authored music or the source document", () => {
  const source = document(),
    original = structuredClone(source);
  const converted = createNarrativeSoundfontDocument(source, {
    bank,
    family: "clear",
  });
  const take = compileNarrativeSoundfontTake(source, { bank });
  assertPerformanceTakeV3(take);
  expect(source).toEqual(original);
  expect(converted.notes).toEqual(source.notes);
  expect(converted.controls).toEqual(source.controls);
  expect(converted.tempoMap).toEqual(source.tempoMap);
  expect(converted.meterMap).toEqual(source.meterMap);
  expect(converted.resources).toEqual([{ ...bank, kind: "soundfont" }]);
  expect(converted.bindings).toEqual([
    {
      id: "narrative-clear-lead",
      kind: "soundfont",
      resourceId: bank.id,
      gmProgram: 12,
      bankMsb: 0,
      bankLsb: 0,
      drum: false,
    },
  ]);
  expect(converted.parts[0].gain).toBe(source.parts[0].gain * 0.25);
  expect(take.renderingProfile).toBe("expressive-gm-offline-1");
  expect(take.provenance.narrativeRenderer).toMatchObject({
    listeningApproval: "pending",
    masterAppliedTo: "part.gain",
    bank,
  });
});

it("the journey keeps per-family palettes and the fixed traveler, while neutral has one melodic color", () => {
  const source = document();
  source.bindings = Object.entries(NARRATIVE_GM_PROGRAMS).flatMap(
    ([family, programs]) =>
      Object.keys(programs).map((part) => ({
        id: `narrative-${family}-${part}`,
        kind: "synth" as const,
        resourceId: source.resources[0].id,
      })),
  );
  const intended = createNarrativeSoundfontDocument(source, { bank });
  expect(
    new Set(
      intended.bindings
        .filter((b) => b.id.endsWith("traveler"))
        .map((b) => b.gmProgram),
    ),
  ).toEqual(new Set([73]));
  expect(
    intended.bindings.find((b) => b.id === "narrative-fog-lead")?.gmProgram,
  ).toBe(70);
  expect(
    intended.bindings.find((b) => b.id === "narrative-storm-lead")?.gmProgram,
  ).toBe(48);
  const neutral = createNarrativeSoundfontDocument(source, {
    bank,
    palette: "neutral",
  });
  expect(neutral.bindings.every((b) => b.gmProgram === 0)).toBe(true);
  expect(neutral.bindings.filter((b) => b.drum)).toHaveLength(0);
  const bytes = Uint8Array.from(
    readFileSync(
      `apps/weather-fronts/public/instruments/generaluser/${manifest.file}`,
    ),
  );
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(bank.sha256);
  const soundbank = SoundBankLoader.fromArrayBuffer(bytes.buffer);
  for (const binding of [...intended.bindings, ...neutral.bindings])
    expect(
      soundbank.presets.some(
        (p) =>
          p.program === binding.gmProgram &&
          p.bankMSB === binding.bankMsb &&
          p.bankLSB === binding.bankLsb &&
          p.isGMGSDrum === binding.drum,
      ),
      binding.id,
    ).toBe(true);
});

it("rejects ambiguous resources, family mismatch, hidden substitutes and unqualified expression", () => {
  const source = document();
  expect(() =>
    createNarrativeSoundfontDocument(source, {
      bank: { ...bank, sha256: "missing" },
    }),
  ).toThrow("resource");
  expect(() =>
    createNarrativeSoundfontDocument(source, { bank, masterGain: NaN }),
  ).toThrow("gain");
  expect(() =>
    createNarrativeSoundfontDocument(source, { bank, family: "storm" }),
  ).toThrow("family");
  source.bindings[0].id = source.notes[0].bindingId = "fallback-piano";
  expect(() => createNarrativeSoundfontDocument(source, { bank })).toThrow(
    "Unknown narrative instrument",
  );
  const brightness = document();
  brightness.controls[0] = {
    ...brightness.controls[0],
    parameter: "brightness",
    value: 0.5,
  };
  expect(() => createNarrativeSoundfontDocument(brightness, { bank })).toThrow(
    "brightness mapping",
  );
});

it("keeps the source synth seam claim distinct from unqualified natural GM tails", () => {
  const source = document();
  source.provenance.weatherNarrative = {
    segments: [{ family: "clear" }, { family: "fog" }],
    transitions: [
      {
        source: "clear",
        destination: "fog",
        tailPolicy: "synth-profile-release-before-entry",
      },
    ],
  };
  const converted = createNarrativeSoundfontDocument(source, { bank });
  expect(converted.provenance.weatherNarrative).toMatchObject({
    transitions: [
      {
        sourceTailPolicy: "synth-profile-release-before-entry",
        tailPolicy:
          "natural-gm-releases-may-cross-cue-boundaries; qualification-pending",
      },
    ],
  });
  expect(source.provenance.weatherNarrative).toMatchObject({
    transitions: [{ tailPolicy: "synth-profile-release-before-entry" }],
  });
  expect(
    converted.provenance.diagnostics.some(
      (d) => d.code === "narrative-gm-natural-transition-tails",
    ),
  ).toBe(true);
});
