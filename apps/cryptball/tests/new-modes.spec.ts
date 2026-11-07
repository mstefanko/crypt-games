import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const evidence='docs/evidence/cryptball-new-modes-2026-11-05';
async function active(page:Page) {
  await expect.poll(async()=>{
    const resume=page.getByRole('button',{name:'Resume',exact:true});if(await resume.isVisible())await resume.click();
    return page.locator('#game').evaluate(g=>(g as HTMLElement).dataset.menu==='play'&&(g as HTMLElement).dataset.phase==='play');
  },{timeout:30000}).toBe(true);
}
async function screenshot(page:Page,name:string){await mkdir(evidence,{recursive:true});await page.screenshot({path:`${evidence}/${name}.png`});}
for(const [mode,label] of [['crypt-dodge','Crypt Dodge'],['crypt-guardian','Crypt Guardian']] as const)test(`${label} selection starts a complete mode with loaded art and honest specials`,async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`/games/cryptball/?sport=${mode}`);
  await expect(page.getByRole('heading',{name:'CRYPT GAMES',level:1,exact:true})).toBeVisible();
  await expect(page.locator('.sport-selector button')).toHaveCount(7);
  await expect(page.locator('.title-menu > p')).toHaveCount(0);
  if(mode==='crypt-guardian')await expect(page.locator('#opponent-team')).toHaveCount(0);
  await page.getByRole('button',{name:'Single player',exact:true}).click();await active(page);
  await expect(page.locator('canvas')).toHaveAttribute('data-new-modes-atlas-ready','true');
  await expect(page.locator('#special-hud')).toHaveCount(0);
  await expect(page.locator('canvas')).toHaveAttribute('data-rendered-balls','2');
  await expect(page.locator('.mode-roster span')).toHaveCount(mode==='crypt-guardian'?2:4);
  if(mode==='crypt-dodge'){
    await expect(page.locator('#game')).toHaveAttribute('data-dodge-lives',/^[0-3],[0-3],[0-3],[0-3]$/);
    await expect(page.locator('canvas')).toHaveAttribute('data-ball-frame',/^new\.object\.ball-/);
    await page.keyboard.down('j');await page.waitForTimeout(180);await page.keyboard.up('j');
    await page.keyboard.press('Shift');
  }else{
    await expect(page.locator('canvas')).toHaveAttribute('data-guardian-floor-previews','false');
    await expect(page.locator('#game')).toHaveAttribute('data-guardian-hp',/^[1-9]\d*$/);
    await expect(page.getByRole('progressbar',{name:'Guardian health'})).toBeVisible();
    await page.keyboard.down('k');await expect(page.locator('#game')).toHaveAttribute('data-pass-held','true');await page.keyboard.up('k');await expect(page.locator('#game')).toHaveAttribute('data-pass-held','false');
  }
  await screenshot(page,`${mode}-live`);expect(errors).toEqual([]);
});

test('guardian practice exposes real family and immortal configuration',async({page})=>{
  await page.goto('/games/cryptball/?sport=crypt-guardian');await page.getByRole('button',{name:'Practice',exact:true}).click();
  await page.getByLabel('Practice weapon family').selectOption('maul');await page.getByLabel('Immortal athletes (practice only)').check();
  await page.getByRole('button',{name:'Begin practice',exact:true}).click();await active(page);
  await expect(page.locator('canvas')).toHaveAttribute('data-guardian-weapon','maul');
  await expect(page.locator('#clock')).toHaveText('PRACTICE');await expect(page.locator('canvas')).toHaveAttribute('data-guardian-cover','');
  await expect(page.locator('canvas')).toHaveAttribute('data-rendered-balls','2');
  await expect(page.locator('canvas')).toHaveAttribute('data-guardian-floor-previews','true',{timeout:15000});
  await screenshot(page,'guardian-maul-practice');
});

test.describe('new-mode touch targets',()=>{
  test.use({hasTouch:true});
  test('dodge primary thumb catches immediately and never turns a held catch into a shot',async({page,browserName})=>{
    test.skip(browserName!=='chromium','CDP multi-touch');await page.setViewportSize({width:844,height:390});
    const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
    await page.goto('/games/cryptball/?sport=crypt-dodge');await page.getByRole('button',{name:'Single player',exact:true}).click();await active(page);
    const game=page.locator('#game');
    // If opening possession belongs to us, release it through actual controls.
    if(await game.getAttribute('data-dodge-holder')===await game.getAttribute('data-controlled-id')){
      await page.keyboard.down('j');await page.waitForTimeout(180);await page.keyboard.up('j');await page.waitForTimeout(200);
    }
    const bounds=(await page.locator('canvas').boundingBox())!;
    const move={id:1,x:bounds.x+bounds.width*.15,y:bounds.y+bounds.height*.65};
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[move]});
    await expect(page.locator('#mode-action')).toHaveCount(0);
    const before=Number(await game.getAttribute('data-controlled-catch-start'));
    const action={id:2,x:bounds.x+bounds.width*.75,y:bounds.y+bounds.height*.55};
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[move,action]});
    await expect.poll(async()=>Number(await game.getAttribute('data-controlled-catch-start'))).toBeGreaterThan(before);
    await page.waitForTimeout(250);await expect(game).toHaveAttribute('data-charging','false');
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await screenshot(page,'dodge-touch-catch');
  });
});

for(const mode of ['crypt-dodge','crypt-guardian'] as const)test(`${mode} movement advances run animation and keeps both balls legible`,async({page})=>{
  await page.goto(`/games/cryptball/?sport=${mode}`);await page.getByRole('button',{name:'Single player',exact:true}).click();await active(page);
  const canvas=page.locator('canvas');const before=Number(await canvas.getAttribute('data-controlled-run-phase'));
  await page.keyboard.down('ArrowLeft');await page.waitForTimeout(100);
  const firstFrame=await canvas.getAttribute('data-controlled-frame');
  await expect.poll(()=>canvas.getAttribute('data-controlled-frame')).not.toBe(firstFrame);
  await page.keyboard.up('ArrowLeft');
  expect(Number(await canvas.getAttribute('data-controlled-run-phase'))).toBeGreaterThan(before);
  await expect(canvas).toHaveAttribute('data-rendered-balls','2');
  await page.waitForTimeout(2500);await screenshot(page,`${mode}-midcombat`);
});
