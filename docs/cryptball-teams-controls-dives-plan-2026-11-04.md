# Ball scale, defensive controls, dives and six teams

Status: implemented; see [delivery and verification](cryptball-teams-controls-dives-delivery-2026-11-04.md).

Date: November 4, 2026. User-authorized implementation with three supervised GPT-6.1 Sol agents. This plan supersedes the previous mode-ball size targets.

## Findings and decisions

The current football has the same 8px solid silhouette as the original Cryptball orb. Changing its collision radius from 3 to 4 did not enlarge its artwork relative to the original ball. The 10px volleyball is only slightly larger. Use 12px solid silhouettes and physical radius 6 for both football and volleyball, leaving Cryptball's existing orb unchanged. This makes the football 50% wider than its previous artwork and the two inflatable sport balls comparable in size. Their panel designs, spin and flight distinguish them. This is an arcade readability scale, not a literal recreation of real baseball-to-football dimensions.

Real-world sizing supports nearly equal sport-ball diameters: [IFAB Law 2](https://www.theifab.com/laws/2025-26/the-ball/) specifies 68–70cm circumference for football; [FIVB rules 2025–2028](https://www.fivb.com/wp-content/uploads/2025/01/FIVB-Volleyball_Rules2025_2028-EN.pdf) specify 65–67cm for volleyball. Their midpoint diameter ratio is only 69/66 ≈ 1.045. At 12 game pixels that difference is about half a pixel, so matching silhouettes are appropriate. Larger radius also enlarges interception area and reduces goal/net clearance; keep collision, contact assistance and rendering coordinated rather than adding visual scale alone. Mass is an independent gameplay choice; retain the grounded rolling football and gravity-driven aerial volleyball profiles.

Right mouse currently passes while left mouse strikes; those actions can look similar. Rebind right mouse to the existing slide action in Cryptball/Cryptkick and dive/dig action in Volley. Keep K for pass/set and Shift/I as defensive keyboard controls. A right click must aim from its actual pointer coordinates, launch the defensive action, never emit a pass, and never accidentally release a charged strike on pointer cancellation or menu transitions.

The current Volley dig is an alias for a feet-first slide. It needs new hands-first anatomy, not a renamed clip or a flipped slide bitmap. Generate launch, airborne reach, low forearm contact and push-up recovery for all eight facings. Existing feet-first slides remain appropriate for soccer tackles and Cryptball blocks.

## Teams and identity

Use short mascot names. Geographic names such as Arizona Fire introduce real-world location associations into a shared fantasy arena and make lobby/HUD text longer. Color-prefixed names such as Blue Rams overemphasize color, which should not be the only identifying cue. Team names and emblems remain stable even if kit contrast is adjusted later.

| ID/name | Uniform palette | Emblem silhouette | Existing asset compatibility |
| --- | --- | --- | --- |
| rams / Rams | Cyan/teal `#72d9d6` | Curled horns and ram face | Existing ivory source palette/prefix |
| foxes / Foxes | Coral/orange `#f08b59` | Tall ears and angular fox muzzle | Existing ember source palette/prefix |
| owls / Owls | Royal blue `#6f9fff` | Broad brow and paired eyes | New masked material swap |
| gators / Gators | Spring green `#9dc95b` | Long jaw and teeth | New masked material swap |
| bats / Bats | Violet `#be8ce8` | Wide angular wings and pointed ears | New masked material swap |
| hornets / Hornets | Gold `#f4ce55` | Striped abdomen, wings and antennae | New masked material swap |

This adds four playable team identities to the two existing palettes, giving the old palettes clearer mascot identities. All teams have identical gameplay stats. Use light/dark outlines, readable names and distinct icons so color is not the sole distinction. Do not add real geography, team-specific abilities or new player body types.

## Engine/game boundary

Keep this work game-owned: sport ball profiles, input bindings, team identities, palette selection and match/lobby policy. Reuse the engine's fixed-flight, circle/closed-boundary geometry, action timelines, atlas loading and clip playback delivered earlier. Do not put a six-team catalog or a volleyball pose controller into the engine. Generate palettes at asset-build time using the existing material masks; do not tint skin and metal with a whole-sprite filter. Review startup/prewarm cost with the additional pages.

## Authority and multiplayer — Sol authority agent

1. Add a validated shared `sim/team-identities.ts` catalog exporting `TEAM_IDS`, `TEAMS`, `TeamId`, `TeamSelection`, defaults and selection validation. Keep game teams as numeric sides 0/1; `teamIds: [TeamId, TeamId]` is separate cosmetic identity carried by observations and checkpoints.
2. Create sessions with a distinct known team pair. Persist the pair through restarts/rematches/reconnects. Bump checkpoint to 7 and wire protocol to 5 for the new required identity contract; regenerate client/server identity together after integration.
3. Include authoritative `teamIds` in lobbies. Join uses `preferredTeamId`; only a side's first human claim can establish that preference. Joining an already-established side adopts its existing identity. If a preference matches an unclaimed opposing identity, move that unclaimed default to a distinct mascot. Preserve claimed opponents; duplicate preferences then receive a deterministic distinct fallback. Show the actual team in the lobby. Do not partition Quick Play into six team-specific queues.
4. Waiting-lobby teammates may send `team {teamId}` to change their own side's identity. Reject unknown IDs, duplicates, unseated senders and changes after countdown starts. A valid changed selection resets readiness so both sides acknowledge the matchup through an explicit Ready button. No-op and rejected selections do not reset readiness. Send a clear `team-error` for a rejected race; the authoritative lobby remains the source of truth.
5. Raise soccer and Volley radius to 6. Raise soccer dribble offset from 12 to 14 to preserve the previous gap. Audit trap/strike/tackle surface reach, goal/post clearance, wall inset, net slab, serve placement, contact heights, predictors and restoring snapshots. Preserve explicit assistance gaps where size should not reduce control unexpectedly. Keep rolling deceleration 36, board restitution 0.82 and Volley setup timing/gravity unless evidence requires a correction.
6. Test unknown/duplicate IDs, first-side preference, teammate joins, ready reset, selection races, in-play rejection, rematch and restore. Add radius-aware control/goal/net regressions.

## Menus, HUD and controls — Sol UI agent

1. Add compact accessible team selection before starting play. Users choose their team and an opposing team offline; keep the pair distinct, save preferences locally, and preserve keyboard focus when selection changes. A compact six-choice grid plus opponent selector avoids burying the Play actions on short screens.
2. Show selected names, emblems and colors in the title matchup preview, scoreboard, lobby, serve/contact prompts and result screen. Use stable DOM anchors where tests depend on them, but remove visible Ivory/Ember assumptions. Native button/select semantics, names and selection states must work without color perception.
3. Send the preferred identity on online join. Expose own numeric side via the authoritative participant ID. In waiting lobbies show the actual matchup and an own-side picker; disable the opponent's selected team, handle rejection messages and lock changes during countdown/play. Explain that joining an existing squad adopts that squad's identity.
4. Track right-button held/blocked state separately from left-button charge. Integrate with tick commands, pointer up/cancel, blur/menu, control switching and online takeover. Keep browser context menus suppressed only on the game canvas. Update all help text and controls labels: left strike/serve/attack, right slide/tackle/dive, K pass/set.
5. Test all three modes' right-click behavior through actual browser input, with no pass event; test release, cancellation and no stuck defensive action. Test team choices locally and through the online transport, including UI persistence and authoritative updates.

## Sprites and animation — Sol art agent

1. Generate genuinely transparent new hands-first dive source art with the built-in ImageGen tool, using inspected existing athlete references. Prefer two 4×4 sheets: rows E/SE/S/SW and W/NW/N/NE; columns launch, airborne reach, chest-low forearm contact, push-up. Preserve teal cloth, gold/neutral armor, skin and leather, complete anatomy, empty hands and consistent scale. No baked ball, floor, motion streak or shadow. Save original outputs and prompts under `art-src/dives-v1`.
2. Inspect generated figures, extract/normalize with a consistent scale and explicit body/contact anchoring, then pack actual distinct `dive` and `dive-recover` clips for Volley. A dig contact should select the real forearm-contact pose; other sports retain feet-first slides. Inspect contact and recovery timing at native play size and all eight facings.
3. Extend both armed and weapon-free atlas pipelines to the six palettes using material masks; preserve existing skin, leather and metallic values. Reuse the same motion frames across teams. Keep deterministic rebuilding, source hashes, prompt provenance and extraction QA.
4. Rebuild football and volleyball art at a 12px solid diameter with corresponding squash/recovery. Consume shared radius for shadow, trail, ground lift, locator and collision-aligned composition. Do not merely upscale an 8px frame with an enlarged invisible collider.
5. Resolve athlete/effect/badge colors and clips from observed `teamIds`, never from a client-only preference. Prewarm the additional atlas pages while loading. Verify disposal and no missing frames after switching sports/teams.
6. Parent authors six original code-native SVG mascot emblems for menu/HUD use; these are icons, not substitutes for generated athlete sprites. Structural and visual tests cover the sprite palettes and distinct dive/slide frame identities.

## Integration and acceptance — parent

Keep workstreams disjoint: authority owns simulation/protocol/server, UI owns host/styles/online client, art owns presentation/animation/importers and image artifacts. Parent owns this plan, emblems, integration review, delivery report and evidence. Preserve unrelated existing working-tree changes.

Validate TypeScript, boundaries/purity, engine regression tests, game simulation/presentation, network and cross-browser determinism. Run production menu/control checks for all six choices and three sports, multiplayer two-side selection/lock/reconnect/rematch, asset-load/prewarm checks, and representative full matches with alternate identities. Capture native-scale ball comparison, feet-first slide versus hands-first dive contact/recovery and all six palettes. Inspect actual images, not just frame names. Refresh the local preview and service together after passed builds. Record exact evidence and unresolved visual/playtest limits without claiming tests establish balance.
