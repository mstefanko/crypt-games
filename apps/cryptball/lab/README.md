# Cryptball headless lab

Run from the repository root (Node and existing workspace dependencies):

```sh
node apps/cryptball/lab/run.mjs --ticks 3600 --seeds 1,2,3
node apps/cryptball/lab/run.mjs --slide-speeds 240,300,360 --ticks 3600 --seeds 1,2,3 --out generated/lab/slide-speed-sweep.json
node apps/cryptball/lab/run.mjs --sim apps/cryptball/lab/baseline-2v2.mjs --label baseline-2v2 --ticks 3600 --seeds 1,2,3 --half-length 144 --half-width 80 --out generated/lab/baseline-2v2.json
```

The current primary game is 2v2 with four field players and no goalkeeper seats. The baseline is an esbuild bundle captured from the original four-player sim before this pass changed it. Its SHA-256 is recorded in the report. It is an evidence fixture, not a production entry point. Current runs bundle the source at execution and record that bundle's hash. The CLI supports only the checkpointed slide launch speed tuning currently supported by the sim; it does not claim arbitrary court, keeper assist, or dive reach sweeps.

Each candidate receives identical seeds and tick budgets. JSON includes raw per-match counts, play ticks, roster, config, a 12×8 ball occupancy heatmap, and diagnostic rates. Sweep SVGs place aggregated occupancy panels together. The ranked table sorts goals per minute solely to make comparisons reviewable: more goals is not an automated quality verdict. Three seeds and sixty seconds of wall-clock match ticks per seed are a smoke experiment, not balance evidence or a human playtest.

Metric definitions:

- Rates divide by actual **play** ticks / 3600, excluding ready and goal pauses. Runs stop at results or the requested tick budget.
- Shots count emitted strike-contact events; first-shot latency includes the initial ready time.
- Ball speed is the mean sampled velocity magnitude during play. Thirds use the explicit half-length option; heatmap uses half-length and half-width.
- Empty running counts play ticks with no player within 40 pixels of the ball; it is a diagnostic, not a pass gate.
- Touches count changes of `lastTouch`; same-player repeated touches are missed. Possession changes count changes in the team of those touches. Keeper-related fields remain in the report schema for archived comparisons; current 2v2 rosters have no keepers.
- Idle is speed below 1 pixel/second during play, recorded per player (with roster roles). Completed rally length is play time between goals; unfinished rallies are excluded.
- Field slide attempts are tracked per player from `slide` until active slide ends or phase resets. The first `slide-contact` marks one intercepted attempt; repeated contacts stay separate raw contacts. An attempt with no contact at completion is a whiff. An active attempt at truncation is pending and excluded from the completion denominator.
- Whiff penalty counts completed whiffs whose team concedes within 120 subsequent simulation ticks (2 seconds, including pauses). Only full 120-tick observation windows enter the penalty denominator; truncated windows are censored. This is temporal association, not proof that the whiff caused the goal. Keeper dive/save events are separate and are not counted as field slide attempts.
- Shots on target and save percentage remain `null` because the current event stream does not support honest attribution. Rebound-goal rates are not implemented.

Human preference and playtest approval require actual human sessions. No lab result supplies those verdicts.
