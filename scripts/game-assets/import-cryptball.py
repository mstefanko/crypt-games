"""Rebuild original Cryptball prototype sample/atlas. Requires local Pillow only."""
from pathlib import Path
import json, math, re, sys
sys.dont_write_bytecode = True
from PIL import Image, ImageDraw, ImageFont
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'apps/cryptball/public/assets/cryptball'; ART=ROOT/'apps/cryptball/art-src'; OUT.mkdir(parents=True,exist_ok=True)
# Export the authoritative authored spec at art-build time; never maintain a second court spec.
spec_source=(ROOT/'apps/cryptball/sim/spec.ts').read_text()
spec_match=re.search(r'export const COURT = Object.freeze\(\{([^}]+)\}',spec_source)
assert spec_match, 'Court spec syntax changed: update exporter'
COURT={key:int(value) for key,value in re.findall(r'(\w+):\s*(\d+)',spec_match[1])}
(OUT/'court-spec.json').write_text(json.dumps(COURT,indent=2)+'\n')
L=COURT['halfLength'];W=COURT['halfWidth'];G=COURT['goalHalfMouth'];D=COURT['netDepth']
HEADINGS=['E','NEE','NE','NNE','N','NNW','NW','NWW','W','SWW','SW','SSW','S','SSE','SE','SEE']
assets=[]; clips={}; selection=[]
def add(name,im,pivot=None,duration=.083333):
 assets.append((name,im,pivot or (im.width/2,im.height),duration))
view_source=(ROOT/'apps/cryptball/src/projection.ts').read_text()
VIEW={key:float(value) for key,value in re.findall(r'(width|height|originX|originY|depth):\s*([\d.]+)',view_source)}
rotation_match=re.search(r'rotation:\s*(-?)Math.PI\s*/\s*(\d+)',view_source)
assert rotation_match,'Projection syntax changed: update exporter'
rotation=(-1 if rotation_match[1] else 1)*math.pi/int(rotation_match[2])
def project(u,v):
 x=math.cos(rotation)*u-math.sin(rotation)*v;y=math.sin(rotation)*u+math.cos(rotation)*v
 return (round(VIEW['originX']+(x-y)*math.sqrt(2)/2),round(VIEW['originY']+(x+y)*math.sqrt(2)*VIEW['depth']/2))
def canvas(w,h):return Image.new('RGBA',(w,h))
# Original procedural sports poses replace the unverified purchased-source dependency.
import importlib.util
module=importlib.util.spec_from_file_location('cryptball_athlete',Path(__file__).with_name('cryptball-athlete.py'))
athletes=importlib.util.module_from_spec(module);module.loader.exec_module(athletes)
sample=[]
for team in ['ivory','ember']:
 for role in ['warrior','knight','keeper']:
  for action,count in [('idle',2),('run',8),('sprint',8),('strike',8),('pass',6),('power',8),('slide-launch',3),('slide',4),('slide-recover',4),('keeper-shuffle',8),('keeper-dive',4),('recoil',3),('celebrate',4)]:
   authored={}
   for h in range(8):
    ids=[]
    for frame in range(count):
     im=athletes.athlete(team,role=='keeper',action,h,frame,count)
     fid=f'{team}.{role}.{action}.{HEADINGS[h*2]}.{frame}'
     add(fid,im,(32,52));ids.append(fid)
     if team=='ivory' and role=='warrior' and action in ['idle','sprint','strike','slide'] and frame==count//2:sample.append((action,h,im))
    authored[h]=ids
   for h,heading in enumerate(HEADINGS):clips[f'{team}.{role}.{action}.{heading}']=authored[((h+1)//2)%8]
# Build-failing structural gates; visual quality/readability still needs human review.
# Pose-forward axes must stay screen unit vectors (diagonals must not get depth twice).
for heading in range(8):
 fx,fy=athletes.screen_heading_vector(heading)
 assert abs(fx*fx+fy*fy-1)<1e-12
 if heading%2:assert abs(abs(fx)-abs(fy))<1e-12
locked={tuple(bytes.fromhex(c[1:])) for c in athletes.PALETTE}
athlete_frames=[(name,im,pivot) for name,im,pivot,duration in assets]
for name,im,pivot in athlete_frames:
 assert im.size==(72,72),(name,'frame size')
 assert pivot==(32,52),(name,'foot anchor')
 assert all(a in (0,255) and (a==0 or (r,g,b) in locked) for r,g,b,a in im.get_flattened_data()),(name,'palette / alpha')
 assert im.getbbox() is not None,(name,'empty silhouette')
qa={'status':'passed','athleteFrames':len(athlete_frames),'authoredHeadings':8,'runtimeHeadings':16,'frameSize':[72,72],'footAnchor':[32,52],'paletteColors':len(locked),'binaryAlpha':True,'humanReview':'pending; structure does not establish readability, loop quality or pose approval'}
ART.mkdir(parents=True,exist_ok=True)
(ART/'sample-qa.json').write_text(json.dumps(qa,indent=2)+'\n')
# Human review gate: real-size athlete pose contact sheet and 3x nearest sample.
sheet=canvas(8*72,4*80);sd=ImageDraw.Draw(sheet);sd.rectangle((0,0,575,319),fill='#263d4c')
for action,h,im in sample:
 row=['idle','sprint','strike','slide'].index(action);sheet.alpha_composite(im,(h*72,row*80+14));sd.text((h*72+2,row*80+2),action,fill='#fff0cf')
ART.mkdir(parents=True,exist_ok=True);(ART/'export').mkdir(exist_ok=True)
sheet.save(ART/'athlete-sample-1x.png');sheet.resize((1728,960),Image.Resampling.NEAREST).save(ART/'athlete-sample-3x.png')
# Authored low-frequency arena painting, native resolution.
im=canvas(512,320);d=ImageDraw.Draw(im)
d.rectangle((0,0,511,319),fill='#121d2b')
# Layered crypt terraces: staggered masonry, recessed arches and wedge voussoirs.
for row in range(6):
 y=27+row*10
 for n,x in enumerate(range(-25+(row%2)*13,540,26)):
  col=['#303e4a','#36444e','#3a4751','#34434d'][(n+row)%4]
  d.rectangle((x,y,x+24,y+8),fill=col,outline='#172735')
  d.line((x+2,y+1,x+22,y+1),fill='#50606a')
  if (n+row)%3==0:d.line((x+8,y+3,x+11,y+6,x+10,y+8),fill='#23333f')
for center in range(28,520,56):
 cy=53
 # Deep dark niche, then twelve individually shaded arch stones.
 d.rectangle((center-12,cy,center+12,76),fill='#101925')
 d.pieslice((center-13,cy-13,center+13,cy+13),180,360,fill='#101925')
 for k in range(9):
  lo=math.pi+k*math.pi/9+.018;hi=math.pi+(k+1)*math.pi/9-.018
  wedge=[(round(center+math.cos(t)*r),round(cy+math.sin(t)*r)) for t,r in [(lo,18),(hi,18),(hi,13),(lo,13)]]
  d.polygon(wedge,fill=['#76817e','#586773','#697679'][k%3],outline='#263643')
  d.line(wedge[:2],fill='#8d9183')
 for side in [-1,1]:
  for row in range(3):
   x=center+side*16-2;y=53+row*7
   d.rectangle((x,y,x+4,y+5),fill='#64727a',outline='#263643')
 d.rectangle((center-20,75,center+20,79),fill='#273a48')
 d.line((center-20,75,center+20,75),fill='#8e9689')
 # Spectators read as quiet silhouettes inside the architectural recess.
 for j in range(3):
  x=center-8+j*8;y=67+(j%2)*2
  d.ellipse((x-2,y-5,x+2,y-1),fill='#56636a')
  d.polygon([(x-2,y-1),(x+2,y-1),(x+4,y+5),(x-4,y+5)],fill='#253644')
# Heavy pier capitals, inset reliefs and warm torch clusters.
for x in range(0,530,56):
 d.rectangle((x-5,29,x+5,79),fill='#3f505b',outline='#172735')
 d.line((x-4,31,x-4,77),fill='#77827e')
 for y in [31,54,77]:
  d.rectangle((x-7,y,x+7,y+3),fill='#697671',outline='#263643')
 for radius,col in [(17,'#414747'),(12,'#5d554b'),(8,'#8b6a4d')]:
  d.ellipse((x-radius,43-radius//2,x+radius,43+radius//2),outline=col,width=2)
 d.rectangle((x-2,41,x+2,57),fill='#292d35');d.line((x-3,45,x+3,45),fill='#a58b69',width=2)
 d.polygon([(x-4,42),(x-5,36),(x-2,31),(x,25),(x+2,34),(x+5,37),(x+4,42)],fill='#ca7947')
 d.polygon([(x-2,41),(x-2,36),(x,31),(x+2,37),(x+1,41)],fill='#ffe1a2')
 for dx,dy in [(-9,-2),(10,3),(-12,6),(6,-6)]:d.rectangle((x+dx,43+dy,x+dx+1,44+dy),fill='#8f7557')
# Front terrace parapet: chunky edge blocks and a recessed shadow below.
d.rectangle((0,82,511,91),fill='#172734')
for n,x in enumerate(range(-8,520,20)):
 d.rectangle((x,79,x+18,85),fill=['#5b6a6d','#52636a','#63716f'][n%3],outline='#273b48')
 d.line((x+1,79,x+17,79),fill='#9c9e88')
 d.line((x+2,84,x+16,84),fill='#374c57')
for x,team in [(72,'ivory'),(398,'ember')]:
 color='#3c98a4' if team=='ivory' else '#ae5a48'
 d.polygon([(x,40),(x+23,40),(x+23,69),(x+12,77),(x,69)],fill=color,outline='#d4bd8d')
 d.line((x+2,42,x+2,66),fill='#6abec2' if team=='ivory' else '#d88863')
 d.polygon([(x+12,47),(x+17,53),(x+12,61),(x+7,53)],fill='#eed9ac')
add('stadium',im,(0,0))
im=canvas(512,320);d=ImageDraw.Draw(im)
outer=[project(u,v) for u,v in [(-L-7,-W-8),(L+7,-W-8),(L+7,W+8),(-L-7,W+8)]]
d.polygon([(x,y+7) for x,y in outer],fill='#333d40');d.polygon(outer,fill='#a89a7b',outline='#ddceb0',width=2)
inner=[project(u,v) for u,v in [(-L,-W),(L,-W),(L,W),(-L,W)]]
d.polygon(inner,fill='#435e6c',outline='#263f50',width=2)
for u in range(-L+10,L+1,24):d.line([project(u,-W+1),project(u,W-1)],fill='#486370',width=1)
for v in range(-W+16,W,16):d.line([project(-L+1,v),project(L-1,v)],fill='#405965',width=1)
# Worn pavers remain low contrast; the orb is the brightest object on the play floor.
for row,v in enumerate(range(-W+2,W-12,16)):
 for n,u in enumerate(range(-L+2,L-20,24)):
  uu=u+(row%2)*8
  if uu+22>=L:continue
  poly=[project(uu,v),project(uu+22,v),project(uu+22,v+14),project(uu,v+14)]
  d.polygon(poly,fill=['#435b68','#455f6c','#405966','#48616d'][(row+n*3)%4])
  d.line(poly[:2],fill='#506975')
  if (row+n)%4==0:
   x,y=project(uu+4,v+2);d.line((x,y,x+2,y+1,x+3,y+1),fill='#586f78')
for side,col in [(-1,'#7cacb1'),(1,'#ae806e')]:
 d.polygon([project(side*L,-W+1),project(side*(L-22),-W+1),project(side*(L-22),W-1),project(side*L,W-1)],fill=col)
d.line([project(0,-W+2),project(0,W-2)],fill='#9caeac',width=1)
crest=[project(u,v) for u,v in [(0,-23),(24,0),(0,23),(-24,0)]];d.polygon(crest,fill='#324c5e',outline='#a4b9b7',width=1)
d.line([project(-11,0),project(11,0)],fill='#c4d2c3',width=2);d.line([project(0,-12),project(0,12)],fill='#c4d2c3',width=2)
# authored wear marks aligned to travel lanes, with restrained contrast
for u,v in [(-100,20),(-82,-34),(-56,40),(-20,-44),(35,27),(78,-32),(103,44)]:
 x,y=project(u,v);d.line((x-5,y-1,x+5,y+1),fill='#536d77')
# Board masonry stays entirely outside the authoritative play rectangle.
def stone_rail(a,b,index,back=False):
 ax,ay=a;bx,by=b
 face=[(ax,ay),(bx,by),(bx,by+11),(ax,ay+11)]
 d.polygon(face,fill=['#3c4b53','#43545a','#3a4c55'][index%3],outline='#223642')
 d.line((ax+1,ay+8,bx-1,by+8),fill='#273c49')
 # A wide warm cap with three stepped material tones.
 cap=[(ax,ay-3),(bx,by-3),(bx,by+1),(ax,ay+1)]
 d.polygon(cap,fill=['#a19579','#b0a084','#9a937d'][index%3],outline='#5c665f')
 d.line((ax,ay-3,bx,by-3),fill='#dfcba3')
 if index%3==0:
  mx=round((ax+bx)/2);my=round((ay+by)/2)
  d.line((mx-2,my-2,mx,my,mx+1,my+2),fill='#656d64')
 d.rectangle((round(ax),round(ay+4),round(ax+1),round(ay+6)),fill='#788279')
for n,u in enumerate(range(-L-7,L+7,20)):
 stone_rail(project(u,W+8),project(min(L+7,u+19),W+8),n)
 # Far cap is lower contrast and doesn't enter the play floor.
 stone_rail(project(u,-W-8),project(min(L+7,u+19),-W-8),n+2,True)
for sign in [-1,1]:
 for n,v in enumerate(range(-W-8,W+8,18)):
  if -G-10<v<G+2:continue
  stone_rail(project(sign*(L+7),v),project(sign*(L+7),min(W+8,v+17)),n)
# Stone chips catch warm torchlight; restrained chips keep the ball readable.
for j in range(90):
 u=-L+12+(j*47)%(2*L-24);v=-W+12+(j*31)%(2*W-24)
 x,y=project(u,v);d.line((x,y,x+2+j%3,y),fill=['#516a73','#3a5361','#617780'][j%3])
# Keeper center uses 8px rounded corners; the painted outer edge includes 7px body.
for sign in [-1,1]:
 front=L-COURT['creaseDepth'];half=COURT['creaseHalfWidth'];radius=15
 points=[]
 for j in range(13):
  angle=math.pi+j*math.pi/24
  points.append(project(sign*(front+radius+radius*math.cos(angle)),-half+radius+radius*math.sin(angle)))
 points.extend([project(sign*L,-half),project(sign*L,half)])
 for j in range(13):
  angle=math.pi/2+j*math.pi/24
  points.append(project(sign*(front+radius+radius*math.cos(angle)),half-radius+radius*math.sin(angle)))
 points.append(points[0]);d.line(points,fill='#9dafaa',width=1)
# Warm pixel rings around court torches; no blur/smooth resampling.
for u,v in [(-L-4,-W-5),(L+4,W+5)]:
 x,y=project(u,v)
 for radius,col in [(13,'#776958'),(8,'#aa8b60'),(3,'#e0b778')]:
  d.arc((x-radius,y-radius//3,x+radius,y+radius//3),0,150,fill=col,width=1)
add('court',im,(0,0))
for side in ['left','right']:
 sign=-1 if side=='left' else 1
 for layer in ['back','front','post.far','post.near']:
  im=canvas(512,320);d=ImageDraw.Draw(im)
  a,b=project(sign*L,-G),project(sign*L,G);c,e=project(sign*(L+D),-G),project(sign*(L+D),G)
  if layer=='back':
   d.polygon([a,b,e,c],fill='#162c3a',outline='#7d897e',width=2)
   d.polygon([(c[0],c[1]-15),(e[0],e[1]-15),e,c],fill='#172b36')
   for v in range(-G,G+1,6):d.line([project(sign*(L+1),v),project(sign*(L+D),v)],fill='#68878a')
   d.line([(c[0],c[1]-13),(e[0],e[1]-13),e,c,(c[0],c[1]-13)],fill='#9eaa9c',width=1)
   for k in range(1,5):
    t=k/5;x=round(c[0]+(e[0]-c[0])*t);y=round(c[1]+(e[1]-c[1])*t);d.line((x,y-14,x,y),fill='#607d80')
   for z in [3,7,11,15]:d.line([(c[0],c[1]-z),(e[0],e[1]-z)],fill='#526d73')
   d.line([(a[0],a[1]-14),(c[0],c[1]-15),(e[0],e[1]-15),(b[0],b[1]-14)],fill='#b1b49c',width=2)
  else:
   for x,y in ([a,b] if layer=='front' else [a] if layer=='post.far' else [b]):
    d.rectangle((x-3,y-9,x+3,y+1),fill='#a79e82',outline='#e0d3aa');d.rectangle((x-3,y-10,x+3,y-8),fill='#74d5da' if side=='left' else '#eb936c')
  add(f'goal.{side}.{layer}',im,(0,0))
for team,color in [('ivory','#81e3e3'),('ember','#ec9570')]:
 im=canvas(16,16);d=ImageDraw.Draw(im)
 if team=='ivory':d.polygon([(8,0),(15,8),(8,15),(0,8)],fill='#e9e5ce',outline='#263d4c');d.polygon([(8,3),(12,8),(8,12),(4,8)],fill=color)
 else:d.ellipse((0,0,15,15),fill='#d8b678',outline='#263d4c');d.polygon([(8,2),(12,10),(8,13),(4,10)],fill=color)
 add('crest.'+team,im,(8,8));add('badge.'+team,im.resize((16,8),Image.Resampling.NEAREST),(8,4))
for f in range(4):
 im=canvas(8,8);d=ImageDraw.Draw(im);d.ellipse((0,0,7,7),fill='#152c3c');d.ellipse((1,1,6,6),fill='#b9dcdf');d.ellipse((2,1,5,4),fill='#fff8d8');d.point((2+f%3,2),fill='white');add('orb.'+str(f),im,(4,4))
im=canvas(14,5);ImageDraw.Draw(im).ellipse((0,0,13,4),fill=(8,21,31,100));add('shadow',im,(7,2))
im=canvas(22,12);d=ImageDraw.Draw(im)
for a in range(0,360,60):d.arc((0,0,21,11),a,a+40,fill='#fff5ce',width=1)
add('ring',im,(11,6))
im=canvas(7,5);ImageDraw.Draw(im).polygon([(0,0),(6,0),(3,4)],fill='#fff4d2');add('arrow',im,(3,5))
im=canvas(384,30);d=ImageDraw.Draw(im);d.rectangle((0,0,511,25),fill='#142736',outline='#60727a');d.line((1,24,510,24),fill='#bdac83');d.polygon([(210,0),(302,0),(294,25),(218,25)],fill='#263f4e',outline='#9e9c85');add('hud',im,(0,0))
# Original bitmap lettering uses Pillow's bundled font; no vendor font redistributed.
im=canvas(220,64);d=ImageDraw.Draw(im);font=ImageFont.load_default(size=30);d.text((11,10),'CRYPTBALL',font=font,fill='#172735',stroke_width=2,stroke_fill='#172735');d.text((10,7),'CRYPTBALL',font=font,fill='#ecd6a4',stroke_width=1,stroke_fill='#8e7059');d.text((51,47),'IVORY  /  EMBER',font=ImageFont.load_default(size=10),fill='#a4c4c5');add('logo',im,(110,32))
# Authored animated fixtures, crowd and sporting effects.
for variant in range(4):
 ids=[]
 for f in range(6):
  im=canvas(24,16);d=ImageDraw.Draw(im)
  for j in range(4):
   x=3+j*6;y=6-((f+j+variant)%3==0)
   d.rectangle((x-1,y-4,x+1,y-1),fill=['#8b8170','#73817d','#887568','#6b7c87'][(j+variant)%4]);d.rectangle((x-2,y,x+2,y+5),fill=['#354e5a','#53484a','#444e5f'][(j+variant)%3])
   if f>1:d.line((x-3,y+1,x-4,y-3),fill='#b7aaa0');d.line((x+3,y+1,x+4,y-3),fill='#b7aaa0')
  fid=f'crowd.{variant}.{f}';add(fid,im,(12,14));ids.append(fid)
 clips[f'crowd.{variant}']=ids
ids=[]
for f in range(8):
 im=canvas(16,28);d=ImageDraw.Draw(im);d.polygon([(4,14),(12,14),(11,19),(9,20),(10,27),(6,27),(7,20),(5,19)],fill='#8c8d79',outline='#3a4d54');d.polygon([(4,14),(3,10),(6,5+f%3),(8,0+f%4),(10,7),(13,9),(12,14)],fill='#c77848');d.polygon([(6,13),(6,9),(8,5+f%3),(10,11),(9,14)],fill='#dfbb72');fid=f'brazier.{f}';add(fid,im,(8,27));ids.append(fid)
clips['brazier']=ids
for team,color in [('ivory','#8de3de'),('ember','#ed9e74')]:
 for effect,count in [('swoosh',8),('impact',5),('pass',6),('dust',4),('goal',10),('stars',6),('whiff',3)]:
  ids=[]
  for f in range(count):
   im=canvas(40,32);d=ImageDraw.Draw(im);cx=20;cy=16
   if effect in ['swoosh','whiff']:d.arc((3+f,6,36,30),275-f*12,350+f*12,fill=color,width=max(1,3-f//3))
   elif effect=='pass':
    r=3+f*2;d.ellipse((cx-r,cy-r//2,cx+r,cy+r//2),outline=color,width=1)
   elif effect=='dust':
    for j in range(4):
     x=cx+(j-2)*(f+2);y=cy-j%2*2-f;d.ellipse((x-2,y-1,x+2,y+1),fill='#aeb4a0')
   elif effect in ['impact','goal']:
    for j in range(8):
     a=j*math.pi/4;r=3+f*1.4;x=round(cx+math.cos(a)*r);y=round(cy+math.sin(a)*r);d.line((x,y,x+round(math.cos(a)*3),y+round(math.sin(a)*3)),fill='#f5dfab' if j%2 else color,width=1)
   else:
    for j in range(3):
     a=j*math.pi*2/3+f*.4;x=round(cx+math.cos(a)*10);y=round(cy+math.sin(a)*5);d.line((x-2,y,x+2,y),fill='#f4d98a');d.line((x,y-2,x,y+2),fill='#f4d98a')
   fid=f'fx.{team}.{effect}.{f}';add(fid,im,(20,16));ids.append(fid)
  clips[f'fx.{team}.{effect}']=ids
for team,color in [('ivory','#87d9dc'),('ember','#dc8b6b')]:
 ids=[]
 for f in range(4):
  im=canvas(24,38);d=ImageDraw.Draw(im);d.line((0,1,23,1),fill='#dfc89b',width=2);d.polygon([(2,3),(21,3),(20-f%2,29),(12,36),(3+f%2,29)],fill=color,outline='#dbc697');d.line((12,7,12,30),fill='#eee1bb',width=2);fid=f'banner.{team}.{f}';add(fid,im,(12,0));ids.append(fid)
 clips[f'banner.{team}']=ids
for label in ['W','A','S','D','J','K','L','Q','SPACE','MOUSE']:
 for pressed in [0,1]:
  w=max(14,len(label)*6+6);im=canvas(w,16);d=ImageDraw.Draw(im);d.rounded_rectangle((0,0,w-1,15),radius=2,fill='#a6b8b4' if pressed else '#294451',outline='#a6b8b4');d.text((3,2+pressed),label,font=ImageFont.load_default(size=10),fill='#142936' if pressed else '#ecdfb7');add(f'key.{label.lower()}.{pressed}',im,(w/2,8))

# Export original authored layers; exact source selection and algorithm form source art.
for name,im,pivot,duration in assets:
 if not name.startswith(('ivory.','ember.')):im.save(ART/'export'/f'{name}.png')
scene=canvas(512,320)
for name,im,pivot,duration in assets:
 if name in ['stadium','court','goal.left.back','goal.right.back']:scene.alpha_composite(im)
for team,u,v,heading in [('ivory',-45,-20,0),('ivory',-85,45,1),('ivory',-145,0,0),('ember',55,18,4),('ember',90,-40,5),('ember',145,0,4)]:
 pose=athletes.athlete(team,False,'sprint',heading,2,8);x,y=project(u,v);scene.alpha_composite(pose,(x-32,y-52))
sd=ImageDraw.Draw(scene)
for x,y in [(65,150),(450,210),(135,90),(380,285)]:
 sd.polygon([(x-4,y),(x+4,y),(x+3,y+5),(x+1,y+6),(x+1,y+14),(x-1,y+14),(x-1,y+6),(x-3,y+5)],fill='#879b9c',outline='#253d4d')
 sd.polygon([(x-4,y),(x-5,y-5),(x-2,y-10),(x,y-17),(x+2,y-7),(x+5,y-4),(x+4,y)],fill='#c77848')
 sd.polygon([(x-2,y-1),(x-2,y-5),(x,y-10),(x+2,y-3),(x+1,y)],fill='#ffe0a2')
x,y=project(8,2);sd.ellipse((x-3,y-3,x+3,y+3),fill='#fff0cf',outline='#172735')
scene.save(ART/'court-sample-1x.png');scene.resize((1536,960),Image.Resampling.NEAREST).save(ART/'court-sample-3x.png')
# Trim/pack all assets with stable source-space pivots.
frames={};pages={};page=canvas(1024,1024);x=y=1;row=0;pageid=0
def savepage():
 page.save(OUT/f'page-{pageid}.png');pages[str(pageid)]=f'page-{pageid}.png'
for name,im,pivot,duration in assets:
 box=im.getbbox();assert box,name
 crop=im.crop(box);w,h=crop.size
 if x+w+1>1024:x=1;y+=row+2;row=0
 if y+h+1>1024:savepage();pageid+=1;page=canvas(1024,1024);x=y=1;row=0
 page.alpha_composite(crop,(x,y));frames[name]={'pageId':str(pageid),'x':x,'y':y,'width':w,'height':h,'originalSize':{'width':im.width,'height':im.height},'trim':{'x':box[0],'y':box[1]},'pivot':{'x':pivot[0],'y':pivot[1]},'duration':duration,'mirrorable':False};x+=w+2;row=max(row,h)
savepage()
for stale in OUT.glob('page-*.png'):
 if stale.name not in pages.values():stale.unlink()
manifest={'version':2,'recipeId':'cryptball-original-sample-2026-11-04','sampling':'nearest','pages':pages,'frames':frames,'clips':clips,'provenance':{'source':'Original code-authored sports-pose sample and original procedural court','tools':['Python','Pillow'],'seed':None,'reviewStatus':'chunky armored fantasy direction approved; actual code-authored sample awaits visual review; prototype action coverage','headings':'8 authored; nearest-of-8 aliases for 16 runtime headings','edits':'Anatomical limb chains, armored palette swaps, keeper gloves/helmet; crypt arch voussoirs, layered stone boards, warm pixel torch clusters and recessed woven nets; no vendor pixels'}}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
(ROOT/'scripts/game-assets/cryptball-source-selection.json').write_text(json.dumps(manifest['provenance'],indent=2)+'\n')
(OUT/'LICENSES.txt').write_text('CRYPTBALL ORIGINAL PROTOTYPE ART\nAthletes, court, stadium, interface and effects are original code-authored drawings from scripts/game-assets/import-cryptball.py and cryptball-athlete.py. No purchased athlete pixels are used. Sample awaits human review before bulk production. Raster lettering uses Pillow bundled default font; no font file is distributed.\n')
(ART/'README.md').write_text('# Cryptball original art sample\n\nOriginal deterministic Pillow code: `scripts/game-assets/cryptball-athlete.py` (sports poses), `import-cryptball.py` (court/atlas). No external generation service or purchased source is required. Eight authored screen headings are mapped to sixteen runtime headings. Uniform variants are palette swaps; keeper adds gloves and helmet. These are coherent prototype clips, not a human-approved bulk art pass. Review `athlete-sample-1x.png`, `athlete-sample-3x.png`, `court-sample-1x.png` and `court-sample-3x.png` before production expansion.\n\nPixelLab / Retro Diffusion connectors were unavailable; Aseprite CLI was absent. No paid calls or installs were made. Provenance is embedded in the manifest.\n')
print(f'{len(frames)} frames, {len(clips)} clips, {len(pages)} pages')
