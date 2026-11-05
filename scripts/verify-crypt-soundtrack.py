"""Technical asset QA; Python 3 + numpy. Does not assert listening quality."""
from pathlib import Path
import hashlib, json, wave
import numpy as np

root = Path(__file__).resolve().parents[1] / 'docs/evidence/crypt-soundtrack-concept-2026-11-05'
manifest = json.loads((root / 'manifest.json').read_text())
report = {'files': [], 'stem_sums': [], 'limitations': 'Technical audio-file checks only; no subjective listening or in-game mix approval.'}

def read(name):
    with wave.open(str(root / name), 'rb') as w:
        assert w.getnchannels() == 2 and w.getsampwidth() == 2 and w.getframerate() == 44100
        return np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').astype(np.int32).reshape(-1, 2)

for f in manifest['files']:
    p = root / f['file']
    assert hashlib.sha256(p.read_bytes()).hexdigest() == f['sha256']
    a = read(f['file'])
    assert len(a) == f['frames']
    assert np.max(np.abs(a)) < 32767
    assert np.any(a)
    if f['loop']:
        assert f['seam'] < .005, f['file'] + ': excessive loop boundary step'
    if f['loop'] and '-stem-' not in f['file']:
        for start in range(0, len(a) - 44100, 44100):
            assert np.sqrt(np.mean((a[start:start+44100] / 32768.) ** 2)) > .0001
    report['files'].append({'file':f['file'], 'frames':len(a), 'peak_dbfs':round(20*np.log10(np.max(np.abs(a))/32768),2), 'boundary_delta':f['seam'], 'passed':True})

for sport in ['cryptball','cryptkick','rift-volley','cryptcheck','crypt-dodge','crypt-guardian']:
    normal=read(sport+'.wav')
    foundation=read(sport+'-stem-foundation.wav')
    identity=read(sport+'-stem-identity.wav')
    pressure=read(sport+'-stem-pressure.wav')
    full=read(sport+'-pressure.wav')
    assert normal.shape == foundation.shape == identity.shape == pressure.shape == full.shape
    # Independent PCM16 quantization introduces up to a few least-significant bits.
    delta_normal=int(np.max(np.abs(normal-foundation-identity)))
    delta_pressure=int(np.max(np.abs(full-foundation-identity-pressure)))
    assert delta_normal<=3 and delta_pressure<=4
    report['stem_sums'].append({'sport':sport,'normal_error_lsb':delta_normal,'pressure_error_lsb':delta_pressure,'passed':True})

midis=list(root.glob('*.mid'))
assert len(midis)==13
for p in midis:
    data=p.read_bytes()
    assert data[:4]==b'MThd' and b'MTrk' in data
report['midi_files']=len(midis)
report['all_passed']=True
(root/'validation.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'wav_files':len(report['files']),'aligned_stem_sets':len(report['stem_sums']),'midi_files':len(midis),'all_passed':True}))
