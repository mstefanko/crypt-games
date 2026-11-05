# Mode ball delivery

Implemented November 4, 2026 by three GPT-6.1 Sol agents with parent architecture review, integration, visual inspection and verification. [Implementation plan](cryptball-mode-balls-plan-2026-11-04.md).

## Engine and game ownership

The engine now exports `@onepage/game-simulation/fixed-flight`: signed fixed-point displacement carries, semi-implicit flight stepping, discrete launch solving, bounded landing prediction, and a closed segment/AABB interval query. These are policy-free provisional helpers, documented in the [engine primitive catalog](engine-primitive-catalog.md). They share one game today; the provisional status avoids claiming broad adoption. Existing open-interior geometry and `BallisticWorld` contracts are unchanged. The purity registry permits only the new public module; engine protection was not weakened.

The game owns mode profiles, dribbling, tackle/contact assistance, restitution, flight duration, net expansion, faults, scoring and artwork. Existing circle sweeps, action timelines, hit receipts, random streams, atlas loading and clip playback remain reused engine infrastructure. No sport-specific renderer or possession framework was added to the engine.

## Delivered behavior

| Mode | Ball and physics |
| --- | --- |
| Cryptball | Existing radius 3, orb artwork and physical defaults retained |
| Cryptkick | Radius 4, distinct panelled football, deceleration 36 units/s², board restitution 0.82, dribble offset 12; existing kick/pass speeds and authored action assistance retained |
| Rift Volley | Radius 5, distinct blue/gold volleyball, set duration 64 ticks and dig duration 72; existing gravity 240 and attack/serve timing retained |

Ground collisions, player separation, passing lanes, goal clearance and prediction consume the selected physical profile. Volley z is center height: floor at radius, wall centers inset by radius, and net slab/top expanded by radius. Shared discrete flight math drives actual displacement, launches, AI interception and the visible free-flight landing marker. Prediction includes current signed carries, rather than using a separate continuous parabola. Radius-expanded rectangular net corners deliberately preserve the conservative slab policy; this is not a full 3D sphere solver.

Checkpoint v6 rejects older height semantics. Wire protocol v4 is unchanged; client/server build identity includes the new engine dependency. Final authority identity: `cryptball-v1-9f35397478d6713c25c48344`.

## Sprites and animation

The independent ball atlas contains 39 original code-authored pixel frames: eight spin frames and four squash/recovery frames per ball, plus five-frame set/dig/attack contact cues. It follows the existing Pillow asset workflow without editing generated athlete anatomy. The new recipe, manifest, atlas and animation proof reproduce byte-for-byte.

Presentation derives shadows, trails, locator size and net ordering from the same radius profile. Volley impact events carry the actual contact coordinates and center height; effects appear at the airborne contact rather than at the athlete's feet. Actual sprite deformation is cosmetic and never changes collision geometry. Reduced motion keeps sports balls round and still with a contact cue. Online correction clamps the Volley center to the physical floor.

Existing overhead set, spike and low slide/dig athlete poses were inspected and reused; no new athlete anatomy or pose sheet was necessary. Their authored assistance remains visible as arcade reach, rather than moving players or stretching limbs to force hand/ball overlap. Confirmed events arriving on an already-rendered tick now display once, using stable epoch/counter identity; duplicates, older contact replacement and rewind/reset are covered.

Evidence: [sprite contact sheet](../apps/cryptball/art-src/balls/contact-sheet-4x.png), [animated sprite proof](../apps/cryptball/art-src/balls/spin-contact-proof.gif), and [captured contact playback](evidence/cryptball-mode-balls-2026-11-04/visual-captures.json). Full-court screenshots cover all modes plus set/dig/attack at ages 0, 4 and 10, and reduced motion. Set and attack captures come from seeded play. The dig capture is explicitly labeled as a validated authored low-ball checkpoint followed by real slide input and simulation-generated contact; it is not represented as spontaneous bot behavior.

## Verification

- Fast engine suite: 233 tests passed across 30 files, including 9 fixed-flight/closed-boundary tests. Independent agent review corrected the launch tie policy; parent review corrected floor-start ascent prediction.
- Cryptball simulation/presentation suite: 89 tests passed across 14 files.
- Network suite: 38 passed; one existing opt-in real-time soak skipped. Actual local socket tests ran with loopback permission.
- Chromium, WebKit and Firefox determinism: all 6 tests passed on finalized source, comparing complete match and takeover/restore hashes with Node.
- Production solo/practice browser suite: all 4 passed. Five multiplayer production browser scenarios passed, including both new modes' invitation, sport discovery, bot fill and reload recovery.
- TypeScript, game boundaries (352 source files, 89 reviewed legacy edges), three boundary regression tests and simulation purity passed. Purity retains 186 pre-existing baseline diagnostics.
- Client and server production builds passed and were refreshed together. Existing local preview remains at `http://127.0.0.1:4224/games/cryptball/`; the local match service was gracefully restarted on port 2567.

Initial browser attempts encountered the existing software-renderer protective pause during warmup. The final sports smoke test resumes only that recognized pause and then requires real clock advancement; production pause policy is unchanged. The final runs passed. This does not establish a guarantee against frame-debt pauses on every device.

## Balance and limits

All 30 seeded bot matches completed. Ten Cryptkick and ten Volley matches produced zero physics diagnostics. The legacy Cryptball sample recorded 6,463 contact-budget diagnostics; its existing default solver policy was retained, and there is no invented pre-change benchmark comparison.

Volley's ten bot matches contained 139 rallies, averaging about 406 play ticks per rally; all ended in floor faults. Team 0 won eight matches, including five 11–0 results. These are functional checks, not a balance endorsement. Bot-only runs did not produce digs, while mixed-input determinism and explicit contact fixtures exercised digging. Human playtesting should assess team balance, receiving reach and the extra 100 ms of setup flight. No public hosting or auditory acceptance is claimed.

Detailed match results, final cross-browser reports, contact screenshots and local-preview verification are in `docs/evidence/cryptball-mode-balls-2026-11-04/`.
