# Review: two-window Dodge motion investigation

Reviews `docs/dodge-two-window-motion-investigation.md` against source at f314516 and published netcode practice.

## Verdict

I agree with the diagnosis and with the fix order. There are three changes:

1. The bug is worse than described.
2. The cheapest fix is to stop suspending on blur at all.
3. Raise the spectator buffer from 100 ms to about 133–150 ms, or make it adaptive.

## Code claims verified

| Claim | Evidence | Status |
|---|---|---|
| Blur suspends input on a visible window | `browser-lifecycle.ts:58-61` blur leads to `interrupt()`. `host.ts:202-207`: `onInputSuspension(true)` leads to `online.suspend()`, and the cover menu opens only if `screen === "play"`. | Confirmed |
| Focus restore has no host action | `browser-lifecycle.ts:66-70` reports `false`, and `host.ts:203` handles only `suspended === true`. | Confirmed |
| Kickoff ignores suspended session | `host.ts:580-597` `beginOnlinePlay` sets `screen="play"` and calls `lifecycle.resume()` without checking `online` suspension. | Confirmed |
| `update()`/`step()` no-op while suspended | `session.ts:451`, `session.ts:537` | Confirmed |
| Server kickoff clears suspension | `model.ts:503-506` sets `p.active = p.connected` and `p.suspended = false` | Confirmed |
| Snapshots every 3rd tick | `room.ts:239` `tick % 3 === 0` | Confirmed |
| Interpolator drops >1-tick gaps | `frame-interpolation.ts` `capture()`: `next.tick > current.tick + 1` sets `previous = next`, which removes the interval | Confirmed |
| Music deep-clones every tick | `session.ts:644` calls `structuredClone(authority)` unconditionally, and `host.ts:221` calls it every paused frame | Confirmed |
| Token written to 2 keys per checkpoint | `session.ts:134-143`; the caller at `:346` is on the adoption path | Confirmed (call frequency not re-measured) |

### Gap the report understates

At kickoff the server wipes the client's earlier `suspend` (`model.ts:505`). The client stays suspended and sends no input, so after `botTicks: 30` (500 ms, `protocol.ts:44`) the server quietly hands the athlete to a bot (`model.ts:521-530`). The court looks normal and no cover menu appears.

If the user clicks back into the window, focus returns but nothing resumes the session. The controls stay dead for the whole match while a bot plays their character. The only exit is a mid-match blur that opens the menu, followed by "Return to play". In a real match this looks like "the game ignores my keys". That is a worse symptom than stutter, and it is probably what players actually hit.

The underlying problem is that suspension has two owners: client and server. Each one resets it independently.

## Where I'd change the plan

### 1. Don't suspend on blur; release keys instead (new step 0)

MDN states that `blur` fires when the user switches windows while the page stays visible. Hidden state is what `visibilitychange` is for. Chrome stops rAF only for hidden or background tabs, not for blurred visible windows.

Recommended policy:
- **blur**: clear held keys and pointer state (this prevents stuck inputs, which is the real reason to react to blur), latch neutral input, and stay active. Optionally dim the screen and show "click to focus".
- **visibilitychange → hidden**: suspend as today, with bot cover and the cover menu on return.

This removes the whole bug class for side-by-side windows, Discord alt-tabs and second monitors. Keep the report's step 1 for the hidden path, because the kickoff race still exists there. With this change it is rare instead of routine.

### 2. Make one owner for suspension (the report's step 1, sharpened)

The client is the source of truth for its own away state:
- On every epoch or phase change (kickoff, rematch, reconnect), the client re-asserts `suspend` or `resume` when it adopts the first checkpoint of the epoch.
- The server should keep `p.suspended` across kickoff instead of clearing it, and seat the player as bot-covered right away rather than after a 500 ms timeout.
- `beginOnlinePlay` must check `online.suspended`, or the lifecycle's input-suspension state, after prewarm. If away, open "Computer covering"; if present, call `resume()` with a neutral latch.

Regression test: blur, then hide, the joiner in the lobby, start, and assert that UI, session and server activity agree. Then focus, and assert again.

### 3. Spectator interpolation buffer (the report's step 2): agree, but tune the delay

- Valve's default is `cl_interp 0.1` at about 20 Hz, which is 2 snapshot intervals and survives one lost snapshot.
- Gaffer measured about 3x the send interval, plus 1–2 frames for jitter, to survive two consecutive losses at 2–5% loss. At 20 Hz that is about 150 ms (my extrapolation from his figures).
- WebSocket runs over TCP, so loss shows up as head-of-line stalls rather than gaps. That argues for a buffer that adapts to measured snapshot-arrival jitter (start at 100 ms, grow to about 150 ms on underruns) rather than a fixed value.

Key the buffer by server tick (`snapshot.tick`), not by arrival time. On underrun, hold the last pose rather than extrapolate. Gaffer found extrapolation poor for non-linear motion and collisions, which describes dodgeball. Agree on putting ball, holder and athletes on one timeline, which is the core Rocket League lesson.

Scope note: this only helps the covered, spectating view. With change 1 in place, that view is rarer, so it is lower priority than the report suggests. It is still worth doing for real hidden-then-return and bot-cover cases.

### 4. Drawn-motion gate (the report's step 3): agree

p95 < 34 ms between changed drawn positions, plus max hold and backward jumps, is a sensible metric. I found no industry-standard alternative. Add two more:
- interpolation-buffer underrun count
- correction distance per entity

Also add the "dead controls" assertion: after focus returns during play, a key press moves the athlete within N ms.

### 5. Remote-player reversals (the report's step 4): agree it's separate

The client predicts the whole world and carries remote players' last held input forward. That matches Rocket League: the server buffers inputs, the client predicts everything, and remote cars use the last input. Cone's slides note this is fine for the ball but poor for unpredictable cars. SnapNet describes *input decay* (fading the carried input toward neutral over a few ticks) as a cheap mitigation that reduces overshoot on reversals. Try input decay before building the remote-intent delivery in step 4. It is a few lines and needs no protocol change.

### 6. CPU items (the report's step 5): agree, low priority

Skip `structuredClone` when `snapshotSeq` is unchanged, and memoize the token write. Both are trivial. Neither affects the symptom.

### Hosting: agree, keep Pages and Render

Render delivered 80 of 80 snapshots to both clients, and the bug is client lifecycle. No reason to move.

## Recommended order

1. Change blur handling to release keys without suspending (small, removes most occurrences).
2. Single-owner suspension, the server preserving `suspended` across kickoff, and the kickoff regression test.
3. Drawn-motion profiler gate, including the dead-controls check.
4. Tick-keyed spectator buffer (100 ms, adaptive to 150 ms).
5. Remote input decay, only if two-device runs show reversal corrections.
6. Clone and storage cleanups.

## Sources

- Jared Cone, "It IS Rocket Science", GDC 2018: https://media.gdcvault.com/gdc2018/presentations/Cone_Jared_It_Is_Rocket.pdf
- Valve, Source Multiplayer Networking: https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking
- Glenn Fiedler, Snapshot Interpolation: https://gafferongames.com/post/snapshot_interpolation/
- Gabriel Gambetta, Entity Interpolation: https://www.gabrielgambetta.com/entity-interpolation.html
- SnapNet, Netcode Architectures Part 2 (input decay): https://www.snapnet.dev/blog/netcode-architectures-part-2-rollback/
- MDN, Page Visibility API: https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
- Chrome background tab policies: https://developer.chrome.com/blog/background_tabs
