# Original mode ball sprites

Rebuild with `.venv-assets/bin/python scripts/game-assets/import-cryptball-balls.py` from the repository root. The recipe draws original native-resolution pixel geometry using Pillow; no generated athlete pixels are modified and no external source assets are required.

The panelled football and blue/gold curved-panel volleyball both occupy 12px solid silhouettes. Eight travel-selected spin frames and four authored squash/rebound/settle frames share a center pivot. Temporary contact deformation is cosmetic; collision radii remain the simulation's authored 6 units for both sports. Set, dig and attack use distinct five-frame airborne contact cues. Cryptball retains its original orb atlas.

`contact-sheet-1x.png` shows delivery pixels; `contact-sheet-4x.png` is nearest-neighbor inspection. `spin-contact-proof.gif` previews actual frame playback. Frame indices follow `provenance.frameOrder` in the runtime manifest. The first twelve are football spin/contact, the next twelve volleyball spin/contact, followed by set/dig/attack cues. Runtime output is the independent `public/assets/cryptball-balls` atlas and manifest. No third-party pixels or licenses are used.
