"""Extract generated weapon-free athlete art; never synthesize or erase anatomy.
Independent atlas keeps Cryptball's source and packed bytes unchanged.
"""
from pathlib import Path
import colorsys, hashlib, json
from PIL import Image, ImageDraw
import importlib.util
_palette_spec=importlib.util.spec_from_file_location("team_palettes",Path(__file__).with_name("cryptball-team-palettes.py"))
_palette_module=importlib.util.module_from_spec(_palette_spec);_palette_spec.loader.exec_module(_palette_module)
PALETTES=_palette_module.PALETTES
team_variant=_palette_module.team_variant
ROOT=Path(__file__).resolve().parents[2]
SRC=ROOT/'apps/cryptball/art-src/sports-v1'
OUT=ROOT/'apps/cryptball/public/assets/cryptball-sports'
OUT.mkdir(parents=True,exist_ok=True)
DIRECTIONS=['E','SE','S','SW','W','NW','N','NE']
POSES=['idle','run-a','run-b','run-c','run-d','slide','recovery-low','recovery-up','kick-windup','kick-contact','kick-follow','receive','set','jump','spike','land']
ACTIONS={'idle':[0],'run':[1,2,3,4],'sprint':[1,2,3,4],'slide-launch':[6,5],'slide':[5],'slide-recover':[6,7],'recoil':[6,7],'celebrate':[12,0],'trap':[9,0],'pass':[8,9,10],'kick':[8,9,10],'receive':[11,0],'set':[11,12,12,0],'spike':[13,14,15],'jump':[13],'land':[15,7],'dig':[6,5,6,7]}
FRAME_SIZE=(112,80);PIVOT=(56,70)
assets=[];clips={};sources=[];extraction=[]
def add(name,im,pivot=PIVOT):
    assert im.getbbox(),name
    assets.append((name,im,pivot,1/12))
def source(name):
    path=SRC/name
    sources.append({'file':name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    return Image.open(path).convert('RGBA')
_sprite_spec=importlib.util.spec_from_file_location("sprite_tools",Path(__file__).with_name("cryptball-sprite-tools.py"))
_sprite_module=importlib.util.module_from_spec(_sprite_spec);_sprite_spec.loader.exec_module(_sprite_module)
clean_alpha=_sprite_module.clean_alpha
extract_grid=_sprite_module.extract_grid
foot_anchor=_sprite_module.foot_anchor

def ember_variant(im):
    out=im.copy();p=out.load()
    for y in range(out.height):
        for x in range(out.width):
            r,g,b,a=p[x,y]
            if not a:continue
            h,s,v=colorsys.rgb_to_hsv(r/255,g/255,b/255)
            # Uniform teal only; leather/skin/gold/neutral metal remain shared.
            if .43 <= h <= .61 and s >= .22 and g>r*1.08 and v>=.26:
                rr,gg,bb=colorsys.hsv_to_rgb(.06,min(.90,max(.78,s*1.25)),min(.98,.18+v*1.15))
                p[x,y]=(round(rr*255),round(gg*255),round(bb*255),a)
    return out


normalized={}
for direction in DIRECTIONS:
    cells=extract_grid(clean_alpha(source(f'action-{direction}.png')),4,4)
    scale=44/cells[0][0].height
    for index,(cell,bbox,rect) in enumerate(cells):
        anchor=foot_anchor(cell)
        size=(max(1,round(cell.width*scale)),max(1,round(cell.height*scale)))
        assert size[0]<=100 and size[1]<=68,(direction,POSES[index],size)
        crop=cell.resize(size,Image.Resampling.NEAREST)
        frame=Image.new('RGBA',FRAME_SIZE)
        x=round(PIVOT[0]-anchor[0]*scale);y=PIVOT[1]-size[1]
        assert x>=0 and x+size[0]<=FRAME_SIZE[0]
        frame.alpha_composite(crop,(x,y));normalized[direction,index]=frame
        extraction.append({'source':f'action-{direction}.png','pose':POSES[index],'sourceRect':rect,'sourceFootAnchor':anchor,'scale':scale,'normalizedRect':[x,y,*size],'pivot':PIVOT})
# Generated hands-first dives are independently authored; never mirror seated slides.
DIVE_POSES=['dive-launch','dive-flight','dive-contact','dive-pushup']
for filename,directions in [('dive-front.png',DIRECTIONS[:4]),('dive-back.png',DIRECTIONS[4:])]:
    path=ROOT/'apps/cryptball/art-src/dives-v1'/filename
    sources.append({'file':'../dives-v1/'+filename,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    sheet=clean_alpha(Image.open(path).convert('RGBA'))
    cells=extract_grid(sheet,4,4)
    # Sheet scale derives from the matching 44px reference standing athlete,
    # whose source height is roughly 22 percent of this 4-row image height.
    scale=44/(sheet.height*.22)
    for row,direction in enumerate(directions):
        for phase,pose in enumerate(DIVE_POSES):
            cell,bbox,rect=cells[row*4+phase]
            size=(max(1,round(cell.width*scale)),max(1,round(cell.height*scale)))
            assert size[0]<=100 and size[1]<=68,(direction,pose,size)
            crop=cell.resize(size,Image.Resampling.NEAREST)
            frame=Image.new('RGBA',FRAME_SIZE)
            # Register the torso/landing footprint, not the reaching fingertips.
            x=round(PIVOT[0]-size[0]/2);y=PIVOT[1]-size[1]
            frame.alpha_composite(crop,(x,y));normalized[direction,16+phase]=frame
            extraction.append({'source':'../dives-v1/'+filename,'pose':pose,'direction':direction,'sourceRect':rect,'scale':scale,'normalizedRect':[x,y,*size],'pivot':PIVOT,'anchor':'centered body footprint; lowest grounded silhouette'})
POSES.extend(DIVE_POSES)
ACTIONS.update({'dive':[16,17,18],'dive-recover':[19,7],'dig':[18,19,7]})

# One palette across poses and directions, preserving stable material colors.
palette_source=Image.new('RGB',(8*112,len(POSES)*80))
for col,direction in enumerate(DIRECTIONS):
    for row in range(len(POSES)):palette_source.paste(normalized[direction,row].convert('RGB'),(col*112,row*80))
palette=palette_source.quantize(colors=64,method=Image.Quantize.MEDIANCUT)
for key,im in normalized.items():
    alpha=im.getchannel('A');im=im.convert('RGB').quantize(palette=palette,dither=Image.Dither.NONE).convert('RGBA');im.putalpha(alpha);normalized[key]=im
for team in PALETTES:
    for direction in DIRECTIONS:
        for index,pose in enumerate(POSES):
            im=normalized[direction,index]
            add(f'sports.{team}.{pose}.{direction}',team_variant(im,team))
        for action,indices in ACTIONS.items():
            clips[f'sports.{team}.{action}.{direction}']=[f'sports.{team}.{POSES[i]}.{direction}' for i in indices]
# Extract only the existing registered playing-floor silhouette from generated edit.
arena=source('arena-unmarked.png').resize((640,400),Image.Resampling.NEAREST)
mask=Image.new('L',(640,400));ImageDraw.Draw(mask).polygon([(122,132),(518,132),(596,305),(45,305)],fill=255)
arena.putalpha(mask);add('sports.floor.volley',arena,(0,0))
proof=Image.new('RGBA',(8*112,len(POSES)*86),(40,32,53,255));d=ImageDraw.Draw(proof)
for col,direction in enumerate(DIRECTIONS):
    for row,pose in enumerate(POSES):
        proof.alpha_composite(normalized[direction,row],(col*112,row*86+6));d.text((col*112+2,row*86),direction+' '+pose,fill='#edd7b9')
proof.save(SRC/'runtime-contact-sheet.png')

teamproof=Image.new('RGBA',(6*112,len(PALETTES)*88),(40,32,53,255));td=ImageDraw.Draw(teamproof)
for col,(direction,index) in enumerate([('E',0),('S',0),('NW',0),('E',17),('S',18),('NW',19)]):
    base=normalized[direction,index]
    for row,team in enumerate(PALETTES):
        teamproof.alpha_composite(team_variant(base,team),(col*112,row*88+12))
        td.text((col*112+2,row*88+1),team+' '+direction+' '+POSES[index][:7],fill='#edd7b9')
teamproof.save(ROOT/'apps/cryptball/art-src/dives-v1/runtime-team-comparison.png')

frames,pages=_sprite_module.pack_atlas(assets,OUT)
for name,ids in clips.items():assert all(fid in frames for fid in ids),name
provenance={'teamPalettes':list(PALETTES),'source':'Built-in OpenAI ImageGen weapon-free sports-v1 and hands-first dives-v1 sheets','tools':['OpenAI ImageGen','Pillow deterministic extraction and packing'],'sources':sources,'authoredFacings':8,'authoredPosesPerFacing':len(POSES),'weaponFree':True,'aliases':ACTIONS,'method':'Connected-component source extraction; alpha210 threshold; shared64 color palette; nearest sampling; six masked teal-uniform material palettes; no drawn athlete anatomy','limitations':'Key poses, not hand-cleaned full inbetween animation. Pass/trap reuse kick frames; Dig/dive use independently generated hands-first poses. Jump is cosmetic contact animation, no player jump physics.'}
(OUT/'manifest.json').write_text(json.dumps({'version':2,'recipeId':'cryptball-sports-v1-2026-11-04','sampling':'nearest','pages':pages,'frames':frames,'clips':clips,'provenance':provenance},indent=2)+'\n')
(SRC/'extraction.json').write_text(json.dumps({'frames':extraction,'provenance':provenance},indent=2)+'\n')
(SRC/'runtime-qa.json').write_text(json.dumps({'status':'structural gates passed','sourcePoseCount':len(normalized),'authoredFacings':DIRECTIONS,'standingHeightPx':44,'frameSize':FRAME_SIZE,'pivot':PIVOT,'binaryAlpha':all(set(im.getchannel('A').get_flattened_data()).issubset({0,255}) for im in normalized.values()),'atlasFrames':len(frames),'atlasPages':len(pages),'sources':sources},indent=2)+'\n')
(OUT/'LICENSES.txt').write_text('Original generated weapon-free athlete sheets, hands-first dive sheets, and unmarked floor edit: OpenAI ImageGen. Source prompts/extraction/provenance: apps/cryptball/art-src/sports-v1 and apps/cryptball/art-src/dives-v1. No third-party sprite assets.\n')
print(f'{len(frames)} frames, {len(clips)} clips, {len(pages)} atlas pages')
