# Cryptball next-pass implementation

2026-11-04. Local candidate, not a human-validated balance or production-art signoff. Implemented with three GPT-6.1 Sol agents, coordinated integration and review. The existing dirty/untracked candidate was preserved; no unrelated files were reset and no commit or deployment was made.

## Implemented

- Versioned court/roster definitions, 332×192 arena, 60-unit goal mouth, six stable F/F/K actors, checkpoint v3 and validated per-match slide launch/end-speed overrides.
- Committed circle-chain slides, lateral keeper dives, shared dash lockout, recovery restrictions, swept opponent checks and energy-limited defensive rebounds. Replaced shield presentation and controls; the old guard command remains only as a compatibility alias.
- Bot keepers with proactive positioning, predictable pass distribution and crease constraints. Keeper intent is checkpointed; replanning occurs every three ticks or on a new touch, with movement steering each tick. Human dives are unassisted.
- Directional teammate selection, field-only switching, four-human public rooms with bot keepers, optional six-human private rooms, stable seats, bot takeover and role-preserving reconnect. Fifth/sixth arrivals in six-seat private rooms are the keepers.
- 512×320 presentation, eight authored visual facings independent of fine simulation headings, armored athletes, team palette swaps, slide/dive/recovery poses, feedback and role-aware lobby controls. Original reproducible art replaces the purchased-pack pixel dependency.
- Seeded headless lab, archived original 2v2 simulation, paired speed sweeps, raw metrics, occupancy heatmaps and per-attempt slide/whiff tracking.

The user approved the generated chunky armored fantasy **style direction**. The generated concept is explicitly marked as not gameplay. The playable artwork follows that direction but remains a prototype; the reference is not evidence that identical production artwork was built.

## Review corrections applied

The overlapping circle chain needs stable contact behavior, not a speculative second solver. Defensive contacts must not accelerate slow balls. Keeper collision paths must obey the same bounds as the displayed body. Bot launch direction must actually point at the predicted interception. Ordinary checks must not impose slide recovery on athletes that were not sliding. Visual facing must be quantized once, and ground reach should match the defensive collider.

The original proposal's numerical targets remain hypotheses. Source verification and rationale are in [the review](cryptball-next-pass-review-2026-11-04.md), including primary links for Rematch, ECMAScript, PixelLab, Retro Diffusion and Aseprite.

## Validation evidence

- Unit tests: 48 passed across seven files, including all-256-heading interception, movement/crease trajectories, simultaneous contacts, no added energy, AI launch direction, recovery, directional passes and checkpointed planning/config replay.
- Network: 17 passed, one opt-in long real-time socket test skipped. Includes complete 2/3/4/6-human authority matches, snapshot round trips under the 6 KiB target, real socket admission and keeper reconnect.
- Cross-browser determinism: 12,979 matching checkpoint hashes per engine against Node: 7,320 ticks with four humans/two bot keepers and 5,659 ticks with six humans including keeper takeover/rejoin. All three browser tests passed.
- Final 12-tick replay p95 on this Apple M4 run: Chromium 4.3 ms, WebKit 5 ms, Firefox 5 ms. All below the unchanged 16.67 ms frame-budget check; the aspirational 4 ms target is **not** consistently met. Node measurements ranged 2.53–6.61 ms. These are workload/hardware-specific samples, not a universal guarantee.
- TypeScript passed. Simulation purity and game-boundary checks passed with the repository's existing unrelated purity baseline retained.
- Asset build validates 3,360 prototype athlete frames for dimensions, anchors, palette and binary alpha. These checks cannot establish visual readability or animation quality.

Browser integration: solo keyboard/pause passed; two-browser Start with bots/menu/reload passed; four-human public auto-start/fifth-player waiting passed. The private keeper flow passed with two rendered browsers plus four real socket peers (28 seconds): six ready seats, auto-start, keeper label and keeper reload. A six-renderer attempt stalled during the fifth client's atlas loading before matchmaking; this remains a rendering-validation limit, not a passing six-browser result.

The default client and server were rebuilt together as `cryptball-v1-988166aa89cb357009c5fca5`. The old local server was gracefully replaced on port 2567. The existing preview at http://127.0.0.1:4224/games/cryptball/ was verified through its UI joining the new server. Actual gameplay screenshot: `docs/evidence/cryptball-next-pass-2026-11-04/production-court.png`; private keeper lobby/rejoin screenshots: `docs/evidence/cryptball-online-2026-11-04/`.

## Balance evidence and remaining scope

The final smoke sweep uses three paired seeds with 3,600 ticks each. Default slide speed 300: 9.36 goals/minute versus old 2v2's 16.98; empty-running proxy 15.57% versus 32.20%; 114/311 completed slide attempts intercepted (36.66%). There were 23 concessions within two seconds among 196 fully observed whiff windows. This is association, not proof a whiff caused a goal. The baseline changes roster, court and defense together, so it cannot isolate one feature.

Scoring misses the original ±25% baseline hypothesis even though interception falls inside the proposed band. Keep these results as playtest prompts, not automated acceptance or a reason to maximize goals. See `generated/lab/summary.md`, JSON and SVG, plus `apps/cryptball/lab/README.md` for reproduction and metric definitions.

Explicit limitations:

- Save percentage and shots-on-target are unmeasured (`null`), not inferred from touches. Keeper touch-change counts are proxies.
- Court geometry is a fixed versioned preset. The lab supports slide-speed overrides, not arbitrary court/roster/timing/assist grids. No collider bakeoff or project skill wrapper was needed.
- Keeper restriction applies to feet/standing-body anchor; outstretched gloves may reach beyond the crease. No human dive assist or catches/holds are included.
- Old v2 checkpoints are rejected, not migrated. Existing rooms need a matching client/server build.
- Six simultaneous software-rendered browser clients stalled during atlas loading on this test machine. Six-seat authority/socket correctness does not establish six-browser rendering performance.
- Human preference for slide versus shield, keeping fun, final scoring balance and art/animation acceptance require human playtesting. No simulated human verdict is claimed.
- PixelLab/Retro Diffusion generation and Aseprite export were researched but not used: those integrations were unavailable here. The playable atlas is original code-authored art; the separate reference was made with the built-in image-generation tool.
