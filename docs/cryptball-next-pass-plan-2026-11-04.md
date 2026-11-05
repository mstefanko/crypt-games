# Crypt Ball — Next Pass Plan (slide, arena, keeper, art)

Date: 2026-11-04 · Status: proposal, values are playtest hypotheses

Review/update: see [the reviewed implementation decisions](cryptball-next-pass-review-2026-11-04.md). This original proposal is retained as input, not as a claim that all exit gates have passed. In particular, collider bakeoff, arbitrary configuration sweeps, vendor art generation, and automated readability certification were revised; human playtest and art approval remain separate gates.
Inputs: codebase map of `apps/cryptball*` (file:line refs below), design/tech research
(`research-design.md`), art-pipeline research (`research-art.md`) — both in session scratchpad.

---

## 0. What the codebase tells us before planning

| Fact | Consequence |
|---|---|
| Sim is fixed-point integer (`FIXED=256`, heading table, integer sqrt — `rules.ts:1,28-352`); floats only in renderer | Cross-browser `Math.sin/atan2` drift is **not** a sim risk. Keep all new sim math in the table/integer style. |
| Swept circle-vs-moving-circle TOI already exists for ball↔players, ≤4 contacts/substep (`ball.ts:45-368`), and guard is already modeled as 5 small circles in front of the body (`ball.ts:105-154`) | Slide collider can be a **chain of circles along the heading** reusing the existing sweep — no new capsule solver required for v1. |
| Court numbers (147/137/73/26/80/144…) are duplicated across `court.ts`, `actions.ts`, `team-ai.ts`, `prediction.ts`, `ball.ts`, `match.ts`, `presenter.ts`, and **again** in `import-cryptball.py` (incl. its own `project()` copy) | Arena change is a refactor first. Do it once, generically, and the arena becomes a tunable. |
| "4 players" hard-coded: `checkpoint.ts:44,70`, `session.ts:62,252,267`, `match.ts:5-9`, `room.ts:23`, `model.ts:40,66-100`, `actions.ts:31` / `team-ai.ts:50` (`find` first teammate) | Roster becomes data (`teamSize`, roles), not a constant. |
| Determinism test compares Node vs 3 browsers in-run (no stored goldens) | Sim changes don't need golden regeneration, just green runs; the 4096-byte snapshot test (`online.test.ts:104`) will need a new budget for 6 players. |
| No headless tuning harness | Build one — it is the backbone of agent-driven tuning for items 1–3. |

---

## Phase 0 — Foundations (enables everything; mostly mechanical, highly agent-friendly)

1. **`CourtSpec` + `RosterSpec` as data.** One module (`sim/spec.ts`) owning half-length, half-width,
   board thickness, goal half-mouth, goal line, post radius, net depth, crease shape, player clamp,
   spawn poses, `teamSize`, role per slot. Replace every literal. Export `court-spec.json` at build time
   so `import-cryptball.py` and `presenter.ts` read it instead of duplicating `project()`/polygons.
2. **`Tuning` object** (all of `rules.ts:2-26` + new slide/keeper values) passed in match config,
   included in checkpoint/hash so overrides stay deterministic and replayable.
3. **Headless lab** `apps/cryptball/lab/` — run N seeded bot-vs-bot matches with `{court, roster, tuning}`
   overrides, emit JSON metrics: goals/min, shots, shots-on-target, save %, keeper touches/min,
   possession changes/min, time-to-first-shot, mean ball speed, % time ball in each third,
   slide attempts / successful intercepts / whiffs, rally length, idle-time-per-role.
   Precedent: headless sim + parameter sweep wrapped as a Claude Code skill (~4 min quick / ~10 min full).
4. Wrap the lab as a project skill (`/cryptball-lab sweep <param> <range>`) that writes a ranked table
   + contact sheet of heatmaps to `generated/lab/`.

**Agents:** swarm pipeline (research→analysis→writer→spec-review→review). Literal-hunting is ideal for
a writer agent; spec-review checks "zero literals remain" with a grep gate. Baseline lab metrics on the
current 2v2 build become the reference all later phases compare against.
**Exit:** all existing cryptball tests + 3-browser determinism green with zero behavior change
(lab metrics identical to pre-refactor at same seeds).

---

## Item 1 — Replace guard with slide

### Design (starting values @60 Hz)
| Property | v1 value |
|---|---|
| Input | guard button → slide; direction = move input, else facing (8-dir quantize via heading table) |
| Launch | 300 px/s, decays to ~120 px/s over slide; direction locked |
| Active slide | 18 ticks (0.30 s) |
| Recovery | 15 ticks (0.25 s), speed ×0.3, cannot strike/pass/dash |
| Reuse | 66 ticks (1.1 s); **dash and slide share a 20-tick lockout** to stop chain-cancelling |
| Collider | 3 circles r=5 along heading at −6/0/+8 px from center (≈ 30 px reach vs 14 px body) |
| Ball contact | deflect off the contacted circle normal, restitution 0.5, speed = clamp(in×0.5, 40, 160) → playable rebound, never a shot |
| Players | slide hitting an opponent's feet = existing dash-check stagger rules (reuse `actions.ts:291-327`), no fouls (Rematch precedent) |
| Keeper version | lateral dive: 4-circle chain, more reach, 14 active ticks, clamped to crease (Item 3) |
| Out of scope v1 | perfect-timing window, tackle-contest timing tiers |

### Implementation
- Contract/state: drop `guard*` fields, add `slideTicks`, `slideHeading`, `slideRecovery`, `slideReady`.
  Update `contract.ts`, `checkpoint.ts:90-104` validator, `actions.ts` priority list (slide where guard was).
- Collision: generalize the guard circle-set into a per-player **`bodyCircles(player, substepT)`**
  provider; ball sweep iterates those circles with the player's piecewise path (`ball.ts:385-445`).
  Deterministic order: player index, then circle index; earliest TOI wins, ties by that order.
  Dust trail is presentation-only.
- Player–player: slide uses swept body for checks; pushout unchanged.
- Bot AI: replace `aiGuard*` with an intercept rule: using the 45-tick forecast (`prediction.ts`), slide
  when the ball path crosses the slide envelope within 6–20 ticks and no strike is possible.
- Animation/audio: new clips `slide-launch`, `slide`, `slide-recover`; remove `guard`. Placeholder art
  until Item 4 (current `special_death` frames rotated/stretched are fine for prototype).
- Tests: replace guard tests (`multiplayer-sim.test.ts:190-270`, `animation.test.ts:5`,
  `presentation-cues.test.ts:4`); add **tunnelling tests** — max-speed (380 px/s) shot at every
  heading through a slide lane must contact; slide at court edges/posts; simultaneous slides.

### Agent approach
- **Bakeoff / competitive implementation** for the collider: writer A = circle-chain via existing sweep,
  writer B = true moving-capsule TOI (two end-cap quadratics + side linear solve, relative frame).
  Judge on: tunnelling suite, determinism, replay p95 (<4 ms target), code size. Expect A to win; B is the fallback if chain gaps show.
- Lab sweep agent: slide speed × duration × reuse grid → pick 3 candidates by (intercept %, whiff
  punish = goals conceded within 2 s of a whiff, rebound playability). Humans playtest the 3.

**Exit:** tunnelling suite green, 3-browser determinism green, lab shows slide intercept rate in a
sane band (target hypothesis 25–45%) and a measurable whiff penalty; 2+ human sessions prefer it to guard.

---

## Item 2 — Bigger arena + wider goal

### Values (starting)
| | Current | v1 |
|---|---|---|
| Court (ball walls inner) | 288 × 160 | **332 × 192** (+15% L, +20% W) |
| Goal mouth | 52 (±26, score ±23) | **60** (±30) — sweep 56–64 together with keeper reach |
| Spawn / lane waypoints / defend-lane x | literals | derived from `CourtSpec` ratios |

### Implementation
- After Phase 0 this is a spec change + AI ratio audit (lane waypoints `{-48,0,48}`, defend-lane
  x=∓108, bank mirror y=±154 in `prediction.ts:85-86` → all become spec-derived).
- **Rendering:** a 332×192 court won't fit the 384×256 view at current scale. For the gameplay
  prototype, bump the canvas to **512×320** now with placeholder (nearest-neighbour upscaled) art,
  keeping athlete pixel size — don't shrink players. This pre-commits the Item 4 canvas decision;
  640×360 stays an option the art sample (Item 4) can overturn.
- Re-run geometry tests (bank angle, post tunnelling, corner pinch, broadphase) parametrized over both specs.

### Agent approach
Lab sweep over length/width/goal (2v2 and 3v3) measuring empty-running time (seconds with no player
within 40 px of ball), goals/min, shots/min. Pick the smallest court that delivers the 3v3 passing
angles; feed results into Item 3.

**Exit:** both specs pass geometry + determinism; lab shows idle-running doesn't rise >15% vs baseline.

---

## Item 3 — Two field players + goalkeeper (3v3)

### Design
- Roster 3/team: slots `[F, F, K]`. Keepers are **bots by default**; private rooms can toggle human keepers.
- **Crease:** rounded rect ~44 px deep × (goal mouth + 2×24) wide, drawn on the floor with a glow edge
  when the keeper presses into it. Enforced in movement (`clampActor` per role) for walk, dive,
  knockback and dash-check shove — no teleport, no penalty. Field players may enter (keep v1 simple; revisit if crowding).
- **Keeper kit:** shuffle (lateral speed ×1.1, forward ×0.8), lateral dive (Item 1 variant), strike/pass
  normally (instant distribution — saves start counters). No catch/hold in v1.
- **Assisted dive** (Rematch S5 lesson: too-weak keeper is miserable, too-strong kills scoring): on dive
  input, sample the forecast and bias dive heading up to ±20° toward the ball path. Tunable assist strength.
- **Bot keeper:** stand on the ball→goal-center line, advance with ball proximity (narrowing angle — the
  behavior that beat EA FC's passive keeper in the arXiv study), dive when forecast crosses the mouth within reach-time;
  distribution = utility score over teammates (openness, forwardness, lane clear).
- **Directional pass target** (fixes `actions.ts:31`, `team-ai.ts:50`): score teammates by angle to
  aim/move input (cone ±60°), distance, lane clearance; fallback nearest. Same function for bots.
- **Switching:** `canSwitch` over field players only; never auto-switch a human into keeper.

### Implementation
1. `RosterSpec` 3/team; `team = slot < teamSize ? 0 : 1`; validator reads spec (`checkpoint.ts:44,70,80`);
   add `aiRole: 'keeper'`.
2. Keeper movement constraints + dive + assist in sim; AI keeper module `sim/keeper-ai.ts`.
3. Server: `maxClients` from spec (6), seat order interleaved `[0,3,1,4,2,5]` with keeper slots
   bot-locked unless room option; auto-start at 4 humans when keepers are bots; snapshot budget re-set
   (measure 6-player checkpoint, cap ≤ 6 KB, keep 16 KB hard limit); bot-takeover and reconnect paths per role.
4. Tests: "fills 3v3", keeper crease under knockback/dive, pass-target directionality table test,
   determinism scripted match with 6 participants (incl. 2 bot keepers), online reconnect for keeper seat.

### Agent approach
- Split into parallel swarm phases in separate worktrees (branch off the Phase-0 branch, not main):
  (a) roster/checkpoint/server seats, (b) keeper sim + AI, (c) directional passing. (a) merges first.
- Lab is the arbiter: keeper idle-time (target: touches ≥ 1.5/min), save % (hypothesis 45–65%),
  goals/min within ±25% of 2v2 baseline, % goals that are rebounds/bank shots. Agent sweeps
  `assistStrength × diveReach × goalMouth`.
- Human gate: 4 humans + 2 bot keepers, then one private session with a human keeper — the real
  question is "is keeping fun", which the lab cannot answer.

**Exit:** 3v3 with bot keepers green on all suites; playtest verdict before making human keepers a
matchmaking role.

---

## Item 4 — Art pass

### Decisions to make first (human)
- **Canvas:** 512×320 (default, matches Item 2) vs 640×360 — decide from the sample scene.
- **Source art:** current "Lords of Pain" pack license is UNVERIFIED (`import-cryptball.py:202`) —
  resolve before shipping anything derived from it; new athletes should replace it.
- **Headings:** current clips need 16 headings × 8 actions. AI tools reliably do 4/8 directions.
  Recommend **8 authored headings**, render at 16 by nearest-of-8 (court rotation is only −π/8);
  verify readability in the sample.
- **Style bible:** locked 24–32 color palette, light from torches (warm) vs cool floor, 1px dark
  outline, 2–3 team-color zones on a shared base body, keeper = same base + gloves/helmet silhouette.

### Pipeline
1. **Pose-guided generation, not text-only.** Sports poses (planted strike, slide, dive) are where pure
   generation fails. Pose key frames via PixelLab skeleton animation (`animate_with_skeleton` / per-frame
   skeleton beta) or a Blender/Mixamo-style rig rendered to low-res as reference → generate → hand-fix key frames in Aseprite.
2. **PixelLab (official MCP + REST v2)** for athletes and animations; **Retro Diffusion** for
   palette-constrained tiles/textures/VFX. Agents drive both from Claude Code.
3. **Aseprite CLI (`aseprite -b` + small Lua)** from the Python build for trim/pad, palette enforcement,
   atlas export — avoid community Aseprite MCPs (arbitrary Lua execution).
4. Team variants via **palette-index swap** of one base athlete (consistency > regeneration).
5. Court: tileset (stone edges with thickness, recessed goals, nets, worn lanes) + painted light layers,
   geometry read from `court-spec.json`. Atlas manifest v2 contract unchanged so `presenter.ts` only
   gains new clip ids (`slide*`, `keeper-shuffle`, `keeper-dive`, `sprint`).
6. Contact FX: impact flash (2 frames), ball squash, scrape dust, net ripple, distinct save SFX
   (ElevenLabs SFX API, paid plan for commercial use). Keep FX ≤ 6 frames so the ball stays readable.

### Automated QA gates (agent-run, build-failing)
Frame size + foot baseline consistent within 1 px; palette ⊆ locked palette; alpha ∈ {0,255};
silhouette test at 1× (alpha-mask IoU between headings / distinctness between actions);
team-color contrast vs floor (ΔE threshold); loop closure; tile seam test; SFX peak/length/silence;
auto contact sheet at 1× and 3× posted for review; provenance log (tool, prompt, seed, edits) per asset.

### Agent approach
- **Quality bar first:** one athlete (8 headings × idle/sprint/strike/slide) + one finished court scene
  at real play size. Human approves at 1× and 3× before any bulk work.
- Then fan-out: agents per action set generate → QA gates → contact sheet; human picks/edits key frames.
- Steam/storefront: disclose player-facing AI art/audio; heavy hand-editing strengthens copyright position.

**Exit:** sample approved; full clip set passes QA gates; `presenter.ts` init no longer throws on
missing clips; side-by-side screenshot vs current build.

---

## Sequencing

```
Phase 0 foundations ──► Item 1 slide (existing court) ──► Item 2 arena ──► Item 3 3v3 bot keepers ──► 6 human slots
          └──────────► Item 4 style bible + art sample (parallel, human-led) ──► bulk art after slide/keeper poses settle
```
Art bulk production waits until slide/dive timings are frozen (frame counts depend on them).

## Risks
- Circle-chain collider leaves gaps at extreme angles → bakeoff capsule fallback.
- Keeper boredom / overpower → assist strength + bot default + lab idle-time metric.
- Bigger court = more empty running → lab-measured, start small.
- AI art fails on dynamic poses → pose-guided + hand-fix budget; keep the art sample honest.
- Snapshot growth at 6 players → measure, consider delta snapshots only if >6 KB.
