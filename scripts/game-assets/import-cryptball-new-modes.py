"""Pack the preserved 96-frame source kit, with explicit cosmetic sockets.
Run with .venv-assets/bin/python. Gameplay never reads these screen-space anchors.
"""
from pathlib import Path
import json, hashlib, importlib.util, colorsys
from PIL import Image, ImageDraw
ROOT=Path(__file__).resolve().parents[2]
SRC=ROOT/'apps/cryptball/art-src/new-modes-v1'
OUT=ROOT/'apps/cryptball/public/assets/cryptball-new-modes'
OUT.mkdir(parents=True,exist_ok=True)
def module(name,file):
 s=importlib.util.spec_from_file_location(name,Path(__file__).with_name(file));m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
sprites=module('sprites','cryptball-sprite-tools.py');materials=module('materials','cryptball-team-palettes.py')
source=json.loads((SRC/'manifest.json').read_text());assets=[];clips={};anchors={};images={}
DIRECTIONS=['E','SE','S','SW','W','NW','N','NE']
POSES=['catch-ready','catch-contact','carry','throw-windup','throw-release','throw-follow','pass-release','hit-recoil']
# Authored hand centers on the normalized 112x80 pose, relative to foot pivot.
# Each row follows POSES; rear-facing poses retain their actual visible hand.
HANDS={
'E':[(16,-28),(12,-24),(11,-20),(-11,-39),(18,-30),(13,-24),(8,-19),(3,-25)],
'SE':[(15,-28),(12,-24),(11,-20),(-11,-39),(17,-30),(12,-24),(7,-19),(4,-25)],
'S':[(0,-28),(0,-23),(0,-20),(-10,-39),(0,-29),(0,-24),(0,-19),(0,-24)],
'SW':[(-15,-28),(-12,-24),(-11,-20),(11,-39),(-17,-30),(-12,-24),(-7,-19),(-4,-25)],
'W':[(-16,-28),(-12,-24),(-11,-20),(11,-39),(-18,-30),(-13,-24),(-8,-19),(-3,-25)],
'NW':[(-14,-29),(-10,-24),(-11,-21),(10,-39),(-17,-31),(-12,-25),(-7,-20),(-4,-25)],
'N':[(0,-28),(11,-24),(11,-21),(11,-39),(13,-31),(7,-25),(0,-20),(0,-24)],
'NE':[(14,-29),(10,-24),(11,-21),(11,-39),(17,-31),(12,-25),(7,-20),(4,-25)]}
BOSS_HANDS=[(24,-20),(22,-20),(25,-22),(35,-36),(28,-48),(30,-47),(20,-40),(24,-20),(-28,-67),(35,-32),(-24,-7),(24,-20),(27,-46),(26,-20),(24,-10),(0,-9)]
def add(name,im,pivot,socket=None):
 assets.append((name,im,pivot,1/12));images[name]=im
 if socket:anchors[name]=socket
for name,meta in source['frames'].items():
 im=Image.open(SRC/meta['file']).convert('RGBA');pivot=meta['pivot']
 if name.startswith('athlete.'):
  _,direction,pose=name.split('.');dx,dy=HANDS[direction][POSES.index(pose)]
  for team in materials.PALETTES:
   key=f'new.{team}.{pose}.{direction}';add(key,materials.team_variant(im,team),pivot,{'hand':{'x':56+dx,'y':70+dy}});clips[f'new.{team}.{pose}.{direction}']=[key]
 elif name.startswith('guardian.'):
  index=list(k for k in source['frames'] if k.startswith('guardian.')).index(name);dx,dy=BOSS_HANDS[index]
  # Constrained purple armor material recolor; ivory, skin, metal and fire remain.
  for palette,hue in [('violet',None),('verdigris',.44),('ember',.04)]:
   variant=im.copy();pixels=variant.load()
   if hue is not None:
    for y in range(im.height):
     for x in range(im.width):
      r,g,b,a=pixels[x,y];h,s,v=colorsys.rgb_to_hsv(r/255,g/255,b/255)
      if a and .65<=h<=.96 and s>=.10:
       rr,gg,bb=colorsys.hsv_to_rgb(hue,min(.6,s*1.25),v);pixels[x,y]=(round(rr*255),round(gg*255),round(bb*255),a)
   add(f'new.guardian.{palette}.{name[9:]}',variant,pivot,{'weapon':{'x':80+dx,'y':112+dy},'crown':{'x':80,'y':39 if index<14 else 76}})
 else:
  key=f'new.{name}';box=im.getbbox()
  # Modules attach by their grip; objects retain authored floor pivots.
  socket={'grip':{'x':(box[0]+box[2])/2,'y':box[1]+(5 if name!='object.maul' else 3)}} if name in ['object.cannon','object.hook','object.maul'] else None
  add(key,im,pivot,socket)
frames,pages=sprites.pack_atlas(assets,OUT)
for name,socket in anchors.items():frames[name]['anchors']=socket
sources=[{'file':n,'sha256':hashlib.sha256((SRC/n).read_bytes()).hexdigest()} for n in ['athlete-front.png','athlete-back.png','guardian.png','equipment.png','manifest.json']]
manifest={'version':2,'recipeId':'cryptball-new-modes-v1-2026-11-05','sampling':'nearest','pages':pages,'frames':frames,'clips':clips,'provenance':{'sourceFrames':96,'athletePoses':64,'guardianPoses':16,'objects':16,'sources':sources,'teamMaterialMask':'Existing teal-only constrained team conversion; neutral armor and skin preserved','guardianMaterialMask':'Purple armor hue only; telegraphs have fixed semantic colors','sockets':'Authored hand, weapon, crown and grip pixel anchors in original normalized frame space; cosmetic only'}}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
(OUT/'LICENSES.txt').write_text('Original OpenAI ImageGen artwork. Preserved sources, prompts, extraction and source QA: apps/cryptball/art-src/new-modes-v1. Runtime importer: scripts/game-assets/import-cryptball-new-modes.py. No third-party sprites.\n')
# Native and 3x socket proof against alternating light/dark backgrounds.
proof=Image.new('RGBA',(8*112,8*92))
draw=ImageDraw.Draw(proof)
for row,pose in enumerate(POSES):
 for col,direction in enumerate(DIRECTIONS):
  key=f'new.ivory.{pose}.{direction}';x=col*112;y=row*92
  draw.rectangle((x,y,x+111,y+91),fill='#e1d4be' if (row+col)%2 else '#202530');proof.alpha_composite(images[key],(x,y+10));a=anchors[key]['hand'];draw.ellipse((x+a['x']-2,y+10+a['y']-2,x+a['x']+2,y+10+a['y']+2),outline='#ff4455');draw.text((x+2,y),direction+' '+pose,fill='#9b7453')
proof.save(SRC/'runtime-sockets-1x.png');proof.resize((proof.width*3,proof.height*3),Image.Resampling.NEAREST).save(SRC/'runtime-sockets-3x.png')
qa={'sourceFrames':len(source['frames']),'runtimeFrames':len(frames),'pages':len(pages),'handSockets':sum('hand'in a for a in anchors.values()),'weaponSockets':sum('weapon'in a for a in anchors.values()),'allClipsResolve':all(all(i in frames for i in ids)for ids in clips.values()),'allRgba':all(i.mode=='RGBA'for i in images.values()),'runtimeBytes':sum(p.stat().st_size for p in OUT.iterdir())}
(SRC/'runtime-qa.json').write_text(json.dumps(qa,indent=2)+'\n');print(json.dumps(qa))
