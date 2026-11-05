import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-webgl']});
const page=await browser.newPage({viewport:{width:1280,height:800}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
 await page.goto('http://127.0.0.1:4224/games/cryptball/?sport=cryptkick');
 await page.getByRole('group',{name:'Your team',exact:true}).getByRole('button',{name:'Owls',exact:true}).click();
 await page.getByLabel('Solo opponent').selectOption('hornets');
 await page.getByRole('button',{name:'Solo match',exact:true}).click();
 await expect.poll(async()=>{if(await page.getByRole('heading',{name:'Time out',exact:true}).isVisible())await page.getByRole('button',{name:'Resume',exact:true}).click();return page.locator('#overlay').isHidden();},{timeout:20000}).toBe(true);
 await expect(page.locator('canvas')).toHaveAttribute('data-banner-teams','owls,hornets');
 await expect(page.locator('#special-hud')).toContainText('Focus');
 await expect(page.locator('#special-hud')).toContainText('Sting');
 await page.mouse.move(640,400);
 await page.screenshot({path:'docs/evidence/cryptball-team-specials-2026-11-04/final-preview.png'});
 await page.goto('http://127.0.0.1:4224/games/cryptball/');
 await page.getByRole('button',{name:'Play with friends',exact:true}).click();
 await page.getByRole('button',{name:'Create room',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Invite link'})).toBeVisible({timeout:15000});
 await page.getByRole('button',{name:'Leave',exact:true}).click();
 expect(errors).toEqual([]);
 await writeFile('docs/evidence/cryptball-team-specials-2026-11-04/live-preview.json',JSON.stringify({url:'http://127.0.0.1:4224/games/cryptball/',teams:['owls','hornets'],specials:['Focus','Sting'],privateRoomCreated:true,errors},null,2));
 console.log('Preview banners/HUD and matching-server private room passed.');
} finally {await browser.close();}
