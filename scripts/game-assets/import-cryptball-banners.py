"""Compose generated blank cloth + existing club SVG rasterizations in arena coordinates.
All colored baked flags are covered by opaque replacement cloth, not tinted logos.
"""
from pathlib import Path
import json, hashlib, math
from PIL import Image, ImageDraw
ROOT=Path(__file__).resolve().parents[2]
SRC=ROOT/'apps/cryptball/art-src/banners-v1'
OUT=ROOT/'apps/cryptball/public/assets/cryptball-banners'
OUT.mkdir(parents=True,exist_ok=True)
COLORS={'rams':'72d9d6','foxes':'f08b59','owls':'6f9fff','gators':'9dc95b','bats':'be8ce8','hornets':'f4ce55'}
# Top-left, top-right, bottom-right, bottom-left. Side flags follow the painted wall planes.
SITES={0:{'rear': [[(7,181),(29,166),(29,251),(7,266)],[(80,127),(98,114),(98,160),(80,176)]], 'front': [[(110,316),(150,316),(150,367),(110,367)],[(219,316),(260,316),(260,367),(219,367)]]},1:{'rear':[[(542,114),(560,127),(560,176),(542,160)],[(611,166),(634,182),(634,266),(611,251)]], 'front':[[(381,316),(421,316),(421,367),(381,367)],[(489,316),(530,316),(530,367),(489,367)]]}}
cloth=Image.open(SRC/'blank-cloth.png').convert('RGB').crop((155,80,875,1280)).resize((40,52),Image.Resampling.NEAREST)

def flag(team):
    color=tuple(bytes.fromhex(COLORS[team])); f=cloth.convert('RGBA')
    # Keep the generated folds/luminance; replace neutral cloth chroma with team fabric.
    for y in range(f.height):
      for x in range(f.width):
        r,g,b,a=f.getpixel((x,y)); light=(r+g+b)/3/75
        f.putpixel((x,y),tuple(min(255,round(c*light*.65)) for c in color)+(255,))
    d=ImageDraw.Draw(f);d.rectangle((0,0,39,51),outline='#d2a569',width=2)
    emblem=Image.open(SRC/f'emblem-{team}.png').convert('RGBA').resize((31,31),Image.Resampling.NEAREST)
    f.alpha_composite(emblem,(4,9));return f

def place(canvas,im,q):
    # Vertical wall planes are affine parallelograms. Inverse affine keeps pixels crisp.
    (x0,y0),(x1,y1),(x2,y2),(x3,y3)=q
    ax=(x1-x0)/im.width;ay=(y1-y0)/im.width;bx=(x3-x0)/im.height;by=(y3-y0)/im.height
    det=ax*by-ay*bx
    coeff=(by/det,-bx/det,(bx*y0-by*x0)/det,-ay/det,ax/det,(ay*x0-ax*y0)/det)
    warped=im.transform((640,400),Image.Transform.AFFINE,coeff,Image.Resampling.NEAREST)
    canvas.alpha_composite(warped)
frames={};pages={}
for team in COLORS:
  for side in (0,1):
    for layer in ('rear','front'):
      name=f'banners.{team}.{side}.{layer}'
      canvas=Image.new('RGBA',(640,400))
      for quad in SITES[side][layer]:place(canvas,flag(team),quad)
      bounds=canvas.getbbox();canvas=canvas.crop(bounds)
      filename=f'{team}-{side}-{layer}.png';canvas.save(OUT/filename)
      page=str(len(pages));pages[page]=filename
      frames[name]={'pageId':page,'x':0,'y':0,'width':canvas.width,'height':canvas.height,'pivot':{'x':-bounds[0],'y':-bounds[1]}}
(OUT/'manifest.json').write_text(json.dumps({'version':2,'recipeId':'cryptball-team-banners-v1','sampling':'nearest','pages':pages,'frames':frames},indent=2)+'\n')
print(f'Composed {len(frames)} registered banner layers.')
