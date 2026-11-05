// Isolates the real scheduler's wall-clock gate; not a browser benchmark.
// Run from the repository root: node docs/evidence/network-plan-2026-11-05/scheduler-cadence.mjs
import { build } from 'esbuild';
const built = await build({entryPoints:['apps/cryptball/src/online/input-scheduler.ts'],bundle:true,platform:'node',format:'esm',write:false});
const { InputScheduler } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].contents).toString('base64'));
for (const [name, intervals] of [['perfect-60hz',[1000/60]],['alternating-16-17.333ms',[16,1000/30-16]]]) {
  const scheduler = new InputScheduler();
  scheduler.seed(80);
  let now = 0, sent = 0;
  for (let i = 0; i < 600; i++) {
    now += intervals[i % intervals.length];
    const serverTick = Math.floor(now / (1000/60));
    scheduler.capture({moveX:1},now,false);
    if (scheduler.allocate(serverTick,serverTick-3,now)) sent++;
  }
  console.log(JSON.stringify({name,elapsedMs:now,calls:600,sent,skipped:600-sent}));
}
