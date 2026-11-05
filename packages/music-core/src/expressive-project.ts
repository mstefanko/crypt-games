import {
  assertScore,
  createBlankScore,
  type Score,
  type ExpressiveProjectResourceEnvelope,
} from "@onepage/project";
import {
  assertPerformanceDocument,
  type PerformanceDocumentV1,
} from "./expressive-performance";

/** Separate resource identity prevents a Score editor from overwriting expression. */
export type ExpressiveProjectResource =
  ExpressiveProjectResourceEnvelope<PerformanceDocumentV1>;
export function assertExpressiveProjectResource(
  value: unknown,
): asserts value is ExpressiveProjectResource {
  if (!value || typeof value !== "object")
    throw Error("Invalid expressive project resource");
  const r = value as ExpressiveProjectResource;
  if (
    r.schemaVersion !== 1 ||
    r.kind !== "expressive-project-resource" ||
    typeof r.id !== "string" ||
    !r.id.length ||
    r.id.length > 128 ||
    typeof r.title !== "string" ||
    r.title.length > 200 ||
    Object.keys(r).some(
      (k) => !["schemaVersion", "kind", "id", "title", "document"].includes(k),
    )
  )
    throw Error("Invalid expressive project resource envelope");
  assertPerformanceDocument(r.document);
}
export function createExpressiveProjectResource(
  document: PerformanceDocumentV1,
  title = document.id,
): ExpressiveProjectResource {
  const resource: ExpressiveProjectResource = {
    schemaVersion: 1,
    kind: "expressive-project-resource",
    id: document.id,
    title,
    document: structuredClone(document),
  };
  assertExpressiveProjectResource(resource);
  return resource;
}
export function serializeExpressiveProjectResource(
  resource: ExpressiveProjectResource,
): string {
  assertExpressiveProjectResource(resource);
  const json = JSON.stringify(resource);
  if (json.length > 16_000_000)
    throw Error("Expressive resource exceeds 16 MB");
  return json;
}
export function parseExpressiveProjectResource(
  json: string,
): ExpressiveProjectResource {
  if (json.length > 16_000_000)
    throw Error("Expressive resource exceeds 16 MB");
  const resource: unknown = JSON.parse(json);
  assertExpressiveProjectResource(resource);
  return resource;
}
/** Explicit diagnostic copy. The richer source is never mutated or replaced. */
export function projectExpressiveResourceToScore(
  resource: ExpressiveProjectResource,
): { score: Score; losses: string[] } {
  assertExpressiveProjectResource(resource);
  const d = resource.document;
  const score = createBlankScore(
    `${resource.title.slice(0, 170)} (lossy Score copy)`,
  );
  score.id = `${resource.id.slice(0, 110)}-score-copy`;
  score.bpm = 60e6 / d.tempoMap[0]!.microsecondsPerBeat;
  score.meter = [
    d.meterMap[0]!.numerator,
    d.meterMap[0]!.denominator,
  ] as Score["meter"];
  score.lengthTicks = Math.max(1, Math.round((d.lengthTicks * 480) / d.ppq));
  score.playback = "one-shot";
  score.loop = null;
  score.tracks = [];
  score.patterns = [];
  score.clips = [];
  const losses = [
    "Expression, sustain/key-release distinction, tempo/meter changes, instrument changes, source provenance and exact source ordering are omitted. All timbres use the default synth patch; ticks round to 480 PPQ.",
  ];
  if (d.parts.length > 32) throw Error("Score copy supports at most 32 parts");
  for (const part of d.parts) {
    const trackId = part.id;
    const patternId = `pattern-${score.patterns.length}`;
    score.tracks.push({
      id: trackId,
      name: part.name,
      role: part.role,
      patchId: score.patches[0]!.id,
      gain: part.gain,
      pan: part.pan,
      minEnergy: 1,
    });
    score.patterns.push({
      id: patternId,
      name: part.name,
      lengthTicks: score.lengthTicks,
      notes: d.notes
        .filter((n) => n.partId === part.id)
        .map((n) => ({
          id: n.id,
          startTick: Math.round((n.startTick * 480) / d.ppq),
          durationTicks: Math.max(
            1,
            Math.round((n.endTick * 480) / d.ppq) -
              Math.round((n.startTick * 480) / d.ppq),
          ),
          pitch: n.pitch,
          velocity: n.velocity,
        })),
    });
    score.clips.push({
      id: `clip-${score.clips.length}`,
      trackId,
      patternId,
      startTick: 0,
      repeats: 1,
      transpose: 0,
    });
  }
  assertScore(score);
  return { score, losses };
}
