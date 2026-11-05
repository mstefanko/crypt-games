import { createTempoMap, type PerformanceDocumentV1 } from "./expressive-performance";
import { createWeatherNarrativeDocument, NARRATIVE_CUE_BUNDLES, createNarrativeModeState, observeNarrativeModeBoundary, type NarrativeDocumentMetadataV1, type NarrativeModeStateV1 } from "./weather-narrative";
import { createNarrativeMemory, admitNarrativeMemoryEvent, advanceNarrativeMemory, selectNarrativeRecall, type NarrativeFamily, type NarrativeMode, type NarrativeMemoryV1, type NarrativeClosure } from "./weather-narrative-memory";
import { planNarrativeTransition, type NarrativeTransitionPlanV1, type NarrativeTransitionExit } from "./weather-narrative-transition";
import { MODE_INTERVALS } from "./tonality";
import type { RichWeatherObservation } from "./weather-model";

export interface NarrativeLiveRequest {
  family: NarrativeFamily;
  mode?: NarrativeMode;
  intensity?: number;
  urgent?: boolean;
}
export interface NarrativeLiveObservedRequest {
  family: NarrativeFamily;
  mode: NarrativeMode;
  intensity: number;
  urgent: boolean;
  observedAtSeconds: number;
  stableAtSeconds: number;
}
export interface NarrativeLiveClock {
  nowSeconds: number;
  committedThroughSeconds: number;
  /** Latest release owned by a committed onset, including the renderer's release guard. */
  protectedThroughSeconds?: number;
}
export interface NarrativeLiveSegment {
  id: string;
  document: PerformanceDocumentV1;
  epoch: number;
  revision: number;
  startSeconds: number;
  endSeconds: number;
  /** Cancel the previous pending suffix here, leaving a declared breath before entry. */
  replaceFromSeconds: number;
  family: NarrativeFamily;
  mode: NarrativeMode;
  transition: NarrativeTransitionPlanV1 | null;
}
export interface NarrativeLivePosition {
  family: NarrativeFamily;
  mode: NarrativeMode;
  intensity: number;
  tempoBpm: number;
  meter: { numerator: number; denominator: number };
  entrySeconds: number;
  revision: number;
}
export interface NarrativeLiveSnapshot {
  version: 1;
  epoch: number;
  rawRequest: NarrativeLiveObservedRequest;
  stableRequest: NarrativeLiveObservedRequest;
  heard: NarrativeLivePosition | null;
  admitted: NarrativeLivePosition | null;
  memory: NarrativeMemoryV1;
  pendingTransition: NarrativeTransitionPlanV1 | null;
  lastTransition: NarrativeTransitionPlanV1 | null;
  modeBoundary: NarrativeModeStateV1 | null;
  admittedSegments: number;
}
interface AdmittedSegment extends NarrativeLiveSegment {
  intensity: number;
  /** End of the suffix that remains admitted, which may precede the original cue end. */
  effectiveEndSeconds: number;
  boundaryCount: number;
}
const validTime = (n: number) => Number.isFinite(n) && n >= 0;
const EPS = 1e-8;
const metadata = (d: PerformanceDocumentV1) => d.provenance.weatherNarrative as NarrativeDocumentMetadataV1;
function normalized(request: NarrativeLiveRequest, at: number): NarrativeLiveObservedRequest {
  const bundle = NARRATIVE_CUE_BUNDLES[request.family];
  const mode = request.mode ?? bundle?.mode, intensity = request.intensity ?? .55;
  if (!bundle || !mode || !bundle.modes.includes(mode) || !Number.isFinite(intensity) || intensity < 0 || intensity > 1 || request.urgent !== undefined && typeof request.urgent !== "boolean" || !validTime(at)) throw Error("Invalid live narrative observation");
  return { family: request.family, mode, intensity, urgent: request.urgent ?? false, observedAtSeconds: at, stableAtSeconds: at };
}
/** Weather intensity never selects the family. Thresholds use the model's local weather fields;
 * temporal hysteresis belongs to the live coordinator, so frame frequency cannot change it. */
export function narrativeRequestFromWeather(observation: RichWeatherObservation, previousFamily?: NarrativeFamily): NarrativeLiveRequest {
  for (const n of [observation.stormStrength, observation.convection, observation.precipitation, observation.fog, observation.intensity, observation.clearingDuration, observation.solarHeating]) if (!Number.isFinite(n)) throw Error("Nonfinite narrative weather observation");
  let family: NarrativeFamily;
  if (observation.lightning || observation.stormStrength >= .18 || observation.convection >= .6 && observation.precipitation >= .12) family = "storm";
  else if (observation.fog >= .35 && observation.precipitation < .2) family = "fog";
  else if (observation.precipitation >= .07) family = "rain";
  else if (previousFamily && previousFamily !== "clear" && observation.clearingDuration > 0 && observation.clearingDuration < 45) family = "clearing";
  else family = "clear";
  const mode: NarrativeMode = family === "clear" ? observation.solarHeating >= .7 ? "lydian" : "ionian" : family === "rain" ? observation.solarHeating < .35 ? "aeolian" : "dorian" : family === "storm" ? observation.stormStrength >= .65 ? "phrygian" : "aeolian" : NARRATIVE_CUE_BUNDLES[family].mode;
  return { family, mode, intensity: Math.max(0, Math.min(1, observation.intensity)), urgent: observation.lightning };
}

/** Deterministic policy/lifecycle only. Planning never means admission or hearing.
 * Source material remains the existing 16-bar corpus. A transition may cancel its future
 * suffix; those live seams require listening qualification independently of the corpus. */
export class WeatherNarrativeLiveComposer {
  readonly epoch: number;
  private readonly seed: number;
  private readonly settleSeconds: number;
  private raw: NarrativeLiveObservedRequest;
  private stable: NarrativeLiveObservedRequest;
  private candidateSince = 0;
  private observedThrough = 0;
  private observations: NarrativeLiveObservedRequest[] = [];
  private segments: AdmittedSegment[] = [];
  private memory = createNarrativeMemory();
  private revision = 0;
  private modeBoundary: NarrativeModeStateV1 | null = null;
  private heardRevision: number | null = null;
  private hasHeardCallback = false;
  private lastTransition: NarrativeTransitionPlanV1 | null = null;
  private draft: NarrativeLiveSegment | null = null;

  constructor(options: { seed: number; epoch?: number; settleSeconds?: number; initialFamily?: NarrativeFamily }) {
    this.seed = options.seed; this.epoch = options.epoch ?? 1; this.settleSeconds = options.settleSeconds ?? 8;
    if (!Number.isSafeInteger(this.seed) || !Number.isSafeInteger(this.epoch) || this.epoch < 0 || !validTime(this.settleSeconds)) throw Error("Invalid live narrative options");
    this.raw = normalized({ family: options.initialFamily ?? "clear" }, 0);
    this.stable = { ...this.raw }; this.observations = [{ ...this.raw }];
  }
  observe(request: NarrativeLiveRequest, atSeconds: number): void {
    const next = normalized(request, atSeconds);
    if (atSeconds < this.observedThrough || atSeconds < this.memory.frontierSeconds) throw Error("Narrative observations must be monotone and no earlier than heard time");
    if (next.family !== this.raw.family) this.candidateSince = atSeconds;
    next.observedAtSeconds = this.candidateSince;
    next.stableAtSeconds = next.urgent ? atSeconds : this.candidateSince + this.settleSeconds;
    this.raw = next; this.observedThrough = atSeconds;
    // Only mode/family changes matter to boundary confirmation; retain one prior anchor.
    const prior = this.observations[this.observations.length - 1];
    if (!prior || prior.family !== next.family || prior.mode !== next.mode) this.observations.push({ ...next, observedAtSeconds: atSeconds });
    this.observations = this.observations.slice(-128);
    this.promote(atSeconds);
    this.draft = null;
  }
  private promote(now: number): void {
    if (this.raw.urgent || now + EPS >= this.candidateSince + this.settleSeconds) this.stable = { ...this.raw, stableAtSeconds: this.raw.urgent ? this.observedThrough : this.candidateSince + this.settleSeconds };
    else if (this.stable.family === this.raw.family) this.stable = { ...this.stable, mode: this.raw.mode, intensity: this.raw.intensity, urgent: false };
  }
  private position(segment: AdmittedSegment): NarrativeLivePosition {
    const meta = metadata(segment.document);
    return { family: segment.family, mode: segment.mode, intensity: segment.intensity, tempoBpm: meta.tempoBpm, meter: { ...meta.meter }, entrySeconds: segment.startSeconds, revision: segment.revision };
  }
  plan(clock: NarrativeLiveClock): NarrativeLiveSegment | null {
    const protection = clock.protectedThroughSeconds ?? clock.committedThroughSeconds;
    if (![clock.nowSeconds, clock.committedThroughSeconds, protection].every(validTime) || clock.nowSeconds + EPS < this.memory.frontierSeconds || protection + EPS < clock.committedThroughSeconds) throw Error("Invalid live narrative planning clock");
    this.promote(clock.nowSeconds);
    const latest = this.segments[this.segments.length - 1];
    // An uncommitted future destination must not impose a new dwell on the current cue.
    const sourceFrontier = Math.max(clock.nowSeconds, clock.committedThroughSeconds);
    const active = [...this.segments].reverse().find((s) => s.startSeconds <= sourceFrontier + EPS && s.effectiveEndSeconds > s.startSeconds + EPS) ?? latest;
    let target = { ...(active ? this.stable : this.raw) };
    if (active && latest !== active && latest.family !== active.family && this.raw.family === active.family) target = { ...this.raw, stableAtSeconds: clock.nowSeconds, observedAtSeconds: Math.min(this.raw.observedAtSeconds, clock.nowSeconds) };
    if (active && target.family === active.family) target.mode = this.modeBoundary?.family === active.family ? this.modeBoundary.committed : active.mode;
    const superseding = !!active && latest !== active && (latest.family !== target.family || latest.mode !== target.mode);
    // The accepted destination already owns this future suffix. Repeated scheduler
    // ticks cannot reseed/re-admit it while its entry is still unheard.
    if (active && latest !== active && !superseding) return null;
    let startSeconds = Math.max(clock.nowSeconds, clock.committedThroughSeconds, protection);
    let replaceFromSeconds = startSeconds;
    let transition: NarrativeTransitionPlanV1 | null = null;
    if (active) {
      const bundle = NARRATIVE_CUE_BUNDLES[active.family], barSeconds = bundle.meter.numerator * 4 / bundle.meter.denominator * 60 / bundle.tempoBpm;
      const phraseSeconds = bundle.phraseBars * barSeconds;
      const familyChange = target.family !== active.family;
      // Local color is confirmed only by two real heard boundaries, never speculative plans.
      if (!familyChange) target.mode = this.modeBoundary?.family === active.family ? this.modeBoundary.committed : active.mode;
      const modeChange = target.mode !== active.mode;
      // Intensity is sampled on cue continuation. Re-entering every four bars would
      // restart the traveler and repeatedly prevent the authored final ending.
      const intensityChange = Math.abs(target.intensity - active.intensity) >= .15 && active.endSeconds - clock.nowSeconds <= 1.5;
      const recallAvailable = active.family === "clearing" && !metadata(active.document).recall && !!selectNarrativeRecall(this.memory);
      if (!superseding && !familyChange && !modeChange && !intensityChange && !recallAvailable && active.endSeconds - clock.nowSeconds > 1.5) return null;
      const earliest = Math.max(startSeconds, target.urgent ? 0 : active.startSeconds + 8);
      const firstBoundary = Math.max(1, Math.ceil((earliest - active.startSeconds - EPS) / phraseSeconds));
      const exits: NarrativeTransitionExit[] = [];
      for (let index = firstBoundary; index * phraseSeconds <= active.endSeconds - active.startSeconds + EPS; index++) {
        const atSeconds = active.startSeconds + index * phraseSeconds;
        exits.push({ atSeconds, sourceBarsFromRequest: Math.max(0, (atSeconds - target.stableAtSeconds) / barSeconds), exitClass: "phrase" as const, sourceVoicing: [48, 55], destinationVoicing: [48, 55], approvedOverlap: false, approvedCadence: false });
      }
      if (!familyChange && !superseding) {
        // Local changes occur only on a phrase boundary and after every owned tail.
        const boundary = exits[0]?.atSeconds ?? Math.max(startSeconds, active.endSeconds);
        if (!exits.length) exits.push({ atSeconds: boundary, sourceBarsFromRequest: 0, exitClass: "phrase", sourceVoicing: [48, 55], destinationVoicing: [48, 55], approvedOverlap: false, approvedCadence: false });
        if (active.endSeconds - clock.nowSeconds > 1.5 && boundary - clock.nowSeconds > 1.5) return null;
        target.stableAtSeconds = Math.min(boundary, Math.max(active.startSeconds, target.stableAtSeconds));
        target.observedAtSeconds = Math.min(target.observedAtSeconds, target.stableAtSeconds);
      }
      const beatSeconds = 60 / bundle.tempoBpm;
      const nextBeat = active.startSeconds + Math.ceil((startSeconds - active.startSeconds - EPS) / beatSeconds) * beatSeconds;
      transition = planNarrativeTransition({ source: active.family, destination: target.family, observedAtSeconds: target.observedAtSeconds, stableAtSeconds: target.stableAtSeconds, nowSeconds: clock.nowSeconds, committedThroughSeconds: Math.max(clock.committedThroughSeconds, protection), lastEntrySeconds: active.startSeconds, sourceBarSeconds: barSeconds, nextUncommittedBeatSeconds: Math.max(0, nextBeat), beatSeconds, meterChanges: bundle.meter.numerator !== NARRATIVE_CUE_BUNDLES[target.family].meter.numerator || bundle.meter.denominator !== NARRATIVE_CUE_BUNDLES[target.family].meter.denominator, urgent: familyChange && target.urgent, exits });
      if (!familyChange && !superseding) {
        // Same-family material is a phrase continuation, not a response to an old request.
        transition.exitSeconds = exits[0].atSeconds; transition.entrySeconds = exits[0].atSeconds;
        transition.strategy = "role-change"; transition.tailPolicy = "compatible-only";
        transition.responseSeconds = Math.max(0, transition.entrySeconds - target.stableAtSeconds);
        transition.budgetMet = true;
        transition.reason = "Local intensity/mode sampled at a heard-confirmed safe phrase boundary; unchanged cues continue after sixteen bars";
      }
      if (superseding) {
        // Discard the stale future destination at its earliest cancellable onset. Its
        // unheard entry cannot become a source cue or impose a phantom minimum dwell.
        transition.exitSeconds = Math.max(clock.nowSeconds, clock.committedThroughSeconds, protection);
        transition.entrySeconds = transition.exitSeconds + .25;
        transition.strategy = "breath-pickup"; transition.tailPolicy = "release-before-entry";
        transition.responseSeconds = transition.entrySeconds - target.stableAtSeconds;
        transition.budgetMet = transition.responseSeconds <= Math.min(8, 4 * barSeconds) + EPS;
        transition.reason = "Cancel superseded future destination; current source releases into a new pickup";
        transition.seam = { meter: "declared-break", timbre: familyChange ? "change" : "continuous", pitch: "released", volume: "breath", abruptness: "prepared" };
      }
      replaceFromSeconds = transition.exitSeconds; startSeconds = transition.entrySeconds;
    }
    const revision = this.revision + 1;
    const document = createWeatherNarrativeDocument({ family: target.family, mode: target.mode, intensity: target.intensity, seed: (this.seed + Math.imul(revision - 1, 101)) | 0, bars: 16, memory: this.memory });
    const meta = metadata(document);
    // Candidate provenance is specific to the accepted live admission, not exemplar defaults.
    if (meta.memoryCandidate) { meta.memoryCandidate.admissionRevision = revision; meta.memoryCandidate.epoch = this.epoch; meta.memoryCandidate.phraseId = `live:${this.epoch}:${revision}:${meta.memoryCandidate.phraseId}`; }
    const duration = createTempoMap(document.ppq, document.tempoMap).tickToSeconds(document.lengthTicks);
    document.provenance.weatherNarrativeLive = { version: 1, epoch: this.epoch, revision, memoryEvidence: "actual-heard-frontier-only", sourceCorpusBars: 16, liveSeamListeningApproved: false, request: target, transition };
    const segment: NarrativeLiveSegment = { id: `narrative-live:${this.epoch}:${revision}`, document, epoch: this.epoch, revision, family: target.family, mode: target.mode, startSeconds, endSeconds: startSeconds + duration, replaceFromSeconds, transition };
    this.draft = structuredClone(segment);
    return structuredClone(segment);
  }
  /** Call only after the audio scheduler accepts the exact segment. */
  admit(segment: NarrativeLiveSegment, actualTiming?: { startSeconds: number; replaceFromSeconds: number }): void {
    if (!this.draft || segment.id !== this.draft.id || JSON.stringify(segment) !== JSON.stringify(this.draft) || segment.epoch !== this.epoch || segment.revision !== this.revision + 1) throw Error("Stale or modified live narrative admission");
    const accepted = structuredClone(segment);
    if (actualTiming) {
      if (![actualTiming.startSeconds, actualTiming.replaceFromSeconds].every(validTime) || Math.abs(actualTiming.startSeconds - accepted.startSeconds) > .005 || Math.abs(actualTiming.replaceFromSeconds - accepted.replaceFromSeconds) > .005 || actualTiming.replaceFromSeconds > actualTiming.startSeconds) throw Error("Invalid audio narrative timing acknowledgement");
      accepted.endSeconds += actualTiming.startSeconds - accepted.startSeconds;
      accepted.startSeconds = actualTiming.startSeconds; accepted.replaceFromSeconds = actualTiming.replaceFromSeconds;
      if (accepted.transition) {
        accepted.transition.entrySeconds = accepted.startSeconds; accepted.transition.exitSeconds = accepted.replaceFromSeconds;
        accepted.transition.responseSeconds = accepted.startSeconds - accepted.transition.stableAtSeconds;
        // Quantization must not turn a reported success into a hidden deadline miss.
        const source = this.segments[this.segments.length - 1];
        const bundle = source && NARRATIVE_CUE_BUNDLES[source.family];
        const budget = accepted.transition.strategy === "urgent-accent" ? 1 : bundle ? Math.min(8, 4 * bundle.meter.numerator * 4 / bundle.meter.denominator * 60 / bundle.tempoBpm) : 8;
        if (accepted.transition.strategy !== "role-change") accepted.transition.budgetMet = accepted.transition.responseSeconds <= budget + EPS;
      }
    }
    if (accepted.replaceFromSeconds + EPS < this.memory.frontierSeconds) throw Error("Cannot replace heard narrative history");
    const interrupted = [...this.segments].reverse().find((s) => s.startSeconds < accepted.replaceFromSeconds && s.effectiveEndSeconds > s.startSeconds + EPS);
    for (const old of this.segments) if (old.effectiveEndSeconds > accepted.replaceFromSeconds) old.effectiveEndSeconds = Math.max(old.startSeconds, accepted.replaceFromSeconds);
    this.memory = { ...this.memory, admitted: this.memory.admitted.filter((e) => e.audibleAtSeconds < accepted.replaceFromSeconds) };
    if (interrupted && interrupted.family !== accepted.family && accepted.replaceFromSeconds < interrupted.endSeconds - EPS) this.rememberInterruption(interrupted, accepted);
    const meta = metadata(accepted.document), clock = createTempoMap(accepted.document.ppq, accepted.document.tempoMap);
    if (meta.memoryCandidate) this.memory = admitNarrativeMemoryEvent(this.memory, { id: `${accepted.id}:remember`, epoch: this.epoch, revision: accepted.revision, audibleAtSeconds: accepted.startSeconds + clock.tickToSeconds(meta.memoryCandidateAudibleTick), action: { type: "remember", phrase: meta.memoryCandidate } });
    if (meta.recall) this.memory = admitNarrativeMemoryEvent(this.memory, { id: `${accepted.id}:resolve`, epoch: this.epoch, revision: accepted.revision, audibleAtSeconds: accepted.startSeconds + clock.tickToSeconds(meta.recall.resolutionTick), action: { type: "resolve", phraseId: meta.recall.phraseId, closure: meta.recall.intendedClosure as NarrativeClosure } });
    this.segments.push({ ...accepted, intensity: (accepted.document.provenance.weatherNarrativeLive as { request: NarrativeLiveObservedRequest }).request.intensity, effectiveEndSeconds: accepted.endSeconds, boundaryCount: 0 });
    this.revision = accepted.revision; this.draft = null;
    this.prune();
  }
  private rememberInterruption(source: AdmittedSegment, destination: NarrativeLiveSegment): void {
    if (source.family !== "storm" && source.family !== "fog") return;
    const doc = source.document, meta = metadata(doc), map = createTempoMap(doc.ppq, doc.tempoMap);
    const cutoff = destination.replaceFromSeconds - source.startSeconds;
    const notesById = new Map(doc.notes.map((n) => [n.id, n]));
    const occurrence = [...meta.signatureOccurrences].reverse().find((o) => o.noteIds.length >= 2 && o.noteIds.every((id) => { const n = notesById.get(id); return !!n && map.tickToSeconds(n.keyReleaseTick) <= cutoff + EPS; }));
    if (!occurrence) return;
    const heardNotes = doc.notes.filter((n) => n.partId !== "percussion" && map.tickToSeconds(n.startTick) < cutoff);
    const harmony = heardNotes.filter((n) => n.partId === "harmony");
    const lastHarmonyTick = Math.max(...harmony.map((n) => n.startTick));
    const voicing = harmony.filter((n) => n.startTick === lastHarmonyTick).map((n) => n.pitch).slice(0, 6);
    const lastMelody = heardNotes.filter((n) => n.partId === "traveler" || n.partId === "lead").sort((a, b) => b.startTick - a.startTick)[0];
    if (!voicing.length || !lastMelody) return;
    // A dominant obligation is claimed only for the actual authored leading-tone/V ending.
    const dominant = lastMelody.pitch % 12 === 11 && [11, 2, 7].every((pc) => voicing.some((n) => n % 12 === pc));
    const collection = MODE_INTERVALS[source.mode] as readonly number[];
    const degreeIndex = collection.indexOf(lastMelody.pitch % 12);
    const phrase = {
      phraseId: `live:${this.epoch}:${source.revision}:interrupted:${destination.revision}`, sourceFamily: source.family,
      signatureId: occurrence.signatureId, variationSeed: meta.seed, motifDegrees: [...occurrence.degrees],
      motifGaps: occurrence.onsetPulses.slice(1).map((n, i) => n - occurrence.onsetPulses[i]),
      tonicPitchClass: 0, mode: source.mode, endingVoicing: voicing, endingMelodicDegree: degreeIndex < 0 ? 7 : degreeIndex + 1, endingAlterationSemitones: degreeIndex < 0 ? 1 : 0,
      endingMelodicPitch: lastMelody.pitch, intendedClosure: dominant ? "dominant-tonic" as const : "home-return" as const,
      status: source.family === "storm" ? "interrupted" as const : "open" as const, priority: source.family === "storm" ? 2 : 1,
      admissionRevision: destination.revision, epoch: this.epoch,
    };
    // This admission is promoted only when the actual transition cutoff is heard. A
    // clearing already queued before that callback must wait for a later phrase to recall it.
    this.memory = admitNarrativeMemoryEvent(this.memory, { id: `${destination.id}:interruption`, epoch: this.epoch, revision: destination.revision, audibleAtSeconds: destination.replaceFromSeconds, action: { type: "remember", phrase } });
  }
  /** Real transport callback only: this is never called from plan/admit or a simulation clock. */
  advanceHeard(seconds: number): void {
    if (!validTime(seconds) || seconds + EPS < this.memory.frontierSeconds) throw Error("Heard narrative frontier must advance monotonically");
    this.hasHeardCallback = true;
    for (const segment of this.segments) {
      if (segment.startSeconds > seconds + EPS || segment.effectiveEndSeconds <= segment.startSeconds + EPS) continue;
      if (this.heardRevision !== segment.revision && segment.startSeconds + EPS >= this.memory.frontierSeconds) {
        this.heardRevision = segment.revision;
        this.modeBoundary = { ...createNarrativeModeState(segment.family), requested: segment.mode, committed: segment.mode };
        if (segment.transition) this.lastTransition = structuredClone(segment.transition);
      }
      const bundle = NARRATIVE_CUE_BUNDLES[segment.family];
      const phraseSeconds = bundle.phraseBars * bundle.meter.numerator * 4 / bundle.meter.denominator * 60 / bundle.tempoBpm;
      const count = Math.min(4, Math.floor((Math.min(seconds, segment.effectiveEndSeconds) - segment.startSeconds + EPS) / phraseSeconds));
      while (segment.boundaryCount < count) {
        segment.boundaryCount++;
        const at = segment.startSeconds + segment.boundaryCount * phraseSeconds;
        const observation = [...this.observations].reverse().find((o) => o.observedAtSeconds <= at + EPS);
        if (observation?.family === segment.family && this.modeBoundary?.family === segment.family) this.modeBoundary = observeNarrativeModeBoundary(this.modeBoundary, observation.mode);
        else if (this.modeBoundary?.family === segment.family) this.modeBoundary = { ...this.modeBoundary, matchingBoundaries: 0 };
      }
    }
    this.memory = advanceNarrativeMemory(this.memory, seconds);
    this.prune();
  }
  /** Explicit scheduler cancellation removes only future events. Heard history survives. */
  cancelRevision(revision: number, fromSeconds: number): void {
    if (!Number.isSafeInteger(revision) || revision < 1 || !validTime(fromSeconds) || fromSeconds < this.memory.frontierSeconds) throw Error("Invalid live narrative cancellation");
    this.memory = { ...this.memory, admitted: this.memory.admitted.filter((e) => e.revision !== revision || e.audibleAtSeconds < fromSeconds) };
    for (const segment of this.segments) if (segment.revision === revision) segment.effectiveEndSeconds = Math.min(segment.effectiveEndSeconds, Math.max(segment.startSeconds, fromSeconds));
    this.segments = this.segments.filter((segment) => segment.effectiveEndSeconds > segment.startSeconds + EPS);
    this.draft = null;
  }
  private prune(): void {
    // Preserve current heard position and future admissions. Ordinary playback keeps 1–2.
    let heardIndex = -1;
    for (let index = 0; index < this.segments.length; index++) if (this.segments[index].startSeconds <= this.memory.frontierSeconds && this.segments[index].effectiveEndSeconds > this.segments[index].startSeconds + EPS) heardIndex = index;
    if (heardIndex > 0) this.segments = this.segments.slice(heardIndex);
    this.segments = this.segments.filter((s, i) => i === 0 || s.effectiveEndSeconds > s.startSeconds + EPS);
    if (this.segments.length > 64) throw Error("Live narrative admission capacity exceeded; heard callbacks are required");
    let anchor = -1;
    for (let index = 0; index < this.observations.length; index++) if (this.observations[index].observedAtSeconds <= this.memory.frontierSeconds) anchor = index;
    if (anchor > 0) this.observations = this.observations.slice(anchor);
  }
  getSnapshot(): NarrativeLiveSnapshot {
    const heard = this.hasHeardCallback ? [...this.segments].reverse().find((s) => s.startSeconds <= this.memory.frontierSeconds + EPS && s.effectiveEndSeconds > s.startSeconds + EPS) : undefined;
    const admitted = this.segments[this.segments.length - 1];
    return structuredClone({ version: 1, epoch: this.epoch, rawRequest: this.raw, stableRequest: this.stable, heard: heard ? this.position(heard) : null, admitted: admitted ? this.position(admitted) : null, memory: this.memory, pendingTransition: admitted && admitted.startSeconds > this.memory.frontierSeconds ? admitted.transition : null, lastTransition: this.lastTransition, modeBoundary: this.modeBoundary, admittedSegments: this.segments.length });
  }
}
