import {afterEach,expect,it,vi} from "vitest";
import {assertPerformanceTakeV3,compileExpressivePerformance,createTempoMap,evaluateExpressionLane} from "@onepage/music-core/expressive-performance";
import {createWeatherNarrativeDocument,WEATHER_NARRATIVE_FAMILIES} from "@onepage/music-core/weather-narrative";
import {ExpressiveStreamQueue} from "./expressive-stream";
import {createExpressiveAudioFixture} from "./expressive-fixture";
import {boundNarrativeNoteTails,NarrativeLiveAudioEngine} from "./narrative-live";
import {expressiveSynthRenderer} from "./expressive-synth";
afterEach(()=>vi.restoreAllMocks());
it("authors finite zero-gain bounded releases without modifying the cue",()=>{
  const source=compileExpressivePerformance(createWeatherNarrativeDocument({family:"fog",seed:17,bars:16}));
  const original=structuredClone(source),take=boundNarrativeNoteTails(source);
  expect(source).toEqual(original);assertPerformanceTakeV3(take);
  expect(take.notes.length).toBeGreaterThan(20);
  for(const n of take.notes){
    expect(n.termination).toBe("kill");
    const controls=take.controls.filter(c=>c.noteId===n.id);
    expect(evaluateExpressionLane(controls,"expression",n.endSeconds,1).value).toBe(0);
    expect(controls.find(c=>c.id.endsWith(":tail-fade"))!.rampSeconds).toBeGreaterThan(0);
  }
});
it("replaces only a future tempo/meter suffix atomically and rejects retiming an owned ending",()=>{
  const take=createExpressiveAudioFixture(),header={...take,notes:[],controls:[]};
  const queue=new ExpressiveStreamQueue(1,header,{rollingCaptureSeconds:120});
  queue.submit({epoch:1,revision:0,startSeconds:0,endSeconds:4,notes:take.notes,controls:take.controls});
  queue.take(.4);
  const prior=structuredClone(queue.template);
  const invalid={tempoMap:[{tick:0,microsecondsPerBeat:1000000}],meterMap:header.meterMap,lengthTicks:header.lengthTicks,instruments:header.instruments};
  expect(queue.submitTimelineWindow({epoch:1,revision:1,startSeconds:.4,endSeconds:4,notes:[],controls:[]},invalid).reason).toBe("timeline-retimes-committed-prefix");
  expect(queue.template).toEqual(prior);
  const boundary=3840;
  const tempoMap=[...header.tempoMap,{tick:boundary,microsecondsPerBeat:1000000}];
  const end=createTempoMap(header.ppq,tempoMap).tickToSeconds(7680);
  const valid={...invalid,tempoMap,meterMap:[...header.meterMap,{tick:boundary,numerator:3,denominator:4}],lengthTicks:7680};
  expect(queue.submitTimelineWindow({epoch:1,revision:1,startSeconds:.4,endSeconds:end,notes:[],controls:[]},valid).status).toBe("accepted");
  queue.take(end); const capture=queue.getCapturedTake();assertPerformanceTakeV3(capture);
  expect(capture.meterMap.at(-1)?.numerator).toBe(3);
});
it("streams clear into actual 3/4 fog, captures only heard attacks and restarts with a fresh clock header",async()=>{
  vi.spyOn(expressiveSynthRenderer,"renderVoice").mockImplementation((_ctx,_dest,_take,note,offset)=>({endContextTime:note.endSeconds+offset,updateControls(){},stop(){}}));
  const context={currentTime:0,state:"running",destination:{}};
  const docs=WEATHER_NARRATIVE_FAMILIES.map(family=>createWeatherNarrativeDocument({family,seed:1,bars:16}));
  const frontiers:number[]=[];
  const engine=await NarrativeLiveAudioEngine.create({audioContext:context as unknown as AudioContext,renderer:"synth",documents:docs,onHeardFrontier:s=>frontiers.push(s)});
  try {
    engine.begin();
    expect(engine.submitSegment({id:"clear",document:docs[0],startSeconds:0,revision:0}).status).toBe("accepted");
    for(let at=0;at<=.4;at+=.025){context.currentTime=at;engine.pump();}
    const protectedEnd=engine.getClock().protectedThroughSeconds;
    const receipt=engine.submitSegment({id:"fog",document:docs[1],startSeconds:protectedEnd+.25,replaceFromSeconds:protectedEnd,revision:1});
    expect(receipt.status,JSON.stringify(receipt)).toBe("accepted");
    for(let at=context.currentTime;at<=protectedEnd+2;at+=.025){context.currentTime=at;engine.pump();}
    const capture=engine.getCapturedTake();assertPerformanceTakeV3(capture);
    expect(capture.meterMap.at(-1)?.numerator).toBe(3);
    expect(capture.tempoMap.length).toBe(2);
    expect(capture.notes.every(n=>n.startSeconds<capture.durationSeconds)).toBe(true);
    expect(capture.provenance.captureHeardThroughSeconds).toBeLessThan(capture.durationSeconds+.002);
    expect(frontiers.length).toBeGreaterThan(0);
    engine.stop();
    engine.begin();
    expect(engine.submitSegment({id:"restart",document:docs[0],startSeconds:0,revision:0}).status).toBe("accepted");
    expect(engine.getClock().preparedThroughSeconds).toBeCloseTo(35.55555555);
  }finally{engine.dispose();}
});
it("protects silent committed time and instrument history from future timeline revisions",()=>{
  const take=createExpressiveAudioFixture(),header={...take,notes:[],controls:[]};
  const queue=new ExpressiveStreamQueue(1,header,{rollingCaptureSeconds:120});
  queue.submit({epoch:1,revision:0,startSeconds:0,endSeconds:4,notes:[],controls:[]});queue.take(1);
  const previous=structuredClone(queue.template);
  const window={epoch:1,revision:1,startSeconds:1,endSeconds:4,notes:[],controls:[]};
  const timeline={tempoMap:header.tempoMap,meterMap:header.meterMap,lengthTicks:header.lengthTicks,instruments:header.instruments};
  expect(queue.submitTimelineWindow(window,{...timeline,tempoMap:[{tick:0,microsecondsPerBeat:1000000}]}).reason).toBe("timeline-retimes-committed-prefix");
  const event={id:"original",partId:header.parts[0].id,bindingId:header.bindings[0].id,tick:0};
  queue.template.instruments=[event];
  expect(queue.submitTimelineWindow(window,{...timeline,instruments:[]}).reason).toBe("timeline-changes-committed-instrument");
  expect(queue.template).toEqual({...previous,instruments:[event]});
});
it("renders bounded releases through the real GeneralUser processor with no tail after cutoff",async()=>{
  const {readFileSync}=await import("node:fs");
  const {ExpressiveSoundfontProcessor}=await import("./expressive-soundfont-processor");
  const {createNarrativeSoundfontDocument}=await import("./narrative-soundfont");
  const manifest=(await import("../../../apps/weather-fronts/src/generaluser-manifest.json")).default;
  const bytes=Uint8Array.from(readFileSync("apps/weather-fronts/public/instruments/generaluser/GeneralUser-GS.sf2")).buffer;
  const document=createNarrativeSoundfontDocument(createWeatherNarrativeDocument({family:"fog",seed:1,bars:4}),{bank:{id:manifest.id,uri:`./instruments/generaluser/${manifest.file}`,sha256:manifest.sha256,license:manifest.license}});
  const take=boundNarrativeNoteTails(compileExpressivePerformance(document));
  const note=take.notes.find(n=>n.partId==="lead")!;
  const rate=22050,done:unknown[]=[];
  const processor=await ExpressiveSoundfontProcessor.create(rate,bytes,(...args)=>done.push(args));
  let peak=0,postCutoffPeak=0;
  try {
    processor.add({slot:0,note,take,offset:0,output:0});
    for(let frame=0;frame<(note.endSeconds+.1)*rate;frame+=128){
      const output=Array.from({length:4},()=>[new Float32Array(128),new Float32Array(128)]);
      processor.process(output,frame/rate);
      for(let i=0;i<128;i++){
        const value=Math.abs(output[0][0][i]);expect(Number.isFinite(value)).toBe(true);peak=Math.max(peak,value);
        if((frame+i)/rate>=note.endSeconds+.001)postCutoffPeak=Math.max(postCutoffPeak,value);
      }
    }
    expect(peak).toBeGreaterThan(.00001);expect(postCutoffPeak).toBe(0);expect(done.length).toBe(1);
  }finally{processor.dispose();}
});
it("keeps thirty minutes of changing future tempo/meter maps in a bounded rolling capture",()=>{
  const fixture=createExpressiveAudioFixture(),header={...fixture,notes:[],controls:[],instruments:[]};
  const queue=new ExpressiveStreamQueue(1,header,{rollingCaptureSeconds:120,maxHorizonSeconds:30});
  let seconds=0,tick=0;
  const tempos:typeof header.tempoMap=[],meters:typeof header.meterMap=[];
  for(let index=0;seconds<1800;index++){
    const microsecondsPerBeat=index%2?750000:500000;
    tempos.push({tick,microsecondsPerBeat});meters.push({tick,numerator:index%2?3:4,denominator:4});
    const endTick=tick+header.ppq*16,end=seconds+16*microsecondsPerBeat/1e6;
    const map=createTempoMap(header.ppq,tempos);
    const startTick=tick+header.ppq,endNoteTick=tick+header.ppq*3;
    const note={...fixture.notes[0],id:`n${index}`,startTick,keyReleaseTick:endNoteTick,endTick:endNoteTick,startSeconds:map.tickToSeconds(startTick),keyReleaseSeconds:map.tickToSeconds(endNoteTick),endSeconds:map.tickToSeconds(endNoteTick)};
    const receipt=queue.submitTimelineWindow({epoch:1,revision:index,startSeconds:seconds,endSeconds:end,notes:[note],controls:[]},{tempoMap:[...tempos],meterMap:[...meters],lengthTicks:endTick,instruments:[]});
    expect(receipt.status,receipt.reason).toBe("accepted");queue.take(end);seconds=end;tick=endTick;
  }
  const capture=queue.getCapturedTake();assertPerformanceTakeV3(capture);
  expect(capture.durationSeconds).toBeLessThan(135);expect(capture.notes.length).toBeLessThan(16);
  expect(capture.tempoMap.length).toBeLessThan(16);expect(capture.meterMap.some(m=>m.numerator===3)).toBe(true);
  expect(capture.provenance.rollingCapture).toBe(true);
});
it("rejects a duplicate event window carrying a different timeline without mutating admitted state",()=>{
  const fixture=createExpressiveAudioFixture(),header={...fixture,notes:[],controls:[],instruments:[]};
  const queue=new ExpressiveStreamQueue(1,header,{rollingCaptureSeconds:120});
  const window={epoch:1,revision:0,startSeconds:0,endSeconds:4,notes:[],controls:[]};
  const timeline={tempoMap:header.tempoMap,meterMap:header.meterMap,lengthTicks:header.lengthTicks,instruments:[]};
  expect(queue.submitTimelineWindow(window,timeline).status).toBe("accepted");
  const before=structuredClone(queue.template);
  expect(queue.submitTimelineWindow(window,{...timeline,tempoMap:[...header.tempoMap,{tick:1920,microsecondsPerBeat:1000000}]}).reason).toBe("conflicting-timeline-window");
  expect(queue.template).toEqual(before);expect(queue.preparedThroughSeconds).toBe(4);
});
it("does not repeatedly admit or reject an unchanged pending destination while the audio clock advances",async()=>{
  vi.useFakeTimers();
  vi.spyOn(expressiveSynthRenderer,"renderVoice").mockImplementation((_ctx,_dest,_take,note,offset)=>({endContextTime:note.endSeconds+offset,updateControls(){},stop(){}}));
  const context={currentTime:0,state:"running",destination:{},resume:async()=>{}};
  const {createNarrativeLivePlayback}=await import("./narrative-live");
  const playback=await createNarrativeLivePlayback({audioContext:context as unknown as AudioContext,renderer:"synth",seed:19});
  try{
    await playback.start();
    for(let index=1;index<=800;index++){
      context.currentTime=index*.025;vi.advanceTimersByTime(25);
      if(index>=80)playback.observe({family:"storm",intensity:.9});
      const receipt=playback.snapshot().lastReceipt;
      expect(receipt?.status,receipt?.reason).not.toBe("rejected");
    }
    const snapshot=playback.snapshot();
    expect(snapshot.heard?.family).toBe("storm");
    expect(snapshot.admittedSegments).toBeLessThanOrEqual(3);
    const capture=playback.capture();assertPerformanceTakeV3(capture);
    expect(capture.tempoMap.length).toBe(2);
    expect(capture.deviations.some(d=>d.kind==="renderer-failure"||d.kind==="coverage-underrun")).toBe(false);
  }finally{playback.dispose();vi.useRealTimers();}
});
it("quantizes off-grid future replacement bounds forward without rejecting an unowned silent frontier",async()=>{
  const context={currentTime:0,state:"running",destination:{}};
  const docs=WEATHER_NARRATIVE_FAMILIES.map(family=>createWeatherNarrativeDocument({family,seed:1,bars:16}));
  const engine=await NarrativeLiveAudioEngine.create({audioContext:context as unknown as AudioContext,renderer:"synth",documents:docs});
  try{
    engine.begin();expect(engine.submitSegment({id:"silent",document:{...docs[0],notes:[],controls:[]},startSeconds:0,revision:0}).status).toBe("accepted");
    context.currentTime=.20123;engine.pump();const frontier=engine.getClock().frontierSeconds;
    const receipt=engine.submitSegment({id:"offgrid",document:docs[1],startSeconds:frontier+.25,replaceFromSeconds:frontier,revision:1});
    expect(receipt.status,receipt.reason).toBe("accepted");
    expect(receipt.actualReplaceFromSeconds).toBeGreaterThanOrEqual(frontier);
    expect(receipt.actualReplaceFromSeconds!-frontier).toBeLessThan(.002);
    expect(receipt.actualStartSeconds).toBeGreaterThanOrEqual(frontier+.25);
  }finally{engine.dispose();}
});
