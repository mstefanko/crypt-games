import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { arrangements, makeScore, makeSting } from './crypt-soundtrack-concept.mjs';
const output=resolve('docs/evidence/crypt-soundtrack-concept-2026-11-05');
await mkdir(output,{recursive:true});
const server=await createServer({configFile:'vite.cryptball.config.ts',server:{port:4259,strictPort:true,hmr:false,watch:{ignored:['**/*']}}});
let browser;
const manifest={version:1,status:'audition; not wired into game',sampleRate:44100,format:'stereo PCM16',source:'Original notes; existing native runtime synth; no external samples',files:[]};
try {
  await server.listen();browser=await chromium.launch({headless:true});
  const page=await browser.newPage();
  await page.route('**/audio-audition',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Offline audio renderer</title>'}));
  await page.goto('http://127.0.0.1:4259/games/cryptball/audio-audition');
  const scores=[...arrangements.map(([id])=>[id,makeScore(id)]),...['start','point','match-point','victory','defeat'].map(id=>['sting-'+id,makeSting(id)])];
  for(const [id,score] of scores) {
    await writeFile(resolve(output,id+'.score.json'),JSON.stringify(score,null,2)+'\n');
    const rendered=await page.evaluate(async({score,id,root})=>{
      const {renderScore,encodeWav}=await import(root+'/packages/music-web-audio/src/index.ts');
      const {exportMidi}=await import(root+'/packages/music-io/src/midi.ts');
      const b64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s);};
      const loop=score.playback==='loop',sampleRate=44100;
      const frames=Math.round(score.lengthTicks/480*60/score.bpm*sampleRate);
      const buffer=(n=frames)=>new AudioBuffer({length:n,numberOfChannels:2,sampleRate});
      const groups=loop?['foundation','identity','pressure']:['sting'];
      const stems={};
      for(const group of groups) {
        const s=structuredClone(score);
        s.tracks=s.tracks.map(t=>({...t,minEnergy:1,gain:((group==='sting'||group==='pressure'&&t.minEnergy===2||group==='identity'&&['hook','answer'].includes(t.id)||group==='foundation'&&t.minEnergy===1&&!['hook','answer'].includes(t.id))?t.gain:0)}));
        s.tracks=s.tracks.filter(t=>t.gain>0);
        const keep=new Set(s.tracks.map(t=>t.id));
        s.patterns=s.patterns.filter(p=>keep.has(p.id));s.clips=s.clips.filter(c=>keep.has(c.trackId));
        let out;
        if(loop) {
          out=buffer();
          // Linear native synthesis: render starts in bounded bars, preserve long
          // notes and releases, and wrap their tails into the next loop.
          for(let bar=0;bar<score.lengthTicks/1920;bar++) {
            const part=structuredClone(s);part.playback='one-shot';part.loop=null;
            part.lengthTicks=5760;part.sections=[];
            part.patterns=part.patterns.map(p=>({...p,lengthTicks:5760,notes:p.notes.filter(n=>n.startTick>=bar*1920&&n.startTick<(bar+1)*1920).map(n=>({...n,startTick:n.startTick-bar*1920}))}));
            const raw=await renderScore(part,{sampleRate,tailSeconds:1});
            const offset=Math.round(bar*4*60/score.bpm*sampleRate);
            for(let c=0;c<2;c++){const d=out.getChannelData(c),v=raw.getChannelData(c);for(let i=0;i<v.length;i++)d[(offset+i)%frames]+=v[i];}
          }
        } else out=await renderScore(s,{sampleRate,tailSeconds:1});
        stems[group]=out;
      }
      const assets={};
      const sum=(names)=>{const out=buffer();for(let c=0;c<2;c++){const d=out.getChannelData(c);for(const name of names){const a=stems[name].getChannelData(c);for(let i=0;i<d.length;i++)d[i]+=a[i];}}return out;};
      if(loop){
        assets[id]=sum(['foundation','identity']);
        if(!['menu','results'].includes(id)) {
          assets[id+'-pressure']=sum(['foundation','identity','pressure']);
          for(const g of groups)assets[id+'-stem-'+g]=stems[g];
        }
        if(id==='cryptball') {
          const demo=buffer(),barFrames=frames/32;
          for(let c=0;c<2;c++){const d=demo.getChannelData(c),normal=assets[id].getChannelData(c),pressure=stems.pressure.getChannelData(c);
            for(let i=0;i<frames;i++){const bar=i/barFrames;const gain=bar<8?0:bar<9?bar-8:bar<24?1:Math.max(0,1-(bar-24));d[i]=normal[i]+pressure[i]*gain;}}
          assets['adaptive-demo']=demo;
        }
      }else assets[id]=stems.sting;
      const files=[];
      for(const [name,b] of Object.entries(assets)) {
        let peak=0,power=0,clipped=0,seam=0;
        for(let c=0;c<2;c++){const d=b.getChannelData(c);for(const v of d){peak=Math.max(peak,Math.abs(v));power+=v*v;if(Math.abs(v)>=1)clipped++;}seam=Math.max(seam,Math.abs(d[0]-d[d.length-1]));}
        if(clipped)throw Error(name+' clipped');
        files.push({name,frames:b.length,seconds:b.duration,peak,rms:Math.sqrt(power/(b.length*2)),clipped,seam:loop?seam:null,wav:b64(encodeWav(b))});
      }
      const programs={bass:38,grit:38,pad:89,hook:score.tracks.find(t=>t.id==='hook').patchId==='glass'?10:62,answer:10,'pressure-pulse':80};
      return {files,midi:b64(exportMidi(score,{programs}))};
    },{score,id,root:'/games/cryptball/@fs'+resolve('.')});
    await writeFile(resolve(output,id+'.mid'),Buffer.from(rendered.midi,'base64'));
    for(const {name,wav,...metrics} of rendered.files){
      const bytes=Buffer.from(wav,'base64');await writeFile(resolve(output,name+'.wav'),bytes);
      manifest.files.push({file:name+'.wav',score:id,bpm:score.bpm,loop:score.playback==='loop',...metrics,sha256:createHash('sha256').update(bytes).digest('hex')});
      if(!name.includes('-stem-'))execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',resolve(output,name+'.wav'),'-codec:a','libmp3lame','-b:a','192k',resolve(output,name+'.mp3')]);
    }
    process.stdout.write(id+': '+rendered.files.length+' audio files rendered\n');
  }
  await writeFile(resolve(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  const cards=manifest.files.filter(f=>!f.file.includes('-stem-')).map(f=>`<article><h2>${f.file.replace('.wav','')}</h2><p>${f.bpm} BPM · ${f.seconds.toFixed(1)} seconds</p><audio controls preload="none" src="${f.file.replace('.wav','.mp3')}"></audio><p><a href="${f.file}">WAV</a> · <a href="${f.score}.mid">MIDI</a> · <a href="${f.score}.score.json">Score</a></p></article>`).join('');
  await writeFile(resolve(output,'listen.html'),`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Crypt Games soundtrack audition</title><style>body{background:#12151a;color:#e8dfc7;font:17px system-ui;max-width:1000px;margin:50px auto;padding:20px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:20px}article{background:#20262c;padding:20px;border-radius:12px}h2{font-size:20px}a{color:#87d6bc}audio{width:100%}p{line-height:1.6}</style><h1>Crypt Games · After Dark</h1><p>Original native-synth audition. Start with Iron Court (cryptball), then adaptive-demo: pressure enters at 15 seconds, leaves at 45 seconds. Same tempo; increased rhythmic tension. These are proposed assets, not changes to the live game.</p><p>All six sports have aligned foundation, identity and pressure WAV stems. MIDI is editable, but its sound depends on your instruments. WAV files are the reference sound.</p><main>${cards}</main><script>document.addEventListener('play',e=>{for(const a of document.querySelectorAll('audio'))if(a!==e.target)a.pause()},true)</script>`);
}finally{await browser?.close();await server.close();}
