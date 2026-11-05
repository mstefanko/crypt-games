# Cryptball: Dodgeball and Crypt Guardian

Historical initial plan. The implemented two-ball openings, Guardian possession combat and subsequent balance changes are specified in [pressure and teamplay](cryptball-pressure-and-teamplay-plan-2026-11-05.md) and its [delivery report](cryptball-pressure-and-teamplay-delivery-2026-11-05.md).

Design and implementation plan • November 5, 2026

Status: proposed mechanics and generated art source package; neither mode is implemented. All balance numbers below are starting hypotheses, not measured results. Preserve the four existing modes and their controls. Implement Dodgeball first, then the cooperative arena. Working names: **Crypt Dodge** (`crypt-dodge`) and **Crypt Guardian** (`crypt-guardian`).

Delivered: [art package and provenance](../apps/cryptball/art-src/new-modes-v1/README.md), [animation preview](../apps/cryptball/art-src/new-modes-v1/animation-proof.gif), [96-frame overview](../apps/cryptball/art-src/new-modes-v1/all-frames.png), [UI/telegraph source](../apps/cryptball/art-src/new-modes-v1/ui-kit.svg), and [asset validation](../apps/cryptball/art-src/new-modes-v1/qa.json).

## 1. The recommendation

Dodgeball is a tense 2v2 possession game: three dings per athlete, one ball, deliberate catches, deceptive passing, and dramatic diving saves. A catch earns possession, not automatic damage to the thrower. Arena is a 1–4-human, four-athlete cooperative ball-combat encounter: reposition, pass, strike the guardian, defend against readable attacks, and rescue allies. Fill vacant seats with bots by default; both modes retain all four athletes in solo play.

Build the boss from three authored weapon families, a small legal encounter table, and cosmetic variation. Do not generate new attack code, arbitrary hitboxes, or new raster art during a match. A seed chooses a reproducible encounter. The first release uses one stationary guardian at the north wall, facing south; weapons aim independently. This makes attack intent readable and avoids pretending one frontal sprite sheet supports a roaming, eight-direction boss.

Two broad alternatives are less suitable: an unrestricted random boss is difficult to teach and validate; a fully roaming boss needs navigation, more directional art, and more obstruction cases before the core ball loop is proven. Keep roaming bosses as a later, explicitly larger expansion.

## 2. Evidence from the existing foundation

Inspected the current working tree, including these files (paths are repository-relative):

| Foundation | Existing capability | Consequence |
|---|---|---|
| `apps/cryptball/sim/contract.ts` | Four sport IDs; `Team = 0 | 1`; four players; one ball; possession; action origins; two shared special slots | Add explicit mode state and cooperation policy; do not disguise the boss as a fifth roster player or score health as goals. |
| `sim/sports.ts`, `session.ts`, `match.ts` | Exhaustive sport dispatch, resets, ready/play/goal/results phases, controller ownership | Add two dispatch branches and mode-owned round/encounter subphases. Existing goal reset assumes teams and must not reset boss health. |
| `sim/modes/rift-volley.ts`, `sim/court.ts` | Half-court behavior, airborne ball handling, swept geometry; current end boards have goal openings | Reuse primitives, not volley scoring. Use genuinely closed collision boundaries and player-only center restriction for Dodgeball. |
| `sim/spec.ts`, `sports-spec.ts` | Court half extents 166×96 world units, authored profiles, fixed-point conversion | Keep court dimensions initially. Introduce separate profiles; do not mutate Cryptball or Volley tuning. |
| `src/animation.ts`, `art-src/sports-v1`, `dives-v1` | Eight-direction weapon-free athletes and hands-first dives | Reuse locomotion and dives; generate actual catch/carry/overarm throw/pass/recoil poses. |
| `art-src/polished-v1`, active Cryptball atlas | Bat-bearing striking, charge, pass, recoil, celebration | Arena should use the original stickball move set and its art. No need to force hockey or football controls into combat. |
| `packages/game-simulation/src/action-timeline.ts` | Tell/active/recovery phases and per-action hit claims | Boss attacks and player release/catch windows use authoritative timelines. |
| `damage-owner.ts`, `dynamic-projectiles.ts` (public package exports) | Bounded damage owner and swept moving-target projectile lifecycle | Reuse where semantics fit; prototype fixed-point/time-unit adapters and cover collision before adopting. `DamageOwner.repair` does not revive dead bodies. |
| `sim/checkpoint.ts`, `protocol.ts` | Current checkpoint 13, protocol 11; bounded validators; action origins | Bump both at implementation; serialize every catch, attack, projectile, cover and rescue state. Older delivery notes contain obsolete version numbers. |
| `apps/cryptball-server/src/model.ts` | Team-based seating, preferences, readiness, reconnects | Four cooperative seats need mode-aware presentation and allegiance, without weakening ownership checks. |

These are game-owned modes using engine primitives. Health, collision, projectile and timeline integration exercise new parts of the engine; mode rules, boss budgets, AI policy and cosmetics remain in the game. Only extend shared primitives after a fixture demonstrates a missing reusable capability. The current network delivery report records a failed local 4 ms replay p95 gate; these modes must not inherit an unsupported performance claim.

## 3. Crypt Dodge rules

### Match and court

* 2v2, three lives each, one ball. Best of three rounds; each round starts with all athletes restored. First side with no living athletes loses the round.
* No goals, posts, scoring triggers, nets, or center barrier for the ball. Close the old goal mouths in both scenery and collision. The center line is a floor marking. Player centers remain at least their body radius inside their own half, including dashes, dives, pushes and correction/restores.
* Seeded opening possession, alternate sides each subsequent round. Place the holder well behind the center line; 1-second visible countdown before throws become legal. Avoid an unreachable ball exactly on the center line.
* Round limit 90 seconds. At expiration, resolve an already-released live throw for up to 2 seconds, then compare surviving athletes, then total lives. A tied round enters up to 30 seconds of sudden death: next ding ends the round, still exactly one ball. If still tied, record a drawn round and replay it with reversed opening possession; do not silently award random victory.
* An eliminated athlete plays a short recoil/soul exit and becomes a non-colliding sideline spectator. No mid-round resurrection. Solo control may switch to the surviving bot; online players cannot steal a human-owned seat. Quick rounds and clear spectator targeting keep waiting manageable.

### Input and catches

| Existing input | Without ball | Holding ball |
|---|---|---|
| J / primary | Press opens a deliberate standing catch; holding does not keep it active | Hold to charge, release to throw |
| K / pass | No offensive effect | Low, safe teammate pass |
| Shift / right mouse / touch flick | Committed hands-first diving catch | Ordinary evasive dive drops the ball safely at launch |
| Space / dash | Reposition; no contact damage | Reposition with ball; same possession deadline |
| Q | Existing eligible teammate switch | Same; ownership stays with the athlete |

Standing catch begins on press, with 2-tick tell, 12-tick active window and 18-tick recovery (60 Hz). A fresh press edge is required after recovery. Catch cone starts at 120°, with reach of body radius + ball radius + 5 units. Holding primary through a successful catch must **not** immediately begin an unintended charged throw: require release then a fresh press. Buffered input preserves command origin.

Diving catch reuses the existing 18-tick committed slide trajectory and 15-tick recovery, with hands-first art. Start with catch active ticks 2–13, forward reach 8 units beyond standing, 100° cone, 66-tick reuse. A successful catch retains possession throughout recovery; no throw/pass until recovery ends. A missed dive exposes the body and costs position. No automatic catch merely because the player is diving, looking toward the ball, or holding the button.

Touch: preserve hold/release throw, tap pass and flick dive. Add a clearly labeled contextual Catch target while empty-handed, occupying the primary action area. An ordinary action-thumb tap can resolve as catch while empty-handed and pass while holding, without delaying the catch until long-press recognition. Releasing the movement thumb cancels a prepared throw, but does not discard possession. Test gesture cancellation across possession changes.

### Ball lifecycle: make every contact unambiguous

Authoritative enum: `held | friendly-pass | hostile-flight | dead-loose | reset`. Store holder, attacking side, throw ID, release tick, last hit claim and possession deadline. Exactly one state and one ball exists.

1. A throw releases at chest height, uses swept horizontal motion and a shallow deterministic ballistic arc, and becomes hostile only to the other side. Friendly bodies never take dings. No headshot bonus or manual vertical aim.
2. At the earliest time of impact, a legal catch volume facing the incoming ball can claim it before that athlete's body hurtbox. If two catches coincide, stable athlete ID breaks the tie. Do not resolve a later catch before an earlier body hit. Catch and ding cannot both occur for one throw.
3. The first unprotected enemy body hit costs **one** life, applies brief recoil and kills the throw. No piercing, ricochet multi-kills, or charge-based extra lives. Drop a dead ball toward the hit side. The hit athlete gets 45 ticks of visible immunity; they can move but cannot immediately collect for the first 18 ticks.
4. Any floor or wall impact ends hostile status. The dead ball rolls and can be collected automatically at close reach. It cannot damage or require a timed catch. A missed throw therefore gives the other team an opportunity to retrieve, instead of making bank shots arbitrarily lethal.
5. Friendly passes use a distinct dotted trail and auto-reception within a modest reach; a pass costs time and changes the attack angle, but never damages. Do not allow pass input to target an opponent. The passer cannot immediately reclaim its release. If the receiver is eliminated/unavailable, release a dead ball within the same half. The pass may hit a wall and become loose.
6. Held ball uses a presentation hand socket; collision is inactive while held. Catch commits position to that socket on the same authoritative tick. Dashing cannot duplicate a ball or leave an active projectile behind.
7. A dead ball lodged at center belongs to the half containing its center (exact zero goes to the last receiving side). After 90 unreachable/stationary ticks, place it at that side's visible retrieval spot with a short reset cue. No hidden teleport during an active throw. Recheck boundaries, holder elimination and disconnect takeover every transition.

### Pressure and passing

Team possession lasts at most 6 seconds, including passes and same-side loose-ball pickups. At 4 seconds show a shrinking ring over the holder; at 6 seconds whistle and transfer to the opponent's back-half restart spot. Crossing center in a hostile release resets the possession clock only when the receiving side next controls a safe ball. Passing cannot reset the clock. A 0.6-second tell precedes forced transfer.

Starting throw speeds: 180 units/s quick, up to 260 units/s charged after 30 ticks. A throw has at least 6 ticks visible preparation after release input; charge movement is 70% normal. Every charge still costs only one life. A clean received pass enables a short release preparation of 4 ticks for 30 ticks, with the same speed cap. This rewards teamwork without giving an invisible instant shot. Keep minimum opposing body separation at center large enough that the fastest shot plus its tell remains reactable; begin with a 20-unit no-standing strip on each side, then tune with humans.

Three diamond pips above each athlete show lives; depleted diamonds remain outlines. Repeat them in four fixed HUD portraits so near/far overlap does not hide status. Show an X and OUT label when eliminated. Hit cue: brief recoil, ivory impact burst, one pip break and a distinct sound. Catch cue: closed hands, possession ring and softer sound. Reduced-motion mode retains symbols and timing cues.

Disable team specials in the first balanced release of this mode; keep mascot cosmetics. Otherwise Gator reach, Owl reception help and Hornet release speed directly affect the main counterplay. A later explicit modifier can adapt specials after baseline catch/dive statistics are known. Never ship an active-looking B button that does nothing.

## 4. Crypt Guardian rules

### Cooperative loop and moves

All four players are allies. Each starts with 5 health; the boss starts at 300 health. One normal Cryptball orb remains in play. Friendly body checks and ball damage are disabled. The boss attacks players; only the orb damages the boss. No direct bat melee damage, avoiding four players camping its feet instead of playing ball.

Use Cryptball movement, aim, quick/charged strike, teammate pass and dash. Replace the feet-first defensive slide presentation with the existing hands-first dive when performing a defensive save, but keep it a **deflection**, not Dodgeball possession. Dive into the normal ball to redirect it toward aim at ordinary power; it does not automatically target the boss. A dive does not grant global invulnerability or catch boss shots. Dash escapes telegraphs; neither dash nor shoulder collision damages the guardian. Charging commits movement long enough to create a risk/reward decision.

Boss damage starters: quick strike 8, fully charged strike 12, successful ally-pass → receiver strike within 90 ticks adds 4 once. Passing chains do not stack bonuses. A hit during the boss recovery window adds 50% (integer floor), giving clear moments to punish. A single ball attack token can damage once; it must be struck again after leaving the boss hurt volume to earn another token. Bare rolling contacts, wall chatter and the boss batting a ball into itself cannot farm damage.

After a valid boss hit, deflect the ball into a reachable open lane using a seeded, bounded direction. Never return it inside cover or behind the boss. A ball trapped out of reach for 120 ticks gets a telegraphed center-lane reset; preserve exactly one ball. Boss hurt volume is on the arena-facing lower body; players cannot enter its body. Its physical silhouette and health target remain readable behind the HP bar.

### Downed players and outcome

At zero health the player becomes downed, nonblocking and invulnerable, with a soul marker at a valid floor position. A nearby ally holds the contextual pass action for 90 ticks within 18 units to revive at 2 health. Damage or leaving range cancels progress. Revive requires line of sight; mode input policy suppresses an accidental pass while channeling. Give 90 ticks protection after revive. One revive per athlete per encounter; a second down eliminates them until retry. A solo active player can have bots revive them. If everyone is down/eliminated, lose immediately.

Do not call `DamageOwner.repair` expecting it to revive zero HP; explicitly reconstruct/restore the validated health snapshot at a game-owned revive transition or add a narrowly tested engine revive operation if another consumer needs it. Boss defeat takes precedence over all-party defeat on an exactly simultaneous final hit, awarding a dramatic mutual-finish victory. Resolve all impacts before deciding outcome; one result event only.

Encounter target 90–150 seconds, soft escalation at 120 seconds, hard 180-second defeat with an on-screen countdown for the last 30 seconds. Escalation shortens recovery by at most 15%; it must not shorten attack tells below their minimum. Retry reuses the same seed; New Guardian selects another. Practice allows attack-family selection, immortal player toggle and immediate restart, clearly separate from scored results.

### Boss generation and fairness

One base guardian, three weapons: **Ossuary Cannon**, **Grave Hook**, **Tomb Maul**. Seeded selection chooses weapon, one of three palettes (violet/verdigris/ember), size 0.90/1.00/1.10, name tokens and one validated arena layout. Cosmetic name examples: Vark, the Hollow Warden; Brakka, Keeper of Embers; Ossa, the Chainbound. No mechanical stats are inferred from arbitrary text.

Size changes the boss body radius, hurt radius and weapon sockets together, capped at ±10%; attack footprints and safe routes are validated for each size. Keep HP fixed for initial balancing so size isn't compounded by random health. Palette never changes attack semantics or hazard color. Store the fully resolved descriptor plus generator version and seed in checkpoints so a later content change cannot reroll a reconnect. There are 3×3×3 = 27 body/weapon appearances before names; do not market cosmetic permutations as 27 distinct fight designs.

Each family has two authored attacks plus universal close-range slam. Use weighted seeded selection with no immediate repetition of the same attack, no third consecutive target lock on one player if another is available, and one damaging pattern at a time. Target lock is visible and stops tracking at the end of its tell. At 50% HP introduce the second pattern; grant a 60-tick safe transition. Reject combinations that block every escape path or overlap a revive marker with unavoidable damage.

| Weapon/pattern | Tell / action / recovery at 60 Hz | Counterplay and bound |
|---|---|---|
| Cannon aimed shot | 48 / one projectile / 72 | Draw lane and target marker; 110 units/s projectile, radius 5; pillar intercepts; one damage. |
| Cannon three-lane fan | 66 / three simultaneous projectiles / 90 | Fixed gaps; show all lanes; cap three active boss projectiles and 180-tick lifetime. |
| Hook line grab | 60 / extend 24 then retract 24 / 78 | Visible narrow corridor; dodge sideways or break on pillar; one damage and short pull at most 20 units, clipped against world/cover. No pull into a subsequent attack. |
| Hook sweep | 72 / 18 / 90 | Show broad arc with an outer safe lane; moving out is sufficient. No repeated damage during sweep. |
| Maul targeted slam | 72 / 6 / 90 | Lock floor disk after 42 ticks, leaving 30 ticks to leave; cover does not block marked floor damage. |
| Maul staggered double slam | 84 / two disks 36 ticks apart / 108 | Both positions announced before first impact; union leaves two escape routes. Second disk cannot retarget a recovering victim. |
| Universal proximity slam | 60 / 6 / 90 | Only if an athlete lingers in the near-boss zone; small visible disk. Never add it over another active attack. |

Every attack has an `attackId`, affected target set and fixed geometry. One attack hits each player at most once. Incoming damage is always one health initially, with 60 ticks damage immunity and 12 ticks recoil. Projectiles expire on first world/cover/player contact even when that player is immune; no stack of hidden impacts. Hazard drawings derive from the same locked shapes used by collision. The giant guardian animates wake/idle, tell, release/sweep/slam, recovery, hit, stun, and defeat; damage flash never cancels the underlying attack state.

### Cover: useful, limited, and optional by family

Default cannon/hook layout has two short pillars at world positions (-65,0) and (65,0), each with radius 11. North is negative world y: guardian anchors at (0,-68), players start in the southern half; layout validation includes maximum boss size. Pillars stop balls, players, shots and hook rays. Projectile impacts consume pillar health; three hits destroy one, with cracked art after first damage and rubble at zero. Rubble is nonblocking and visually low. Normal player-ball impacts ricochet and do not destroy cover. A ball striking cover cannot also damage a boss behind it on the same sweep.

Maul uses the open layout initially; floor telegraphs already create movement demands and pillars can make escape frustrating. Do not add cover simply for visual variety. Later broken-pillars layouts must pass reachability checks before entering the random pool. Never regenerate cover mid-fight beneath players. Telegraphs draw above floor/rubble but below actors, and remain readable around intact cover. Depth-sort pillars against actors; optional occlusion fade is visual only.

The boss gets a large top HP bar with name, weapon icon, phase marker and current attack word (SHOT/HOOK/SLAM). Each athlete has five compact health pips plus down/revive status. Keep identity via player number and ring shape, not opposing team colors. Solo AI roles: ball collector, passing outlet, danger avoidance and rescue; give each bot limited reaction delay and imperfect targeting. No bot reads future human inputs or unannounced target selection.

For v1 disable mascot specials in arena too. The existing two-team shared cooldown model does not represent four allied personal resources. Re-enable later only with a deliberately designed cooperative resource model; avoid silently giving half the party different cooldown ownership.

## 5. Art package and animation contract

Sources and exact prompts are in `apps/cryptball/art-src/new-modes-v1/`. Built-in ImageGen was used. See that folder's README and manifest for the actual generated outputs, extraction status and review limitations. Preserve source PNGs and provenance; generated key poses require native-scale review before shipping.

| Visual requirement | Source / implementation |
|---|---|
| Catch ready/contact, carry, overarm windup/release/follow-through, underarm pass, hit recoil | New athlete front/back source grids: eight directions × eight poses. |
| Run, idle, dive launch/flight/low contact/push-up, get-up | Existing weapon-free sports and dive atlases; explicit reuse, not newly generated frames. |
| Arena strike/charge/pass/recoil/celebrate | Existing Cryptball bat-bearing atlas. Defensive hands-first save uses existing weapon-free dive; validate weapon visibility transition or keep the stick slide if the swap looks distracting. |
| Guardian idle, wake, roar, ranged tell/aim/recoil/recovery, melee tell/sweep/slam/recovery, hit/stun/defeat/rubble | New 4×4 south-facing guardian source. Weapon modules attach separately; stationary boss avoids missing directional footage. |
| Cannon, hook, maul, optional crown; cover intact/cracked/rubble; closed gate | New equipment source sheet. Gate only if existing closed-goal scene cannot be reused cleanly. |
| Dodgeball spin/squash/recovery; boss bolt, chain segment, impact, soul marker | New equipment source sheet. Use skeletal transforms for hook extension/maul travel and cosmetic particles for decay. |
| Court floor, walls, crowd, flames | Existing unmarked floor and surrounding arena, goals closed. No replacement full arena required. |
| Center line, attack lanes/arcs/disks, pips, countdown rings, target/possession/revive markers, HP bars | Deterministic vector graphics at native resolution; use symbols and text as well as color. Source SVG design sheet included; runtime draws from geometry. |

Dodge clips: `catch-ready → catch-contact → carry`; `throw-windup → throw-release → throw-follow`; `pass-release → carry/idle`; `hit-recoil → recovery`; existing `dive → catch-contact/push-up`. Release frame must coincide with simulation release, not an animation-completion callback. The held ball is a separate sprite with per-pose/direction socket metadata; do not bake it into character art. Dive sockets sit near the leading hands, and the ball remains there during possession recovery.

Normalize athlete poses to the existing 44px standing scale, 112×80 frame and (56,70) anchor. Keep low poses low rather than stretching them to 44px. Use eight direction names from `spriteHeading`, not raw world axes. Apply existing material-restricted team palettes only after inspecting new teal masks; do not recolor skin/ivory armor. Guardian target height approximately 78px at size 1, allowing room for attack tells on the 640×400 canvas. Use nearest sampling. Preserve alpha; inspect edges on light and dark backgrounds.

Acceptance: every frame complete, no neighboring-cell bleed, no weapon/ball accidentally baked into athlete hands, back directions truly rear-facing, constant identity and foot placement, hand sockets follow catch/throw, guardian/weapon layers align at all sizes, cover collider matches footprint. Inspect both native and 3× playback. Source-sheet generation is not proof of these shipping conditions. Do not label an unintegrated source kit a runtime atlas.

Audio needs no external sample purchase: extend original synth cues for catch, ding, out, possession expiry, boss tell/release, cover crack/break, down/revive and victory. Each weapon gets a distinct warning rhythm. Avoid stacking four life-loss sounds at full volume; retain the existing bounded voice owner and separate effects gain. Sounds are implementation work, not delivered recordings in this package.

## 6. Implementation work breakdown

### Milestone A — shared contracts and isolated foundations

1. Add IDs/descriptors/profiles in `sim/contract.ts`, `sports-spec.ts`; add exhaustive dispatch and reset policies in `sports.ts`, `session.ts`. Introduce discriminated mode state rather than unrelated optional booleans. Do not alter current mode rules.
2. Define mode policy for competitive/cooperative allegiance, seats, switch eligibility, targeting, friendly contact, results and special availability. Keep seat/participant identity separate from combat allegiance. Audit `team` comparisons in AI, pass targeting, input switching, presenters, lobby and server model; existing two-team fields may persist as cosmetic/legacy slots but cannot control co-op damage or rescue.
3. Mode-owned court builders close goals and introduce center constraints/cover. Use existing circle geometry and swept contacts. Add fixtures before changing any reusable engine primitive.
4. Define finite, bounded snapshots: dodge lives/catch windows/ball state/possession clock/round score; arena health/down/revive/descriptor/boss timeline/target lock/attack-hit sets/projectiles/cover/damage tokens. Preserve RNG state and command origins. Establish stable contact ordering and one terminal result edge.

Exit: create/reset/capture/restore each new mode headlessly, reject malformed state, no changes to legacy snapshots except deliberate version migration/rejection.

### Milestone B — Dodgeball playable slice

Add `sim/modes/crypt-dodge/{index,spec,actions,ball,ai}.ts` (or equivalent compact modules), with catch-before-hurt resolution, possession/pass/throw states, life loss and elimination, half-court sweeps, timeout/sudden death, stuck-ball recovery and round transitions. Add contextual input labels and touch catch routing in existing input adapters; reapply existing ownership and cancellation policies. Implement bots with finite reaction delay, deliberate catches/dives and passing choices.

Import new athlete/ball frames to an independent atlas; wire `src/animation.ts`, `sport-presentation.ts`, `ball-presentation.ts`, `court.ts`, `presenter.ts`, effects and audio. Add a private practice fixture with trajectory/catch-window overlays. Leave specials disabled with honest UI.

Exit: two humans can finish best-of-three with bots, no crossing/duplicate balls/double dings; a pass-to-throw and a diving catch both visibly work with correct lives.

### Milestone C — one cooperative boss before randomization

Add `sim/modes/crypt-guardian/{index,spec,boss,damage,projectiles,ai}.ts`. Start with cannon, fixed seed, fixed size, two pillars. Exercise the exported damage/action/projectile primitives through explicit game adapters. Verify world/cover collision compatibility; `ProjectileOwnerV1` does not by itself prove the game's rectangular-world/cover rules. Implement ball damage tokens, recovery vulnerability, ally passing, rescue, bot roles and deterministic results.

Add health/results/HUD and cooperative lobby layout. Atlas loading must complete before play in local selection and room-code discovery. Integrate source guardian/equipment frames, hand/weapon sockets, depth sorting and attack geometry overlays.

Exit: one complete four-player cooperative fight with readable tells, destructible cover, ball recovery, revive, loss and victory. Measure orb engagement for all four players before adding content.

### Milestone D — legal boss variety

Add hook and maul timelines, two-phase patterns, size/palette/name descriptors, legal layout table, retry/new-seed controls. Use a generator version and resolved descriptor. Build a seeded gallery fixture rendering every family/size/layout and all warning footprints. Cosmetic RNG must not consume gameplay RNG. Reject unsupported combinations, never retry random generation indefinitely.

Exit: every mechanical family/size/layout is reachable, escapable and reproducible; no impossible telegraph unions, repeated target bullying, or lost ball behind guardian/cover.

### Milestone E — network, validation and release

Extend `protocol.ts`, `sim/checkpoint.ts`, build identity and server seating/matchmaking for both IDs; increment versions together. Reconnect restores exact round lives, catch/revive progress, boss HP/phase, cover and RNG. An eliminated/downed participant retains identity; bot takeover inherits state and cannot resurrect them. Preserve server admission, ordered inputs and action-origin receipts. Predict movement/action tells if supported, but confirm catch/damage/revive/defeat feedback once from authority; do not predict a pip disappearing and replay the sound twice.

Keep projectile count ≤3, cover bodies ≤2, boss count 1 and exactly one player ball. Bound target-hit sets by four athletes. Audit payload against current 4096-node/64-entry checkpoint bounds instead of blindly raising limits. Restore and replay during every active phase, including held ball, diving catch, hook pull, broken cover and revival. Make room sport and cooperation labels explicit in invitations and results.

## 7. Verification and tuning gates

| Area | Required evidence |
|---|---|
| Dodge contacts | Earlier body hit beats later catch; same-contact legal catch beats ding; wrong-facing/recovery catches fail; two-player ties stable; max-speed throws do not tunnel; wall/floor kills threat; one life per throw. |
| Possession | Pass timer cannot reset; eliminated target safe fallback; catch while holding primary cannot auto-throw; ball-on-center recovery works; held ball and dive cannot duplicate; no cross-half motion through dash/restore. |
| Boss combat | One hit/target/attack; quick/charged/assisted damage caps; zero-speed overlap cannot farm HP; cover takes projectile first; simultaneous boss/party defeat rule; legal revive and once-per-encounter limit. |
| Boss geometry | All legal size/layout footprints; world-clipped pull; unblocked rescue; maul safe paths; attack tell geometry equals collision geometry; target locks do not track late movement. |
| Networking | Checkpoint equality in Chromium/Firefox/WebKit; scripted four-player authority; reconnect in every nontrivial state; delayed/duplicated event intake; no duplicate health cues; four allied seats never steal ownership. |
| Presentation | All eight athlete facings, hand/weapon anchors, full boss defeat, cover depth, native/mobile HUD, reduced motion, muted audio playability and lazy-load failure recovery. |

Run the repository's relevant commands after implementation: `npm run test:cryptball`, `test:cryptball:network`, `test:cryptball:determinism`, `typecheck`, `check:game-boundaries`, `check:game-purity`, `build:cryptball`, `build:cryptball:server`, plus browser fixtures for each new mode and `test:cryptball:network-benchmark`. Existing failed replay performance gate remains a release issue; record target-device measurements and do not lower physics frequency or weaken assertions to conceal it.

Human sessions: at least three groups spanning novice, mixed and experienced players; run 10 Dodge rounds and each boss family per group, including touch and 100–150 ms network conditions. This is an initial tuning sample, not statistical proof. Log throw/catch/dive success, lives lost, possession expiries, round duration, pass-assisted hits, boss attack hit rates, rescue attempts, time without touching the orb, and each player's contribution.

Desired first-pass outcomes: Dodge rounds mostly 35–75 seconds, deliberate standing catches ~25–45% against readable throws, useful but costly dives, neither starting side consistently winning. Boss fights 90–150 seconds; novices win after learning in 2–4 attempts, and all four players regularly move, save/pass/strike or rescue. Single-ball co-op can leave three players idle: if any player routinely has >15 seconds without a useful action, first improve return lanes, AI outlets, rescue opportunities and boss targeting, rather than adding extra balls. If that still fails, explicitly revisit the one-ball cooperative premise before adding complexity.

Tuning order: readability and input reliability → ball return/possession flow → catch/tell windows → movement/throw speeds → damage and HP → cosmetic variety. If Dodge becomes catch spam, increase failed-catch recovery before increasing shot speed. If one survivor is helpless, widen defensive space/reduce charge advantage before granting extra lives. If bosses feel like damage sponges, reduce HP and increase recovery rewards; if cover trivializes cannon, tune its durability and fan gaps while keeping a viable escape route. Human feedback must verify that these modes are fun; automated survival rates cannot establish that.
