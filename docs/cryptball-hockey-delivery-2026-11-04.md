# Cryptcheck · Hockey delivery

Implemented November 4, 2026, in the existing working tree using three GPT-6.1 Sol agents for simulation, presentation/assets, and online integration, with independent integration review. This report records the delivered implementation of the [hockey plan](cryptball-hockey-implementation-plan-2026-11-04.md). No live service was restarted or deployment performed.

## Play

Select **Cryptcheck · Hockey** in Solo, Practice, Quick Play, or private rooms. Stable identity: `cryptcheck`. Existing controls remain: movement pushes the skater, releasing movement coasts, opposite movement brakes; aim rotates the stick independently. J/left mouse releases a wrist shot or charged slapshot, K passes, Shift/right mouse poke-checks, Space bursts and shoulder-checks, B uses the team special.

The puck remains an independent colliding body, including during soft stick control. Charging or bursting exposes it. Blade contacts share the swept collision clock with boards, posts and athletes; action receipts prevent repeated hits. Puck radius is 4, deceleration 12 units/s², board restitution 0.88 and speed cap 420 units/s. Pass/wrist/slap launch speeds are 180/260/380 units/s. Whole-puck goal crossing and 45-tick neutral faceoffs are hockey policies. All six team specials have explicit skating/checking behavior. Matches remain 2v2 with the existing regulation/overtime rules. No offside, icing, penalties, airborne puck or behind-net route was added.

## Foundation and ownership

No hockey-specific engine API or second physics backend was added. Existing engine geometry, action timelines, deterministic session, renderer and audio primitives remain the foundation. Shared **game-owned** ground-object profiles now specify drag, radius, restitution, speed/rest caps, goal crossing and contact policies. A game-owned swept-contact provider admits stick contacts on the existing integration timeline.

`sim/sports.ts` now dispatches exhaustively to separate Cryptkick, Rift Volley and Cryptcheck modules. Hockey owns its immutable tuning, skating, control, contacts and AI in `sim/modes/cryptcheck/`. Canonical possession fields are reused; only faceoff leads and check/poke receipts require hockey-specific checkpoint state. Presentation uses an exhaustive sport registry. Arena, teams, clocks, input, sessions, menus, networking and audio ownership are shared.

Checkpoint 9 and protocol 7 reject incompatible state/clients. Build identity follows directory imports and includes the new authority modules. Rooms, invites, queue separation, rematches, reconnect, bot takeover, practice and asset readiness all recognize hockey. Hockey atlas loading is cached and deferred until selection; joining by bare room code also waits for assets.

## Generated art

The source pack and exact generation provenance are in `apps/cryptball/art-src/hockey-v1/`. Eight directional sheets supply 128 authored stick/skating poses. A corrected north sheet grounds its blade; the superseded source remains preserved and excluded from runtime selection. Twelve diagonal contact poses use generated corrections, with taller 112×96 bounds and the unchanged (56,70) foot pivot; the other 116 pose selections are unchanged. Generated ice and puck/effects sources are included. Shared palette, extraction and packing helpers retain the six team materials. Reusable scenery and other existing sport assets remain shared.

The importer produces 781 frames/771 clips on 3 atlas pages (approximately 2.50 MB encoded, 12 MB decoded). The generated ice is masked exactly to the registered arena floor, with projected game-owned rink markings. The puck is rigid and does not inherit football/volleyball squash or rolling animation. Contact cues use authoritative events; reduced motion retains readable contact cues. Existing sports atlas outputs remain byte-identical after tooling extraction. Thirteen consumed source hashes and all twelve contact overrides are recorded; the final built asset files match the reviewed sources byte-for-byte.

Runtime contact evidence is in [visuals](evidence/cryptball-hockey-2026-11-04/visuals/): 24 actual authoritative shot/check fixtures across 8 directions, each captured normally and with reduced motion, plus debug views. These use validated checkpoints and actual input admission, not manually fabricated contact events.

## Validation

- Simulation/presentation suite: **174 tests passed across 23 files** after the bank-pass correction; TypeScript passed.
- Network/authority suite: **67 passed**, with one existing opt-in full-real-time socket test skipped. Includes four sports, two/three/four-human full matches and hockey reconnect fixtures.
- Production browser: **11 passed**, including hockey selection, practice and defensive input.
- Cross-runtime replay: **6 passed** in Chromium, WebKit and Firefox against Node, including complete hockey matches, takeover, all six specials and checkpoint restoration. Hockey 12-tick replay p95 measured **1.9/2/3 ms** respectively on this machine, below the 16.67 ms frame budget. See `evidence/cryptball-hockey-2026-11-04/determinism-*.json`; these measurements are workload/hardware-specific.
- Legacy regression: all six baseline/current workload hashes match exactly: full bot matches plus 2,400 mixed-input ticks for each original sport. The comparison includes RNG and events, excluding only the added null hockey field and outer checkpoint schema number. Evidence: `legacy-{baseline,current,comparison}.json`.
- Hockey seed study: nine complete games with checkpoint restore every 15 ticks, victories for both teams, draws/overtime and 1–6 completed passes per game. Evidence: `simulation-validation.json`.
- Bank targeting: actual swept puck integration reaches the intended target within 4 world units after exactly one board bounce on either side, accounting for 0.88 restitution.
- Asset validation: all frame/clip references resolve, selected source hashes match, corrected source selection is explicit, floor mask matches the registered polygon pixel-for-pixel, and legacy sport atlas files remain byte-identical.

- Game boundary checker passed (367 source files, 89 reviewed legacy edges); all three Cryptball boundary tests passed. Simulation purity checker passed with its existing 186 baseline diagnostics retained.

- Multiplayer production browsers: **7 passed**, including hockey private invitation, automatic sport adoption, bot-filled match start and reload reconnect.

- Production client and server builds pass with matching authority `cryptball-v1-07a23030fd98f246ff2e7830` (33 transitive source files). The final client uses the default service configuration, not the isolated multiplayer-test endpoint.

- Final renderer capture: **48 native contact images and three enlarged debug views**, with zero page errors and all puck frames resolving correctly after the diagonal contact corrections. Both targeted production hockey browser tests also passed again with the corrected atlas, and all 46 focused presentation/fixture tests passed after final import.

## Acceptance limits

Automated replay and browser checks establish deterministic behavior and integration, not game balance or human enjoyment. Human feel/balance and an auditory review remain pending. Discrete generated key poses approximate the continuous stick-contact sweep; far-side puck/stick contacts can be naturally occluded by the athlete. The final diagonal contact corrections improve blade alignment without moving the authoritative puck. Source art is generated raster material normalized into a pixel-art pipeline; the screenshots are actual runtime output, not concept images. Software-GPU browser runs can invoke the existing protective frame-debt pause; readiness helpers resume only that explicit pause and then require advancing authoritative ticks. Production protections were not weakened.
