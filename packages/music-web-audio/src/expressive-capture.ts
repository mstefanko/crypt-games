import {
  NEUTRAL_EXPRESSION,
  createTempoMap,
  evaluateExpressionLane,
  type ExpressionParameter,
  type PerformanceTakeV3,
} from "@onepage/music-core/expressive-performance";
import { controlOrder } from "./expressive-stream";
/** Rolling streams preserve retained onsets, active tempo/meter and unfinished part ramps. */
export function rebaseExpressiveCapture(
  take: PerformanceTakeV3,
  originTick: number,
  endTick: number,
  faithfulFromSeconds = 0,
): PerformanceTakeV3 {
  if (originTick === 0 && endTick === take.lengthTicks)
    return structuredClone(take);
  const clock = createTempoMap(take.ppq, take.tempoMap),
    origin = clock.tickToSeconds(originTick);
  const shiftControl = (c: PerformanceTakeV3["controls"][number]) => {
    const { sourceTick, ...body } = c;
    return {
      ...body,
      timeSeconds: Math.max(0, c.timeSeconds - origin),
      ...(sourceTick !== undefined && sourceTick >= originTick
        ? { sourceTick: sourceTick - originTick }
        : {}),
    };
  };
  const faithfulFrom = Math.max(0, faithfulFromSeconds - origin);
  const diagnostics = take.provenance.diagnostics.filter(
    (d) => d.code !== "rolling-capture-preroll",
  );
  if (faithfulFrom > 0 && diagnostics.length < 10000)
    diagnostics.push({
      code: "rolling-capture-preroll",
      severity: "warning",
      message: `First ${faithfulFrom.toFixed(3)} seconds are render preroll; use captureFaithfulFromSeconds for faithful listening/crop comparisons.`,
    });
  const latestInstruments = new Map(
    take.instruments
      .filter((i) => i.tick <= originTick)
      .map((i) => [i.partId, i]),
  );
  return {
    ...structuredClone(take),
    lengthTicks: endTick - originTick,
    durationSeconds: clock.tickToSeconds(endTick) - origin,
    tempoMap: [
      { ...take.tempoMap.filter((p) => p.tick <= originTick).at(-1)!, tick: 0 },
      ...take.tempoMap
        .filter((p) => p.tick > originTick && p.tick <= endTick)
        .map((p) => ({ ...p, tick: p.tick - originTick })),
    ],
    meterMap: [
      {
        ...(take.meterMap.filter((m) => m.tick <= originTick).at(-1) ?? {
          numerator: 4,
          denominator: 4,
        }),
        tick: 0,
      },
      ...take.meterMap
        .filter((m) => m.tick > originTick && m.tick < endTick)
        .map((m) => ({ ...m, tick: m.tick - originTick })),
    ],
    notes: take.notes.map((n) => ({
      ...n,
      startTick: n.startTick - originTick,
      keyReleaseTick: n.keyReleaseTick - originTick,
      endTick: n.endTick - originTick,
      startSeconds: n.startSeconds - origin,
      keyReleaseSeconds: n.keyReleaseSeconds - origin,
      endSeconds: n.endSeconds - origin,
    })),
    controls: take.controls.map(shiftControl),
    instruments: [...latestInstruments.values()]
      .map((i) => ({ ...i, tick: 0 }))
      .concat(
        take.instruments
          .filter((i) => i.tick > originTick && i.tick <= endTick)
          .map((i) => ({ ...i, tick: i.tick - originTick })),
      ),
    deviations: take.deviations
      .filter((d) => d.timeSeconds >= origin)
      .map((d) => ({ ...d, timeSeconds: d.timeSeconds - origin })),
    provenance: {
      ...take.provenance,
      captureOriginTick: originTick,
      captureOriginSeconds: origin,
      rollingCapture: originTick > 0,
      captureFaithfulFromSeconds: faithfulFrom,
      diagnostics,
      capturePriorSourceTicks: Object.fromEntries(
        take.controls
          .filter(
            (c) => c.sourceTick !== undefined && c.sourceTick < originTick,
          )
          .map((c) => [c.id, c.sourceTick]),
      ),
    },
  };
}
export function restorePartBaseline(take: PerformanceTakeV3, at: number): void {
  const sorted = take.controls.slice().sort(controlOrder);
  for (const part of take.parts) {
    const events = sorted.filter((c) => c.partId === part.id && !c.noteId);
    const initial = {
      ...NEUTRAL_EXPRESSION,
      ...part.initialState,
      pan: part.initialState?.pan ?? part.pan,
    };
    for (const parameter of Object.keys(
      NEUTRAL_EXPRESSION,
    ) as ExpressionParameter[])
      initial[parameter] = evaluateExpressionLane(
        events,
        parameter,
        at,
        initial[parameter],
      ).value;
    part.initialState = initial;
  }
}
