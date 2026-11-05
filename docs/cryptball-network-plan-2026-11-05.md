# Cryptball networking implementation plan — November 5, 2026

Recommended disposition: retain Colyseus rooms/WebSockets, the authoritative 60 Hz simulation, 20 Hz complete checkpoints and coherent full-world prediction. Implement timing correctness first. No shared-engine networking abstraction or transport migration is required.

This revision supersedes the earlier proposal, preserved in `cryptball-network-plan-2026-11-05.review-input.md`. It is an implementation plan, not a claim that fixes have shipped. The earlier audit measurements remain baseline evidence; they were not rerun for this planning pass. Source and installed-package exports were checked again. The working tree now has protocol **10** and checkpoint version **12**; use protocol **11**, or the next unused version at implementation time, for the new wire contract. Do not blindly set it to 10 or change checkpoint version merely for envelope metadata.

## 1. Decisions

### D1: supported latency and resource envelope

Adopt these product targets:

- Full quality: nominal RTT through 150 ms, with bounded additional variation of ±30 ms **on each direction**, reliable ordered delivery, no sustained loss stall. Test symmetric and asymmetric splits explicitly. This permits instantaneous RTT through 210 ms; saying just “150 ms ±30 ms” was ambiguous.
- Degraded but controllable: nominal RTT through 250 ms with the same bounded directional variation. More corrections are acceptable; recurring recovery requests, discarded ordinary control and unsolicited bot takeover are not.
- A 100–250 ms transmission stall is a transient recovery test, not a promise of uninterrupted full-quality visuals. Keep the human seat, neutralize unsafe stale actions, recover promptly. Longer outages may legitimately invoke the existing bot policy. A bad client's connection must not slow the other three.
- Warmup: first valid time sample initializes the estimate; up to 2 seconds to stabilize arrival margins. Do not wait for an undefined “converged clock.” Countdown normally supplies samples. Reconnect enters an explicit bounded synchronization state.

Provisional constants, centralized in app protocol/config and validated together:

| Setting | Initial value | Meaning |
| --- | ---: | --- |
| Simulation / snapshots | 60 / 20 Hz | Unchanged |
| Desired server arrival margin | 2 ticks | Small buffer; adaptive within 1–4 ticks using observed variation |
| Maximum estimated arrival lead | 20 ticks | A safety ceiling, not the normal lead or intentional input delay |
| Server maximum future tick | 24 ticks | Relative to current authoritative simulation tick |
| Prediction/replay hard span | 32 ticks | Relative to the received checkpoint; separate from server admission |
| Server pending capacity | 32 frames/peer | At most one execution slot per tick, bounded independently |
| Client command/outcome retention | 128 frames/peer | Bounded recovery metadata/history, not 128 ticks of replay |
| Late execution grace | 3 ticks | Actual execution tick minus requested tick, at most 50 ms |
| Quiet input neutralization / bot threshold | 100 / 500 ms initially | Distinguish command freshness from link liveness; see §5 |

Why not 20 ticks everywhere: 250 ms RTT + up to 60 ms directional variation + 50 ms snapshot age + roughly 33 ms arrival margin + scheduling allowance can exceed 400 ms, or 24 ticks. The hard span must cover this without forcing normal play to predict 32 ticks ahead. Budget 32 as a ceiling and measure 12/20/24/32-tick replay. The old 12-tick local limit and seven-tick lead are independent failure mechanisms.

Release gate: complete decode/adopt/replay/event-processing p95 under 4 ms on the agreed supported reference devices at full quality, measured with a real clock. Do not claim this from a virtual-time fixture or pure simulation benchmark. If 32-tick worst cases exceed budget, optimize or explicitly narrow the supported envelope; never silently stall command transmission or alter physics timestep. Degraded mode may temporarily render the authoritative view while bounded prediction recovers.

### D2: accept up to three ticks late, without historical authority

Adopt a three-tick **execution** grace. If current completed server tick is `S`, the next executable tick is `S+1`. A command requested for `T` may be retimed to `E` only when `0 < E-T <= 3`, and must still be valid for its epoch, generation, controller revision and game state at E.

This does not let a player act “in the past”: never rewind ball contacts, cooldowns, possession, score, charge duration or another player's state. A late strike can miss because the ball has moved. The design tradeoff is accepting a slightly old intention now, not granting historical hits. Recheck action eligibility at execution.

Preserve command order and execute at most one command frame per player per simulation tick. Do not merge press and release booleans from several frames or apply a batch of movement steps in one tick. See §4 for exact queue and acknowledgement rules. Expired intentions are explicitly rejected; “never silently lose an edge” means bounded retention plus a visible diagnostic outcome, not unlimited retries or guaranteed gameplay success.

## 2. Scope and ownership

| Component | Changes | Owner |
| --- | --- | --- |
| `apps/cryptball/protocol.ts`, optional `network-config.ts` | Limits, typed clock/feedback/resync/receipt envelopes, validation, version | Cryptball protocol |
| `apps/cryptball/src/online/{session,clock,input-scheduler,recovery}.ts` | Clock adapter, command cadence/identity, replay, recovery, metrics | Cryptball browser adapter |
| `apps/cryptball-server/src/{model,room,main}.ts` | Admission, late policy, input feedback, watchdogs, resync throttling, snapshots/metrics | Cryptball server |
| `apps/cryptball/sim/{contract,session}.ts` | Pure scalar accessors only; optional deterministic action-origin metadata if required | Cryptball simulation, **not shared engine** |
| `apps/cryptball/src/{host,audio,presenter,effects}.ts` plus online presentation helpers | Edge capture/consumption, render offsets, cosmetic deduplication | Cryptball presentation |
| `apps/cryptball/tests`, app-owned impairment/load scripts and evidence | Network regressions, profiling, real socket/browser scenarios | Cryptball tests/tooling |
| `packages/game-runtime/src/scheduler.ts` and browser lifecycle | Preserve 60 Hz accumulator, lifecycle and catch-up semantics | Shared engine; no production change planned |
| Shared simulation/collision/audio packages | Existing deterministic rules/services remain unchanged | Shared engine; no networking dependencies |

Boundary rule: no Colyseus imports, RTT, packet queues, network clocks, room IDs, bot-network policy or wall-clock reads in shared engine or pure simulation. Scalar accessors return primitives or detached minimal records, never mutable world references. Any command-origin metadata entering simulation must be explicit deterministic input and survive capture/replay consistently.

Only change the engine if a focused generic regression proves its existing contract broken independently of Cryptball. Make that a separate change with offline/lifecycle coverage. Command pacing belongs in the online adapter, not a variable timestep added to `FixedScheduler`. Rendering offsets never feed collision, aiming, AI or checkpoint state.

## 3. Clock and feedback design

Verified in installed SDK 0.18.9:

- The top-level SDK exports clock **types**, not the implementation.
- `import { RoomClockImpl } from '@colyseus/sdk/RoomClock'` succeeds in Node through the package's wildcard exports.
- The predicted-events subpath also imports successfully, but the implementation describes itself as internal machinery. Its availability does not make it a stable public API.

Use `RoomClockImpl` behind a small app-owned adapter, with the dependency pinned by the lockfile and a browser-bundle/import contract test. Do not copy its implementation or wire a fake schema/input handshake into this game. If browser bundling fails, resolve that dependency boundary before selecting a minimal independently tested estimator; no speculative source vendoring.

Extend pings and snapshots with server monotonic send time and a paired simulation tick anchor. The ping response echoes a bounded request ID/local send timestamp, includes server send time, current simulation tick, and epoch. Validate finite ranges and outstanding request identity. Never feed `tick * tickMs` as a continuously running wall clock: ticks stop in lobby/results and restart across epochs. Tick extrapolation is phase-aware and based on the paired anchor. Expose server debt so an overloaded server is not mistaken for a healthy faster clock.

Ping at 250 ms during initial synchronization/countdown for a bounded warmup, 1 s during healthy play, temporarily 250 ms during recovery. Initialize from the first valid RTT, reset appropriately on room/epoch transitions, and do not wait for multiple seconds of EMA convergence. Test a route change as well as startup.

Do not treat mixed 1 Hz pong and 20 Hz snapshot arrival intervals as one SDK jitter series. Use the SDK for clock/RTT estimates and a separate app-owned snapshot-cadence/input-margin estimator for jitter. Synthetic timestamps and receipt timing must have documented units. Symmetric RTT-based clock offset remains biased on asymmetric links; arrival feedback corrects scheduling without claiming to measure exact one-way latency.

Per-peer feedback in each snapshot:

- Highest received sequence, highest terminal sequence, pending execution assignments (§4).
- Recent arrival margin distribution/sample count; minimum and low percentile of `requestedTick - (serverTickAtReceipt+1)` are more useful than only the latest sample.
- Cumulative counters for late receipt, rejection reason, empty input slots, stale-control neutralization and bot transitions. Cumulative counters avoid losing telemetry if snapshots are coalesced.
- Sample sequence/range and generation. Ignore stale feedback, zero-sample windows and feedback from a previous stream.

Controller starting rule: initialize lead from RTT/2 plus two ticks, then increase quickly when measured low-tail arrival margin drops below target, decrease at most one tick after a sustained healthy interval (initially one second). Clamp feedback corrections and use a deadband; don't integrate repeated identical snapshot feedback. Target margin rises only within 1–4 ticks for observed jitter. These are tunable starting values with deterministic controller tests, not claimed optimal gains.

## 4. Commands, scheduling and reconciliation

### Monotonic command stream

Separate input sampling from network slot allocation and local rendering. The host samples at its existing 60 Hz ticks. Held movement/aim can coalesce while waiting for a slot; ordered action edges cannot. Start with an eight-frame unsent edge FIFO and a 100 ms local capture-age limit. Expire with a recorded reason, cancel unsafe held actions on overflow, and never retain edges across suspend, ownership change, generation or epoch reset. This local waiting limit is separate from the three-tick server execution grace. Change host/adapter consumption so a scheduling refusal does not erase unsent edges.

Maintain monotonically increasing sequence IDs and strictly increasing requested execution ticks for each `(epoch,generation)` stream. Changing lead must not rewrite packets already sent.

- Increasing lead may skip requested ticks; fill local replay with the previous held command and let the server repeat held state for those gaps. Do not invent extra action edges or advance authority.
- Decreasing lead may temporarily produce no new command slot. Hold/coalesce samples until the next legal slot instead of forcing `lastSentTick+1` forever; otherwise a lead increase can never unwind. Retain ordered edges with their original local capture age and expiry.
- Normal transmission stays near 60 packets/s. Catch-up is bounded and respects the existing 90 input/100 total-message rate limits; do not fire five frames of network work at one timestamp merely because rendering caught up.
- Local prediction advances toward the selected prediction horizon with the same command timeline; no extra simulation steps beyond the replay/work cap. Render-only cosmetic onset can occur immediately even when command allocation waits.
- At the cap, continue bounded liveness/feedback traffic and retain only fresh bounded intent. Do not clamp many packets to the same tick or send known-invalid targets. Clear out-of-envelope status explicitly; retain human ownership during brief healthy-link synchronization.

“Never stop sending inputs” is revised to **never let prediction failure silence the connection or erase fresh intent**. A transport with an accumulating outbound buffer cannot safely accept unlimited new sends. Bound unsent commands, heartbeat and recovery traffic; show degraded/reconnecting state for actual outages.

### Server admission and late execution

For each authenticated current-stream frame:

1. Validate schema, sequence monotonicity, requested-tick monotonicity, revision, rate and future bounds before queue insertion. Track receipt even when a valid fresh frame is rejected for timing; malformed/spoofed/rate-abusive traffic does not refresh healthy liveness.
2. Assign `E = max(T, S+1, previousQueuedExecutionTick+1)`. If E-T exceeds three ticks, expire the frame rather than shifting a whole backlog indefinitely. If E exceeds future bounds or capacity is exhausted, reject with an explicit reason.
3. Execute a single queued frame at E, preserving the original frame's movement, aim and edge ordering. Its movement applies for that server tick only; never retroactively accumulate movement or charge.
4. Before execution, revalidate epoch/generation/revision/activity and normal gameplay eligibility. A frame accepted into the queue may later be invalidated by an ownership switch. Distinguish transport acceptance, execution and successful game action.
5. Update held controls from the executed frame using a documented per-field edge/held classification. Audit `slide`/guard semantics alongside strike press/hold/release; do not assume every boolean is a one-shot action.

Ordered late bursts can legitimately expire frames when they cannot all execute within the three-tick grace. A stale release/cancel must still cause safe neutralization so a dropped release cannot leave an indefinite charge. Process this as a safety cancel at current time, never as a late shot. A newer held sample must not be overwritten by an older recovered frame. Test press→release, release→press, switch→strike, dash→pass and simultaneous legitimate flags across all sports.

### Acknowledgement contract: required, not optional

The existing `ack` plus `p.tick > snapshot.tick` filtering is insufficient when the server retimes packets. Define:

- `receivedSeq`: greatest validated sequence observed (not proof of execution).
- `terminalSeq`: greatest contiguous prefix whose commands have executed or been rejected/expired. Advance through terminal outcomes only, never acknowledge an accepted future frame as executed.
- For unresolved frames through `receivedSeq`, a bounded disposition table identifying accepted `executionTick` or rejection. Retain original requested tick separately. Include rejection outcomes above the terminal prefix until the prefix can advance. The bounded 128-frame ledger must cover client history; cap malicious sequence gaps.

A snapshot's checkpoint includes all execution through its tick. Drop history through `terminalSeq`; retain other frames using their assigned execution ticks, not their obsolete requested ticks. Pending retimed frames must replay at the assigned tick. Unknown in-flight frames use their original local schedule provisionally. Confirmed rejected frames never replay. If metadata falls outside retention after a long outage, enter an explicit acknowledged stream-reset/reconnect flow; a routine resync must not silently discard queued commands.

Add snapshot sequence numbers independent of simulation tick so two snapshots at the same tick can carry newer receipts/recovery metadata. Adoption must not skip them just because the tick is unchanged. Tests must cover delayed acks, rejection after an earlier future frame, accepted-but-unexecuted retiming, duplicate snapshots and generation resets.

## 5. Recovery, watchdogs and backpressure

`resync` is a bounded checkpoint request with request ID, epoch/generation and last snapshot sequence. It never calls `suspend(false)` or clears commands/history. Any sufficiently fresh compatible snapshot may satisfy it; the response echoes the request ID when explicitly served.

Client: one outstanding request; initial timeout `max(500 ms, 2*smoothedRTT+100 ms)`; exponential retry backoff capped at 4 s. Suppress requests while disconnected or while the socket cannot drain. Server: per-peer token bucket/coalescing (initially one served per 500 ms, burst one), also subject to room send budget; reuse the next scheduled snapshot when possible. Client throttling alone is insufficient. Keep explicit suspend/resume transitions idempotent, and reconnect generations authoritative.

Split watchdog state:

- Last valid traffic/liveness time: fresh valid command receipt or bounded 10 Hz heartbeat while commands are unavailable. It does not advance physics, change held movement, or bypass revision checks.
- Last executable control time: governs safe neutralization, taking already queued upcoming controls into account. Liveness-only traffic must not repeat stale movement or maintain a charge.
- Bot ownership: after 500 ms of actual traffic silence initially, or immediately for explicit suspend/drop under existing semantics. Do not count scheduling rejection alone as disconnection. A connected but timing-degraded client remains human-controlled and neutral when necessary.

Reactivation after genuine bot takeover is explicit: server transitions control, changes revision once, supplies fresh revision/checkpoint, and client resumes commands against it. Do not activate during consumption of a packet whose revision that same activation invalidates. Test this race and focus/reload independently.

Track per-peer outbound bytes and time spent continuously backlogged. The server's `bufferedAmount` bounds queued bytes, not exact delivery age. Call the time metric “backlog duration,” not measured packet age. On the browser, verify a supported transport-buffer hook before depending on it; never assume a server `client.ref` API exists on the client. Keep bounded app-owned unsent work regardless. Do not introduce 60 Hz full-checkpoint responses.

## 6. Presentation and server efficiency

### Feel

Render offsets for every player plus the ball; start from the **previous drawn pose**, not raw pre-correction simulation state, so repeated corrections do not visibly jump. Exponential time-based decay, initially 65 ms, with sport-aware snap thresholds. Reset by entity identity, ownership/revision, epoch, phase/serve/faceoff and teleports. No added remote interpolation delay initially. Renderer and targeting must explicitly distinguish drawn and simulated coordinates.

Local cosmetic events use `(epoch,generation,participantId,seq,eventKind,ordinal)`; seq alone cannot identify multiple effects or other participants. Emit once for first prediction, never during replay. Confirm/expire against an explicit server action-origin receipt, not a guessed event tick. If deterministic simulation buffers an action, preserve its origin until execution or expiry. Admission alone does not confirm a swing that cooldown rejected. Use an app-owned small ledger; borrow the SDK pattern without coupling the simulation to its internal helper. One-shot audio cannot be undone; predict only low-risk swing/dash/charge onset, with cancelable charge loops. Score, hit/contact, goal, possession and opponent effects stay authoritative.

Fix audio filtering against the authoritative event stream rather than dropping events older than predicted display ticks. Preserve event IDs across coalescing, ensure reconnect does not replay old audio, and retain offline behavior.

### Cost

Pull pure scalar accessors into the timing change: `getTick()` and `getControllerRevision(id)` (or existing naming conventions). Add them to the app simulation contract/implementation and replace hot-path capture/observe clones. Add a minimal phase/team accessor only where profiling warrants it.

After correctness, capture a common immutable world and common remote-input state once per broadcast tick, then attach per-peer metadata. Encoding remains per peer until profiling justifies a separate common binary body. “One capture” is not “one encoding.” Avoid mutating the shared capture while creating envelopes or updating authority.

Lobby version/dirty tracking must cover joins, leave/drop/reconnect, team selection, ready, activity, start/rematch, phase and capacity/lock changes. Throttle countdown UI to 4 Hz, but send its endpoints and important membership changes immediately. Full checkpoints continue at 20 Hz.

Coalescing snapshots during catch-up must preserve all unique authority events and latest input dispositions. If an event envelope exceeds budget, use a bounded reliable event path or explicit overflow handling; never silently discard events or send oversized packets. Recheck the 16 KiB wire bound with worst-case pending metadata and four simultaneous specials.

## 7. Execution sequence and deliverables

Each step is a reviewable change; Phase 1 substeps may remain on one feature branch until the new protocol is coherent. Do not ship incompatible halves.

| Step | Deliverable / files | Exit gate |
| --- | --- | --- |
| 0 | Promote audit transport fixture to `tests/online-impairment.test.ts`; factor reusable ordered-link simulator; add real-clock benchmark separately | Baseline reproduced on current build; capture fresh evidence, not assumed old protocol-8 counts |
| 1A | App NET config, protocol 11 envelopes/validators, scalar accessors, contract tests | Units/bounds explicit; malformed metadata bounded; scalar methods preserve determinism and isolation |
| 1B | Server admission/retiming/terminal ledger, arrival feedback, independent watchdogs, idempotent resume and throttled resync | All queue/edge/revision cases in §4–5 pass; no world clone in input admission |
| 1C | Clock adapter, monotonic command scheduler, host edge retention, heartbeat, new replay/ack adoption and recovery | Full/degraded matrix passes; lead can rise **and fall**; no storm, no unintended bots |
| 1D | Four real SDK/socket clients under an ordered delay proxy using actual adapter scheduling | Early integration gate before visual polish; independent rooms/slow peer/reconnect unaffected |
| 2 | Remote correction offsets, local cosmetic ledger/action origins, authoritative audio event filtering | No physics changes; no duplicate feedback; all four sports and offline tests pass |
| 3 | Shared capture, lobby dirty state, snapshot/event coalescing, operational metrics | Correct events/receipts; payload/CPU improvement measured; bounds remain enforced |
| 4 | Four real browsers, controlled render cadence, deployment-like WSS, separate-machine playtest, 1 then 25 active rooms | Document target-device costs, timing, egress and playable supported envelope |
| 5 optional | Compact/versioned payload or transport experiment only against a measured bottleneck | Isolated experiment; fallback and deployment cost justified; no prerequisite for release |

Metrics needed for correctness belong in Phase 0/1, not postponed to Phase 3: received/applied/expired counts; rejection reasons; margins; desired/actual lead; queue depth; resync requested/served/suppressed; heartbeat; neutralization; bot transitions; replay horizon and correction magnitude. Phase 3 adds bounded histograms, server event-loop delay, tick/pump/encode work, payload and backlog metrics to authenticated `/metrics`. Avoid unbounded per-room/session labels and do not expose credentials.

## 8. Test matrix and acceptance

Deterministic virtual-link tests must preserve WebSocket ordering independently in each direction: delivery time is at least the preceding packet's delivery time. Jitter may bunch messages; it must not create UDP-style reorder. Model packet loss as head-of-line stalls. Inject serialization-size limits, reconnect and disposal, plus bounded room event ordering. Use reproducible seeds and retain failure traces.

Required scenarios:

- Symmetric RTT 20/80/150/200/250/300 ms; asymmetric 10/140, 140/10, 25/225, 225/25 ms one-way pairs; ±30 ms directional variation with nonnegative delays; alternating good/bad periods and route changes.
- One 250 ms client with three 20 ms clients; four distinct links; 100/250 ms ordered stalls; a >500 ms true outage; background tab, slow render, rejoin and reload.
- Press/release/charge, held guard, pass, switch, dash and special; simultaneous ball contact; ownership revision changes; late bursts and queue-full/replay-cap/history-exhaustion; malicious seq/tick jumps and repeated resync requests.
- Every sport. Include active movement and ball play, not only neutral keepalives. Record bot transitions as events, not just a sampled count of inactive seats.

Full-quality gate after a documented 2-second warmup: <1% ordinary command timing rejections; zero accidental bot transitions; no expired isolated action edges under stable links; no normal-play resync after initialization (and never more than one per 10 s in the bounded jitter fixture). Degraded gate: no bots or recurring resync on steady supported links; at least 99% of fresh ordinary frames applied or validly superseded after warmup; maintain bounded queues and demonstrate actions still reach authority. Counters alone cannot pass a test where heartbeat prevents bots but every control is rejected.

Stall gate: no unbounded traffic/work and no other-client degradation; expired commands are accounted for, not required to execute. After traffic resumes, return to healthy control within `2*RTT + 500 ms` under the supported envelope. True outages/focus suspension may invoke bots and must reconnect without stale edges.

CPU measurements use an unmocked monotonic timer, measured separately from synthetic network time. Include decode, validation/restore, replay, disposition/event handling and allocations; measure complete browser frame costs separately. Capture per-mode p50/p95/p99/max and payload distribution at 12/20/24/32 replay ticks. First benchmark isolated; capacity tests then include scheduling/GC contention. No extrapolation from one-room p95 to 25-room safety.

Relevant repository checks, selected per change:

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
```

Add targeted impairment/benchmark commands or ensure the existing network glob discovers them, and verify the engine test registry discovers new files. Simulation-contract changes require the existing cross-runtime determinism suite. Use isolated ports/temp outputs and preserve concurrent working-tree changes. A custom TMPDIR is operational setup, not evidence that a networking change is correct.

Real-browser frame-rate control must be deliberate; merely asking headless browsers for 120 Hz is not evidence they rendered at that cadence. Record observed frame spacing. Separate-machine human playtesting is an explicit release gate, not something an automated run can claim to have performed.

## 9. Alternatives and source verification

- **RTT-only scheduling:** adequate seed, insufficient feedback for asymmetric links and runtime jitter. Adopt measured input-arrival margins.
- **Only increase 12 to 20:** leaves the seven-tick lead, recovery queue resets, stale edge consumption and ack semantics broken. Reject.
- **Clamp every sample and keep sending:** causes duplicate/nonmonotonic target ticks, invalid future traffic or inability to reduce lead. Use monotonic slot allocation and separate liveness.
- **Rewind ball for late strikes:** incompatible with the selected fairness model; do not add server-side historical contacts.
- **Change shared engine rate:** unnecessary coupling. Keep fixed physics and control network scheduling in the app.
- **Switch to Colyseus input/schema protocol:** not required to use its clock algorithm; full-world custom checkpoints remain suitable here.

[Rocket League primary slides](https://media.gdcvault.com/gdc2018/presentations/Cone_Jared_It_Is_Rocket.pdf), slides 132–138 and 176: support buffering inputs, predicting all relevant objects and accounting for correction cost. They describe actual upstream/downstream pacing changes, not proof that simply moving a target tick is equivalent. This plan implements explicit command-slot pacing without changing the shared engine timestep. The slides reference the Overwatch talk; its precise controller gains were not independently verified and are not imported as facts.

[Safari 26.4 release notes](https://webkit.org/blog/17862/webkit-features-for-safari-26-4/) confirm WebTransport support on March 24, 2026. This removes an old browser-support objection, but establishes neither deployment readiness for this Node/Colyseus service nor the quoted universal “3–5% UDP blocked” statistic. Do not use that percentage as measured Cryptball evidence. Defer transport work until WebSocket head-of-line delay remains a demonstrated bottleneck after timing fixes, and evaluate fallback/hosting then.

Installed source/API verification: `node_modules/@colyseus/sdk/src/{index.ts,RoomClock.ts,predict/predictedEvents.ts}`, package exports and successful Node imports. Browser bundle behavior remains an implementation gate. Existing public game comparisons and their commit-pinned links remain in `cryptball-network-audit-2026-11-05.md`.

Confidence: high in the timing/recovery failure mechanisms and boundary placement; moderate in proposed starting windows/controller gains until the expanded harness and full-browser cost measurements run. Product choices D1/D2 are recommended defaults ready for implementation, with measurable release gates rather than another approval dependency.
