# Rift Volley online smoothness investigation — November 5, 2026

The reported symptom was forward-moving but visibly chopped animation on a phone and laptop sharing Wi-Fi, playing Rift Volley through Render Free in Virginia. We reproduced uneven displayed motion even when browser frame delivery was consistently 60 Hz. Render was not the primary bottleneck in the single live match measured.

## Findings and changes

1. **Rendering inherited uneven network prediction ticks.** The online simulation only advanced when the input scheduler allocated a new command slot. Display frames could therefore repeat a pose, then jump two or three simulation ticks. The frame loop displayed the latest observation directly. In an isolated, rendered 150 ms RTT trial, 163 of 513 measured moving-ball frames (31.8%) repeated the previous displayed ball position despite steady frame timing.

   For Rift Volley, added a small render-only pose buffer with a separate display clock, approximately two ticks (33 ms) behind prediction. It interpolates player and main-ball positions; other modes retain their existing presentation pending their own visual qualification; physics, input aiming, authority, scores, and action admission continue to use unsmoothed state. It resets on transitions/ownership changes and long frame interruptions, never extrapolates beyond available poses, and bounds storage. This is presentation latency, not additional network input scheduling delay.

2. **The lead controller repeatedly responded to an overlapping feedback window.** The server reports low arrival margins over 60 receipts. The client treated each new feedback sequence as independent evidence and repeatedly increased lead before old receipts aged out. Lead hit 20 ticks, even with the roughly 48–70 ms RTT observed against Render. Higher lead expands whole-world replay and increases the interval over which remote actions are unknown.

   The controller now waits for a full window of new receipts after an adjustment before applying another adjustment. Reset clears that guard. A focused regression proves repeated overlapping feedback cannot drive the lead to the cap.

3. **Collision work amplified reconciliation cost.** CPU samples showed circle/rectangle sweeps and exact BigInt disk-entry calculations among the main simulation costs, including in Volley. Each online checkpoint can replay many simulation ticks.

   Added conservative closed-bound rejection before expensive narrowphase work. Impossible contacts return early; possible contacts still use the original exact solver. Input validation remains before the rectangle shortcut. Recorded state hashes match the baseline for all six modes, three seeds each, over 900 ticks per seed, sampling every 15 ticks (1,080 complete checkpoint samples). This verifies those scenarios, not every possible input.

4. Added `ballCorrectionPx` to the existing client diagnostics and a reproducible rendered-browser profiling command. No automatic production deployment or hosting subscription change was performed.

## Matched rendered trial

One rendered Chromium client, one real SDK peer, two bot teammates, local server in a separate process, ordered TCP proxy with 75 ms each way, 4× Chromium CPU throttling, 20 seconds per run. First 120 display samples excluded from distribution calculations. Tests ran sequentially without concurrent test workloads.

| Measurement | Baseline | Optimized |
| --- | ---: | ---: |
| Measured RTT p95 | 152.9 ms | 152.5 ms |
| Browser frame interval p95 | 16.8 ms | 16.7 ms |
| Stationary displayed ball frames while moving | 163 / 513 (31.8%) | 23 / 475 (4.8%) |
| Prediction lead p95 | 20 ticks | 8 ticks |
| Replayed simulation ticks p95 | 24 | 12 |
| Active-ball replay cost p95 | 5.6 ms | 3.2 ms |
| Timing rejections / resync requests / bot takeovers | 0 / 0 / 0 | 0 / 0 / 0 |

The logical simulation tick still jumps: the renderer now fills in the display poses between those ticks. The profiler deliberately retains logical-tick metrics rather than changing tick values to make the results appear smoother. Remaining stationary samples include startup and discontinuity behavior; this was not a perfect-zero-stutter result.

Timing values are frame-sampled diagnostics, not independent per-packet percentiles. Trials are short, with scripted controls and a changing live match, not an identical recorded input tape. CPU throttling is a stress proxy, not an iPhone benchmark. Earlier 30-second runs measured the CPU/lead fixes before interpolation; a separate contended run is explicitly labeled and excluded from comparisons.

## Additional checks and limits

At near-zero injected delay with 4× CPU throttling, repeated moving-ball positions were 22 / 418 (5.3%), with no timing rejections, resyncs, or bot takeovers. At 300 ms injected RTT, one run suffered a 783 ms browser stall and 300 ms server debt, triggering a resync and bot takeover. A repeat recorded RTT p95 306 ms, frame interval p95 16.8 ms, 25 / 499 repeated moving-ball positions (5.0%), and active replay p95 8.3 ms, but still had one timing rejection and a 100 ms maximum frame interval. These stress runs are retained as evidence; 300 ms operation is not fully qualified.

Validation: 386 offline tests passed, 18 independent geometry/flight tests passed, 10 scheduler/interpolation tests passed, and five Rift Volley adapter impairment scenarios passed (150 ms, 300 ms, jitter, route change, and a 100 ms stall). The adapter scenarios exercise deterministic transport impairment; the rendered trials separately exercise actual browser presentation. Neither substitutes for testing the user's phone.

## Render assessment

`https://crypt-games.onrender.com/healthz` returned HTTP 200 in about 77 ms when checked. One private diagnostic match against the existing deployment recorded RTT p50 47.8 ms / p95 69.7 ms. Server residual tick debt stayed around 4 ms median / 7.6 ms p95 / 8.5 ms maximum. Below one 16.67 ms simulation tick, this is ordinary accumulator remainder, not evidence of an overloaded server. No resyncs, timing rejections, or bot transitions occurred in that trial.

Both devices on the same Wi-Fi still send game traffic to the hosted authority. The two-device report plus our reproduction points primarily to rendering/prediction, rather than proving a Render capacity problem. We did not access the Render dashboard, CPU/memory charts, or metrics token, and did not run a production capacity test. Free-tier variability, a weaker phone GPU/CPU, Wi-Fi interference, and transient network stalls can still contribute.

Recommendation: deploy the game fixes first and retest the same phone/laptop. Keep Virginia for nearby East Coast players. Upgrade to always-on paid hosting for predictable availability; increase CPU only when server tick debt grows persistently, CPU saturates, or multiple rooms demonstrably overload the instance. Moving providers alone does not fix the repeated-pose display path.

Render Free sleeps after 15 minutes without inbound traffic and can take about a minute to wake. Opening `/healthz`, waiting for `{"ok":true}`, then retrying the game is a manual wakeup. Active WebSocket traffic counts as activity, so sleeping does not explain this steady in-match cadence defect.

## Reproduce and validate

```sh
npm ci
npm run build:cryptball:server
PROFILE_VARIANT=baseline PROFILE_CPU=4 PROFILE_SECONDS=20 node scripts/cryptball-network-profile.mjs /tmp/baseline.json
PROFILE_CPU=4 PROFILE_SECONDS=20 node scripts/cryptball-network-profile.mjs /tmp/optimized.json
PROFILE_RTT=300 PROFILE_CPU=4 node scripts/cryptball-network-profile.mjs /tmp/slow-link.json
npm run typecheck
npm run test:cryptball
npx vitest run --config vitest.cryptball-network.config.ts apps/cryptball/tests/online-scheduler.test.ts apps/cryptball/tests/online-frame-interpolation.test.ts
npx vitest run --config vitest.cryptball-network.config.ts apps/cryptball/tests/online-impairment.test.ts -t 'rift-volley (steady-150|steady-300|jitter|route-change|stall-100)'
```

The baseline browser variant reads the two original source files from commit `2492946` and bypasses the new rendering buffer. The local server uses the current build in both runs; its physics results were checked against the original. `PROFILE_ENDPOINT=https://...` creates one private diagnostic cloud match, not a load test. Client/server source identities must match for a cloud run; do not use a changed authority build against the older deployed server.

Evidence is in [the adjacent directory](evidence/network-smoothness-2026-11-05/). Existing unrelated multiplayer-suite failures from the initial export are not claimed fixed. Remaining release checks: the actual phone, Safari, variable refresh rates, real Internet jitter, and sustained load. Physics-source changes alter the build identity, so server and Pages must be deployed from the same revision.

## Primary research

- [Colyseus prediction and reconciliation](https://docs.colyseus.io/netcode/client-prediction): separates predicted simulation, reconciliation, and display smoothing.
- [Glenn Fiedler: snapshot interpolation](https://gafferongames.com/post/snapshot_interpolation/): explains buffering updates to render smooth motion despite uneven arrival. Our buffer interpolates predicted poses, not a replacement snapshot-only architecture.
- [Render free instances](https://render.com/docs/free): idle shutdown and wakeup behavior.
- [Render WebSockets](https://render.com/docs/websocket): persistent connections, restarts, and compute limits.
