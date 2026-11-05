# Cryptball polished source kit

Generated 2026-11-04 with the built-in image generation tool from the user's approved reference. These are project-owned copies of generated source images, not a finished runtime atlas. No gameplay, roster or current preview changes were made in this pass. Exact prompts are in `prompts.json`; image dimensions and measured alpha coverage are in `manifest.json`.

## Files and inspection

| File | Content | Inspection / remaining work |
| --- | --- | --- |
| athlete-directions.png | Eight neutral athlete views, 4 by 2 | Requested N, NE, E, SE / S, SW, W, NW in screen space. Views are broadly correct; diagonal separation, bat hand consistency and foot anchors need normalization. The 1774 by 887 output is not an evenly divisible four-column atlas. Do not blindly slice uniform cells. |
| athlete-actions.png | Twelve key poses, 4 by 3 | Ready/run, strike, slide/recovery. One facing only; these are key poses, not a seamless run cycle or all-direction animation. Repeated ready poses are intentional. |
| arena-empty.png | Full empty arena composition | Closest complete architectural direction; useful layout reference or static backdrop. Its painted lines are not collision geometry. |
| court-floor.png | Isolated trapezoid floor | Register four corners to the render projection. Boundary and arc shapes are illustrative, not exact simulation dimensions. |
| back-stands.png | Isolated architecture strip | Empty terraces allow a separately animated crowd. Contains baked torch flames; mask/replace them when adding flame animation to avoid doubling. |
| crowd-props.png | Four crowd groups, pennants, torch, brazier, ball, dust, wall, statue | Crowd details are brighter than ideal: reduce contrast for background use. Groups are pose variants, not a temporally coherent cheering cycle. Props require individual extraction. |
| goal-pair.png | Two team goal assemblies | Useful material/design source, but too front-facing for left/right end-wall planes. Redraw/reproject these to the locked camera before use. Split grilles/posts for ball occlusion. |

Transparent PNGs contain genuine clear pixels, but most interior alpha is approximately 250–254 and the edges have soft/fringed alpha. The initial action sheet visually appeared to have a backdrop; alpha inspection confirms clear areas, and the cleanup variant is saved here. None passes a strict opaque-interior/binary-edge pixel-art gate yet. Preserve soft alpha only for intentionally glowing effects, not athletes or stone. No manual pixel cleanup is claimed.

## Design recommendation

Return the primary mode to 2v2 with no dedicated keepers; retain committed field slides for saves. Keep the enlarged court initially so roster and court size are not both changed during the first comparison. If movement becomes empty, reduce geometry after a controlled human playtest. Six players plus much broader athletes will exacerbate occlusion. The previous bot sweep cannot prove a preference either way.

The current keeper AI has a concrete suspect in `sim/keeper-ai.ts`: it selects a forecast point within a broad danger band, then always chooses one lateral dive direction. A centered incoming ball selects the positive direction; there is no explicit hold-position branch when the body already covers the shot. The selected point is not necessarily the exact keeper-plane crossing. This is a code-based hypothesis consistent with the reported behavior, not a newly reproduced diagnosis. A future keeper mode should compare predicted miss distance with standing reach, hold central saves, and dive only for reachable lateral misses. Do not spend the next art pass tuning an unwanted role.

## Camera and visual hierarchy

The present `src/projection.ts` uses a rotated isometric transform with depth 0.55. The reference uses a centered elevated frontal composition: goal-to-goal movement is horizontal; far and near sidelines are level; side walls converge mildly. Changing a rotation constant alone cannot align independently painted perspective layers.

Lock a single presentation transform before fitting assets. Prefer a mild trapezoid mapping of the rectangular simulation court, with an inverse for mouse aim. Map the floor corners and goal lines to that transform; leave deterministic world physics unchanged. Use the same transform for feet, ball, effects and aim. Keep athlete scale constant initially for readability, with a separate vertical screen offset for airborne motion. Validate visual/collision agreement at all four corners, both posts and midfield. Ground shadows attach to projected feet, and actors sort by projected ground depth.

Prototype at 640 by 400 with standing athletes around 40–48 pixels tall; these are trial values, not accepted final dimensions. Retain integer display scaling where possible. A larger canvas alone cannot create polish. The new silhouette needs broad shoulders, bent knees, exposed arms, visible leather and a readable bat, replacing the current narrow upright proportions. Compare at native gameplay size, not only enlarged source-sheet size.

Make the architecture wrap the playing area. Use layered warm stone bevels over cool purple shadows; keep the playing surface quieter than the actors. Put spectators in the back and side terraces; use a low dark foreground crowd below the near boundary so it does not hide feet or the ball. Limit crowd animation to occasional small gestures. Keep the ball's bright center and short trail unique; torch glow stays at the perimeter. Put the scoreboard in a dedicated top margin.

## Production sequence

1. Lock camera, court quad and four-player composition. Build a static composition proof at target resolution using these sources; check empty space and near-wall occlusion.
2. Clean one neutral athlete to a consistent native pixel grid and palette, then normalize all eight views with explicit frame rectangles and foot pivots. Keep visual direction separate from physics headings. Handedness and emblems must not flip accidentally.
3. Finish one facing's idle/run/strike/slide/recovery and preview it as animation. Then extend each action to all eight views, using these key poses as reference. Suggested starting counts: idle 4, run 6, strike 5, slide 4, recovery 3 = 176 frames per base athlete. Map pose phases to simulation timing rather than one frame per tick. Do not generate an enormous sheet and assume frame consistency.
4. Apply a controlled teal-to-ember material palette swap to the cleaned base, retaining skin/leather/metal ramps. No independent orange character generation is required.
5. Fit floor, back architecture, side walls and goals to the camera. Split front goal posts/grilles and near parapet from background for correct occlusion. The generated wall prop is a material source, not a verified seamless tile.
6. Extract and clean crowd groups, ball and props. Author coherent short flame/dust/cheer cycles; keep shadows and impact effects separate from player frames.
7. Pack normalized atlases with explicit metadata. Validate pivots, frame dimensions, alpha, palette, clipping, direction identity and seams where intended. Human inspection must check silhouette and motion; automated structure checks cannot certify either.
8. Integrate 2v2 as a versioned roster change across simulation, checkpoints, matchmaking, pass selection and lobby; rerun determinism/network/browser checks. Compare readability and fun in actual movement before producing more decoration.

The kit establishes the visual direction and reusable component sources. Outstanding production work includes exact slicing, cleanup, complete directional animation, coherent crowd/effect cycles, goal-angle correction, layer registration, runtime integration and playtesting.

## Runtime integration pass

The polished runtime importer is now `scripts/game-assets/import-cryptball-polished.py`; `npm run assets:cryptball` invokes it. The active full arena is `arena-runtime.png`, a generated edit that preserves the composition and ambient torch lighting while removing painted flames and replacing the giant decorative goal grilles with stone. Only the registered simulation goal mouths are visible in play. `arena-unlit.png` remains the intermediate historical edit with decorative grilles. Separate generated flame frames animate over its empty braziers. `arena-empty.png` remains the original reference, not the animated runtime backdrop.

New facing-specific inputs are `action-E.png`, `action-SE.png`, `action-S.png`, `action-SW.png`, `action-W.png`, `action-NW.png`, `action-N.png` and `action-NE.png`. Each sheet is four columns by three rows: idle/run A/run B/run C; run D/strike windup/strike contact/strike follow-through; slide entry/slide active/recovery low/recovery up. The flame source is `fire-frames.png`, four columns by two rows. Exact source hashes and extraction coordinates are written by the importer rather than assuming every generated image meets a pixel-perfect grid.

Runtime extraction records are in `extraction.json`; actual native-size sheets and structural checks are `runtime-contact-sheet.png`, `runtime-contact-sheet-2x.png`, `runtime-fire-sheet.png`, `runtime-goal-post.png`, `runtime-arena.png` and `runtime-qa.json`. The four `crowd.polished.*` textures are tinted static pose variants; no coherent cheering animation is claimed. Small ball/UI/contact effects retain their earlier original code-authored provenance. The previous procedural athlete generator is not a fallback for missing generated inputs: the active build fails if a facing sheet is absent.
