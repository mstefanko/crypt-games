# Cryptball online candidate — November 4, 2026

The review was investigated, the implementation plan revised, and three GPT-6.1 Sol agents coordinated across simulation, networking, and engine boundaries/presentation. This is a locally implemented multiplayer candidate. Public deployment and the plan's human/WAN acceptance gates remain separate work.

## Implemented

- Four-seat public matchmaking, private invitation rooms, automatic four-human countdown, and two/three-human Start with bots. The first two arrivals play on opposing teams. A fifth arrival enters another room.
- A Node/Colyseus authoritative match service running the shared 60 Hz game rules. Game logic, protocol, server and browser adapter are app-owned; engine boundary, purity, ownership and test-discovery checks include them.
- Complete MessagePack checkpoints, participant ownership/revision, reconnect generations, bounded scheduled input, full-world prediction and restore/replay, event deduplication, authoritative score/results, and a simulation/protocol source-derived build identity.
- Deterministic integer maths and literal direction tables; complete capture/restore of nested actions, AI and RNG. Offline modes retain their local session.
- Bot coverage during menus, blur, silence and disconnection; reconnect/reload handling and explicit leave. The engine lifecycle has an opt-in input-suspension policy with its previous pause behavior preserved by default.
- Passing/reception, guard/perfect block, and full-charge Cryptbreaker with a distinct windup, effects, audio and first-bank behavior. Team material palettes and authored pass/guard/power animation variants cover 16 directions.
- Origin admission checks, bounded messages/queues, server backpressure, health/readiness/private metrics, graceful drain, and Docker/Caddy examples. These are deployment preparations, not a provisioned service or measured capacity claim.

## Research decisions

Colyseus core 0.18.26, SDK 0.18.9 and ws-transport 0.18.4 remain the chosen stack. Schema 5.0.43 is used because it supports the repository's TypeScript 7; the earlier 5.0.8 peer dependency did not. Game-specific simulation belongs under apps, and no unused generic engine networking package was introduced.

The installed SDK predictor reconciles when `input.lastProcessed` advances. That does not provide the coherent full-world adoption needed for independent binary checkpoints and no-input ticks. The game therefore implements the plan's bounded scheduled-input fallback. Colyseus provides rooms, admission, transport and reconnection.

The server's ws socket exposes `bufferedAmount`, so the 64 KiB pending-send ceiling is enforced server-side. The SDK's reconnect credential travels in the encrypted upgrade query; invitation URLs contain only a room ID and proxy access logging is disabled in the example.

The review's broad alternative-engine claims were corrected: Nakama explicitly supports up to 60 Hz; SpacetimeDB has scheduled game ticks. Neither was benchmarked against this game. Official hosting notices support portability but do not establish that all managed hosts are unavailable. Node 24 is Maintenance LTS and Node 26 Active LTS under the official schedule. WebTransport remains a later deployment/topology change.

Primary sources and item-by-item dispositions are in the [revised plan](cryptball-online-and-polish-implementation-plan-2026-11-04.md#14-review-dispositions-2026-11-04). The user's review remains unchanged.

## Run locally

From the repository root:

```sh
npm ci
npm run dev:cryptball:online
```

Open `http://127.0.0.1:4223/games/cryptball/` in independent browser profiles/windows and select Quick Play, or create a private room and share its invitation. The match service listens on loopback port 2567. This loopback URL is not reachable by friends on other computers. For the existing production preview on port 4224, build with `npm run build:cryptball` and run `npm run dev:cryptball:server`.

Controls: movement WASD/arrows; aim pointer; strike/charge J or primary pointer; pass K; dash Space/L; switch Q; guard I/Shift. The in-game tutorial is authoritative for alternate bindings.

See [service runbook](../apps/cryptball-server/README.md) for origins, TLS, reconnect credential handling, drain and deployment configuration.

## Verification and limits

Automated evidence:

- Final simulation checks: 30 focused tests and three full-match authority tests passed. TypeScript passed. Boundary checks passed for 341 files; purity passed for 140 modules with 186 unchanged baseline findings; affected lifecycle/boundary/discovery tests passed.
- Identical per-tick state hashes for a 7,503-tick scripted match in Node, Chromium, WebKit and Firefox.
- Production-browser integration: both scenarios passed (44.3 seconds): two-human start/menu/reload and four-human auto-start/fifth-room/leave. Under software-rendered overload, a paused client continues to display authoritative state while its bot covers. Both production builds passed.
- Network suite: 14 tests passed; the separate opt-in real-time socket run passed four tests in 128.09 seconds, including simultaneous 2/3/4-human matches through authoritative results with matching client scores.
- Representative moving-ball checkpoint, 12 replay ticks with forced AI replanning: browser p95 1.3 ms Chromium, 2 ms WebKit, 3 ms Firefox. Paired Node p95 1.18/1.15/1.46 ms. Fresh browser realm, 20 warmup batches and 40 measured batches. These pure-simulation measurements **meet the 4 ms target** but exclude rendering, audio and full reconciliation overhead. See [Chromium](evidence/cryptball-online-2026-11-04/chromium.json), [WebKit](evidence/cryptball-online-2026-11-04/webkit.json), [Firefox](evidence/cryptball-online-2026-11-04/firefox.json).
- An earlier stationary-ball fixture was replaced with a representative moving-ball fixture, initially measuring 4.3/5/6 ms. Conservative swept bounds now skip distant court shapes while preserving the exact engine collision solver and original candidate order; 592 cull-versus-unculled contact comparisons and unchanged cross-runtime hashes validate this optimization. Prior measurements are retained as `*-before-broadphase.json` and in the investigation evidence.


The complete-client 4 ms p95 prediction/reconciliation target remains a release measurement; the pure replay fixture above is only one part of that budget. Timing measurements are local to Apple M4, 10 logical CPUs, 16 GiB, macOS arm64. Cross-runtime hash equality applies to tested matches and runtime versions; it is not a proof for all future code or input sequences.

Still required before claiming the plan's release acceptance: separate-machine human playtests; real impaired HTTPS/WSS links and contested-contact correction measurements; deployed 100-client capacity/egress measurements; production host/domain configuration; and asset distribution-rights review or replacement art. Art changes refine the existing source-based pipeline rather than constituting a wholly original sprite set. No public endpoint was deployed.
