# All-mode responsiveness and smoothness plan

Research date: November 5, 2026. Baseline: `abd6b66`, now on main. This document proposes the next implementation; it does not claim those changes are already deployed.

## Recommendation

Fix the shared timing architecture first, then introduce one entity-aware presentation pipeline for all six modes. Keep the authoritative fixed-step simulation, deterministic physics, Colyseus transport, and existing admission/security rules. Do not solve sluggish controls by increasing the whole-scene interpolation delay. Do not start by changing hosting, transport, or rewriting the game into another engine.

The earlier patch reduced repeated poses, but did not remove the coupling between network send pacing and predicted simulation. It also introduced a two-tick render delay for the local player. The user's post-deployment report means the earlier benchmark was insufficient as a release gate: smooth RAF timing and a lower count of repeated positions do not establish responsive, smooth gameplay.

## Evidence and confidence

### Confirmed in code and isolated reproduction

- `src/online/input-scheduler.ts:allocate` refuses a new command when fewer than `TICK_MS - 0.5` milliseconds have passed since the last send. `src/online/session.ts:step` returns without advancing prediction when allocation fails. The host already has a 60 Hz accumulator, so two independent timing gates control progress.
- Calling the real scheduler 600 times over ten seconds with alternating 16 and 17.333 ms intervals accepts **301 commands and skips 299**. Ideal 16.667 ms intervals accept 596 (four additional skips arise from integer/floating-point tick boundaries). This isolates a real cadence sensitivity; it is not a trace from the user's phone. The prediction loop then catches up multiple ticks using held input, applying the newest command at the allocated target tick. That can produce both chopped motion and delayed response to direction changes.
- `src/online/frame-interpolation.ts` buffers every player's position and the primary ball approximately two simulation ticks behind prediction. It has no separate local-player path. Its speed adjustment responds continuously to error, and its reset key includes possession and controlled-player changes for the entire scene.
- `src/online/corrections.ts` already applies exponentially decaying correction offsets (65 ms time constant). `session.observe` applies these before the host's second pose buffer. Two distinct smoothing stages operate on the same positions. Their combined perceptual effect must be measured; neither time constant can simply be added to RTT to estimate input latency.
- The extra objects in `dodge.balls` and `guardian.orbs` are drawn separately in `src/presenter.ts`. The new pose buffer neither captures nor interpolates them. `confirmed-combat.ts` also substitutes authoritative positions on ownership/action changes. Simply removing the Volley-only condition would leave these paths untreated.
- Server simulation is 60 Hz; snapshots are normally sent every third tick (20 Hz). Every received checkpoint synchronously restores and replays the full predicted world. Observations, correction drawing, and combat presentation make multiple detached copies. These are CPU/allocation candidates, not proof that copying is currently the dominant cost.
- Several effects and mode cues use integer simulation tick even while other animations use wall-clock render time. Entity positions, animation phase, shadows, trails, and cues need a consistent presentation timeline, without changing authoritative timing.

Reproducer and output: [scheduler-cadence.mjs](evidence/network-plan-2026-11-05/scheduler-cadence.mjs), [results](evidence/network-plan-2026-11-05/scheduler-cadence.jsonl).

### New cloud measurement

A 20-second private Rift Volley match used the current local browser client against the deployed Render authority, with another SDK participant and bots. It was not the user's phone, not a production Pages asset/cache check, and not a load test. Client/server build compatibility passed matchmaking.

- Chromium frame interval p95: 16.7 ms, maximum 16.8 ms.
- RTT p95: 19.7 ms; active replay cost p95: 1.4 ms.
- Lead: five ticks; replay p95: five ticks.
- Server residual debt p95: 7.8 ms, max 8.3 ms—below one simulation interval, consistent with ordinary accumulator remainder.
- 23 stationary displayed moving-ball samples; logical simulation ticks still repeated/jumped. Zero timing rejections, resync requests, or bot transitions during measurement.
- Proxy emitted connection-reset messages on teardown after the result; no browser errors were recorded during the match.

[Raw result](evidence/network-plan-2026-11-05/redeployed-volley.json). This supports fixing client cadence first. It does not rule out intermittent Render contention, Wi-Fi jitter, phone CPU/GPU limits, or a mismatched/cached Pages release.

## Research: current guidance and public implementations

These are sources inspected in November 2026, not all publications written in 2026.

- **Colyseus 0.18:** [current prediction guide](https://docs.colyseus.io/netcode/client-prediction) and [repository implementation contract](https://github.com/colyseus/colyseus/blob/master/PREDICTION.md). The guide explicitly warns that incorrect frame ordering can leave fast objects stalled at the newest available pose. The installed `@colyseus/sdk` 0.18.9 also includes `Predictor.ts` and `simReconciler.ts`: one frame driver, fixed-step input production, render-pose interpolation and correction. Its composite-world support is relevant, but opaque state must be fully restored; an adapter is not automatically compatible with our checkpoints/RNG/action ledger. Use as a reference and evaluate a small adapter spike, not an automatic migration.
- **Mirror:** [algorithm explanation](https://mirror-networking.gitbook.io/docs/manual/components/network-transform/snapshot-interpolation), [SnapshotInterpolation.cs](https://github.com/MirrorNetworking/Mirror/blob/master/Assets/Mirror/Core/SnapshotInterpolation/SnapshotInterpolation.cs), [tests](https://github.com/MirrorNetworking/Mirror/blob/master/Assets/Mirror/Tests/Editor/SnapshotInterpolation/SnapshotInterpolationTests.cs). Its standalone algorithm separates timestamps from render time, measures delivery variation, uses a deadband for catch-up/slowdown, bounds storage, and explicitly tests missing samples and interrupted timelines. Those are better design references than arbitrary per-mode smoothing constants.
- **geckos.io:** [TypeScript implementation](https://github.com/geckosio/snapshot-interpolation/blob/master/src/snapshot-interpolation.ts). Useful reference for matching entities by stable ID and buffering timestamped samples. Its generic buffer defaults are not a suitable local-control delay target for this game.
- **Photon Fusion 2:** [render behavior](https://doc.photonengine.com/fusion/v2/addons/advanced-kcc/render-behavior) distinguishes local render prediction from proxy interpolation and identifies the input-delay tradeoff of interpolation. Apply the distinction, not Unity-specific code.
- **2026 developer article:** [Net Forge, updated October 23, 2026](https://forge.netnet.capital/docs/guides/threejs-multiplayer-netcode), describes immediate local prediction, reconciliation, and delayed remote presentation. It is a small framework's own documentation, not an independently verified performance benchmark. Its simple movement example does not resolve our multi-body ball/catch interactions.
- **Renderer:** [PixiJS performance guidance](https://pixijs.com/8.x/guides/concepts/performance-tips) identifies frequently rebuilt graphics, changing text, texture churn, and batching as profiling targets. [Chrome's Long Animation Frames API](https://developer.chrome.com/docs/web-platform/long-animation-frames) helps attribute long main-thread frames where available; RAF traces are still required for smaller missed deadlines and unsupported browsers.
- **Transport research:** [Orlando and Gember-Jacobson, 2025](https://aaron.gember-jacobson.com/docs/nsdi2025browser-networking.pdf) compares WebSocket, WebRTC and WebTransport behavior under loss. Its experiments used server-side clients; browser/residential testing was future work. It supports testing TCP stalls, not promising that a transport swap will fix this game.

## Architecture decision

Separate four responsibilities with explicit clocks:

1. **Capture:** record timestamped held input and ordered action edges. Never discard a release/cancel during catch-up or batch formation.
2. **Predict:** a single monotonic fixed-step accumulator advances 60 Hz simulation. Generate sequence/tick-assigned commands and immediately apply them to local prediction. Correct clock drift gradually; do not freeze simulation because a transport interval has not elapsed. Keep bounded lead, history, and catch-up work.
3. **Transmit/reconcile:** send ordered commands with bounded batching if necessary. Preserve every edge and existing server admission limits. Associate acknowledgements/dispositions with exact simulated ticks. Apply authoritative snapshots and replay pending history coherently at a frame boundary before rendering.
4. **Present:** render a compact view once per RAF with one owner for interpolation/correction. Simulation state and render state remain separate. Confirmed scores, eliminations, damage, ownership, and outcome transitions remain authoritative.

Keep whole-world deterministic prediction in the first implementation. Our sports contain interacting players, balls, bots, contacts, and RNG; replacing the simulation with isolated local-player prediction could break those dependencies. Introduce presentation policy per entity, not a separate network stack per sport. For the controlled player, avoid the blanket two-tick buffer: use last/current predicted poses with the accumulator fraction initially, then test bounded render-only partial prediction for movement if the input-to-visible target is missed. Do not extrapolate through contact/ownership boundaries or feed fractional positions into gameplay.

For interacting balls and players, start from the same coherent predicted timeline. Remote-only snapshot interpolation and selective prediction are a later experiment requiring contact-alignment and fairness tests. Drawing the opponent in the past while evaluating catches against a different timeline can feel worse; do not apply shooter-style server rewind indiscriminately to continuous ball physics.

## Ordered implementation plan

### 1. Establish observable baselines

Add an opt-in diagnostic overlay/export with client/server build IDs, mode, device/browser, refresh rate, renderer resolution, RAF intervals, input event → capture → predicted application → submitted render timestamps, steps per frame, skips by reason, queue age, lead, snapshot intervals/bytes, decode/restore/replay duration, corrections and interpolation underruns per entity. Measure metrics per event, not repeatedly sampled copies of the most recent value. Record synthetic input-to-render separately from physical input-to-photon latency.

Expand the profiler beyond the primary ball: scripted mode-aware actions, every active object ID, contacts/resets annotated, real two-browser clients, and independent scripted input tapes. Capture CPU traces for laptop and actual phone; provide browser fallbacks where performance APIs are unavailable. Verify Pages and Render release identities first. Deliverable: a comparable offline/online baseline for each mode and a low-overhead export the user can capture on the affected phone.

### 2. Repair the shared simulation/input clock

Change `input-scheduler.ts`, `session.ts`, and the host/lifecycle boundary together. Replace minimum-time-since-last-send admission with accumulator-based logical input ticks. Define tick mapping and bounded clock slewing; handle decreasing lead without dropped simulation progress or replaying an action twice. Batch commands only after server validation/rate limits and sequence processing are updated to support them. Do not just delete the throttle: current authority permits bounded tick/rate windows.

Tests: alternating 16/17.333 ms calls, 30/59.94/60/90/120/144 Hz display schedules, catch-up bursts, changing lead, asymmetric latency, input press/release ordering, suspend/resume, reconnect, and stale history. Healthy ten-second traces must produce approximately 600 consecutive logical simulation steps, independent of transport flush count. Reuse deterministic hashes and action-admission tests.

### 3. Replace layered smoothing with a shared presentation model

Create an entity pose extractor/presenter boundary containing stable ID, generation, position/height/heading, velocity if needed, owner, action identity, and discontinuity markers. Cover all players, primary and extra balls, Guardian and its moving attack objects. Keep one primary-ball alias linked to its entity, not a second independently smoothed copy.

Apply correction once against poses at the same logical time. Interpolate continuous motion; use per-entity reset on spawn, retirement, catch, throw, teleport, elimination and respawn. Keep held balls attached to their holder's rendered socket. Whole-match epoch/round reset clears the scene; an ordinary possession change must not reset unrelated players. Use one render clock for trails and cosmetic animation; action windows remain simulation-timed. Keep readable warnings/telegraphs aligned with their authoritative danger timing.

Replace the existing Volley-only host branch and retire the overlapping correction path after parity tests. Tune bounded buffer/decay policies using measured error and underruns; avoid mode-specific magic values unless justified by a concrete discontinuity or speed constraint.

### 4. Reduce main-thread work with profiles

Measure decode, validation, restore, RNG creation, AI, collision, replay, clone/allocation, HUD, audio, and Pixi render separately. Then remove redundant observation copies using a detached compact render snapshot; retain ownership isolation and validation at the wire boundary. Cache unchanged names/styles/HUD, gate test-only DOM datasets, reuse pose buffers, index replay inputs once, and avoid rebuilding unchanged graphics.

Reconcile at most once per rendered frame to the newest complete checkpoint if several arrived, while separately preserving every event, acknowledgement, disposition, and epoch transition. Never drop reliable action outcomes along with obsolete snapshots. Only skip replay when matching complete deterministic state and pending command semantics prove it unnecessary. Do not disable AI or collision in replay without a demonstrated deterministic equivalence.

If replay remains the measured bottleneck, evaluate a simulation worker with compact transferable pose buffers; measure messaging delay before accepting it. If GPU-bound, test quality levels for effects and backbuffer resolution rather than lowering simulation tick rate. Raise snapshot frequency or add delta encoding only after evaluating CPU, bandwidth, jitter and replay tradeoffs.

### 5. Validate all mode semantics

| Mode | Required scenarios beyond movement |
| --- | --- |
| Cryptball | Carry, pass, shot, tackle, goal/reset, control switch and special |
| Cryptkick | Fast kicks, rebounds, possession, shots, goal/reset and special |
| Rift Volley | Serve, set/dig/spike, fast contact direction changes, net/bounce, rally point and next serve |
| Cryptcheck | Glide/brake, puck carry/pass/rebound, poke/body check, knockdown, faceoff and special |
| Crypt Dodge | Every simultaneous ball, throw/catch/deflect, hand attachment, retirement/spawn, elimination, round reset and control change |
| Crypt Guardian | All orbs, boss movement/attacks/telegraphs, cover changes, stages, down/revive, victory and simultaneous contacts |

Include rematch, Shuffle between modes, late join, disconnect/rejoin, tab backgrounding and orientation change. Existing failing/hanging network scenarios must be isolated and resolved or explicitly shown unrelated; do not count skipped Guardian coverage as an all-mode pass.

### 6. Acceptance and rollout

Use matched recorded scenarios: offline versus local server versus Render; 0/50/100/150 ms RTT as the normal envelope and 300 ms as stress; independent uplink/downlink delay, jitter, TCP stalls, bandwidth restriction and route changes. A delay proxy is not a packet-loss emulator; use OS-level impairment or accurately modeled TCP blocking for loss tests. Run repeated two-minute scenarios and a ten-minute soak. Test the actual phone plus laptop, mobile Safari/Chrome as applicable, and high-refresh desktop. CPU throttling supplements real-device results.

Initial engineering targets, to be confirmed against the offline/device baseline:

- Local synthetic input-to-first-visible-response p95 no more than one display interval worse than offline; target ≤33 ms at 60 Hz under normal network conditions. No RTT-sized wait for local movement.
- At 60 Hz, app CPU work p95 ≤8 ms and p99 ≤12 ms on the agreed target devices; fewer than 1% missed display deadlines during steady play. Report GPU and display cadence separately.
- No repeated-pose plateaus caused by send gating in continuous controlled trajectories. Report velocity/acceleration discontinuities and correction magnitudes too; stationary-frame percentage alone is not a sufficient score.
- Zero duplicated/lost action edges or incorrect confirmed outcomes; no healthy-link resync/bot takeover. Measured buffer underruns below 1% in the normal envelope. Predictable bounded recovery under 300 ms/stall stress, not a promise of latency-free play.
- Server tick duration and sustained backlog within budget at agreed concurrent room count. A normal sub-tick accumulator remainder must not be counted as overload.

Release one matching client/server revision, expose its identity, and compare each mode against the recorded baseline. Retain a coordinated rollback path. Require an actual phone/laptop playtest before calling this fixed.

## Hosting and alternatives

Render remains a possible source of transient delay, but the current evidence does not identify it as the leading problem. Free sleeping is an availability issue ([Render documentation](https://render.com/docs/free)); it is separate from an active match's cadence. First compare the same build and input scenarios locally and on Render. Consider an always-on instance for availability, and more CPU/a nearer region only when server backlog or network measurements justify it.

Rejected as first moves: larger whole-scene interpolation buffers (more sluggish local controls), only increasing snapshot rate (more serialization/replay work), copying a generic remote-interpolation library onto every ball (contact/timeline mismatch), switching to WebRTC/WebTransport immediately (deployment/protocol work without fixing the reproduced gate), and a wholesale SDK prediction migration (checkpoint/RNG/ack semantics need a compatibility spike). These remain conditional options after the first three stages establish a correct baseline.

## Remaining uncertainty

We have not captured the user's phone's current trace or verified its cached Pages asset. The new cloud trial measured one laptop-class Chromium client against Render, not two physical devices over the user's Wi-Fi. Stacked smoothing, allocation cost, cosmetic cadence and mode transitions are code-backed risks whose individual perceptual contribution needs isolation. The cadence gate is independently reproducible. This plan prioritizes that demonstrated defect while adding the measurements necessary to avoid another partial fix being called complete.
