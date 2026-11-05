# Crypt Dodge / Crypt Guardian art package

Generated November 5, 2026 using built-in ImageGen, referenced against the existing weapon-free teal athlete. This directory preserves the **source and review package**. The separate installed runtime atlas and its importer are documented below. The complete rules, balance hypotheses, engine mapping and work breakdown are in [the mode plan](../../../../docs/cryptball-dodgeball-arena-plan-2026-11-05.md).

## Delivered

* `athlete-front.png`: columns E/SE/S/SW; eight action rows.
* `athlete-back.png`: columns W/NW/N/NE; eight action rows. The original incorrectly faced right in the two left columns. The selected revision corrects those directions; the rejected source is preserved as `athlete-back-direction-rejected.png` and is excluded from extraction.
* Athlete rows: catch-ready, catch-contact, carry, overarm throw windup, throw release, follow-through, underarm pass release, hit recoil. Total **64 new athlete key poses**. Ball is overlaid separately at runtime.
* `guardian.png`: **16 south-facing boss poses**, row-major: idle A/B, wake, roar; ranged tell/aim/recoil/recover; melee tell/sweep/slam/recover; hit/stun/defeat/rubble. The guardian stays at the north wall; this is not an eight-direction boss kit.
* `equipment.png`: **16 objects/variants**, row-major: cannon/hook/maul/crown; intact pillar/cracked pillar/rubble/closed gate; ball spin A/B/squash/stretch; boss bolt/chain segment/impact/soul marker.
* `frames/`: **96 extracted transparent PNGs**, with source coordinates, hashes, normalization scales and pivots in `manifest.json`. Athlete canvases are 112×80, pivot (56,70), about 44px standing height. Guardian canvases 160×128, pivot (80,112), about 78px standing height. Object frames use 96×96 review canvases; runtime should trim while preserving pivots.
* `manifest.json`: **35 clip sequences**: catch, throw, pass and hit for all eight directions; guardian ranged, melee and defeat. These are frame order definitions; gameplay timing must come from authoritative action phases. The melee proof enumerates sweep and slam rather than claiming they are one attack.
* `animation-proof.gif`: looping eight-direction action and guardian pose review at 2× native pixels; **not gameplay footage**. This is a pose-coverage proof, not the final animation timing.
* `all-frames.png`: native-size overview of every extracted frame. `equipment-native.png`: object readability sheet.
* `ui-kit.svg`: original editable vector design sheet with reusable life/empty/out/target/revive symbols, HP bar, possession timer, lane/disk/arc telegraphs. Runtime warnings must derive from simulation geometry, not use a fixed-size screenshot.
* `prompts.json` and `correction-prompt.json`: exact generation requests, reference and tool provenance. No CLI/API fallback or external paid sprite pack was used.

## Reuse inventory

Existing `sports-v1` supplies idle/run and recovery; `dives-v1` supplies hands-first launch/flight/contact/push-up in eight directions. Reuse those assets without copying them here. Existing Cryptball art supplies arena stick strikes, charged hits, passes and celebration. Existing unmarked arena floor, stone architecture, crowd and fire cycle remain. The new gate is optional because the existing Volley closed-goal presentation may already suffice.

The guardian's weapon modules rotate/translate through authored sockets for hook extension and hammer attacks; the chain repeats between hand and hook. The soul marker uses a small bob/fade for down/out, without affecting collision. Ball spin alternates A/B; squash/stretch are cosmetic only. No extra bitmap frames are needed for vector health depletion, target-lock countdown, pillar collision, or particle decay. Team/boss palette variants should use material masks during runtime import; they are not delivered as pre-baked recolor sheets.

## Rebuild and QA

From repository root: `.venv-assets/bin/python apps/cryptball/art-src/new-modes-v1/prepare.py`.

The script slices authored row boundaries (the generated grids have nonuniform vertical spacing), preserves RGBA, resizes with nearest sampling, and writes all review files. It does not redraw anatomy or alter the game. Row cuts were adjusted after inspection found an adjacent-row fragment above the first pillar extraction. All four selected sources have genuine transparent and opaque pixels. All 96 output frames and all 35 sequence references are checked by the delivery validation; see `qa.json`.

Visual source review confirmed distinct actions, complete silhouettes, corrected W/NW directions and modular boss props. The equipment native-size review was inspected after row-cut correction. The full overview was inspected for missing/cropped cells. Neighboring E/SE athlete directions remain fairly close, and emblem details vary between generated sheets. Key poses will need in-game pacing and direction-transition review; they are not hand-cleaned inbetweens. The squat recoil is intentional, with the feet anchored.

Before shipping: author/check hand sockets per pose/direction; align weapon sockets across boss poses; apply and review constrained team/palette masks; pack an independent runtime atlas and update provenance; compare native and 3× clips on light/dark backgrounds; verify guardian scale/collision, pillar footprints, depth sorting, HUD readability and reduced-motion behavior in the real game. Review sprite pivots are normalized defaults, not proof of collision/weapon alignment. No claim of completed runtime integration or balanced gameplay is made.

Sound design is specified in the plan but no new audio recordings are delivered. Existing synthesis will generate the required cues during implementation.


## Installed runtime integration

The source kit is now packed by `scripts/game-assets/import-cryptball-new-modes.py` into `public/assets/cryptball-new-modes/manifest.json`: **448 runtime frames on two nearest-sampled pages**, using all 96 selected source frames. Athlete variants use the existing constrained teal material mask for six teams; guardian variants recolor purple armor only for three palettes. Skin, ivory armor, weapon metal and orange fire remain separate from those masks.

Each of the 384 directional athlete variants has an authored hand socket. All 48 guardian palette/pose variants have weapon and crown sockets, and each of the three weapon modules has a grip anchor. Sockets use the original normalized frame coordinate system and survive trimming. Held Dodge balls use the sampled hand socket; hands-first dive saves use explicit directional leading-hand offsets. The guardian layers its weapon at the sampled pose socket, aims cannon/hook modules, extends a repeated chain, and draws slam impacts from authoritative floor disks. Cover scales to its projected collider width. Sprite sockets are cosmetic and do not change authoritative collisions.

Runtime reuse is explicit: weapon-free idle/run and hands-first dive/recovery come from the existing sports atlas, while Guardian strikes use the established bat-bearing Cryptball atlas. Dodge catch/carry/windup/release/follow/pass/recoil use the new atlas. Guardian wake, two idle poses, roar, ranged and melee phases, hit flash, stun, defeat and rubble are integrated. The terminal result remains authoritative immediately; a bounded 1.5-second presentation finale plays before the victory results menu.

Rebuild with `.venv-assets/bin/python scripts/game-assets/import-cryptball-new-modes.py`. `runtime-qa.json` records structural coverage. `runtime-sockets-1x.png` and `runtime-sockets-3x.png` provide light/dark socket review. The development-only `tests/new-mode-visuals/index.html` fixture selects resolved seeded appearances and renders the actual simulation's locked attack shapes at native or 3× size. Its defeat/revive settings construct explicit visual review states; they are not gameplay-success evidence. Production browser tests exercise actual selection, match/practice entry, controls and atlas readiness.

Generated key poses remain discrete poses rather than hand-cleaned inbetweens. E/SE similarity and emblem variation from the source package remain. Human play sessions, mobile hardware review and balance tuning remain required; source or atlas validation does not establish gameplay quality.
