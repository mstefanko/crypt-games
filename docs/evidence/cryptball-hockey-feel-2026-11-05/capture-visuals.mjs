import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const output='docs/evidence/cryptball-hockey-feel-2026-11-05/visuals';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=metal','--enable-webgl']});
try{
 const page=await browser.newPage({viewport:{width:1000,height:900},deviceScaleFactor:1});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:4231/games/cryptball/tests/hockey-visuals/');
 await page.waitForFunction(()=>document.body.dataset.ready==='true');
 const first=await page.evaluate(()=>window.hockeyVisualFixture.showAction({direction:'E',hit:true,age:0}));
 const cases=[['tell',true,0],['fall',true,first.contactIndex],['down',true,first.contactIndex+8],['get-up',true,first.contactIndex+16],['miss',false,20]];
 const summaries=[];
 for(const [name,hit,age] of cases){
  summaries.push(await page.evaluate(({hit,age})=>window.hockeyVisualFixture.showAction({direction:'E',hit,age}),{hit,age}));
  await page.locator('#stage').screenshot({path:`${output}/check-${name}.png`});
 }
 await writeFile(`${output}/summary.json`,JSON.stringify({errors,summaries},null,2));
 if(errors.length)throw Error(errors.join('\n'));
 console.log(`Captured ${summaries.length} real-action frames; contact tick index ${first.contactIndex}`);
}finally{await browser.close();}
