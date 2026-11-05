# Cryptball networking plan — November 5, 2026

Follows `docs/cryptball-network-audit-2026-11-05.md`. I checked that audit against the source (`apps/cryptball/src/online/session.ts`, `apps/cryptball-server/src/{room,model,main}.ts`, `apps/cryptball/protocol.ts`), against the installed Colyseus packages (`@colyseus/core` 0.18.26, `@colyseus/sdk` 0.18.9, `@colyseus/ws-transport` 0.18.4), and against outside material listed at the end.

## 1. Verdict on the audit

The audit is accurate. I reproduced each of its code claims by reading the source. Most of its recommendations should be adopted as written. I disagree with two points and add four.

### Root cause, stated as arithmetic

On the client, `step()` schedules each input for:

```
tick ≈ lastTick + snapshotAge + RTT/2 (estimate of server now) + min(7, RTT/2 + 1) (arrival lead)
```

It then refuses any tick greater than `lastTick + 12`, where `lastTick` is the most recent snapshot the client has received. At steady state that means `RTT + snapshotAge(0–3 ticks) + 1 tick ≤ 12 ticks`. **The scheduler cannot work above roughly 130–150 ms RTT.** That matches the 150 ms result, where about a third of inputs were rejected.

Two more limits make it worse:

- **Lead cap.** The arrival lead is capped at 7 ticks (117 ms). Once the one-way uplink takes longer than that, every input arrives late. That explains 0 accepted inputs at 250 ms.
- **Slow RTT convergence.** RTT starts at a hard-coded 80 ms, is sampled once per second and blended 25% per sample. It takes about 5–8 s to reach the real value, so early-match inputs at high RTT are scheduled too late.

### Why it turns into a storm

- **Resume every frame.** When the window check fails, `step()` sends `resume` **every frame (60/s)**. Each `resume` makes the server clear that peer's input queue and send a full checkpoint. Recovery traffic grows as the link gets worse, which is backwards.
- **Bot takeover.** A client stuck in that loop sends no inputs. After 6 ticks the server cancels its held input, and after 30 ticks (500 ms) a bot takes over the player. The audit lists these thresholds but does not connect them to the storm. At ≥200 ms RTT, players are probably losing control to bots. This needs an explicit regression assertion.

### Where I agree

These audit recommendations stand as written:

- Fix timing and recovery before anything else.
- Keep 20 Hz snapshots and the full-world deterministic replay.
- Keep authoritative contact resolution.
- Add render-only offsets for remote players, with no interpolation delay.
- Add a narrowly scoped channel for predicted cosmetic events.
- Add scalar accessors, share one world capture per broadcast, and track lobby changes with a dirty flag.
- Defer compact or delta wire formats until measured.
- No transport migration now.

### Where I disagree

1. **"Derive lead, history and replay span together" is necessary but not enough.** Even a perfect RTT/2 estimate fails on asymmetric links, because the uplink is not half the round trip. The client should not have to infer how early its inputs arrive. The server should report it directly (see A1).
2. **Order of the server efficiency work.** The audit lists it after the visual work. Part of it should move into Phase 1. `MatchAuthority.receive()` calls `session.capture()`, which structured-clones the whole world, for every input. With four players at 60 Hz that is about 240 clones per second per room before any snapshot is built. Phase 1 already rewrites that function, so fixing it there costs almost nothing.

### Additions

- **A1 — Server-reported input margin (the Overwatch model).** Each snapshot already goes to one recipient, so it can carry that peer's input margin: how many ticks early its latest input arrived, plus late and starved counts since the last snapshot. The client adjusts its lead with a small controller aiming for about 1–2 ticks of margin plus measured jitter. RTT/2 is used only to seed the first lead. Overwatch does this by speeding up or slowing down its command-frame clock. We get the same effect by moving the lead tick, which needs no change to the 60 Hz scheduler.
- **A2 — Late grace for one-shot input edges.** Today a packet that arrives one tick late is rejected outright. Its strike press or release is lost, and the server repeats the held command. Instead, accept late packets within a small grace (for example ≤3 ticks), apply the edge on the next simulated tick, and acknowledge it. Movement stays authoritative and the action is never silently dropped. The client's replay already reconciles from `ack`. The audit's "preserve edges across backoff" covers the client side; A2 covers the server side.
- **A3 — Use the Colyseus 0.18 SDK we already have.** `node_modules/@colyseus/sdk/src` already contains `RoomClock.ts` (first-sample init, windowed-minimum RTT gate, RFC 3550 jitter, render clock), `predict/predictedEvents.ts` and `predict/confirmOn.ts`. Its `sample(sNow, rttSample)` interface could be fed directly from our `pong`. Whether `RoomClockImpl` is exported from the package is UNVERIFIED. If it is, instantiate it. If not, port its roughly 150 lines of logic. Either way, do **not** adopt `defineInput()` or schema state sync. Our checkpoint protocol is the right shape for a contested physical ball.
- **A4 — Never stop sending inputs.** If the target tick falls outside the window, clamp it to the server's acceptance window and keep sending. At most one resync should be in flight at a time, with exponential backoff. Remove the 60/s resume path completely.

## 2. Outside research: what applies

| Source | Takeaway for Cryptball |
| --- | --- |
| Overwatch GDC 2017 (Tim Ford) | The server signals input starvation and the client dilates its clock to keep a small input buffer at the server. Adopt the feedback loop as A1, without the time dilation. |
| Rocket League GDC 2018 (Jared Cone) | A networked physics ball with every entity predicted and a server-side input buffer. Confirms the full-world-predict model is correct for a ball sport. |
| Colyseus 0.18 SDK (installed) | RoomClock estimator and predicted-event identity, expiry and confirmation. Reuse the algorithms (A3). |
| Colyseus Tanks / Phaser template (audit) | Load-test bots that actively play, plus separate target and drawn positions. Adopt; use time-based decay rather than per-frame lerp. |
| WebTransport | Safari 26.4 (March 2026) made it Baseline across browsers. About 3–5% of networks block UDP, and the IETF protocol is not yet an RFC. Not warranted now; reconsider only if impaired-link tests show head-of-line stalls dominating after Phase 1. Server-side HTTP/3 maturity on Node is UNVERIFIED. |

## 3. Plan

The protocol bumps to `PROTOCOL = 10` in Phase 1. Every phase ends with `npm run test:cryptball:network` plus the harness from Phase 0, run with `TMPDIR` set outside the repo.

### Phase 0 — Make the failure a regression test (about 1 day)
- Promote `docs/evidence/.../timing.test.ts` into `apps/cryptball/tests/online-impairment.test.ts`, using the real client adapter as today.
- Add jitter (±20/40 ms, keeping order), asymmetric uplink/downlink, 100–250 ms stalls, and mixed RTT per peer.
- Record per scenario: accepted inputs, rejects by reason (late, early, revision, queue), resync count, bot takeovers, input-margin histogram, correction px p95, replay ms p95.
- Phase 0 records today's baseline. The gates are enforced after Phase 1.

### Phase 1 — Timing and recovery (P0)
1. **One config for every window.** Create a single `NET` config in `protocol.ts`: `maxLeadTicks`, `serverAcceptAhead`, `replaySpan`, `queueCapacity`, `historyLimit`, `lateGraceTicks`. Derive them all from one supported envelope (decision D1). These replace the hard-coded `12`, `7`, `16` and `HISTORY_LIMIT`.
2. **Clock estimator (A3).** Seed it from the first sample and gate it on the windowed-minimum RTT. Track jitter. Ping every 250 ms during countdown and every 1 s while playing. The client does not accept gameplay input until it has a converged sample.
3. **Margin feedback (A1).** The server adds `{margin, late, starved}` to each per-peer snapshot. The client's lead controller replaces the fixed `min(7, …)` formula.
4. **Window relative to estimated server tick.** Measure the client window from the *estimated server tick*, not from `lastTick`. Size the client prediction and replay span for about RTT + snapshot interval + jitter, capped by `replaySpan`. Above the cap, switch to an explicit degraded mode: clamp the lead and show a connection indicator. Do not fall into a loop.
5. **Resync separated from resume (A4).** Add a new `resync` message that sends a checkpoint without clearing the queue. Only one may be outstanding, with a timeout and backoff. `resume` keeps its suspend/resume meaning only.
6. **Late grace on the server (A2).** Add `lateGraceTicks`, preserve edges, and acknowledge late packets.
7. **Scalar accessors.** Add `session.tick()` and `session.controllerRevision(id)`. Use them in `receive()`, in the consume loop, and in the client's `step()` and `adopt()`.

Gates, measured on the Phase 0 harness (the audit's proposed criteria, tightened):
- Up to the envelope's full-quality RTT: <1% of ordinary inputs rejected after warmup, zero bot takeovers, ≤1 resync per 10 s per client.
- At the envelope's degraded RTT: no storm (resyncs bounded by the backoff) and no bot takeover.
- Client network work stays under its existing 4 ms p95 target.

### Phase 2 — Feel (P1)
- Give each remote player a render offset, using the same `exp(-dt/65)` decay. Reset it on teleport, phase change, ownership change or revision change.
- Add predicted cosmetic events for the local player's swing, charge and dash onset. Key them by `(epoch, generation, seq)`, then confirm or expire them, modelled on Colyseus `predictedEvents`. Scores, contacts and possession stay authoritative.
- Test audio's stale-event filter against the predicted display tick.

### Phase 3 — Server cost and observability (P1, small)
- Capture the world once per broadcast and attach the per-peer envelope (`ack`, generation, margin) to it.
- Keep lobby state behind a dirty or version flag, and throttle countdown updates to about 4 Hz.
- Add the per-reason reject counters, resync counts, margin distribution and outbound queue age to `/metrics`.

### Phase 4 — Real-world validation
- Run four headless browsers through a network-impairment proxy at the envelope points, with 30, 60 and 120 Hz rendering.
- Run playtests across separate machines covering all four sports and contested contacts.
- Run an active-bot load test (Tanks-style) for 1 room, then 25 rooms, before trusting `maxRooms: 25`.

### Phase 5 — Conditional, only if measurements require it
- A compact binary or delta checkpoint (it must keep RNG, cooldowns and hidden state), if egress or decode cost matters, for example on mobile.
- A WebTransport spike, only if head-of-line stalls dominate after Phase 1.

## 4. Decisions needed

- **D1 — Supported envelope.** I recommend full quality up to **150 ms RTT ±30 ms jitter**, and degraded but playable (no bots, no storm) up to **250 ms**. That suggests `replaySpan` ≈ 20 ticks, `serverAcceptAhead` ≈ 20 and `queueCapacity` ≈ 24. The CPU cost of a 20-tick full-world replay at 20 Hz must be measured in Phase 0.
- **D2 — Late-grace size** (A2). I recommend 3 ticks. A larger grace lets high-latency players act "in the past" in contested-ball moments, so it is a game-design call.

## Sources
- Overwatch summaries: https://edgegap.com/blog/game-backend-deep-dive-overwatch-2016-netcode-architecture-rollback, https://gamedev.net/forums/topic/701605-overwatch-client-input-buffer-dynamic-fixedtimestep/, talk: https://www.youtube.com/watch?v=W3aieHjyNvw
- Rocket League: https://www.gdcvault.com/play/1024972/It-IS-Rocket-Science-The, slides: https://media.gdcvault.com/gdc2018/presentations/Cone_Jared_It_Is_Rocket.pdf
- WebTransport: https://webkit.org/blog/17862/webkit-features-for-safari-26-4/, https://webrtc.ventures/2026/04/webtransport-is-now-baseline-what-it-means-for-real-time-media/, https://caniuse.com/webtransport
- Colyseus 0.18 SDK source as installed: `node_modules/@colyseus/sdk/src/{RoomClock.ts,predict/,input/}`
