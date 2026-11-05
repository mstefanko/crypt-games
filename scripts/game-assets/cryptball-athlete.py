"""Original fantasy sports-pose prototype, awaiting human sample review.
Eight screen headings; fixed (32,52) ground anchor; code-authored pixels only.
"""
import math
from PIL import Image, ImageDraw
PALETTE=['#14232e','#293e4a','#526a77','#899da2','#ccd5c8','#fff0cf','#654638','#ab7856','#e8b984','#f6d7a0','#173f4b','#287c8b','#65c9ce','#b7eeea','#642e35','#a65045','#e9916c','#ffce9b','#4a342c','#866043','#c69d65','#e4c58e']
def screen_heading_vector(heading):
 # Heading labels are already screen facing after world projection. Do not project twice.
 angle=heading*math.pi/4
 return math.cos(angle),-math.sin(angle)
def athlete(team,keeper,action,heading,frame,count):
 im=Image.new('RGBA',(72,72));d=ImageDraw.Draw(im)
 ink,steel0,steel1,steel2,steel3,white=PALETTE[:6]
 skin0,skin1,skin2=PALETTE[6:9]
 dark,cloth,hi=PALETTE[10:13] if team=='ivory' else PALETTE[14:17]
 gold0,gold1,gold2,gold3=PALETTE[18:22]
 a=heading*math.pi/4;fx,fy=screen_heading_vector(heading);sx,sy=-fy,fx
 phase=frame/max(1,count-1); cycle=frame/max(1,count)*math.pi*2
 slide=action in ['slide','slide-launch'];dive=action=='keeper-dive';low=slide or dive
 recover=action=='slide-recover';run=action in ['run','sprint','keeper-shuffle'];strike=action in ['strike','pass','power']
 swing=math.sin(cycle) if run else 0
 # Collider reach in screen pixels depends on the projected world direction.
 projection_scale=1/math.sqrt(fx*fx+(fy/.55)**2)
 front=(17 if dive else 13)*projection_scale
 rear=(17 if dive else 11)*projection_scale
 def pt(f,s,z,margin=0):
  x=fx*f+sx*s;y=fy*f+sy*s*.55
  if low:
   along=x*fx+y*fy
   limit=max(-rear+margin,min(front-margin,along))
   x+=fx*(limit-along);y+=fy*(limit-along)
  return (round(32+x),round(52+y-z))
 def stroke(points,color,width,shine=None):
  d.line(points,fill=ink,width=width+2)
  d.line(points,fill=color,width=width)
  if shine:d.line([(x-1,y-1) for x,y in points],fill=shine,width=1)
 def limb(points,color,width,shine=None):stroke([pt(*p) for p in points],color,width,shine)
 # Grounded bent legs; slide leads with a long extended boot, dive trails legs.
 hipf=-4 if slide else -3 if dive else 0
 hipz=6 if low else 13 if recover or action=='slide-launch' else 17+(round(abs(swing)) if run else 0)
 for side in [-1,1]:
  f=(-16 if dive else 20 if slide and side==1 else 5 if slide else side*swing*7)
  foot=pt(f,side*4,1,6);knee=pt((hipf+f)*.5-2,side*4,hipz*.48+2)
  stroke([pt(hipf,side*4,hipz),knee,foot],steel1,5,steel2)
  limb([(hipf,side*4,hipz),(hipf+side,side*4,hipz-5)],dark,6,cloth)
  x,y=foot;d.rounded_rectangle((x-4,y-4,x+4,y+1),radius=1,fill=ink)
  d.rectangle((x-3,y-3,x+3,y-1),fill=gold0);d.line((x-2,y-3,x+3,y-3),fill=gold2)
 # Torso retains physical thickness in side views rather than collapsing to a line.
 cf=10 if dive else -9 if slide else 2 if run else 0
 cx,cy=pt(cf,0,hipz+6)
 shoulder=5 if low else 8
 d.polygon([(cx-6,cy+6),(cx+6,cy+6),(cx+shoulder,cy-7),(cx-shoulder,cy-7)],fill=ink)
 d.polygon([(cx-5,cy+4),(cx+4,cy+4),(cx+6,cy-6),(cx-6,cy-6)],fill=cloth)
 d.polygon([(cx-5,cy+3),(cx-1,cy+3),(cx-1,cy-5),(cx-5,cy-5)],fill=dark)
 d.line((cx-4,cy-5,cx+4,cy-5),fill=hi,width=2)
 d.rectangle((cx-5,cy+4,cx+5,cy+6),fill=gold0);d.line((cx-4,cy+4,cx+4,cy+4),fill=gold2)
 d.rectangle((cx-1,cy+4,cx+1,cy+6),fill=gold3)
 # Far arm, shoulder guards, near arm: bent elbows, padded gauntlets.
 for side in [-1,1]:
  reach=22 if dive else (5+12*math.sin(phase*math.pi)) if strike and side==1 else -5 if slide else -side*swing*5
  sh=(cx+side*7,cy-5)
  elbow=(round(sh[0]+fx*reach*.45+side*2),round(sh[1]+fy*reach*.5+5))
  hand=(round(sh[0]+fx*reach),round(sh[1]+fy*reach+(2 if dive else 9)))
  if low:
   hand=pt(front-5 if dive else -2,side*4,hipz+5,5)
   elbow=(round((sh[0]+hand[0])/2),round((sh[1]+hand[1])/2+2))
  stroke([sh,elbow,hand],skin1,4,skin2)
  x,y=sh;d.polygon([(x-4,y-3),(x+3,y-4),(x+5,y),(x+3,y+3),(x-4,y+2)],fill=steel1,outline=ink)
  d.line((x-2,y-2,x+2,y-2),fill=steel3,width=1)
  x,y=hand;d.rectangle((x-3,y-3,x+3,y+2),fill=ink);d.rectangle((x-2,y-2,x+2,y+1),fill=white if keeper else gold1)
  d.line((x-2,y-2,x+2,y-2),fill=steel3 if keeper else gold3)
  # Crypt sports striking club: compact haft, broad rounded padded striking face.
  if not keeper and side==1 and (strike or action in ['idle','run','sprint']):
   angle=a+(-1+phase*2.2 if strike else -.8)
   tx=round(x+math.cos(angle)*16);ty=round(y-math.sin(angle)*16-5)
   stroke([(x,y),(tx,ty)],gold1,3,gold3)
   vx,vy=round(math.cos(angle)*4),round(-math.sin(angle)*4)
   stroke([(tx-vx,ty-vy),(tx+vx,ty+vy)],steel1,6,steel3)
 # Helmet: broad brow, recessed face slit, crown highlight and team crest.
 hx,hy=pt(cf+(3 if dive else -2 if slide else 1),0,hipz+19)
 d.rounded_rectangle((hx-6,hy-7,hx+6,hy+5),radius=3,fill=ink)
 d.polygon([(hx-5,hy-4),(hx-3,hy-7),(hx+3,hy-7),(hx+5,hy-4),(hx+5,hy+3),(hx-5,hy+3)],fill=steel1)
 d.polygon([(hx-4,hy-5),(hx-2,hy-6),(hx+1,hy-6),(hx+1,hy-1),(hx-4,hy-1)],fill=steel2)
 d.line((hx-3,hy-6,hx+2,hy-6),fill=steel3)
 # Face is shown for front/side directions, back helmet has team stripe.
 if fy<.7:
  offset=round(fx*2);d.rectangle((hx-3+offset,hy-1,hx+3+offset,hy+2),fill=ink)
  d.line((hx-2+offset,hy,hx+2+offset,hy),fill=skin2)
 else:d.rectangle((hx-1,hy-5,hx+1,hy+2),fill=hi)
 d.rectangle((hx-1,hy-9,hx+1,hy-6),fill=hi)
 if keeper:
  d.line((hx-4,hy+2,hx+4,hy+2),fill=steel3);d.line((hx,hy-1,hx,hy+3),fill=steel3)
 return im
