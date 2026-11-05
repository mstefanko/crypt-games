# Review: Cryptball online and polish implementation plan

Date: 2026-11-04. Reviewed document: [cryptball-online-and-polish-implementation-plan-2026-11-04.md](cryptball-online-and-polish-implementation-plan-2026-11-04.md).

## Method

- Source checked: `apps/cryptball/src` (untracked candidate), `packages/game-simulation`, `packages/game-runtime`, `scripts/engine-protection/policy.json`, `scripts/check-game-boundaries.mjs`, and `docs/game-engine-boundaries-and-presentation-roadmap.md`.
- External claims checked against the Colyseus documentation, the npm registry, MDN, WebKit release notes, the Node.js documentation and the Node.js release pages on this date.
- Hathora, PartyKit, Rivet and Unity Multiplay status comes mostly from vendor announcements and secondary reports.
- Not verified:
  - Colyseus server backpressure hooks.
  - Whether Caddy can forward WebTransport to a Colyseus H3 origin.
  - Edgegap, Playroom and Photon JS.

## Verdict

The plan is unusually thorough on product rules, ownership, lifecycle, checkpoints and acceptance. **Colyseus 0.18 on Node, with WebSocket first, is still the right stack.** Six issues should be fixed before N0 starts:

- Two are architectural blockers: §1, where code ownership is placed, and §2, cross-engine float determinism.
- One is a mis-scoped assumption about the SDK predictor (§3).

## Stack confirmation (research, November 2026)

| Claim in plan | Status |
| --- | --- |
| `@colyseus/core 0.18.26`, `@colyseus/sdk 0.18.9` | Correct. These are the npm `latest` tags (published 2026-11-03 and 2026-10-30). Core 0.18.0 shipped 2026-05-22. `engines: >=22`. |
| `defineInput`, fixed-timestep input, `predict.sim` | They exist and are not marked experimental. The server uses `setFixedTimestep(step, tickRate, {subSteps})`. `defineInput` provides `bufferMaxSize`, `sanitize` and `idle`. The client `InputHandle` exposes `lastProcessed`, `pendingCount` and `at(seq)`. `room.clock` provides time synchronisation. |
| WebTransport adapter experimental; unreliable fields stop on WebSocket | Correct. `@colyseus/h3-transport` sits on `@fails-components/webtransport`, is JS-client only and "not battle tested". |
| WebTransport Baseline 2026 | Correct. Safari 26.4 added it in March 2026, so older Safari still needs WebSocket. Node's `node:quic` is still experimental and has no WebTransport. |
| Node 24 LTS | Node 24 and Node 26 are both LTS. Following the normal schedule, 26 became Active LTS in October 2026 and 24 is now in Maintenance (support ends April 2028). See §6. |
| Alternatives table | Missing the 2026 hosting shake-out, which strengthens the self-hosted Colyseus choice. See §7. |
| Complete-world client prediction of a shared ball | Consistent with the published Rocket League approach: the client predicts the ball and all cars and replays constantly (Jared Cone, GDC 2018, "It IS Rocket Science!"). §7.1 of the plan is sound. |

Alternatives still rejected correctly:

| Option | Why it is rejected |
| --- | --- |
| Nakama | Heavier backend with weaker browser prediction tooling. |
| SpacetimeDB 2.0 | Its reducer/subscription model has no 60 Hz physics tick. |
| geckos.io | WebRTC UDP with prediction left entirely to you. |
| Lance.gg | Stale. |
| NetplayJS | Peer-to-peer rollback, not server-authoritative. |
| Cloudflare Durable Objects / PartyServer | A 60 Hz timer keeps the object awake, so duration is billed continuously. A poor cost fit for an authoritative loop. |

## Findings

### 1. Blocker: the source layout violates the repo's engine/game boundary and protection policy

**What the plan proposes**

- §5 moves the game rules to `packages/cryptball-simulation/`.
- It adds `packages/game-network/` with "explicit Colyseus client/server adapter exports".

**Why that conflicts with the repo**

- `docs/game-engine-boundaries-and-presentation-roadmap.md` §2 says individual games own their authored rules, balance and scene layout, and that `packages/` is the engine. Every current package is engine-level.
- `scripts/engine-protection/policy.json` says: "Default deny. Only declared game-owned app paths are writable. Package rules stay pinned pending explicit relocation."
- Neither `apps/cryptball/` nor the proposed `apps/cryptball-server/` is in `gamePaths`. `apps/cryptball/` is currently untracked.
- The plan never mentions `check:game-boundaries`, `check:game-purity`, `scripts/engine-test-registry.mjs` or the protection policy.

**Recommended layout**

| Location | Owner | Contents |
| --- | --- | --- |
| `apps/cryptball/sim/` (exported through a `package.json` `exports` subpath such as `@onepage/cryptball/sim`) | Game | Rules, AI, ball solver, actions, contract, capture/restore, replica codec |
| `apps/cryptball/src/` | Game | Host, local/online adapters, presenter, lobby UI, effects, audio |
| `apps/cryptball/src/online/` | Game | Colyseus SDK binding: `predict.sim` wiring, `adopt`/`pose`, connection UI state |
| `apps/cryptball-server/` | Game | Colyseus room, admission, FIFO matchmaking, scheduler binding, health/metrics, drain |
| `packages/game-network/` (new engine package, only after explicit engine authorisation) | Engine | Provider-neutral pieces only (see below) |
| `packages/game-runtime` (existing) | Engine | Small extensions: `browser/lifecycle` non-pausing "online" mode; correction decay built on `interpolation.ts` |
| `packages/game-simulation` (existing) | Engine | Reuse `DeterministicRandom` + `RandomSnapshot`, `tick-deadline`, `circle-geometry`; no Cryptball types |

What `packages/game-network` should contain, and only capabilities Cryptball actually uses:

- Bounded input ring and history.
- Event settlement and dedupe keyed by `(epoch, tick, counter)`.
- Correlation of predicted local effects with authoritative events.
- The connection state machine: `connecting → joined → reconnecting → interrupted`.
- The checkpoint adapter interface (`capture`, `restore`, `validate`).
- The deterministic impairment simulator used by authority tests.
- Network diagnostic and metric record types.
- The scheduled-input clock estimator, only if the N2 fallback is selected.

**Keep the Colyseus binding in the game until there is a second consumer.** The plan's own rule is "implement only capabilities exercised by this game". A provider-specific adapter inside the engine with one consumer invites premature generalisation, and it makes `colyseus` a dependency of the engine graph.

**Add to N0:**

- Add the new game paths to the protection policy.
- Get engine-change authorisation for `game-network` and the lifecycle extension.
- Extend `check-sim-purity` to `apps/cryptball/sim`: no `Date`, `performance`, DOM, Node, `colyseus` or `Math.random`.
- Add a boundary rule so `apps/cryptball-server` may import only `@onepage/cryptball/sim` and engine public subpaths.
- Register the new test scripts in `engine-test-registry`.

### 2. Blocker: cross-browser float divergence is acknowledged but not addressed

The server runs in V8 (Node). Clients run in V8, JavaScriptCore or SpiderMonkey. The authoritative paths use:

- `Math.hypot` in `rules.ts` (`length`, `normalized`).
- `Math.atan2` in `aimHeading`.
- A 256-entry `DIRECTIONS` table built at load time with `Math.cos` and `Math.sin`.
- Float `normalized()` results inside `steer` and the ball solver.

ECMAScript does not require these functions to return identical results across engines. Colyseus's determinism contract assumes the same step function gives the same result on client and server. A one-ULP difference that crosses `Math.round` changes a fixed-point position. A wrong contact then cascades into a ball correction on every Safari or Firefox client, regardless of latency. This would silently fail the plan's "ball p95 ≤ 4 px" gate on non-Chrome browsers.

The fix is cheap and should be part of N1:

- Emit `DIRECTIONS` as literal integer constants.
- Replace `hypot`/`normalized` with an integer square root on the fixed-point values.
- Replace `atan2` with a table or binary search over `DIRECTIONS`.
- Keep any floats presentation-only.
- Add a determinism test: run the same scripted match in Node and through Playwright in Chromium, WebKit and Firefox, and compare per-tick checkpoint hashes. Playwright already runs all three engines in this repo.

With this in place, client mispredictions come only from unknown remote inputs. That is the property the prediction design depends on.

### 3. Correct the `predict.sim` assumption and set the RNG policy explicitly

The plan says the adapter "must restore all Cryptball state, including nested action and RNG state". The documented behaviour is narrower:

- Decoded schema instances are auto-bound as scalar mirrors.
- For an opaque engine you supply `adopt(world)` and `pose(world)`. `adopt` re-seeds scalars, and everything else is re-derived by replay.
- There is no nested-state snapshot hook.
- The documented RNG pattern is `ctx.memo`: freeze a value so that replay reuses it.

Full restore is still possible, but only if `adopt` receives a complete checkpoint and calls our atomic `restore()`. The SDK will not do it for us. That makes the wire-replica choice the real decision for N2.

**Option A: checkpoint as a binary message at 20 Hz.** Send the full checkpoint as one versioned binary message per snapshot, carrying the tick and the ack together. `adopt` calls `restore(decode(msg))`. Schema state is kept for lobby and roster data only.

- This gives one coherent tick by construction, and it removes the plan's "partial patch + later ack" hazard (§6.3).
- It avoids mirroring hit sets, buffers and AI targets into schema classes.
- It avoids the schema-instance-stability work.
- **Recommended starting point**, at a size cost measured against the ≤ 4 KiB budget.

**Option B: the whole checkpoint as nested schema.** Delta-compressed, but it requires a large replica adapter, and coherence across patches must be proven.

**RNG:** pick exactly one approach and record it.

- Recommended: AI RNG state lives in the checkpoint (`RandomSnapshot` already exists), and is restored by `adopt`.
- Do not also use `ctx.memo` for the same draws.

**Add to the N2 gate:**

- "adopt → restore round-trips RNG, hit sets and buffers."
- "the `idle` option and `lastProcessed` map correctly to server-only ticks." This resolves the open question in §6.4.

Also note the documented input constraint: inputs must be flat primitive schemas. Cryptball's input (axes, 0–255 heading, bits, revision, epoch) already fits.

### 4. The browser lifecycle needs an engine change the plan doesn't name

`host.ts` drives `BrowserLifecycle` from `@onepage/game-runtime/browser/lifecycle`, and calls `lifecycle.pause()` together with `session.step({cancel:true})`. Online mode needs two things:

- A lifecycle that reports visibility and focus without stopping the clock.
- An input-suspension signal.

This is a change to a shared engine API, so it should appear in N4 with its own test. Today it is implied by "separate local pause from online input suspension" but owned by no package.

### 5. WebTransport would change the deployment topology

Colyseus `h3-transport` terminates HTTP/3 itself, while the plan has Caddy terminate TLS. A later WebTransport transport therefore needs either:

- UDP/443 and certificates delivered to the Node process, or
- verified proxy support.

Record this in §3.2 and §10 so that "optional second transport" is not mistaken for a configuration toggle. Keep the decision to defer it.

### 6. Node version

`package.json` declares `engines: node >=24`, and Colyseus requires `>=22`. Node 24 is acceptable for maintenance until April 2028. Two changes are suggested:

- Pin the server image to the same major as the repo toolchain.
- Run server CI on both 24 and 26, or move the new server to Node 26 Active LTS.

Change the plan's wording from "Node 24 LTS" to "Node 24 (Maintenance LTS) or 26 (Active LTS)".

### 7. Add the hosting landscape to §3.1 (supports the decision)

- **Hathora:** shut down around 2026-05-05 after its acquisition.
- **Unity Multiplay:** game-server hosting reportedly ended 2026-03-31.
- **PartyKit:** the hosted platform shut down 2026-10-23. PartyServer on your own Cloudflare account continues.

Self-hosting a framework you can move between providers is therefore the lower-risk choice. A single Docker VM is right, and the plan should say why: there is no viable managed browser-game host to rely on. Edgegap and Rivet could be later options but were not verified.

### 8. Smaller gaps

- **Backpressure.** No Colyseus slow-client hook was found in the documentation. Keep §10.2's verification. If there is none, implement it at the transport level with the `ws` socket's `bufferedAmount` on the server, not the browser's.
- **Replay cost at 20 Hz.** At 100 ms RTT plus a 50 ms snapshot interval, the client replays roughly 9–12 full ticks per snapshot, including AI for 2–3 bots. Profile `aiCommands` in N1, because the 12-tick-per-frame cap in §7.1 will be hit regularly. Consider throttling AI re-planning during replay, which is allowed because bot decisions are provisional anyway.
- **Global cancel bug.** `stepState` returns before advancing on `c.cancel` and clears every athlete's charge. The plan identifies this (§6.4), but N1's exit condition should explicitly include deleting the global-cancel path.
- **Hard-coded switching.** `controlledId` and `pendingSwitch` are hard-coded to `team === 0` in `session.ts`. The plan's refactor list (§4.3) covers this.
- **Effort.** N2 at 3–6 days assumes the predictor works. Given §3, budget the fallback realistically: plan for it and treat success as upside.

## Suggested plan edits (summary)

1. §5 layout: replace it with the ownership table in §1 of this review. Add the protection, boundary and purity registration to N0.
2. N1: add a cross-engine integer-math pass and a hash-comparison test across Node, Chromium, WebKit and Firefox.
3. §3.3, §6.3 and §7.2: state the scalar-only `adopt` behaviour. Make "checkpoint message → `restore()` in `adopt`" the default replica. Make the RNG-in-checkpoint policy explicit.
4. N4: name the `BrowserLifecycle` online mode as an engine change.
5. §3.2 and §10: record the WebTransport topology consequence.
6. §1 and §10.1: update the Node wording, and add the 2026 hosting-landscape note to §3.1.
