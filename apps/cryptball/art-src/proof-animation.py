"""Emit a native-pixel animation/feet inspection sheet from the actual shipped atlas."""
from PIL import Image,ImageDraw
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];BASE=ROOT/'apps/cryptball/public/assets/cryptball';m=json.loads((BASE/'manifest.json').read_text());pages={k:Image.open(BASE/v).convert('RGBA') for k,v in m['pages'].items()}
headings=['E','NEE','NE','NNE','N','NNW','NW','NWW','W','SWW','SW','SSW','S','SSE','SE','SEE'];pictures=[]
for tick in range(96):
 action=['run','strike','recoil','celebrate'][tick//24];im=Image.new('RGBA',(1024,360),'#435e6c');d=ImageDraw.Draw(im)
 for row,(team,role) in enumerate([('ivory','warrior'),('ivory','knight'),('ember','warrior'),('ember','knight')]):
  for col,h in enumerate(headings):
   ids=m['clips'][f'{team}.{role}.{action}.{h}'];f=m['frames'][ids[(tick//3)%len(ids)]];sprite=pages[f['pageId']].crop((f['x'],f['y'],f['x']+f['width'],f['y']+f['height']));x=32+col*64;y=68+row*82
   d.line((x-8,y,x+8,y),fill='#d0cda8');d.line((x,y-3,x,y+3),fill='#d0cda8');im.alpha_composite(sprite,(x+round(f['trim']['x']-f['pivot']['x']),y+round(f['trim']['y']-f['pivot']['y'])));d.text((x-25,y+7),h,fill='#e7e4c8')
  d.text((4,row*82+2),f'{team} {role} {action}',fill='#fff4ce')
 pictures.append(im.convert('RGB'))
pictures[0].save(Path(__file__).parent/'animation-proof.gif',save_all=True,append_images=pictures[1:],duration=83,loop=0)
print('Wrote all16-heading four-variant moving proof with source-space feet crosses.')
