import { it, expect, vi } from "vitest";
// Text rasterization alone requires a browser canvas. Keep the actual Pixi
// scene graph, atlas loader, clip sampler, presenter and graphics commands.
vi.mock("@onepage/game-runtime/pixi", async (original) => {
  const runtime=await original<typeof import("@onepage/game-runtime/pixi")>();
  return {...runtime,Text:class extends runtime.Container {text="";anchor={set:()=>{}};}};
});
import { Container, type PixiStage } from "@onepage/game-runtime/pixi";
import { CryptballPresenter } from "../src/presenter";
import { createCryptballSession } from "../sim/session";

it("real presenter takes same-tick authority events, deduplicates identities, resets and reduces motion", () => {
  const canvas={dataset:{}} as HTMLCanvasElement;
  const stage={canvas,layers:{ground:new Container(),actors:new Container(),effects:new Container(),hud:new Container()},camera:{}} as unknown as PixiStage;
  const presenter=new CryptballPresenter(stage);
  // Assets are checked separately; omit network loading for this render test.
  Object.assign(presenter,{loaded:true,sport:"rift-volley"});
  const state=createCryptballSession({sportId:"rift-volley"}).observe();
  state.players=[];state.tick=100;state.phase="play";
  presenter.render(state);
  const event={type:"volley-contact",kind:"attack",tick:100,epoch:1,counter:10,x:0,y:0,height:40*256};
  presenter.render(state,[event]);
  expect(canvas.dataset.ballFrame).toBe("balls.volley.contact.0");
  const fx=(presenter as unknown as {fx:{emit:()=>void}}).fx;
  const emit=vi.spyOn(fx,"emit");
  presenter.render(state,[{...event,height:99*256}]);
  expect(emit).not.toHaveBeenCalled();
  presenter.render(state,[{...event,tick:90,counter:9,kind:"set"}]);
  expect(canvas.dataset.ballFrame).toBe("balls.volley.contact.0");
  presenter.render(state,[],true);
  expect(canvas.dataset.ballFrame).toBe("balls.volley.spin.0");
  presenter.render({...state,tick:110});
  expect(canvas.dataset.ballFrame).toBe("balls.volley.spin.0");
  presenter.render({...state,tick:99});
  presenter.render(state,[{...event,kind:"set"}]);
  expect(canvas.dataset.ballFrame).toBe("balls.volley.contact.1");
  presenter.dispose();
});
