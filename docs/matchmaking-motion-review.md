# Multiplayer motion and seat recovery

## Review and implementation decisions

The starting revision was `1fc4a65`. The findings apply to the five online sports. All distances below from the per-ball source probe are world units. Projected sprite distances vary with court position and ball height.

1. **Scoring transitions.** A client can predict a goal before its latest checkpoint awards one. The old client substituted the entire checkpoint for the newly predicted observation. In Volley the client predicted tick 118, yet drew the tick-104 court after already drawing tick 117. Snapshot age, input scheduling, and prediction lead all contribute to that gap. The proxy delay alone cannot predict the displayed tick gap. The host uses `FrameInterpolation`, whose correction offset has a 12-world-unit cutoff and a 65 ms exponential time constant. Its adjacent-pose continuity check already considers speed. The separate `PresentationCorrections` class and its hockey threshold are outside this render path.
2. **Keep the pending point visually stable.** The client holds the last submitted interpolated player and ball poses and the animation sampling clock while the older authoritative checkpoint still describes the same play. Score, phase, and match events continue to come from authority. A newer checkpoint can override a rejected prediction. A new timeline or disconnect clears the hold. Automatic player switches and serve-state changes within the same scoring phase preserve it. The client can still pause briefly before confirmation. Predicting a finish into the goal or net would require a reliable terminal trajectory for each sport. The current cosmetic ledger predicts local swing and dash onsets. For a rejected point with a free ball displaced by more than 24 world units, the corrected ball and shadow appear at their actual destination with 25% opacity and return to full opacity over 120 ms. Reduced motion shows the corrected position immediately. A speculative goal cue remains a separate design decision.
3. **Dodge throw provenance.** Mode and holder are authority-owned, while physical position can come from either prediction or a checkpoint. Matching visible mode and throw ID therefore do not establish matching pose source. The instrumented hostile throw changed from predicted flight to predicted reset while its confirmed flight remained active. The chosen physical position moved back by 97.5 world units. A friendly pass reaching local terminal contact also exposed this issue. A release-tick difference alone does not switch the source when mode, holder, and throw ID agree. The fix preserves the last submitted position for a same-flight reversal until the path catches up or authority resolves the discrepancy. Confirmed contact, retirement, a new throw, an authoritative direction change, or checkpoint catch-up releases the hold. Separate balls have separate histories. Advancing an old checkpoint by velocity times age would require sweeping through walls, the floor and other athletes, with flight height and contacts modeled consistently. Pinning a throw permanently to one source would also prevent recovery from a bad prediction.
4. **Reset flags and general smoothing.** The client already has authoritative phase, score, rally, Dodge round, throw, possession, and life markers. Use those first. Collect unclassified jumps by entity and transition. If a genuine teleport cannot be recognized between delivered checkpoints, carry a per-entity discontinuity generation in the checkpoint; a one-shot event can be missed. A configurable, speed-dependent offset limit should be tested on continuous movement before changing the global correction budget. Widening it everywhere could briefly draw a ball through a surface or interpolate across possession changes.
5. **Input and buffering.** The scheduler seeds arrival lead from RTT and adapts to server receipt margins. Additional local input delay is a separate experiment. One or two 60 Hz ticks add about 17 or 33 ms before local feedback if applied literally. Measure physical-input-to-first-drawn-motion, correction distance and rejected inputs at the same impairment settings before choosing a default. The covered/spectator buffer currently starts at 100 ms and grows in 25 ms increments to 150 ms on underruns. Active players use prediction. Compare buffer underruns, added viewer latency, and recovery after stalls before introducing a jitter estimator. Neither tuning change addresses a wrong presentation timeline.
6. **Recovery and closing a tab.** Page exit closes the transport with reload code 4010 and retains the reconnect token. Explicit Leave uses the consented room-leave path. The friends client now waits until the lobby and snapshot agree on epoch and role before exposing admission. A lost seat that falls back to watching gets an explicit message with Play next immediately available. The browser regression checks the original controlled player ID after reload, then exercises token loss, checks spectator role and empty controlled ID, and queues the spectator.

## Automatic checks and next debugging steps

Build the server once, then run the focused probe from the repository root.

```sh
npm run build:cryptball:server
node scripts/cryptball-matchmaking-motion.mjs .local-game-tests/motion.json
node scripts/cryptball-matchmaking-motion.mjs --check .local-game-tests/motion.json
```

The probe starts a loopback server and ordered proxy, drives three isolated Chromium clients through Find a match, and disconnects one client during each game. The host records submitted frames under 65 ms of base delay each way, ±20 ms of chunk jitter and a 0.8% chance of an extra 90 ms stall per chunk. The random sampler is seeded. Browser scheduling and match outcomes can still vary. The proxy preserves stream ordering and introduces no packet loss.

The gate compares consecutive active-play frames in the same epoch, score and round. It checks for a backward displayed tick, displacement of a held pre-point pose, and a large retreat along a continuing Dodge flight. The flight allowance uses elapsed time, observed velocity, tick advance, and rounding tolerance. It skips changes of flight identity, ownership, and velocity reversal. Large player or free-ball steps beyond estimated travel plus a correction allowance are recorded for investigation. Contacts, body separation, animation sockets and respawns make a universal per-frame top-speed assertion unreliable.

Set `MOTION_SPORT=rift-volley` to run a single sport. The trace checker can reproduce its verdict offline and checks sprite opacity on large, same-rally handoffs from a held free ball. Re-simulating a session offline would additionally need the starting checkpoint, ordered snapshot and input payloads, arrival times, clock samples, render times and lifecycle changes. Verify identical submitted poses on the original code before using such a replay to compare implementations. If the next issue needs an overlay, use that trace to draw predicted, authoritative, and submitted positions for a selected entity, labeled with source ticks and possession/throw IDs. This keeps display instrumentation out of normal play.

Use confirmed-point and rejected-point fixtures for scoring, and source-switch, contact, generation-change, and catch-up fixtures for Dodge. Then use the public-match probe for integration. For recovery, separately exercise a valid reload token, a missing token, and a player who chooses Leave. Require a settled role and controlled ID before judging success.

## Before and after

The same three-client scenario on the original client produced 11 backward-tick frames across the scoring sports and three large same-throw Dodge reversals. The proxy recorded 149 induced stalls before and 150 after. This is a sampled playtest, with different match timings on each run.

| Sport | Baseline failure count | After | Coverage in the corrected run |
| --- | ---: | ---: | --- |
| Cryptball | 3 court rewinds | 0 | 30 pending-point frame pairs |
| Cryptkick | 1 court rewind | 0 | 27 pending-point frame pairs |
| Rift Volley | 5 court rewinds | 0 | 63 pending-point frame pairs |
| Cryptcheck | 2 court rewinds | 0 | 45 pending-point frame pairs |
| Crypt Dodge | 3 same-flight reversals above the allowance | 0 | 230 comparable flight pairs |

The first implementation still rewound Volley when the authority described a serve within the same rally. The browser probe caught it, and the final unit fixture includes a serve and controller mismatch. A longer Dodge source probe recorded 10,160 source selections. On five severe reversals, including a predicted catch, the final renderer held the prior ball pose while the raw candidate jumped backward.

The general displacement probe also found a 60-world-unit Cryptkick ball step and two roughly 50–58-unit Volley steps as a stationary ball started moving. Those are candidates to inspect around serve or restart synchronization. Two other Volley jumps, 39 and 45 units, occurred as a predicted point was rejected and the same rally resumed. These motivated the short opacity transition described above. A focused Volley replay exercised two rejected points. In both, the submitted ball sprite started at 25% opacity and returned to full opacity eight submitted frames later. The positional correction remains measurable.

The friends test covered countdown cancellation when the second player left, replacing that player and starting the match, cutting both ends of the replacement's court TCP connection, recovering the same controlled ID after reload, and removing a disconnected queued spectator. The role-fallback browser scenario separately deleted the saved court token and verified that Play next actually queued the resulting watcher.

## Follow-up on the first moving ball

A second three-browser investigation separated the real move to a restart formation from the first movement after placement. The host logged the predicted ball before presentation changes, the latest server checkpoint and the submitted ball after interpolation. The video carries the index of the corresponding trace sample. Distances include height and use world units.

On the reference client at `bd6ec5c`, Rift Volley frame 586 went from a waiting ball to a position 50.5 units away. The incoming checkpoint at 399 still had a waiting server. Reconciliation produced a contact at 401 and replayed it through tick 413. Cryptkick frame 399 exposed a different path. The local predictor advanced a dribble by 1.3 units while the submitted ball moved 25.6 units from the ready formation to the player. The earlier 60.4-unit free-ball trace lacked prediction and checkpoint provenance.

The client captures compact ball samples during reconciliation of a waiting Volley serve or untouched protected-side Cryptkick placement. A short continuous path can play back at double speed until it rejoins live presentation. Incomplete approaches can use the existing 120 ms free-ball fade. Volley separates the serve marker from the scene-wide interpolation key and attaches the waiting ball to the drawn server. When a confirmed Kick or Volley countdown reaches its scheduled end, the renderer can present play on the same score and rally, including attached dribbles. A speculative point still freezes the submitted play frame.

### Reproduce

From the Crypt Games root, build the authority and run the probe on the desired client revision.

```sh
npm run build:cryptball:server
MOTION_SPORTS=cryptkick,rift-volley MOTION_STEPS=48 MOTION_LABEL=sample \
  MOTION_VIDEO_DIR=.local-game-tests/launch-video \
  node scripts/cryptball-matchmaking-motion.mjs .local-game-tests/launch.json
node scripts/cryptball-matchmaking-motion.mjs --check .local-game-tests/launch.json
node --test scripts/cryptball-matchmaking-motion.test.mjs
```

For a comparison against `bd6ec5c`, copy the current probe into that checkout before running it. Install dependencies locally in each worktree so its workspace packages and generated build identities match. The launch gate follows the first 250 ms or until the contact or scene changes. It counts failing opportunities once, distinguishes visible steps from faded corrections, and requires launch coverage. Ordinary point, held-frame and Dodge checks remain available.

| Sampled host | Reference, jumps / opportunities | Corrected at 572ce0c |
| --- | ---: | ---: |
| Cryptkick | 1 / 4 | 0 / 3 |
| Rift Volley | 2 / 6 | 0 / 6 |

The two runs recorded 110 and 109 induced stalls, respectively. All nine corrected launches stayed within the displacement allowance at full opacity. In corrected Volley frame 587 the raw prediction advanced 46.9 units, while the submitted ball advanced 0.9 units. Its largest step within the window was 8.2 units. A separate intermediate Volley capture had two faded discontinuities in eleven serves. Counts describe the recorded host in local proxy runs. Frame times, rally outcomes and opportunity counts vary.

For the free-ball mechanism, set `MOTION_SCENARIO=kick-restart` instead of choosing sports. This probe builds an instrumented authority in the ignored test directory. It starts in the standard team-1 restart formation at 1–0 with a 120-tick ready period and uses three browsers. The browser controlling player 2 strikes the untouched ball through the normal input path. The host remains neutral. Coverage requires the remote touch, no possession and a large raw correction. The reference host stepped 56.0 units (raw 60.2) on frame 356. The corrected host stepped 8.9 units (raw 91.2) on frame 374. Its maximum was 12.3 units within the launch window. Both selected launches were fully opaque.
