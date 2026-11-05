# Six teams, readable sports balls and distinct defenses

Implemented November 4, 2026 with three supervised GPT-6.1 Sol agents: authority/physics, UI/input, and generated art/presentation. Parent authored the plan and original mascot marks, reviewed integration, and verified runtime captures.

## Result

- Cryptkick football is now 12px across instead of 8px; Volley is also 12px instead of 10px. Both have radius 6 collision geometry. Cryptball retains its original orb. Soccer dribble offset 14 and explicit contact assistance preserve surface gaps; net/goal/floor/predictor geometry follows the ball profile. Rolling soccer and aerial Volley retain their distinct physics.
- Right mouse aims and performs a slide/tackle in ground sports or dive/dig in Volley. Left mouse strikes; K passes/sets. Cancellation, release, switching and menus clear or block held input appropriately.
- Generated 32 new transparent hands-first dive poses across eight directions, including airborne reach, forearm contact and push-up recovery. Successful dig contacts select the contact pose immediately and cannot rewind to launch. Ground sports retain feet-first art.
- Six teams: Rams, Foxes, Owls, Gators, Bats and Hornets. Original SVG mascot marks accompany distinct material-only uniform palettes. All have identical stats. Names, emblems, HUD and effects follow authoritative identities.
- Solo team/opponent choices persist. Multiplayer preferences establish unclaimed sides; teammates adopt established identities. Waiting selection changes require renewed Ready acknowledgment, lock at countdown, and survive reconnect/rematch. Matchmaking is separated by sport, not mascot.

## Ownership and artifacts

No new engine API was needed. The game uses existing engine flight/geometry, action timelines, atlas clips and lifecycle services. Ball tuning, team identity, lobby policy, controls and sport-specific anatomy remain game-owned.

The [implementation plan](cryptball-teams-controls-dives-plan-2026-11-04.md) includes physical sizing research, rationale and engine boundaries. Football and volleyball real-world circumferences differ by only about 4.5% at their midpoints, less than one pixel at this scale; matching 12px silhouettes prioritize readability.

Generated originals and prompts: `apps/cryptball/art-src/dives-v1/`. Native six-palette proof: `runtime-team-comparison.png`. Original code-native emblems rebuild through `scripts/game-assets/import-cryptball-team-icons.mjs`. `npm run assets:cryptball` rebuilds icons and all atlases. Five 1024² athlete/arena pages total about 20MiB decoded, plus the small ball atlas. All pages are prewarmed. Pixel QA checked 1,280 palette-variant frames: alpha and nonuniform materials are exactly preserved.

Runtime evidence in `docs/evidence/cryptball-teams-controls-dives-2026-11-04/` includes actual rendered ball silhouettes, feet-first soccer slide, immediate dive contact and push-up recovery. `visual-fixtures.json` identifies seeded captures and the explicitly authored low-ball checkpoint followed by real simulation input; those captures are not claimed as naturally occurring bot digs.

## Validation

- Game simulation/presentation:95 passed.
- Authority/network/client/full-match:43 passed, 1 opt-in soak skipped.
- Engine regression:233 passed.
- TypeScript, game boundaries and three Cryptball boundary tests passed. Purity passes with its unchanged 186 baseline diagnostics.
- Material QA: 1,280 variant frames passed.
- Production browser suite: 7/8 passed initially; existing sustained-charge test passed independently afterward. Failed run showed a practice goal and no powered player. A goal resets player charge, making interference likely; the failed trace was replaced by the independent rerun, so this cause is not conclusively established. No retry policy, weakened assertion or gameplay workaround was added.
- Full multiplayer browser suite: 6 passed, including authoritative team change → both Ready → Start, invitations, bot fill and reload/reconnect.
- Determinism: 6 passed across Chromium, WebKit and Firefox; complete matches and takeover hashes match Node.
- Production client/server builds passed with authority identity `cryptball-v1-93a675d628924fa945b0241f`, checkpoint 7, protocol 5.

- Live preview at `http://127.0.0.1:4224/games/cryptball/` verified all six choices, both menu sizes, correct radii and defensive right-click without a pass in all three modes, and private creation/leave against the updated port2567 service for both new sports. Zero page errors; see `live-preview-verification.json`.

## Limits

Automated checks establish rules, transport, rendering availability and deterministic agreement, not competitive balance or subjective animation smoothness. These are generated key-pose animations rather than hand-cleaned inbetweens. The arena's painted house banners retain original scenery motifs; selected team identities are communicated by uniforms, live HUD, menu emblems and effects. No team-specific abilities or geographic affiliations were introduced.
