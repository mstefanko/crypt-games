import { describe, expect, it } from "vitest";
import { assertPerformanceDocument, compileExpressivePerformance, createTempoMap } from "./expressive-performance";
import { MODE_INTERVALS } from "./tonality";
import { createNarrativeMemory, admitNarrativeMemoryEvent, advanceNarrativeMemory, cancelNarrativeMemoryRevision, assertNarrativeMemory, selectNarrativeRecall, type NarrativeMemoryEventV1 } from "./weather-narrative-memory";
import { WEATHER_NARRATIVE_FAMILIES, NARRATIVE_CUE_BUNDLES, WORLD_SIGNATURE_V1, createWeatherNarrativeDocument, createWeatherNarrativeJourney, createNarrativeModeState, observeNarrativeModeBoundary, transformNarrativeSignature, narrativeDegreePitch, type NarrativeDocumentMetadataV1 } from "./weather-narrative";
import { NARRATIVE_TRANSITION_GRAPH, harmonicTransitionFeatures, planNarrativeTransition, type NarrativeTransitionRequest } from "./weather-narrative-transition";
const metadata = (d: ReturnType<typeof createWeatherNarrativeDocument>) => d.provenance.weatherNarrative as NarrativeDocumentMetadataV1;

describe("original narrative cue documents", () => {
  it("generates reproducible, closed, renderable material for every family over several seeds", () => {
    for (const family of WEATHER_NARRATIVE_FAMILIES) for (const seed of [1,17,985]) {
      const d = createWeatherNarrativeDocument({ family, seed });
      assertPerformanceDocument(d);
      expect(d).toEqual(createWeatherNarrativeDocument({ family, seed }));
      const take = compileExpressivePerformance(d);
      expect(take.notes.length).toBeGreaterThan(20);
      expect(take.durationSeconds).toBeCloseTo(16 * NARRATIVE_CUE_BUNDLES[family].meter.numerator * 60 / NARRATIVE_CUE_BUNDLES[family].tempoBpm);
      expect(metadata(d).tonicPitchClass).toBe(0);
      expect(metadata(d).listeningApproved).toBe(false);
      // A synth releases once after endSeconds, and finishes before the declared cue entry.
      for (const note of take.notes) {
        const resource = d.resources.find((r) => r.id === d.bindings.find((b) => b.id === note.bindingId)!.resourceId)!;
        expect(note.endTick).toBe(note.keyReleaseTick);
        expect(note.endSeconds + resource.patch!.release).toBeLessThan(take.durationSeconds);
      }
    }
  });
  it("uses real 3/4 fog, cross-bar sustains, empty melody bars, and less dense attacks", () => {
    const fog = createWeatherNarrativeDocument({ family: "fog" });
    const storm = createWeatherNarrativeDocument({ family: "storm" });
    expect(fog.meterMap[0]).toEqual({tick:0,numerator:3,denominator:4});
    expect(fog.lengthTicks).toBe(16 * 3 * 480);
    expect(fog.notes.some((n) => n.endTick - n.startTick > 3 * 480)).toBe(true);
    const occupied = new Set(fog.notes.filter((n) => n.partId === "lead").map((n) => Math.floor(n.startTick / 1440)));
    expect(occupied.size).toBeLessThan(12);
    expect(storm.notes.length).toBeGreaterThan(fog.notes.length * 4);
  });
  it("adopts requested permitted modes immediately; intensity cannot choose family or mode", () => {
    const darkRain = createWeatherNarrativeDocument({ family: "rain", mode: "aeolian", intensity: 1 });
    expect(metadata(darkRain).committedMode).toBe("aeolian");
    expect(darkRain.notes.filter((n) => n.partId !== "percussion").every((n) => (MODE_INTERVALS.aeolian as readonly number[]).includes(n.pitch % 12))).toBe(true);
    expect(() => createWeatherNarrativeDocument({ family: "fog", mode: "ionian" })).toThrow();
    const light = createWeatherNarrativeDocument({ family: "rain", intensity: 0 });
    const strong = createWeatherNarrativeDocument({ family: "rain", intensity: 1 });
    expect(metadata(light).mode).toBe(metadata(strong).mode);
    expect(light.notes.map((n) => [n.startTick,n.pitch])).toEqual(strong.notes.map((n) => [n.startTick,n.pitch]));
  });
  it("separates compositional material from real palette changes and same-tonic foils", () => {
    const intended = createWeatherNarrativeDocument({ family: "clear", seed: 17 });
    const neutral = createWeatherNarrativeDocument({ family: "clear", seed: 17, palette: "neutral" });
    expect(intended.notes.map((n) => [n.pitch,n.startTick,n.keyReleaseTick])).toEqual(neutral.notes.map((n) => [n.pitch,n.startTick,n.keyReleaseTick]));
    expect(new Set(intended.resources.map((r) => r.patch!.waveform)).size).toBeGreaterThan(2);
    expect(new Set(neutral.resources.map((r) => r.patch!.waveform))).toEqual(new Set(["triangle"]));
    const foil = createWeatherNarrativeDocument({ family: "clearing", signature: "foil" });
    const original = createWeatherNarrativeDocument({ family: "clearing" });
    expect(metadata(foil).tonicPitchClass).toBe(metadata(original).tonicPitchClass);
    expect(foil.resources).toEqual(original.resources);
    expect(metadata(foil).signatureId).not.toBe(metadata(original).signatureId);
    expect(metadata(foil).cadence.recipe).toBe("IV-ii-I");
    expect(metadata(original).cadence.voicings).toEqual([[48,51,56],[50,53,58],[48,52,55]]);
    expect(createWeatherNarrativeDocument({ family:"storm", composition:"shared-melody" }).notes).not.toEqual(createWeatherNarrativeDocument({ family:"storm" }).notes);
  });
  it("varies actual melody with seed while preserving the world signature", () => {
    const a = createWeatherNarrativeDocument({family:"clear",seed:1}), b = createWeatherNarrativeDocument({family:"clear",seed:14});
    expect(a.notes.filter((n) => n.partId === "lead").map((n) => [n.startTick,n.pitch])).not.toEqual(b.notes.filter((n) => n.partId === "lead").map((n) => [n.startTick,n.pitch]));
    expect(metadata(a).signatureOccurrences.map((s) => s.pitches)).toEqual(metadata(b).signatureOccurrences.map((s) => s.pitches));
  });
  it("records only a motif actually emitted and recalls its audible rhythm before closing its real obligation", () => {
    const storm = createWeatherNarrativeDocument({family:"storm",seed:14});
    const meta = metadata(storm), candidate = meta.memoryCandidate!;
    const notes = storm.notes.filter((n) => n.id.includes("remembered-angular-cell"));
    expect(notes.map((n) => n.pitch)).toEqual(candidate.motifDegrees.map((d) => narrativeDegreePitch(d,candidate.mode,4)));
    expect(notes.slice(1).map((n,i) => (n.startTick - notes[i].startTick)/480)).toEqual(candidate.motifGaps);
    let memory = createNarrativeMemory();
    memory = admitNarrativeMemoryEvent(memory,{id:"heard-storm",epoch:1,revision:1,audibleAtSeconds:10,action:{type:"remember",phrase:candidate}});
    memory = advanceNarrativeMemory(memory,11);
    const returning = createWeatherNarrativeDocument({family:"clearing",memory});
    expect(metadata(returning).recall?.phraseId).toBe(candidate.phraseId);
    const recalled = returning.notes.filter((n) => n.id.includes(":recalled:"));
    expect(recalled.map((n) => n.pitch)).toEqual(candidate.motifDegrees.map((d) => narrativeDegreePitch(d,"ionian")));
    expect(recalled.slice(1).map((n,i) => (n.startTick-recalled[i].startTick)/480)).toEqual(candidate.motifGaps);
    const resolution = returning.notes.find((n) => n.id.includes("tonic-resolution"))!;
    expect(resolution.pitch).toBe(72);
    expect(resolution.startTick).toBe(metadata(returning).recall!.resolutionTick);
    expect(returning.id).not.toBe(createWeatherNarrativeDocument({family:"clearing"}).id);
    expect(memory.pending[0].status).toBe("interrupted"); // composition alone never marks a heard resolution
  });
  it("describes the actual heard ending pitch, borrowing and frontier, including fog and foil", () => {
    for (const family of ["storm", "fog"] as const) for (const seed of [1,8,14]) {
      const doc = createWeatherNarrativeDocument({family,seed,signature:"foil"});
      const meta = metadata(doc), candidate = meta.memoryCandidate!;
      const finalLead = doc.notes.filter((n) => n.partId === "lead" || n.partId === "traveler").sort((a,b) => b.startTick-a.startTick)[0];
      expect(candidate.endingMelodicPitch).toBe(finalLead.pitch);
      expect(candidate.signatureId).toBe("weather-foil-world-v1");
      expect(meta.memoryCandidateAudibleTick).toBeGreaterThanOrEqual(finalLead.keyReleaseTick);
      const scale = MODE_INTERVALS[candidate.mode];
      expect((scale[(candidate.endingMelodicDegree - 1) % 7] + candidate.endingAlterationSemitones!) % 12).toBe(finalLead.pitch % 12);
    }
    const phrygian = createWeatherNarrativeDocument({family:"storm",mode:"phrygian"});
    expect(phrygian.notes.filter((n) => n.partId !== "percussion").every((n) => (MODE_INTERVALS.phrygian as readonly number[]).includes(n.pitch % 12))).toBe(true);
    expect(metadata(phrygian).memoryCandidate?.intendedClosure).toBe("pedal");
    expect(metadata(phrygian).cadence.borrowed).toBe(false);
  });
  it("builds a frozen mixed-tempo/meter journey with faithful compiler timing and explicit offline memory evidence", () => {
    const d = createWeatherNarrativeJourney({seed:8,barsPerCue:8});
    const take = compileExpressivePerformance(d);
    expect(d.tempoMap.map((p) => Math.round(60000000 / p.microsecondsPerBeat))).toEqual([108,72,81,144,108]);
    expect(d.meterMap.map((p) => p.numerator)).toEqual([4,3,4,4,4]);
    const meta = d.provenance.weatherNarrative as {segments:(NarrativeDocumentMetadataV1&{startTick:number;endTick:number;startSeconds:number;endSeconds:number})[];memoryEvidence:string;memorySimulation:ReturnType<typeof createNarrativeMemory>};
    const map = createTempoMap(d.ppq,d.tempoMap);
    for (const segment of meta.segments) {
      expect(map.tickToSeconds(segment.startTick)).toBeCloseTo(segment.startSeconds,8);
      expect(map.tickToSeconds(segment.endTick)).toBeCloseTo(segment.endSeconds,8);
      expect(map.secondsToTick(segment.startSeconds)).toBeCloseTo(segment.startTick,8);
    }
    expect(meta.memoryEvidence).toBe("offline-symbolic-frontiers-only");
    expect(meta.memorySimulation.fulfilled?.sourceFamily).toBe("storm");
    expect(meta.segments[4].recall?.phraseId).toBe(meta.segments[3].memoryCandidate?.phraseId);
    expect(new Set(take.notes.map((n) => n.id)).size).toBe(take.notes.length);
    assertPerformanceDocument(createWeatherNarrativeJourney({families:["clear","clear","storm","clearing"],barsPerCue:8}));
  });
});

describe("world signature and local modal boundaries", () => {
  it("deeply freezes the shared versioned signature, cue catalog and transition graph", () => {
    expect(Object.isFrozen(WORLD_SIGNATURE_V1.motif.degrees)).toBe(true);
    expect(Object.isFrozen(WORLD_SIGNATURE_V1.cadence.homeReturn)).toBe(true);
    expect(Object.isFrozen(NARRATIVE_CUE_BUNDLES.clear.meter)).toBe(true);
    expect(Object.isFrozen(NARRATIVE_TRANSITION_GRAPH[0].allowedExits)).toBe(true);
    expect(() => (NARRATIVE_CUE_BUNDLES.clear.meter.numerator = 3)).toThrow();
  });
  it("preserves contour, modal degrees and whole-cell rhythm ratios", () => {
    for (const mode of ["ionian","aeolian","dorian"] as const) for (const rhythmScale of [.5,1,2] as const) {
      const t = transformNarrativeSignature({mode,rhythmScale});
      expect(t.degrees).toEqual([1,2,5,3]);
      expect(t.onsetPulses).toEqual([0,1,2,4].map((n) => n * rhythmScale));
      expect(t.pitches[1]).toBeGreaterThan(t.pitches[0]);
      expect(t.pitches[2]).toBeGreaterThan(t.pitches[1]);
      expect(t.pitches[3]).toBeLessThan(t.pitches[2]);
      expect(t.signatureId).toBe(WORLD_SIGNATURE_V1.id);
    }
    expect(transformNarrativeSignature({mode:"mixolydian",fragment:[2,4]}).onsetPulses).toEqual([0,2]);
    expect(() => transformNarrativeSignature({mode:"ionian",fragment:[0,1]})).toThrow();
  });
  it("requires two agreed phrase observations and compatible held tones before committing", () => {
    let state = createNarrativeModeState("rain");
    state = observeNarrativeModeBoundary(state,"aeolian",[9]);
    expect(state.committed).toBe("dorian");
    state = observeNarrativeModeBoundary(state,"aeolian",[9]);
    expect(state.requested).toBe("aeolian");
    expect(state.committed).toBe("dorian");
    state = observeNarrativeModeBoundary(state,"aeolian",[0,7]);
    expect(state.committed).toBe("aeolian");
    expect(() => observeNarrativeModeBoundary(state,"phrygian")).toThrow();
  });
});

function remember(id: string, at: number, priority = 1): NarrativeMemoryEventV1 {
  return {id,epoch:1,revision:1,audibleAtSeconds:at,action:{type:"remember",phrase:{phraseId:id,sourceFamily:"storm",signatureId:WORLD_SIGNATURE_V1.id,variationSeed:4,motifDegrees:[1,6,2,5],motifGaps:[.5,.5,1],tonicPitchClass:0,mode:"aeolian",endingVoicing:[47,50,55],endingMelodicDegree:7,intendedClosure:"dominant-tonic",status:"interrupted",priority,admissionRevision:1,epoch:1}}};
}
describe("heard narrative memory", () => {
  it("admits future events without remembering them, and cancelled revisions never become heard", () => {
    const future = admitNarrativeMemoryEvent(createNarrativeMemory(),remember("future",10));
    expect(future.pending).toHaveLength(0);
    expect(advanceNarrativeMemory(future,9).pending).toHaveLength(0);
    expect(advanceNarrativeMemory(cancelNarrativeMemoryRevision(future,1,1),20).pending).toHaveLength(0);
    const heard = advanceNarrativeMemory(future,10);
    expect(cancelNarrativeMemoryRevision(heard,1,1).pending[0].phraseId).toBe("future");
  });
  it("rejects a substitute home-return closure and resolves only after matching admitted closure sounds", () => {
    let m = advanceNarrativeMemory(admitNarrativeMemoryEvent(createNarrativeMemory(),remember("a",1)),1);
    m = admitNarrativeMemoryEvent(m,{id:"wrong",epoch:1,revision:1,audibleAtSeconds:2,action:{type:"resolve",phraseId:"a",closure:"home-return"}});
    m = advanceNarrativeMemory(m,2);
    expect(m.pending).toHaveLength(1);
    m = admitNarrativeMemoryEvent(m,{id:"right",epoch:1,revision:1,audibleAtSeconds:4,action:{type:"resolve",phraseId:"a",closure:"dominant-tonic"}});
    expect(advanceNarrativeMemory(m,3).fulfilled).toBeNull();
    m = advanceNarrativeMemory(m,4);
    expect(m.pending).toHaveLength(0);
    expect(m.fulfilled?.status).toBe("resolved");
  });
  it("expires records and explicitly abandons the oldest lowest-priority overflow", () => {
    let m = createNarrativeMemory(120);
    for (let i = 0; i < 5; i++) m = admitNarrativeMemoryEvent(m,remember(`p${i}`,i + 1,i === 0 ? 3 : 1));
    m = advanceNarrativeMemory(m,5);
    expect(m.pending).toHaveLength(4);
    expect(m.abandoned[0]).toMatchObject({phraseId:"p1",reason:"overflow"});
    expect(selectNarrativeRecall(m)?.phraseId).toBe("p4");
    m = advanceNarrativeMemory(m,126);
    expect(m.pending).toHaveLength(0);
    expect(m.abandoned.some((a) => a.reason === "expired")).toBe(true);
    expect(() => advanceNarrativeMemory(m,125)).toThrow();
  });
  it("validates serialized material and bounded admission provenance", () => {
    const e = remember("bad",1);
    if(e.action.type !== "remember") throw Error();
    e.action.phrase.motifGaps[0] = Infinity;
    expect(() => admitNarrativeMemoryEvent(createNarrativeMemory(),e)).toThrow();
    expect(() => admitNarrativeMemoryEvent(createNarrativeMemory(),{...remember("bad",1),revision:-1})).toThrow();
    const m = advanceNarrativeMemory(admitNarrativeMemoryEvent(createNarrativeMemory(),remember("x",1)),1);
    m.pending[0].status="resolved";
    expect(() => assertNarrativeMemory(JSON.parse(JSON.stringify(m)))).toThrow();
  });
});

const request = (overrides: Partial<NarrativeTransitionRequest> = {}): NarrativeTransitionRequest => ({source:"clear",destination:"rain",observedAtSeconds:8,stableAtSeconds:9,nowSeconds:9,committedThroughSeconds:9.4,lastEntrySeconds:0,sourceBarSeconds:2.22,nextUncommittedBeatSeconds:9.5,meterChanges:false,exits:[{atSeconds:12,sourceBarsFromRequest:1.5,exitClass:"phrase",sourceVoicing:[48,52,55],destinationVoicing:[48,51,55],approvedOverlap:true,approvedCadence:true}],...overrides});
describe("authored narrative transition planning", () => {
  it("covers all family edges and uses approved cadences with accurate entry latency", () => {
    expect(NARRATIVE_TRANSITION_GRAPH).toHaveLength(25);
    const plan = planNarrativeTransition(request());
    expect(plan.strategy).toBe("cadence-pickup");
    expect(plan.responseSeconds).toBe(3);
    expect(plan.budgetMet).toBe(true);
    expect(plan.tailPolicy).toBe("release-before-entry");
  });
  it("counts bridge duration, source bars, admission horizon and ordinary dwell in deadlines", () => {
    const tooLate = planNarrativeTransition(request({committedThroughSeconds:18}));
    expect(tooLate.strategy).toBe("breath-pickup");
    expect(tooLate.budgetMet).toBe(false);
    const bridge = planNarrativeTransition(request({exits:[{atSeconds:16.7,sourceBarsFromRequest:3.5,exitClass:"open",sourceVoicing:[48,52,55],destinationVoicing:[48,51,55],approvedOverlap:true,bridgeSeconds:.5}]}));
    expect(bridge.strategy).toBe("breath-pickup");
    const bars = planNarrativeTransition(request({sourceBarSeconds:1,exits:[{atSeconds:13.1,sourceBarsFromRequest:4.1,exitClass:"phrase",sourceVoicing:[48,52,55],destinationVoicing:[48,51,55],approvedOverlap:true,approvedCadence:true}]}));
    expect(bars.strategy).toBe("breath-pickup");
    expect(planNarrativeTransition(request({lastEntrySeconds:8})).exitSeconds).toBeGreaterThanOrEqual(16);
  });
  it("requires actual common tones plus explicit author approval and releases through meter changes", () => {
    const open = {atSeconds:12,sourceBarsFromRequest:1,exitClass:"open" as const,sourceVoicing:[48,52,55],destinationVoicing:[48,51,55],approvedOverlap:true};
    expect(planNarrativeTransition(request({exits:[open]})).strategy).toBe("pedal-bridge");
    expect(planNarrativeTransition(request({meterChanges:true,exits:[open]})).strategy).toBe("breath-pickup");
    const pole = {...open,destinationVoicing:[47,51,56],bridgeSeconds:1.5};
    const breath = planNarrativeTransition(request({exits:[pole]}));
    expect(breath.strategy).toBe("breath-pickup");
    expect(breath.entrySeconds - breath.exitSeconds).toBe(.25);
    expect(planNarrativeTransition(request({exits:[{...open,exitClass:"phrase",approvedOverlap:false}]})).strategy).toBe("breath-pickup");
  });
  it("bypasses dwell for urgent events, preserves committed attacks and reports impossible one-second budgets", () => {
    const urgent = planNarrativeTransition(request({urgent:true,lastEntrySeconds:8,nextUncommittedBeatSeconds:9.5}));
    expect(urgent.strategy).toBe("urgent-accent");
    expect(urgent.budgetMet).toBe(true);
    expect(urgent.seam.abruptness).toBe("designed-cutoff");
    const late = planNarrativeTransition(request({urgent:true,committedThroughSeconds:12,nextUncommittedBeatSeconds:9.5,beatSeconds:.5}));
    expect(late.exitSeconds).toBe(12);
    expect(late.budgetMet).toBe(false);
    expect(() => planNarrativeTransition(request({urgent:true,committedThroughSeconds:12}))).toThrow();
  });
  it("keeps common-tone similarity separate from minimum registered motion", () => {
    expect(harmonicTransitionFeatures([48,52,55],[48,51,55])).toMatchObject({commonPitchClasses:2,minimumSemitoneMovement:1});
    expect(harmonicTransitionFeatures([48,52,55],[47,51,56])).toMatchObject({commonPitchClasses:0,minimumSemitoneMovement:3});
  });
});
