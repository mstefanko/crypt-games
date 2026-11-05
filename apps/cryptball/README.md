# Crypt Games

A dungeon sports prototype with five competitive modes and one solo boss mode with an allied bot on one arena. Uses the shared public simulation geometry, browser lifecycle, Pixi renderer and audio synth. Quick Play and private rooms seat up to four humans, with optional bot fill and reconnect takeover. There are no dedicated keepers.

| Sport | Play | Scoring |
| --- | --- | --- |
| Cryptball (default) | Free-orb stickball, bank shots and slide blocks | 90-second regulation, 30-second sudden-death overtime |
| Cryptkick | Soft dribbling possession, passing, charged kicks and committed tackles; sprinting pushes the ball loose | Same timed goal scoring |
| Cryptcheck · Hockey | Momentum skating, exposed stick control, low passes, wrist/slap shots and committed checks | Same timed scoring; neutral center faceoffs |
| Rift Volley | Stay on your half; serve, set, attack and dig over the spectral net; three team contacts with no consecutive contact by one athlete | First to 11, win by two, capped at 15 |
| Crypt Dodge | 2v2, two balls, stay on your half, deliberate catches and diving saves, charged throws and teammate passes | Three lives per athlete; best of three rounds |
| Crypt Guardian | Two allies carry, throw and pass two orbs against a seeded cannon/hook/maul guardian, read weapon tells and dodge attacks and revive allies | Defeat the boss before the party falls or the three-minute limit |

Select a sport before Solo, Practice, Quick Play or creating a private room. Quick Play queues are separate. Invitations and bare room codes adopt the room's sport. Fixed-activity rooms retain their sport through rematches. Crypt Shuffle rotates through the five competitive activities after each full match, including a best-of-three Dodge match; Guardian is solo only. Hosts choose the activity before room creation. Players enter a name before joining; white shadowed labels follow their authoritative controlled athletes. `?sport=cryptkick`, `?sport=rift-volley` and `?sport=cryptcheck` select a sport on the title screen.

The new modes use `?sport=crypt-dodge` and `?sport=crypt-guardian`. In Dodge, press J while empty-handed to catch; holding it does not extend the catch window. With possession, hold/release J to throw or K to pass. Shift/right mouse dives to catch; diving while holding drops a safe ball. Three pips show each athlete's remaining lives. Wall/floor contact or the first body hit ends a dangerous throw. Same-side passes cannot renew the possession clock. Eliminated athletes wait until the next round.

Guardian uses ordinary Cryptball orb strikes, passes and movement. The player and one allied bot cooperate; legacy numeric team slots only preserve seats/cosmetics. Hold K/middle mouse (or the touch Revive control) near a downed ally to revive; damage or leaving range cancels progress. Each athlete can be revived once. Cannon and hook fights have destructible cover; maul fights use an open floor. Retry preserves the guardian seed; New Guardian chooses another offline. Practice offers weapon-family selection and an immortal-athlete option. Guardian is unavailable online. Team special moves have been removed from every activity.

The [new-mode plan](../../docs/cryptball-dodgeball-arena-plan-2026-11-05.md) explains rules, initial balance values and engine boundaries. Generated sources are in `art-src/new-modes-v1`; runtime art uses its own atlas and reused movement/dive poses. Human balance and device comfort still require playtesting.

## Run

From the repository root:

```sh
npm run dev:cryptball
# http://127.0.0.1:4223/games/cryptball/
npm run build:cryptball
npm run test:cryptball
npm run test:cryptball:browser
npm run dev:cryptball:online
npm run test:cryptball:network
npm run test:cryptball:determinism
```

The build is `.local-game-tests/cryptball/`, with public base `/games/cryptball/`. Serve it at that path. Atlas output is included in the working tree, so running/building does not require Python. Rebuild the athlete/arena atlases and independent mode-ball atlas with `npm run assets:cryptball` using Python/Pillow in `.venv-assets`. No purchased archive or external generation account is required. See `art-src/dives-v1/README.md`, `art-src/README.md`, `art-src/sports-v1/README.md`, `art-src/balls/README.md`, and `art-src/hockey-v1/README.md` for source and review status.

## Controls

- WASD / arrows: screen-relative movement.
- Move the mouse over the court to aim; movement keys return to keyboard facing.
- J / left mouse: hold to charge indefinitely, release to strike. Full charge adds a golden halo and small sparks; dash, slide, cancellation or a check can interrupt it.
- K: choose a teammate in the aiming cone, falling back to nearest. In solo play, a pass can switch control to an available field teammate.
- Right mouse / Shift / I: launch a committed slide. Recovery blocks striking, passing and dashing.
- Space / L: dash and shoulder check.
- Q: switch an available teammate. Escape: pause/resume offline, bot cover menu online.

Cryptkick uses the same bindings: J kicks, K passes, right mouse / Shift tackles and Space sprints. Close, manageable loose balls are trapped automatically. The ball remains independently collidable during dribbling; release and tackle lockouts prevent instant reattachment.

In Cryptcheck, release movement to coast and move against the glide to brake before reversing. Aim rotates the stick independently of momentum. J fires a wrist shot or charges a slapshot; K makes a low push pass; Shift/right mouse poke-checks the puck; Space commits a skate burst with shoulder contact. Control assists a reachable puck on the blade but never attaches its position to the athlete. Bursting or charging releases control. The full puck must cross the goal line. Matches restart with a neutral faceoff; there are no icing, offside or penalty stoppages, dedicated goalies, airborne pucks or behind-net skating.

In Rift Volley, J serves/attacks, K sets toward your teammate and right mouse / Shift dives to dig low balls. Charge changes attack pace/depth; aim controls lateral placement. Jump poses are contextual animation, not a separate player jump input. Ball height, net clearance and landing are authoritative simulation. Floor and perimeter contacts score faults; the server has three seconds to initiate a serve. Practice keeps both opposing bots visible for rallies and does not end at the match score target. Ground-sport practice uses only the two friendly athletes.

Teams (Rams, Foxes, Owls, Gators, Bats, Hornets) are assigned randomly and are cosmetic. All teams use the same rules and stats; uniforms and arena banners retain their identity. No team picker or special HUD is shown. Old special commands are ignored, and checkpoints with active specials are rejected.

The title screen uses large activity cards with clear sport subtitles and the existing pixel-art banners. Scoring triggers a 650 ms seven-pixel scorer hop; Dodge round winners and a victorious Guardian party celebrate together. Reduced motion omits the hop. Gameplay timing is unchanged.

## Assets and sound

The active atlas uses generated armored athletes in eight visual directions, with twelve base poses per direction and controlled team palette swaps. It no longer imports the previously unverified Lords of Pain athlete pack. Current provenance is in `public/assets/cryptball/manifest.json` and `scripts/game-assets/cryptball-source-selection.json`.

Selected-team banner sources and the exact built-in generation prompt are in `art-src/banners-v1/`; their importer combines generated blank cloth with the original mascot SVGs into perspective-matched overlays.

The arena, athlete poses, crowd groups and eight-frame flame cycle were generated with the built-in image tool. Sources, prompts and review sheets are in `art-src/polished-v1/`. The importer extracts full figures, cleans alpha, normalizes foot anchors and packs two atlas pages using Pillow. Original small ball/UI/contact effects are retained. Goal geometry is rendered from the same dimensions as the simulation with generated stone-post material. Static flames and oversized decorative grilles were removed from the backdrop. The separately generated art-direction concept remains a concept; actual gameplay evidence is recorded in the polished-2v2 delivery report.

Cryptkick and Rift Volley share a separate weapon-free atlas with eight facings and sixteen generated key poses per facing, plus team palette variants. Kick/pass, receive, set, spike and landing poses are distinct from Cryptball's bat art; exact clip aliases are documented in `art-src/sports-v1/README.md`. A third compact atlas supplies original pixel football/volleyball art, spin, squash/recovery and distinct set/dig/attack contact cues. The original three atlases are preloaded. Hockey loads its independent atlas pages when selected, and the host awaits art readiness before play, including room-code discovery. Volley extracts an unmarked floor from a generated arena edit, closes the goals and draws a depth-sorted spectral divider. A ground shadow and landing ellipse make airborne balls readable. The ellipse predicts uninterrupted flight and can change after a contact.

Ball profiles in `sim/sports-spec.ts` keep original Cryptball at radius 3, use radius 6 for both Cryptkick and Volley, matching their 12px solid art. Cryptkick rolls with deceleration 36 units/s² and board restitution 0.82; its 14-unit dribble offset preserves clearance. Volley sets take 64 ticks and digs 72, with gravity 240 units/s². Its `z` is center height and floor contact occurs at radius 6. Shared engine fixed-flight math drives live displacement, discrete launch, AI interception and the visible landing estimate; the engine's closed segment/AABB query handles the ball-expanded net slab. Radius, contact assistance, sport rules, cosmetic deformation and art remain game-owned. Volley uses 32 additional generated hands-first dive poses across eight directions, including forearm contact and push-up recovery; Cryptball and Cryptkick retain feet-first slides; hockey uses low stick checks. Ball deformation never changes its collider. Reduced motion keeps sports balls round and still while retaining a contact cue.

Hockey uses the generated ice floor masked into the registered arena, projected rink markings, eight directional stick/skate pose sheets and a rigid puck. Its ground radius is 4 units, sliding deceleration 12 units/s², board restitution 0.88 and maximum puck speed 420 units/s. Physics remains game-owned on the shared swept solver; it does not add a second engine backend. Source provenance and animation proofs live in `art-src/hockey-v1/`. See `../../docs/cryptball-hockey-implementation-plan-2026-11-04.md` for the design and shared-mode boundary.

The score and sound effects are original synthesis through one `M2Audio` owner with an app-owned adapter to the existing `AudioEngine`. The 150-BPM match loop lasts 38.4 seconds; overtime adds a denser arrangement at the next musical loop boundary. Music volume changes restart transport; effects have an eight-voice admission cap and spatial pan. No samples ship.

## Acceptance limits

Automated tests cover collision/action/clock rules, four-player authority and reconnects, browser flows, and cross-engine checkpoint equality. They do not establish fun, full art acceptance or an auditory review. Human playtesting and art approval remain pending. See `docs/cryptball-polished-2v2-delivery-2026-11-04.md` for actual validation and deviations.

The seeded lab in `lab/README.md` preserves an old 2v2 baseline and supports bounded Cryptball slide-speed sweeps. New sports have separate complete-match and cross-runtime test workloads. The current court is a fixed versioned preset; arbitrary geometry, keeper-assist and timing sweeps are not supported. Checkpoint v9 rejects older states and validates two distinct team identities; protocol v7 still requires matching client/server build identities. See the repository's `docs/cryptball-mode-balls-plan-2026-11-04.md` for the engine/game boundary and ball update plan.

The contact solver uses four substeps with four contacts total per substep. In blocked or repeated multi-player contacts, athletes yield two world pixels and stop for the remaining substep; the orb follows the shared feasible tangent. This explicit arcade constraint prevents stationary bodies acting as motors. Normal contact slop remains one fixed unit. Wall-slide paths are piecewise, while end separation corrections are instantaneous. Seeded full-match checks are recorded in the delivery notes, not presented as proof of balance.

Software-GPU testing note: the short production smoke passes, but earlier extended SwiftShader runs triggered the shared lifecycle’s protective frame-debt pause. The latest 20-second optimized run was smooth; a full uninterrupted match remains an acceptance item. Native Chrome testing was not completed independently.

Implementation and verification details for Dodge and Guardian: [new-mode delivery](../../docs/cryptball-new-modes-delivery-2026-11-05.md).

Dodgeball powered throws use a three-tick standing catch window (50 ms at 60 Hz) and cannot be dive-caught. Duel bots mix full charges with quicker throws. Possession runs down in a small arc on the carried ball. Guardian supports one human plus one bot or two humans; rooms have two seats. Live matches use weapon tells; floor previews remain practice-only.
