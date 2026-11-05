# Cryptball network implementation — November 5, 2026

The working tree implements protocol **11** and checkpoint **13**. The checkpoint change is required by deterministic action-origin metadata; timing envelope metadata alone did not change it. Nothing was committed, pushed, or deployed. Existing unrelated working-tree changes were preserved.

## Plan coverage

| Phase | Delivered / remaining |
| --- | --- |
| 0 | Reusable ordered-link fixture, actual-adapter impairment matrix, separate real-clock benchmark and evidence. |
| 1 | Protocol/clock/scheduler/receipts/watchdogs/recovery and real SDK socket integration. |
| 2 | All-entity correction offsets, deterministic action origins, local swing/dash deduplication and authoritative audio. Existing predicted-state charge visuals retained; no new charge audio loop. |
| 3 | Shared capture, dirty lobby state, event-preserving coalescing, bounds and operational metrics. |
| 4 | Local real-browser regressions, cross-runtime determinism, delayed real sockets and bounded 1/25-room smoke. Reference-device performance, controlled browser cadence, WSS/WAN and human release gates remain open. |

## Implemented behavior

- The browser uses an app-owned adapter around the installed SDK `RoomClockImpl`, paired monotonic-time/simulation-tick anchors, outstanding ping validation, phase-aware extrapolation, and independent arrival-margin feedback. The first valid RTT seeds the estimator. Input slots are monotonic and paced by wall time; lead can rise and fall. Ordered unsent edges have an eight-frame/100 ms bound. Prediction is capped at 32 ticks, independently of the server's 24-tick future limit.
- The server assigns one execution slot per peer per tick, permits at most three ticks of late execution, records explicit dispositions and contiguous terminal acknowledgements, and bounds queues/history. Reconciliation replays accepted retimed commands at assigned execution ticks. Snapshot sequence numbers allow newer metadata at an unchanged simulation tick.
- Heartbeats keep connection liveness separate from executable-control freshness. Quiet controls neutralize safely. Resync requests preserve history and ownership, use bounded retries, and are coalesced/throttled on the server. Brief prediction-cap encounters await scheduled checkpoints before requesting recovery.
- Corrections use the last drawn pose for every player and the ball, decay by elapsed time, and never affect physics or targeting. Compact pose records avoid a second full observation clone per draw. Local swing/dash cues use complete action-origin identities, emit only on first prediction, and confirm against successful authoritative action events. Buffered actions preserve their original identity through checkpoint/restore; transport acceptance does not confirm a swing. Charge visuals continue to follow the predicted simulation state. The game has no authored charge-onset audio loop, so no new predicted charge sound/loop was invented; the cosmetic event allowlist is swing/dash, and the existing charge-ready event remains authoritative. Contacts, scores, goals and opponent feedback remain authoritative. Authoritative audio is independent of predicted display ticks.
- Broadcasts capture one common checkpoint per broadcast, encode per peer, and coalesce catch-up snapshots while preserving all events. Lobby dirty versions and 4 Hz countdown buckets avoid repeated full lobby comparisons. Authenticated metrics expose bounded work/payload distributions, event-loop delay, rejection reasons, heartbeat/resync counts and outbound backlog duration without peer labels. Oversized checkpoints explicitly interrupt a room.

The shared engine scheduler, fixed timestep, physics/contact rules, and shared audio services were not changed by this networking implementation. Scalar simulation accessors replace cloning in input admission and tick/revision reads.

## Review fixes

Legacy repeated `resume` messages now use the next scheduled 20 Hz checkpoint instead of causing an immediate full-world capture/encode. A 60-repeat regression verifies zero immediate snapshots/captures and one lifecycle revision change.

Three independent review findings were fixed with focused regressions: rejected release/cancel now reaches authority as a safety cancellation and invalidates older unsafe queued controls; adoption updates held prediction controls from the reconstructed timeline; rematch resets arrival-feedback sequence metadata for the new generation. Audio prediction keys are also isolated from unrelated authoritative event counters.

## Validation and reproduction

Validation: **268 offline tests passed**; **61 impairment/FIFO tests passed** (60 scenarios, zero post-warmup timing rejections, resyncs or bot transitions); **101 remaining network tests passed**, with two opt-in long/capacity tests skipped in that ordinary run. After the final resume fix, 32 focused server tests and the real-browser focus/menu/resume/reload scenario passed. Final clock/client tests passed 35/35. All eight online browser regressions passed. Typecheck, both production builds, boundary/purity checks and engine-registry discovery passed.

All six unique cross-runtime determinism tests agree with Node. The concurrent combined run passed five and failed Firefox's existing 12-tick performance assertion (23 ms against 16.67 ms); an isolated Firefox rerun passed both tests, including that assertion. This contended failure is retained alongside the isolated rerun; it is not a hash divergence or proof of the separate 4 ms network release budget.

The first expanded network run exposed seven valid-state checkpoint failures. Strict active-special and hockey-check field whitelists were missing optional, separately validated action origins. Those were corrected, real authority mid-action restore regressions were added, and all twelve full-match tests passed. The old 6 KiB soft-size assertion was replaced with the actual 16 KiB protocol bound; observed hockey four-player maximum was 6,313 bytes.

Evidence and exact run scopes are in [validation-summary.json](evidence/cryptball-network-implementation-2026-11-05/validation-summary.json) and the adjacent logs/artifacts.

```sh
npm run test:cryptball:network
npm run test:cryptball
npm run test:cryptball:determinism
npm run typecheck
npm run check:game-boundaries
npm run check:game-purity
npm run build:cryptball
npm run build:cryptball:server
npm run test:cryptball:online-browser
node --test tests/engine-harness/cryptball-discovery.test.mjs
```

Performance and capacity are explicit, separate commands:

```sh
CRYPTBALL_BENCHMARK_REPORT=/tmp/cryptball-replay.json npm run test:cryptball:network-benchmark
CRYPTBALL_CAPACITY_REPORT=/tmp/cryptball-capacity.json npm run test:cryptball:network-capacity
# Optional generator stress, including 100 complete predictors:
CRYPTBALL_CAPACITY_PREDICT=1 CRYPTBALL_CAPACITY_REPORT=/tmp/cryptball-capacity-predict.json npm run test:cryptball:network-capacity
```

The functional network glob discovers the new impairment, scheduler, receipt, origin, metrics, cosmetics and correction tests. The performance file is deliberately excluded from the functional suite and selected by the explicit benchmark command; its 4 ms assertion remains enforced. The engine test registry selects Cryptball network/determinism/browser suites for these paths.

The pre-existing audit baseline remains historical evidence. A new pre-change protocol-10 baseline was not captured before the concurrent implementation edits; the new artifacts measure the implemented protocol-11 adapter and must not be presented as a fresh before/after experiment.

The real-socket proxy scenario runs four complete browser adapters through actual SDK/WebSocket connections and an ordered TCP delay proxy at 150 ms RTT. The deterministic transport matrix uses the actual adapter with a mocked SDK transport, preserves ordering separately in each direction, and models stalls as head-of-line blocking. These are different kinds of evidence.

## Capacity and performance limits

The successful bounded capacity fixture uses 1 then 25 full rooms (4 then 100 actual SDK connections), production clock/scheduler logic and scripted active controls, without running 100 complete predictors in one generator process. It retains the production 60/minute per-IP admission limiter and explicitly readies all rooms after staged admission. Each measured interval is six seconds after two seconds of warmup. At 25 rooms it recorded at least 228 terminal commands per client, zero bot transitions, generator timer p95 17.01 ms, zero server tick debt, and about 10.13 MB/s of aggregate checkpoint payload. This is a local smoke test, not production capacity qualification.

The separate full-adapter generator run failed: 100 predictors in one process caused timer p95 about 724 ms and bot transitions while server debt remained zero. Its artifact is preserved as `capacity-full-adapters-generator-bound.json`; it must not be presented as a measured server limit. The passing lightweight run is `capacity.json`.

The isolated local simulation decode/restore/replay/event-intake benchmark **fails the 4 ms p95 release gate**. At 32 ticks the final local p95 values were approximately 8.15 ms Cryptball, 5.90 ms Cryptkick, 4.10 ms Rift Volley and 10.79 ms Hockey. This benchmark does not include complete adapter disposition/correction handling, renderer or browser frame cost, and the host is not an agreed reference device. Earlier overlapping diagnostic measurements are labeled contended separately. A small measured correction-render optimization reduced local draw p95 from about 0.089 to 0.037 ms; it does not resolve replay cost.

## Remaining release gates

Complete target-device browser frame costs and observed rendering cadence, deployment-like WSS, separate-machine human playtests, sustained multi-room capacity/GC contention, and a complete browser decode/adopt/replay/event budget remain open. The implementation does not claim 4 ms full-quality qualification. No transport migration or physics timestep change was introduced to hide that failure.

The source supports two simultaneous team-special slots, not four simultaneous team specials. Payload tests therefore cover both legal active specials plus all four players' action metadata, conservatively synthesized 32 pending assignments and 128 retained dispositions per peer. Ordinary strict ordering within the 24-tick future window admits at most 24 pending slots, despite the independent 32-frame storage bound.
