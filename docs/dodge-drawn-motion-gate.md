# Dodge drawn-motion gate

Run from the repository root with Playwright Chromium installed:

```sh
npm run build:cryptball:server
node scripts/cryptball-dodge-motion-gate.mjs .local-game-tests/dodge-motion-gate.json
```

The script starts its own authoritative server, ordered TCP delay proxy, Vite frontend and two rendered Chromium pages. `MOTION_RTT=80` selects added round-trip delay in milliseconds (the default). Ports 2589 and 4249 must be available. Watch and HMR are disabled during each trial.

It blurs the joiner before kickoff, returns focus and uses real keyboard events to require a newly allocated command and at least two screen pixels of movement in the drawn controlled athlete within 1500 ms. Eight labelled crossings reverse both clients' movement. A deterministic hidden/visible event pair then opens computer cover; the joiner must allocate zero inputs while the host crosses in both directions, its covered playout cursor must advance, and its drawn remote positions must continue changing. Return to play repeats the keyboard check.

The gate requires p95 time between changed drawn positions below 34 ms for each client's controlled and remote athlete, and for the covered joiner's remote athlete. Minimum sample counts prevent empty or stationary trials from passing. The JSON includes actual render-submission poses, labelled intervals, longest controlled holds, per-athlete reversals and distances, per-entity correction distances in pixels, network counters, and interpolation underruns. Failures produce a nonzero exit status and remain in the report.

The Vite-only observer samples integer court-pixel positions from each presenter shadow immediately after `stage.render(0)` and retains fixed-coordinate world poses separately; it does not replace input or simulation stepping and does not ship in production. This measures render submission rather than display scanout. Injected visibility events make lifecycle coverage deterministic but do not emulate compositor occlusion or OS background scheduling; actual side-by-side windows and separate devices still need manual validation. Reversals and longest holds are reported for investigation rather than assigned universal failure thresholds.

## Recorded verification

The local protocol 16 trial at 80 ms added RTT used each athlete’s rounded on-court shadow position after render submission. Values below are milliseconds between changes of at least one court pixel. Each active client supplied 209 controlled-player intervals.

| View | Controlled p95 | Remote p95 |
| --- | ---: | ---: |
| Host, active | 17.9 | 17.9 |
| Joiner, active | 18.1 | 18.1 |
| Joiner, covered | — | 33.3 |

The covered joiner recorded 137 changed-position intervals, zero buffer underruns and zero newly allocated commands. Its longest measured interval was 249.5 ms at the start of the first covered crossing, when the host athlete began at rest. The playhead advanced about 15 ticks during that interval. This gate includes time from the start of a labelled crossing to its first movement, so that interval includes movement onset. The joiner's keyboard movement checks completed within 194 ms after refocus and 162 ms after explicit return. These figures include browser test polling and the time required to travel more than two pixels.

The correction probe measured a remote player correction up to 41.6 world pixels during this trial. Use two separately focused devices and isolate reversals before deciding whether to change prediction. Save both device exports with diagnostics enabled. Compare the same remote athlete’s correction distribution and steady straight-line movement, since fading its last known direction can also introduce errors while it continues moving straight.

The client and authority require protocol 16 because they now agree to preserve suspension through kickoff. Publish matching builds of the client on Pages and the server on Render for the rollout.
