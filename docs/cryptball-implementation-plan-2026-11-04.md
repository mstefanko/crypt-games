# Cryptball — full implementation plan

Date: 2026-11-04. Status: implementation candidate delivered locally; finished-demo and human playability acceptance remain pending.

Follow-on: [Online multiplayer, game feel, and pixel-art implementation plan](cryptball-online-and-polish-implementation-plan-2026-11-04.md). It adds the researched 2026 networking stack and supersedes this candidate's online-play/snapshot exclusions for that next phase. This document remains the record of the original demo scope.

Research baseline: `6b1136dd1f3f0e59a6ccb20beee7f2a2eb84efa7`, plus the existing dirty working tree inspected on this date. Museum and Wrecklight changes were already present; do not reset, stage, or attribute them to this plan.

**This is a demo.** Spend effort on feel, art, animation and sound. Keep testing to the small set listed in §11; do not build qualification, replay, or snapshot infrastructure.

## 0. Handoff summary (read first)

**What to build:** a single static web game at `apps/cryptball/`, modelled on `apps/wrecklight-works/` (same host/session/presenter split, same config style). One court, 2v2, 90-second match, title → practice → match → results → rematch.

**Prerequisites**

| Need | Detail |
| --- | --- |
| Node deps | `npm install` at repo root (Vite, Vitest, Pixi, Playwright already present) |
| Python for asset import | Python 3 with Pillow. System `python3` has no Pillow: `python3 -m venv .venv-assets && .venv-assets/bin/pip install Pillow`. Existing importers (`scripts/game-assets/build-wrecklight.py`) use the same dependency |
| Source archives (local only, never committed) | `~/Documents/GameAssets/Lords of Pain/Lords Of Pain - Old School Isometric Assets.zip` (athletes, props, VFX); `~/Documents/GameAssets/Dead Revolver/Dead Revolver Typeface.zip`, `Pixel UI & HUD.zip`, `Pixel PC Controller Pack.zip` (font, panels, key prompts); `~/Documents/GameAssets/Penusbmic/Dark Flames FX Pack.zip`, `Fire Element 1.1.zip` (torch/goal fire). Check each pack's license before shipping its pixels; record it in the manifest |
| Art tool | Aseprite (or equivalent) for hand-authored court, goals, crests, orb, HUD, and frame cleanup |

**Commands to add in C0** (copy the Wrecklight pattern in `package.json`):

```text
dev:cryptball          vite --config vite.cryptball.config.ts --host 127.0.0.1   (port 4223)
build:cryptball        vite build --config vite.cryptball.config.ts               (→ .local-game-tests/cryptball/, base /games/cryptball/)
test:cryptball         vitest run --config vitest.cryptball.config.ts
test:cryptball:browser playwright test --config playwright.cryptball.config.ts    (one smoke spec)
assets:cryptball       .venv-assets/bin/python scripts/game-assets/import-cryptball.py
```

**Done means:** the §11 finished-demo checklist passes on a production build, played by a person with keyboard/mouse and sound on. Locked numbers live in §2 and §5; open decisions are only the three C0 items in §12.

**Order of work:** two tracks from day one. Track A (code): C0 → C1 → C2 → C4. Track B (art/audio): asset import and art production start in C0 and run alongside, merging into C3. Art is the long pole; do not leave it until gameplay is done.

## 1. Product decision

Build a complete, compact **2-on-2 arcade stickball game in a dungeon stadium**, with an always-visible shallow isometric court. A player directs one team against two computer opponents. Weapon swings propel an orb; quick passes, bank shots, dashes, and interceptions create the sport. One arena, one balanced roster, one 90-second match, immediate rematch.

The target is the completeness and readability of a good SNES sports game: a finished title screen, distinct teams, animated players, textured court, recognizable goals, crowd response, music, useful HUD, and decisive match endings. This is an aesthetic target, not a claim of authentic SNES hardware limits. No flat-color debug arena in the delivered demo.

**Three promises:** a satisfying strike within ten seconds of starting practice; readable play at the native resolution; a reason to immediately play another match.

Scope deliberately excludes online multiplayer, local multiplayer, tournaments, equipment, character stats, progression, airborne ball physics, refereeing/fouls, lethal combat, interior hazards, and a second arena. These can follow a successful game. Desktop keyboard/pointer is the initial supported input; keyboard-only must also work. Gamepad is a later separately tested adapter, not an assumed engine feature.

### Recommended play model

- Ball is always free-moving. No inventory possession, catching animation, hand attachment, or invisible magnetic leash.
- Walking into a slow ball nudges it forward. Swing to make a deliberate shot; use the dedicated pass action to aim toward a teammate.
- Players physically block and deflect the ball. Fast balls do not damage or stun players.
- Dash doubles as a brief shoulder check. One short stagger can open a lane, but repeated stun-locking is forbidden.
- Control switches manually with Q, and automatically to the receiver after a successful deliberate pass strike. No automatic switching merely because another player is closer to the ball.
- No goalkeeper class: the off-ball defender protects the goal lane but must also participate in play.

This avoids requiring catch/throw/tackle clips we do not own and makes the existing melee animation the central sporting motion.

## 2. Camera, coordinates, and court

### Decision: shallow dimetric view, entire court in frame

Use an orthographic 2D projection, with the court's long axis rotated **22.5 degrees in the ground plane** and ground depth compressed by **0.55**. Its visible long-axis slope is approximately 12.8 degrees. This produces a left-high to right-low court with visible floor and upright sprites. It is less steep than a symmetric 45-degree diamond, leaving more horizontal room for sports play.

The sprite pack's exact source camera is not documented in the inspected material. The chosen compression is a design starting point supported by visual inspection, not a recovered camera calibration. Permit a bounded C0 comparison at depth factors 0.50, 0.55, and 0.60; select one and pin it before finalizing court art. The same scene must include north/south motion, all facing directions, a goal opening, and ball contacts.

| Alternative | Benefit | Why it is not the default |
| --- | --- | --- |
| True top-down | Maximum geometric clarity | Weak match for upright, pre-rendered directional characters; less stadium character |
| Symmetric 45-degree diamond | Familiar isometric look | Long field occupies too much vertical space and forces smaller actors or scrolling |
| Shallow rotated dimetric, fixed | Shows both goals, preserves actor size, supports bank-shot planning | Requires explicit inverse input mapping and careful foreground handling; selected |
| Following/zooming camera | Larger individual players | Hides passing targets and creates moving aim coordinates; unnecessary with four players |
| Perspective/Mode-7 ground | Strong spectacle | Inconsistent with fixed source views and sports depth judgments; separate future experiment |

### Concrete projection

Native framebuffer: **384 × 256 logical pixels**. Author HUD and art on that grid. Court coordinates use world pixels and are converted to the engine's 256 fixed units per world pixel in authority.

For centered court coordinates `(u, v)`:

```text
theta = 22.5 degrees
screenX = 192 + cos(theta) * u - sin(theta) * v
screenY = 154 + 0.55 * (sin(theta) * u + cos(theta) * v)
```

Implement with public `projectIsometric` / `unprojectIsometric` composed with a -22.5-degree ground rotation, `tileWidth = sqrt(2)`, and `tileHeight = sqrt(2) * 0.55`. This gives the formula above without a second projection library. Store projection constants in one game-owned view recipe. The inverse must undo origin, isometric mapping, then the ground rotation.

- Gameplay geometry remains an ordinary rectangle in `(u,v)`; no collision math operates in screen coordinates.
- WASD/arrows represent screen directions. Invert projection for a requested screen vector, then normalize in world space. Up must move visually upward, not along a surprising diagonal grid axis. World speed remains isotropic; vertical screen travel is naturally foreshortened.
- Pointer aim converts client → logical framebuffer → court coordinates. Quantize authoritative aim to 256 directions; 16 art headings are a separate presentation choice.
- Select sprite direction from projected facing, using a measured source-heading lookup. Do not assume directory compass labels equal screen angles. Pin the lookup after the eight-direction visual check.
- Sort actors and posts by projected **foot Y**, then stable entity ID. Do not use the stock unrotated `feetDepth(u,v)` blindly.
- Camera stays fixed during live play. At most one logical pixel of optional impact shake; default no shake during pointer aiming. Goal celebrations may use a 2-pixel shake. Reduced motion removes both.

### Court geometry

Court interior: `u ∈ [-144,144]`, `v ∈ [-80,80]` — **288 × 160 world pixels**. There is ample room for four 7-pixel-radius player bodies while their upright sprites remain around 34–44 logical pixels tall.

| Feature | Geometry / rule |
| --- | --- |
| Side boards | `v = -80`, `v = +80`; ball radius and actor radius are inset for collision |
| End boards | `u = ±144`, except the central goal opening |
| Goal opening | `v ∈ [-26,26]`, 52 pixels wide on each end |
| Goal recess | Extends to `u = ±156`; ball-only playable pocket; visible net/back wall |
| Goal posts | Radius 3 at `(±144, ±26)`; fixed circles; identical on both ends |
| Scoring threshold | Goal line is `u = ±144`; whole-ball crossing occurs when the center crosses `u = ±147`, with center `v ∈ [-23,23]`, before any earlier post/wall contact |
| Actor end boundary | Players stop at their radius-inset `u = ±144` boundary, including the goal opening; they never enter the pocket |
| Markings | Center line, center emblem, goal arcs, subtle lane inlays; all are non-colliding |
| Interior obstacles | None in release one. Bank shots use boards; decorative pillars stay beyond the playable surface |

Projected floor corners are approximately `(90,83), (356,144), (294,225), (28,164)`. Goal recesses still fit within the native frame. Reserve HUD `y=0..25`; keep tallest near-court actors and decoration below it. Keep bottom scenery low enough not to cover the near board. See [camera/layout diagram](cryptball-planning/court-layout.svg) ([PNG](cryptball-planning/court-layout.png)). The diagram's corner positions match the formula above (checked 2026-11-04). It shows geometry only. Goal positions and court framing are the initial implementation target; the figures, posts and nets are placeholders.

Court floor is medium-value desaturated blue/slate, bordered by warm sandstone. Team A is cyan/ivory, team B coral/gold. Orb is bright pearl with a dark outline. The brightest object in live play is always the orb or its brief impact, never a torch.

### Rendering and scale

Render at an actual fixed 384×256 backing resolution, then upscale by the largest integer factor fitting the available area, with nearest-neighbor filtering and centered letterboxing. Below 1×, show a deliberate fit-down mode and a larger-window hint; the supported play target is at least 768×512 CSS pixels. Preserve aspect ratio at every size and DPR.

`PixiStage.resize` currently enables fractional scaling and `imageRendering = auto`, with a DPR-aware renderer. It does **not** already provide this pixel pipeline. C0 must establish an app-local viewport adapter using public `stage.app.renderer`, `stage.app.stage`, and canvas properties: set `stage.width = 384` and `stage.height = 256` for pointer mapping, set renderer resolution to 1, resize to 384×256, stage scale 1, set CSS integer display dimensions and `image-rendering: pixelated`. Do not call the normal resize path afterward. Verify `stage.pointer` remains correct against the displayed canvas rectangle. If public access proves insufficient, request the narrow viewport seam; do not silently ship blurred scaling.

## 3. Asset selection and art-production work

### Verified source and limitations

Primary archive: `/Users/mstefanko/Documents/GameAssets/Lords of Pain/Lords Of Pain - Old School Isometric Assets.zip`.

SHA-256: `85d208a201d5e8ec2a64b47ddacb6ca07c12b21a55d9ad80c064572efb9bfbdc`.

The [planning audit](cryptball-planning/asset-audit.json) records exact direction coverage. Warrior and knight each have 16-direction armed idle (one frame/direction), armed walk (eight), armed attack (eight), and select (eight). Fighter has the same coverage but a smaller silhouette; reserve it rather than introducing unequal apparent body sizes. No run, dash, hurt, catch, or throw animation is claimed.

Source examples:

```text
playable character/warrior/warrior_armed_idle/E/warrior_armed_idle_E_0.0_0.png
playable character/warrior/warrior_armed_walk/<heading>/*.png
playable character/warrior/warrior_armed_attack/<heading>/*.png
playable character/knight/knight_armed_idle/<heading>/*.png
playable character/knight/knight_armed_walk/<heading>/*.png
playable character/knight/knight_armed_attack/<heading>/*.png
prop/column1/<heading>/*.png
prop/wall1/<heading>/*.png
prop/brazier/<heading>/*.png
environment/ground_stone1.png
environment/ground_variation1.png
environment/ground_variation2.png
```

Use source lists discovered from the archive, pinned in a manifest; the wildcard notation above describes selection, not the final importer contract.

Archive inventory verified 2026-11-04 (all 16 headings unless noted):

| Archive member | Frames | Cryptball use |
| --- | --- | --- |
| `*_armed_idle` / `_armed_walk` / `_armed_attack` | 1 / 8 / 8 | Idle, run, strike/pass/charge |
| `*_special_select` | 8 | Goal celebration, title-screen pose, results winner pose |
| `*_special_death` | 8 | **Frames 0–2 only** as the checked/stagger recoil (never play the fall) |
| `*_default_walk` (unarmed) | 8 | Not used |
| `vfx/swoosh` | 8 (one set) | Strike arc base; recolor per team, stretch for charged strike |
| `vfx/glint` | 8 | Charge-full sparkle, orb glint on spin |
| `vfx/flame`, `vfx/flames`, `vfx/glow` | 16 headings / 1 | Flame fixtures and additive glow under braziers (kept dimmer than the orb) |
| `prop/brazier_lit` | 8 per heading | Four stadium braziers, animated |
| `prop/torch`, `prop/column1/2`, `prop/wall1/2/3` | 1 per heading | Rear arches, stand walls, pillars beyond the court |
| `environment/ground_*` | 1 each | Stone texture base for the sandstone border, not the court floor |

The archive has no run, dash, catch or throw clip. Polish for those comes from the effect and timing work in §4, not invented frames.

**Important visual finding:** raw sprites are dark pre-rendered images, not finished SNES-style pixel art. Their 256×256 canvases contain tiny alpha values across much of the frame and baked ground shadows. A naive alpha bounding box includes nearly the entire canvas. Visual inspection used alpha >64 to locate subjects; that threshold is an inspection aid, not an approved production matte. The source art needs a deliberate cleanup and palette pass.

Local cropped inspection sheets live under `.local-game-tests/cryptball-planning/`. They are private planning references, not public template assets or final art. Keep purchased source archives and these reference sheets out of public engine distributions.

### Roster and team identification

Each team has one warrior and one knight with **identical gameplay statistics**. Different silhouettes make teammates identifiable without giving a hidden balance advantage. Prepare team-specific palettes for each archetype rather than tinting the whole sprite cyan or red. Preserve metal, skin, weapon, and shadow ramps.

- Team A: cyan cloth/trim, ivory highlights, diamond ground badge.
- Team B: coral cloth/trim, gold highlights, round ground badge.
- Controlled player: bright white segmented ground ring plus a small arrow above the head.
- Teammate: smaller team badge; pass target pulses once on pass input.
- Opponents: subdued badges, no flashing rings.
- Team, controlled-player status, and ball location must remain distinguishable in grayscale.

### Required deliverables

Team names are locked as **Ivory** (team A, human, attacks screen-right) and **Ember** (team B), matching the layout diagram.

Every row below is a required deliverable (not an assertion of existing files) under `apps/cryptball/public/assets/cryptball/`. "Source" says where the pixels come from: **import** = archive frames through the importer, **author** = new pixel art drawn at 1× on the 384×256 grid, **pack** = licensed third-party pack, cleaned and recolored.

| Asset | Source | Spec (1× logical pixels) | Animation |
| --- | --- | --- | --- |
| Athletes ×4 variants (warrior/knight × Ivory/Ember) | import | Body 34–44 px tall, cells trimmed with foot anchor | idle 1f; run 8f distance-driven; strike 8f; charge = held attack frame 1–2 with 2 px shiver; check recoil = death 0–2; celebrate = select 8f at 12 fps |
| Contact shadow | author | 14×5 ellipse, 2 tones, 50% alpha | Scales 90–110% with run phase |
| Team badges and control ring | author | Ivory diamond / Ember circle, 16×8; controlled ring 20×10 segmented white, rotates 1 segment/8 ticks | Arrow above head bobs 1 px at 2 Hz |
| Court floor | author | Single 320×192 tile-free painting in slate blue, low-frequency wear along lanes and center | Static |
| Border masonry | author + `ground_*` texture | Sandstone, 6 px rim, inset highlight on far edge, shadow on near edge | Static |
| Markings | author | Center line, 32 px center crest, goal arcs, team-color end tint | Ember/Ivory end tint pulses once on goal |
| Goals ×2 | author | Recess to u=±156, back wall, net overlay split into back half (behind actors) and front lip (in front) | Net bulges 3 frames on goal; ripples 2 frames on post hit |
| Posts ×4 | author | 6×10 low stone posts with team-color cap | Flash white 2 frames on contact |
| Orb | author | 8 px pearl, 1 px dark outline, 4 spin frames, 6×3 shadow | Spin rate tracks speed; trail 3–5 ghost dots; 5-frame impact star |
| Strike arc | pack (`vfx/swoosh`) recolored | Team-tinted, charged version 1.3× and brighter | 8f, plays on active ticks only |
| Effects | author | Dash dust (4f), check impact burst (5f), stagger stars (3 stars, 6f loop), pass ping ring (6f), goal burst (10f confetti + team-color flash), whiff swish lines (3f) | All on the bounded 128-particle budget |
| Stadium | import (`column`, `wall`, `brazier_lit`, `torch`) + author | Rear arches and stands above the far board; 4 braziers at court corners outside play; 2 hanging team banners per side; low near-side trim no taller than 12 px | Braziers 8f; banners 4f sway; crowd see below |
| Crowd | author | 3–4 spectator cluster sprites, ~24×16 each, repeated with phase offsets and palette swaps | Idle bob 2f; cheer 4f on shot near goal; big cheer 6f on goal; side of scoring team cheers harder |
| Font | pack (Dead Revolver `Game`/`GameCompact`) | Rasterize to a bitmap font at 1×; large numerals for score/timer | — |
| HUD | author + pack (Pixel UI & HUD panels) | 26 px scoreboard bar, crests 16×16, timer centered, dash wedge, charge meter | Score digit flips 3f; timer turns warm and pulses in last 10 s |
| Screens | author | Title logo (~200×60) over animated mini-court; pause/settings panel; results plate with winner celebration pose | Logo shimmer pass every 4 s; menu cursor bob |
| Key prompts | pack (Pixel PC Controller Pack) | WASD, J/K/L, Space, Q, mouse buttons | Pressed-state frame |

Court goals, crests, markings, orb, effects, crowd, and HUD are **new art work**; archive availability does not eliminate that work.

### Animation polish requirements (cheap, high-impact)

These are what make it feel finished despite the missing clips. Each is presenter-only and never changes authority.

- Run: shadow squash and 1 px body bob locked to walk frames 2 and 6; dust puff on direction reversal.
- Dash: 3 after-image copies of the current walk frame at 60/40/20% alpha in team color, plus dust; walk clip at 2× rate.
- Strike: 1-frame white flash on the athlete at contact; orb stretches 1 frame along launch direction; charged hit adds 2-frame screen flash at 25% only if reduced motion is off.
- Check: hit flash on victim, recoil frames, 2 px knockback ease, stars over head for the stagger duration.
- Orb: rotation speed proportional to velocity; outline brightens above 250 px/s; board/post impact star.
- Goal: net bulge, end-zone flash, goal burst, crowd cheer, scorer plays celebrate while others return to idle; scoreboard digit flip.
- Ambient life: braziers, banners and crowd always move, so the screen is never frozen while athletes are idle. Athletes themselves do not bob at idle (see §4). Author crisp pixel assets or rasterize original vector drafts to the pinned grid and manually clean the result. Do not stretch unrelated dungeon door art and call it a goal. The recess, end color, opening, and net response must communicate scoring without explanation.

### Import/cleanup pipeline

1. Read-only archive inspection; exact member list, hash, dimensions, and included license recorded. Preserve `Licence.txt` with provenance. Restricted art ships only as the selected game outputs allowed by its terms, not a reusable public asset pack.
2. Determine a stable foot anchor for every heading and clip. Begin inspection around source `(128,128)` but measure actual feet; shadows and weapon reach are not anchors. Retain source-space anchor metadata when trimming.
3. Define a common subject/matte policy across a full clip, remove stray low-alpha haze, and isolate or consistently retain baked shadows. Preferred output removes baked shadows and adds one uniform court-space contact shadow. Do not allow mixed double shadows. If clean separation is impractical, retain consistent baked shadows for all athletes and avoid adding another.
4. Apply a shared limited palette with distinct material ramps, brighter midtones, and small intentional highlights. Target 24–32 colors per actor variant; quantize the whole animation family, never independently per frame. Avoid random dithering and noisy outlines.
5. Team recolor uses reviewed material masks, not a global hue rotation. Preserve silhouette and weapon readability at 1×. Add only necessary one-pixel edge cleanup; do not sharpen every pixel indiscriminately.
6. Measure the subject body height on the 256×256 source canvases first (not yet measured; Pillow was unavailable during planning). If it is outside 34–44 px, apply **one uniform scale factor per archetype** to every clip and heading, before palette quantization, and record the factor in the manifest. Never resize headings independently to fit a bounding box. Weapon reach and shadows can extend beyond body height. Walk cycles must not slide or bounce from changing pivots.
7. Build atlases with 2-pixel extrusion/padding, `sampling: nearest`, stable frame IDs, original sizes, trim offsets, anchors, clip order, and authored durations. Frame count: 4 variants × 16 headings × 28 frames (1 idle + 8 walk + 8 attack + 8 select + 3 recoil) = **1,792 frames**. At a ~48×56 trimmed cell this is about 4.6 pages of 1024². Budget **six 1024² athlete pages** plus two for scenery/UI. If that is too much memory, drop the select clip to 4 frames before reducing headings.
8. Emit only selected game assets under `public/assets/cryptball/`, with an archive-to-output manifest and importer version/hash. Never ship vendor scripts or the original archive.
9. Play every direction/action on the actual court. Review unscaled screenshots, integer-scaled screenshots, a rotation loop, and movement/strike video. Direction completeness alone is not acceptance.

The art pass is mandatory for the requested look. If C0 cleanup does not produce readable athletes, resolve that before full-match development; do not relabel the raw dark pack as SNES polish.

## 4. Controls and animation contract

| Action | Keyboard/pointer | Keyboard-only behavior |
| --- | --- | --- |
| Move | WASD or arrows | Same, screen-relative |
| Aim | Pointer over court | Last nonzero movement direction; brief goal assist described below |
| Strike / charge | Left mouse hold/release or J | J hold/release |
| Pass | Right mouse press or K | K; targets teammate |
| Dash/check | Space or L | Same |
| Switch athlete | Q | Same |
| Pause | Escape | Same |

Suppress browser context menu only on the play canvas. Prevent scroll keys only when game input is active. Buttons and settings must remain keyboard focusable. A click on Resume cannot also strike the ball. Pointer cancel, blur, hidden page, and pause cancel held charge and require release before rearming.

Pointer direction wins only after real pointer movement while over the court. Otherwise keyboard facing remains usable; an old cursor location must not permanently override keyboard-only play. Aim is locked on strike release; movement may continue at the attack's speed multiplier. Pass direction is chosen when the pass action begins and does not home after contact.

Action arbitration: one athletic action at a time. Dash may cancel an uncommitted charge without firing it, but cannot cancel an active swing or its recovery. Pass may replace an uncommitted charge; it cannot interrupt a committed swing. Switching cancels an uncommitted charge, while a committed swing continues under its original athlete. If conflicting edges arrive on one tick, apply switch, then dash, then pass, then strike; consume lower-priority edges rather than queueing surprise actions. A charge cap and release on the same tick create only one swing. Record this order in tests.

Keyboard shot assist: if aimed within 12 degrees of the opponent goal center and the straight lane is clear under the shared collision queries, snap aim to that center. No assistance through players/posts, no auto-banks, no hidden curve after launch. Pointer shots are unassisted. Both modes retain manual bank shots.

### Animation states (60 Hz authority)

| State | Source / rendering | Initial timing and synchronization |
| --- | --- | --- |
| Idle | Armed idle, one frame | Static pose; no artificial full-sprite bobbing |
| Move | Armed walk, eight frames | Approx. 16 frames/sec at full run, distance-driven phase; stop phase on idle |
| Charge | Authored held windup from attack | Hold reviewed preparatory frame; small weapon sparkle, two-step meter near feet |
| Quick strike | Armed attack | 4 startup + 3 active + 9 recovery ticks; contact starts tick 4 |
| Charged strike | Same attack, stronger effects | 6 startup + 3 active + 12 recovery; charge hold is separate, up to 24 ticks |
| Pass | Same swing, reduced arc/impact | 4 startup + 3 active + 7 recovery ticks |
| Dash | Walk sequence accelerated, forward lean pose if usable | 10 active + 6 recovery ticks; short dust trail, no fabricated tumble |
| Checked | `special_death` frames 0–2 (recoil only), hit flash, stars | 10 ticks of limited control; frames 0→1→2→1→0 over 10 ticks; never show the fall |
| Celebrate | `special_select` 8 frames at 12 fps | Scorer only, during the 54-tick celebration; if a heading's select clip reads poorly, use the S-facing clip for all |

The inspected east-facing attack has preparation in early frames and a low extended weapon near frames 3–5. Author per-clip contact markers from all headings. The default `actionAnimationPhase` uses a generic 35–65% active span; use it only if the reviewed contact frames agree. Otherwise map shared `actionPhase` to the authored keyframes in the app. Collision must never wait for render playback.

Strikes have one action ID and a one-ball hit ledger using `claimActionHit`. Repeated rendering or multiple active ticks cannot strike the same ball twice. Switching control does not cancel or duplicate an existing swing. Walking clips cannot play underneath a full-body attack.

## 5. Rules, pacing, and initial tuning

All values below are implementation starting values, versioned together in `rules.ts`; they are not playtested balance claims. Store authority in fixed units, integer ticks, and rational remainders. UI values are derived.

| Parameter | Initial value |
| --- | --- |
| Live regulation | 5,400 ticks / 90 seconds; countdown excludes kickoff and goal celebration |
| Overtime | Sudden death, 1,800 ticks / 30 seconds; draw if still tied |
| Player radius | 7 world pixels |
| Ball radius | 3 world pixels |
| Run speed | 96 world pixels/sec |
| Acceleration / stopping | Reach full speed in 6 ticks; stop in 4 ticks; no slippery idle drift |
| Strike movement | 75% normal speed; charge 65% |
| Dash | 192 pixels/sec for 10 ticks; 6 recovery ticks at 75% speed |
| Dash reuse | 66 ticks from activation, no stamina inventory |
| Check consequence | 10-tick stagger, bounded 8-pixel total displacement, 36-tick check immunity after contact |
| Swing reach | Ball center within 19 pixels of athlete center and a 100-degree forward cone |
| Strike buffer | One request, 6 ticks; never unlimited automatic swings while held |
| Quick shot | 250 pixels/sec |
| Charged shot | Linear 250→350 pixels/sec over 24 held ticks; automatic release at cap |
| Pass | 210 pixels/sec, direction toward a capped teammate lead position |
| Ball drag | 30 pixels/sec², applied with fixed-point carry |
| Board restitution | 0.90; goal posts 0.85; player deflection 0.60 relative normal speed |
| Slow-ball nudge | At relative contact speed <100 pixels/sec, push along contact normal, capped at 90 pixels/sec; never attach |
| Rest | Below 8 pixels/sec set to zero; an athlete can still nudge or strike it |
| Visual ball trail | 3–5 historical points, at most 18 pixels; distinguish ball core from trail |

Only a dash contact checks an opponent; ordinary swings do not hurt athletes. Teammates cannot check each other. Dash hits at most one opponent per activation. A checked player cannot start charge/dash, but can steer at 35% speed. Strike is cancelled by a check before its active phase; an already active strike participates in the same tick's gathered resolution. Immunity is visualized briefly, not a flashing permanent aura.

Shots do not stop the simulation for hit-stop. Preserve ball continuity and sports pace; use 1–2 frames of visual impact emphasis without freezing authority or the match timer.

### Strikes and passes

- Input release creates a swing even when the ball is not immediately in range; the six-tick buffer applies only while the player is in a recoverable action state. Whiffing is a legitimate result and has a small air-swish cue.
- During the three active ticks, query ball reach/cone, claim one hit, and set its outgoing velocity along the locked aim. The launch is a velocity assignment, not unbounded additive impulse.
- If multiple swings contact in the same authority substep, resolve earliest contact, then smallest distance to the ball. An exact opposing tie produces a neutral clash: retain incoming tangential motion, cancel the opposed shot component, and emit one clash event; do not always favor player ID. Remaining ties on the same team use stable ID.
- Separate the ball to a valid non-overlapping point on contact using the shared query result, never teleport it through boards or posts. Near-wall strikes that would immediately hit a wall bank normally.
- Pass aims at teammate position plus at most 0.25 seconds of current velocity. Check the straight lane against board/post/player geometry; if blocked, still execute the pass toward that point and show interception naturally. No special pass immunity.
- A successful pass strike switches control to the intended teammate on the next tick and cancels the former controlled slot's held physical actions. The new athlete requires a fresh strike edge; held charge cannot transfer. The old athlete becomes AI support.
- A manual Q edge switches on the next tick with an 18-tick switch debounce. Q during an outstanding pass takes precedence and cancels the scheduled auto-switch. If the pass whiffs, no auto-switch.
- Player-body contact with a fast incoming ball deflects it; no invisible catch. The receiver can strike a moving pass immediately if timing and reach permit. AI uses the same rule.

### Goals and match flow

Initial flow: title → optional 20–30-second free practice → READY (60 ticks) → PLAY. Practice supports one player, a feeding teammate, both goals, and no opponent pressure; three concise prompts teach strike, pass, dash. It is skippable and replayable from the title.

Score only when the **whole** ball crosses the end-board goal line through the aperture: center reaches signed `u = 147` and remains inside radius-inset `v ∈ [-23,23]`, after accounting for earlier collisions in the same tick. Own goals count for the opposing side. Last-touch identity is diagnostic/celebration data, not a scoring requirement. Post contact tied with scoring-threshold crossing wins over scoring. A goal commits once and suppresses all later live events from that tick.

After a goal: 54-tick celebration plus 24-tick READY, then restart for the conceding side. Reposition everyone; zero velocities; clear actions, stagger, buffers, check immunity, and ball contact ledgers; restore dash availability. No long replay or compulsory cutscene.

For a left-side conceding restart: player nearest restart at `(-88,0)`, teammate `(-108,40)`, ball `(-70,0)`, opponents `(48,-20)` and `(92,35)`; mirror `u` for right-side restarts. During the first 60 live restart ticks or until the first deliberate strike, opponents remain in their own half. The restart team may move immediately. Show a small disappearing center-line seal during protection. Initial kickoff uses ball `(0,0)`, players at `(-48,-24),(-96,32),(48,24),(96,-32)` and no restart protection.

Process live goal contact before regulation expiry on its last tick: a shot that crosses within that tick counts. A ball still travelling at the horn does not gain extra time. Unequal score ends the match; equal score enters a 60-tick overtime READY and then sudden death. No mid-match side swap; the human team attacks screen-right for consistent learning.

Reset safeguards: an orb outside validated playable geometry is an error, not ordinary out-of-bounds play. Keep a recovery action in the pause menu for development. A shipping stuck-ball rescue is allowed only after four seconds with negligible displacement while players are actively trying to move it: short referee cue, reset to the nearest valid central restart with no score. Log the event; repeated rescues fail technical acceptance rather than being hidden as gameplay. An unattended resting ball is not automatically reset.

### Pacing targets for playtests

Treat these as observations to tune, not automated definitions of fun:

- New player lands an intentional strike within 10 seconds of practice.
- At least one credible scoring chance within the first 20 seconds of a match.
- Typical possession-like sequences last seconds, not long chase loops.
- Goal-to-control return is under 1.5 seconds.
- Target roughly 4–10 combined goals in regulation, with meaningful saves and interceptions; tune goal width and defense before increasing orb speed.
- Players can explain why a shot missed and where their teammate was useful.
- If most play is four actors clustering around the orb, fix AI spacing before adding hazards or powers.

## 6. Team AI

Use deterministic utility selection with small explicit states: chase/intercept, support, defend-lane, strike/pass, recover, restart. Four total athletes means a tactical graph is sufficient; do not add full RTS architecture. Prefer shared geometry and deadlines. Do not tick a navigation service solely to claim engine coverage.

AI plans every 6 ticks on staggered actor offsets, moves every tick, and retains a role for at least 18 ticks unless the ball changes team touch, crosses a danger threshold, or a goal/reset occurs. All decisions read the same start-of-tick observation. AI cannot inspect future human input or apply extra speed, reach, cooldown, or collision privileges.

### Role assignment

- Team coordinator selects one ball challenger by estimated intercept time, not just distance. The other becomes support or goal-lane defender.
- On the human team, the controlled athlete is never given AI steering. Teammate recognizes the human's current action: when human is approaching or winding up near the ball, stay open; when human is remote, chase and make a useful play.
- Defense: challenger pressures ball; partner stands between predicted ball position and own goal, normally 24–48 pixels in front of the line. Partner must not permanently camp inside the mouth.
- Attack support: target 35–65 pixels from challenger, preferably further toward the attacking end and on the opposite `v` side. Avoid crossing directly in front of an imminent shot.

### Interception, routes, and shot choice

Predict at most 45 ticks using the **same ball-motion code** on a detached copy, with static boards/posts and known current velocities. Planning budget is bounded; do not simulate all future AI policies. Select the earliest reachable intercept with a 6-tick reaction margin; do not require mathematically perfect interceptions.

Use direct steering where clear; otherwise evaluate a small authored graph of center, quarter-lane, and goal-approach points. Dynamic teammates/opponents are local avoidance costs, not permanent obstacles. Maintain at least about 20 pixels of preferred teammate separation. Re-evaluate if stalled for 18 ticks; choose an alternate waypoint rather than alternating left/right every frame.

At striking range, score a direct shot, two side-board banks (mirror-goal construction, then validate with real collision prediction), and a pass. Prefer shots with an open goal segment; prefer passes when a defender blocks the shot and teammate has space. Charge only with enough separation for the windup. AI aim has seeded ±6-degree error on standard difficulty and a minimum six-tick response to a new touch. Error/decision deadlines are state, not renderer randomness.

One default difficulty, tuned to be beatable and active. No difficulty menu until a second behavior set has actually been tested. AI should occasionally miss; it must never miss by deliberately ignoring collision rules.

## 7. Engine composition and the ball controller

### Reuse map

| Responsibility | Existing public mechanism | Game-owned work |
| --- | --- | --- |
| Browser timing, focus/debt pause | `@onepage/game-runtime/browser/lifecycle` | Match state machine and one 60Hz step |
| Semantic input / cancellation | `…/input/action-map`, `…/input` | Pointer aim, switching, charge rules |
| Circle/static and circle/circle contact | `@onepage/game-simulation/circle-geometry` | Orb restitution/drag, actor slide and separation policy |
| Fixed units and filters | `…/geometry` | Court geometry and categories |
| Action phases and hit claims | `…/action-timeline` | Swing timing, contact cone, authored animation mapping |
| Deadlines | `…/tick-deadline` | Match, immunity, dash, AI reevaluation deadlines |
| Randomness | `…/random` | Owned AI error stream; presentation gets a separate cosmetic seed |
| Projection | `…/presentation/isometric` | Rotated court recipe and sprite heading lookup |
| Stage, atlas, playback, effects | `…/pixi` | Pixel viewport adapter, court presenter, bounded effects |
| Audio/event delivery | Existing `M2Audio` and `PresentationQueue` public exports | Sports cues, music arrangement, crowd state |
| Diagnostics | Current inspector patterns | Dev-only overlay toggled by backtick (collision circles, AI roles, tick counter); stripped from the production build |

Inspect the actual public export names during provisioning; use no package-private imports. Existing Wrecklight host/identity/import patterns are reference implementations, not files to copy wholesale with stale names and game rules.

### Why not reuse the existing ball owner directly?

`BallisticWorld` is a bounded independent-body proof: 256 ticks, finite bounce budget, and static target contracts. A continuous 90-second sports orb with moving athletes is not that contract. `ProjectileOwnerV1` handles swept projectile hits but does not provide persistent sports rebound policy. The current Rapier adapter is `candidate-unqualified`, fixes gravity to `(0,-9.81)`, friction to 0.7, restitution to zero, and exposes opaque local captures rather than the needed portable game snapshot. None is a drop-in sports solver.

Recommended composition: **one app-owned `BallController` using public query math**. The engine supplies geometry facts; the game supplies arcade motion policy. Do not reimplement circle sweep equations or add another generic physics package. This is justified game code, not an excuse for duplicated collision math.

### Bounded motion algorithm

- World positions use 256 units/pixel. Keep all authority positions, velocities, timers, and integration remainders integer. Quantize aim once to a pinned 256-entry direction table; do not recalculate trigonometry on every replay step.
- Respect public query limits: displacement is at most 8,192 fixed units (32 world pixels), radius at most 4,096 units, and coordinates at most 262,144 units. Motion substeps fit these limits. Long shot-lane, assist, and bank-planning queries must be subdivided into ordered segments no longer than 32 pixels, translating segment fractions back into total path distance; do not submit a whole-court ray to the bounded query. Use the actual ball radius for clearance, rather than a zero-width line through a post gap.
- Four movement substeps per 60Hz tick; at 350 pixels/sec the ball advances at most about 1.46 pixels/substep before a rebound. Query swept paths anyway; overlap-only detection is insufficient for posts and moving players.
- Propose player movement from common starting poses, sweep against static court geometry, and slide with a bounded two-contact iteration. Resolve player pairs in stable order with at most two separation passes, rechecking static boundaries. Record actual piecewise trajectories, including corrections; do not pretend a wall-slide followed one straight chord.
- Ball sweeps against fixed boards/posts using `queryCircleGeometry`. For moving player circles, transform to relative displacement over each actual trajectory segment and use the public circle sweep. Reconstruct contact time/normal in world space; zero normals get a specified fallback based on previous separation then relative velocity.
- Process earliest time of impact; reflect incoming **relative** normal velocity with surface restitution, then add target normal velocity for moving players. Cap orb speed at 350 pixels/sec after every response. Tangential velocity is retained. Normalize the public query’s non-unit normals and round updated authority values to fixed units; query time fractions use a 65,536 denominator. Nudge policy applies only to slow player contacts.
- Resolve at most four ball contacts per substep. Use one fixed-unit separation slop and exclude only a just-resolved separating zero-time pair; do not globally disable collision with that player for several frames. On exhausted contact budget, stop remaining movement for that substep and emit a diagnostic. It must not happen in supported acceptance routes.
- Goal-plane crossings participate in earliest-event ordering; solids win equal-time ties. A successful strike is evaluated at the defined active contact stage and may change remaining orb motion, but the same swing cannot hit again.
- Drag is applied once per tick via carried integer division. No friction or clock appears in the presenter.
- The public query's targets are static and reject embedded velocity/delta fields. Relative-motion composition belongs in the app adapter; do not pass unsupported dynamic-shaped objects into the API.

C0 must show sustained motion, moving interceptions, corner escape and relative rebounds working through public composition (watched in the dev build plus the few unit tests in §11). If it cannot, record the minimal failing fixture and smallest missing public seam. A new general physics API is not a prerequisite inferred from the genre.

### Deterministic tick and authority state

One session owns `step(commandFrame)`, `observe()`, and `drainEvents()`. Order:

1. Admit semantic edges/aim and pending switch; validate tick/counter bounds.
2. Advance non-live match phases, or sample human/AI intents from a common live state.
3. Advance action phases and deadlines; gather ready strike/check candidates.
4. Run four ordered movement/contact substeps, including actor trajectories, ball contacts, and goal detection. Commit shared contacts deterministically, without observing partially applied damage-style effects.
5. Commit goals or, if still live, decrement match time and resolve horn/overtime. Goal wins over a later same-tick horn.
6. Publish detached observation and ordered events.

**Cut for the demo:** no `capture()`/restore, snapshot validation, content-identity hashing, recorded replay scenarios or golden files. Keep the session deterministic anyway (integer state, seeded RNG) because it makes bugs reproducible for free, but do not build tooling around it. Host device state is cancelled on pause/blur. No mid-match Save/Load. Persist only audio/reduced-motion preferences in `localStorage`, with a silent fallback. No telemetry.

## 8. Presentation, interface, and sound

### Scene composition

Layer stack: rear architecture/stands → court floor and painted markings → ground shadows/badges → depth-sorted actors/posts/goal backs → orb and contact effects with correct world depth → low foreground trim → HUD.

Do not simply draw the orb above all scenery. Use proper depth, plus a small high-contrast outline/indicator when an actor occludes its center. Tall rear columns stay outside play. Front goal posts are low; net and arch overlays fade or are split so a ball entering remains visible. Decorative noise is lower contrast than gameplay.

Use a cohesive shared palette. Keep floor pattern variation low-frequency. The court gets authored wear along lanes and center, not random visual noise. Crowd consists of 3–4 varied loops repeated with offset phase; no need for dozens of unique fully animated spectators. Banners and fire provide ambient movement even while players are still.

### Screens and HUD

- **Loading:** crest, compact progress indicator based on real required loads, clear retry on missing assets; never enter an invisible arena after a failed load.
- **Title:** Cryptball logo, miniature animated court/crowd or quiet backdrop, Play / Practice / Settings / Credits. One input to enter a match. Do not expose seeds, test tools, hashes, or engine terminology here.
- **Scoreboard:** left team crest/score, centered `1:30`, right crest/score, compact attack-direction marker shown during READY. Native HUD height 26 pixels; numerals large enough at 1×.
- **Live:** controlled-player ring, small dash recharge wedge, charge indicator near controlled feet only while held. Avoid four health bars and a permanent tutorial panel.
- **First-use prompts:** at most one short prompt at a time; disappear after its action is demonstrated. Practice can repeat prompts.
- **Pause:** Resume, Restart match, How to play, Settings, Title. Restart requires a second deliberate selection because it discards the match; no modal chain for Resume.
- **Settings:** music, effects, reduced motion. Text labels and volume sliders are keyboard accessible. Honor system reduced-motion preference on first visit.
- **Results:** winner/draw, final score, shots/goals/passes for the human team, large Rematch and Title. Statistics must derive from authority events; a shot counts on actual strike contact, a completed pass on teammate's next deliberate touch without intervening opponent touch.

Use an existing verified bitmap font or an original compact font with clear numerals; pin its source/credit in the manifest. Do not assume an uninspected font's distribution terms. DOM menus may overlay the canvas for accessibility but must visually match the pixel composition. Maintain visible keyboard focus and correctly announced screen changes without flooding screen readers with live frame updates.

### Audio direction

Original short sports-fantasy score: bright bass pulse, snare/hat rhythm, short brass or square-wave hook, restrained dungeon texture. Target 145–155 BPM, 32–48-second seamless loop, with a more urgent variation for overtime. Avoid continuous ominous ambient drones; the game should sound athletic.

**How it is made:** all audio is synthesized through the existing `M2Audio` (`@onepage/game-runtime/audio`) with `Patch` and `Score` objects, using `apps/wrecklight-works/src/audio.ts` for lifecycle and event wiring only. Its score has no tracks; it is not a music arrangement example. No sample files ship. Author the match loop, overtime variation, title cue and goal/end stings as `Score` data in `apps/cryptball/src/audio.ts` (use `npm run game:generate:music` as a starting point if useful, then hand-edit). SFX are short patches: square/triangle pops for pass and strike, filtered noise for board knock and check thud, a high sine for post ping, two-tone square for whistle. Crowd is a band-limited noise patch with volume envelopes (murmur → swell → cheer); keep it under the music.

Use the existing pipeline; do not add a second audio engine. Music must not set simulation tempo. Start/unlock on explicit user interaction; pause/focus and disposal cancel scheduled effects safely. A failed audio unlock leaves a playable muted game and a visible sound control.

Prioritize distinct cues: soft pass pop, hard shot crack, hollow board knock, metallic post ping, check thud, goal chord, referee whistle. Modest panning follows screen position; clamp near ±0.6. Limit repeated board cues and voice count (target eight simultaneous effects); goal/whistle preempt expendable ambience. Crowd swells on shots and goals then settles. Reduced motion changes visuals only; mute changes sound only.

Required review includes one uninterrupted match with sound. Check clipping, loop seam, repetitive impacts, delayed effects after pause, and whether post/goal/pass can be recognized without watching.

## 9. Files, provisioning, and workflow

Proposed app: `apps/cryptball/`. Proposed local port: **4223**, verified free at provisioning; do not assume availability today. Proposed production output: `.local-game-tests/cryptball/`, served for acceptance at `/games/cryptball/`.

```text
apps/cryptball/
  AGENTS.md                         maintainer-owned scope/ownership instructions
  index.html, styles.css
  src/
    main.ts, host.ts                lifecycle, semantic input, mount/dispose
    contract.ts, rules.ts           bounded types and versioned tuning
    session.ts, match.ts            one authority, phases, goal/horn/restarts
    court.ts, motion.ts             geometry and query-based actor movement
    ball.ts, actions.ts             orb response, swing/check policy
    team-ai.ts, prediction.ts       deterministic decisions/shared prediction
    presenter.ts, viewport.ts       fixed-resolution rendering
    animation.ts, projection.ts     clip mapping/anchors/view recipe
    effects.ts                      polish effects from §3 (particles, flashes, after-images)
    audio.ts, ui.ts                 patches/scores and product screens
  public/assets/cryptball/          prepared atlases, fonts, manifest.json, LICENSES.txt
  art-src/                          Aseprite sources for authored art (committed)
  tests/cryptball.test.ts           the small unit set in §11
  tests/smoke.spec.ts               one production-build browser smoke test
scripts/game-assets/
  cryptball-source-selection.json  exact archive members, hashes, anchors, scale factor
  import-cryptball.py              archive → cleaned, recolored, packed atlases (Pillow)
vite.cryptball.config.ts            minimal app config (omit Wrecklight identity plugins); port 4223, base /games/cryptball/
vitest.cryptball.config.ts          copy vitest.wrecklight.config.ts
playwright.cryptball.config.ts      copy playwright.wrecklight.config.ts
```

Add the five `package.json` scripts listed in §0. Add the lane to existing harness discovery only if `npm run check` fails without it; no new policy, inventory, or denial-probe work for the demo.

Asset pipeline contract: `npm run assets:cryptball` reads the archives from `~/Documents/GameAssets/…` (path overridable by `CRYPTBALL_ASSET_ROOT`), plus authored PNG exports from `apps/cryptball/art-src/export/`, and writes everything into `public/assets/cryptball/`. Generated atlases **are committed**, so a developer without the archives can still build and run the game. Wrecklight already does the same; if this repo is ever published, check each pack license allows redistributing the processed outputs. Re-run the importer only when source selection or authored art changes.

Use public package exports only (`@onepage/game-runtime/*`, `@onepage/game-simulation/*`). Use Wrecklight as the reference for host, lifecycle and audio wiring, and [primitive catalog](engine-primitive-catalog.md) to find exports. Do not overwrite the current Museum/Wrecklight working-tree changes. Implement additively in the current checkout, preserving those changes; a clean checkout of the baseline alone would omit the reviewed local reference work.

## 10. Ordered implementation milestones

Estimates are active developer effort, not elapsed time: milestones below sum to ~10–17 developer-days; budget **12–20** to cover the art risk. With two people (code + art) running the tracks in parallel, elapsed time is roughly 7–11 days. Art cleanup and tuning are the largest uncertainty. A greybox is not the deliverable.

### C0 — scaffold, view proof, art pipeline proof (1–2 days)

Code: create `apps/cryptball/`, the three configs and five scripts from §0. Pixel viewport adapter at 384×256 with integer scaling. Projection module with the three depth factors switchable from the dev overlay. Ball and four circles bouncing on boards/posts through public queries.

Art: write `import-cryptball.py` for **one** archetype (warrior, Ivory), all 16 headings of idle/walk/attack: measure height, pick scale factor, anchors, matte, palette, recolor. Draw a first-pass court floor, border and one goal at 1×.

Exit: screenshot of the real warrior running in all headings on the draft court at 2× scale looks clean and readable; depth factor, scale factor and feet anchors pinned in code; ball bounces and post hits look right. If cleaned athletes are not readable here, stop and fix the art approach before continuing.

### C1 — satisfying single-player ball play (1–2 days)

Implement movement, strike/charge, pass target dummy, dash, wall/post banks, goal detection and quick reset. Use a dressed court and real sprite animations from the start, even if title/crowd are incomplete. Build practice. Verify ordinary inputs; avoid relying only on direct session commands.

Exit: repeated deliberate bank shots, intelligible whiffs, no mismatched weapon/ball contact, no stuck corners. Review a 30-second clip at native scale and test movement/aim in all headings. Obtain a short user playtest if available; record absence honestly without stopping unrelated production work.

### C2 — complete 2-on-2 match (2–3 days)

Add team coordination, passing/control transfer, defensive lanes, checks/immunity, restart protection, regulation/overtime/results.

Exit: player can start, win, lose, draw, pause, resume, restart and rematch through ordinary UI. Both teams score in normal play; no four-player permanent scrum.

### C3 — finished art and animation (3–5 days; art track runs from C0, this is the merge point)

Every row of the §3 asset table shipped and wired; every item in "Animation polish requirements" implemented in `effects.ts`/`animation.ts`. All four athlete variants, both goals, stadium, crowd, braziers, banners, title, crests, HUD, results, key prompts. Remove all placeholder art and debug labels from the production build. Check atlas page count against the §3 budget and look for baked-shadow halos.

Exit: record a full match at 2× and review it frame by frame for: placeholder art, missing heading/clip, sliding feet, double shadows, hidden orb, blurry scaling, unreadable team identity, static screen. Zero of each. This milestone is required, not optional polish.

### C4 — audio and usability tuning (2–4 days)

Produce and integrate music/cues/crowd. Tune speed, aim assistance, goal width, AI reaction and spacing using actual matches. Fix the strongest observed friction first. Verify keyboard-only play and mute/reduced-motion modes. Keep all tuning in `rules.ts`.

Exit: at least two unfamiliar players can explain scoring, make a deliberate pass and finish a match with little/no coaching. Target at least three of five players choosing a voluntary rematch in final testing; report sample and observations rather than treating the threshold as universal proof of fun. If recruitment is unavailable, report human acceptance pending; do not fabricate it or hide unfinished art behind it.

### C5 — ship the demo (½ day)

`npm run typecheck && npm run test:cryptball && npm run build:cryptball && npm run test:cryptball:browser`. Serve the build at `/games/cryptball/` and play one full match in Chrome with sound. Write `apps/cryptball/README.md`: how to run, controls, credits/licenses, known limits.

Exit: the §11 checklist is ticked, and the README and asset manifest are committed.

## 11. Verification (demo-sized)

Testing is deliberately small. Write tests only where a bug would be hard to see by playing. Everything else is checked by playing.

### Automated: `tests/cryptball.test.ts` (~12 cases, Vitest, session-level)

1. Ball banks off a side board at the expected angle and loses speed per restitution.
2. Ball hitting a post reflects and does not tunnel at max speed (350 px/s).
3. Ball cannot escape the court from a corner wedge with a player pressing it.
4. Goal: whole-ball crossing scores once; ball clipping the post at the threshold tick does not score.
5. Own goal credits the other team.
6. Goal on the final regulation tick counts; tie at horn enters overtime; OT goal ends the match.
7. One swing hits the ball at most once.
8. Charge auto-releases at the 24-tick cap, producing exactly one swing.
9. Same-tick input priority: switch > dash > pass > strike.
10. Successful pass switches control to the receiver; a whiffed pass does not.
11. Dash checks at most one opponent; teammates are never checked; immunity prevents a stun chain.
12. Project → unproject round-trips; screen-up input moves visually up.

### Automated: `tests/smoke.spec.ts` (one Playwright test, Chromium, production build)

Load `/games/cryptball/`, confirm no console errors, press Enter through title, play 5 seconds of keyboard input, pause and resume with Escape, and confirm the scoreboard is visible. That is the whole browser suite.

### Not doing (out of scope for the demo)

Snapshot/restore and continuation tests, replay goldens, content identity hashing, Firefox/WebKit runs, harness inventory/protection/denial-probe registration, p95 performance instrumentation, engine qualification runs.

### Manual play checks (do these in C3–C5; 30 minutes total)

- Watch FPS in the dev overlay for a full match; it should stay at 60 on the dev machine. Investigate only if it drops.
- Tab away mid-charge and come back: no stray swing. Click Resume: no strike.
- Play one match keyboard-only and one with the mouse.
- Toggle mute and reduced motion; both take effect immediately.
- Grayscale screenshot (any image tool): teams, controlled player and orb are still distinguishable.
- Asset budget sanity: `du -sh public/assets/cryptball` under ~12 MiB.

### Finished-demo checklist

- [ ] Court, camera and athletes look clean at 1× and 2×, judged from moving sprites, not stills.
- [ ] Both goals, all four players and the orb stay readable in every live state.
- [x] Title, practice, match, pause/settings, results, rematch and credits all present.
- [ ] Every §3 asset row and every animation polish item is in; no placeholder or debug art in the production build.
- [ ] Music, SFX and crowd play, loop cleanly, and respond to shots and goals.
- [ ] Keyboard/mouse and keyboard-only both work; pause and blur never fire an action.
- [x] `test:cryptball` and `test:cryptball:browser` pass on the production build.
- [ ] README with run instructions, controls and credits; asset manifest with licenses.
- [ ] At least one person other than the developer has played a full match; record what they said.

## 12. Decisions to carry into implementation

Locked direction: shallow fixed isometric court; 384×256 pixel grid; 2-on-2; free orb; sword-swing shots; dedicated pass; short dash check; one arena; short matches; complete retro sports presentation.

Bounded C0 decisions (the only open items): (1) depth factor within 0.50–0.60; (2) athlete scale factor, source compass mapping and feet anchors; (3) shared palette/matte/shadow treatment. Each is pinned as a constant in code or the source-selection JSON when chosen. These are implementation investigations with concrete proof scenes, not reasons to reopen the whole game concept.

Playtest variables: shot speed/drag, goal width, AI reaction/error/spacing, check recovery, and initial tutorial wording. Record changes and the observations that prompted them. Add no new powers, progression, hazards, or game modes to compensate for unclear basic movement and ball play.

The implementation is successful when the small game feels complete and invites another match—not merely when its engine systems can be shown in isolation.

## 13. Implementation review — 2026-11-04

The edited plan was checked against the current public engine sources and the layout PNG. Projection composition, court corners, fixed-unit/query limits and app-owned rebound policy are supported. Milestone estimates and feel/readability goals remain estimates and acceptance targets, not measured outcomes.

Accepted corrections:

- Pixel viewport setup must set public stage dimensions as well as renderer size; texture sampling and canvas enlargement both need nearest-neighbor behavior.
- Cryptball uses a minimal Vite config, not Wrecklight’s identity/hash plugins. Its three root configs are added to TypeScript checking.
- `M2Audio.effect` does not expose gain, pan or priority and uses a 32-effect cap. Independent audio controls and eight-effect admission require an app-owned adapter around the public `AudioEngine`, injected into the single `M2Audio` owner. Music track gain is applied to score data; changing it restarts transport. Goal/end cues are short patch sequences, not separately played one-shot scores. Match/overtime arrangements use the public synth’s queued-score boundary through that adapter; the constrained engine low/high bank only supports 8/16 bars and cannot meet the requested 32–48-second duration at 150 BPM. The app uses compatible 24-bar (38.4-second) loops. This is additional implementation work, not existing Wrecklight behavior.
- The purchased Lords of Pain archive contains no license/readme member. Local availability and hashes do not establish permission to redistribute processed sprites. Record that uncertainty in the asset manifest and credits; public distribution remains pending license confirmation. Unused UI/font packs need not be imported merely because they were suggested; original art can replace them with explicit provenance.
- Human playtests, listening review and art acceptance cannot be marked complete from unit tests or browser automation. Report these separately. The plan’s “only three open items” refers to bounded design choices; it does not remove these acceptance and licensing uncertainties.

### Concrete implementation choices

- Pixel depth is pinned to 0.55. Warrior scale is 1.00 and knight scale 1.12; source feet anchor is (139,132), with stable source-space cropping/scaling. The source-selection file records directional inspection and the matte/recolor recipe.
- The art source is deterministic native-resolution Pillow drawing code plus editable PNG layers, not Aseprite documents. The prepared atlas has 1,959 frames, 341 clips and three 1024² pages; public assets occupy about 1.8 MiB. Material recoloring is a pinned heuristic, not hand-painted per-frame masks or a verified 24–32-color actor palette.
- No Dead Revolver or Penusbmic assets are needed. Original interface/effects replace those selections. Logo raster lettering uses Pillow’s Aileron default; its designer states “No Rights Reserved.” Product menu/HUD text currently uses DOM monospace rather than a dedicated bitmap font.
- Goal net response uses an eased transform, and particles/shapes supplement atlas effects. Attack animation uses a shared startup/active/recovery frame mapping, not independently authored contact markers for every heading. These are explicit differences from the exact C3 specification, pending visual/playtest acceptance.
- Initial audio/GPU work completes before the authority clock starts. The host waits for six stable render frames; this avoids a false debt pause on first Play while retaining the existing pause-on-sustained-debt behavior.
- No files were committed or published. Existing Museum/Wrecklight changes remain in place.

- Collision implementation refinement: normal slop stays one fixed unit, but a persistent blocked or multiple-player contact can yield the athlete two world pixels and stop its remaining substep collider. A shared inelastic tangent constraint prevents repeated motor contacts. End separation corrections are instantaneous rather than swept ball impacts. These are explicit game-policy deviations from the original motion prescription; regression cases and three full seeded matches exercise them without contact-budget exhaustion.

Final command validation: typecheck, 12 authority cases, production build and one Chromium smoke test pass. See [delivery notes](cryptball-delivery-2026-11-04.md) for evidence and the unresolved uninterrupted full-match, exact C3 visual, human listening/playtest, and purchased-art licensing acceptance items. The local preview is not a public release.
