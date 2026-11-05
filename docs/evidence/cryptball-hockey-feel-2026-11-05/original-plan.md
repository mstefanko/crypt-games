# Hockey possession, pursuit, and contact plan

Date: 2026-11-05. Scope: investigate and plan; no production behavior or art changed.

## Recommendation

Make this a possession-led arcade hockey game: collect → carry/stickhandle → pass or shoot; defenders choose a precise poke or a committed body check; carriers evade with a separate dash. A check visibly knocks the victim down. A dive is a risky puck/lane block, not another body attack. Fix acquisition, stable carrying and pursuit before tuning aggression or producing final animation sheets.

Keep the existing deterministic simulation, swept puck contacts, skating and rendering pipeline. Do not solve this by increasing pickup radius, increasing all bot aggression, or making players intangible. Those approaches mask the coordination and ownership defects while making collisions less readable.

## Investigation and evidence

Inspected the current working tree at base commit `6b1136dd1f3f0e59a6ccb20beee7f2a2eb84efa7`; the app is untracked and the repository already has substantial unrelated work. Results describe the current files, not that commit alone. Inspected the eight-direction runtime art contact sheet. Ran hockey simulation/review tests and a disposable-location diagnostic: 3 files, 28 tests passed (27 existing tests plus one research harness). No browser or human playtest was performed for this investigation.

Evidence and reproducible harness: `docs/evidence/cryptball-hockey-feel-2026-11-05/`. Run from repository root:

```
./node_modules/.bin/vitest run --config docs/evidence/cryptball-hockey-feel-2026-11-05/vitest.config.ts
```

Three 3,600-tick scenarios, seed 42, existing default teams and specials enabled:

| Scenario | Owned/live ticks | Mean completed ownership span | Maximum ownership span | Findings |
|---|---:|---:|---:|---|
| All bots, normal faceoff | 208/3457 (6.0%) | 1.27 ticks | 33 ticks | 164 acquisitions/losses; 160 losses called unreachable; 89 clashes; only 2 shot contacts and 1 pass |
| All bots, puck shifted 7 units sideways | 230/3457 (6.7%) | 2.28 ticks | 34 ticks | 95/101 losses unreachable; 149 clashes; 3 shot contacts and 1 pass |
| Idle local human, other players bots | 670/3556 (18.8%) | 10.98 ticks | 110 ticks | Puck coordinates unchanged in samples from ticks 1800 through 3600; no shots or passes |

These are diagnosis examples, not statistically representative balance results. Tick duration is 1/60 second. The broad `unreachable` reason combines several checks; do not claim these counts identify which predicate failed. The cluster metric in the JSON means at least three players within 30 world units of the puck; it does not measure every obstructed two-player duel.

### Confirmed mechanisms

1. **Equal acquisition can repeatedly do nothing.** `sim/modes/cryptcheck/control.ts:83–96` denies ownership to equal opposing candidates and sets a global 12-tick pickup delay. It does not move the puck or make the contenders change approach. Both bots stop at blade distance. In the normal faceoff, the puck is still at center at tick 600, with interceptors symmetrically at ±16.605 units. Specials can eventually disturb this; it is not a successful faceoff policy.
2. **Receiving and carrying use brittle eligibility.** `control.ts:26–64` excludes actions, charge, dash, poke/recovery and stagger; retention checks distance, relative speed and two lanes. `actions.ts:119–132` releases possession at action admission, before blade contact. Every release globally prevents everyone acquiring for 12 ticks. Passing and charging intentionally drop control, and dash drops it even when used to escape. The AI changes from aiming at the puck to aiming at the goal immediately upon ownership; this can redirect the blade target through its own solid body. This is a strong causal candidate for the short ownership spans; instrument individual predicates to distinguish it from obstruction and speed loss.
3. **Pursuit is distance-based and has no escape policy.** `ai.ts:22–29` chooses the nearest teammate each tick, including a human who may be idle or skating away. The other bot waits in defense even when that teammate cannot collect. There is no role commitment, obstacle avoidance, progress timeout or alternate approach around an obstructing body. The physics solver separates overlapping players; it cannot invent a path around them (`sim/motion.ts:157–181`). Nearest-player changes can also switch roles repeatedly.
4. **Bots do not know how to resolve a slow loose-puck battle.** `ai.ts:116–125` pokes only an owned opposing puck and strikes a loose puck only when it is faster than the receive threshold in the permitted field area. On a stationary contested puck they can simply remain at the same intercept. A stale intended pass can reserve pursuit until its 90-tick expiry. Reach prediction uses cruise speed, not the full current acceleration/turn and obstruction cost.
5. **Hacking is partly input semantics, partly AI decisions.** `src/host.ts:914–915` sends poke from held right mouse/Shift/I; shared action admission repeats it when ready. Bot poke requests remain true whenever the existing range/owner condition holds. The AI has no tactical wait/reposition after a failed poke. It writes `aiNext` after shots, but only the pass condition reads that cooldown. The existing diagnostic establishes frequent poke attempts; it does not prove every observed visual hack was an actual puck hit.
6. **Dash and check are currently the same action.** `actions.ts:349–395` checks bodies during dash or Rams rush. Ordinary checks apply only 10 ticks of stagger and 36 ticks of immunity, not a downed state. This prevents dash from having a clean evasion identity. Hockey AI does not emit ordinary dash/check commands; specials can still produce checks.
7. **The animation gaps are real.** `src/animation.ts:133–174` never selects `stickhandle`, although the importer defines it as ready/receive/ready. Moving skaters settle on a static glide pose. Recoil uses the standing recover frame with no animated phase progression. Shoulder art is primarily selected after a successful check event rather than across a readable pre-contact check. The existing 16 poses per direction include a shoulder pose, but no hockey fall, prone slide, get-up, or dive sequence. The current art sheet confirms those omissions.

## Gameplay decisions

### Possession and stickhandling

Maintain one canonical owner with explicit receive/carry/action-preparation semantics. Preserve ownership through normal turns, braking and the evasive dash. Keep the physical puck at a bounded blade pocket, never teleporting through players or boards. Rotate the carry pocket with a capped turn rate and a feasible path around the player's body; avoid sweeping it straight through the torso on 180-degree aim changes. Aim can remain responsive while blade/puck preparation catches up; a shot must wait for reachable contact.

Use a short receive settle followed by stable carry, with separate retention tolerance from initial acquisition. Retain the puck during pass/wrist-shot preparation and release at the active contact. Slapshot preparation exposes a wider, visibly stealable pocket rather than silently disowning the puck at charge start. Allow whiffs when contact is genuinely lost. Shot contact must still use the authoritative swept geometry.

Replace the global acquisition embargo with per-releaser self-recapture limits; an opponent or receiving teammate must remain eligible immediately. On equal claims, resolve a single deterministic contested contact with a small physical deflection and a short contest receipt, then require reapproach. Use symmetric fixtures and mirrored outcomes to prevent permanent low-ID/team advantage. A contest may remain neutral briefly, but cannot replay forever without spatial progress.

Do not give passive body brushing automatic ownership. A body can block a loose puck or obstruct a carry path; a successful intentional poke/check should be the ordinary way to force a turnover. Severe geometric loss can still release control, with a visible reason.

### Poke, check, dash and dive

Initial tuning below is a prototype starting point, not approved balance:

| Action | Role and commitment | Puck result |
|---|---|---|
| Poke | Short blade reach; ~4-tick tell, 3 active, 14 recovery. One attempt per press; AI explicitly schedules attempts. Miss leaves a brief opening. | Dislodges into reachable space; no automatic possession and no knockdown. |
| Check | Directional shoulder lunge; ~7-tick tell, 8 active, 20 recovery. Lock direction at commitment; one victim/contact receipt. Requires actual approach/contact, not any nearby body. | Successful hit releases puck and starts victim fall → slide/down → get-up. |
| Dash | Short directional cut, separate cooldown; cannot check, phase through bodies, or fire during committed burst. | Existing possession retained through bounded control. Avoid checks by displacement, not universal invulnerability. |
| Dive | Committed low reach/shot-lane block; ~5-tick launch, 18 slide, 24 recovery. Cannot cancel into check/dash. No body knockdown. | Deflects a loose/in-flight puck; cannot auto-catch or steal an owned puck through the carrier. |

A normal successful check should visibly knock the victim over: start with ~6 ticks falling, ~16 sliding/down, ~18 getting up. Disable pickup and actions while down; preserve collision occupancy without making prone players impassable walls. Grant protection through getting up plus a brief grace period; prevent stun chains. Distinguish solid check contact from passive bumping. Check/dive travel must terminate safely at boards. Audit Rams, Foxes, Bats and Gators against these new semantics rather than accidentally inheriting the old dash/check coupling.

### Proposed controls

Keep existing move/aim, shoot, pass, switch and special bindings. Use explicit actions independent of possession, so a turnover never changes what a pressed button means.

| Intent | Keyboard/mouse proposal |
|---|---|
| Move / aim | WASD/arrows / pointer or existing keyboard facing |
| Shoot / pass | J or left mouse hold/release / K or middle mouse |
| Poke | I, Shift or right mouse, on press rather than hold-repeat |
| Dash | Space or L |
| Check | E |
| Dive | C |
| Switch / special | Q / B |

Provide remapping/help and a keyboard path for trackpads. Extend command validation, protocol and prediction for separate check/dive commands; do not overload `slide` with several actions inferred from possession.

Touch currently uses a two-thumb recognizer with flick mapped to `slide` and help saying “dive,” even in hockey where it means poke. For hockey, retain movement, tap-pass, hold-release-shoot and movement re-touch dash; label action flick as poke. Add explicit Check and Dive thumb targets (minimum 44px) beside the existing special control, with one pointer owner per action. This intentionally revisits the prior single-button touch design: four distinct defensive/evasion intents are too ambiguous to hide in the same flick or possession-dependent gesture. Validate on an actual phone before locking layout; touch accessibility remains a ship requirement.

## AI work

Assign one active collector/forechecker per team with a brief commitment window; support maintains an open lateral pass lane, defense holds goal-side space. Score collector choice using feasible arrival time, current velocity, facing, action availability and progress, not distance alone. An idle/blocked human must not indefinitely reserve the collector role. Respect deliberate human pursuit without steering their character.

Add local separation/avoidance before physics, legal board-adjacent approach points, and progress detection. After roughly 30 ticks without closing on a reachable puck, choose an alternate side or hand off collection; never teleport or inject random speed. Include pass-target validity and timeout in this policy. Resolve symmetrical faceoffs through the contest mechanics and deliberate lateral approach.

Defenders predict the carrier's exposed pocket: poke when the blade window is reachable, check when approach angle and committed travel can connect, otherwise contain/reposition. After a whiff, reassess rather than repeat at cooldown. Carriers select escape direction, maintain puck control, and pass into an available receiver lane. Shots and passes both honor decision cooldowns and contact preparation. Keep all persistent intentions, cooldowns and progress counters checkpointed.

## Art and presentation work

Prototype timings with existing key poses first. Then author matching eight-direction sequences in the existing style and six palette masks:

- Stickhandle: 4–6 clearly different forehand/center/backhand transitions with hands, shaft and blade moving. Support stationary handling and skating with the puck.
- Check attacker: 5–6 poses covering shoulder load, drive, contact/follow-through and recovery. The shoulder tell must appear even on a miss.
- Check victim: 7–9 poses covering hit reaction, loss of balance, fall, ice slide, down hold, kneel/push-up and return to skates. Preserve stick continuity; do not substitute a standing recovery pose.
- Dive: 6–8 poses for launch, extended stick/body, low slide, brake and rise. Share compatible prone/get-up art only after visual review.
- Dash: 3–4 distinct cut/push poses; reuse existing push art where it reads well. Keep its silhouette distinct from the lowered shoulder check.

Maintain the current 112×80 frames and foot pivot (56,70) where possible; flag dive/fall extents before clipping. Record per-frame blade, hand and ground anchors rather than one generic blade anchor per direction. Separate simulation carry phase/offset from renderer frame choice: the rendered puck uses its actual world position, and the stick pose must meet it. Use a small deterministic stickhandling pocket motion if the puck needs to visibly travel side-to-side; do not render a fake puck displaced from its collision location. Validate rollback and reduced motion behavior.

Review at 1× and 3×, all eight facings, all six palettes, boards, foreground occlusion and overlapping skaters. Impact ice spray, body thud and puck tick distinguish successful check, poke and miss without hiding the puck. New sheets are required; they were not generated in this planning task.

## Ordered execution and acceptance

1. **Instrument and capture failing cases.** Split unreachable reasons into distance, relative speed, body-path and blade-path; record ownership spans, role changes, action attempts/hits, stall duration and contact density. Save exact checkpoints for symmetric faceoff, idle-human obstruction, corner duel and turning carrier. Convert the current symptom reproductions into desired-behavior regression tests.
2. **Stable acquisition/carry slice.** Implement contested acquisition, per-player recapture and body-safe pocket turns. Keep receive/action preparation coherent. Exit: unpressured carrier can skate, stop, turn and dash for five seconds without incidental loss; pass recipient can collect immediately; no through-body/board pickup; symmetric faceoff escapes a static contest within one second without a special.
3. **Pursuit and spacing slice.** Implement stable roles, feasible intercepts, avoidance and progress escape. Exit: idle human cannot freeze bots; reachable loose-puck fixtures progress within one second; corner/board cases escape without physics energy injection or phasing. Compare both mirrored teams across at least ten seeds; keep the new diagnostics visible during tuning.
4. **Distinct actions and knockdown slice.** Add explicit check/dive commands and state timelines; edge-trigger poke; remove checking from ordinary dash. Add fall/get-up eligibility and hit receipts. Exit: poke only dislodges; check knocks down once; dash can evade by movement while carrying; dive blocks without body attack; misses recover and held inputs cannot spam; no stun chains.
5. **Presentation and controls slice.** Author/import the sheets after mechanics are playable. Hook state-driven tells/contact/recovery and actual stickhandling. Integrate desktop and touch help, cancellation, pointer ownership, remapping and accessible targets. Exit: eight-direction action and victim proofs, clear whiffs, visible puck-stick agreement, touch play without gesture conflicts.
6. **Authority/regression and human tuning.** Update `contract.ts`, checkpoint validators, session allowed keys, protocol/server validators, observation/prediction, build identity and network tests. Current checkpoint test expects version 10; protocol is 8—bump from the actual current values when implementing. Add restore/reconnect tests midway through carry-turn, check, knockdown, dive and cooldown. Run focused hockey tests, full Cryptball regression, network/browser/determinism suites and client/server builds. If shared solver changes are necessary, follow engine protection requirements and run the required engine tests. Keep other sports' behavior unchanged.

Final feel gate: human solo and two-player sessions can intentionally carry, escape, poke, check, recover and pass. A controlled possession should last until a readable decision/contact—not routinely one or two simulation ticks. Use comparative metrics to catch regression, but do not ship on bot scorelines alone. No public deployment is part of this plan.
