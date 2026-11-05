"""Verify delivered palettes change only the source uniform mask, for every pose."""
from pathlib import Path
import importlib.util,json
from PIL import Image
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('palettes',Path(__file__).with_name('cryptball-team-palettes.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
report={}
for atlas,baseprefix in [('cryptball','ivory.athlete.'),('cryptball-sports','sports.ivory.')]:
    path=ROOT/'apps/cryptball/public/assets'/atlas;manifest=json.loads((path/'manifest.json').read_text())
    pages={key:Image.open(path/name).convert('RGBA') for key,name in manifest['pages'].items()}
    def pixels(key):
        f=manifest['frames'][key];return list(pages[f['pageId']].crop((f['x'],f['y'],f['x']+f['width'],f['y']+f['height'])).get_flattened_data())
    tested=0;changed={team:0 for team in m.PALETTES if team!='ivory'}
    for key in manifest['frames']:
        if not key.startswith(baseprefix):continue
        base=pixels(key)
        for team in changed:
            variant=key.replace('ivory',team,1);actual=pixels(variant)
            assert len(actual)==len(base),(key,team,'geometry changed')
            for original,painted in zip(base,actual):
                assert original[3]==painted[3],(key,team,'alpha changed')
                if not m.material_pixel(*original):assert original==painted,(key,team,'nonuniform material changed')
                changed[team]+=original!=painted
            tested+=1
    assert all(changed.values()),changed
    report[atlas]={'variantFramesChecked':tested,'changedUniformPixels':changed,'nonUniformPixelsPreserved':True,'alphaPreserved':True,'pages':len(pages),'pngBytes':sum((path/name).stat().st_size for name in manifest['pages'].values())}
out=ROOT/'apps/cryptball/art-src/dives-v1/material-qa.json';out.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
