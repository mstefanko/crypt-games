# Mode-specific balls: engine boundary and implementation plan

Date: November 4, 2026. Status: implemented and verified by supervised GPT-6.1 Sol agents. See the [delivery report](cryptball-mode-balls-delivery-2026-11-04.md) for actual changes, checks, evidence and remaining balance limits.

## Outcome

Give Cryptkick a readable, controlled rolling football and Rift Volley a larger airborne volleyball with distinct spin and contact response. Preserve original Cryptball behavior and artwork. Size must agree across collision, prediction, AI, sprites, shadows, effects, and multiplayer replay.

## Evidence and rationale

The existing shared orb occupies an 8×8 atlas frame. Ground physics uses radius 3; Volley embeds that value in wall limits (163/93), its net slab (±3), and net clearance (height + 3). Volley floor contact currently uses z=0. Live motion integrates four 240 Hz substeps with integer displacement remainders, while AI landing uses 60 Hz truncation and presentation uses a continuous quadratic. A radius-only edit would leave inconsistent geometry and prediction.

Real volleyballs have circumference 65–67 cm and mass 260–280 g; footballs have circumference 68–70 cm and mass 410–450 g. The larger Volley presentation is deliberately for arcade readability, not literal physical scale. Size changes contact clearance; it does not by itself prescribe gravity, mass, rolling resistance, or rebound.

Sources: [FIVB rules](https://www.fivb.com/wp-content/uploads/2025/01/FIVB-Volleyball_Rules2025_2028-EN.pdf), [IFAB Law 2](https://www.theifab.com/laws/latest/the-ball/), [NASA drag equation](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/drag-equation/).

## Boundary decisions

| Responsibility | Owner | Reason |
| --- | --- | --- |
| Fixed-point displacement carry, acceleration stepping, bounded free-flight prediction and launch math | `packages/game-simulation` | Reusable deterministic kinematics; no teams, ball art, court, scoring, or sport IDs |
| Closed segment/AABB interval query | `packages/game-simulation` | Generic geometry with explicit tangency semantics; reuse for ball-expanded net slab |
| Moving circle sweeps, action timelines/hit receipts, seeded random | Existing engine APIs | Already correctly shared; reuse rather than replace |
| Ball size, resistance/rebound coefficients, flight duration | Game sport profiles | Authored balance, not universal physics defaults |
| Possession spring, traps, tackles, action reach, legal halves, net/floor/wall fault policy, scoring | Game simulation | Rules and intentional arcade approximations |
| Applying generic flight math to ball state; AI and visible landing estimate | Shared game flight wrapper | One state mapping, consistent radius/floor/config for all consumers |
| Atlas loading, clip playback, projection infrastructure | Existing runtime/asset APIs | Reuse existing primitives |
| Ball art, spin cadence, impact squash/recovery, contact poses/effect styling and net draw order | Game presentation/assets | Sport art direction; no universal ball renderer in the engine |

Do not retrofit `BallisticWorld`: its static targets, finite lifetime, response budget and residual-motion behavior are a poor fit for indefinite rallies and moving athlete contacts. Do not change existing open-interior `geometrySegment` semantics. Add a separately named closed-boundary query with tests. Do not migrate unrelated games or add a rigid-body/mass/spin solver for this change.

The user's explicit request authorizes appropriate engine changes. Keep any engine-protection tooling intact; no blanket policy exemption is part of this plan.

## Initial tuning

| Parameter | Cryptball | Cryptkick | Rift Volley |
| --- | --- | --- | --- |
| Physical radius, authored units | 3 unchanged | 4 | 5 |
| Ball artwork | Existing orb unchanged | 8px solid panelled ball | 10px solid curved-panel ball |
| Rolling deceleration | 30 unchanged | 36 units/s² | Not used |
| Board restitution | 0.90 unchanged | 0.82 | Wall is still a fault |
| Dribble offset | Not applicable | 12 (was 11) | Not applicable |
| Setup flight | Not applicable | Existing kick/pass speeds | Set 64 ticks; dig 72 (was 58/66) |
| Gravity/attack flight | Existing | Existing | Gravity 240; existing attack/serve timings |

These are starting values subject to evidence-led adjustment. Increasing ground radius narrows the available center corridor through a 60-unit goal mouth from 54 to 52 units. Longer Volley setup durations add 100 ms without making attacks universally slower. Do not introduce aerodynamic drag merely because size changed.

## Workstream A: engine primitives — Sol engine agent

1. Add bounded, typed, deterministic fixed-flight math with signed displacement carries and semi-implicit vertical acceleration. Keep integer units and stepping frequency explicit. Live integration and prediction must call the same primitive; launch math must account for the discrete integrator and target floor height.
2. Add a closed segment/AABB interval helper for planar `(x,z)` net slab intersection. Include stationary embedded points, vertical descent, boundary and corner tangency. Keep bounds expansion and conservative rectangular net-contact policy game-owned and documented.
3. Export public package subpaths; add focused tests and register in the fast engine test manifest. Cover signed carry conservation, partial intervals, launch/landing agreement, prediction bound, exact boundary touches and invalid inputs.
4. Coordinate concrete signatures with the simulation agent before consumers are finalized.

## Workstream B: sport simulation — Sol simulation agent

1. Add immutable profiles selected by `sportId`, with explicit unit conversion at simulation boundaries. Thread profile values through ball sweeps, player/ball separation, drag/rebound, goal clearance, passing lanes and rollouts. Legacy default parameters preserve original Cryptball's path.
2. Update Cryptkick dribble offset and make trap/tackle/strike reach policy explicit. Preserve authored assistance rather than accidentally scaling every reach by sprite area. Keep AI and physical eligibility synchronized.
3. Standardize Volley z as center height: floor at radius, walls at court extent minus radius, net slab expanded by radius and top at netHeight+radius. Update launch targets, serve location, contact-height interpretation, and event payloads. Retain earliest swept fault/contact ordering and existing rally rules.
4. Export one game-level `predictVolleyLanding` wrapper for both AI and renderer, using engine integration and current carries. Prediction must expose whether a bounded rollout landed; it predicts free flight, not future player interventions.
5. Use actual ball contact coordinates and center height for impact events. Include velocity data if needed for event-driven presentation, without changing authority or adding cosmetic state to checkpoints.
6. Bump checkpoint semantic version for changed height semantics; reject older snapshots. Preserve atomic restoration, sport identity, and mixed-input takeover. Build identity must include new transitive engine sources; protocol shape changes only if actually needed.
7. Add regression coverage for per-mode profiles, dribble clearance, post/goal edges, net grazes, floor/dig timing, matching landing prediction, and legacy behavior. Run simulation and network tests.

## Workstream C: sprites and animation — Sol presentation agent

1. Add actual native-size ball sprite assets with distinct panel designs and spin frames, plus Volley impact squash/recovery frames. Prefer a separate compact ball atlas to avoid rebuilding unrelated athlete art. Follow the existing asset/provenance workflow; deterministic packing must reproduce outputs.
2. Keep original orb rendering unchanged. Use profile radius for sports silhouette, ground offset, shadow footprint, trail width, occlusion locator and net depth ordering. Volley center is projected court position minus center height, without the old extra offset. Decorative glow is outside the physical silhouette.
3. Animate contact from delivered simulation events: gentle receive/set response, stronger spike impact, and dig/serve variants. Place airborne impact effects at the ball's event position and height, not at player feet. Restore round shape after contact; cosmetic deformation never modifies collision radius.
4. Inspect existing receive/set/spike/dig athlete poses against contact timing. Reuse correct authored frames, fix sampling/alignment where needed, and create new poses only when existing art cannot represent the interaction. Never stretch anatomy to hide a geometry error.
5. Preserve pause/reduced-motion behavior, reset/rewind cleanup, event deduplication, and state isolation. Use the shared game landing predictor instead of a renderer-only parabola.
6. Produce an inspectable ball/impact contact sheet and browser evidence in all modes. Test profile/frame selection, event timing/expiry, reset, reduced motion, and matching landing cues.

## Supervised integration and acceptance

The parent owns this plan, boundary review, cross-workstream integration, evidence and delivery notes. Agents share the existing checkout and must preserve all unrelated dirty work; their file ownership is disjoint.

After focused checks, run TypeScript, game boundaries and simulation purity, the fast engine suite, Cryptball unit and network suites, Chromium/WebKit/Firefox determinism, solo/practice production browser acceptance, and multiplayer browser acceptance. Regenerate client/server build identity and builds together. Inspect actual rendered balls and impact sequences at native play scale, including floor/net contact and reduced motion. Compare seeded full-match behavior for stalled matches, diagnostic events, rally lengths, scoring and fault patterns; bot tests do not substitute for human balance feedback.

Refresh the existing local preview and local match service only after validated builds, preserving their settings. Record exact successful checks and any genuine limits in a delivery note. No public deployment or unrelated engine rewrite is part of this task.
