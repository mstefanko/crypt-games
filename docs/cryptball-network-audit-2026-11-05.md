# Cryptball four-player networking audit — November 5, 2026

Keep the authoritative Colyseus/WebSocket architecture and 60 Hz simulation. The sampled four-player server workload has local CPU headroom, but the current client timing/recovery path is not ready to be called robust on higher-latency links. Fix that before increasing snapshot frequency or migrating transports.

This is an evaluation, with reproducible audit fixtures and measurements; production game logic was not changed. Reviewed the current working tree, including uncommitted Cryptball files, against repository HEAD `6b1136dd1f3f0e59a6ccb20beee7f2a2eb84efa7`, build identity `cryptball-v1-ffc5e7a56e71e5909e02b80d`. Node v26.0.0. Measurements are local, not production capacity certification.

## What is configured well

- One authoritative simulation per room, independent of input arrival. Four human field seats, bounded admission, fifth-player room separation, generation and revision checks, reconnect reservation, bot coverage, authoritative outcomes.
- 60 Hz fixed simulation; 20 Hz complete MessagePack snapshots; 8 ms server polling with at most four catch-up steps per poll. Server detects substantial debt and closes a match rather than silently losing simulation ticks.
- Browser fixed scheduler decouples simulation from display refresh and caps catch-up at five steps. Focus/visibility interruptions suspend input while authority continues. These are sensible foundations; no evidence here justifies replacing the engine scheduler.
- Input validation, bounded queues, stale input neutralization, payload bounds, disabled WebSocket per-message compression, per-client outgoing buffer checks. One slow peer does not impose a lockstep barrier on the other three.
- Shared deterministic rules and full-world restore/replay are appropriate for players contesting one physical ball. Keep authoritative contact resolution.

Sources: `apps/cryptball-server/src/{room,model,main}.ts`, `apps/cryptball/src/online/session.ts`, `apps/cryptball/protocol.ts`, `packages/game-runtime/src/{scheduler.ts,session/browser-lifecycle.ts}`.

## Reproduced timing failure: highest priority

The audit runs four instances of the **actual browser session adapter** against `MatchAuthority`, mocking only SDK transport and monotonic time. Each direction has constant RTT/2 delivery delay, reliable ordered delivery, 60 Hz server/client steps and 20 Hz snapshots. Each scenario lasts 15 simulated seconds. All four players reverse movement once per second. No random packet loss, jitter, rendering, TLS, or real socket buffering is included.

| RTT | Delivered inputs accepted | Delivered inputs rejected | Resume requests, all four clients |
| --- | ---: | ---: | ---: |
| 20 ms | 3,596 | 0 | 4 |
| 80 ms | 3,580 | 0 | 4 |
| 150 ms | 2,260 | 1,280 | 28 |
| 200 ms | 736 | 1,660 | 1,176 |
| 250 ms | 0 | 1,004 | 2,568 |
| 300 ms | 0 | 628 | 2,940 |

Four resume requests are normal initial adoption. Inputs still in transit at the end are excluded from accepted/rejected totals. The 150 ms rejects comprise 1,236 late packets and 44 revision mismatches; 200 ms comprises 1,644 late packets and 16 revision mismatches. All rejects at 250/300 ms are late. These exact counts depend on fixture phase/order; they establish a reproducible failure, not a universal latency threshold.

The client computes a server estimate from the latest snapshot/pong tick, elapsed time and RTT/2, then adds an arrival lead. Accounting for both snapshot age and future uplink is reasonable; do **not** simply remove one RTT/2 term as “double counting.” The problem is the combined policy:

1. RTT starts at 80 ms and is only blended 25% toward each one-second ping sample. Startup on a slower link can schedule inputs too late.
2. `step()` refuses targets past `lastTick + 12` (200 ms after the last received authoritative tick), clears history, and sends `resume` on every failed step. The arrival lead is also capped at seven ticks. At 200 ms RTT, half-RTT age plus seven ticks already approaches/exceeds the 12-tick window, before snapshot cadence and jitter.
3. A server `resume` clears the peer's scheduled queue and held command and sends another full checkpoint. During congestion this adds traffic and discards useful work; it is not a harmless clock probe.
4. Silence causes cancellation after six server ticks (100 ms), then bot takeover after 30 (500 ms). Controller revisions change across activity transitions. Recovery must explicitly handle this instead of relying on stale input being accepted.

Evidence: client `session.ts:364–408`, server `room.ts:87–90`, `model.ts:188–229,298–331`; [raw timing results](evidence/cryptball-network-audit-2026-11-05/timing.json).

Recommended implementation:

- Separate clock sync/checkpoint requests from participant resume. Allow only one outstanding recovery request, with timeout/backoff; do not clear the server input queue for a routine clock refresh.
- Initialize the RTT estimator from the first valid sample and sample during connection/countdown, before accepting gameplay input. Track snapshot age and jitter as well as smoothed RTT.
- Define a supported latency/jitter envelope. Derive input lead, history capacity and maximum replay span together, with a CPU budget and an explicit degraded mode. Increasing 12 to an arbitrary larger number alone is insufficient.
- Preserve one-shot input edges across temporary scheduling backoff, with expiry and acknowledgements; the host currently clears its input edges after `session.step()` even when that method returns without sending.
- Promote this fixture into regression tests that assert healthy acceptance, bounded recovery traffic and no unintended bot takeover. Add asymmetric links, one slow peer among three fast peers, jitter, stalls and reconnects.

## Local work and wire budget

A second fixture exercises all four sports for 1,200 ticks, excluding the first 120 from measurements. Each tick submits four commands, advances authority and builds a lobby; every third tick captures and encodes four complete snapshots. It includes fixture-side checkpoint access, but excludes sockets, JSON lobby serialization, room polling, rendering and operating-system scheduling. Concurrent local test activity can affect timings. This is a scripted workload, not a worst-case full-match benchmark.

| Sport | p95 sampled tick work | Median snapshot | Estimated payload egress per four-seat room |
| --- | ---: | ---: | ---: |
| Cryptball | 1.24 ms | 3,311 B | 275 kB/s |
| Cryptkick | 1.07 ms | 3,311 B | 275 kB/s |
| Rift Volley | 1.40 ms | 3,457 B | 289 kB/s |
| Cryptcheck | 1.00 ms | 3,409 B | 283 kB/s |

The 60 Hz tick budget is 16.67 ms. These measurements support CPU headroom for **one local four-player room**, not the configured 25-room capacity. Maximum sampled tick work ranged from 2.01 to 8.89 ms. Snapshot maxima were 4,074–4,236 B, below the 16 KiB limit. Payload egress is mean snapshot size × 20 × 4; it excludes protocol/TLS overhead, lobby messages and recovery bursts. Roughly 69–72 kB/s per client is workable on good links but unnecessarily expensive for this small arena. See [cost results](evidence/cryptball-network-audit-2026-11-05/cost.json).

Optimization order:

1. Add scalar/read-only accessors for current tick and controller revision. `capture()` and `observe()` structured-clone the world; input admission currently invokes both just to read these scalars, then repeats cloning during input consumption. Preserve snapshot isolation at public serialization boundaries.
2. Capture the common world once per snapshot broadcast, then attach each participant's ack/generation/identity. Currently the world is captured and encoded separately for each of four recipients. Sharing the capture is low risk; sharing encoded bytes requires a common-state/personal-envelope protocol design.
3. Avoid constructing and serializing an unchanged lobby every 8 ms. Use dirty/version tracking, and send countdown updates at a UI-appropriate cadence instead of each simulation tick. Do not delay ownership/activity changes.
4. After measurement, evaluate a compact binary checkpoint layout or versioned delta baseline plus periodic full keyframes. Include every field required by deterministic replay, including RNG, cooldowns and hidden action state. Do not blindly omit fields just because they are not rendered.
5. Coalesce redundant snapshots during catch-up/recovery where correctness permits, preserving events. A snapshot carrying undelivered events cannot simply be dropped. A 64 KiB buffer threshold is a useful bound but not a latency guarantee: at about 70 kB/s payload rate it represents roughly 0.9 seconds of traffic already queued.

Keep 20 Hz snapshots initially. Raising to 30/60 Hz before reducing the payload increases egress and reconciliation cost; it does not repair the scheduling failure.

## Responsiveness beyond local movement

**Remote player correction is under-smoothed.** Full-world replay extrapolates remote held commands, which cannot predict a remote player changing direction or pressing an action. `adopt()` computes correction offsets only for the locally controlled player and ball. Other players can jump on adoption. Keep the coherent predicted collision world, but add render-only correction offsets for each remote player, with teleport/phase/ownership reset rules. Evaluate timestamped interpolation for remote visuals carefully: drawing a player in the past while resolving ball contact in the predicted world can make contact look wrong. Do not transplant a shooter interpolation delay without contested-ball playtests.

**Local feedback waits for authority.** Both forward prediction and reconciliation drain/discard simulation events, and the user-facing event queue is populated from snapshots. Local movement can respond immediately while event-driven sounds/effects arrive later. For a command scheduled about one uplink into the future, confirmation can take approximately one RTT plus up to a snapshot interval (50 ms), plus scheduling/processing. Add a narrowly scoped predicted cosmetic channel for local swing/charge/dash onset, keyed for confirmation/deduplication. Keep scores, damage, contacts and possession authoritative. Also test audio's stale-event filtering against a predicted display tick.

**Diagnostics are incomplete.** `replayMs` starts after MessagePack decoding and ends before event delivery/storage and presentation; it is not total client networking/frame cost. Current metrics are aggregate counters and maximum severe debt, with no input rejection reasons, queue age, p95/p99 frame cost, recovery counts, or per-peer latency/correction distributions. Measure complete decode → restore → replay → presentation costs and event-loop delay before optimizing CPU further.

## Actual external source inspected, current in 2026

These are public runnable game/demo sources, not claims about private commercial game internals. Git checkout succeeded for all; the first two checkouts reported a local post-checkout hook error after fetching files, which did not prevent source inspection. No dependencies from those repositories were executed.

### Colyseus Realtime Tanks — April 14, 2026

Pinned commit `6339493130b4b1d4d28f0f52d17b2fba738c7d47`; Colyseus 0.17, Node authoritative server, WebSocket clients, 12-player arena demo.

- [BattleRoom](https://github.com/colyseus/realtime-tanks-demo/blob/6339493130b4b1d4d28f0f52d17b2fba738c7d47/server/src/rooms/BattleRoom.ts): server-owned room/game loop and player input state. Its 20 Hz simulation is not a recommended replacement for Cryptball's 60 Hz contacts.
- [BattleState](https://github.com/colyseus/realtime-tanks-demo/blob/6339493130b4b1d4d28f0f52d17b2fba738c7d47/server/src/schema/BattleState.ts): explicit typed synchronized fields separated from server-only fields. Borrow deliberate wire budgeting; Cryptball's replay needs more state than this demo's visual clients.
- [Load-test bots](https://github.com/colyseus/realtime-tanks-demo/blob/6339493130b4b1d4d28f0f52d17b2fba738c7d47/server/src/loadtest.ts): moving/aiming/shooting clients with navigation and pickups. Borrow active gameplay load generation instead of mostly neutral full-match clients.
- [Tank rendering](https://github.com/colyseus/realtime-tanks-demo/blob/6339493130b4b1d4d28f0f52d17b2fba738c7d47/web-threejs/src/Tank.ts): separates target and drawn positions. Borrow that separation; do not copy its fixed per-frame lerp coefficient, which varies with display rate.

### TypeScript Online Game Template — July 24, 2026

Pinned commit `c0c89c9cd6b7c2b1853277b4500e7d58ef345610`; Phaser, Colyseus 0.17, WebSockets, shared movement code and a playable multiplayer combat demo.

- [PlayerSystem](https://github.com/ASteinheiser/ts-online-game-template/blob/c0c89c9cd6b7c2b1853277b4500e7d58ef345610/apps/desktop/src/renderer/src/game/systems/PlayerSystem.ts): queues authoritative reconciliation until the next fixed tick and tracks pending inputs by sequence. Borrow applying state coherently at a simulation boundary; if coalescing Cryptball snapshots, separately retain all unique events.
- [RemotePlayerSystem](https://github.com/ASteinheiser/ts-online-game-template/blob/c0c89c9cd6b7c2b1853277b4500e7d58ef345610/apps/desktop/src/renderer/src/game/systems/RemotePlayerSystem.ts): separate remote presentation and delta-scaled smoothing. Borrow remote-specific rendering, preferably exponential/time-based correction.
- [PlayerInput](https://github.com/ASteinheiser/ts-online-game-template/blob/c0c89c9cd6b7c2b1853277b4500e7d58ef345610/apps/game-api/src/rooms/GameRoom/systems/PlayerInput.ts): bounded per-player queues and input staleness. Cryptball already has these protections. Do not directly copy sequence-only execution or dropping oldest commands: Cryptball has tick-addressed input and one-shot actions.

### Colyseus SDK/core — November 3, 2026

Pinned commit `d5a4f3df87d59c5d265e1851612ec2a4b69fedc7`. This is framework source, not a third game.

- [RoomClock](https://github.com/colyseus/colyseus/blob/d5a4f3df87d59c5d265e1851612ec2a4b69fedc7/packages/sdk/src/RoomClock.ts): first-sample RTT initialization, jitter measurement, low-delay clock samples and a separately smoothed render clock. These are directly relevant to Cryptball's clock estimator. Its built-in clock is wired to the input/timed-message handshake; merely reading `room.clock` in the existing custom protocol is not a migration.
- [Predicted events](https://github.com/colyseus/colyseus/blob/d5a4f3df87d59c5d265e1851612ec2a4b69fedc7/packages/sdk/src/predict/predictedEvents.ts): prediction, confirmation and expiry for cosmetic feedback. Borrow the identity/confirmation model while preserving authoritative outcomes.

## Verification and release gates

Fresh existing network run: **5 files passed, 67 tests passed, 1 opt-in full-duration socket test skipped** (72.56 s). The first sandboxed attempt failed to bind a local socket; rerunning with local socket permission passed. The successful suite includes actual four-seat joins, fifth-arrival isolation and reconnect ownership, along with model/client tests. The opt-in simultaneous full matches were not rerun.

Both audit measurements passed as measurement fixtures; they deliberately record current failures rather than asserting that networking is healthy. Re-run:

```sh
npx vitest run --config docs/evidence/cryptball-network-audit-2026-11-05/vitest.config.mjs
npm run test:cryptball:network
```

Before claiming four-player WAN responsiveness, require:

- Four actual browser adapters at 20/80/150/200 ms RTT, asymmetric and mixed-peer links, ±20–40 ms jitter and 100–250 ms stalls. Preserve WebSocket ordered delivery when injecting delay; model loss as transport stalls/retransmission rather than arbitrary reordered application packets.
- Separate-machine browser playtests with contested contacts, simultaneous action edges, all four sports, and 30/60/120 Hz rendering. Track local input-to-visible-action, remote correction and authoritative feedback separately.
- Suggested initial goals, subject to product playtesting: no recurring recovery storm; no unintended bot takeover on the supported steady-delay envelope; <1% rejected ordinary inputs after warmup; complete client network work p95 under the existing 4 ms target; per-room server work with comfortable margin below 16.67 ms. These are proposed acceptance criteria, not results already achieved.
- Production-like HTTPS/WSS measurements with bounded outbound queue age and p95/p99 server scheduling delay. Test 1 room first; measure 25 rooms separately before treating `maxRooms: 25` as validated capacity.

Recommended sequence: timing/recovery correctness → actual-client impaired-link regressions → remote visual correction and local cosmetic feedback → scalar accessors/shared capture/lobby throttling → compact wire format only if measured bandwidth or client decode remains material. No transport migration is warranted by the evidence collected here.
