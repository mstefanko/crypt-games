# Hockey feel implementation and validation

Implemented 2026-11-05 using three GPT-6.1 Sol agents with parent integration and independent mechanics review. The reviewed [plan](cryptball-hockey-feel-plan-2026-11-05.md) records each review item and the isolated possession gate. Existing unrelated working-tree changes are preserved; no commit or public deployment was performed.

## Behavior

- Aim remains responsive while the physical carry pocket turns around the solid skater. Receiving, normal turns, braking, feasible dashes and shot/pass preparation retain control. Actual stick contact releases a shot/pass. Unreachable geometry can still lose possession; incidental body touch alone does not strip it.
- Faceoffs have a seeded initial lateral drop and alternate after goals. Equal blade contests resolve physically, including three-skater ties, with consistent blade-distance ranking and short contact receipts. Only the releasing skater receives a self-recapture delay; opponents and receivers remain eligible.
- Bots choose committed collectors using actual human intent and feasible arrival, route around obstruction, hand off stalled pursuit, maintain geometric support lanes, and choose escape directions. They respect shot/pass/poke cooldowns and can deliberately dash or check.
- Shift/I/right mouse pokes once per press. Space/L dashes without body-checking. E commits a shoulder check; touch gets a separate Check button and correctly labels flick as poke. Successful checks knock the victim down for 24 ticks (~0.4s), with protected recovery. A check has a 7-tick tell, 8 active ticks, and 20 recovery ticks. Misses recover visibly; held input, cancel and specials cannot bypass commitments.
- Existing eight-direction sprites now show stickhandling, check tells/misses, seated knockdown and get-up. Physical carry heading drives the rendered stick direction; the puck stays at its actual position. Existing sports recovery poses are reused with the stick stowed. No new art was generated and no dive input was added.
- Saved carry, collector, contest, check and recovery state is validated and replayed. Checkpoint version is 12; network protocol is 10. Old clients/checkpoints are rejected. Shared behavior changes are gated to hockey.

## Before/after evidence

Reproduced 3 scenarios × seeds 42/123/999 × 3,600 authority ticks. Baseline, isolated stage0, final workload and source hashes are in `docs/evidence/cryptball-hockey-feel-2026-11-05/`.

| Scenario, seed 42 | Before | Possession slice alone | Final |
|---|---:|---:|---:|
| All-bot owned time | 6.0% | 28.8% | 39.7% |
| All-bot mean completed ownership span | 1.27 ticks | 18.58 ticks | 22.95 ticks |
| Idle-human owned time | 18.8% | 0.8% | 40.1% |
| Longest static loose-puck stall, idle human | 2111 ticks (~35s) | 3345 ticks (~56s) | 1 tick |

Across all final runs, owned-puck time was 37.3–44.8%; completed possession spans averaged 23–42 ticks. Exactly stationary loose-puck stalls never exceeded one tick. This metric does not prove every moving or jittering contest is enjoyable. Normal all-bot seed 42 produced 22 strike events and one pass, compared with 2 and 1 in the original baseline. Bots still favor shooting; passing frequency and scoring pace need human tuning rather than being declared balanced from these runs.

The review correctly identified the failing retention predicate. Independent instrumentation qualified its attribution: excluding the owner alone did not clear every blocked lane, and all 49 idle-human losses still encountered another body. The measured stage0 regression is why the pursuit and contest stages were completed rather than stopping at the narrow fix.

## Verification

- Full application suite: 30 files, 258 tests passed.
- TypeScript (`tsc --noEmit`): passed.
- Simulation purity and game boundaries: passed (372 source files; existing reviewed baseline edges retained).
- Focused coverage includes five-second carry/turn/brake, physical self/other obstruction, passive touch attribution, actual swept check, anti-repeat/anti-stunlock, special interactions, malformed receipts, three-way contests, 30 seeded/alternating faceoffs, mirrored corner pursuit, and real pending-input prediction correction during carry/check/down/get-up.
- Native-size browser visual inspection completed for actual check tell, contact/fall, seated/down, get-up and miss. PNGs plus authority summaries are in the evidence `visuals/` directory. All eight directions are also exercised by actual-command fixture tests.

- Network suite: 69 passed, one optional full-socket-match test skipped by its existing environment gate.
- Production browser suite: all 22 passed, including hockey poke/check and real multi-touch pointer isolation. Fixed the Check button's mounting so other sports retain their original HUD structure.
- Cross-runtime replay: all six tests passed across Chromium, WebKit and Firefox, including complete matches, takeover, checkpoint restoration and the new check input. Hockey 12-tick replay p95 was 1.4ms / 3ms / 12ms respectively; all stayed within the 16.67ms frame-budget gate. Reports are copied into this delivery's evidence directory.
- Online browser suite: all eight passed, including hockey invitation hydration, bot play, menu takeover and reload/reconnect.
- Client and server production builds passed. The client was rebuilt with the normal default server configuration after online tests. Existing large-chunk warning remains.
- Local playtest build: http://127.0.0.1:4231/games/cryptball/?sport=cryptcheck (solo/practice; no public deployment).

## Remaining playtest decisions

No human solo/two-player balance session or physical-phone session has been claimed. Check duration, shooting pace, passing incentives and touch placement are prototype tuning values. Dive and new sprite sheets remain deliberately deferred until that feedback justifies them. The implementation is suitable for playtesting, not a claim that automated tests prove fun.

## Suggested first playtest

1. In hockey practice, collect the puck, reverse mouse aim, brake, dash and prepare a pass/shot. Check whether the visible stick and puck communicate the carry direction clearly.
2. In a solo match, poke at the puck with Shift/right mouse; use E for a committed shoulder check. Compare a hit with a miss and try dashing away from the tell.
3. Watch an idle teammate situation, corner pickup and repeated faceoffs. Bots should route or hand off pursuit rather than reserve the puck indefinitely.
4. Judge whether the 0.4s knockdown, recovery protection, scoring pace and shooting bias feel right for 2v2 before commissioning new sprites or adding dive.
