# Selected-team arena banners and six specials

Implemented with three GPT-6.1 Sol agents, with parent design, integration and review. The [design comparison](cryptball-team-specials-implementation-2026-11-04.md) records rejected options, sport-specific value, counterplay and resource choices.

## Arena art

All eight colored club flags now use the authoritative teams, including perspective side-wall flags and foreground cloth above the stone cutout. Rear skull hangings remain neutral architecture. Generated blank pixel cloth was combined with the existing original mascot SVGs to preserve team identity; cropped outputs total about 1 MB decoded. Team changes update the overlays in all sports, solo and multiplayer.

Generated source and exact prompt: [banners-v1](../apps/cryptball/art-src/banners-v1/README.md), [provenance.json](../apps/cryptball/art-src/banners-v1/provenance.json). Built-in OpenAI ImageGen was used. The final runtime art is in `apps/cryptball/public/assets/cryptball-banners/`. `npm run assets:cryptball` rebuilds it. Runtime screenshots for all three sports are in `docs/evidence/cryptball-team-banners-2026-11-04/`.

## Specials

B activates the controlled athlete's team move. Both teammates share one resource: 12 seconds initial charge, then 24 seconds per use, measured in live simulation ticks. The HUD shows the selected move, progress, READY, a single readiness flash/announcement, and the active athlete and remaining time. Reduced motion retains static state cues. Fully bot-controlled teams can activate; a bot teammate does not spend a human side's resource.

Every move has a six-tick (0.1-second) tell. Ordinary action/recovery/stagger admission rules apply, and Volley serve setup blocks specials. All movement uses existing collision and Volley half-court clamps. No move increases ball power or reach, grants invulnerability, adds Volley contacts or bypasses same-player contact restrictions.

| Team | Implemented behavior after tell |
| --- | --- |
| Rams — Charge | 18 ticks at 1.75× run speed in a committed direction; one ordinary body check; 12 ticks recovery. |
| Foxes — Sidestep | 14 ticks at 1.65× run speed with steering; no special body check. |
| Owls — Focus | 90 ticks of full movement while charging/striking, plus faster acceleration while charging. |
| Gators — Snap | 24-tick defensive slide/dive with ordinary contact limits; 20 ticks recovery. |
| Bats — Flutter | Two eight-tick bursts at 1.8× run speed, separated by ten ticks at ordinary movement, followed by ten ordinary-movement ticks. |
| Hornets — Sting | 60-tick priming window; next strike/pass tell reduced by two ticks and recovery by four, minimum one; consumed on action creation. |

Existing directional athlete art supplies the correct anatomy, including hands-first Volley dives. New native mascot signatures and phase-driven poses distinguish anticipation, bursts and recovery without introducing unrelated generated athlete silhouettes. Active effects reconstruct from checkpoint state. Fast soccer bursts release possession using ordinary sprint rules.

Goals/restarts and match completion clear active effects while retaining spent cooldown. Pauses/stoppages do not charge. Stable athlete order resolves simultaneous teammate requests once. Checkpoint version 8 and protocol version 6 include and validate ability state, including opening/repeat meter denominators. Reconnect never restores a spent resource.

## Validation

- 110 simulation/presentation tests passed, including final-whistle and interrupted-effect checkpoint restores across all six teams and three sports.
- 43 authority/network/full-match tests passed, one opt-in soak skipped; an additional real socket special test passed separately, covering natural initial recharge, one activation seen by both peers, and spent cooldown preserved through an actual network drop/reconnect.
- Six cross-browser determinism tests passed in Chromium, WebKit and Firefox, including all 18 team/sport special fixtures and mid-effect restore.
- Production browser suite: eight of nine passed in the aggregate run. The startup smoke test entered the existing software-renderer protective pause; it passed independently afterward. Failure trace was retained. No gameplay workaround or relaxed assertion was introduced for that test.
- TypeScript passed. Game boundaries and three Cryptball boundary tests passed; purity passed with its unchanged 186 existing baseline diagnostics.

- Six multiplayer browser tests passed, including private-room sport hydration, bot fill, reload/reconnect and authoritative waiting-room team changes.
- The dedicated natural-recharge B test also passed with final READY/active screenshots in `docs/evidence/cryptball-team-specials-2026-11-04/`.
- Client and server production builds passed with authority `cryptball-v1-0bc1a68a1983baff49102ad9`. Existing local preview at `http://127.0.0.1:4224/games/cryptball/` was rebuilt; its local server on port 2567 was gracefully restarted to match protocol 6.


- Final existing-preview verification passed: Owls/Hornets banners and Focus/Sting HUD, successful private-room create/leave against the restarted server, zero page errors. See `live-preview.json` and `final-preview.png` in the special evidence directory.

## Limits

These are initial balance values, not demonstrated competitive parity. Human playtesting is still needed to compare useful activations, scoring/possession after use, telegraph readability and animation feel. Long software-rendered runs can still trigger the existing protective pause.
