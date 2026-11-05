# Dodgeball and Guardian pressure/teamplay delivery

Implemented November 5, 2026 by three GPT-6.1 Sol agents with parent supervision, reciprocal mode review, presentation review, and integrated validation. The [implementation plan](cryptball-pressure-and-teamplay-plan-2026-11-05.md) records the decisions. Existing unrelated working-tree changes were preserved. No commit or public deployment was performed.

## Player-facing changes

Dodgeball starts with two loose balls just inside the opposing inner boundary lines, offset symmetrically along the center. Neither side starts holding a ball; the countdown gates collection. Players remain in their own halves. Two independent ball records carry physics, ownership, possession clocks and attack identities. One player cannot hold or catch a second ball. Successful catches consume their attempt, and shared hit immunity prevents simultaneous multi-life loss. One-versus-one retires a dead ball without removing a live throw.

Quick/full throw speeds are 210/350 units per second, ordinary catch duration is nine ticks, powered precision is six ticks, and failed recovery is 24 ticks. A friendly reception gives a 48-tick empowered follow-up at full speed. Damage stays one life. Passing does not restart the ball's possession deadline. Bots retrieve reachable balls, respect occupied hands, react to distinct throws, and evade while carrying.

Guardian now uses two carryable balls, charge/release throws, automatic friendly reception and directional boss aim assistance. Shots retain their release trajectory and collide with cover. Friendly passes empower the next shot. Empty-handed primary opens a timed catch; hostile returns damage an unprepared athlete, while defensive movement allows evasion. Reviving requires empty hands and has explicit input priority.

The boss has a visible directional guard, finite guard pressure, a timed stagger, recovery vulnerability and announced hostile deflections. Frontal guard persists throughout committed attacks; flanking, recovery and stagger create openings. Blocks are determined by state and approach angle rather than random chance. Projectile speed is 165 units/second; recovery is 54–66 ticks. Each orb has its own return warning. Normal play hides future floor footprints and instructional attack prompts; practice retains overlays. Weapon aiming/windups and a traveling, descending maul communicate threats physically. Locomotion advances with actual traveled distance and uses weapon-free movement/carry/throw art.

Both balls render independently with hand sockets, clear outlines, powered feedback and authoritative audio. Target feedback identifies the intended teammate, eligible boss aim and blocked lane. Checkpoint version is 15; protocol version is 13. Client/server must use the same generated build identity.

## Review corrections

Cross-review fixed duplicate-holder/retrieval and revive bot cases, globally distinct Dodge throw identities, carrier evasion, cancellation of an unrelated ball's prepared throw during possession reset, clamped Guardian carry sockets, integer locomotion distance, locale-independent bot ordering, and per-orb hostile-return cues. Tests cover detached JSON and actual wire encode/decode restores, not only in-memory aliases.

## Validation

- Final full simulation suite: 381 passed; focused Dodge/multi-ball checks also passed after the stable-ordering fix.
- Full browser suite: 28 passed, including actual sprite-frame advancement in both modes, both rendered balls, touch catching, and practice-only floor previews. Midcombat screenshots were inspected.
- Final six-test new-mode browser rerun passed after the committed-guard and projectile-pressure adjustment.
- Both new-mode multiplayer browser invitation/start/reload/reconnect flows passed. Guardian was rerun after overlapping client builds changed its server URL.
- Full network suite initially reported 215 passed, 10 failed and 2 skipped. Nine failures were explicit build-identity mismatch rejections during overlapping builds; the isolated socket rerun passed 10 tests with 2 skipped. The remaining four-human Dodge scenario used the old pickup location; its real input strategy now retrieves reachable balls, and all three Dodge full-match authority scenarios pass. No simulation shortcuts or relaxed completion assertions were introduced.
- TypeScript passes; game boundaries pass. Purity passes with the existing 186-diagnostic baseline unchanged.
- Cross-engine replay state matched Node in Chromium, WebKit and Firefox. The initial Firefox run exceeded a separate performance assertion (18 ms versus 16.67 ms) under concurrent suite load; its isolated rerun passed without changing the threshold.
- After the final guard/pressure adjustment, all three Guardian full-match authority scenarios and 13 new-mode/confirmed-combat network checks passed.
- Final changed-sports replay run passed all three browser engines (Chromium, WebKit, Firefox), including complete-match/takeover hashes and the unchanged browser performance assertions.

Logs are in [evidence](evidence/cryptball-pressure-2026-11-05/). Screenshots are in [new-mode evidence](evidence/cryptball-new-modes-2026-11-05/).

## Qualification

Nine bot-only Guardian fights before the committed-guard correction all ended in victory in 24.7–48.6 seconds, median 32.6. With the correction and increased projectile pressure, the same nine seeds all ended in victory in 42.7–75.7 seconds, median 48.7. Blocks rose from 21 to 117, player downs from 2 to 11, and completed passes from 42 to 78. Boss health stayed 300. This is a small deterministic diagnostic, not evidence of human difficulty or enjoyment; the initial 90–150-second target was not achieved and was not forced by padding health.

Human catch timing, pass frequency, four-player engagement, physical-phone control feel and delayed-link play still require playtesting. Initial balance values and fight-duration targets are hypotheses, not measured human outcomes. The previously documented overall 4 ms replay release qualification gap remains separate from correctness tests; no performance threshold was weakened.

The final real-clock benchmark also misses the 4 ms budget for the upgraded modes on this development host: Dodge p95 at 32 ticks is 4.94 ms, Guardian 9.17 ms. Earlier windows vary (Dodge 1.60/2.24/5.56 ms at 12/20/24 ticks; Guardian 4.58/9.94/6.76 ms). Legacy Cryptball also exceeds the budget, beginning at 11.88 ms for 12 ticks. These timings are host measurements, not supported-device performance guarantees; the implementation is not performance-release-qualified. Snapshot sizes are 5,209 bytes for Dodge and 5,291 for Guardian, below the unchanged 16 KiB cap. The full raw report is retained in replay-benchmark.json.
