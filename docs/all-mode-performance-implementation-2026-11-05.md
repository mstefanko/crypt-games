# All-mode performance implementation — November 5, 2026

Implements the shared timing and presentation stages of [the research plan](network-performance-plan-2026-11-05.md). Three GPT-6.1 Sol agents implemented timing, presentation, and diagnostic tooling, with cross-review and host integration by the coordinating agent.

## Changes

- The fixed-step host accumulator now owns input cadence. The redundant minimum-time-since-send gate is removed. Commands use monotonic assigned simulation ticks, bounded by the existing authority limits. Lead reductions use a bounded clock rate; increased safety lead advances intervening held-input ticks once. Server rate, queue and execution-ownership limits remain enforced.
- Match epoch resets retain the measured connection clock offset and RTT while clearing the tick timeline. A previous ten-minute soak exposed 13 expired inputs per client when resetting the SDK clock discarded downlink compensation; the aged-checkpoint regression now covers all five online modes without requiring a fresh pong. Disconnect/resume still resets the connection clock fully.
- Input allocation waits for a live checkpoint matching the playing lobby epoch. The four-client trace reproduced 11 expired startup inputs per client when the lobby advanced before the countdown clock; the guard keeps connection maintenance running while preventing those stale allocations.
- Manual-switch and pass-induced control transfers now survive lagging checkpoints. The authority admits an anticipated revision only when queued transfer commands or an actual pending transfer justify it, then still checks exact ownership at execution. Rematches and unmatched ownership resets preserve the learned latency lead, including overlapping reset paths. Forged revisions and failed switches cannot authorize actions.
- Forced ownership changes explicitly terminate received stale-revision commands instead of later counting them as missing sequences. These cancellations remain visible in diagnostics. Held inputs are cleared when authority changes the controlled player, preventing an old charge from reaching the replacement; fresh commands for the new revision remain valid.
- Quick Play now preserves the normalized Shuffle flag in room metadata, so compatible callers can find the same room.
- One presentation owner interpolates adjacent predicted ticks and applies same-tick reconciliation corrections. It replaces the stacked correction-plus-two-tick-buffer path. The host supplies accumulator alpha and captures each step, including an intermediate pose when safety recovery advances multiple ticks.
- Entity identities cover players, the primary ball, every Dodge ball, Guardian orbs, boss, and projectiles. Possession/action generations prevent interpolation across catches, throws, retirement and respawns; held objects follow rendered holders. Confirmed score/damage/lifecycle remains authoritative. Cosmetic animation can use fractional presentation time while action windows and dangerous telegraphs stay simulation-timed.
- Local play uses the same pose rendering path. Guardian remains explicitly solo-only in UI/server admission; no online Guardian feature was enabled. Its local renderer and latent authority-model tests are covered separately.
- Removed the redundant full-observation correction clone from the active path and indexed replay input lookup. No worker or transport migration was introduced: those remain profiling-driven options.
- Opt-in `?diagnostics=1` exports bounded frame, input and snapshot timing data plus build/source revision. Physical browser events are recorded separately from command application; they are not falsely paired across queued actions. Synthetic input-to-render-submission is explicitly not input-to-photon or first-changed-pixel latency.
- The profiler freezes both measurement boundaries before exporting large payloads and optionally rejects unhealthy sustained runs. Integer quarter-turn headings prevent invalid synthetic aim values. The delay proxy now uses one FIFO delivery queue per direction, including delayed FIN, with regression tests for fractional timing and cancellation. An earlier Volley trial had one sequence gap on each client during catch-up bursts; the exact cause was not proven, and the FIFO rerun passed without changing production admission limits. It supports two rendered browser clients, mode-aware repeatable input tapes, all moving entities, a solo route, event-sampled metrics, warmup exclusion, and final network counters. It fails rather than silently substituting partial historical source files for a baseline.

## Review and regression fixes

Cross-review caught and fixed intermediate pose consumption, composition of multiple corrections before a frame, allocation behind the predicted tick after controller revision changes, stale offsets crossing ball generations, confirmed scene resets, Volley floor-radius clamping, and ordinary control changes incorrectly resetting interpolation for every entity.

Ten failures in three older network test files were reproduced on unchanged baseline `767fca1`. Fixture corrections preserve intended assertions: use the current two-player Guardian roster, explicitly seed team-choice fixtures instead of assuming room-generated team defaults, and verify a live charged-strike origin rather than a disabled special mechanic. These are not production gameplay changes.

## Validation and evidence

The complete suite passes: 403 offline tests and 279 network tests; two existing opt-in capacity/long-match tests remain skipped. Type checking and both production builds pass. The scheduler cadence reproducer now allocates all 600 of 600 ticks under both ideal 60 Hz and alternating 16/17.333 ms timing (the earlier alternating result was 301 of 600).

See [evidence](evidence/all-mode-performance-2026-11-05/) for final test output and rendered-trial summaries. Raw profiling runs remain in `.local-game-tests/`; checked-in summaries exclude the bulky per-frame trajectories.

All six 120-second trials completed without browser errors. The five online modes passed the health gate on both clients with zero sequence gaps, expired/future/capacity rejections, resyncs or bot takeovers after warmup. These matrix trials also had zero ownership cancellations; the forced-elimination regression separately proves that intentional stale-owner cancellation works. Online trials used a local authority, an ordered 150 ms RTT proxy, two rendered Chromium pages, and 4× CPU throttle on the primary page only. Guardian used solo play with automatic retry.

| Mode | Route | Frame interval p95 (ms) | RAF app work p95 (ms) | Snapshot replay p95 (ms) | Active frames |
| --- | --- | ---: | ---: | ---: | ---: |
| cryptball | Online, two browsers | 16.7 | 3.8 | 5.8 | 86.8% |
| cryptkick | Online, two browsers | 16.7 | 3.5 | 3.4 | 81.6% |
| rift-volley | Online, two browsers | 16.7 | 3.3 | 2.4 | 61.1% |
| cryptcheck | Online, two browsers | 16.7 | 3.9 | 6.7 | 58.0% |
| crypt-dodge | Online, two browsers | 16.7 | 4.4 | 1.2 | 97.9% |
| crypt-guardian | Solo | 16.7 | 2.9 | 0.0 | 98.6% |

The mode matrix preceded the final epoch-clock follow-up. Rendering code did not change afterward; the follow-up is covered by all-mode delayed-checkpoint regressions; the repeated ten-minute soak passed. Dodge traces included 48 throws, four catches, an elimination and a round end; Guardian traces included attacks, deflections, cover destruction and a defeat/retry. These annotations show actual exercised interactions, not exhaustive scenario coverage.

The final 600-second Rift Volley soak passed across 11 match epochs. Both clients recorded zero expired/future/capacity rejections, sequence gaps, ownership cancellations, resyncs and bot takeovers after warmup. Primary frame interval p95 was 16.7 ms (p99 16.8 ms, maximum 50 ms); 3 of 35877 measured intervals exceeded 25 ms. Primary RAF work p95 was 3.9 ms and replay p95 2.4 ms in the retained timing window. The bounded recorder retained roughly the last 227 seconds; frame intervals and health counters cover the full post-warmup run. See [passing soak](evidence/all-mode-performance-2026-11-05/volley-soak-summary.json) and the [earlier failing soak](evidence/all-mode-performance-2026-11-05/volley-soak-before-clock-fix-summary.json).

RAF app work and snapshot replay are separately sampled tasks, not a combined total; neither measures GPU execution or display scanout. Default room seeds differ across trials, so these are stress qualification runs rather than a matched-seed before/after performance comparison.

Performance numbers are controlled desktop-browser evidence, not actual phone results. CPU throttle is a stress proxy. Scripted actions and model tests do not establish every possible match interaction, so the mode/action and device matrix remains a release checklist rather than a claim of exhaustive coverage.

## Remaining qualification and deferred work

- The final revision has not yet been profiled on the live Render service; the automated matrix uses a local authority and a delay proxy. Deploy matching client/server versions before the cloud comparison.
- The actual affected phone/laptop and mobile Safari still need a post-release playtest and diagnostic export. The new capture controls make this practical; no unattended test can certify physical input-to-photon responsiveness here.
- Coalescing checkpoints is deliberately deferred. Safe coalescing must preserve event acknowledgements, dispositions, controller transitions and cosmetics; synchronous replay remains bounded and instrumented. Adding it without those guarantees would risk missing actions for an unproven gain.
- Selective entity prediction, workers, transport changes, snapshot-rate changes, and GPU quality scaling remain conditional on measured bottlenecks. The full deterministic interacting world remains predicted.
- Guardian's latent online combat projection still uses authoritative boss coordinates. This does not affect its available solo mode, and online Guardian remains disabled.
- Diagnostic exports provide command application and render-submission timing. Exact physical action-edge-to-pixel correlation requires tracking edge identity through every queue plus device display instrumentation.

## Redeploy and test

Deploy both the new client and server from the same main revision. Protocol 15 marks the changed ownership-admission contract, preventing a new client from silently using an older server that drops switch follow-up commands. The diagnostic export includes a separate client source revision so an old cached client can be distinguished independently of the authority compatibility hash. Hard refresh both devices after deployment, test Rift Volley and Dodge first, then the other modes. Append `?diagnostics=1` (or `&diagnostics=1`) and export after a symptomatic match; see [capture instructions](network-performance-diagnostics.md).
