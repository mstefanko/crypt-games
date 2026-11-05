import { it, expect, vi } from "vitest";
vi.mock("@onepage/game-runtime/pixi", async (original) => {
 const runtime = await original<typeof import("@onepage/game-runtime/pixi")>();
 return { ...runtime, Text: class extends runtime.Container { text=""; anchor={set:()=>{}}; } };
});
import { Container, Sprite, Texture, type PixiStage } from "@onepage/game-runtime/pixi";
import { CryptballPresenter } from "../src/presenter";
import { createCryptballSession } from "../sim/session";
import { TEAM_IDS } from "../sim/team-identities";
import { readFileSync, existsSync } from "node:fs";
it("selects both banner planes from every authoritative team selection across sports", () => {
 const canvas={dataset:{}} as HTMLCanvasElement;
 const stage={canvas,layers:{ground:new Container(),actors:new Container(),effects:new Container(),hud:new Container()},camera:{}} as unknown as PixiStage;
 const presenter=new CryptballPresenter(stage);
 const internals=presenter as unknown as {bannerAtlas:{texture:(name:string)=>Texture};bannerSprites:Map<string,Sprite>};
 const texture=vi.fn(()=>Texture.EMPTY);internals.bannerAtlas.texture=texture;
 for(const side of [0,1]) for(const layer of ["rear","front"]) internals.bannerSprites.set(`${side}.${layer}`,new Sprite());
 Object.assign(presenter,{loaded:true});
 for(const sportId of ["cryptball","cryptkick","rift-volley"] as const) {
  // Avoid sport scenery construction: this test verifies the real render's identity binding.
  Object.assign(presenter,{sport:sportId});
  const observation=createCryptballSession({sportId}).observe();observation.players=[];
  for(let i=0;i<TEAM_IDS.length;i++) {
   observation.teamIds=[TEAM_IDS[i],TEAM_IDS[(i+1)%TEAM_IDS.length]];
   presenter.render(observation);
   expect(canvas.dataset.bannerTeams).toBe(observation.teamIds.join(","));
   for(const side of [0,1]) for(const layer of ["rear","front"])
    expect(texture).toHaveBeenCalledWith(`banners.${observation.teamIds[side]}.${side}.${layer}`);
  }
 }
 presenter.dispose();
});
it("ships every club on either side with nearest-neighbor registered layers", () => {
 const dir=new URL('../public/assets/cryptball-banners/',import.meta.url);
 const manifest=JSON.parse(readFileSync(new URL('manifest.json',dir),'utf8'));
 expect(manifest.sampling).toBe('nearest');
 for(const team of TEAM_IDS)for(const side of [0,1])for(const layer of ['rear','front']) {
  const frame=manifest.frames[`banners.${team}.${side}.${layer}`];
  expect(frame.width*frame.height).toBeLessThan(640*200);
  expect(frame.pivot.x).toBeLessThan(0);
  expect(frame.pivot.y).toBeLessThan(0);
  expect(existsSync(new URL(manifest.pages[frame.pageId],dir))).toBe(true);
 }
});
