# Cryptball specials, controls, and audio delivery

Implementation by three GPT-6.1 Sol agents, with parent integration and cross-review. Authoritative design: [implementation plan](cryptball-specials-controls-audio-plan-2026-11-05.md).

## Shipped behavior

All six specials now have larger tactical benefits while preserving ordinary scoring, collision, charge-power caps, and Volley contact rules. Charge is faster and stops on its first body hit; Sidestep resists checks during its cut and preserves an existing soccer dribble; Focus lasts three seconds and helps one reception; Snap extends defensive reach and recovers faster on successful contact; Flutter's second burst requires a second press; Sting converts very short charges into fast ordinary-power releases. Shared 12-second opening / 24-second repeat charge remains.

Touch uses a floating movement thumb and a separate action thumb: tap passes, hold/release shoots, flick dives, and drag after shot recognition aims independently. Tap the special card while moving; Flutter uses the same card again. Movement-thumb lift cancels a prepared shot. Quick nearby movement re-touch followed by drag dashes. Teammate targeting provides switching where control ownership permits. Menus retain scrolling, and interruptions cancel safely.

Mouse uses cursor aim, left shoot/charge, right dive, middle pass, and clickable specials. Existing keyboard alternatives remain. Individual mouse button chords and participant-scoped switch handling prevent missed actions or remote players releasing a local held shot.

Original synth music uses a 32-bar C-minor arrangement with hook, answer, breakdown, return, and immediately eligible overtime layers. A separate four-bar title loop removes the former long silence. Six special palettes plus impact/save/material cues share bounded effect voices and output protection; music/effects gains are independent without restarting transport. Audio sources and sample provenance: [listening exports](evidence/cryptball-audio-2026-11-05/README.md).

## Integration decisions

* Movement remains direction-only after a deadzone, matching the simulation's normalized movement input. No new analog movement advantage is introduced.
* Sting charge of at most six ticks becomes charge zero for power and a quick release; longer charges preserve ordinary tell and power. This is identical across input devices.
* Volley Snap shifts its ordinary dig reach forward by 35%, rather than exceeding the geometry engine's primitive radius limit. A longer replay exposed and verified this fix.
* Hockey Snap preserves the 18-tick poke structure. Focus adds four Volley set contact ticks at ordinary reach and damps a physical ground reception.
* Checkpoints are version 10; multiplayer protocol is version 8. Manual follow-up and reception/contact flags are authoritative and replayable.
* Real phone comfort and final competitive balance remain user playtesting questions; automated gesture and scoring invariants cannot establish those subjective outcomes.

## Verification

* Cross-browser determinism: six tests passed across Chromium, WebKit, and Firefox; complete sports runner covers 30 scenarios and 35,748 ticks, including special follow-up and mid-effect restores.
* Multiplayer authority/network: 67 passed, one existing opt-in soak skipped. Local socket checks were rerun with permission to bind localhost after a sandbox-only failure.
* Cryptball import boundaries: three passed.
* Full simulation/unit suite: 203 passed across 27 files. TypeScript passed.
* Production keyboard/mouse defense, charged release, special cooldown, team selection and sports browser checks: 11 passed.
* Touch/mouse integration: four cases passed with genuine Chromium multitouch and mouse input. The two mobile cases also passed a final isolated run with stronger shot-release and active second-burst assertions. Nine focused input-policy/gesture tests passed, including local participant ownership and online one-human switching.
* Server build passed. Production client build passed as part of browser checks. The local server uses authority `cryptball-v1-ffc5e7a56e71e5909e02b80d`.
* Original music/effect exports contain no clipped samples or silent music seconds. Audio rendering and live-device smoke cover independent gains, no transport reset on volume changes, mute/pause/reset/dispose and context suspension. A 48kHz headroom audit of 77 effects bounds eight simultaneous effects plus maximum music below full scale before ducking.
* Final client rebuild and original preview at `http://127.0.0.1:4224/games/cryptball/` verified: private room created/left against port 2567, live practice reached tick 171, server health OK, zero page errors. [Verification record](evidence/cryptball-controls-2026-11-05/final-preview.json).

[Landscape](evidence/cryptball-controls-2026-11-05/mobile-landscape.png), [portrait](evidence/cryptball-controls-2026-11-05/mobile-portrait.png), and [final preview](evidence/cryptball-controls-2026-11-05/final-preview.png) screenshots are preserved separately from disposable Playwright outputs. Temporary control-test servers/configurations were removed; the user preview and matching multiplayer server remain running. Mobile play is most comfortable in landscape; portrait retains the full court without cropping.

The test harness now uses ANGLE Metal by default on macOS, with SwiftShader elsewhere and `CRYPTBALL_ANGLE` override. Forced software rendering and competing renderer processes could trigger the existing frame-debt protection during live gestures. Those interruptions were retained as evidence; no game lifecycle thresholds were weakened.
