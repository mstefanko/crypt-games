# Cryptcheck hockey source art

Generated November 4, 2026 with the built-in OpenAI ImageGen tool, using the existing weapon-free Cryptball athlete sheets and unmarked arena as identity/camera references. All selected outputs are saved here. Runtime integration now uses an independent hockey atlas, loaded when Cryptcheck is selected. Exact generation prompts, including the north-facing correction, are in [prompts.json](prompts.json). Source hashes, dimensions, transparency checks and proposed grid cells are in [source-manifest.json](source-manifest.json).

## Inventory

| Files | Contents |
|---|---|
| `action-E.png`, `action-SE.png`, `action-S.png`, `action-SW.png`, `action-W.png`, `action-NW.png`, `action-N.png`, `action-NE.png` | 16 generated hockey key poses per screen-facing direction, 128 total; transparent |
| `action-N-grounded.png` | Selected runtime north sheet: targeted low-blade correction; original `action-N.png` remains preserved |
| `diagonal-contact-grounded.png` | Targeted four-direction contact correction: only NW/NE columns are consumed; rows wrist/slap/poke |
| `contact-SE-grounded.png`, `contact-SW-grounded.png` | Final front-diagonal corrections; three columns wrist/slap/poke, one row; replace six contact poses |
| `arena-ice.png` | Existing dungeon arena with frozen playable floor; opaque reference composition, extract only registered floor |
| `puck-effects.png` | Four puck scuff variants, four braking spray phases, four small contact cue phases; transparent |
| `component-extraction.json` | 16 complete figure source rectangles per facing, verified using current sports importer component extraction |
| `inspect-sources.py` | Read-only PNG inspection and repeatable source manifest generation |

Directional sheets use four rows of four poses, read left to right:

1. Ready, glide, left push, right push.
2. Wrist windup, wrist contact, wrist follow-through, receive.
3. Slap windup, slap downswing, slap contact, slap follow-through.
4. Poke check, shoulder check, hockey stop, relaxed recovery.

The puck/effects sheet uses four columns and three rows: puck variants, spray phases, contact phases. Do not use spray or contact graphics as a physics collider. The dark puck is rigid; variant frames are cosmetic top-scuff variation, not deformation.

## Reuse and intended aliases

Reuse existing architecture, foreground cutouts, goals, banners, icons, HUD, special overlays and six team-material palettes. Brief falls/push-ups/celebrations may use existing weapon-free poses with the stick explicitly stowed/hidden. Active skating, shots, receiving and checks use this new art. Pass aliases wrist shot, burst aliases push, stickhandling uses ready/receive, and full charge holds slap windup. Exact rink lines and circles should be drawn from world coordinates using the existing projection, not generated into the floor texture.

## Inspection performed and limitations

All ten selected PNGs were visually inspected. All eight athlete sheets have 16 nonempty cells and transparent backgrounds. The current sports importer's connected-component algorithm successfully identifies 16 complete figure components for **every** facing; these source rectangles are recorded. There are 12 nonempty puck/effect cells. Selected source PNGs total 14,042,642 bytes (about 13.4 MiB); these are high-resolution sources, not the proposed runtime download cost.

Some silhouettes cross nominal grid boundaries: east poke/shoulder cells and north upper rows. Use the component rectangles, not naive equal-cell cropping. Grid-edge findings are retained in the manifest instead of hidden. This is not an assertion that each rectangle already has the final foot/blade pivot. The runtime importer must retain small disconnected skate/armor components, validate full blade extents, apply the existing material palette and inspect native-size output.

The planning north sheet correctly occluded the far-side grip but placed many low blades at shoulder height. A targeted built-in ImageGen edit produced `action-N-grounded.png`: ready/glide/push, wrist, receive, contact, poke, shoulder, stop and recovery blades now protrude beside the skate footprint; only the high slap windup retains a raised blade. The runtime importer selects this correction and retains the original PNG. The exact prompt and selected hash are in `prompts.json` under `runtimeNorthGroundCorrection`.

The importer uses explicit per-pose skate centers, scaling from the reference helmet-to-skate body height. Source rectangles, absolute source foot/blade anchors, runtime pivots and blade markers are in `runtime-extraction.json`. Blade anchors are authored visual guides, and the debug view shows the sprite blade marker in pink and authoritative control anchor in green. Generated directional foreshortening and discrete key poses remain visible; these anchors never move the authoritative puck.

The ice reference preserves the recognizable arena composition. Only its floor should be masked into the existing renderer; unchanged-looking generated masonry is not a pixel-exact replacement for existing foreground assets. The generated puck is normalized to one rigid 12×8 frame shape. Code-native rink lines use the registered world projection; runtime browser screenshots verify the complete composition. The VFX use softer alpha than athlete silhouettes; do not apply the athlete alpha threshold indiscriminately to fading spray.

## Runtime import and evidence

Run from the repository root:

```sh
.venv-assets/bin/python scripts/game-assets/import-cryptball-hockey.py
.venv-assets/bin/python apps/cryptball/art-src/hockey-v1/inspect-sources.py
```

The importer writes `public/assets/cryptball-hockey/manifest.json`, three packed 1024×1024 pages and licenses. Current output is 781 frames, 771 clip aliases and 2,499,873 runtime bytes (about 2.38 MiB downloaded) (12 MiB decoded RGBA). All six team palettes share these pages; team-specific page loading is not supported by the existing atlas loader. Hockey pages are leased only when this mode is selected.

The 116 base runtime athlete poses use 112×80 frames; twelve diagonal contact overrides use 112×96 bounds so forward ground blades have room below the skates. Every pose keeps the same foot pivot (56,70), and the base reference standing body is 44px high. Enlarging frame bounds does not change world foot registration. Complete connected figures retain their full sticks, including sticks crossing source grid boundaries. Shared extraction/packing helpers are also used by the previous sports importer; its five output files were SHA-256 byte-identical before and after that refactor.

Generated native-scale evidence:

- `runtime-contact-sheet-1x.png`: every pose and authored direction.
- `runtime-contact-sheet-3x.png`: nearest-scaled inspection copy.
- `runtime-team-comparison.png`: six material palettes across all eight facings.
- `runtime-animation-proof.gif`: key-pose progression across all directions and palettes.
- `runtime-extraction.json`: exact source rectangles, authored anchors, scaling and source hashes.
- `runtime-qa.json`: bounded frame extents, binary athlete alpha, atlas counts and memory.

The runtime uses wrist/pass, slap, poke and shoulder semantics from authority timing and confirmed contact receipts. Push and stop cues are bounded semantic events; coasting uses a glide pose. Puck contact never invokes rolling/squashing frames. Reduced motion freezes puck scuffs, suppresses sprite spray and moving trails, and retains short static contact/stop cues. Audio uses the existing synthesizer for skate scrape, woody stick tick, muted rubber board knock and a restrained two-note goal cue; confirmed receipt identities prevent replayed audio.

Source inspection preserves fourteen generated PNGs: the original ten planning assets, selected north correction, grouped diagonal contact correction and final SE/SW contact sheets. Thirteen generated sources contribute to the runtime atlas; the original north remains preserved but unselected. Four derived edit-guide composites and one unselected broad attempt are retained separately for provenance and excluded from source-count/runtime checks. `source-manifest.json` marks selected source files. The old `component-extraction.json` is the planning snapshot; the current importer records its selected-source extraction separately in `runtime-extraction.json`.

A test-only real-contact scene is available at `/games/cryptball/tests/hockey-visuals/` when the Cryptball Vite server runs. `await window.hockeyVisualFixture.show({direction:'N',kind:'slap',reduced:false,debug:true,age:0,scale:1})` renders the captured contact tick at native 640×400. Eight directions × wrist/slap/poke are validated by `hockey-visual-fixture.test.ts`; these setups restore a validated practice checkpoint, then use real inputs and require an actual `puck-contact` receipt. They do not invent contact events or move the puck to match the sprite.


## Final contact correction and visual limits

The twelve overrides replace `wrist-contact`, `slap-contact` and `poke-check` in SE, SW, NW and NE only. NW/NE use the last two columns of the grouped 4×3 correction; SE/SW use their final 3×1 per-direction sheets. The first two grouped columns are preserved as superseded source variants. `manifest.json` provenance includes the explicit twelve-entry override mapping, and `runtime-extraction.json` records each source rectangle, authored skate anchor, blade guide and expanded frame size. The original directional sheets remain intact.

The final native screenshot matrix contains 48 normal/reduced contact captures and three double-size debug views in `docs/evidence/cryptball-hockey-2026-11-04/visuals`. Representative frames across all eight facings were visually reviewed. The frozen rink floor mask is pixel-identical to the registered polygon, retains the existing architecture/goals/foreground, and gives the dark puck clear contrast. Final SE/SW blade corrections visibly improve contact reach while preserving coherent grip/pose anatomy.

These remain discrete generated key poses. The puck has already traveled roughly 4–6 world units by the end of the authority contact tick, so a rendered receipt frame can show a small gap after release. North and other back-facing ground contacts can be obscured by the skater's body; the outlined puck locator/contact cue preserves visibility. The visible far-side blade tip and authored cosmetic anchor are approximate in foreshortened poses. Neither the renderer nor the fixture moves the authoritative puck to meet the art. Human playtesting and hand-cleaned animation inbetweens remain future polish.
