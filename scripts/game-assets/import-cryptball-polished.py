"""Deterministically extract generated polished-v1 sources into the runtime atlas.
No athlete is drawn or synthesized here; every pose is an inspected source crop.
"""
from pathlib import Path
import colorsys, hashlib, json, math, re, sys
from PIL import Image, ImageDraw
import importlib.util
_palette_spec=importlib.util.spec_from_file_location("team_palettes",Path(__file__).with_name("cryptball-team-palettes.py"))
_palette_module=importlib.util.module_from_spec(_palette_spec);_palette_spec.loader.exec_module(_palette_module)
PALETTES=_palette_module.PALETTES
team_variant=_palette_module.team_variant
ROOT = Path(__file__).resolve().parents[2]
ART = ROOT/'apps/cryptball/art-src'
SRC = ART/'polished-v1'
OUT = ROOT/'apps/cryptball/public/assets/cryptball'
OUT.mkdir(parents=True,exist_ok=True)
spec_source=(ROOT/'apps/cryptball/sim/spec.ts').read_text()
spec_match=re.search(r'export const COURT = Object.freeze\(\{([^}]+)\}',spec_source)
assert spec_match, 'Court spec syntax changed: update exporter'
COURT={key:int(value) for key,value in re.findall(r'(\w+):\s*(\d+)',spec_match[1])}
(OUT/'court-spec.json').write_text(json.dumps(COURT,indent=2)+'\n')
DIRECTIONS = ['E','SE','S','SW','W','NW','N','NE']
HEADINGS = ['E','NEE','NE','NNE','N','NNW','NW','NWW','W','SWW','SW','SSW','S','SSE','SE','SEE']
POSES = ['idle','run-a','run-b','run-c','run-d','strike-windup','strike-contact','strike-follow','slide-entry','slide-active','recovery-low','recovery-up']
ACTIONS = {'idle':[0], 'run':[1,2,3,4], 'sprint':[1,2,3,4], 'strike':[5,6,7], 'pass':[5,6,7], 'power':[5,6,7], 'slide-launch':[8], 'slide':[9], 'slide-recover':[10,11], 'recoil':[10,11], 'celebrate':[0], 'keeper-shuffle':[1,2,3,4], 'keeper-dive':[8,9]}
FRAME_SIZE = (112,72)
PIVOT = (56,64)
assets=[];clips={};sources=[];extraction=[]
def add(name,im,pivot=PIVOT,duration=1/12):
    assert im.getbbox(),f'Empty frame: {name}'
    assets.append((name,im,pivot,duration))
def source(name):
    path=SRC/name
    if not path.exists():raise RuntimeError(f'Required generated source missing: {path}')
    sources.append({'file':name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    return Image.open(path).convert('RGBA')
def clean_alpha(im):
    # ImageGen cutouts have alpha250-254 interiors and very faint colored fringes.
    # Never composite the fringe against a matte: discard it before normalization.
    im=im.copy();im.putalpha(im.getchannel('A').point(lambda a:255 if a>=210 else 0))
    return im

def extract_grid(sheet,cols,rows):
    """Assign isolated source silhouettes by center; poses may cross cell lines."""
    width,height=sheet.size;alpha=sheet.getchannel('A').tobytes();seen=bytearray(width*height)
    selected={};components=[]
    for start,value in enumerate(alpha):
        if not value or seen[start]:continue
        stack=[start];seen[start]=1;pixels=[];minx=width;miny=height;maxx=maxy=0
        while stack:
            at=stack.pop();pixels.append(at);x=at%width;y=at//width
            minx=min(minx,x);maxx=max(maxx,x);miny=min(miny,y);maxy=max(maxy,y)
            neighbors=[]
            if x:neighbors.append(at-1)
            if x+1<width:neighbors.append(at+1)
            if y:neighbors.append(at-width)
            if y+1<height:neighbors.append(at+width)
            for nxt in neighbors:
                if alpha[nxt] and not seen[nxt]:seen[nxt]=1;stack.append(nxt)
        if len(pixels)>=64:components.append((pixels,(minx,miny,maxx+1,maxy+1)))
        if len(pixels)<500:continue
        col=min(cols-1,int(((minx+maxx)/2)/width*cols));row=min(rows-1,int(((miny+maxy)/2)/height*rows))
        key=row*cols+col
        if key not in selected or len(pixels)>len(selected[key][0]):selected[key]=(pixels,(minx,miny,maxx+1,maxy+1))
    assert len(selected)==cols*rows,('Expected isolated figures',len(selected),cols*rows)
    # Retain detached solid armor/bat pieces near the owning silhouette. Faint
    # antialias/glow islands are not anatomy and must not become opaque halos.
    main_ids={id(item[0]) for item in selected.values()}
    for extra,box in components:
        if id(extra) in main_ids:continue
        if sum(alpha[at]>=245 for at in extra)/len(extra)<.90:continue
        cx=(box[0]+box[2])/2;cy=(box[1]+box[3])/2
        choices=[]
        for key,(main,bounds) in selected.items():
            dx=max(bounds[0]-box[2],box[0]-bounds[2],0)
            dy=max(bounds[1]-box[3],box[1]-bounds[3],0)
            if dx<=28 and dy<=28:choices.append((dx*dx+dy*dy,key))
        if choices:
            _,key=min(choices);main,bounds=selected[key]
            selected[key]=(main+extra,(min(bounds[0],box[0]),min(bounds[1],box[1]),max(bounds[2],box[2]),max(bounds[3],box[3])))
    result=[]
    for index in range(cols*rows):
        pixels,rect=selected[index];mask=Image.new('L',sheet.size);data=bytearray(width*height)
        for at in pixels:data[at]=255
        mask=Image.frombytes('L',sheet.size,bytes(data)).crop(rect)
        cell=sheet.crop(rect);cell.putalpha(mask)
        result.append((cell,(0,0,cell.width,cell.height),rect))
    return result

def foot_anchor(im):
    box=im.getbbox(); assert box
    y0=max(box[1],box[3]-max(2,round((box[3]-box[1])*.12)))
    pixels=im.load();xs=[x for y in range(y0,box[3]) for x in range(box[0],box[2]) if pixels[x,y][3]]
    return ((min(xs)+max(xs))/2,box[3])

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

# Required eight sheets; explicit crops and source anchors become reviewable metadata.
normalized={}
for direction in DIRECTIONS:
    sheet=clean_alpha(source(f'action-{direction}.png'))
    cells=extract_grid(sheet,4,3)
    scale=44/(cells[0][1][3]-cells[0][1][1])
    for index,(cell,bbox,rect) in enumerate(cells):
        anchor=foot_anchor(cell)
        crop=cell.crop(bbox)
        size=(max(1,round(crop.width*scale)),max(1,round(crop.height*scale)))
        assert size[0]<=94 and size[1]<=63,(direction,POSES[index],size,'source pose exceeds normalized canvas')
        crop=crop.resize(size,Image.Resampling.NEAREST)
        frame=Image.new('RGBA',FRAME_SIZE)
        x=round(PIVOT[0]-(anchor[0]-bbox[0])*scale);y=PIVOT[1]-size[1]
        assert x>=0 and x+size[0]<=FRAME_SIZE[0],(direction,POSES[index],'horizontal clipping',x,size)
        frame.alpha_composite(crop,(x,y));normalized[direction,index]=frame
        extraction.append({'source':f'action-{direction}.png','pose':POSES[index],'sourceComponentRect':rect,'contentRect':bbox,'sourceFootAnchor':anchor,'scale':scale,'normalizedRect':[x,y,*size],'frameSize':FRAME_SIZE,'pivot':PIVOT})

# One shared athlete palette prevents per-frame quantization color flicker.
palette_source=Image.new('RGB',(8*112,12*72))
for col,direction in enumerate(DIRECTIONS):
    for row in range(12):palette_source.paste(normalized[direction,row].convert('RGB'),(col*112,row*72))
shared_palette=palette_source.quantize(colors=64,method=Image.Quantize.MEDIANCUT)
for key,im in normalized.items():
    alpha=im.getchannel('A')
    im=im.convert('RGB').quantize(palette=shared_palette,dither=Image.Dither.NONE).convert('RGBA')
    im.putalpha(alpha);normalized[key]=im

for team in PALETTES:
    for direction in DIRECTIONS:
        for index,pose in enumerate(POSES):
            im=normalized[direction,index]
            im=team_variant(im,team)
            add(f'{team}.athlete.{pose}.{direction}',im)
    for archetype in ['warrior','knight','keeper']:
        for action,indices in ACTIONS.items():
            for h,heading in enumerate(HEADINGS):
                # Runtime heading order is counterclockwise; generated rows are clockwise.
                direction=['E','NE','N','NW','W','SW','S','SE'][((h+1)//2)%8]
                clips[f'{team}.{archetype}.{action}.{heading}']=[f'{team}.athlete.{POSES[i]}.{direction}' for i in indices]

# Retain original small UI/ball/contact effects, never the old athletes or court.
old=json.loads((OUT/'manifest.json').read_text())
allowed=('orb.','shadow','ring','arrow','hud','crest.','badge.','logo','fx.','key.')
for path in sorted((ART/'export').glob('*.png')):
    if path.stem.startswith(allowed):
        meta=old['frames'].get(path.stem,{})
        im=Image.open(path).convert('RGBA')
        pivot=meta.get('pivot',{'x':im.width/2,'y':im.height/2})
        add(path.stem,im,(pivot['x'],pivot['y']),meta.get('duration',1/12))
for name,ids in old['clips'].items():
    if name.startswith('fx.'):clips[name]=ids

# Generated spectator pose variants are static clusters, not claimed animation.
crowd_source=clean_alpha(source('crowd-props.png'))
crowd_rects=[(16,90,374,252),(398,84,748,252),(773,105,1130,252),(1150,104,1518,252)]
for index,rect in enumerate(crowd_rects):
    cell=crowd_source.crop(rect);cell=cell.crop(cell.getbbox())
    scale=min(80/cell.width,30/cell.height)
    cell=cell.resize((max(1,round(cell.width*scale)),max(1,round(cell.height*scale))),Image.Resampling.NEAREST)
    pixels=cell.load()
    for y in range(cell.height):
        for x in range(cell.width):
            r,g,b,a=pixels[x,y]
            lum=.2*r+.65*g+.15*b
            pixels[x,y]=(round(22+lum*.38),round(20+lum*.30),round(35+lum*.44),a)
    frame=Image.new('RGBA',(80,30));frame.alpha_composite(cell,((80-cell.width)//2,30-cell.height))
    add(f'crowd.polished.{index}',frame,(40,30))

# A generated stone upright is registered to the actual simulation goal posts.
goal_source=clean_alpha(source('goal-pair.png'))
goal_post=goal_source.crop((382,271,435,553)).resize((8,28),Image.Resampling.NEAREST)
add('goal.post.polished',goal_post,(4,28))
goal_post.save(SRC/'runtime-goal-post.png')

# Full composition establishes the camera; no old procedural stadium is layered over it.
arena=source('arena-runtime.png').resize((640,400),Image.Resampling.NEAREST)
fire_positions=[(60,43),(183,57),(267,59),(373,59),(458,57),(580,43),(27,343),(614,343)]
arena.save(SRC/'runtime-arena.png')
add('arena.polished',arena,(0,0))
foreground=Image.new('RGBA',(640,400))
# Near-wall occlusion: all pixels below the registered near floor edge.
foreground.paste(arena.crop((0,305,640,400)),(0,305))
# End walls stay in the background. A full-height side cutout incorrectly
# painted the boundary line and masonry over athletes standing near the goal.
add('arena.foreground',foreground,(0,0))

fire=clean_alpha(source('fire-frames.png'))
firecells=[]
for index in range(8):
    col=index%4;row=index//4
    cell=fire.crop((round(col*fire.width/4),round(row*fire.height/2),round((col+1)*fire.width/4),round((row+1)*fire.height/2)))
    bbox=cell.getbbox();assert bbox,('empty fire',index)
    firecells.append((cell.crop(bbox),foot_anchor(cell),bbox))
scale=min(30/max(im.width for im,anchor,bbox in firecells),38/max(im.height for im,anchor,bbox in firecells))
for index,(im,anchor,bbox) in enumerate(firecells):
    im=im.resize((max(1,round(im.width*scale)),max(1,round(im.height*scale))),Image.Resampling.NEAREST)
    frame=Image.new('RGBA',(32,40))
    x=round(16-(anchor[0]-bbox[0])*scale)
    x=max(0,min(32-im.width,x))
    frame.alpha_composite(im,(x,39-im.height))
    add(f'arena.fire.{index}',frame,(16,39),.09)
clips['arena.fire']=[f'arena.fire.{index}' for index in range(8)]

# Native-resolution inspection sheet. Frames include the exact fixed canvas.
proof=Image.new('RGBA',(8*112,12*78),(40,32,53,255));draw=ImageDraw.Draw(proof)
for col,direction in enumerate(DIRECTIONS):
    for row,pose in enumerate(POSES):
        proof.alpha_composite(normalized[direction,row],(col*112,row*78+6))
        draw.text((col*112+2,row*78),direction+' '+pose[:7],fill='#edd7b9')
proof.save(SRC/'runtime-contact-sheet.png')
proof.resize((1792,1872),Image.Resampling.NEAREST).save(SRC/'runtime-contact-sheet-2x.png')
teamproof=Image.new('RGBA',(6*112,len(PALETTES)*88),(40,32,53,255));td=ImageDraw.Draw(teamproof)
proof_poses=[('E',0),('S',0),('NW',0),('E',2),('E',6),('E',9)]
for col,(direction,index) in enumerate(proof_poses):
    base=normalized[direction,index]
    for row,team in enumerate(PALETTES):
        teamproof.alpha_composite(team_variant(base,team),(col*112,row*88+12))
        td.text((col*112+2,row*88+1),team+' '+direction+' '+POSES[index][:7],fill='#edd7b9')
teamproof.save(SRC/'runtime-team-comparison.png')
teamproof.resize((1344,len(PALETTES)*176),Image.Resampling.NEAREST).save(SRC/'runtime-team-comparison-2x.png')
fireproof=Image.new('RGBA',(8*40,48),(40,32,53,255))
for i,(name,im,pivot,duration) in enumerate([a for a in assets if a[0].startswith('arena.fire.')]):fireproof.alpha_composite(im,(i*40+4,4))
fireproof.save(SRC/'runtime-fire-sheet.png')

# Deterministic shelf pack, two-pixel gutters, source-space pivots retained.
frames={};pages={};page=Image.new('RGBA',(1024,1024));x=y=1;row=0;pageid=0
def savepage():
    page.save(OUT/f'page-{pageid}.png');pages[str(pageid)]=f'page-{pageid}.png'
for name,im,pivot,duration in assets:
    box=im.getbbox();crop=im.crop(box);w,h=crop.size
    if x+w+1>1024:x=1;y+=row+2;row=0
    if y+h+1>1024:savepage();pageid+=1;page=Image.new('RGBA',(1024,1024));x=y=1;row=0
    page.alpha_composite(crop,(x,y))
    frames[name]={'pageId':str(pageid),'x':x,'y':y,'width':w,'height':h,'originalSize':{'width':im.width,'height':im.height},'trim':{'x':box[0],'y':box[1]},'pivot':{'x':pivot[0],'y':pivot[1]},'duration':duration,'mirrorable':False}
    x+=w+2;row=max(row,h)
savepage()
for path in OUT.glob('page-*.png'):
    if path.name not in pages.values():path.unlink()
provenance={'teamPalettes':list(PALETTES),'source':'Generated polished-v1 source images; see prompts.json and extraction.json','tools':['OpenAI ImageGen','Python','Pillow'],'sources':sources,'athleteMethod':'Source crop, threshold alpha210, nearest-neighbor native sampling,64-color shared palette quantization, six constrained teal-uniform material palettes; no generated procedural anatomy','authoredHeadings':8,'runtimeHeadings':16,'reviewStatus':'Runtime integration preview; human motion/readability approval pending','retainedAssets':'Original small ball/UI/contact effects from art-src/export; no original procedural athletes/court/stadium used'}
manifest={'version':2,'recipeId':'cryptball-polished-2v2-2026-11-04','sampling':'nearest','pages':pages,'frames':frames,'clips':clips,'provenance':provenance,'arena':{'size':[640,400],'firePositions':fire_positions,'firePivot':[16,39]}}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
(SRC/'extraction.json').write_text(json.dumps({'frames':extraction,'fireGrid':[4,2],'fireFrameSize':[32,40],'firePivot':[16,39],'firePositions':fire_positions,'aliases':ACTIONS,'provenance':provenance},indent=2)+'\n')
(ROOT/'scripts/game-assets/cryptball-source-selection.json').write_text(json.dumps(provenance,indent=2)+'\n')
(OUT/'LICENSES.txt').write_text('CRYPTBALL POLISHED GENERATED ART\nAthletes, arena and animated flame source images generated with OpenAI ImageGen. Prompts, source hashes and extraction metadata: apps/cryptball/art-src/polished-v1. Runtime cleanup uses Pillow. Original small ball/UI/contact FX retained from scripts/game-assets/import-cryptball.py; no purchased athlete assets used. No assertion of exclusive copyright or human approval.\n')
# Build-failing atlas integrity and alpha/anchor gates.
for name,im,pivot,duration in assets:
    if '.athlete.' in name:
        assert im.size==FRAME_SIZE and pivot==PIVOT
        assert set(im.getchannel('A').get_flattened_data()).issubset({0,255})
for name,ids in clips.items():assert all(fid in frames for fid in ids),(name,'dangling frame')
qa={'status':'structural gates passed','generatedAthletePoseCount':len(normalized),'authoredDirections':DIRECTIONS,'frameSize':FRAME_SIZE,'footPivot':PIVOT,'standingHeightPx':44,'sharedBasePaletteLimit':64,'athleteBinaryAlpha':True,'flameFrames':8,'atlasFrames':len(frames),'atlasPages':len(pages),'sourceHashes':sources,'manualReview':'Contact sheet and runtime preview require visual inspection; structural gates do not certify handedness or motion quality.'}
(SRC/'runtime-qa.json').write_text(json.dumps(qa,indent=2)+'\n')
(ART/'sample-qa.json').write_text(json.dumps(qa,indent=2)+'\n')
print(f'{len(frames)} frames, {len(clips)} clips, {len(pages)} pages; generated polished source extraction complete')
