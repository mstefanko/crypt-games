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
  test.use({hasTouch:true});
  test("Check owns its HUD pointer, preserves movement and cancels drags", async ({page,browserName}) => {
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
    const check=page.getByRole("button",{name:"Body check",exact:true});
    await expect(check).toBeVisible();
    const rect=(await check.boundingBox())!;
    expect(rect.width).toBeGreaterThanOrEqual(44);expect(rect.height).toBeGreaterThanOrEqual(44);
    const h={id:2,x:rect.x+rect.width/2,y:rect.y+rect.height/2};
    await send("touchStart",[a,h]);await send("touchEnd",[h]);
    await expect(page.locator("#game")).toHaveAttribute("data-controlled-action","check");
    await expect(page.locator(".touch-stick")).toBeVisible();
    await expect(page.locator(".touch-aim")).toBeHidden();
    await expect(page.locator("#prompt")).toContainText("flick to poke");
    await hockeyReady(page);
    // A frame-debt pause cancels pointer roles. Start a fresh movement contact
    // if the browser needed that normal resume flow during recovery.
    if (!await page.locator(".touch-stick").isVisible()) {
      await send("touchEnd",[]);await send("touchStart",[a]);
    }
    await send("touchStart",[a,h]);h.x+=20;await send("touchMove",[a,h]);await send("touchEnd",[h]);
    await hockeyTicks(page,10);
    await expect(page.locator("#game")).toHaveAttribute("data-controlled-action","idle");
    await send("touchEnd",[]);
    await page.setViewportSize({width:390,height:844});
    await expect.poll(async()=>{
      const rect=await check.boundingBox();
      return !!rect&&rect.x>=0&&rect.x+rect.width<=390;
    }).toBe(true); // Resize registration occurs on the next browser frame.
    const portrait=(await check.boundingBox())!;
    expect(portrait.x).toBeGreaterThanOrEqual(0);expect(portrait.x+portrait.width).toBeLessThanOrEqual(390);
    expect(portrait.width).toBeGreaterThanOrEqual(44);expect(portrait.height).toBeGreaterThanOrEqual(44);
    await cdp.detach();
  });
});

test.describe("default mobile input", () => {
test.use({ hasTouch: true });
test("real multi-touch pointers move, hold, isolate HUD contacts and cancel without a release shot", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "CDP delivers genuine multi-touch input on Chromium");
  await page.setViewportSize({ width: 844, height: 390 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await practice(page);
  await page.evaluate(() => {
    (window as any).controlEvents = [];
    for (const name of ["pointerdown", "pointerup", "pointercancel", "lostpointercapture", "orientationchange", "blur", "visibilitychange"])
      window.addEventListener(name, e => (window as any).controlEvents.push({ type: e.type, id: (e as PointerEvent).pointerId, x: (e as PointerEvent).clientX, y: (e as PointerEvent).clientY, at: performance.now() }));
  });
  const canvas = (await page.locator("canvas").boundingBox())!;
  const a = { id: 11, x: canvas.x + canvas.width * .2, y: canvas.y + canvas.height * .6 };
  const b = { id: 22, x: canvas.x + canvas.width * .72, y: canvas.y + canvas.height * .45 };
  const send = async (type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", touchPoints: { id: number; x: number; y: number }[]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
  await page.evaluate(() => {
    (window as any).courtPointers = [];
    document.querySelector("canvas")!.addEventListener("pointerdown", e => (window as any).courtPointers.push({ id: (e as PointerEvent).pointerId, type: (e as PointerEvent).pointerType }));
  });
  const xBefore = Number(await page.locator("#game").getAttribute("data-player-x"));
  await send("touchStart", [a]);
  a.x += 42; await send("touchMove", [a]);
  await expect.poll(async () => Number(await page.locator("#game").getAttribute("data-player-x"))).toBeGreaterThan(xBefore);
  // Returning the movement thumb to its origin permits a stationary shot.
  a.x -= 42; await send("touchMove", [a]);
  await send("touchStart", [a, b]);
  try { await expect(page.locator(".touch-aim")).toHaveAttribute("data-phase", "shoot"); }
  catch (error) { console.log(await page.evaluate(() => (window as any).controlEvents)); throw error; }
  await expect(page.locator("#game")).toHaveAttribute("data-charging", "true");
  const card = page.locator('#special-hud > div[data-mine="true"] button');
  const button = (await card.boundingBox())!;
  expect(button.width).toBeGreaterThanOrEqual(44); expect(button.height).toBeGreaterThanOrEqual(44);
  const h = { id: 33, x: button.x + button.width / 2, y: button.y + button.height / 2 };
  await send("touchStart", [a, b, h]); await send("touchEnd", [h]);
  await expect(page.locator("#game")).toHaveAttribute("data-charging", "true");
  await expect(page.locator(".touch-stick")).toBeVisible();
  const ids = await page.evaluate(() => (window as any).courtPointers as { id: number; type: string }[]);
  expect(ids).toHaveLength(2); expect(new Set(ids.map(p => p.id)).size).toBe(2); expect(ids.every(p => p.type === "touch")).toBe(true);
  await send("touchEnd", [a]);
  await expect(page.locator("#game")).toHaveAttribute("data-charging", "false");
  await send("touchEnd", []);
  await expect(page.locator("#game")).toHaveAttribute("data-controlled-action", "idle");
  await expect(page.locator(".touch-aim")).toBeHidden();
  await page.screenshot({ path: ".local-game-tests/cryptball-browser/mobile-landscape.png" });
  // A new contact owns movement, and a second quick tap passes once.
  await send("touchStart", [a]); await send("touchStart", [a, b]); await send("touchEnd", [b]);
  await expect(page.locator("#game")).toHaveAttribute("data-controlled-action", "pass");
  await send("touchEnd", []);
  await expect(page.locator("#game")).toHaveAttribute("data-controlled-action", "idle");
  await page.waitForTimeout(350); // avoid the deliberate quick-retouch dash gesture
  await send("touchStart", [a]);
  a.x += 40; await send("touchMove", [a]);
  await send("touchStart", [a, b]);
  b.y += 50; await send("touchMove", [a, b]);
  await expect(page.locator("#game")).toHaveAttribute("data-controlled-action", "slide");
  // The action thumb flick points down while the movement thumb points right.
  await expect(page.locator("#game")).toHaveAttribute("data-aim", "64");
  await send("touchEnd", [b]); await send("touchEnd", []);
  await expect(page.locator("#game")).toHaveAttribute("data-controlled-action", "idle");
  await page.waitForTimeout(350);
  await send("touchStart", [a]); await send("touchStart", [a, b]);
  await expect(page.locator("#game")).toHaveAttribute("data-charging", "true");
  await send("touchEnd", [b]);
  await expect(page.locator("#game")).toHaveAttribute("data-controlled-action", "strike");
  await expect(page.locator(".touch-stick")).toBeVisible();
  await send("touchEnd", []);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: ".local-game-tests/cryptball-browser/mobile-portrait.png" });
  const portraitButton = (await card.boundingBox())!;
  expect(portraitButton.x).toBeGreaterThanOrEqual(0); expect(portraitButton.x + portraitButton.width).toBeLessThanOrEqual(390);
  await cdp.detach();
});
});

test("mouse button presses aim immediately, middle passes and READY is clickable", async ({ page, browserName }) => {
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
  const wrapper = page.locator('#special-hud > div[data-mine="true"]');
  await expect.poll(async () => {
    const resume = page.getByRole("button", { name: "Resume", exact: true });
    if (await resume.isVisible()) await resume.click();
    return wrapper.getAttribute("data-ready");
  }, { timeout: 60000 }).toBe("true");
  await wrapper.locator("button").click();
  await expect(wrapper).toHaveAttribute("data-ready", "false");
  await expect(wrapper).toHaveAttribute("data-active", "true");
  await cdp.detach();
});

test.describe("default mobile special input", () => {
test.use({ hasTouch: true });
test("touch READY and Flutter follow-up stay isolated while the movement thumb remains down", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium");
  test.setTimeout(120000);
  await page.setViewportSize({ width: 844, height: 390 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await page.goto("/games/cryptball/");
  await page.getByRole("button", { name: "Bats", exact: true }).click();
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  const wrapper = page.locator('#special-hud > div[data-mine="true"]');
  await expect.poll(async () => {
    const resume = page.getByRole("button", { name: "Resume", exact: true });
    if (await resume.isVisible()) await resume.click();
    return await page.locator("#overlay").isHidden() && await wrapper.getAttribute("data-ready") === "true";
  }, { timeout: 90000 }).toBe(true);
  const canvas = (await page.locator("canvas").boundingBox())!;
  const a = { id: 1, x: canvas.x + canvas.width * .2, y: canvas.y + canvas.height * .6 };
  const send = async (type: "touchStart" | "touchMove" | "touchEnd", touchPoints: { id: number; x: number; y: number }[]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
  await send("touchStart", [a]); a.x += 40; await send("touchMove", [a]);
  // The local card is on the action side in the default mobile layout.
  const rect = (await wrapper.locator("button").boundingBox())!;
  const h = { id: 2, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  await send("touchStart", [a, h]); await send("touchEnd", [h]);
  await expect(wrapper).toHaveAttribute("data-ready", "false");
  await expect(wrapper).toHaveAttribute("data-active", "true");
  await expect(wrapper).toContainText("AGAIN");
  await expect(page.locator(".touch-stick")).toBeVisible();
  await expect(page.locator(".touch-aim")).toBeHidden();
  const position = Number(await page.locator("#game").getAttribute("data-player-y"));
  // Re-aim the movement thumb for the separate second burst, then tap again.
  a.x -= 40; a.y += 40; await send("touchMove", [a]);
  await send("touchStart", [a, h]); await send("touchEnd", [h]);
  await expect(wrapper).not.toContainText("AGAIN");
  await expect(wrapper).toContainText("ACTIVE");
  await expect.poll(async () => Number(await page.locator("#game").getAttribute("data-player-y"))).toBeGreaterThan(position);
  await expect(page.locator(".touch-stick")).toBeVisible();
  await expect(page.locator("#game")).toHaveAttribute("data-charging", "false");
  await send("touchEnd", []); await cdp.detach();
});
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
