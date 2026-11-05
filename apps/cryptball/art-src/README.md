# Cryptball art sources

The active runtime pipeline is `scripts/game-assets/import-cryptball-polished.py`, invoked by `npm run assets:cryptball`. It extracts the generated `polished-v1` source kit; it does not draw procedural athletes or use purchased athlete pixels.

The source kit includes eight facing-specific 4×3 pose sheets, an eight-frame flame sheet, a runtime arena with unlit braziers and stone side walls, crowd clusters and goal material. The importer records source SHA-256 hashes, crop rectangles, source foot anchors and native normalization in `polished-v1/extraction.json`. It creates a shared 64-color athlete palette, binary athlete alpha, a material-only teal-to-ember team swap, fixed frame pivots and nearest-neighbor atlas pages. It retains the original small ball, interface and contact effects from `export/`.

Review `polished-v1/runtime-contact-sheet.png` at native size and `runtime-contact-sheet-2x.png` enlarged; inspect `runtime-fire-sheet.png`, `runtime-arena.png` and the in-game preview. `runtime-qa.json` checks structure and clipping, not human approval or animation quality. Pass/power share the authored strike poses; recoil shares recovery; idle/celebrate use the neutral source pose. These aliases are explicit in extraction metadata.

Earlier `athlete-sample-*`, `court-sample-*`, `animation-proof.gif`, `cryptball-athlete.py` and `import-cryptball.py` document the original procedural prototype. They are retained as history and are not the active polished athlete or arena source. The old `export/` arena/athlete-adjacent decorations are not composited into the polished arena.
