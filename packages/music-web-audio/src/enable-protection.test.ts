import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AudioEngine } from "./index";
const deferred=()=>{let resolve!:()=>void,reject!:(reason:Error)=>void;const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
class Node {
  outputs=new Set<Node>();
  gain={value:1,setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn(),cancelScheduledValues:vi.fn()};
  port={postMessage:vi.fn(),onmessage:null};
  connect=(destination:Node)=>{this.outputs.add(destination);return destination;};
  disconnect=(destination?:Node)=>{if(destination)this.outputs.delete(destination);else this.outputs.clear();};
  addEventListener=vi.fn();
}
class Context {
  static instances:Context[]=[];
  state="suspended";currentTime=0;sampleRate=48000;destination=new Node();nodes:Node[]=[];
  onstatechange:(()=>void)|null=null;
  module=deferred();
  audioWorklet={addModule:vi.fn(()=>this.module.promise)};
  constructor(){Context.instances.push(this);}
  createGain(){const node=new Node();this.nodes.push(node);return node;}
  resume=vi.fn(async()=>{this.state="running";});
  close=vi.fn(async()=>{this.state="closed";});
}
class Worklet extends Node {constructor(context:Context){super();context.nodes.push(this);}}
const incoming=(context:Context)=>context.nodes.filter(node=>node.outputs.has(context.destination));
beforeEach(()=>{Context.instances=[];vi.stubGlobal("AudioContext",Context);vi.stubGlobal("AudioWorkletNode",Worklet);});
afterEach(()=>vi.unstubAllGlobals());
it("overlapping enable calls await one protected graph before any environment tap can attach",async()=>{
  const engine=new AudioEngine();engine.setMixProfile("weather-protected-1");
  const first=engine.enable(),context=Context.instances[0];let secondReady=false;
  const second=engine.enable().then(()=>{secondReady=true;engine.prepareMixCaptureTaps();});
  await Promise.resolve();await Promise.resolve();
  expect(secondReady).toBe(false);expect(context.audioWorklet.addModule).toHaveBeenCalledTimes(1);
  // Even a caller resuming the exposed device itself cannot allocate a legacy bypass.
  await context.resume();expect(engine.prepareMixCaptureTaps().environment).toBeNull();expect(incoming(context)).toHaveLength(0);
  context.module.resolve();await Promise.all([first,second]);
  expect(Context.instances).toHaveLength(1);expect(engine.prepareMixCaptureTaps().environment).not.toBeNull();
  expect(incoming(context)).toHaveLength(1);
  await engine.dispose();expect(incoming(context)).toHaveLength(0);
});
it("failed worklet preparation closes its context and permits a fresh successful retry",async()=>{
  const engine=new AudioEngine();engine.setMixProfile("weather-protected-1");const first=engine.enable(),failed=Context.instances[0];
  failed.module.reject(Error("worklet failed"));await expect(first).rejects.toThrow("worklet failed");
  expect(failed.state).toBe("closed");expect(incoming(failed)).toHaveLength(0);
  const retry=engine.enable(),fresh=Context.instances[1];fresh.module.resolve();await retry;
  expect(incoming(fresh)).toHaveLength(1);await engine.dispose();
});
it("dispose invalidates pending preparation without letting its completion replace a reopened graph",async()=>{
  const engine=new AudioEngine();engine.setMixProfile("weather-protected-1");const oldEnable=engine.enable(),old=Context.instances[0];
  await engine.dispose();const freshEnable=engine.enable(),fresh=Context.instances[1];fresh.module.resolve();await freshEnable;
  const master=engine.prepareMixCaptureTaps().master;old.module.resolve();await oldEnable;
  expect(engine.prepareMixCaptureTaps().master).toBe(master);expect(incoming(old)).toHaveLength(0);expect(incoming(fresh)).toHaveLength(1);
  await engine.dispose();
});
it("clears closed-device protection before preparing a replacement context",async()=>{
  const engine=new AudioEngine();engine.setMixProfile("weather-protected-1");const first=engine.enable(),old=Context.instances[0];old.module.resolve();await first;
  await old.close();const replacement=engine.enable(),fresh=Context.instances[1];await fresh.resume();
  expect(engine.prepareMixCaptureTaps().environment).toBeNull();expect(incoming(fresh)).toHaveLength(0);
  fresh.module.resolve();await replacement;expect(incoming(fresh)).toHaveLength(1);await engine.dispose();
});
