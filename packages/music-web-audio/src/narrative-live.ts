import {
  compileExpressivePerformance, createTempoMap, evaluateExpressionLane,
  type ExpressiveControlEvent,
  type PerformanceDocumentV1, type PerformanceTakeV3,
} from "@onepage/music-core/expressive-performance";
import { createWeatherNarrativeDocument, WEATHER_NARRATIVE_FAMILIES, type NarrativeFamily } from "@onepage/music-core/weather-narrative";
import { WeatherNarrativeLiveComposer, type NarrativeLiveRequest, type NarrativeLiveSegment } from "@onepage/music-core/weather-narrative-live";
import { ExpressiveAudioEngine } from "./expressive-engine";
import { expressiveSynthRenderer, type ExpressiveVoiceRenderer } from "./expressive-synth";
import { createNarrativeSoundfontDocument, type NarrativeSoundfontOptions } from "./narrative-soundfont";
import type { ExpressiveReceipt, ExpressiveTimelineRevision } from "./expressive-stream";

export interface NarrativeLiveAudioOptions {
  audioContext: AudioContext;
  destination?: AudioNode;
  documents: PerformanceDocumentV1[];
  renderer: "synth" | "gm";
  bank?: ArrayBuffer;
  bankIdentity?: NarrativeSoundfontOptions["bank"];
  onHeardFrontier?: (seconds: number) => void;
}
const FADE_SECONDS = 0.025;
const controlOrder = (a:ExpressiveControlEvent,b:ExpressiveControlEvent) => a.timeSeconds-b.timeSeconds || (a.order??0)-(b.order??0) || a.id.localeCompare(b.id);
function trimControls(controls:ExpressiveControlEvent[], cutoff:(c:ExpressiveControlEvent)=>number) {
  return controls.filter(c=>c.timeSeconds<=cutoff(c)).map(c=>{
    const end=cutoff(c);
    if(c.rampSeconds>0 && c.timeSeconds+c.rampSeconds>end) return {...c,value:evaluateExpressionLane(controls.filter(e=>e.partId===c.partId && e.noteId===c.noteId).sort(controlOrder),c.parameter,end,1).value,rampSeconds:end-c.timeSeconds};
    return c;
  });
}
/** Author a bounded fade into each owned note before its explicit cutoff. This
 * deliberately replaces natural GM tails for this new profile, in both replay
 * and live rendering. Historical expressive/Song 3 releases are unchanged. */
export function boundNarrativeNoteTails(take: PerformanceTakeV3): PerformanceTakeV3 {
  const bounded = structuredClone(take);
  for (const note of bounded.notes) {
    note.termination = "kill";
    const start = Math.max(note.startSeconds, note.endSeconds - FADE_SECONDS);
    const events = bounded.controls.filter(c => c.noteId === note.id && c.parameter === "expression").sort(controlOrder);
    const value = evaluateExpressionLane(events, "expression", start, 1).value;
    bounded.controls = bounded.controls.filter(c => !(c.noteId === note.id && c.parameter === "expression" && c.timeSeconds >= start));
    // A zero-duration anchor preserves the pre-fade level, including an interrupted authored ramp.
    bounded.controls.push(
      { id: `${note.id}:tail-anchor`, partId: note.partId, noteId: note.id, parameter: "expression", timeSeconds: start, value, rampSeconds: 0 },
      { id: `${note.id}:tail-fade`, partId: note.partId, noteId: note.id, parameter: "expression", timeSeconds: start, value: 0, rampSeconds: note.endSeconds - start, order: 1 },
    );
  }
  bounded.controls.sort(controlOrder);
  bounded.provenance.narrativeTailPolicy = { profile: "bounded-expression-release-v1", fadeSeconds: FADE_SECONDS, cutoff: "explicit-zero-gain-kill", naturalSoundfontTails: false };
  return bounded;
}
function secondsToAbsoluteTick(take: PerformanceTakeV3, seconds: number) {
  const clock = createTempoMap(take.ppq, take.tempoMap);
  const point = [...take.tempoMap].reverse().find(p => clock.tickToSeconds(p.tick) <= seconds)!;
  return point.tick + (seconds - clock.tickToSeconds(point.tick)) * take.ppq * 1e6 / point.microsecondsPerBeat;
}
function unique<T extends {id: string}>(items: T[]): T[] {
  const values = new Map<string, T>();
  for (const item of items) {
    const old = values.get(item.id);
    if (old && JSON.stringify(old) !== JSON.stringify(item)) throw Error(`Conflicting narrative resource ${item.id}`);
    values.set(item.id, item);
  }
  return [...values.values()];
}
export class NarrativeLiveAudioEngine {
  private readonly engine: ExpressiveAudioEngine;
  private header: PerformanceTakeV3;
  private epoch = 0;
  private readonly initialHeader:PerformanceTakeV3;
  private stoppedAt:number|null=null;
  private constructor(private readonly options: NarrativeLiveAudioOptions, header: PerformanceTakeV3, renderer: ExpressiveVoiceRenderer) {
    this.header = header;
    this.initialHeader=structuredClone(header);
    this.engine = new ExpressiveAudioEngine({audioContext: options.audioContext, destination: options.destination, renderer});
  }
  static async create(options: NarrativeLiveAudioOptions) {
    if (!options.documents.length) throw Error("Narrative playback requires prepared family documents");
    const docs = options.documents.map(d => {
      if (options.renderer === "gm") {
        if (!options.bank || !options.bankIdentity) throw Error("GM narrative playback requires bank bytes and frozen identity");
        return createNarrativeSoundfontDocument(d, {bank: options.bankIdentity});
      }
      return structuredClone(d);
    });
    const takes = docs.map(d => compileExpressivePerformance(d, options.renderer === "gm" ? "expressive-gm-live-1" : "expressive-synth-v1"));
    const header = {...takes[0], id: "weather-narrative-live-v1", notes: [], controls: [], instruments: [],
      bindings: unique(takes.flatMap(t => t.bindings)), resources: unique(takes.flatMap(t => t.resources)),
      provenance: {...takes[0].provenance, liveNarrative: true, narrativeTailPolicy: {profile: "bounded-expression-release-v1", fadeSeconds: FADE_SECONDS, cutoff: "explicit-zero-gain-kill", naturalSoundfontTails: false}},
    };
    for (const take of takes) {
      if (take.ppq !== header.ppq) throw Error("Narrative PPQ must be shared");
      for (const part of take.parts) {
        const prepared = header.parts.find(p => p.id === part.id);
        if (!prepared || JSON.stringify({...prepared,name:""}) !== JSON.stringify({...part,name:""})) throw Error("Narrative part state must be shared");
      }
    }
    let renderer = expressiveSynthRenderer;
    if (options.renderer === "gm") {
      const {prepareExpressiveSoundfontLiveRenderer} = await import("./expressive-soundfont-live");
      renderer = await prepareExpressiveSoundfontLiveRenderer(header, {bank: options.bank!});
    }
    await renderer.prepareContext?.(options.audioContext, header);
    return new NarrativeLiveAudioEngine(options, header, renderer);
  }
  begin() {
    this.header=structuredClone(this.initialHeader);
    this.stoppedAt=null;
    this.epoch = this.engine.begin({take: this.header, maxHorizonSeconds:120, maxPendingNotes:4096, maxWindowControls:16384, rollingCaptureSeconds:120, onHeardFrontier:this.options.onHeardFrontier});
    return this.epoch;
  }
  submitSegment(segment: Pick<NarrativeLiveSegment, "id" | "document" | "startSeconds" | "revision"> & {replaceFromSeconds?:number}) : ExpressiveReceipt & {actualStartSeconds?:number;actualReplaceFromSeconds?:number} {
    const state = this.engine.getClock();
    const reject = (reason:string): ExpressiveReceipt => ({epoch:this.epoch,status:"rejected",reason});
    if (!state.running) return reject("stale-or-stopped");
    const previous = this.header;
    const startTick = Math.ceil(secondsToAbsoluteTick(previous, segment.startSeconds) - 1e-8);
    const start = createTempoMap(previous.ppq, previous.tempoMap).tickToSeconds(startTick);
    const replaceTick = Math.ceil(secondsToAbsoluteTick(previous, segment.replaceFromSeconds ?? segment.startSeconds) - 1e-8);
    const replace = createTempoMap(previous.ppq, previous.tempoMap).tickToSeconds(replaceTick);
    if (replace < state.frontierSeconds - 1e-7 || start < replace) return reject("replacement-before-frontier");
    const doc = this.options.renderer === "gm" ? createNarrativeSoundfontDocument(segment.document, {bank:this.options.bankIdentity!}) : segment.document;
    const local = boundNarrativeNoteTails(compileExpressivePerformance(doc, previous.renderingProfile));
    for (const resource of local.resources)
      if (!previous.resources.some(r => r.id === resource.id && JSON.stringify(r) === JSON.stringify(resource))) return reject("unprepared-narrative-resource");
    const prefix = `${segment.id}:`;
    const incomingNotes = local.notes.map(n => ({...n,id:prefix+n.id,startTick:n.startTick+startTick,keyReleaseTick:n.keyReleaseTick+startTick,endTick:n.endTick+startTick,startSeconds:n.startSeconds+start,keyReleaseSeconds:n.keyReleaseSeconds+start,endSeconds:n.endSeconds+start}));
    const incomingControls = local.controls.map(c => ({...c,id:prefix+c.id,...(c.noteId?{noteId:prefix+c.noteId}:{}),timeSeconds:c.timeSeconds+start,...(c.sourceTick!==undefined?{sourceTick:c.sourceTick+startTick}:{})}));
    const pending = this.engine.getPendingEvents();
    const retainedNotes = pending.notes.filter(n => n.startSeconds < replace).map(n => n.endSeconds > replace ? {...n,endTick:replaceTick,keyReleaseTick:Math.min(n.keyReleaseTick,replaceTick),endSeconds:replace,keyReleaseSeconds:Math.min(n.keyReleaseSeconds,replace)} : n);
    const ids = new Set(retainedNotes.map(n=>n.id));
    const retainedControls=pending.controls.filter(c => c.noteId ? ids.has(c.noteId) && !c.id.endsWith(":tail-anchor") && !c.id.endsWith(":tail-fade") : c.timeSeconds < replace);
    const retained = boundNarrativeNoteTails({...previous,notes:retainedNotes,controls:trimControls(retainedControls,c=>c.noteId ? retainedNotes.find(n=>n.id===c.noteId)!.endSeconds : replace)});
    const timeline:ExpressiveTimelineRevision = {
      tempoMap: [...previous.tempoMap.filter(p=>p.tick<startTick),...local.tempoMap.map(p=>({...p,tick:p.tick+startTick}))],
      meterMap: [...previous.meterMap.filter(p=>p.tick<startTick),...local.meterMap.map(p=>({...p,tick:p.tick+startTick}))],
      instruments: [...previous.instruments.filter(p=>p.tick<replaceTick),...local.instruments.map(p=>({...p,id:prefix+p.id,tick:p.tick+startTick}))],
      lengthTicks:startTick+local.lengthTicks,
    };
    const end = start + local.durationSeconds;
    const receipt = this.engine.submitTimelineWindow({epoch:this.epoch,revision:segment.revision,startSeconds:state.frontierSeconds,endSeconds:end,notes:[...retained.notes,...incomingNotes],controls:[...retained.controls,...incomingControls]},timeline);
    if (receipt.status === "accepted") this.header = {...previous,...timeline,durationSeconds:end};
    return {...receipt,actualStartSeconds:start,actualReplaceFromSeconds:replace};
  }
  pump() {this.engine.pump();}
  getClock() {return this.engine.getClock();}
  getSnapshot() {return this.engine.getSnapshot();}
  getCapturedTake() {
    const take=this.engine.getCapturedTake();
    const clock=this.engine.getClock();
    const origin=Number(take.provenance.captureOriginSeconds??0);
    const heard=Math.max(0,(this.stoppedAt??clock.positionSeconds)-origin);
    const cutoffTick=Math.max(1,Math.floor(secondsToAbsoluteTick(take,heard)));
    const cutoff=createTempoMap(take.ppq,take.tempoMap).tickToSeconds(cutoffTick);
    const interrupted=take.notes.some(n=>n.startSeconds<cutoff && n.endSeconds>cutoff);
    take.notes=take.notes.filter(n=>n.startSeconds<Math.min(cutoff,heard)).map(n=>n.endSeconds>cutoff ? {...n,endTick:cutoffTick,keyReleaseTick:Math.min(n.keyReleaseTick,cutoffTick),endSeconds:cutoff,keyReleaseSeconds:Math.min(n.keyReleaseSeconds,cutoff),termination:"kill" as const}:n);
    const ids=new Set(take.notes.map(n=>n.id));
    take.controls=trimControls(take.controls.filter(c=>!c.noteId||ids.has(c.noteId)),()=>cutoff);
    take.lengthTicks=cutoffTick; take.durationSeconds=cutoff;
    take.tempoMap=take.tempoMap.filter(p=>p.tick<cutoffTick);
    take.meterMap=take.meterMap.filter(p=>p.tick<cutoffTick);
    take.instruments=take.instruments.filter(p=>p.tick<=cutoffTick);
    take.deviations=take.deviations.filter(d=>d.timeSeconds<=cutoff+60);
    take.provenance.captureHeardThroughSeconds=heard;
    take.provenance.captureCutoffQuantizationSeconds=heard-cutoff;
    if(interrupted && !take.deviations.some(d=>d.kind==="stopped")) take.deviations.push({kind:"capture-interrupted",timeSeconds:cutoff,reason:"Capture ends inside a sounding owned note; cutoff quantized by less than one tick. Planned replay only."});
    return take;
  }
  endStream() {this.engine.endStream();}
  stop() {this.stoppedAt=this.engine.getClock().positionSeconds;this.engine.stop();}
  dispose() {this.engine.dispose();}
}

export interface NarrativeLivePlaybackOptions extends Omit<NarrativeLiveAudioOptions,"documents"|"onHeardFrontier"> {
  seed?:number;
  onChange?:()=>void;
}
/** One lifecycle owner couples pure weather decisions to actual audio admissions. */
export async function createNarrativeLivePlayback(options:NarrativeLivePlaybackOptions) {
  let composer = new WeatherNarrativeLiveComposer({seed:options.seed??1});
  let lastReceipt:ExpressiveReceipt|null = null;
  let active=false, timer:ReturnType<typeof setInterval>|undefined;
  const audio = await NarrativeLiveAudioEngine.create({...options, documents:WEATHER_NARRATIVE_FAMILIES.map(family=>createWeatherNarrativeDocument({family,seed:options.seed??1,bars:16})),onHeardFrontier:seconds=>composer.advanceHeard(seconds)});
  const tick = () => {
    if (!active) return;
    const clock=audio.getClock();
    if (!clock.running) {active=false; if(timer)clearInterval(timer); options.onChange?.(); return;}
    const segment=composer.plan({nowSeconds:clock.positionSeconds,committedThroughSeconds:clock.frontierSeconds,protectedThroughSeconds:clock.protectedThroughSeconds});
    if(segment) {
      lastReceipt=audio.submitSegment(segment);
      if(lastReceipt.status === "accepted") {
        const timing=lastReceipt as ExpressiveReceipt & {actualStartSeconds:number;actualReplaceFromSeconds:number};
        composer.admit(segment,{startSeconds:timing.actualStartSeconds,replaceFromSeconds:timing.actualReplaceFromSeconds});
      }
    }
    audio.pump(); options.onChange?.();
  };
  return {
    async start(initialFamily:NarrativeFamily="clear") {
      if(active)return;
      await options.audioContext.resume();
      composer=new WeatherNarrativeLiveComposer({seed:options.seed??1,initialFamily});
      audio.begin(); active=true; tick(); timer=setInterval(tick,25);
    },
    observe(request:NarrativeLiveRequest) {composer.observe(request,audio.getClock().positionSeconds);tick();},
    snapshot() {return {...composer.getSnapshot(),audio:audio.getSnapshot(),lastReceipt,active};},
    capture() {return audio.getCapturedTake();},
    stop() {active=false;if(timer)clearInterval(timer);timer=undefined;audio.stop();options.onChange?.();},
    dispose() {active=false;if(timer)clearInterval(timer);timer=undefined;audio.dispose();},
  };
}
