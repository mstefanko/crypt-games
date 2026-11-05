"""Original native-resolution pixel balls and contact clips; Pillow, no source edits."""
from pathlib import Path
import json
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'apps/cryptball/public/assets/cryptball-balls'
ART = ROOT / 'apps/cryptball/art-src/balls'
OUT.mkdir(parents=True, exist_ok=True)
ART.mkdir(parents=True, exist_ok=True)
assets = []
clips = {}

def add(name, image):
    assets.append((name, image))

def ball(sport, frame, width, height):
    # Deliberately draw at delivery resolution: panel seams remain crisp at 1x.
    im = Image.new('RGBA', (20, 20))
    d = ImageDraw.Draw(im)
    x, y = (20-width)//2, (20-height)//2
    box = (x, y, x+width-1, y+height-1)
    d.ellipse(box, fill='#162d3c')
    d.ellipse((x+1,y+1,x+width-2,y+height-2), fill='#f1ead0' if sport=='kick' else '#fff2cb')
    panel = Image.new('RGBA', im.size)
    p = ImageDraw.Draw(panel)
    shift = frame % 4
    if sport == 'kick':
        cx = x + 2 + shift
        cy = y + height//2 + frame//4
        p.polygon([(cx-1,cy-1),(cx+1,cy-1),(cx+2,cy),(cx,cy+2),(cx-2,cy)], fill='#243745')
        p.line([(cx-1,cy-1),(cx-2,y),(x,y+height-2)], fill='#677b7e')
        p.line([(cx+1,cy-1),(x+width-1,y+1)], fill='#677b7e')
        p.line([(cx,cy+2),(cx+1,y+height-1)], fill='#677b7e')
    else:
        # Blue and golden curved bands distinguish this ball from the football.
        for offset, color in [(0,'#388cb5'),(4,'#d7a94f')]:
            cx = x + ((frame+offset) % 8)-2
            p.arc((cx,y-2,cx+width+1,y+height+1), 95, 265, fill=color, width=2)
        p.arc((x-2,y+height//2-2,x+width+2,y+height+1),180,340,fill='#607d8a',width=1)
    # Clip all seams to the ball silhouette; never enlarge the physical footprint.
    panel.putalpha(Image.composite(panel.getchannel('A'), Image.new('L',im.size), im.getchannel('A')))
    im.alpha_composite(panel)
    ImageDraw.Draw(im).point((x+2,y+1), fill='#ffffff')
    return im

for sport, diameter in [('kick',12),('volley',12)]:
    for frame in range(8): add(f'balls.{sport}.spin.{frame}',ball(sport,frame,diameter,diameter))
    # Pixel-authored squash, rebound and settle, keeping a common center pivot.
    for index,(w,h) in enumerate([(diameter+3,diameter-3),(diameter+2,diameter-2),(diameter-1,diameter+1),(diameter,diameter)]):
        add(f'balls.{sport}.contact.{index}',ball(sport,2,w,h))
    clips[f'balls.{sport}.contact']=[f'balls.{sport}.contact.{i}' for i in range(4)]

for kind,color in [('set','#b0f4e6'),('dig','#ffd688'),('attack','#fff5ce')]:
    ids=[]
    for frame in range(5):
        im=Image.new('RGBA',(20,20)); d=ImageDraw.Draw(im); r=3+frame
        if kind=='set':
            d.arc((10-r,10-r,10+r,10+r),195,345,fill=color,width=1)
            d.point((7-frame,9),fill=color);d.point((13+frame,9),fill=color)
        elif kind=='dig':
            d.line([(10-r,12),(10,14+frame//2),(10+r,12)],fill=color,width=1)
            d.line([(7,6-frame),(6,9-frame)],fill=color)
            d.line([(13,6-frame),(14,9-frame)],fill=color)
        else:
            for dx,dy in [(-1,-1),(1,-1),(-1,1),(1,1)]:
                d.line([(10+dx*r,10+dy*r),(10+dx*(r+2),10+dy*(r+2))],fill=color,width=1)
        name=f'balls.fx.{kind}.{frame}';add(name,im);ids.append(name)
    clips[f'balls.fx.{kind}']=ids

page=Image.new('RGBA',(512,64));frames={}
proof=Image.new('RGBA',(12*28,6*36),'#30283d'); d=ImageDraw.Draw(proof)
for i,(name,im) in enumerate(assets):
    x=(i%24)*21+1;y=(i//24)*21+1;page.alpha_composite(im,(x,y))
    frames[name]={'pageId':'0','x':x,'y':y,'width':20,'height':20,'originalSize':{'width':20,'height':20},'trim':{'x':0,'y':0},'pivot':{'x':10,'y':10},'duration':1/12,'mirrorable':False}
    px=(i%12)*28;py=(i//12)*36
    proof.alpha_composite(im,(px+4,py+9));d.text((px+1,py),str(i),fill='#fff2cb')
page.save(OUT/'page-0.png')
proof.save(ART/'contact-sheet-1x.png')
proof.resize((proof.width*4,proof.height*4),Image.Resampling.NEAREST).save(ART/'contact-sheet-4x.png')
sequence=[]
lookup=dict(assets)
for step in range(28):
    preview=Image.new('RGBA',(96,32),'#30283d')
    for col,sport in enumerate(['kick','volley']):
        name=f'balls.{sport}.spin.{step%8}' if step<16 or step>=24 else f'balls.{sport}.contact.{min(3,(step-16)//2)}'
        preview.alpha_composite(lookup[name],(col*32+6,6))
    if 16<=step<26: preview.alpha_composite(lookup[f'balls.fx.attack.{min(4,(step-16)//2)}'],(70,6))
    sequence.append(preview.resize((384,128),Image.Resampling.NEAREST).convert('RGB'))
sequence[0].save(ART/'spin-contact-proof.gif',save_all=True,append_images=sequence[1:],duration=85,loop=0)
manifest={'version':2,'recipeId':'cryptball-mode-balls-v1','sampling':'nearest','pages':{'0':'page-0.png'},'frames':frames,'clips':clips,'provenance':{'source':'Original code-authored native pixel geometry','tools':['Python','Pillow'],'recipe':'scripts/game-assets/import-cryptball-balls.py','solidDiameters':{'kick':12,'volley':12},'frameOrder':[name for name,_ in assets]}}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
(OUT/'LICENSES.txt').write_text('Original code-authored pixel ball and contact sprites. Recipe: scripts/game-assets/import-cryptball-balls.py. No third-party pixels.\n')
print(f'{len(frames)} ball/contact frames')
