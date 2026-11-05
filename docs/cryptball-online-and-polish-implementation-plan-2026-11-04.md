# Cryptball: online multiplayer, game feel, and pixel-art implementation plan

Date: 2026-11-04. Status: reviewed implementation plan; implementation in progress. Review dispositions are recorded below; shipped capabilities are reported separately in delivery notes.

## 1. Decision and scope

Build a server-authoritative, four-seat Cryptball game using the existing TypeScript simulation and Pixi presentation. Use Colyseus 0.18 as the room/session framework, Node 24 Maintenance LTS (matching the repo toolchain) as the initial server runtime, and secure WebSocket as the first production transport. Retain local practice and solo matches. Keep the initial networking adapter game-owned; extract provider-neutral engine primitives only when a second consumer demonstrates the shared contract. Do not migrate rendering engines or put socket code in the simulation.

Deliver these changes together:

- Quick Play matches the first four compatible arrivals; two or three can start immediately with bots filling vacant athlete positions.
- Two humans default to opposing teams, each with a computer teammate. Four humans play 2v2.
- Clearer passing and reception, a directional block/perfect block, and a full-charge Cryptbreaker shot with a distinct animation and enhanced first side-board bounce.
- A stronger SNES-inspired pixel-art treatment, prioritizing athlete readability and animation over additional environmental detail.
- A deployable match service, reconnect behavior, bounded network queues, version compatibility, and a focused multiplayer verification suite.

This follow-on supersedes the original plan's exclusions of online play and network snapshot infrastructure **for this phase only**. The [original candidate plan](cryptball-implementation-plan-2026-11-04.md) and [delivery record](cryptball-delivery-2026-11-04.md) remain the baseline for implemented behavior and unfinished acceptance. Existing court projection, 384×256 framebuffer, fixed camera, free-moving orb, four athletes, 90-second regulation, and 30-second sudden-death overtime remain.

Excluded from this release: ranked ladders, accounts/passwords, persistent progression, chat/voice, spectators, tournament brackets, mid-match public backfill, host migration, mobile/controller certification, general replicated ECS, generic rollback for every engine game, and a second arena. Private friend rooms are a small included convenience, not a party system.

The initial target is desktop browsers, one human per browser, one deployment region, and casual matches. All numeric network and balance budgets below are proposed acceptance targets or tuning defaults, not measurements already achieved.

## 2. Verified starting point

Inspected baseline: commit `6b1136dd1f3f0e59a6ccb20beee7f2a2eb84efa7` plus the current uncommitted Cryptball candidate. Preserve unrelated Museum, Wrecklight, engine-harness, and package changes. Record the actual implementation baseline before editing.

| Area | Current implementation | Required change |
| --- | --- | --- |
| Simulation | Pure game-owned modules; 60 Hz; four collision substeps | Reuse on server and client prediction |
| Human ownership | One `controlledId`, one command per `step`, team-0 assumptions | Per-participant ownership and simultaneous input |
| AI | All athletes except `controlledId`; support logic assumes Ivory human | Explicit controller map; symmetric team behavior |
| Passing | K/right mouse, teammate lead, control switch on successful strike contact | Reception, visible target, ownership-safe switching |
| Charge | 24 ticks, auto-release; 250→350 px/s | Full-charge hold window, special shot state and art |
| Defense | Body deflection and dash shoulder check | Directional guard and timed deflection |
| Snapshots | Detached observation omits future-affecting state; no session restore | Complete internal checkpoint and wire replica |
| RNG | Session owns RNG privately; shared RNG has capture/restore | Include its state in checkpoints |
| Events | Type/tick/player payload; no network identity | Stable action/event identity and replay-safe presentation |
| Lifecycle | Browser pause/cancel stops local authority, sometimes clears all players | Separate local pause from online input suspension |
| Network | No gameplay room service or transport found in engine sources | New optional runtime and service boundaries |
| Art | Pre-rendered directional sprites, heuristic recoloring; simple generated arena | Deliberate palettes, cleaner silhouettes, authored move poses |

Primary local evidence: [contract](../apps/cryptball/src/contract.ts), [session](../apps/cryptball/src/session.ts), [actions](../apps/cryptball/src/actions.ts), [AI](../apps/cryptball/src/team-ai.ts), [host](../apps/cryptball/src/host.ts), [rules](../apps/cryptball/src/rules.ts), [ball solver](../apps/cryptball/src/ball.ts), [RNG](../packages/game-simulation/src/rng.ts), and [asset importer](../scripts/game-assets/import-cryptball.py).

The broader [engine roadmap](66-post-m6-build-plan.md#networking-and-fighterrpg-expansion) discusses networking experiments without promising a completed netcode subsystem. Fixed-point positions alone do not establish cross-browser deterministic continuation: Cryptball also uses floating-point geometry/trigonometry and ordering operations. Server authority provides the final truth; prediction quality must be measured separately.

## 3. Networking research, as of November 2026

### 3.1 What other engines and frameworks provide

These are distinct layers: renderer/game engine, gameplay replication/prediction, room matchmaking, transport, and hosting. An engine's networking API does not automatically supply all five.

| System | Verified approach | Lesson for this engine |
| --- | --- | --- |
| Unreal Engine | Client/server authority and replication; dedicated servers are a first-class topology. [Official overview](https://dev.epicgames.com/documentation/unreal-engine/networking-overview-for-unreal-engine?lang=en-US) | Separate authoritative rules from the local player's presentation. A browser losing focus must not stop a match. No reason to port this small TypeScript game to Unreal. |
| Unity | Netcode for Entities supplies server-authoritative prediction; GameObjects supplies higher-level object networking. [Unity overview](https://docs.unity.com/multiplayer/netcode/netcode) | Borrow explicit authority, input, and predicted-state boundaries, without adopting DOTS/ECS. |
| Unity's 2026 evolution | The September NGO 3.0.0 release makes Netcode for Entities 7.0.0 a dependency. [Release record](https://github.com/Unity-Technologies/com.unity.netcode.gameobjects/releases/tag/NGOv3.0.0) | Old blanket comparisons of “GameObjects versus Entities” are version-sensitive. This release note alone does not prove all GameObjects workflows automatically gain full prediction. |
| Godot | MultiplayerPeer abstraction with ENet, WebRTC, and WebSocket implementations plus higher-level multiplayer facilities. [Godot documentation](https://docs.godotengine.org/en/stable/tutorials/networking/high_level_multiplayer.html) | Keep transport behind an adapter. Native ENet cannot simply be assumed available in a browser. |
| Photon Fusion | Dedicated-server, client-host, and shared-authority choices; authority has fairness and hosting consequences. [Topology guide](https://doc.photonengine.com/fusion/v2/fusion-choose) | Choose one server owner for the ball rather than transferring authority between players. |
| Photon Fusion 2.1 | July 2026 stable release includes forecast physics, bandwidth prioritization, and reconnect improvements. [Release announcement](https://blog.photonengine.com/fusion-2-1-stable-release/) | Smooth moving physics objects and recovering sessions are explicit product work, not consequences of opening a socket. |
| Photon Quantum | Input distribution plus deterministic local simulation and prediction/rollback, with a separate simulation model. [Quantum documentation](https://doc.photonengine.com/quantum/v3/quantum-intro) | A useful alternative architecture; adopting its simulation stack would be a substantial rewrite. Do not equate a coordinating input server with a server running all game rules. |
| Phaser ecosystem | Official Colyseus integration tutorial covers rooms, interpolation, client-predicted inputs, and fixed ticks. [Tutorial](https://docs.colyseus.io/learn/tutorial/phaser) | A JS renderer can remain independent of the multiplayer service. Pixi can stay. |
| Colyseus | Node authoritative rooms, matchmaking, binary state synchronization; 0.18 adds prediction facilities. [Overview](https://docs.colyseus.io/) | Best direct fit for the existing language, simulation, and four-seat game. |
| Nakama | Authoritative match handlers run fixed-tick game logic and explicitly broadcast state; supports broader backend capabilities. [Authoritative matches](https://heroiclabs.com/docs/nakama/concepts/multiplayer/authoritative/) | Strong option if accounts/social/persistence become central. Extra runtime/backend integration is unnecessary for this initial guest arcade. |
| Socket.IO | Connection management, acknowledgments, rooms, and optional recovery; ordered delivery is not durable exactly-once application delivery. [Features](https://socket.io/docs/v4/how-it-works), [delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/) | Viable transport/session infrastructure, but leaves more game-specific synchronization and matchmaking work than Colyseus. |

No engine is selected on a claim that it automatically makes shared-ball sports feel good online. That depends on the game integration and the contact test in N2.

### 3.2 Browser transports in 2026

| Transport | Benefit | Cost / limitation | Decision |
| --- | --- | --- | --- |
| Secure WebSocket | Broad browser support, straightforward TLS/proxy deployment, Colyseus default | Ordered reliable delivery can stall fresh updates behind retransmission; application must bound queues | Ship first |
| WebTransport / QUIC | Reliable streams plus unreliable datagrams to a server; useful for replaceable movement state | Deployment and adapter maturity need verification; older browsers/networks still matter | Optional measured second transport |
| WebRTC data channels | Configurable ordering/retransmission; browser P2P or server peers | Signaling, ICE/STUN/TURN, native server integration, connection recovery | Defer |
| Native UDP/ENet | Well suited to many native action games | Not a direct ordinary-browser socket API | Not applicable to initial web host |

MDN lists WebTransport as **Baseline 2026, newly available since March**, while WebSocket is widely available and lacks automatic backpressure. WebRTC data channels expose ordering and retransmission controls. [WebTransport](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport), [WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket), [RTCDataChannel](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel).

The Colyseus WebTransport adapter still labels itself experimental. Its documentation says unreliable schema fields stop updating after initial synchronization on WebSocket, rather than transparently becoming reliable. Therefore the first release must use ordinary reliable fields; adding a transport fallback later requires explicit equivalent state behavior. The adapter page's older browser-availability warning differs from current MDN; browser support and adapter readiness are separate facts. [Colyseus WebTransport](https://docs.colyseus.io/server/transport/webtransport).

### 3.3 Why Colyseus, and what it will not own

Use Colyseus for room membership, seat reservation, reconnect plumbing, serialization, transport, and initially its composite prediction integration. Keep team selection, bot behavior, collision outcomes, scoring, checkpoint completeness, and gameplay event identity in our code.

The release listing inspected on this date includes `@colyseus/core 0.18.26` and `@colyseus/sdk 0.18.9`. Treat these as research pins, not an instruction to install mismatched transitive packages blindly. N0 verifies compatible stable versions, schema/transport peer dependencies, licenses, Node compatibility, and lockfile integrity. [Release listing](https://github.com/colyseus/colyseus/releases).

The 0.18 documentation includes `defineInput`, fixed-timestep input consumption, and a composite `predict.sim` interface for interactions such as a paddle and puck. The adapter must restore all Cryptball state, including nested action and RNG state; scalar mirroring alone is insufficient. Use one complete-world predictor per client, not separate predictors competing over the same orb. [Server input](https://docs.colyseus.io/netcode/server-input), [client prediction](https://docs.colyseus.io/netcode/client-prediction).

**Build versus buy decision:** adopt the framework; implement the game integration. Do not build an independent matchmaking service, persistence platform, or full networking engine first. Do not add a second prediction loop around an active SDK predictor.

## 4. Product flow and room rules

### 4.1 Entry and matchmaking

Title actions: **Practice**, **Solo match**, **Quick Play**, **Play with friends**, **Settings**. Solo and practice require no server request.

Quick Play uses one public pool per region, protocol major, and rules/build compatibility group. “First four” means first four compatible arrivals in that pool, not four globally across incompatible builds or distant regions. Initial release has one region; do not fragment a small audience by skill or cosmetic choices.

The matchmaker reserves seats in the oldest open room, ordered by server creation time with room ID as a tie-break. Reservations expire after 10 seconds if assets/socket readiness never completes. Retry a room-full race against the next candidate, with a bounded retry count. The service owns the reservation operation; a browser-supplied room listing never grants a seat. Colyseus provides filter/sort and reservation primitives, but validate this FIFO policy under concurrent joins. [Matchmaking API](https://docs.colyseus.io/matchmaker).

Private rooms reuse the same room implementation but are excluded from public matching. A generated room code/link admits guests to its four seats; no password/account system. Rate-limit guesses. A private link is an invitation, not a privileged server credential.

### 4.2 Seats, start, and fairness

| Connected ready humans | Default roster | Start behavior |
| --- | --- | --- |
| 1 | Ivory human + bot; Ember two bots | Local practice while waiting. Online Start with bots disabled until a second human arrives; Solo remains available. |
| 2 | One human + bot on each team | Either human can press **Start with bots** |
| 3 | Two humans on one team, one + bot on the other | Any human can press **Start with bot**; roster visible |
| 4 | Two humans per team | Automatically begin countdown once all clients are loaded |

Assignment order: Ivory first slot, Ember first slot, Ivory second slot, Ember second slot. Lobby departures rebalance to this order before the next countdown; assignments are frozen at match start. Team names and assigned sides are visible before play. No team switching mid-match.

Start is idempotent and server-validated. The first valid request begins a three-second countdown and locks new public reservations. Requests at four ready humans do the same automatically. An already reserved fourth client may complete before locking only if the reservation has been incorporated into the roster; otherwise it receives a clear retry response. If a player drops during countdown, cancel it, release the lock, rebalance, and require a new start request unless four are ready again. Do not silently replace someone during the countdown and start a different roster.

State machine: `waiting → countdown → playing → results → waiting`, with `closing` reachable from any state on service failure/shutdown. The gameplay session retains its own ready/play/goal/results phases; room countdown and kickoff ready animation must not accidentally double the advertised countdown.

At results, offer Rematch and Leave. Rematch votes return retained humans to a visible waiting roster; start rules above apply again. Increment match epoch, clear input/action histories, and reset reconnect tickets associated with the previous match. A results room expires after 60 seconds without a rematch; an empty room closes after a short cleanup grace period.

### 4.3 Ownership

Separate four stable athlete IDs from participant IDs and transient connection IDs. A server controller map assigns each athlete to human or bot. A participant has team, selected athlete, ownership revision, connection generation, and switch cooldown.

- A lone human on a team may Q-switch between that team's athletes. The other athlete becomes AI-controlled at the same tick.
- A successful pass strike can switch that human to the bot receiver. A pass whiff cannot switch.
- With two humans on a team, each owns one athlete. Q is unavailable; passing never transfers ownership.
- When a teammate disconnects mid-match, its bot replacement remains in that seat. The remaining human does not acquire a new switching privilege until the next lobby. This prevents reconnect ownership fights.
- Switching cancels the old athlete's charge/queued action inputs; both peers see the same ownership revision. A command is interpreted against the ownership at its applied server tick.
- Client commands cannot name an arbitrary athlete or change team. The service derives the participant from the connection and validates ownership.

Refactor every team-0 special case: aim assist, AI support, shot/pass statistics, controlled ring, results labels, and audio perspective. `resetCourt` must preserve the controller map while resetting athlete actions.

### 4.4 Disconnect and focus

Unexpected socket loss reserves the human's seat for 15 seconds and immediately assigns a bot on detection. Silence without a socket close neutralizes inputs after 100 ms; after 500 ms without fresh inputs it enters temporary bot control. These defaults need tests with throttled/background browsers.

Reconnect authenticates a short-lived ticket, adopts a fresh full snapshot, clears stale commands, and transfers control at a server-tick boundary. Increment connection generation so packets from an old socket cannot apply. The player's first input starts neutral and held keys must be released before triggering a fresh charge. Explicit Leave is not reconnectable. Colyseus supports automatic and manual reconnection, but the game must still enforce these seat and bot policies. [Reconnection documentation](https://docs.colyseus.io/room/reconnection).

Online Escape opens a menu and relinquishes active input; show “Match continues — computer covering.” Returning requests control and resynchronizes. Offline Escape still pauses. A hidden tab does not accumulate seconds of inputs or replay an enormous backlog on return. If all humans leave, end and dispose the match after a brief reconnect grace period; do not run unattended bot rooms indefinitely.

## 5. Stack, ownership, and source layout

```text
Browser: existing Pixi/DOM/audio host
  → local-session adapter (practice/solo)
  → online-session adapter → Colyseus browser SDK
                                  │ HTTPS matchmaking / WSS
                                  ▼
                       TLS reverse proxy (Caddy)
                                  │
                       Node 24 match service
                       Colyseus room per match
                                  │
                       Shared Cryptball simulation
                       Four athletes + orb + bots

Static app/assets: immutable web build on HTTPS static hosting/CDN
Initial room state: process memory, no database or Redis
Later multiple processes: Redis presence/driver + room-aware routing
```

One long-lived container/VM in the selected region is the initial deployment unit. Use Docker with a pinned Node image and compiled JS server entrypoint. Do not put the 60 Hz loop in request-only serverless functions. Caddy terminates TLS and proxies HTTP/WebSocket to the room service. Static assets may be served separately; production client configuration explicitly identifies the service origin. The localhost preview is not the multiplayer deployment.

Proposed layout:

| Location | Responsibility |
| --- | --- |
| `apps/cryptball/sim/` | Game-owned rules, AI, input, capture/restore and checkpoint codec; exported as `@onepage/cryptball/sim` |
| `packages/game-network/` | Only exercised provider-neutral input/history bounds, connection state and event dedupe contracts. No Colyseus dependency or game types |
| `apps/cryptball-server/` | Room, guest admission, matching policy, server scheduler binding, protocol projection, health/metrics, shutdown |
| `apps/cryptball/src/` | Host, local/online adapters (Colyseus binding stays game-owned), presenter, effects, audio, lobby UI, input mapping |
| `scripts/cryptball/` | Local two-service launcher, network impairment runner, bounded capacity smoke |
| `deploy/cryptball/` | Dockerfile, example environment, Caddy configuration, deployment/runbook |

The browser and server import the game-owned simulation through its package export. Do not put authored game rules in engine `packages/`. Avoid service imports from presentation code and simulation imports from DOM/Pixi or Colyseus. Register both app roots in engine-protection policy, the pure simulation root in the purity checker, public import boundaries in game-boundaries, and focused scripts in engine-test-registry. These changes are authorized by the request to implement this corrected plan; preserve existing unrelated registrations. Export subpaths so offline builds never eagerly import Colyseus or Node modules. Use a separate server tsconfig/build with Node types, not the root DOM/Vite configuration as the server runtime definition.

The engine package must not contain team colors, Cryptbreaker rules, lobby bot counts, or court geometry. Implement only capabilities exercised by this game. The shared simulation owns one mutable state per session. Network replicas and presentation observations are detached values, never a second authority.

Add scripts: `dev:cryptball:online`, `dev:cryptball:server`, `build:cryptball:server`, `test:cryptball:network`, `test:cryptball:online-browser`, and `cryptball:network-smoke`. Keep existing solo commands working.

## 6. Simulation and protocol contract

### 6.1 One step, all participants

Refactor `step(command)` into a pure step accepting the commands for every human participant, plus explicit controller changes queued by the room for that tick. Derive AI commands only for bot-controlled athletes. Apply all admitted commands, then advance the existing shared physics once. Never step the world once per connected player.

Use a fixed 60 Hz simulation and retain four collision substeps. Network snapshots begin at 20 Hz, independently of simulation. Inputs are captured at 60 Hz and sent under the selected adapter's fixed-step contract. Rendering remains display-driven. Do not lower the existing gameplay tick rate to reduce socket traffic.

Within a tick, apply ownership/disconnect changes, resolve command priority, calculate AI intent, admit actions/steering, run collision substeps, settle goals, finish actions, then publish events. Stable numeric athlete order replaces locale-dependent comparisons where authority tie-breaks matter.

### 6.2 Deterministic authority and checkpoints

N1 replaces runtime trigonometric direction generation with checked-in integer tables; authority heading selection uses integer/table comparisons, and normalization/distance use bounded integer-root helpers. Audit transitive geometry as well as game files, define overflow/range bounds and rounding, and keep presentation math separate. Integer storage alone is not proof. Run an identical scripted full match in Node, Chromium, WebKit and Firefox and compare every tick's complete checkpoint hash, reporting the first divergent tick. Non-Chrome divergence is a real risk, not an already observed failure; the review's claim that every Safari/Firefox client necessarily fails is too strong.

Profile 12-tick correction batches including bots early. Preserve identical AI semantics during replay; do not throttle only replay AI decisions to hide cost, because that changes the predicted continuation. Optimize allocations/planning reuse or change deterministic planning cadence on both server and client.


Introduce `capture()` and atomic `restore(checkpoint)` in the game simulation. This is an internal same-build networking checkpoint, not a user save format or cross-version migration promise.

Capture everything affecting the next tick: current phase/timers/score; athlete transforms, velocities and integration remainders; action IDs/timings/hit sets; charge, guard, dash, stagger, immunity and input buffers; AI roles/targets/deadlines; ball motion/remainders/drag, pass chain and powered-shot state; controller map and switch state; next action/event counters; RNG stream state; match tick and epoch. Exclude particles, audio voices, DOM state, and drained outbound events. Transport admission windows stay in the server adapter, not in simulation state, but their applied ownership changes must be represented in a checkpoint.

Restore into staged temporary values, validate bounded lengths/enums/references/numeric ranges, then replace state atomically. Verify capture→advance→restore→advance matches the original continuation with identical inputs. Exercise active charges, guard contact, a bank, a goal reset, and bot RNG decisions. An `Observation` is not a checkpoint.

### 6.3 Messages and state

Send a complete versioned binary checkpoint envelope at 20 Hz with authoritative tick, epoch and applied-input acknowledgements in the same message. Decode and validate once, then call the game's atomic restore. Lobby/roster may use schema state, but do not mirror nested simulation state into partial scalar patches. Use a compact established codec or explicit bounded game-owned codec, measure against the 4 KiB target, and never silently omit future-affecting fields. AI RNG state is restored from RandomSnapshot; do not also memoize the same RNG draws through ctx.memo.

| Message/state | Required contents |
| --- | --- |
| Handshake | Protocol major/minor, simulation build ID, rules hash, client asset readiness, guest ticket |
| Lobby | Room ID, roster, ready state, start eligibility, countdown deadline, region |
| Input | Quantized move axes, aim heading 0–255, held/edge action bits, ownership revision, connection/match epoch |
| Snapshot | Complete future-affecting game replica, authoritative tick, match epoch, per-client applied-input acknowledgement, controller changes |
| Event | Match epoch, server event ID, tick, action correlation key, type and bounded payload |
| Recovery | Reconnect result, new connection generation, fresh full replica, fresh input baseline |
| Rejection | Stable reason code and actionable UI text: full, incompatible, expired, unavailable |

Framework input sequence/ack fields may supply acknowledgement mechanics; do not duplicate them unless N2 selects the explicit fallback protocol below. All replica fields required for prediction must come from one coherent authoritative tick. Never combine an ack from a later tick with a partially applied older state patch.

Reject non-finite values, invalid bit combinations, oversized payloads, unknown epochs, and commands outside ownership. Normalize/clamp movement before simulation using the same wire quantization in client prediction. Rate-limit admission and input traffic; admitting two commands cannot grant two movement steps. One-shot presses cannot repeat merely because a held-state packet is reused.

### 6.4 Missing input and slow connections

Use bounded per-participant input queues. N2 starts with a 32-frame maximum; persistent queue depth above six frames triggers resynchronization rather than seconds of delayed control. Apply at most one input per participant per server tick. Do not drain an entire burst and advance that athlete multiple times while everyone else gets one tick.

Missing frames briefly retain movement/aim/guard held state, clear one-shot actions immediately, and cancel charge without firing when the 100 ms silence threshold expires. Cancellation is participant-local; it must not execute the current global `cancel` behavior. A normal explicit strike release still fires. After the takeover threshold, bot commands replace missing human commands until control is restored.

Acknowledgements distinguish a consumed command from a synthetic no-input tick. The snapshot's server tick always advances even if no human sends anything. Verify the SDK mapping for this case; equal input count is not necessarily equal world tick.

## 7. Prediction, contacts, and latency policy

### 7.1 Selected approach

The server runs the only authoritative world. Each active client maintains a provisional complete world containing all four athletes and the ball. Own movement/actions are predicted immediately. Unknown remote movement is briefly held from the latest authoritative command/state; never invent a remote strike/pass edge. Bots can run from the captured RNG/state during prediction, but those decisions remain provisional and are overwritten by snapshots.

On authoritative state arrival: adopt the complete checkpoint, discard acknowledged local commands, replay the remaining local inputs with explicitly recorded/estimated remote context, and compute presentation-only correction offsets. Score, match result, and goal celebrations always wait for server confirmation. Prediction is a responsiveness technique, not client authority.

Keep the ball and athlete collision poses on the same predicted timeline. Rendering opponents 100 ms behind a present-time ball can make blocking look incorrect. Start with complete-world predicted poses and short correction smoothing; evaluate delayed interpolation only for non-interacting decorative entities. Never use smoothed screen coordinates for collision tests.

Initial presentation tuning: 50–80 ms correction decay for small errors; immediately snap on epoch change/kickoff or errors exceeding 12 world pixels; remove trails at discontinuities. Avoid smoothing the orb through a goalpost or wall. Keep a bounded 120-tick history and cap replay work at 12 ticks per rendered frame. If recovery needs more, adopt the fresh state and discard the stale local prediction window rather than freezing the UI.

### 7.2 SDK integration gate and fallback

Budget N2 for the scheduled-input fallback below. Evaluate Colyseus `predict.sim` only if installed source proves that binary checkpoints can drive adoption at the matching acknowledgement. Its scalar mirrors are not complete nested-state restoration. Any SDK integration must have adopt call the game's restore on the coherent checkpoint, one predictor per browser. The game owns capture/restore; the adapter maps framework acknowledgements to authoritative tick boundaries. SDK documentation requires consistent fixed-step input/prediction timing and replay-safe side effects. [Determinism contract](https://docs.colyseus.io/netcode/determinism).

Before expanding the integration, demonstrate all of the following with the real four-body solver:

1. Simultaneous opposing strikes settle to the same server outcome on all clients.
2. A snapshot restores nested action hit sets, RNG, integration remainders, and ownership, not merely x/y/vx/vy.
3. Missing input, unequal input counts, and server-only idle ticks do not replay an incorrect number of world steps.
4. Reconnect/goal resets invalidate old predictor bindings and input history correctly.
5. Repeated reconciliation neither duplicates effects nor grows queues.

Time-box this adapter proof before committing integration; a successful SDK proof is schedule upside, not an assumed dependency. If SDK ack/adopt semantics cannot express the coherent world contract, keep Colyseus rooms and WebSocket but replace **only its prediction/input timing adapter** with an engine-owned scheduled-input adapter. Do not run both.

Fallback protocol: commands carry monotonic sequence, target server tick, epoch, and quantized controls. Maintain a clock estimate using request/response timestamps; initially target estimated server tick plus `ceil(RTT/2 / tickDuration) + 1`, clamped to a 2–7 tick lead. Client predicts through that target horizon. Server accepts only bounded future ticks, one command per participant per tick, deduplicates sequence, and rejects late commands rather than rewinding committed scores. Snapshots identify accepted/processed sequences and their applied ticks. Reschedule only unsent commands when the clock estimate changes. Out-of-window clients resync instead of gaining extra simulation time. This is a bounded fallback implementation, with the same tests and budgets, not a new general rollback project.

N2 records which adapter was selected and the measured reason. Documentation of a library feature is not enough to close this gate.

### 7.3 Fairness and shared-ball policy

Do not introduce shooter-style rewind of only a defender's position. In this game the ball, blocks, other strikes, and goal crossings interact; granting a hit against old geometry while preserving the new ball state can create impossible results.

The first release uses forward server simulation, bounded input lead/buffering, and provisional client prediction. Late inputs are handled by the selected adapter policy, never arbitrary client timestamps. A perfect block window is evaluated at the command's server application tick. High RTT may reduce timing precision; expose connection quality and measure acceptability rather than promising competitive fairness at all latencies.

If 100 ms RTT contacts remain visibly unfair, first tune the input lead, contact tells, and guard window; then evaluate a coherent bounded server rollback design as a separately reviewed extension. That extension would need full-world replay and delayed finality rules, not a one-line rewind helper.

### 7.4 Events and audio

Give every server event an epoch/tick/counter ID. Correlate local action effects with participant, input sequence, and action kind, because locally predicted action IDs can differ after reconciliation. Play local swing/charge feedback immediately; confirm or retire it when the server event arrives. Never replay audio while resimulating. Remote effects play once from authoritative events. Goal score, horn, crowd celebration, and match results are authoritative only.

Keep event dedupe history bounded to the reconnect/history horizon. A reconnect starts at a new event cursor and current state; it does not replay an entire missed celebration. The soundtrack is local presentation driven by confirmed match phase; sample-accurate music synchronization between browsers is not required.

## 8. Passing, guard, and Cryptbreaker specification

All timings are initial 60 Hz tuning values and belong in the shared rules file. Bump rules/build compatibility when authority behavior changes. Art consumes action state; sprite frames never decide collisions.

### 8.1 Controls and priority

Keep WASD/arrows movement, pointer aim, J/left mouse strike, K/right mouse pass, Space/L dash, Q switch. Add **I or Shift: hold guard**, with a remappable binding if the existing public action-map adapter can be reused without widening scope. Show prompts on the title/practice screen and compactly during initial play.

Priority: lifecycle cancel → ownership switch → dash → guard → pass → strike. Dash explicitly exits guard; guard cancels a charging shot without firing. Guard cannot cancel an already active attack/recovery. While guarding, pass and strike require guard release. This avoids ambiguous same-tick actions. Preserve short action buffering only where explicitly allowed.

### 8.2 Pass and reception

Pass is a deliberate free-ball strike, not possession or teleportation. Retain 210 px/s initially. Use a compact 3-tick tell, 2-tick contact window, and 6-tick recovery. Aim toward teammate position plus bounded movement lead calculated from estimated travel time, capped at 0.2 seconds and 24 world pixels. Clamp target to the court; no trajectory homing after release.

Briefly mark the receiver and draw a small directional cue before contact. Do not show a guaranteed-success green lane when an opponent can intercept. Use a lighter swish/contact cue than a shot. Only a real ball contact begins pass tracking or switches to a bot teammate.

Track passer, intended receiver, team, and initiation tick. Complete the pass once on a receiver touch or strike; an opponent touch, goal/reset, or expiry after 90 ticks clears it. Board bounces can remain part of a pass. Statistics become per-team/per-participant, not hard-coded Ivory counters.

Allow a 6-tick buffered one-touch strike when a receiver anticipates an incoming pass; it still requires contact and can whiff. Do not silently slow every pass at the receiver. AI receivers move toward an intercept point, then choose a short touch/pass/shot. Humans get the same action affordances and physical rules.

### 8.3 Guard and perfect block

Guard startup: 3 ticks. Active guard: front 100-degree arc with a short weapon interception surface extending 4 world pixels beyond the body. Movement: 45% normal speed. Recovery after release: 8 ticks. Turn rate while braced is bounded so guarding cannot instantly cover every direction.

Implement the guard as a swept geometric contact candidate in the existing ball time-of-impact ordering, before body contact only when its hit actually occurs first. Keep player body collisions active. The arc does not block from behind and does not increase the whole character radius. Ignore a ball moving away from the guard to avoid repeated energy injection.

Normal guard deflects and retains roughly 55% of incoming speed, with a minimum separation impulse sufficient to leave the surface and a strict no-energy-gain cap. Perfect block is available for the first 6 active ticks after startup; it redirects toward the defender's facing at at most ordinary-shot speed, grants a short recoil to the defender, and emits a distinct spark/chime. Release/re-press has an 18-tick perfect-window cooldown so tapping cannot create permanent perfect guard.

A full-power shot can push a normal guard backward a small bounded distance but cannot pass through a correctly blocking defender. Perfect guard removes the powered-ball property. A ball contacting the back of an athlete follows existing body rules. Define one contact per guard/ball contact episode so a trapped orb cannot trigger repeated perfect blocks.

Keep dash/check as a separate committed move: current 10-tick burst, 66-tick reuse, one opponent check, and immunity against stun chains remain initial defaults. A braced frontal guard resists the check; side/rear checks can interrupt guard. Use the existing action state and swept collision order rather than a second overlapping combat subsystem.

### 8.4 Full-power Cryptbreaker

Keep normal shot speed 250 px/s. Partial charge scales toward the special threshold. Full charge at 24 ticks becomes visibly ready and may be held for at most another 18 ticks while moving at 45% speed. Releasing fires; holding beyond the limit auto-releases exactly once. Cancel, takeover, switch, or valid stagger discards the charge without firing.

Start full-power speed at 380 px/s. Increase the global ball cap accordingly and recheck the solver at that speed. Full power uses a 6-tick tell, 3-tick active window, and 16-tick recovery; it earns a strong strike but leaves the shooter committed.

Distinct behavior: the first **long side-board** impact retains 98% of incoming speed. Set `powerTeam`, `powerActionKey`, `bankBonusRemaining = 1`, and a 60-tick expiry on the ball. Posts, end walls, net walls, and body hits use ordinary collision behavior; a player touch/block clears the bonus. Consuming the side-board bonus clears it, and a corner cannot consume/apply it twice. No extra goal points, homing, defender penetration, or arbitrary acceleration at every bounce.

Visual sequence: planted charge pose → weapon/head highlight at full charge → broad release pose → 1–2 animation-frame contact accent → strong follow-through → recovery. Use a pearl-core team-colored trail with a visible pulse at the enhanced bank. Contact accents must not freeze network authority; any local animation hold is presentation-only and must not hide the moving ball. Reduced-motion mode uses a simpler flash/trail and no shake.

Update the AI bank predictor to share the actual powered-ball restitution/expiry rules. Bots should charge only when space and a plausible lane exist; no instant full power and no perfect-block reaction to unseen future inputs. Start with a minimum 6-tick reaction delay and the same cooldowns as humans.

### 8.5 Practice and balancing

Practice teaches three actions in sequence: pass to a marked teammate, block an incoming feed, charge and bank into goal. Keep normal practice available after completion. Compare direct shots, banks, pass chains, guard camping, and dash spam in two-human-plus-bot games before tuning four-human balance. Neither archetype gains different hidden stats in this phase.

## 9. Pixel-art and presentation work

The supplied screenshot establishes the current visual baseline. The three external image links from the discussion were not successfully retrieved during the initial inspection; do not claim frame-specific analysis of them. The target is a readable, deliberately authored 16-bit-era style, not exact SNES hardware emulation or copying reference pixels.

### 9.1 Art direction

- Preserve the shallow dimetric court and cyan/ivory versus coral/gold identity.
- Athletes need larger contiguous color shapes, clearer helmet/shoulder/weapon silhouettes, and stronger value separation from the slate floor.
- Use material-specific palettes, with roughly 3–5 deliberate shades per major material and approximately 24–32 visible colors per athlete variant as a guide. Avoid automated whole-sprite tinting or RGB rounding as the final art pass.
- Use selective outlines and consistent upper-left lighting. Keep contact shadows separate from the sprite and remove baked shadow remnants.
- Reduce incidental floor contrast beneath play. Concentrate environmental detail on borders, arches, goals, and banners.
- Keep the pearl orb visually dominant. Team marks and participant numbers distinguish ownership without relying only on color.
- Retain true 384×256 rendering, nearest-neighbor textures, integer display scaling, stable foot pivots, and depth sorting by projected feet.

### 9.2 Asset production sequence

First produce one polished warrior, one team palette, and four representative headings with idle/run/pass/guard/power poses. Composite it on the current court at 1×, 2×, and the typical full-window scale. Check action recognition and ball visibility in motion. Choose cleanup of current source versus replacement based on this proof before generating hundreds of frames.

Then finish both archetypes, both team palettes, and eight coherent facing directions. Eight deliberately authored directions are the proposed final art budget; the existing 16-direction selector must be changed explicitly and never reference absent clips. Keep 256-direction aim independent of art headings. Do not mirror asymmetrical weapons without checking handedness and silhouettes. If retained source permits efficient 16-direction cleanup at equal quality, record that choice in the manifest rather than mixing coverage silently.

Per archetype/direction, author idle (2–4 frames), run (6–8), pass (4–6), strike (6–8), guard enter/hold/exit (3–5), perfect-block recoil (2–3), power charge/release (6–8 plus held pose), check/recoil, and celebration. Reuse frames only when the action remains readable. Action timing markers are separate from displayed frame durations.

Replace or improve goals with readable front/far posts and a brief net impact; give the crowd several recognizable spectator silhouettes and restrained cheering groups; finish banners and crests; add a bitmap scoreboard font with accessible DOM labels. Avoid unnecessary scrolling, glow layers, and filters. No visual effect may obscure a passing lane or permanently cover the orb.

Store editable source and explicit palette/mask/anchor data. Extend the importer to consume authored exports deterministically; do not keep editing generated atlas pages. Retain provenance and licenses. Existing purchased sprite redistribution permission is unresolved in the candidate: private development can continue, but a public release must confirm permission or use replacement assets.

### 9.3 UI and sound

Lobby shows four seats, team, human/bot state, connection state, and the exact Start button. During play show local marker, teammate marker, charge readiness, and a subtle connection warning only when useful. Error screens offer Retry, Solo, and Back; do not expose protocol jargon to players.

Give pass, ordinary shot, full charge, Cryptbreaker, normal block, perfect block, and check distinct short sounds. Full-charge cue occurs once per charge. Keep music local and use the existing single audio owner. Tune effects at actual match volume and under four simultaneous players; reduced motion and mute must remain functional.

## 10. Service operation, scaling, and release

### 10.1 Initial service

Guest admission issues an opaque, short-lived session ticket scoped to room/match membership. Use HTTPS/WSS, origin allowlisting, bounded names rendered as text, input/payload limits, and per-IP/per-session admission limits. Tickets and reconnect secrets never enter URLs or logs. Do not collect accounts or persistent personal profiles for this release.

Authority never accepts positions, score updates, cooldown resets, or a client claim that it hit the ball. This reduces game-state cheating; it does not prevent aim automation. All players can see the court, so hidden-state filtering is not a first-release requirement.

Start with in-memory rooms. A process crash ends its matches and clients receive “Match interrupted” with requeue/solo choices. Do not claim reconnect can recover a destroyed process. Persisting live matches and migrating authority are outside scope.

The room scheduler has one monotonic time source. Catch up at most four simulation ticks per callback; sustained debt above 250 ms stops admissions and records an overload event. If debt remains unrecoverable, terminate affected matches explicitly rather than slowing some players indefinitely or running an unbounded catch-up loop. Browser frame debt affects only that browser.

### 10.2 Backpressure and observability

Track RTT/jitter, input queue age, snapshot age, bytes/client, correction magnitude, prediction replay time, event-loop lag, simulation time, active rooms, rejected admissions, reconnects, and abnormal match ends. Aggregate metrics by build/region; do not log every input permanently.

Set an initial 64 KiB per-connection pending-send ceiling. Do not drop an already serialized schema delta and continue with later deltas that depend on it. Slow consumers must either receive a valid fresh baseline through a supported reset flow or disconnect/reconnect. Avoid serializing another snapshot to an already saturated connection where the adapter permits it. Verify the actual transport hook in N2/N6; browser `bufferedAmount` alone is not a server backpressure implementation.

Expose `/healthz` for liveness, `/readyz` for admission readiness, and authenticated/private metrics. Public admin panels remain disabled. Structured logs identify room, epoch, build, and reason codes without tokens.

### 10.3 Capacity and expansion

Initial smoke target: 25 concurrent four-seat rooms / 100 connected test clients on a named staging machine. This is a test target, not a server capacity claim. Measure full cost including AI, snapshots, sockets, and event-loop overhead. Set production room limits below the measured saturation point with at least 30% headroom.

Budget full snapshots at a target ≤4 KiB each at 20 Hz: roughly 80 KiB/s downstream per player before protocol overhead, or 320 KiB/s per full room. Measure actual binary deltas before optimizing; reject unbounded action histories. Track an upstream target ≤10 KiB/s/player. Cost planning uses measured room CPU/RAM plus egress: connected-player-seconds × measured bytes/second. Obtain a current hosting quote at deployment; do not turn an unmeasured CCU guess into a dollar promise.

When a second process is needed, add Redis presence/driver and route each connection to the process owning its room; a generic round-robin reconnect target is insufficient. Rooms remain single-process authorities. Redis coordinates discovery/reservations, not per-tick ball state and not automatic crash recovery. Colyseus documents this process ownership and scaling model. [Scaling documentation](https://docs.colyseus.io/scalability).

Add regions only when measured geography demands them; choose by latency and visible player pool rather than splitting every arrival into an empty room. No Kubernetes, global matchmaking database, or service mesh is needed for the first release.

WebTransport is a future deployment change, not a Caddy toggle. Colyseus H3 terminates HTTP/3 itself; adoption requires UDP/443 and certificate ownership at the H3 endpoint or a specifically verified compatible proxy. The WSS Caddy configuration makes no claim to proxy WebTransport.

Node release policy: Node 24 is Maintenance LTS through April 2028; Node 26 is Active LTS as of October 28, 2026. Keep repo/server major aligned and add 24/26 CI coverage where those runtimes are available. [Official release schedule](https://github.com/nodejs/Release).

### 10.4 Deployment and upgrades

Build immutable client/server artifacts with matching protocol/rules/simulation IDs. Refuse incompatible joins with a refresh prompt. Drain an old server by disabling new rooms, retaining current matches through regulation/overtime/results, then shutting down. Bound drain to five minutes. New builds receive new matches; never hot-swap rules mid-match. Keep the previous image and static assets for rollback.

Local development uses a separate server port, initially 2567; keep existing preview ports intact. Prepare deployment configuration and a staging runbook during implementation. Creating paid infrastructure or publishing remains a separate concrete deployment action; this planning task authorizes neither.

## 11. Ordered implementation work

| Phase | Work and deliverables | Exit condition | Rough effort |
| --- | --- | --- | --- |
| N0: dependency and contract proof | Pin compatible Colyseus packages; inspect release APIs; server/browser build skeleton; choose final protocol fields and build identity | Headless simulation imports without DOM; matched client/server connect; exact dependency record | 1–2 days |
| N1: shared simulation and ownership | Extract game-owned sim; controller map; team-symmetric AI/stats; delete global cancel; complete capture/restore; deterministic math and early bot replay profile | Simultaneous commands + bots; local cancellation only; active-state restore; full-match per-tick checkpoint parity in Node/Chromium/WebKit/Firefox | 3–5 days |
| N2: real networking slice | One room, four clients, coherent replica/ack, complete-world prediction, event dedupe; actual collision latency experiment | Pass contact/restore/idle/reconnect tests; choose SDK adapter or documented fallback | 6–11 days (fallback budget included) |
| G1: game feel | Pass/reception, guard/perfect block, Cryptbreaker, symmetric AI, shared collision rules | Each mechanic works offline and online; no ownership theft, tunneling, duplicate charge release, or guard loops | 3–5 days |
| A1: visual proof | One polished athlete, key headings and move poses, palette/arena composite | Readable at native resolution and in motion; source-cleanup/replacement decision recorded | 2–4 art days |
| N3: lobby/product | Public FIFO pool, private room link, start with bots, countdown, roster UI, rematch | 2/3/4-human routes and fifth-arrival race work as specified | 2–3 days |
| N4: lifecycle/recovery | Explicit opt-in BrowserLifecycle input-suspension engine API + regression tests; focus/menu takeover; reconnect; stale input reset; failure screens | No global pause or stale charge on return; bots cover missing humans | 2–3 days |
| A2: final art/audio/UI | Complete directions/archetypes/palettes/action clips; goals/crowd/HUD; sound cues/tutorial | No placeholder move poses; readable full-match capture; provenance complete | 7–12 art/audio days |
| N5: network feel | Tune prediction/lead/corrections under real socket impairment and human play | Meets declared normal-network criteria; degraded connections fail intelligibly | 2–4 days |
| N6: operations and release candidate | Container/TLS examples, metrics, drain/backpressure, bounded capacity smoke, docs | Repeatable staging deployment and rollback; finished multiplayer candidate | 2–3 days |

Dependencies: N0 → N1 → N2; G1 begins after N1 but requires N2 integration before completion; A1 can start immediately and precedes A2; N3/N4 follow the N2 contract; N5 requires G1/N3/N4 and representative final art; N6 completes after N5. These are work streams, not a request to spawn agents.

Total engineering planning range: approximately 21–36 focused working days, including the bounded fallback. Art/audio: approximately 9–16 working days, potentially longer for fully original sprites. With a dedicated artist working alongside engineering, budget roughly 5–8 calendar weeks including iteration. A basic two-browser connection may arrive sooner, but is not the finished target. Revise estimates after N2 and A1 with measured evidence.

## 12. Verification and acceptance

This phase adds only tests necessary for multiplayer authority, recovery, new collisions, and presentation. The original demo's prohibition on snapshot infrastructure does not apply to the networking checkpoint required here. The repository's three-demo Arcade Volume 2 testing exception is scoped to that separate work; do not apply it globally to Cryptball. Use current applicable repository checks and preserve unrelated tests.

### 12.1 Focused automated coverage

- Ownership: both teams, simultaneous commands, switching with bot teammate, no stealing a human teammate, reconnect/goal reset, cancellation confined to one participant.
- Snapshot: complete continuation during charge, guard, bank, goal, AI decisions; invalid restore leaves old state unchanged.
- Actions: pass completion once, interception clears pass, buffered one-touch whiff, guard front/back and cooldown, dash resistance/immunity, full-charge release exactly once, bank bonus exactly once, new maximum-speed post/corner tests.
- Protocol: spoofed ownership, stale epoch/generation, duplicate/late input, NaN/oversized input, queue bounds, coherent ack/state, no faster movement from flooding.
- Rooms: concurrent fifth arrival, expired reservation, duplicate Start, countdown departure, private-room exclusion, 2/3/4-human starts, results/rematch cleanup.
- Prediction: correction convergence with known inputs, unknown remote strikes, no duplicate audio/events, bounded history/replay, SDK/fallback contract tests for server ticks without input.
- Recovery: socket drop/reload, bot takeover, ticket expiry, explicit Leave, hidden tab, process death, incompatible build.

Keep a small deterministic impairment simulator for authority tests, but also test the real WSS path through a network proxy/OS impairment setup. Artificially delaying a callback does not reproduce TCP retransmission and head-of-line blocking. Application-level unordered delivery tests are relevant to a future datagram adapter; do not claim WebSocket naturally reorders messages.

### 12.2 Network profiles

| Profile | Conditions | Required outcome |
| --- | --- | --- |
| Local | Same-machine and LAN, no imposed delay | Stable four-client full match and rematch |
| Normal | 40–100 ms RTT, up to ±15 ms jitter, 0–1% induced link loss | Responsive movement and usable passes/blocks; no permanent divergence |
| Degraded | 150–200 ms RTT, ±30 ms jitter, up to 3% link loss | Quality indicator, bounded correction/queues, no corrupt scores or frozen global game |
| Interrupted | 1–5 s disconnect, hidden tab, page reload | Bot coverage and clean resync inside grace window |
| Failed | Server kill or reconnect after expiry | Explicit interruption/expiry and requeue path |

Initial performance gates on named desktop/staging hardware: normal-profile p95 local movement response within two display frames at 60 fps; client prediction/reconciliation work p95 below 4 ms with no unbounded spikes; at target room load, server simulation tick callbacks p99 below the 16.67 ms interval with no accumulating debt. Record render/audio work too. Correction targets: uncontested athlete p95 error ≤2 world pixels; ball p95 ≤4 world pixels outside contested-contact windows. Report contested-contact corrections separately so averages cannot hide bad collisions. Adjust a target only with a documented reason and observed gameplay consequences.

### 12.3 Human and visual acceptance

Play two-human-plus-bot and four-human full matches on separate machines/connections. Players should deliberately pass, guard, recognize a perfect block, recognize full charge, and use a bank shot after the short tutorial. Review frustration from rejected contacts, constant switching, guard camping, AI crowding, and full-power spam. Record observations rather than declaring fun from a smoke test.

Inspect 1×/2× art and full-match motion for consistent pivots, legible teams, recognizable actions, hidden orb, effects overload, native pixel scaling, and foreground goal occlusion. Listen to a full match with simultaneous actions. Confirm mute/reduced motion, keyboard-only control, lobby readability, and meaningful error recovery.

### 12.4 Definition of done

The candidate is complete when the first four compatible users can join and play; two can start on opposing teams with computer teammates; all three enhanced mechanics work under the same server rules; reconnect and menu behavior do not stall others; the final art is coherent and readable; focused checks pass; real-network and human observations are recorded; and a repeatable server deployment/runbook exists.

Public shipping additionally requires a chosen host/domain, verified asset distribution rights or replacement art, and execution of the reviewed deployment. Do not describe a local preview, simulated network test, or prepared Dockerfile as a published multiplayer game.

## 13. Decisions to record during implementation

The defaults above allowed implementation without further product clarification. Decision status:

1. N0 resolved: compatible package pins and complete MessagePack replica; see section 15.
2. N2 resolved: narrow scheduled-input fallback; installed SDK acknowledgement semantics do not fit independent complete snapshots.
3. A1 resolved: cleaned source sprites with authored move variants and 16-heading coverage.
4. N5: final balance values and latency thresholds after playtesting.
5. N6: actual host/region/capacity cap and current cost quote before deployment.

Implementation decisions resolved on November 4: core 0.18.26, SDK 0.18.9, ws-transport 0.18.4, schema 5.0.43 (compatible with the repository’s TypeScript 7); complete MessagePack checkpoints; the scheduled-input fallback; cleaned source sprites with authored action variants and 16 headings. N5 human/real-network tuning and N6 deployed capacity remain acceptance work.

Every change to a default belongs in this plan or a linked decision note. Keep research claims, proposed design, measured results, and shipped capabilities distinct.

## 14. Review dispositions (2026-11-04)

Validated against the [review](cryptball-online-plan-review-2026-11-04.md), repository source and primary vendor documentation.

| Review item | Disposition |
| --- | --- |
| Game/engine ownership and registration | Accepted. Game sim and Colyseus wiring remain under apps; engine primitives provider-neutral; policy/purity/boundary/registry changes explicit in N0. |
| Cross-browser math | Accepted as a blocker/risk. Deterministic math plus full-match cross-engine checkpoint evidence in N1. An actual divergence is not established merely by an implementation-dependent Math call. |
| Nested checkpoint / RNG | Accepted. Coherent binary snapshot → atomic restore. One RNG policy; SDK adoption/ack coupling must be proven from installed code. |
| Lifecycle | Accepted after source inspection: opt-in shared input-suspension behavior with default behavior preserved and tested. |
| WebTransport topology | Accepted; separate HTTP/3 deployment evaluation. |
| Node | Confirmed from official schedule; 24 Maintenance and 26 Active LTS. |
| Slow client hook | Verify installed transport; enforce server queue bounds, not browser-only bufferedAmount. |
| Replay cost and estimates | Accepted profiling/fallback budget. Reject replay-only AI throttling that silently changes rule continuation. |

Hosting research supports portability but does not establish that managed hosting is unavailable. GameFabric confirms Hathora's wind-down and a migration path; Unity's official notice confirms deprecation with a migration exception; PartyKit docs confirm its hosted/CLI retirement. Exact Hathora shutdown date remains unverified here. These developments do not rule out GameFabric, Edgegap, Photon or other managed providers. [GameFabric announcement](https://gamefabric.com/blog/gamefabric-and-hathora-partner-to-provide-seamless-migration-for-multiplayer-game-developers), [Unity service notice](https://status.unity.com/info_notices/362941), [PartyKit documentation](https://docs.partykit.io/guides/deploy-to-cloudflare/).

Reject categorical claims that Nakama cannot run 60 Hz or SpacetimeDB has no game tick: Nakama advertises 1–60 Hz authoritative loops and SpacetimeDB documents scheduled reducers/game ticks. They remain less direct fits for this existing TypeScript simulation and integration scope; no comparative cost/performance benchmark was performed. [Nakama](https://heroiclabs.com/multiplayer/), [SpacetimeDB scheduling](https://spacetimedb.com/docs/tables/schedule-tables/). Durable Object expense is workload/pricing-dependent, not proved just by the frequency of a timer.


## 15. Implementation decisions and evidence

The implemented networking adapter lives in `apps/cryptball/src/online/`, with pure rules in `apps/cryptball/sim/` and authority/Colyseus service in `apps/cryptball-server/`. All are registered with repository ownership and boundary checks. No speculative `game-network` engine package was added. The shared browser lifecycle gained the explicit `suspend-input` policy; existing consumers retain pause behavior.

Inspection of installed SDK `predict/rollback.ts` showed reconciliation is gated by advancing `input.lastProcessed`. Independent binary snapshots, including ticks with no human input, cannot safely drive that contract. The implementation therefore selects the scheduled-input fallback now, rather than leaving SDK adoption as a prerequisite. Complete binary checkpoint messages atomically carry world tick, epoch, inputs, ownership, acknowledgements and RNG. The client restores/replays the whole game, caps replay at 12 ticks, and displays authoritative score/time/results.

The installed WebSocket transport exposes `client.ref.bufferedAmount`; the server enforces its 64 KiB queue ceiling using that value. The stock SDK reconnect token is transmitted in the encrypted WebSocket upgrade query. The application stores reload credentials in sessionStorage, puts only room IDs in invitation links, and the proxy example disables access logging. A blanket claim that credentials never occur in URLs would be incorrect.

Build identity is generated from protocol and transitive simulation source, including imported engine rules, for both browser and server. Mismatched identities reject admission. Production uses HTTPS/WSS; local development uses loopback HTTP/WS. Docker/Caddy examples and a drain/recovery runbook are prepared without provisioning a public service.

See [implementation delivery and remaining gates](cryptball-online-delivery-2026-11-04.md) for measured results. Prepared infrastructure and automated local tests do not complete the human, impaired-link, or staging-capacity acceptance gates above.
