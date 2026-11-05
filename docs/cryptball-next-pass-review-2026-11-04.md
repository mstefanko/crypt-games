# Cryptball next-pass review and implementation decisions

Reviewed 2026-11-04. The original next-pass plan remains a proposal; this document records corrections and the implementation direction. Completion and playtest results must be reported separately.

## Verdict

Proceed with a deterministic circle-chain slide, a modestly larger arena, two field players plus a keeper per team, four-human matchmaking with bot keepers, and optional six-human private rooms. Build a reviewable original art sample at 512×320. These are testable design choices, not proven improvements in fun.

## Plan corrections

| Area | Decision and reason |
|---|---|
| Determinism | Retain fixed-point state, authored headings, quantization, stable contact ordering, complete checkpoints and cross-browser replays. The existing implementation reduces risk; it does not eliminate risk from new state, arithmetic bounds, collision ordering or config divergence. “Floats only in renderer” overstates the code: Number division/normalized vectors also occur in simulation. |
| Collision | Use overlapping circles and the existing swept moving-circle path. The proposed radius-5 circles at offsets −6/0/+8 span **24** world units, not 30. Adjacent circles overlap; scalloped surfaces and repeated contacts are the concern, not literal gaps. Add grazing, low-speed, simultaneous-contact, wall/post and moving-body tests. Implement a capsule only if these tests show a concrete need. |
| Slide rebound | Remove the minimum speed of 40: it adds energy to slow balls. Cap outgoing speed by incoming speed and the configured maximum. Avoid repeated damping once per overlapping circle for one contact. Separate body interception from offensive striking. |
| Slide recovery | Block strike/pass/dash during recovery and prevent dash cancellation of the active slide. Shared reuse lockout alone is insufficient. Explicit launch/active/recovery state belongs in checkpoints. |
| Direction | Eight visual directions do not require eight-direction physics. Keep the fine heading table; visual quantization is independent. Keeper assistance, if enabled, selects a bounded launch direction once, never homes during a dive. |
| Foundations | Centralize semantic geometry and roster values; do not use a “zero numeric literals” gate. Animation offsets, tolerances and unrelated constants are legitimate. Avoid an unrestricted configuration framework; serialize supported validated tuning and version the rules. |
| Lab | Record definitions, raw counts, fixed seeds and sample sizes. Save rate needs a shots-on-target denominator; keeper touches are not saves. Empty running and interception rates are diagnostic proxies, not pass/fail definitions of fun. Use paired seed comparisons and preserve the old build baseline. |
| Arena | 332×192 and a 60-unit mouth are starting settings. 512×320 provides room without shrinking athletes. Geometry, input projection, overlays and art must share dimensions. Larger canvas alone does not improve art. |
| Keeper | Default bot keepers; optional human keeper slots in private rooms. Enforce the feet/standing-body crease constraint through motion and collision response; outstretched diving gloves may reach beyond it. Test shoves, corners, swept paths and recovery. Passing/switching must handle the extra teammate and exclude involuntary keeper switching. |
| Network | Keep stable player/role assignment through waiting departures, disconnect, bot takeover and reconnect. Four ready humans start normal rooms; six are possible only with the private keeper option. Version protocol/build identity and reject incompatible checkpoints. Measure snapshot size rather than choosing compression prematurely. |
| Art direction | Use eight authored headings, team palette swaps and distinct keeper silhouette. Preserve finer aim physics. Replace the unverified imported athlete dependency for the sample; no inference that the old pack is unlawful. 512×320 is the implementation default, 640×360 is a later sample-driven alternative. |
| Art tooling | PixelLab/Retro Diffusion are viable vendor options, not demonstrated best-in-class sports animation pipelines. Neither is exposed by the current tools; plugin discovery returned no matching integration. Use original code-authored sample assets and reproducible exports here. Aseprite is optional, not a prerequisite for PNG/JSON atlases. |
| Art QA | Hard checks can validate dimensions, anchors, palette, alpha, references and seams on tiles intended to repeat. Alpha-mask overlap or color distance cannot certify readability. Non-looping strike/slide/dive clips must not be required to close as loops; airborne feet should not be forced to a constant baseline. Human review remains necessary. |
| Animation timing | Frame count need not equal simulation ticks. Map authored phases to launch/contact/recovery. Tune timing without regenerating every frame. Bulk art still waits for sample approval, not because timing values must be frozen. |
| Work organization | The existing game is largely untracked in a dirty checkout. Fresh branches from HEAD would omit the candidate. Use disjoint ownership in the shared candidate, coordinated interfaces, and integrated validation; preserve unrelated edits. |

## Primary-source verification

Checked full primary documentation, rather than accepting research snippets as evidence:

- [Rematch developer blog, Season 5](https://www.playrematch.com/post/dev-blog-season-5-gameplay-changes): confirms future-ball-position sampling for dive assistance and the tradeoff between dependable saves and exploitable weaknesses. It does not validate Cryptball's proposed sizes, cooldowns or target percentages.
- [EA goalkeeping research, October 2025](https://arxiv.org/html/2510.23216v1): studies a trained keeper in EA SPORTS FC 25 and proactive positioning. Useful inspiration; not evidence to add reinforcement learning to this small deterministic game.
- [ECMAScript numerical specification](https://tc39.es/ecma262/multipage/numbers-and-dates.html): trig remains implementation-approximated. Continue using the authored heading table in simulation and verify the whole workload in each browser.
- [Box2D collision documentation](https://box2d.org/documentation/md_collision.html): continuous collision and time-of-impact are established techniques. This supports testing the current sweep implementation, not replacing it with a new engine.
- [PixelLab API v2](https://api.pixellab.ai/v2/docs) and [endpoint index](https://api.pixellab.ai/v2/llms.txt): currently document eight-direction character creation and pose-guided Skeleton v3 animation. API capability is verified; visual reliability for these particular sports poses has not been demonstrated.
- [Retro Diffusion official API examples](https://github.com/Retro-Diffusion/api-examples): current API includes images, animations and tilesets, with account authentication and prepaid usage. No generation or purchase is necessary for this prototype.
- [Aseprite CLI documentation](https://www.aseprite.org/docs/cli/): confirms batch exports, palettes, sheets, tags and scripting. It is a suitable optional artist workflow.
- [Steamworks content survey](https://partner.steamgames.com/doc/gettingstarted/contentsurvey): distinguishes development efficiency tools from generated content consumed by players. Storefront compliance is outside this local implementation; keep accurate provenance rather than asserting exemptions.

No exact vendor price, unverified Season 6 patch number, guaranteed copyright outcome, or universal AI sprite reliability claim is adopted.

## Validation and remaining human decisions

Automated implementation checks: targeted simulation and geometry regressions; checkpoint validation and restore; network room/reconnect/seat tests; production build; browser flows; Node/Chromium/WebKit/Firefox checkpoint agreement; measured replay profile; reproducible lab output; asset structure checks and actual visual inspection.

Human-only checks remain: preference for slide versus shield, whether keeping is enjoyable, whether the larger court improves passing, and approval of the athlete/court sample before production art. Automated completion must not be reported as satisfying those gates.
