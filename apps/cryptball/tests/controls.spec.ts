import { test, expect, type Page } from "@playwright/test";

async function practice(page: Page, hockey = false) {
  await page.goto(`/games/cryptball/${hockey ? "?sport=cryptcheck" : ""}`);
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await expect.poll(async () => {
    const resume = page.getByRole("button", { name: "Resume", exact: true });
    if (await resume.isVisible()) await resume.click();
    return await page.locator("#overlay").isHidden() && Number(await page.locator("#game").getAttribute("data-tick")) > 130;
  }, { timeout: 30000 }).toBe(true);
}

async function resumeFrameDebt(page: Page) {
  if (await page.getByRole("heading",{name:"Time out",exact:true}).isVisible())
    await page.getByRole("button",{name:"Resume",exact:true}).click();
}
async function hockeyReady(page: Page) {
  await expect.poll(async()=>{
    await resumeFrameDebt(page);
    return page.locator("#game").evaluate(game=>{
      const state=(game as HTMLElement).dataset;
      return state.menu==="play"&&state.phase==="play"&&state.controlledAction==="idle";
    });
  },{timeout:30000}).toBe(true);
}
async function hockeyTicks(page: Page, ticks: number) {
  const start=Number(await page.locator("#game").getAttribute("data-tick"));
  await expect.poll(async()=>{
    await resumeFrameDebt(page);
    return Number(await page.locator("#game").getAttribute("data-tick"))-start;
  },{timeout:30000}).toBeGreaterThanOrEqual(ticks);
}

test("hockey poke presses rearm only after release and E commits a separate check", async ({ page }) => {
  await practice(page,true);
  const game = page.locator("#game");
  await page.evaluate(() => {
    const game=document.querySelector<HTMLElement>("#game")!;
    let previous=game.dataset.controlledAction;
    const counts:Record<string,number>={};
    (window as unknown as {hockeyActionStarts:Record<string,number>}).hockeyActionStarts=counts;
    new MutationObserver(()=>{
      const current=game.dataset.controlledAction;
      if(current&&current!==previous) counts[current]=(counts[current]??0)+1;
      previous=current;
    }).observe(game,{attributes:true,attributeFilter:["data-controlled-action"]});
  });
  const starts = (action:string) => page.evaluate(action => (window as unknown as {hockeyActionStarts:Record<string,number>}).hockeyActionStarts[action]??0,action);
  for (const key of ["Shift", "i"]) {
    await hockeyReady(page);
    const before=await starts("slide");
    await page.keyboard.down(key);
    await expect.poll(()=>starts("slide")).toBe(before+1);
    await hockeyTicks(page,80); // Includes the full 66-tick poke reuse window.
    expect(await starts("slide")).toBe(before+1);
    await page.keyboard.up(key);
  }
  const canvas = (await page.locator("canvas").boundingBox())!;
  await page.mouse.move(canvas.x + canvas.width * .7,canvas.y + canvas.height * .5);
  await hockeyReady(page);
  const mouseBefore=await starts("slide");
  await page.mouse.down({button:"right"});
  await expect.poll(()=>starts("slide")).toBe(mouseBefore+1);
  await hockeyTicks(page,80);
  expect(await starts("slide")).toBe(mouseBefore+1);
  await page.mouse.up({button:"right"});
  await hockeyReady(page);
  const checkBefore=await starts("check");
  await page.keyboard.down("e");
  await expect.poll(()=>starts("check")).toBe(checkBefore+1);
  await page.keyboard.press("Escape");
  await page.getByRole("button",{name:"Resume",exact:true}).click();
  await hockeyTicks(page,45);
  expect(await starts("check")).toBe(checkBefore+1);
  await page.keyboard.up("e");
  await hockeyReady(page);
  await page.keyboard.press("e");
  await expect.poll(()=>starts("check")).toBe(checkBefore+2);
});

test.describe("hockey mobile check input", () => {
  test.use({hasTouch:true,screen:{width:844,height:390}});
  test("right-region flick body-checks while movement remains independent", async ({page,browserName}) => {
    test.skip(browserName !== "chromium","CDP delivers genuine multi-touch input on Chromium");
    await page.setViewportSize({width:844,height:390});
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled",{enabled:true,maxTouchPoints:5});
    await practice(page,true);
    await hockeyReady(page);
    const canvas = (await page.locator("canvas").boundingBox())!;
    const a={id:1,x:canvas.x+canvas.width*.2,y:canvas.y+canvas.height*.4};
    const send = async (type:"touchStart"|"touchMove"|"touchEnd"|"touchCancel",touchPoints:{id:number;x:number;y:number}[]) => cdp.send("Input.dispatchTouchEvent",{type,touchPoints});
    await send("touchStart",[a]);a.x+=40;await send("touchMove",[a]);
    await expect(page.locator("#hockey-check")).toHaveCount(0);
    const h={id:2,x:canvas.x+canvas.width*.72,y:canvas.y+canvas.height*.5};
    await send("touchStart",[a,h]);h.x+=45;await send("touchMove",[a,h]);
    await expect(page.locator("#game")).toHaveAttribute("data-controlled-action","check");
    await expect(page.locator(".touch-stick")).toBeVisible();
    await expect(page.locator("#prompt")).toContainText("body-check");
    await send("touchEnd",[]);
    await page.evaluate(() => document.fullscreenElement ? document.exitFullscreen() : undefined);
    await page.setViewportSize({width:390,height:844});
    await expect(page.locator("#orientation-gate")).toBeVisible();
    await cdp.detach();
  });
});

test.describe("default mobile input", () => {
  test.use({hasTouch:true,screen:{width:844,height:390}});
  test("regions support solo actions, independent movement, interruption cancellation and score pause", async ({page,browserName}) => {
    test.skip(browserName !== "chromium", "CDP multi-touch");
    await page.setViewportSize({width:844,height:390});
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled",{enabled:true,maxTouchPoints:5});
    await practice(page);
    const bounds=(await page.locator("canvas").boundingBox())!;
    const a={id:1,x:bounds.x+bounds.width*.2,y:bounds.y+bounds.height*.6};
    const b={id:2,x:bounds.x+bounds.width*.75,y:bounds.y+bounds.height*.5};
    const send = (type:"touchStart"|"touchMove"|"touchEnd"|"touchCancel",touchPoints:{id:number;x:number;y:number}[]) => cdp.send("Input.dispatchTouchEvent",{type,touchPoints});
    const game=page.locator("#game");
    await expect(page.locator("#special-hud, #hockey-check, #mode-action")).toHaveCount(0);
    await send("touchStart",[b]);
    await expect(page.locator(".touch-aim")).toHaveAttribute("data-phase","shoot");
    await expect(game).toHaveAttribute("data-charging","true");
    await expect(page.locator(".touch-stick")).toBeHidden();
    await send("touchCancel",[]);
    await expect(game).toHaveAttribute("data-charging","false");
    await expect(page.locator(".touch-aim")).toBeHidden();
    await page.waitForTimeout(350);
    const before=Number(await game.getAttribute("data-player-x"));
    await send("touchStart",[a]);a.x+=40;await send("touchMove",[a]);
    await expect.poll(async()=>Number(await game.getAttribute("data-player-x"))).toBeGreaterThan(before);
    a.x-=40;await send("touchMove",[a]);
    await send("touchStart",[a,b]);
    await expect(game).toHaveAttribute("data-charging","true");
    await send("touchEnd",[a]);
    await page.waitForTimeout(80);
    await expect(game).toHaveAttribute("data-charging","true");
    await expect(page.locator(".touch-stick")).toBeHidden();
    await send("touchCancel",[]);
    await expect(game).toHaveAttribute("data-charging","false");
    await page.getByRole("button",{name:"Pause game",exact:true}).click();
    await expect(page.getByRole("heading",{name:"Time out",exact:true})).toBeVisible();
    await page.getByRole("button",{name:"Resume",exact:true}).click();
    await page.evaluate(()=>document.fullscreenElement ? document.exitFullscreen() : undefined);
    await page.setViewportSize({width:390,height:844});
    await expect(page.locator("#orientation-gate")).toBeVisible();
    await cdp.detach();
  });
});

test("mouse presses aim immediately, middle explicitly passes and score opens pause", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium");
  await page.setViewportSize({ width: 960, height: 640 });
  await practice(page);
  const cdp = await page.context().newCDPSession(page), canvas = (await page.locator("canvas").boundingBox())!;
  const x = canvas.x + canvas.width * .1, y = canvas.y + canvas.height * .55;
  // Direct press, without a preceding pointermove at the click position.
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await expect(page.locator("#game")).toHaveAttribute("data-charging", "true");
  await expect.poll(async () => Number(await page.locator("#game").getAttribute("data-aim"))).toBeGreaterThan(96);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await expect(page.locator("#game")).toHaveAttribute("data-charging", "false");
  await expect(page.locator("#game")).toHaveAttribute("data-controlled-action", "idle");
  await page.waitForTimeout(500); // ordinary strike admission/recovery lockout
  await page.mouse.click(x, y, { button: "middle" });
  await expect(page.locator("#game")).toHaveAttribute("data-controlled-action", "pass");
  await expect(page.locator("#special-hud")).toHaveCount(0);
  await page.getByRole("button",{name:"Pause game",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Time out",exact:true})).toBeVisible();
  await cdp.detach();
});

test("handedness and sound are available through Settings and handedness persists", async ({page}) => {
  await practice(page);
  await page.getByRole("button",{name:"Pause game",exact:true}).click();
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:"Movement: left half",exact:true}).click();
  await expect(page.getByRole("button",{name:"Movement: right half",exact:true})).toBeVisible();
  await page.locator("#overlay").getByRole("button",{name:"Mute sound",exact:true}).click();
  await expect(page.locator("#overlay").getByRole("button",{name:"Unmute sound",exact:true})).toBeVisible();
  await page.reload();
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await expect(page.getByRole("button",{name:"Movement: right half",exact:true})).toBeVisible();
});

test("chorded middle/right buttons register while left is held and release independently", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await practice(page);
  const box = (await page.locator("canvas").boundingBox())!;
  await page.mouse.move(box.x + box.width * .8, box.y + box.height * .35);
  await page.mouse.down({ button: "left" });
  await expect(page.locator("#game")).toHaveAttribute("data-charging", "true");
  await page.mouse.down({ button: "middle" });
  await expect(page.locator("#game")).toHaveAttribute("data-controlled-action", "pass");
  await page.mouse.up({ button: "middle" });
  await expect(page.locator("#game")).toHaveAttribute("data-controlled-action", "idle");
  await page.waitForTimeout(350);
  await page.mouse.down({ button: "right" });
  await expect(page.locator("#game")).toHaveAttribute("data-controlled-action", "slide");
  // Left releases before the last held mouse button; pointerup alone misses it.
  await page.mouse.up({ button: "left" }); await page.mouse.up({ button: "right" });
  await expect(page.locator("#game")).toHaveAttribute("data-controlled-action", "idle");
  await page.waitForTimeout(500);
  await page.mouse.down({ button: "left" });
  await expect(page.locator("#game")).toHaveAttribute("data-charging", "true");
  await page.keyboard.press("Escape");
  await page.mouse.up({ button: "left" });
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.locator("#game")).toHaveAttribute("data-charging", "false");
});
