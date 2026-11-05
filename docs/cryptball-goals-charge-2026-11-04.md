# Goal depth and indefinite charge

Implemented 2026-11-04. Local preview http://127.0.0.1:4224/games/cryptball/ and match server refreshed to authority `cryptball-v1-5e63f4b081a7f2f41c7657f5`.

The reported occlusion came from two always-front layers: registered goal net/crossbar graphics and a side-wall cutout that included the boundary artwork. Netting and crossbars now render behind athletes. Posts render in the actor layer, sorted by their ground depth so only a genuinely nearer post can cover a player. The full-height side cutout was removed; near-wall foreground masonry remains. Goal frame height increased from26 to38 native pixels with matching post height. Ground post coordinates, physical mouth width and collision geometry are unchanged.

Charge ticks now saturate at24 rather than forcing a swing at42. `charge-ready` emits once; release triggers one fully powered swing. Existing interruption rules still apply: cancellation, checks, dash/slide and controller changes can clear the charge. This is indefinite holding, not immunity from interruption. A small additive golden silhouette halo and rising motes show full charge to all clients; reduced motion holds them steady. Visuals derive from replicated charging/chargeTicks state and simulation ticks, with no additional network event stream.

Validation:49 unit tests passed, including3600 held-input updates without auto-release and exactly one ready/swing event.16 network tests passed, one optional long match skipped. All three Node/Chromium/WebKit/Firefox replay comparisons passed. TypeScript passed. Both production browser tests passed with native Metal rendering, including goal-side full-charge persistence/release and flame animation. The software-GPU runs intermittently hit startup/protective frame-debt pauses under substantial concurrent local process load; individual checks passed there, but the final full software-GPU run did not. No lifecycle budget was relaxed to hide this.

Actual goal-side charge and gameplay screenshots are in `docs/evidence/cryptball-goals-charge-2026-11-04/`. The native-GPU test configuration is `.local-game-tests/cryptball-native.config.ts`; it uses the same test bodies with Metal instead of forced SwiftShader. Structural tests cannot substitute for player feedback on the goal proportions or glow strength.

Team specials are design only, not implemented. See `cryptball-team-specials-proposal-2026-11-04.md` for alternatives and the recommended Rams Stampede / Fire Cinder Gate pairing.
