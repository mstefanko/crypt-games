/** Original Crypt Games audition scores. No borrowed melodies or samples.
 * This module does not change the live game. Beat positions use 480 PPQ. */
export const arrangements = [
  ['menu', 'Under the Floodlights', 96, 'menu'],
  ['cryptball', 'Iron Court', 128, 'breaks'],
  ['cryptkick', 'Graveyard Strut', 120, 'funk'],
  ['rift-volley', 'Across the Rift', 132, 'flight'],
  ['cryptcheck', 'Black Ice', 144, 'drive'],
  ['crypt-dodge', 'Bone Rattle', 136, 'ricochet'],
  ['crypt-guardian', 'The Last Gate', 112, 'boss'],
  ['results', 'Still Standing', 96, 'results'],
];
const patch = (id, waveform, brightness, decaySeconds, release=.08, attack=.006, duty=.4) => ({id,name:id,waveform,brightness,decaySeconds,release,attack,duty});
const patches = [
  patch('sub','harmonic-bass',.3,.5,.08),
  patch('grit','sawtooth',.025,.18,.045),
  patch('brass','sawtooth',.08,.38,.15,.025),
  patch('organ','pulse',.045,.3,.12,.012,.3),
  patch('glass','sine',.32,.3,.32),
  patch('air','triangle',.045,2,.6,.22),
  patch('kit','noise',.8,.8,.02,.002),
  patch('tom','sine',.06,.13,.07,.003),
];
const lanes = [
  ['bass','sub','bass',.94,0,1], ['grit','grit','bass',.20,0,1],
  ['kick','kit','drums',1,0,1], ['snare','kit','drums',.66,.05,1],
  ['hat','kit','drums',.25,.22,1], ['toms','tom','drums',.40,-.16,1],
  ['pad','air','harmony',.16,-.25,1],
  ['hook','brass','melody',.37,.12,1], ['answer','glass','melody',.29,-.3,1],
  ['pressure-pulse','organ','harmony',.24,-.12,2],
  ['pressure-drums','kit','drums',.28,-.22,2],
];
// E minor identity: a low syncopated call, a rising fourth, then a falling answer.
// Each activity changes rhythm, register and phrasing, not just BPM.
const calls = [
  [[.5,64,.45],[1.25,71,.3],[2,67,.7],[3.25,66,.35]],
  [[.25,64,.3],[1,67,.4],[2.5,74,.75]],
  [[0,72,.6],[1.5,71,.4],[2.25,67,.55],[3.25,69,.35]],
  [[.5,66,.4],[1.25,67,.3],[2,64,1.25]],
];
export function makeScore(id) {
  const a = arrangements.find(a=>a[0]===id);
  if(!a) throw Error('Unknown arrangement '+id);
  const [,title,bpm,style]=a, quiet=style==='menu'||style==='results';
  const bars=quiet?16:32, lengthTicks=bars*1920;
  const tracks=lanes.map(([id,patchId,role,gain,pan,minEnergy])=>({id,name:id,patchId,role,gain,pan,minEnergy}));
  if(style==='funk') tracks.find(t=>t.id==='hook').patchId='organ';
  if(style==='flight') tracks.find(t=>t.id==='hook').patchId='glass';
  if(quiet) tracks.forEach(t=>{t.gain*=t.role==='drums'?.48:.8;});
  const patterns=tracks.map(t=>({id:t.id,name:t.name,lengthTicks,notes:[]}));
  const add=(lane,bar,beat,pitch,dur=.25,velocity=.75)=>{
    const p=patterns.find(p=>p.id===lane),startTick=Math.round((bar*4+beat)*480);
    p.notes.push({id:lane+'-'+p.notes.length,startTick,pitch,durationTicks:Math.max(1,Math.min(Math.round(dur*480),lengthTicks-startTick)),velocity});
  };
  for(let b=0;b<bars;b++) {
    const section=Math.floor(b/8), breath=!quiet&&section===2;
    const root=[28,28,36,36,31,31,26,35][b%8];
    const bass=quiet?[0,1.75,3]:style==='ricochet'?[0,.5,1.75,2.5,3.75]:style==='boss'?[0,.75,1.5,2.5,3.25]:style==='drive'?[0,.5,1,1.5,2,2.5,3,3.5]:style==='funk'?[0,.75,1.5,2.75,3.5]:style==='flight'?[0,1.5,2,3.25]:[0,.75,1.5,2,2.75,3.5];
    bass.forEach((at,i)=>{
      if(breath&&i%2) return;
      const note=root+(i===bass.length-1&&b%2?12:i===2?7:0),d=quiet?.65:i===0?.40:.24;
      add('bass',b,at,note,d,i===0?.95:.76);
      if(!quiet) add('grit',b,at,note+12,d*.8,.7);
    });
    const kicks=quiet?[0,2.5]:style==='ricochet'?[0,.75,2.5,3.75]:style==='drive'?[0,1,2,3]:style==='boss'?[0,1.5,2.75]:style==='flight'?[0,1.75,2.5]:[0,1.5,2,3.25];
    kicks.forEach((at,i)=>{if(!breath||i<2)add('kick',b,at,36,.25,i===0?.96:.76);});
    if(!quiet) for(const at of style==='boss'?[2]:[1,3]) add('snare',b,at,38,.21,.8);
    if(!quiet&&b%2) add('snare',b,2.75,38,.12,.24);
    for(let i=0;i<(quiet?4:8);i++) {
      if(breath&&i%2)continue;
      const swing=style==='funk'&&i%2?.055:0;
      add('hat',b,i*(quiet?1:.5)+swing,42,.10,i%2?.6:.36);
    }
    if(!quiet&&b%4===3) {
      add('hat',b,3.5,46,.3,.55);
      if(!breath) [3,3.5,3.75].forEach((at,i)=>add('toms',b,at,[52,47,40][i],.18,.7));
    }
    if(b%2===0) for(const n of [root+24,root+31]) add('pad',b,0,n,7.5,.52);
    const speak=quiet?b%2===0:style==='boss'?b%4<2:breath?b%4===0:b%4!==3;
    if(speak) for(const [at,n,d] of calls[Math.floor(b/2)%4]) {
      const transpose=style==='boss'?-12:style==='flight'?12:section===1?-12:0;
      add('hook',b,at,n+transpose,d*(quiet?1.25:style==='ricochet'?.45:1),quiet?.58:.73);
      // A quiet octave reinforcement gives the brass more body.
      if(style==='boss'||style==='drive') add('answer',b,at,n-12,d*.8,.30);
    }
    if(b%4===3&&!breath) for(const [i,n] of [71,74,67,66].entries())
      add('answer',b,.5+i*.75,n+(style==='flight'?12:0),.3,.60);
    if(style==='ricochet'&&b%2===1) for(const [i,n] of [52,59,47].entries()) add('toms',b,.75+i,n,.14,.65);
    if(quiet&&b%4===1) add('answer',b,2.5,76,.8,.52);
    if(!quiet) {
      for(let i=0;i<8;i++) add('pressure-pulse',b,i*.5+.25,root+24+[0,7,12,7][i%4],.14,i%2?.48:.7);
      for(const at of [.75,1.75,2.75,3.75]) add('pressure-drums',b,at,42,.07,.55);
      if(b%4===3) for(const at of [3.25,3.5,3.75]) add('pressure-drums',b,at,38,.1,.48);
    }
  }
  return {schemaVersion:1,id:'crypt-concept-'+id,title,ppq:480,bpm,meter:[4,4],scale:{root:4,mode:'minor'},playback:'loop',lengthTicks,loop:{startTick:0,endTick:lengthTicks},tracks,patterns,
    clips:patterns.map(p=>({id:p.id,trackId:p.id,patternId:p.id,startTick:0,repeats:1,transpose:0})),
    sections:Array.from({length:bars/8},(_,i)=>({id:'s'+i,name:['Call','Answer','Breath','Return'][i],startTick:i*15360,lengthTicks:15360})),patches};
}
export function makeSting(kind) {
  const score=makeScore('cryptball');
  score.id='crypt-sting-'+kind;score.title=kind;score.bpm=120;
  score.playback='one-shot';score.loop=null;score.lengthTicks=3840;score.sections=[];
  score.patterns.forEach(p=>{p.notes=[];p.lengthTicks=3840;});
  const notes=kind==='victory'?[64,71,76,79]:kind==='defeat'?[67,66,64,59]:kind==='match-point'?[64,71]:kind==='start'?[52,59,64]:[64,76];
  notes.forEach((pitch,i)=>score.patterns.find(p=>p.id==='hook').notes.push({id:'h'+i,startTick:i*180,pitch,durationTicks:i===notes.length-1?700:140,velocity:.8}));
  score.patterns.find(p=>p.id==='bass').notes.push({id:'b',startTick:0,pitch:28,durationTicks:1100,velocity:.9});
  score.patterns.find(p=>p.id==='kick').notes.push({id:'k',startTick:0,pitch:36,durationTicks:150,velocity:.9});
  return score;
}
