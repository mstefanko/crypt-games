import {
  assertPerformanceDocument,
  compileExpressivePerformance,
  type ExpressiveBinding,
  type PerformanceDocumentV1,
  type PerformanceTakeV3,
} from "@onepage/music-core/expressive-performance";

type Family = "clear" | "fog" | "rain" | "storm" | "clearing";
type Part = "traveler" | "lead" | "harmony" | "bass" | "percussion";
export interface NarrativeSoundfontOptions {
  /** Actual bank bytes are checked against this identity by both GM renderers. */
  bank: { id: string; uri: string; sha256: string; license: string };
  family?: Family;
  palette?: "intended" | "neutral";
  /** Attenuation only, baked into part gains and retained in capture/export. */
  masterGain?: number;
}

/** Zero-based GM programs. The traveler is the same flute throughout this profile. */
export const NARRATIVE_GM_PROGRAMS: Readonly<
  Record<Family, Readonly<Record<Part, number>>>
> = {
  clear: { traveler: 73, lead: 12, harmony: 46, bass: 32, percussion: 0 },
  fog: { traveler: 73, lead: 70, harmony: 14, bass: 43, percussion: 0 },
  rain: { traveler: 73, lead: 71, harmony: 4, bass: 32, percussion: 0 },
  storm: { traveler: 73, lead: 48, harmony: 44, bass: 42, percussion: 0 },
  clearing: { traveler: 73, lead: 68, harmony: 46, bass: 32, percussion: 0 },
};

/** Explicit alternate arrangement of a narrative document; no synth fallback.
 * The GM palette is separately identified and has no acoustic listening approval.
 * Both live and offline renderers subsequently verify bytes and exact presets.
 */
export function createNarrativeSoundfontDocument(
  document: PerformanceDocumentV1,
  options: NarrativeSoundfontOptions,
): PerformanceDocumentV1 {
  assertPerformanceDocument(document);
  const gain = options.masterGain ?? 0.25,
    palette = options.palette ?? "intended";
  if (
    !options.bank.id ||
    !options.bank.uri ||
    !options.bank.license ||
    !/^[a-f0-9]{64}$/i.test(options.bank.sha256) ||
    !Number.isFinite(gain) ||
    gain < 0 ||
    gain > 1 ||
    !["neutral", "intended"].includes(palette)
  )
    throw Error("Invalid narrative GM resource or gain");
  if (
    document.parts.some(
      (p) =>
        p.initialState?.brightness !== undefined &&
        p.initialState.brightness !== 1,
    ) ||
    document.controls.some((c) => c.parameter === "brightness" && c.value !== 1)
  )
    throw Error("Narrative GM brightness mapping is not qualified");
  const converted = structuredClone(document);
  converted.resources = [
    {
      ...options.bank,
      sha256: options.bank.sha256.toLowerCase(),
      kind: "soundfont",
    },
  ];
  converted.bindings = document.bindings.map((binding): ExpressiveBinding => {
    // The family is encoded per binding so a journey keeps each cue's palette.
    const match =
      /^narrative-(clear|fog|rain|storm|clearing)-(traveler|lead|harmony|bass|percussion)$/.exec(
        binding.id,
      );
    if (!match)
      throw Error(`Unknown narrative instrument binding: ${binding.id}`);
    const family = match[1] as Family,
      part = match[2] as Part;
    if (options.family && options.family !== family)
      throw Error("Narrative family does not match instrument bindings");
    return {
      id: binding.id,
      kind: "soundfont",
      resourceId: options.bank.id,
      gmProgram:
        palette === "neutral" ? 0 : NARRATIVE_GM_PROGRAMS[family][part],
      bankMsb: 0,
      bankLsb: 0,
      drum: palette !== "neutral" && part === "percussion",
    };
  });
  for (const part of converted.parts) part.gain *= gain;
  const narrative = converted.provenance.weatherNarrative;
  const journey =
    narrative && typeof narrative === "object" && "segments" in narrative;
  if (journey)
    converted.provenance.diagnostics.push({
      code: "narrative-gm-natural-transition-tails",
      severity: "warning",
      message:
        "The journey's synth release guard does not qualify GM releases. Natural GM tails may cross cue boundaries; acoustic seam compatibility and listening approval remain pending.",
    });
  if (
    journey &&
    "transitions" in narrative &&
    Array.isArray(narrative.transitions)
  )
    converted.provenance.weatherNarrative = {
      ...narrative,
      transitions: narrative.transitions.map((transition: unknown) =>
        transition && typeof transition === "object"
          ? {
              ...transition,
              sourceTailPolicy:
                "tailPolicy" in transition ? transition.tailPolicy : undefined,
              tailPolicy:
                "natural-gm-releases-may-cross-cue-boundaries; qualification-pending",
            }
          : transition,
      ),
    };
  converted.provenance.narrativeRenderer = {
    profile: "narrative-gm-v1",
    engine: "spessasynth_core@4.3.22",
    effects: false,
    palette,
    masterGain: gain,
    masterAppliedTo: "part.gain",
    bank: { ...options.bank },
    sourceDocumentId: document.id,
    bindingPrograms: converted.bindings.map((b) => ({
      id: b.id,
      program: b.gmProgram,
      drum: b.drum,
    })),
    listeningApproval: "pending",
    transitionTailPolicy: journey
      ? "natural-gm-releases-may-cross-cue-boundaries; qualification-pending"
      : "natural-gm-releases",
  };
  assertPerformanceDocument(converted);
  return converted;
}

export function compileNarrativeSoundfontTake(
  document: PerformanceDocumentV1,
  options: NarrativeSoundfontOptions,
): PerformanceTakeV3 {
  return compileExpressivePerformance(
    createNarrativeSoundfontDocument(document, options),
    "expressive-gm-offline-1",
  );
}
