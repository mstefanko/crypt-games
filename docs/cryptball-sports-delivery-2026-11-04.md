# Cryptkick and Rift Volley delivery

Implemented November 4, 2026 with three GPT-6.1 Sol agents for simulation, networking/UI, and presentation, supervised and integrated by the root agent. The shared-first implementation plan is in `cryptball-sports-implementation-plan-2026-11-04.md`.

## Delivered behavior

The title screen selects Cryptball, Cryptkick, or Rift Volley before Solo, Practice, Quick Play, or private-room creation. All modes use the same dungeon arena, camera, four-athlete roster, input bindings, renderer, session lifecycle, deterministic geometry utilities, and multiplayer service. Cryptball remains the default with its existing rules and art.

| Mode | Distinct gameplay | Arena changes |
| --- | --- | --- |
| Cryptkick | Soft exposed dribbling, automatic traps, passes, charged kicks, sprint releases and committed tackles; timed goals | Existing goals, boards, stone floor and architecture; possession/contact cues |
| Rift Volley | Authoritative ball height; serves, sets, attacks and digs; three contacts, no consecutive contact by one athlete; first to 11, win by two, cap 15 | Unmarked stone-floor overlay, closed goal panels, thin spectral divider with depth sorting, airborne shadow/trail and predicted landing cue |

The volley divider is an 8-pixel visual ribbon because the center plane is nearly edge-on in the existing camera. Its world position and net clearance match the simulation. Player jumps are contextual animation; ball flight, net collision and floor/perimeter faults are simulation rules. No new manual jump binding was added.

## Shared work and reuse

Shared sport descriptors and validation feed the simulation, UI and server. Sport identity is independent of match/practice and persists through checkpoints, matchmaking, invitations, reconnects and rematches. Existing input actions take sport-specific meanings. The new sports use their own rules and tactics while retaining Cryptball's existing path.

Quick Play queues are sport-filtered. Private invitations include the sport, and a bare room code discovers authoritative room settings. Prediction and rollback restore possession and rally state; score and rally transitions remain authoritative. Reconnect storage is scoped by mode/room. Checkpoint v5 and protocol v4 require updated peers; older checkpoints are rejected. Both client and server builds regenerate a shared identity. The network test command now generates that identity before Vitest imports modules, preventing stale identity failures after simulation edits.

Both new modes reuse a separate weapon-free athlete atlas: eight facings × sixteen generated key poses, team variants, 257 packed frames and 272 named clips on one 1024×1024 page. Movement, slide and recovery are shared. Kick anticipation/contact/follow-through, receive, set, jump, spike and landing are added. Pass uses kick poses; trap uses kick contact/idle; dig uses slide/recovery. This is generated key-pose art, not hand-polished inbetweens. Source prompts, extraction coordinates, provenance and aliases are in `apps/cryptball/art-src/sports-v1/README.md`. The original Cryptball atlas remains separate. The standard asset command rebuilds both.

## Supervision corrections

Integration review caught and corrected repeated tackle contacts, immediate possession reacquisition, interception attribution, invalid contact-query radii, invisible opponents in volley practice, and an unreadable edge-on net. Later full-match review corrected soccer defenders advancing toward the opponent while defending, shots aimed from the athlete rather than ball, and volley net checks missing vertical drops or descending top grazes. Regression tests cover these cases. Five seeded games per new sport all finish without physics diagnostics; soccer wins occur on both sides. This sample is evidence of functioning bots, not a balance guarantee.

## Validation

- Simulation/presentation unit suite: 79 passed across 11 files.
- Network suite: 38 passed across 4 files; one existing opt-in real-time socket soak skipped. Includes nine complete authoritative matches covering three sports with two, three and four human slots, plus real socket admission/reconnect scenarios.
- Cross-runtime determinism: 6 browser tests passed. Node checkpoint/event hashes match Chromium, WebKit and Firefox at every tested tick, including complete bot matches and mixed-input takeover/restore scenarios for each new sport.
- Production solo/practice browser suite: 4 passed, covering original Cryptball controls/charge and each new sport's selection, practice, solo rendering, controls and pause/resume. Screenshots were visually reviewed.
- New-sport determinism workloads: 6,240 Cryptkick bot ticks, 5,630 volley bot ticks, and 2,400 mixed-input ticks per sport. Chromium p95 for a 12-tick replay was 1.1 ms for Cryptkick and 0.5 ms for volley, using 20 warmups and 40 measured trials; these are replay measurements, not end-to-end latency.
- TypeScript passes. Game boundaries pass across 350 source files and 89 reviewed legacy edges; three dedicated boundary regression tests pass. Simulation purity passes with 186 retained pre-existing baseline diagnostics.

- Production multiplayer browser acceptance: all 5 scenarios pass across the final full run (4 passing) and a focused rerun of the corrected original Cryptball test (1 passing). Both new modes pass invitation/bare-code discovery, bot fill, cover/resume and interactive reload. Original scenarios also cover four-player auto-start, fifth-player queueing and private-room reload.
- The initial browser runs exposed legitimate `Computer covering` screens from blur/frame-debt protection during multi-client software rendering. Tests now bring the active page forward, recognize only that specific cover screen, prove authoritative ticks keep advancing, explicitly return to play and assert the correct interactive court. Connection errors and other overlays still fail. Runtime protection is unchanged; a nonvisual `data-tick` attribute exposes progress for this check.
- Final production client/server builds pass. The existing preview at `http://127.0.0.1:4224/games/cryptball/` serves the refreshed default client, and the local match server was gracefully restarted on port 2567. A final browser check created and left a private room for each new sport, verified invitation sport identity and actual WebSocket port 2567, and reported no page errors. TypeScript was rechecked after the final progress attribute/test changes.

## Remaining acceptance limits

Human playtesting should assess passing/receiving feel, volley reach and timing, bot difficulty, and directional pose transitions. Tests do not establish fun, final art approval, auditory acceptance, or public/WAN hosting readiness. Generated poses and their intentional aliases are documented rather than represented as bespoke full animation sets. Local multiplayer is tested; no public service is deployed. Existing software-GPU frame-debt protection may pause or offer bot cover under heavy concurrent rendering load.

Evidence: `docs/evidence/cryptball-sports-2026-11-04/` contains mode screenshots and cross-browser determinism reports; `docs/evidence/cryptball-online-2026-11-04/` contains multiplayer/reconnect screenshots.
