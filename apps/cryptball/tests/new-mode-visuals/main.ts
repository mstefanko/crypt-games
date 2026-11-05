import { PixiStage } from '@onepage/game-runtime/pixi';
import { CryptballPresenter } from '../../src/presenter';
import { createCryptballSession } from '../../sim/session';
import { resizeCryptball } from '../../src/viewport';
import type { GuardianWeapon } from '../../sim/modes/crypt-guardian/types';
const canvas=document.querySelector('canvas')!,root=document.querySelector<HTMLElement>('#stage')!;
const stage=new PixiStage(canvas);await stage.init();resizeCryptball(stage,root);
const presenter=new CryptballPresenter(stage);await presenter.init();await presenter.loadSport('crypt-guardian');
async function show({weapon='cannon',size=100,palette='violet',phase='tell',scale=1,reduced=false}:{weapon?:GuardianWeapon;size?:90|100|110;palette?:'violet'|'verdigris'|'ember';phase?:'tell'|'active'|'recover'|'defeat'|'revive';scale?:1|3;reduced?:boolean}={}){
  let session:ReturnType<typeof createCryptballSession>|undefined;
  for(let seed=0;seed<3000;seed++){
    const candidate=createCryptballSession({sportId:'crypt-guardian',mode:'practice',seed,guardianPractice:{immortal:true}}),d=candidate.observe().guardian!.descriptor;
    if(d.weapon===weapon&&d.size===size&&d.palette===palette){session=candidate;break;}
  }
  if(!session)throw Error('No legal seeded descriptor');
  let state=session.observe();
  for(let t=0;t<1000;t++){
    session.step({});state=session.observe();const a=state.guardian!.attack;if(!a)continue;
    const elapsed=a.elapsed-a.timing.tell;
    if(phase==='tell'&&a.locked&&elapsed<0||phase==='active'&&elapsed>=0&&elapsed<a.timing.active||phase==='recover'&&elapsed>=a.timing.active)break;
    if((phase==='defeat'||phase==='revive')&&t>120)break;
  }
  if(phase==='defeat'){state.guardian!.hp=0;state.guardian!.outcome='victory';state.phase='results';}
  if(phase==='revive'){const a=state.guardian!.athletes[state.players[1].id];a.hp=0;a.status='down';a.reviveBy=state.players[0].id;a.reviveTicks=45;}
  root.style.width=`${640*scale}px`;root.style.height=`${400*scale}px`;resizeCryptball(stage,root);await presenter.prewarm(state);
  presenter.render(state,session.drainEvents(),reduced);stage.render(0);
  const summary={descriptor:state.guardian!.descriptor,hp:state.guardian!.hp,attack:state.guardian!.attack,phase,scale,reduced,pose:canvas.dataset.guardianPose,cover:state.guardian!.cover};
  document.querySelector('#status')!.textContent=JSON.stringify(summary,null,2);return summary;
}
Object.assign(window,{newModeVisualFixture:{show}});await show();document.body.dataset.ready='true';
