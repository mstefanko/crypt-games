"""Import preserved ImageGen hockey key poses; never redraw or crop away sticks.

Run from any directory with the repository's .venv-assets Python. Athlete anchors
are authored independently from total silhouette bounds (raised sticks are not
body height). Fading effect alpha is preserved instead of athlete thresholding.
"""
from pathlib import Path
import hashlib, importlib.util, json
from PIL import Image, ImageDraw

def module(name, filename):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(filename))
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result

sprites=module('sprite_tools','cryptball-sprite-tools.py')
materials=module('team_palettes','cryptball-team-palettes.py')
ROOT=Path(__file__).resolve().parents[2]
SRC=ROOT/'apps/cryptball/art-src/hockey-v1'
OUT=ROOT/'apps/cryptball/public/assets/cryptball-hockey'
OUT.mkdir(parents=True,exist_ok=True)
DIRECTIONS=['E','SE','S','SW','W','NW','N','NE']
POSES=['ready','glide','push-left','push-right','wrist-windup','wrist-contact','wrist-follow','receive','slap-windup','slap-downswing','slap-contact','slap-follow','poke-check','shoulder-check','stop','recover']
ACTIONS={'idle':[0],'glide':[1],'skate':[2,1,3,1],'burst':[2,3],'stickhandle':[0,7,0],
         'wrist':[4,5,6],'pass':[4,5,6],'slap':[8,9,10,11],'slap-hold':[8],
         'poke':[0,12,15],'shoulder':[13,15],'stop':[14,1],'recover':[15,0],
         'receive':[7,0],'recoil':[15],'celebrate':[15,0]}
FRAME_SIZE=(112,80);PIVOT=(56,70)
# Fraction of the extracted pose's bounds. Each row is deliberately explicit:
# these anchor skates, not the center of a silhouette that includes a long stick.
FOOT_X={
'E':[.31,.33,.34,.37,.45,.32,.34,.36,.52,.37,.36,.43,.31,.38,.41,.38],
'SE':[.32,.35,.35,.37,.5,.34,.35,.4,.51,.38,.36,.42,.32,.37,.41,.41],
'S':[.44,.42,.43,.43,.54,.48,.44,.43,.52,.4,.47,.39,.4,.42,.44,.42],
'SW':[.63,.63,.65,.65,.64,.59,.6,.62,.51,.63,.64,.63,.55,.6,.59,.6],
'W':[.67,.68,.67,.67,.59,.62,.62,.64,.49,.63,.62,.59,.66,.62,.62,.62],
'NW':[.62,.62,.61,.61,.64,.57,.6,.61,.47,.62,.62,.63,.61,.62,.6,.59],
'N':[.41,.4,.4,.4,.42,.41,.4,.42,.5,.42,.43,.44,.4,.41,.44,.43],
'NE':[.32,.33,.34,.36,.45,.31,.35,.36,.53,.35,.35,.42,.33,.37,.4,.38]}
# Visible blade centers for the ground-contact key poses (relative to crop).
# The corrected north sheet keeps low blades beside the skate footprint.
# These are renderer anchors only and never change authoritative stick geometry.
BLADE={
'E':(.94,.94),'SE':(.94,.92),'S':(.57,.95),'SW':(.06,.94),
'W':(.06,.94),'NW':(.06,.88),'N':(.94,.92),'NE':(.94,.89)}
assets=[];clips={};extraction=[];sources=[];normalized={}
def source(name):
    path=SRC/name;sources.append({'file':name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    return Image.open(path).convert('RGBA')
def add(name,im,pivot=PIVOT):
    assert im.getbbox(),name;assets.append((name,im,pivot,1/12))
def helmet_top(im):
    points=[y for y in range(im.height) for x in range(im.width) if materials.material_pixel(*im.getpixel((x,y)))]
    assert points;return min(points)
for direction in DIRECTIONS:
    filename='action-N-grounded.png' if direction=='N' else f'action-{direction}.png'
    cells=sprites.extract_grid(sprites.clean_alpha(source(filename)),4,4)
    reference=cells[0][0]
    # Standing helmet-to-skate height; includes no extended or raised stick.
    scale=44/(reference.height-helmet_top(reference))
    for index,(cell,_,rect) in enumerate(cells):
        foot=(round(cell.width*FOOT_X[direction][index],2),cell.height)
        size=(max(1,round(cell.width*scale)),max(1,round(cell.height*scale)))
        x=round(PIVOT[0]-foot[0]*scale);y=round(PIVOT[1]-foot[1]*scale)
        assert x>=1 and y>=1 and x+size[0]<FRAME_SIZE[0] and y+size[1]<FRAME_SIZE[1],(direction,POSES[index],size,(x,y))
        frame=Image.new('RGBA',FRAME_SIZE);frame.alpha_composite(cell.resize(size,Image.Resampling.NEAREST),(x,y))
        normalized[direction,index]=frame
        bx,by=BLADE[direction]
        # Windups and follow-through explicitly have no ground-contact anchor.
        blade=(round(x+size[0]*bx,2),round(y+size[1]*by,2)) if index in [0,1,2,3,5,7,10,12,14,15] else None
        extraction.append({'source':filename,'direction':direction,'pose':POSES[index],
          'sourceRect':rect,'sourceFootAnchor':[round(rect[0]+foot[0],2),rect[1]+foot[1]],
          'sourceBladeAnchor':None if blade is None else [round(rect[0]+cell.width*bx,2),round(rect[1]+cell.height*by,2)],
          'bladeAnchor':blade,'bladeVisibleAtGround':blade is not None,'scale':scale,'normalizedRect':[x,y,*size],'pivot':PIVOT})
# Targeted diagonal contact correction. The other 116 poses still consume
# their preserved directional source sheets. Larger vertical frame bounds keep
# a genuinely low blade in front of the skates without changing the foot pivot.
OVERRIDE_DIRECTIONS=['SE','SW','NW','NE']
OVERRIDE_POSES=[5,10,12]
override_sheet=source('diagonal-contact-grounded.png')
override_cells=sprites.extract_grid(sprites.clean_alpha(override_sheet),4,3)
cell_w=override_sheet.width/4;cell_h=override_sheet.height/3
for row,index in enumerate(OVERRIDE_POSES):
    for col,direction in enumerate(OVERRIDE_DIRECTIONS):
        cell,_,rect=override_cells[row*4+col]
        scale_x=112/cell_w;scale_y=96/cell_h
        fractions={'SE':[(.44,.695),(.435,.676),(.445,.711)],'SW':[(.555,.695),(.539,.679),(.552,.696)],'NW':[(.566,.707),(.537,.676),(.552,.699)],'NE':[(.460,.704),(.427,.694),(.430,.702)]}
        fx,fy=fractions[direction][row]
        source_foot=(cell_w*(col+fx),cell_h*(row+fy))
        foot=(source_foot[0]-rect[0],source_foot[1]-rect[1])
        size=(round(cell.width*scale_x),round(cell.height*scale_y))
        x=round(PIVOT[0]-foot[0]*scale_x);y=round(PIVOT[1]-foot[1]*scale_y)
        assert x>=1 and y>=1 and x+size[0]<112 and y+size[1]<96,(direction,POSES[index],size,(x,y))
        frame=Image.new('RGBA',(112,96));frame.alpha_composite(cell.resize(size,Image.Resampling.NEAREST),(x,y))
        normalized[direction,index]=frame
        dx=-17 if direction in ['SW','NW'] else 17
        dy=11 if direction in ['SE','SW'] else -11
        blade=(PIVOT[0]+dx,PIVOT[1]+dy)
        extraction[DIRECTIONS.index(direction)*16+index]={'source':'diagonal-contact-grounded.png','direction':direction,'pose':POSES[index],
          'override':True,'sourceCell':[col,row],'sourceRect':rect,'sourceFootAnchor':source_foot,
          'sourceBladeAnchor':[source_foot[0]+dx/scale_x,source_foot[1]+dy/scale_y],
          'bladeAnchor':blade,'bladeVisibleAtGround':True,'scale':[scale_x,scale_y],'normalizedRect':[x,y,*size],
          'frameSize':[112,96],'pivot':PIVOT,'anchorMethod':'Authored edit target relative to preserved per-cell foot registration'}
# The two front diagonals received a further targeted three-pose correction;
# grouped back-diagonal contact poses retain their natural body occlusion.
for direction,feet in [('SE',[(.44,.695),(.435,.676),(.445,.711)]),('SW',[(.555,.695),(.539,.679),(.552,.696)])]:
    filename=f'contact-{direction}-grounded.png'
    sheet=source(filename);cells=sprites.extract_grid(sprites.clean_alpha(sheet),3,1)
    cw=sheet.width/3;ch=sheet.height
    for col,index in enumerate(OVERRIDE_POSES):
        cell,_,rect=cells[col];sx=112/cw;sy=96/ch
        fx,fy=feet[col];source_foot=(cw*(col+fx),ch*fy)
        foot=(source_foot[0]-rect[0],source_foot[1]-rect[1])
        size=(round(cell.width*sx),round(cell.height*sy))
        x=round(PIVOT[0]-foot[0]*sx);y=round(PIVOT[1]-foot[1]*sy)
        assert x>=1 and y>=1 and x+size[0]<112 and y+size[1]<96,(direction,POSES[index],size,(x,y))
        frame=Image.new('RGBA',(112,96));frame.alpha_composite(cell.resize(size,Image.Resampling.NEAREST),(x,y))
        normalized[direction,index]=frame
        dx=14 if direction=='SE' else -14;blade=(PIVOT[0]+dx,PIVOT[1]+9)
        extraction[DIRECTIONS.index(direction)*16+index]={'source':filename,'direction':direction,'pose':POSES[index],
          'override':True,'sourceCell':[col,0],'sourceRect':rect,'sourceFootAnchor':source_foot,
          'sourceBladeAnchor':[source_foot[0]+dx/sx,source_foot[1]+9/sy],
          'bladeAnchor':blade,'bladeVisibleAtGround':True,'scale':[sx,sy],'normalizedRect':[x,y,*size],
          'frameSize':[112,96],'pivot':PIVOT,'anchorMethod':'Authored skate midpoint and contact target from per-direction guided correction'}
# Reuse material conversion, preserving skin, cream, steel, shaft and tape.
# One uniform palette across all facings prevents frame-to-frame color flicker.
palette_source=Image.new('RGB',(8*112,16*80))
for col,direction in enumerate(DIRECTIONS):
    for row in range(16):palette_source.paste(normalized[direction,row].convert('RGB'),(col*112,row*80))
palette=palette_source.quantize(colors=64,method=Image.Quantize.MEDIANCUT)
for key,im in normalized.items():
    alpha=im.getchannel('A');im=im.convert('RGB').quantize(palette=palette,dither=Image.Dither.NONE).convert('RGBA');im.putalpha(alpha);normalized[key]=im
for team in materials.PALETTES:
    for direction in DIRECTIONS:
        for index,pose in enumerate(POSES):add(f'hockey.{team}.{pose}.{direction}',materials.team_variant(normalized[direction,index],team))
        for action,indices in ACTIONS.items():clips[f'hockey.{team}.{action}.{direction}']=[f'hockey.{team}.{POSES[i]}.{direction}' for i in indices]
arena=source('arena-ice.png').resize((640,400),Image.Resampling.NEAREST)
mask=Image.new('L',(640,400));ImageDraw.Draw(mask).polygon([(122,132),(518,132),(596,305),(45,305)],fill=255)
arena.putalpha(mask);add('hockey.floor',arena,(0,0))
effects=source('puck-effects.png')
for row,kind in enumerate(['puck','spray','contact']):
    for col in range(4):
        rect=(col*effects.width//4,row*effects.height//3,(col+1)*effects.width//4,(row+1)*effects.height//3)
        cell=effects.crop(rect);box=cell.getbbox();assert box
        cell=cell.crop(box)
        # A rigid 12x8 disk, or a bounded 36px spray / 18px contact cue.
        if kind=='puck':size=(12,8);pivot=(6,5)
        else:
            width=36 if kind=='spray' else 18
            size=(width,max(1,round(cell.height*width/cell.width)));pivot=(size[0]/2,size[1]-1)
        cell=cell.resize(size,Image.Resampling.NEAREST)
        add(f'hockey.{kind}.{col}',cell,pivot)
        extraction.append({'source':'puck-effects.png','pose':f'{kind}-{col}','sourceRect':rect,'opaqueRect':box,'runtimeSize':size,'pivot':pivot,'alpha':'preserved'})
    clips[f'hockey.fx.{kind}']=[f'hockey.{kind}.{i}' for i in range(4)]
frames,pages=sprites.pack_atlas(assets,OUT)
for entry in extraction[:128]:
    if entry['bladeAnchor'] is None:continue
    for team in materials.PALETTES:
        name=f"hockey.{team}.{entry['pose']}.{entry['direction']}"
        frames[name]['anchors']={'weaponTip':{'x':entry['bladeAnchor'][0],'y':entry['bladeAnchor'][1]}}
for name,ids in clips.items():assert all(fid in frames for fid in ids),name
provenance={'source':'OpenAI ImageGen hockey-v1; preserved source files and prompts','sources':sources,'teamPalettes':list(materials.PALETTES),'authoredFacings':8,'authoredPosesPerFacing':16,'aliases':ACTIONS,
 'method':'Shared connected-component extractor, alpha210 athlete threshold, body-to-skate scale, explicit foot and blade anchors, shared64 palette, nearest sampling; VFX alpha preserved',
 'limitations':'Generated key poses, no full inbetweens. North low blades and 12 diagonal contact poses use targeted ImageGen corrections; original sources are preserved. Foot/blade anchors are authored cosmetic guides and never move the authoritative puck.'}
provenance['poseOverrides']=[{key:entry[key] for key in ['direction','pose','source','sourceCell','sourceRect','sourceFootAnchor','sourceBladeAnchor','frameSize','pivot']} for entry in extraction[:128] if entry.get('override')]
(OUT/'manifest.json').write_text(json.dumps({'version':2,'recipeId':'cryptcheck-hockey-v1-2026-11-04','sampling':'nearest','pages':pages,'frames':frames,'clips':clips,'provenance':provenance},indent=2)+'\n')
(OUT/'LICENSES.txt').write_text('Original generated hockey athlete sheets, ice floor edit and puck/effects: OpenAI ImageGen. Source, prompts, hashes and extraction: apps/cryptball/art-src/hockey-v1. No third-party sprite assets.\n')
(SRC/'runtime-extraction.json').write_text(json.dumps({'frames':extraction,'provenance':provenance},indent=2)+'\n')
proof=Image.new('RGBA',(8*112,16*102),(40,32,53,255));draw=ImageDraw.Draw(proof)
for col,direction in enumerate(DIRECTIONS):
    for row,pose in enumerate(POSES):
        proof.alpha_composite(normalized[direction,row],(col*112,row*102+6));draw.text((col*112+2,row*102),direction+' '+pose,fill='#edd7b9')
proof.save(SRC/'runtime-contact-sheet-1x.png');proof.resize((proof.width*3,proof.height*3),Image.Resampling.NEAREST).save(SRC/'runtime-contact-sheet-3x.png')
teamproof=Image.new('RGBA',(8*112,6*106),(40,32,53,255));draw=ImageDraw.Draw(teamproof)
for row,team in enumerate(materials.PALETTES):
    for col,direction in enumerate(DIRECTIONS):
        teamproof.alpha_composite(materials.team_variant(normalized[direction,5],team),(col*112,row*106+10));draw.text((col*112+2,row*106),team+' '+direction,fill='#edd7b9')
teamproof.save(SRC/'runtime-team-comparison.png')
animated=[]
for index in [0,2,1,3,1,4,5,6,0,8,9,10,11,12,13,14,15]:
    image=Image.new('RGB',(8*112,6*96),(40,32,53))
    for row,team in enumerate(materials.PALETTES):
        for col,direction in enumerate(DIRECTIONS):
            im=materials.team_variant(normalized[direction,index],team);image.paste(im,(col*112,row*96),im)
    animated.append(image)
animated[0].save(SRC/'runtime-animation-proof.gif',save_all=True,append_images=animated[1:],duration=140,loop=0)
qa={'status':'structural gates passed; targeted north and diagonal blade corrections','athletePoseCount':128,'facings':DIRECTIONS,'palettes':list(materials.PALETTES),'frameSize':FRAME_SIZE,'contactOverrideFrameSize':[112,96],'contactOverridePoses':12,'pivot':PIVOT,'referenceBodyHeightPx':44,
 'binaryAthleteAlpha':all(set(im.getchannel('A').get_flattened_data()).issubset({0,255}) for im in normalized.values()),'noClippedFigures':True,'atlasFrames':len(frames),'atlasPages':len(pages),'runtimeBytes':sum(p.stat().st_size for p in OUT.glob('*')),'atlasRgbaBytes':len(pages)*1024*1024*4,'sources':sources}
(SRC/'runtime-qa.json').write_text(json.dumps(qa,indent=2)+'\n')
print(f'{len(frames)} frames, {len(clips)} clips, {len(pages)} pages, {qa["runtimeBytes"]:,} runtime bytes')
