# Cryptball polished 2v2 delivery

Implemented locally on 2026-11-04 with three GPT-6.1 Sol agents under root integration and visual review. Existing dirty/untracked work was preserved. No commit or external deployment was made.

## Result

- Four field players, two per team; no dedicated keepers or six-seat private-room option. Public/private room admission, bot fill, takeover and reconnect use four stable seats. Slides remain. The larger 332×192 court remains so the roster change can be evaluated independently of another size change.
- Versioned protocol 3 and checkpoint/config 4 reject incompatible older matches atomically. Dormant keeper primitives remain internal code, not accessible primary-match roles.
- Native 640×400 frontal arena with a shared mild-trapezoid projection and inverse input mapping. CSS uses available window space instead of dropping to an unnecessarily small integer scale. Floor corners and physical goal posts are registered to the same projection.
- Generated armored athlete source art replaces procedural player pixels: eight distinct screen facings, twelve source poses per facing, 96 base poses. Teal and ember uniform variants share skin/leather/highlight materials. Idle, four run phases, strike anticipation/contact/follow-through, slide entry/active and two recovery poses supply the runtime action clips. Some gameplay actions deliberately reuse these poses; this is not 96 independent full animation sequences.
- Generated arena architecture, extracted terrace spectators, registered scoring-goal assemblies and eight animated fires. Painted flames were removed from the base artwork; oversized painted decorative grilles were also removed so they do not compete with actual scoring mouths. The crowd uses static pose groups, not an advertised crowd animation cycle.
- Eight generated flame frames play over fixed wall-torch and brazier anchors. Rear flame height leaves the scoreboard clear; foreground flames render above foreground masonry.

## Asset production and review

Sources and exact generation prompts are in `apps/cryptball/art-src/polished-v1/`. Built-in image generation was used, followed by deterministic atlas extraction, normalization and palette processing. Rear diagonal and southwest sheets were regenerated after visual inspection caught direction drift. Whole-figure extraction fixes poses that cross nominal source-sheet cell boundaries. Athletes have binary alpha, one shared base palette and fixed foot pivots; source hashes and actual extraction bounds are recorded.

`npm run assets:cryptball` builds 324 frames / 1,263 clip mappings in two atlas pages. The untrimmed athlete frame is 112×72, pivot (56,64), standing body height 44 pixels; the wider transparent canvas prevents extended bats and slide poses from clipping. Runtime atlas trimming avoids paying for the entire transparent frame area.

Review evidence includes `runtime-contact-sheet.png`, `runtime-fire-sheet.png`, `runtime-arena.png`, `runtime-qa.json` and `extraction.json` in the source kit. The contact sheet was visually inspected for all eight facings and action poses. Structural validation cannot certify perfect anatomical or temporal consistency; these remain generated, normalized game sprites rather than a hand-polished pixel animation production.

## Validation

- Unit suite: 49 tests passed after the roster migration; presentation/projection checks additionally cover registered corners, post round trips and animation selection.
- Network suite: 16 tests passed with the optional full-match run separately enabled. All five real-time socket tests passed, including complete 2/3/4-human matches and private-room reconnect.
- Node, Chromium, WebKit and Firefox: 12,090 checkpoint hashes agree across complete two-human-plus-bots and four-human reconnect scenarios. Replay p95: Chromium 2.1 ms, WebKit 2.0 ms, Firefox 3.0 ms, below the unchanged 4 ms aspirational target and 16.67 ms hard budget on this machine.
- TypeScript, game-boundary and simulation-purity checks passed; the repository's 186 existing unrelated purity-baseline diagnostics remain unchanged.
- Production browser proof verifies four actually rendered athletes, loaded atlas pages, all eight directional action mappings, keyboard play, pause/resume and a changing isolated flame crop. The flame check uses images 170 ms apart, excluding player motion from its selected region.

Final browser regression passed all four flows: solo controls/pause/fire proof; two-human online recovery; four-human auto-start plus fifth-player admission; private four-seat reload. The final flame crop changed 15.63% of material RGB pixels in 170 ms (1.5% minimum). Actual screenshot and fire captures are in `docs/evidence/cryptball-polished-2v2-2026-11-04/`; online screenshots are under `docs/evidence/cryptball-online-2026-11-04/`.

The default production client and server were rebuilt as `cryptball-v1-3522a4192cbb946edb89a1d1`. The prior server was gracefully replaced on localhost:2567. The existing preview at http://127.0.0.1:4224/games/cryptball/ serves the updated output. Root independently opened that preview, joined the four-seat online lobby, then played solo and inspected the rendered arena, four athletes, crowd, goals and flames. The preview and match server remain running.

## Limits

The three-seed bot smoke run reports 11.51 goals/minute, 21.86% empty-running proxy and 32.17% slide interception. These are diagnostics, not a verdict on fun; humans still need to evaluate passing, defensive commitment and the court size. Eight-direction visual quantization remains independent from fine simulation headings. Generated animations can still benefit from manual frame-by-frame refinement. The current task does not claim that the game is visually identical to the much larger art-direction illustration.
