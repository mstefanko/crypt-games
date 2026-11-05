"""Read-only image inspection; writes selected-source provenance/QA JSON only."""
from pathlib import Path
from PIL import Image
import hashlib,json
root=Path(__file__).resolve().parent
poses=['ready','glide','push-left','push-right','wrist-windup','wrist-contact','wrist-follow','receive','slap-windup','slap-downswing','slap-contact','slap-follow','poke-check','shoulder-check','stop','recover']
contact_poses=['wrist-contact','slap-contact','poke-check']
# Explicit source inventory excludes runtime proof PNGs and edit-guide composites.
files=[f'action-{d}.png' for d in ['E','SE','S','SW','W','NW','N','NE']]+['action-N-grounded.png','arena-ice.png','puck-effects.png','diagonal-contact-grounded.png','contact-SE-grounded.png','contact-SW-grounded.png']
records=[]
for name in files:
    path=root/name
    with Image.open(path) as image:
        alpha=image.convert('RGBA').getchannel('A')
        record={'file':name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'size':list(image.size),'mode':image.mode,'alphaExtrema':list(alpha.getextrema()),'bytes':path.stat().st_size,'selectedForRuntime':name!='action-N.png'}
        if name!='arena-ice.png':
            cols,rows=(4,4) if name.startswith('action-') else (3,1) if name.startswith('contact-') else (4,3)
            record['grid']=[cols,rows];record['cells']=[]
            for i in range(cols*rows):
                col,row=i%cols,i//cols
                box=(col*image.width//cols,row*image.height//rows,(col+1)*image.width//cols,(row+1)*image.height//rows)
                cell=alpha.crop(box).point(lambda a:255 if a>=210 else 0);bounds=cell.getbbox();assert bounds,(name,i,'empty cell')
                pose=poses[i] if name.startswith('action-') else contact_poses[col]+'-'+name[8:10] if name.startswith('contact-') else contact_poses[row]+'-'+['SE','SW','NW','NE'][col] if name.startswith('diagonal-') else ['puck','spray','contact'][row]+f'-{col}'
                record['cells'].append({'index':i,'pose':pose,'gridRect':list(box),'opaqueBoundsInCell':list(bounds),'touchesGridEdge':bounds[0]==0 or bounds[1]==0 or bounds[2]==cell.width or bounds[3]==cell.height})
            assert alpha.getextrema()[0]==0,(name,'missing transparency')
        records.append(record)
assert len(records)==14
(root/'source-manifest.json').write_text(json.dumps({'generated':'2026-11-04','generator':'built-in image_gen','status':'runtime imported; original sheets and selected north/diagonal corrections preserved','runtimeAthletePoses':128,'runtimeContactOverrides':12,'generatedSourcePngs':14,'consumedSourcePngs':13,'sources':records},indent=2)+'\n')
print(json.dumps({'generatedSourcePngs':len(records),'consumedSourcePngs':13,'baseDirectionalCells':128,'generatedContactCorrectionCells':18,'runtimeContactOverrides':12,'runtimeAthletePoses':128,'puckAndEffectCells':12,'bytes':sum(r['bytes'] for r in records)},indent=2))
