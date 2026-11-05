# Cryptcheck — hockey mode implementation plan

Prepared November 4, 2026. Original scope: research, design, generated source art, and implementation plan. Implementation is now complete; see [the delivery report](cryptball-hockey-delivery-2026-11-04.md) for actual behavior, validation and remaining acceptance work. The evidence table below records the pre-implementation baseline. Repository: `game-runtime-m5`, current working tree, not an assumed clean commit. Recheck source versions before implementation: other work is present in this checkout.

## Recommendation and name

Ship **Cryptcheck**, displayed as **Cryptcheck · Hockey**. It retains the Cryptball/Cryptkick family, communicates physical checking, and is short enough for the mode selector. Use stable `cryptcheck` identity independently of future display-name changes. The descriptive Hockey subtitle is necessary because “check” alone does not explain the sport.

Alternatives: **Crypt Hockey** is clearest but less distinctive; **Cryptpuck** names the object but sounds less fluid; **Frostbound** is atmospheric but does not identify hockey and breaks the sport naming pattern; **Rift Hockey** fits Rift Volley but weakens the Crypt family. This is a product naming recommendation, not a trademark clearance.

The distinguishing loop is accelerate → glide → receive in front of the stick → draw a defender → pass or wind up → chase a rebound. Low puck drag, committed player momentum, visible stick reach, and deliberate stops must distinguish this from soccer with a different ball.

## Evidence from the current code

| Source | Observed behavior | Consequence |
|---|---|---|
| `sim/sports-spec.ts` | Three descriptors/profiles; current kick and volley radii are **6**, despite older delivery notes reporting 4/5 | Read code when baselining; add an explicit fourth profile |
| `sim/session.ts` | 60 Hz authority; non-Cryptball dispatch through `stepSport`; capture currently version **8** | Keep one session/controller/rollback implementation |
| `sim/sports.ts` | Kick and volley implementation and AI in one large file; `stepSport` treats every non-kick mode as volley | Exhaustive dispatch is a prerequisite |
| `sim/actions.ts` | Shared admission, charge, pass targeting, strike resolution and steering; steering stops toward zero in a few ticks; special velocity can bypass it | Hockey needs an explicit motion/action policy, not a friction constant alone |
| `sim/motion.ts` | Four 240 Hz displacement substeps; signed carries; swept player paths and post-separation correction | Reuse geometry integration, preserve piecewise path semantics |
| `sim/ball.ts` | Swept contacts, earliest goal vs collision, bounded contact work, pinches, drag carry; speed cap, rest threshold, post/body restitution and power-bank behavior partly global | Parameterize the remaining ground-object policies with exact legacy defaults |
| `sim/court.ts`, `sim/spec.ts` | Rectangular 332×192 world; existing goal mouths/posts, cached bounds, no behind-net player route; four field players | Retain arena topology and 2v2 for v1; do not paint rounded boards with rectangular collisions |
| `sim/checkpoint.ts` | Possession explicitly allowed only in Cryptkick; other ground sports require z/vz/rz = 0 | Add validated hockey state and version the schema |
| `protocol.ts` | Protocol **6**; independent hardcoded three-sport predicate | Consolidate or update transport validation, don't just extend the menu |
| `sim/specials.ts` | Six team specials, automatic bot admission, direct velocity ownership | Add intentional hockey policies and tests; otherwise skating can be bypassed |
| `src/animation.ts`, `src/presenter.ts`, `src/ball-presentation.ts` | Non-Cryptball defaults select sports/kick/volley clips and rolling/squashing ball visuals | Exhaustive visual profiles; flat puck must never squash or roll like a football |
| `scripts/game-assets/import-cryptball-sports.py` | Generated directional poses, shared material palette, fixed foot pivots, clip aliases, extracted floor | Extend tooling through shared helpers; independent hockey manifest |
| `apps/cryptball-server/identity.mjs`, server model/room and online tests | Shared build identity, mode-aware rooms, reconnect, authoritative checkpoints | Reuse transport; include all new simulation dependencies in identity |

Existing `src/{motion,ball,court,...}.ts` compatibility exports are not competing simulation implementations. Do not “merge duplicates” that are deliberate facades. The source has team specials and newer protocol/checkpoint changes absent from earlier sports delivery reports.

## Match, controls, and rules

Retain solo, practice, Quick Play, private room, bot fill, controller switching, team selection, 90-second matches and sudden-death overtime. Four skaters, no dedicated goalkeeper. Existing side-wall goals remain, including no route behind the net. This is dungeon arena hockey, not a regulation rink simulation. No offsides, icing, penalties, periods, fighting, fatigue meter or roster expansion in v1. Center faceoff replaces soccer-style possession restart.

| Existing action | Hockey behavior |
|---|---|
| Move | Push in desired direction; neutral input coasts; opposite input brakes before reversing |
| Aim | Rotate stick/body aim without instantly rotating velocity; existing pointer/gamepad aim remains |
| Strike tap | Quick wrist shot from actual blade/puck contact |
| Strike hold/release | Slapshot windup; full charge has more speed and recovery, no magical bank boost |
| Pass | Low push pass using existing teammate targeting/lead; incoming pass + strike contact creates a one-timer |
| Dash | Short skate burst in committed movement direction, exposes puck and suspends control |
| Slide / legacy guard | Short committed stick/poke check, no soccer feet-first slide; one puck hit receipt |
| Special | Existing six team identities, adapted below |
| Switch/cancel | Existing switching; cancel clears charge/input but does not erase physical momentum |

No new binding is required. Brake is opposite movement input; add a short practice instruction and an ice-stop cue. Don't multiplex body-check vs poke-check based on whether a target happens to exist on a client. Ordinary body contact separates bodies; a dash may shoulder-check once per opponent using existing action receipts/immunity. A poke-check only affects the puck. Striking never damages/stuns athletes.

Faceoff: 45 ready ticks with the puck at center and two mirrored lead skaters outside a radius-18 center exclusion; partners start behind them. Freeze action admission and clock during ready. On the whistle release both teams symmetrically, with no possession owner or restart protection. Resolve equal-time stick contests as a clash that leaves a neutral puck, rather than always awarding the lower player ID. Alternate within-team lead athlete after goals; checkpoint that choice. Practice resets use the same central puck with opponent participation disabled consistently with other ground sports.

Whole-puck goal rule for hockey: require the trailing edge to cross the goal line (`side*x >= goalLine + radius`), with full lateral clearance. Use a profile setting so existing sports retain their center-crossing behavior. Post collision wins an exact tie with a goal crossing; score once, then stop integration and advance phase. Own goals count for the opposing team using existing attribution semantics. Preserve the current end-of-clock ordering, with an explicit test for a goal on the final live tick.

## Ice and puck model

Physical inspiration: skate glide and lateral edge grip are different effects. Ice friction also depends on speed, pressure and temperature; a single literal real-world coefficient is not a faithful model. [Primary experimental/model study, Physical Review X](https://journals.aps.org/prx/abstract/10.1103/PhysRevX.11.011025) and [hockey skate performance research](https://www.sciencedirect.com/science/article/abs/pii/S0165232X11001649) support this distinction. Use a deterministic authored arcade response, not thermodynamic simulation. The [IIHF rules index](https://www.iihf.com/en/static/55352/rules_regulations_guidelines) is the reference for regulation hockey; the deliberate exclusions above keep this game readable and continuous.

All values below are **initial tuning proposals**, world units, not measurements or validated balance. Keep one immutable hockey tuning object with versioned authority/build identity.

| Parameter | Start value | Intent |
|---|---:|---|
| Skater cruise / burst cap | 120 / 180 units/s | Distinct push without crossing the small court instantly |
| Forward push | 420 units/s² | About 0.29 s to cruise from rest |
| Neutral glide deceleration | 75 units/s² | At cruise about 1.6 s and 96 units to rest before contacts |
| Counter-input braking | 720 units/s² | About 0.17 s / 10 units stopping distance at cruise |
| Lateral correction cap | 300 units/s² | Curved turns; no instantaneous right-angle velocity change |
| Puck collision radius | 4 units | Smaller than soccer, readable projected diameter ~10–13 px |
| Puck sliding deceleration | 12 units/s² | Long free glide, rather than rolling resistance |
| Puck stop threshold | 1 unit/s | Deterministic rest without visible jitter |
| Board / post / body restitution | 0.88 / 0.75 / 0.35 | Useful banks; softer body rebounds |
| Puck speed cap | 420 units/s | Max 1.75 units per 240 Hz substep before CCD |
| Pass / wrist / full slap speed | 180 / 260 / 380 units/s | Different risk and timing windows |
| Control offset / break distance | 14 / 24 units | Puck sits on an exposed blade, never in the body |
| Receive relative-speed ceiling | 170 units/s | Hard shots rebound unless deliberately met |
| Control reacquire delay | 12 authority ticks | Prevent immediate self-recapture after shots/checks |
| Poke tell / active / recover | 3 / 3 / 12 ticks | Readable commitment and one contact |
| Wrist tell / active / recover | 3 / 2 / 8 ticks | Quick release |
| Full slap tell / active / recover | 6 / 3 / 16 ticks | Telegraph and punishment for a miss |
| Full-charge threshold | existing 24 ticks | Preserve familiar control timing |

Skater velocity is authoritative. Project current velocity onto desired move direction and perpendicular direction. Approach forward target with capped push/braking, and reduce sideways slip by a separately capped edge-grip term. With no input reduce speed by glide drag, preserving direction. For opposite input, consume braking first; only unused tick time may accelerate the reverse direction. Aim heading must not steer glide velocity. Use existing integer heading vectors and deterministic norm/rounding helpers; no simulation trig, renderer delta time, or wall clock. Apply at 60 Hz before the four existing displacement steps; checkpoint any added acceleration remainders. Cap only propulsion appropriately: charge reduces thrust/turn authority rather than instantly deleting momentum. Project skater velocity away from blocking board normals to avoid perpetual inward thrust after a glancing collision.

Puck: use a circle collider in the ground plane and a thin cylinder/ellipse sprite. Keep z/vz/rz at zero; visual thickness is not simulation altitude. Flat slides, passes, wrist shots, slapshots and one-timers are in scope. Airborne saucer passes, bouncing on edge, tipping and spin-induced trajectory changes are deferred; adding them correctly needs a cylinder height/contact model, goal crossbar checks and ground/air transitions. Do not reuse volley's sphere center-height semantics by accident.

Apply constant-magnitude sliding drag with the existing carry approach once per live tick, never once per render or four times per tick. After contacts, preserve the tangential velocity and reflect only inward normal relative velocity by restitution. Stationary board impacts cannot increase kinetic energy; moving players and explicit stick actions may add energy, bounded by the puck speed cap. Keep contact budgets and diagnostics. Do not solve a pinch by teleporting the puck or raising the iteration cap blindly.

Stickhandling: adapt the soccer soft-control infrastructure, not its exact spring behavior. Eligibility requires puck inside a short forward blade capsule, low relative speed, no blocking board/body, and no charge/check/stagger cooldown violation. Ownership is assistance permission, not immunity. Use a bounded damped velocity correction toward the blade anchor; cap acceleration and correction speed, then send the resulting puck movement through the same swept collision path. Provisional correction acceleration 900 units/s², correction speed 80 units/s relative to owner. Never assign puck position directly. Retain owner body collision (unlike the current soccer owner exclusion) so a fast aim reversal cannot pull it through the skater. If unreachable, blocked, over-speed, burst/checking, or 24 units away, release control and preserve velocity. Clear control when charge starts so a stationary puck can be struck naturally, but a moving puck may escape during a long windup. No homing pass after release.

Stick contacts use authored world blade reach, not the sprite bounding box or a full circular aura. Approximate the low blade capsule with a short deterministic chain of circles using existing sweep queries; sample the motion over active substeps. One action receipt prevents repeat hits. Resolve body, board, stick and goal events on the same substep clock; earliest wins, solid world wins exact ties, then deterministic actor/action ordering, with explicit equal-opponent clash policy. Prefer a small game-owned contact-provider interface around the existing solver over a parallel hockey-only collision loop. Contact events include exact puck position, heading, incoming/outgoing velocity and action ID for presentation and replay.

## Engine/game boundary and refactoring

**No new physics backend or required engine feature for flat-puck v1.** Existing public circle sweeps, fixed-axis carry helpers, action timelines/hit receipts, RNG, runtime clocks, atlases and clip playback are sufficient. Rapier would add a second determinism/rollback contract without solving the game policy.

| Layer | Owns |
|---|---|
| Engine `packages/game-simulation` | Policy-free geometric queries, signed fixed-step math, action time/receipt primitives, deterministic RNG |
| Shared Cryptball simulation | Player/path integration, ground-object sweep loop, goals and match clock, stats, input admission primitives, replay/checkpoint plumbing |
| Hockey mode | Ice steering, puck profile, blade/control eligibility, faceoffs, shot/check choices, hockey AI and team-special adaptations |
| Game presentation | Ice mask/markings, flat puck sprite, skating/shot clips, event effects, help text and sounds |
| Server | Existing authoritative room lifecycle, sport selection, validation, queues and snapshots |

First split `sim/sports.ts` mechanically into `sim/modes/cryptkick.ts` and `sim/modes/rift-volley.ts`, with `sports.ts` retained as a compatibility dispatcher if useful. Capture replay hashes before and after; no tuning changes in this step. Add `sim/modes/cryptcheck/{index,spec,motion,control,actions,ai}.ts` only as size warrants. Avoid one tiny file per function.

Introduce an explicit `Record<SportId, SportSimulation>` or exhaustive switch with reset/step/phase handlers and a compile-time `never` failure. Keep pure sport metadata/types in a dependency-light module importable by protocol and browser without importing simulation/runtime cycles. Descriptors remain data; don't turn them into arbitrary global callbacks. Presentation uses a separate exhaustive art/animation profile registry.

Extend `GroundBallPhysics` into a game-local ground-object response profile: radius, sliding/rolling deceleration, rest speed, max speed, board/post/body restitution, whole-object goal crossing and powered-bank eligibility. All legacy values and ordering must remain exact defaults. Parameterize `capBall`, drag, goal crossing, dynamic body response and prediction together. Keep policy out of the engine's circle query. Reuse common touch/pass attribution and lifetime bookkeeping, but separate receiving/control decisions between soccer and hockey.

Separate action admission/cooldowns from action meaning and contact resolution. Existing Cryptball semantics remain intact. Hockey must not invoke soccer kicks, volleyball set logic, slide-body chains or powered-bank awards accidentally. Share phase timing/charge buffers; supply mode-specific shot speed, allowed contact surface, body-check eligibility and movement policy.

Separate special intent from velocity application: existing defaults preserve current modes, hockey applies bounded ice impulses/targets and its own contact policy. Rams: committed skating charge with one body hit; Foxes: lateral skate cut; Owls: preserve normal skating thrust while charging (not instant full-speed velocity); Gators: extended low stick sweep, not a seated soccer tackle; Bats: two short skate pushes with coast gap; Hornets: shorter next-shot tell/recovery. Preserve cooldowns and team identities initially, retaining clear visual telegraphs. Every mode/special pair needs validation; no silent direct `specialVelocity` bypass of hockey steering. Generated low-check and push poses plus existing special overlays cover these variations.

Engine extraction is conditional: if implementation exposes a missing policy-free bounded-vector approach or swept capsule helper with demonstrated reuse, propose it separately, define rounding/range/ordering, add engine tests/catalog/identity coverage, then consume it. A hockey-only spring, skate controller, arena, goalie or possession manager does not belong in the engine. Do not weaken purity/protection rules to import game code into packages.

Performance: preserve current cached static bounds and four-player small-N loops. Cache immutable per-mode physics profiles instead of constructing them in inner queries. Compute shared puck forecasts once per tick for both bots, cache team/player lookup per step where useful, and avoid repeated sort allocations for nearest teammate (stable linear minimum is sufficient). Profile before adding pools or an ECS. Reuse bounded scratch arrays only when reentrancy and rollback ownership are explicit; never serialize scratch caches. Lazy-load hockey atlases by selected mode; don't load all team/mode source sheets. Ice markings are cached graphics; trails/scratches have fixed lifetime/count and remain cosmetic. Optimize only with replay-hash equality and recorded before/after workload costs.

## Art inventory and integration

Generated source package: `apps/cryptball/art-src/hockey-v1/`. See its README, prompts and source manifest for exact inventory and provenance. Eight directional sheets × sixteen key poses give 128 hockey poses; matching existing teal/cream character and same view convention. Arena edit supplies ice texture. Puck/effect source supplies rigid puck, ice-stop spray and stick-contact cues. These are source assets, not a claim that the runtime atlas or game integration is already complete.

Generate/reuse decisions:

- Reuse walls, goals, posts, crowd, banners, team icons, UI, selection markers and special overlays. Existing scene registration remains authoritative.
- New stick-bearing ready/glide/push, wrist-shot, receive, slapshot, poke-check, shoulder-check, stop and relaxed recovery poses. Both hands and full sticks are generated together; don't bolt a stick onto an incompatible empty-hand swing.
- Existing weapon-free fall/push-up/celebration poses may be reused for brief incapacitated or celebration states, explicitly stowing/hiding the stick during those states. Return to generated stick-held recovery. Do not play running or soccer-kicking poses for active hockey.
- Teal source material is recolored through the existing six-team palette masks; do not regenerate all six teams or recolor cream trim/skin/steel/stick tape.
- Puck remains a rigid flat disk. No football squash frames or rolling cycle. A subtle top scuff can rotate cosmetically; a static frame is valid under reduced motion.
- Precise center line/circle, goal lines and crease markings are code-native geometry using `projectCourt`, not baked AI geometry. No blue lines suggesting an offside rule. Floor texture stays low contrast and has no physical cracks.

Importer work: factor reusable alpha/component extraction, palette material conversion, packing, manifests and QA from current Python importers into a script-local helper without changing existing output bytes. Add `import-cryptball-hockey.py`. Use current 112×80 frames, foot pivot (56,70), approximately 44px body height and nearest sampling. Scale from body/skates, not raised stick height; explicit anchors are required for slapshot/stop poses. Permit wider frames only if actual blade extent clips and all consumers support it. Record per-pose source rectangles, foot anchor, blade-contact anchor, source hash, palette and aliases. Avoid treating the stick as a detached component to discard. Build only the selected teams where the loader supports it, otherwise report packed size honestly.

Clip aliases: pass uses wrist windup/contact/follow; stickhandle alternates ready/receive subtly; burst uses push poses; full charge holds slap windup; partial charge uses wrist sequence; poke uses ready/poke/recover; shoulder-check uses generated shoulder pose then relaxed recovery; stop uses stop/glide. No generated full inbetween animation is claimed. The final contact instant must agree with active timeline and blade anchor; time art to simulation, never move authoritative puck to match a picture.

Mask only the registered floor polygon from `arena-ice.png`; retain existing live architecture/foreground/goals. At current runtime projection the corners are (122,132), (518,132), (596,305), (45,305) at 640×400. Match the importer’s exact coordinate transformation before extraction. Generated surrounding walls are reference context and must not replace registered cutouts. Check goal openings and foreground occlusion after compositing.

Audio: retain existing sound pipeline; add short synthesized scrape/stop, woody stick tick and muted rubber board knock using current audio facilities, with a distinct but restrained goal cue. No new externally generated audio is required. Stop/push sounds follow confirmed semantic events or bounded movement cues, never four substeps or repeated rollback delivery.

## Ordered implementation work

1. **Baseline and lock evidence.** Record current commit + dirty diff hash, current checkpoint/protocol/build identity, seeded event/checkpoint hashes for all three modes, asset hashes and replay timings. Read applicable engine protection instructions. Save current visuals and team-special results. Exit: reproducible baseline, not a historical delivery-note count.
2. **Behavior-preserving foundation.** Split mode implementations; exhaustive simulation/presentation registries; central sport validation; parameterize ground-response gaps and common action plumbing. Preserve legacy order/rounding and atlas bytes. Exit: all existing hashes and suites unchanged. Keep optional optimization separate from structural extraction.
3. **Hockey contract and skating slice.** Add identity/descriptor/tuning, mode-owned hockey state, validated reset/faceoff, skating and wall response. Reuse displacement paths. Exit: accelerate/coast/brake/turn tests, no-input pause/replay equality, playable debug movement without puck ownership.
4. **Puck and contact slice.** Add profile, whole-puck goals, blade swept reach, bounded soft control, pass/wrist/slap/one-timer, check receipts and neutral clashes. Exit: deterministic mechanics fixtures and actual blade/puck contact overlay; no center snapping or energy growth at static boards.
5. **AI and specials.** Reuse role/targeting infrastructure but predict puck and skater stopping paths with hockey rules. One forechecker, one goal-side lane defender; on offense carrier plus support/rebound receiver. Compare bounded direct and one-bank pass candidates using actual profile. Intercept where the puck will be, brake before overshooting, aim from puck, respect windup travel, use deterministic tie/RNG ordering. Add six special policies. Exit: seeded complete games, all actions/specials exercised, both sides can win; bot play does not prove human balance.
6. **Art import and presentation.** Package supplied sources, palettes and clips; load hockey atlas; masked floor plus cached markings; rigid puck, contact anchors, depth ordering, skate spray, audio and reduced motion. Exit: source/atlas QA and native-size animated proofs for all eight facings, six palettes and mode transitions; no extra runtime asset generation needed unless a QA defect requires correction.
7. **Online and schema integration.** Update SportId/descriptor/profile/transport validators, queue filters, invitations, bare-code discovery, lobby, help/results, practice and reconnect storage. Proposed next checkpoint **9**, protocol **7** because this adds authority state/semantics; rebase these numbers if they have advanced. Reject old peers/checkpoints clearly. Include hockey modules and any new engine helpers in identity closure. Reconnect resets stale prediction/event state and preserves control/cooldowns/faceoff. Exit: real local sockets, 2/3/4 human slots, bot fill/takeover, reload, rematch and cross-sport isolation.
8. **Acceptance, tune, optimize.** Run matrix below; collect real frame/replay/atlas data, then tune with humans for predictable braking, visible stick reach, pass usefulness and defender recovery. Apply justified allocation reductions separately with hash checks. Update delivery report with actual counts, screenshots and limitations. Build client/server together; no public deployment is part of this request.

Suggested authority state: `hockey: null | { faceoffLead: [playerId,playerId], controlId: playerId|null, controlReadyTick: number, ... }`, with per-player skating/action carries and receipts only where existing Player fields cannot express them clearly. Avoid duplicate possession fields: choose one canonical owner reference and adapt observation once. Keep inert hockey state null in other sports. Validate exact keys, finite safe integers, bounds, same-mode references, carry ranges, action clocks, ownership eligibility and zero ground height. Checkpoint every future-affecting value, including bot intentions and repeated-contact receipts; derived geometry caches and cosmetic spin stay out.

## Validation and acceptance matrix

| Area | Required evidence |
|---|---|
| Movement | Cardinal/diagonal equal caps; start/coast/brake/reverse durations; aim independent of velocity; wall tangent glide; stagger and six specials; carries across save/restore; no permanent wall push |
| Puck | Straight stop distance within integer tolerance; drag once/tick; max-speed tunneling through player/post/goal; moving relative contact; corner and multi-body pinch budgets; board energy monotonicity; rest clears carries |
| Stick/control | Behind-body/through-wall pickup denied; opposing tie clash; one receipt across four substeps; pass self-recapture delay; charging releases; high-speed receive bounces; puck can be stolen while controlled; blade anchor visible at contact |
| Rules | Whole puck vs center line; post/goal tie; own goal; last-tick goal; reset clears all control/action state; symmetric faceoff; overtime; practice reset and disabled opponents |
| Regressions | All existing modes' baseline replay/event hashes; team specials; unchanged source/packed assets; no hockey fallback into volley/kick code |
| Authority | Checkpoint round trip and malformed rejection; cross-runtime Node/Chromium/Firefox/WebKit hashes; mixed input, specials, takeover and restore; stale build/protocol rejection |
| Network | Sport-isolated queues/rooms; invite and bare code; reconnect while coasting, charging, checking, controlled puck and faceoff; authority advances through blur/bot cover; event dedupe after correction |
| Visual | Eight-direction frame contact sheets at 1×/3×; six-team material masks; thin blades visible, no clipped sticks/alpha fringe; floor registration; dark puck contrast; correct far/near occlusion; reduced motion; paused animation |
| Performance | Same-device seeded 12-tick rollback workloads before/after with warmups, median/p95 and allocations; end-to-end frame times separately; atlas/page memory; long-lived effects bounded |
| Feel | Human solo and two-human sessions: deliberate stop, overshoot recovery, readable charge, reachable passes, no ownership magnet, useful checks and no stun lock |

Use repository commands `npm run test:cryptball`, `npm run test:cryptball:network`, `npm run test:cryptball:determinism`, `npm run test:cryptball:browser`, `npm run test:cryptball:online-browser`, `npm run build:cryptball`, `npm run build:cryptball:server`, plus TypeScript, game-boundary and sim-purity checks. If an engine primitive changes, run its focused and required engine/protection suites. Extend existing test tables that enumerate three sports rather than adding only a disconnected hockey smoke test. Do not regenerate unrelated live builds during the planning/art phase.

## Risk decisions

- Biggest technical risk is shared solver policy leakage, not missing engine physics. Parameterize existing hardcoded behavior before tuning hockey.
- Biggest feel risk is mixing powerful soft control with low drag. Constrain correction and release early; use debug trajectories and human playtesting.
- Biggest art risk is direction/anchor inconsistency in generated poses. Source kit is key-pose art; directional interpolation and exact contact alignment remain importer/presentation acceptance work.
- Avoid broad redesign: no new ECS, generic sport scripting framework, goalie AI, full rigid-body puck, or rounded-rink collision system in v1. Rounded corners/behind-net play can be a later cohesive arena upgrade with matching art and geometry, not a visual-only change.
- All tuning and proposed refactors are recommendations. No tests of a hockey implementation are claimed in this planning delivery.

## Concrete file checklist

- `apps/cryptball/sim/contract.ts`, `sports-spec.ts`, `session.ts`, `checkpoint.ts`: sport identity, mode state, exhaustive dispatch and authoritative validation.
- `apps/cryptball/sim/sports.ts` → `modes/cryptkick.ts`, `modes/rift-volley.ts`; new `modes/cryptcheck/`: mechanical extraction first, then hockey rules.
- `apps/cryptball/sim/actions.ts`, `ball.ts`, `motion.ts`, `prediction.ts`, `specials.ts`, `match.ts`: narrow shared policies, common solver and goal/reset integration. `court.ts` topology stays unchanged for v1.
- `apps/cryptball/src/animation.ts`, `presenter.ts`, `ball-presentation.ts`, `effects.ts`, `audio.ts`, `main.ts`, `special-presentation.ts`: exhaustive hockey visuals, input/help labels, events, loading and special cues.
- `apps/cryptball/protocol.ts`, `src/online/session.ts`, `apps/cryptball-server/src/model.ts`, `room.ts`, `identity.mjs`: authoritative mode validation, protocol/build compatibility, persistence and queue metadata. Do not fork a hockey server.
- `scripts/game-assets/import-cryptball-hockey.py`, shared script-local extraction helpers, `package.json` asset command, new hockey runtime manifest/pages: consume supplied sources without changing old atlas bytes.
- Extend `sports-sim.test.ts`, `sports-invariants.test.ts`, `mode-balls.test.ts`, `animation.test.ts`, `sports-presentation.test.ts`, `ball-presentation.test.ts`, `specials.test.ts`, `specials-review.test.ts`; add focused hockey movement/contact fixtures.
- Extend `full-match-authority.test.ts`, `multiplayer-sim.test.ts`, `online.test.ts`, `online-socket.test.ts`, `online-client.test.ts`, `online-teams.test.ts`, `determinism/sports.ts`, `determinism.spec.ts`, `sports-smoke.spec.ts`, `online.spec.ts` to cover the fourth sport and new state transitions.

Source art QA completed for this planning delivery: ten selected PNGs; eight transparent athlete sheets with 128 nonempty poses; twelve puck/effect cells; all eight sheets successfully yield sixteen complete figures through the current component extractor. Prompt provenance, SHA-256 hashes, exact dimensions and component rectangles are saved beside the art. This structural check does not replace runtime animation/contact/palette acceptance.
