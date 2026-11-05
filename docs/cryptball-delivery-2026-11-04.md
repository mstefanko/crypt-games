# Cryptball implementation candidate — 2026-11-04

The edited implementation plan was checked against the local engine sources and camera diagram before implementation. GPT-6.1 Sol agents handled the engine audit/presentation, asset pipeline, and simulation; the coordinating agent integrated host/UI/audio, corrected the plan and checked the combined app. Existing Museum/Wrecklight changes were preserved. No commit, push or publication was performed.

## Delivered code

`apps/cryptball/` includes the native 384×256 Pixi court, four directional athletes, free-orb physics using public geometry queries, 2v2 team AI, charge/pass/dash/switch actions, regulation/overtime, practice, title, pause/settings, results/rematch, synthesized music/cues and reproducible art outputs. Root scripts provide development, production build, unit tests, a single production Chromium smoke test and asset rebuilding. README includes controls and credits.

The host owns physical input cancellation and browser lifecycle. The session owns all gameplay state. The presenter consumes detached observations. The audio adapter uses one existing synth/device owner; music does not drive game time. No replay, save/restore, content-identity, qualification harness or general physics engine was added.

## Accuracy corrections folded into the plan

- Public projection composition and fixed geometry bounds were verified. Pixel viewport pointer dimensions required explicit setup.
- Wrecklight provides lifecycle/event examples, but its empty music score and identity-heavy build configuration were not reusable as claimed.
- Independent sound levels/panning/voice admission required app-owned policy around the public audio engine.
- Original art replaces optional uninspected font/UI/VFX packs. Purchased athlete sprite redistribution terms remain unverified.
- Effort estimates, aesthetic quality, playability and voluntary-rematch targets are not measured results.

## Remaining acceptance work

This is an implementation candidate, not an assertion that every finished-demo checkbox has passed. Human listening and unfamiliar-player playtesting remain outstanding. Public distribution of Lords of Pain pixels remains pending confirmation of the purchased pack terms.

The implementation uses DOM monospace UI text rather than a dedicated bitmap font, a shared attack contact-frame mapping rather than separately authored markers for every heading, and eased goal-net transforms rather than three hand-authored net frames. The palette pass is a fixed material-color heuristic rather than hand-painted masks or a verified 24–32-color palette. These differences are explicitly recorded in the plan; exact C3 visual acceptance remains open.

Visual evidence: `docs/evidence/cryptball-2026-11-04/court-2x.png`, `practice-1x.png`, and the private-source-derived moving inspection sheet `apps/cryptball/art-src/animation-proof.gif`. Inspection supports crisp scaling and directional coverage; it does not substitute for full-match human art review.

## Validation

- Final authority suite: 12/12 cases pass, including actively pressured corner escape and an interior two-athlete pinch; temporary investigative tests were removed.
- Three complete idle-human seeded matches (seeds 1, 2, 3) ended 1–5, 4–7 and 4–8 with zero contact-budget diagnostics. This checks progress/scoring and stability on those routes; it is not a balance or fun claim.
- Final `npm run typecheck`, `npm run test:cryptball` (12/12), `npm run build:cryptball`, and `npm run test:cryptball:browser` (1/1 production Chromium test) all pass.
- The smoke route enters with Enter, exercises keyboard play, checks a progressing timer and no audio/load notice, pauses/resumes, and checks console errors/scoreboard.
- Latest 20-second production profiling run completed without a pause after host observation/DOM caching, single-frame rendering, atlas clip caching and effect prewarming. No sustained main-thread bottleneck was identified.
- Earlier full-match software-GPU (SwiftShader) runs triggered protective scheduler pauses. A final uninterrupted full-match acceptance result has NOT been established. Native Chrome was observed at 0:37, but apparent user activity meant that tab was left untouched; this is not claimed as an independently completed test.
- Local preview remains at http://127.0.0.1:4224/games/cryptball/. It is local only, not a published deployment.

### Collision policy correction

The solver uses four substeps and at most four contacts total per substep. Wall slides preserve piecewise paths. Player-pair corrections use bounded orb/static sweeps; end positional corrections are instantaneous rather than physically swept ball impacts. For persistent blocked/multiple-player contacts, the athlete yields two world pixels and its remaining collider motion stops; common-tangent velocity projection is inelastic. This is deliberate arcade policy and exceeds the normal one-fixed-unit separation slop. Only walking contacts nudge the orb; stationary actors do not inject energy. Bank prediction verifies the intended 250-pixel/second shot speed and does not forecast future player decisions.
