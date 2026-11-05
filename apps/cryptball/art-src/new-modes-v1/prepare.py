"""Slice generated source grids and assemble review-only clips; no game code changes."""
from pathlib import Path
import hashlib
import json
from PIL import Image, ImageDraw

BASE = Path(__file__).resolve().parent
POSES = ['catch-ready', 'catch-contact', 'carry', 'throw-windup', 'throw-release', 'throw-follow', 'pass-release', 'hit-recoil']
BOSS = ['idle-a', 'idle-b', 'wake', 'roar', 'ranged-tell', 'ranged-aim', 'ranged-recoil', 'ranged-recover', 'melee-tell', 'sweep', 'slam', 'melee-recover', 'hit', 'stun', 'defeat', 'rubble']
OBJECTS = ['cannon', 'hook', 'maul', 'crown', 'pillar', 'pillar-cracked', 'pillar-rubble', 'closed-gate', 'ball-a', 'ball-b', 'ball-squash', 'ball-stretch', 'boss-bolt', 'chain', 'impact', 'soul']
manifest = {'status': 'review sprites; not registered with runtime', 'frames': {}, 'sources': {}, 'clips': {}, 'notes': ['Hand and weapon sockets require in-game authoring.', 'Athlete frames use a shared scale within each source sheet.', 'Key-pose animation, not hand-authored inbetweens.']}
images = {}
ROW_CUTS = {
    'athlete-front.png': [0,242,462,684,905,1126,1348,1562,1774],
    'athlete-back.png': [0,234,457,677,900,1123,1344,1553,1774],
    'guardian.png': [0,279,538,819,1086],
    'equipment.png': [0,300,566,810,1086],
}
(BASE / 'frames').mkdir(exist_ok=True)

for filename, rows, directions in [('athlete-front.png', 8, ['E','SE','S','SW']), ('athlete-back.png', 8, ['W','NW','N','NE']), ('guardian.png', 4, None), ('equipment.png', 4, None)]:
    path = BASE / filename
    im = Image.open(path).convert('RGBA')
    alpha = im.getchannel('A')
    assert alpha.getextrema() == (0, 255), f'Expected genuine alpha: {filename}'
    manifest['sources'][filename] = {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'size': list(im.size), 'grid': [4,rows]}
    cells = []
    for row in range(rows):
        for col in range(4):
            box = (round(col*im.width/4), ROW_CUTS[filename][row], round((col+1)*im.width/4), ROW_CUTS[filename][row+1])
            cell = im.crop(box)
            bbox = cell.getchannel('A').point(lambda a: 255 if a > 32 else 0).getbbox()
            assert bbox, (filename,row,col)
            cells.append((box,bbox,cell.crop(bbox)))
    standing = max(c[2].height for c in cells[:4])
    scale = (44 if directions else 78) / standing
    for i, (box,bbox,crop) in enumerate(cells):
        row,col = divmod(i,4)
        if directions:
            key = f'athlete.{directions[col]}.{POSES[row]}'
            canvas_size,pivot = (112,80),(56,70)
            factor = scale
        elif filename == 'guardian.png':
            key = 'guardian.' + BOSS[i]
            canvas_size,pivot = (160,128),(80,112)
            factor = scale
        else:
            key = 'object.' + OBJECTS[i]
            canvas_size,pivot = (96,96),(48,80)
            # Ball deformation keeps a shared scale; cover states share a scale.
            if 8 <= i <= 11:
                factor = 12 / cells[8][2].width
            elif 4 <= i <= 6:
                factor = 34 / cells[4][2].height
            else:
                target = [26,30,34,30,34,34,34,58,12,12,12,12,16,14,24,20][i]
                factor = target / max(crop.size)
        size = (max(1,round(crop.width*factor)),max(1,round(crop.height*factor)))
        sprite = crop.resize(size,Image.Resampling.NEAREST)
        assert size[0] <= canvas_size[0] and size[1] <= pivot[1], (key,size)
        frame = Image.new('RGBA',canvas_size)
        frame.alpha_composite(sprite,(pivot[0]-size[0]//2,pivot[1]-size[1]))
        frame.save(BASE/'frames'/f'{key}.png')
        images[key] = frame
        manifest['frames'][key] = {'file': f'frames/{key}.png', 'size': list(canvas_size), 'pivot': list(pivot), 'source': filename, 'cell': list(box), 'cropWithinCell': list(bbox), 'scale': factor}

for direction in ['E','SE','S','SW','W','NW','N','NE']:
    prefix = f'athlete.{direction}.'
    for name, poses in {'catch': ['catch-ready','catch-contact','carry'], 'throw': ['carry','throw-windup','throw-release','throw-follow','catch-ready'], 'pass': ['carry','pass-release','catch-ready'], 'hit': ['catch-ready','hit-recoil','catch-ready']}.items():
        manifest['clips'][f'{direction}.{name}'] = [prefix+p for p in poses]
manifest['clips']['guardian.cannon'] = ['guardian.'+p for p in ['idle-a','idle-b','ranged-tell','ranged-aim','ranged-recoil','ranged-recover']]
manifest['clips']['guardian.melee'] = ['guardian.'+p for p in ['idle-a','melee-tell','sweep','slam','melee-recover']]
manifest['clips']['guardian.defeat'] = ['guardian.'+p for p in ['hit','stun','defeat','rubble']]

# Proofs deliberately show the native pixels magnified 2x, without smoothing.
proof=[]
seq=['catch-ready','catch-contact','carry','throw-windup','throw-release','throw-follow','pass-release','hit-recoil']
for t in range(16):
    canvas=Image.new('RGBA',(720,260),'#20242f'); draw=ImageDraw.Draw(canvas)
    draw.text((12,8),'CRYPT MODES - generated key-pose review (not gameplay)',fill='#eee5ce')
    for i,d in enumerate(['E','SE','S','SW','W','NW','N','NE']):
        frame=images[f'athlete.{d}.{seq[(t//2)%8]}']
        x=8+(i%4)*112;y=30+(i//4)*104
        canvas.alpha_composite(frame,(x,y));draw.text((x+48,y+82),d,fill='#eee5ce')
    frame=images['guardian.'+BOSS[t]]
    canvas.alpha_composite(frame,(500,56));draw.text((510,202),BOSS[t],fill='#eee5ce')
    proof.append(canvas.convert('RGB').resize((1440,520),Image.Resampling.NEAREST))
proof[0].save(BASE/'animation-proof.gif',save_all=True,append_images=proof[1:],duration=220,loop=0)

contact=Image.new('RGBA',(768,384),'#20242f');draw=ImageDraw.Draw(contact)
for i,name in enumerate(OBJECTS):
    x=(i%8)*96;y=(i//8)*150
    contact.alpha_composite(images['object.'+name],(x,y+20));draw.text((x+2,y+108),name,fill='#eee5ce')
contact.save(BASE/'equipment-native.png')
overview=Image.new('RGBA',(1280,12*150),'#20242f');draw=ImageDraw.Draw(overview)
for i,(key,frame) in enumerate(images.items()):
    x=(i%8)*160;y=(i//8)*150
    overview.alpha_composite(frame,(x+(160-frame.width)//2,y))
    draw.text((x+4,y+130),key.replace('athlete.','').replace('guardian.','boss.'),fill='#eee5ce')
overview.save(BASE/'all-frames.png')
(BASE/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'frames':len(images),'clips':len(manifest['clips']),'sources':len(manifest['sources']),'alpha':'all source PNGs contain transparent and opaque pixels'}))
