/** Test-only native-size presentation proof from real authoritative contacts. */
import { PixiStage } from "@onepage/game-runtime/pixi";
import { CryptballPresenter } from "../../src/presenter";
import { resizeCryptball } from "../../src/viewport";
import { athleteAnimation, spriteHeading } from "../../src/animation";
import { CONTACT_KINDS, DIRECTIONS, captureHockeyContact, type Direction, type ContactKind } from "./capture";
import { captureHockeyCheck } from "./check-capture";

const canvas = document.querySelector("canvas")!, container = document.querySelector<HTMLElement>("#stage")!;
const stage = new PixiStage(canvas);await stage.init();resizeCryptball(stage,container);
const presenter = new CryptballPresenter(stage);await presenter.init();await presenter.loadSport("cryptcheck");
const captures = new Map<string,ReturnType<typeof captureHockeyContact>>();
for (const direction of DIRECTIONS) for (const kind of CONTACT_KINDS) captures.set(`${direction}:${kind}`,captureHockeyContact(direction,kind));

async function show({direction="E",kind="wrist",age=0,reduced=false,debug=false,scale=1}:{direction?:Direction;kind?:ContactKind;age?:number;reduced?:boolean;debug?:boolean;scale?:1|2}={}) {
  const capture = captures.get(`${direction}:${kind}`);if (!capture) throw Error("Unknown hockey fixture");
  container.style.width=`${640*scale}px`;container.style.height=`${400*scale}px`;resizeCryptball(stage,container);
  await presenter.prewarm(capture.initial);presenter.setDebug(debug);
  const end = Math.max(0,Math.min(capture.packets.length-1,capture.contactIndex+Math.trunc(age)));
  for (let i=0;i<=end;i++) presenter.render(capture.packets[i].state,capture.packets[i].events,reduced);
  stage.render(0);
  const packet = capture.packets[end],p = packet.state.players[0];
  const animation = athleteAnimation(p,packet.state,capture.contact);
  const summary = {direction,heading:capture.heading,spriteHeading:spriteHeading(capture.heading),kind,age:end-capture.contactIndex,tick:packet.state.tick,
    origin:"validated practice checkpoint + actual normal input + captured puck-contact event",reduced,debug,frame:canvas.dataset.ballFrame,
    contact:capture.contact,ball:packet.state.ball,animation,foot:{x:p.x,y:p.y},initialPuck:capture.initial.ball};
  document.querySelector("#status")!.textContent=`${direction} · ${kind} · contact age ${summary.age} · T${summary.tick} · ${animation.clip} · reduced ${reduced} · debug ${debug}`;
  document.querySelector("#details")!.textContent=JSON.stringify(summary,null,2);
  return summary;
}
const checks = new Map<string,ReturnType<typeof captureHockeyCheck>>();
async function showAction({direction="E",hit=true,age=0,reduced=false,debug=false,scale=1}:{direction?:Direction;hit?:boolean;age?:number;reduced?:boolean;debug?:boolean;scale?:1|2}={}) {
  const key=`${direction}:${hit}`;
  if(!checks.has(key)) checks.set(key,captureHockeyCheck(direction,hit));
  const capture=checks.get(key)!;
  container.style.width=`${640*scale}px`;container.style.height=`${400*scale}px`;resizeCryptball(stage,container);
  await presenter.prewarm(capture.initial);presenter.setDebug(debug);
  const end=Math.max(0,Math.min(capture.packets.length-1,Math.trunc(age)));
  for(let i=0;i<=end;i++) presenter.render(capture.packets[i].state,capture.packets[i].events,reduced);
  stage.render(0);
  const packet=capture.packets[end],attacker=packet.state.players.find(p=>p.id===capture.playerId)!,victim=packet.state.players.find(p=>p.id===capture.victimId)!;
  const summary={direction,hit,age:end,tick:packet.state.tick,contactIndex:capture.contactIndex,
    origin:"validated match checkpoint + actual Check command; no invented contact or recovery state",reduced,debug,
    attacker:athleteAnimation(attacker,packet.state),victim:athleteAnimation(victim,packet.state),
    skaters:packet.state.hockey!.skaters,events:packet.events,ball:packet.state.ball};
  document.querySelector("#status")!.textContent=`${direction} · check ${hit?"hit":"miss"} · elapsed ${end} · T${packet.state.tick} · ${summary.attacker.clip} / ${summary.victim.clip} · reduced ${reduced}`;
  document.querySelector("#details")!.textContent=JSON.stringify(summary,null,2);
  return summary;
}
Object.assign(window,{hockeyVisualFixture:{keys:[...captures.keys()],show,showAction}});
const directionSelect = document.querySelector<HTMLSelectElement>("#direction")!,kindSelect=document.querySelector<HTMLSelectElement>("#kind")!;
for(const direction of DIRECTIONS) directionSelect.add(new Option(direction,direction));
for(const kind of CONTACT_KINDS) kindSelect.add(new Option(kind,kind));
kindSelect.add(new Option("check hit","check-hit"));kindSelect.add(new Option("check miss","check-miss"));
document.querySelector("#show")!.addEventListener("click",()=>{
  const options={direction:directionSelect.value as Direction,reduced:document.querySelector<HTMLInputElement>("#reduced")!.checked,debug:document.querySelector<HTMLInputElement>("#debug")!.checked,
    age:Number(document.querySelector<HTMLInputElement>("#age")!.value),scale:document.querySelector<HTMLInputElement>("#double")!.checked?2 as const:1 as const};
  void(kindSelect.value.startsWith("check-")?showAction({...options,hit:kindSelect.value==="check-hit"}):show({...options,kind:kindSelect.value as ContactKind}));
});
await show();document.body.dataset.ready="true";
