# Selected-team arena banners

`blank-cloth.png` was generated with the built-in OpenAI ImageGen tool. Exact prompt and processing details are in `provenance.json`. The full generated source is preserved; only its blank interior fabric is sampled, so the generated backdrop and hardware never enter runtime assets.

Rebuild from repository root with `node scripts/game-assets/import-cryptball-banners.mjs` (also part of `npm run assets:cryptball`). Requires the existing Playwright Chromium installation and `.venv-assets` Pillow environment. Chromium rasterizes the existing six `public/assets/teams/*.svg` emblems without redrawing their identities. Python combines those marks with generated fabric folds, applies team fabric color, and projects opaque cloth into the eight existing colored wall flag locations. Rear skull banners remain neutral architectural decoration.

The output is `public/assets/cryptball-banners/manifest.json` and its PNG pages. Pages are tightly cropped to nontransparent bounds; negative pivots retain arena registration. Rear side flags render behind athletes, while front wall flags render above the foreground masonry cutout. The presenter reads observation `teamIds` every render so solo selection, authoritative multiplayer identity changes, and all sports use the same team assignment as athlete uniforms. No game rules depend on these assets.
