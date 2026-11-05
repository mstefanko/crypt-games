# Hockey feel implementation plan — reviewed revision

2026-11-05. User authorized implementation with GPT-6.1 Sol agents. This supersedes the initial plan, preserved in `docs/evidence/cryptball-hockey-feel-2026-11-05/original-plan.md`.

## Review validation

| Review item | Validation and disposition |
|---|---|
| Puck-to-blade retention sees the carrier as an obstacle; instantaneous aim turns trigger it | Confirmed in `control.ts`, shared `actions.ts` and isolated reversal probe. Fix first, separating responsive aim from the physical carry pocket. Do not change other sports' heading rules. |
| This explains essentially all unreachable losses | The failing predicate is confirmed: in our 3 scenarios × seeds 42/123/999, every unreachable loss failed puck-to-blade clearance. Qualification: self-body is not the sole obstruction. In normal faceoff seed42, 138/160 failures involve the owner, but 116/160 still fail with owner excluded; only 44 clear with that exclusion alone. In idle-human runs all 49 failures remain with owner excluded and none fail owner-only clearance. Fixing owner clearance alone cannot be claimed to solve those cases. |
| All small-turn idle losses are self-body grazes | Not reproduced by the independent diagnostic. Other-player obstruction explains that failing lane in our current tree. Preserve the finding as a difference in evidence, not a reason to reject the narrow first fix. |
| Passive body contact strips possession and starts global delay | Confirmed `ball.ts` touch attribution → `cryptcheck/index.ts` lastTouch mismatch. Decide explicitly: passive contact remains solid and records the actual touch, but does not itself remove canonical possession; actual geometric escape or intentional poke/check can. Keep other sports unchanged. |
| Faceoff symmetry, microscopic inconsistent tie threshold | Confirmed: mirrored start/approach, no initial puck-drop motion; sort by blade distance but tie by body distance ≤1 fixed unit (1/256 world unit). Add a deterministic, balanced puck-drop mechanic plus consistent contest metric. Random bot aggression is not the remedy. |
| Networking must accompany every saved-state slice | Accepted. Validate checkpoint, restoration, command transport and prediction as each state change lands; final full network test is integration confirmation, not the first test. |
| Shared heading/ball code risks other sports | Confirmed. Gate any necessary shared contact/invariant change on hockey; retain regression tests for all sports. No engine rewrite. |
| ID-derived support lanes and straight carrier | Confirmed in hockey AI. Replace with geometric lane choice, pressure-aware escape and separate evasive dash. |
| Too many inputs; dive deferred | Accepted. Keep poke, check, dash distinct; add only Check (E / touch button). No dive command or C binding in this iteration. |
| 0.7s knockdown too expensive in 2v2 | Accepted as balance risk. Begin at a tunable ~24 ticks (0.4s total fall/down/get-up), immunity through recovery plus grace. Human playtesting must settle duration. |
| Block new art pending playtests | Accepted. Existing loaded sports atlas has matching seated slide/low rise/upright recovery in eight directions and six palettes. Use those for prototype victim motion with stick stowed; use existing shoulder/poke/skate/stickhandle poses. No new sprite generation this iteration. |

Evidence: `review-diagnostic-before.json`, `review-diagnostic.test.ts`, `review.config.ts` in the evidence directory. The diagnostic hooks the real retention call without changing gameplay and records all failed predicates, not only the first. Static obstructions were absent in the measured failing lanes. The original baseline remains preserved. Base commit `6b1136dd1f3f0e59a6ccb20beee7f2a2eb84efa7` plus substantial existing untracked/modified app work; preserve unrelated files.

## Implementation order and gates

### 0. Narrow possession fix and measurement

Exclude the owner from the *retention* puck-to-pocket obstruction test. Keep the owner solid in puck movement and constrain physical carry-pocket rotation separately from instantaneous aim, so this exclusion cannot drag the puck through the torso. Use bounded authority updates and feasible carry paths, no teleporting. Retain stable ownership through normal turns/brakes/dash and action preparation when legally reachable; release on actual strike/pass contact or loss of reach. Preserve actual passive touch attribution without stripping possession merely because lastTouch changed.

Store all new carry phase/heading/timers canonically in hockey-only state, with exhaustive validation/reset and observation/prediction compatibility. Remove hockey-only incompatible legacy checkpoint invariants. Add sharp-turn, slow graze, passive-body, opponent obstruction, high speed, stationary carry and restore tests. Run existing hockey tests and checkpoint/prediction fixtures. Rerun the original 3×3 workload before proceeding, record improvement and remaining stalls separately. Do not attribute AI or faceoff gains to this fix.

### 1. Faceoff and loose-puck contests

Introduce an explicit deterministic puck drop at the ready→play transition. Alternate/mirror drop directions or use a persisted seeded choice with symmetric distribution; no permanent low-ID/team first-possession award. Test faceoffs with specials disabled and across mirrored teams/seeds.

Rank and tie using the same blade metric and a meaningful world-unit tolerance. A neutral contest should produce a bounded physical outcome with one receipt/short contest cooldown, not an unchanged repeat forever. Remove the global 12-tick acquisition embargo; use per-releaser recapture timing, leaving opponents/receivers eligible. Preserve no-through-body/board acquisition and swept contact receipts. Validate restoration/prediction during drop, contested contact, and recapture timing.

### 2. Pursuit, roles, spacing, carrier escape

One committed collector per team, selected using feasible arrival, current velocity, availability and actual human movement intent. An idle or blocked human cannot reserve collection indefinitely. Store short commitment/progress/approach-side state explicitly; do not overload unrelated generic AI fields with undocumented meanings.

Use local separation, board-legal approach positions and bounded lateral detours. After ~30 ticks without useful progress, reapproach or hand off collection. Support chooses a lane relative to carrier and obstacles; defenders remain goal-side. Carriers choose escape space and can dash away from pressure; do not drive through opponents. Both shots and passes respect decision cooldowns. Pokes are deliberate edge requests followed by reassessment. Test idle-human stalls, corner/board routes, human pursuit respect, support lane geometry, carrier evasion, mirrored teams and deterministic restore.

### 3. Separate poke/check/dash and prototype knockdown

Poke remains Shift/I/right mouse (existing slide command may remain a compatibility alias); one attempt per press, no held repeat. Poke hits only the puck and dislodges without guaranteed ownership. Check uses E and a distinct authoritative command/timeline; directional tell→active→recovery, one victim hit receipt, actual closing contact, miss recovery. Dash stays Space/L, preserves reachable carry, and cannot body-check or phase through bodies. Dive is deferred entirely.

Start check tell/active/recovery around 7/8/20 ticks; victim fall/down/get-up around 6/8/10 ticks, all authored tuning. Prevent repeated knockdowns through recovery/grace, downed pickup or attack, and action-cancel loopholes. Audit Rams/Foxes/Bats/Gators and input edges. Check must remain distinct from charge special. Test face-to-face, grazing/miss, stationary/retreating contact, boards, downed bodies and two opponents. Add check command to session/protocol/server allowlists; bump actual checkpoint/protocol versions and validate old-version rejection, reconnect and prediction before finishing this slice.

### 4. Existing-art presentation and controls

Select existing stickhandle while carrying; animate the stick using real carry heading/phase and keep the visible puck at authoritative position. Do not render a fake puck away from collision. Select check shoulder during tell/active/miss recovery, not just after a contact event. Victim uses loaded sports slide then low/upright get-up before returning to hockey recovery. Special overlays cannot hide committed checks or knockdowns. Respect heading, interpolation, depth order and reduced motion.

Touch retains move, pass/shot and dash gestures. Label flick correctly as poke in hockey. Add one explicit ≥44px Check button beside READY; preserve pointer ownership, cancel/blur behavior and other sports' touch controls. Help states actual bindings. No new art; assess existing-pose readability in browser. Human playtest feedback is required before approving newly generated sheets.

### 5. Integration and tuning

Run focused mechanics/AI/input/animation tests as slices land; then full app regression, network, browser, deterministic replay/checkpoint, type and sim-purity/boundary checks, client/server builds. If any engine primitive must change, follow engine protection requirements first. Compare before/after 3×3 diagnostics, plus longer multi-seed/mirrored workloads; report possession spans, actual stall duration, shots/passes, poke attempts/hits and checks. Do not mistake a fixed puck held by a stationary owner for a loose-puck stall.

Playable acceptance: collect, carry, turn, pass, shoot and evade deliberately; bots escape blocked pickup routes; faceoffs begin without a special; poke and check have different risks; check victim visibly goes down and returns quickly without stun chains. Human solo/two-player and physical-phone balance/readability remain explicit limitations until performed. No public deployment or new art generation is authorized by this implementation iteration.

## Ownership

Mechanics agent: hockey simulation except AI, canonical schema/checkpoints, command protocol/server validation, focused mechanics/restore tests. First stop after stage0 for isolated measurement.
AI agent: `sim/modes/cryptcheck/ai.ts` and focused AI tests; coordinate all schema needs with mechanics. Begin only after stage0 measurement, then land role/pursuit slice.
Presentation agent: input/touch/help, animation/presenter/special guards, focused UI tests. Implement against agreed hockey state; existing art only.
Parent: validate review, maintain this plan, preserve/reproduce diagnostics, integration fixes/review, run cross-slice checks and provide playtestable build/results. Shared-file changes must be coordinated; no commits or destructive cleanup of existing work.

## Stage0 gate (measured before AI/faceoff edits)

Completed narrow carry/body-contact slice with checkpoint11/protocol9. Focused carry + hockey + sports simulation: 61 tests passed; online-client: 26 passed including actual pending-input correction/replay while turning and dashing. The 3×3 workload passed after giving this research harness a 30s timeout (default 5s was shorter than the ~7s workload; no gameplay timeout changed).

Normal all-bot seed42: owned time 6.0%→28.8%; mean completed span 1.27→18.58 ticks. Seeds123/999: mean 1.58→17.22 and 2.03→18.05 ticks. Faceoff still stalls 746 ticks. Idle-human: owned time 18.8%→0.8%, static loose-puck stall 3345 ticks. This is a real remaining regression in the interim slice, not a final acceptable result: proceed with the already planned collector/obstacle escape fixes and require remeasurement. Evidence: `workload-stage0.json` with source hashes. Production changes beyond this slice were held until measurement completed.

## Delivered

All implementation slices are complete. See [delivery and validation](cryptball-hockey-feel-delivery-2026-11-05.md) for final measured results, test outcomes, controls and the remaining human playtest decisions. No dive or new art was added.
