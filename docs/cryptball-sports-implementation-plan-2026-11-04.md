# Cryptball, Cryptkick, and Rift Volley

Requested November 4, 2026: implement two additional modes on the existing dungeon arena, using GPT-6.1 Sol agents under root integration and review. This plan describes intended behavior; delivery evidence is recorded separately.

## Scope and decisions

Keep the current four-athlete 2v2 roster, 332×192 world court, 640×400 presentation, dungeon architecture, crowd, torches, team identities, and camera. Cryptball remains the default and retains its rules. New modes use the same room transport, input bindings, session lifecycle, deterministic checkpoint/replay, geometry utilities, and asset-loading infrastructure. No generic sports engine or separate multiplayer service is needed.

Cryptkick adds possession and passing choices; Rift Volley adds aerial team rallies. Hockey is deferred because it overlaps the existing free-orb stickball game. Tennis can later reuse airborne trajectory primitives, but is outside this delivery.

## Phase 1 — shared foundation

1. Add a validated `SportId` (`cryptball`, `cryptkick`, `rift-volley`) separate from match/practice. Shared descriptors supply names, rules, controls, and scoring descriptions.
2. Add sport identity to state, observation, checkpoints, lobbies, room creation, matchmaking filters, invitations/reconnect adoption, and solo/practice selection. Keep sport immutable during a room; rematches reset sport state and input/event epochs. Reject unsupported or mismatched states atomically.
3. Introduce bounded deterministic sport state with floor position and height/vertical velocity for the ball. Preserve Cryptball's existing simulation path. Only new modes dispatch new actions, tactics, and scoring.
4. Preserve authority at the server. Client prediction executes the same simulation; restore all possession/rally state. Scores and rally outcomes come from authority. Keep existing input vocabulary, with mode-specific meanings and instructions.
5. Share a weapon-free armored athlete atlas between new modes. Existing bat poses cannot represent kicks or overhead sets. Preserve original Cryptball art; use new generated source poses and reproducible extraction/packing, team material variants, consistent foot pivots, and eight screen facings.
6. Reuse arena base and lighting. Add a mode-specific floor/prop layer instead of regenerating the architecture. Existing painted markings are decorative and need masking or consistent overlays where they conflict with volley rules.

## Phase 2 — Cryptkick

### Gameplay

- Two field players per side, live boards, existing goal mouths and short timed scoring.
- Soft, exposed dribbling: nearby manageable balls can be controlled; visible touches and sprinting push the ball ahead. No invulnerable carried ball.
- Primary action charges/releases a kick; secondary passes; slide tackles commit and release the ball into a contest. Dash/sprint trades control for speed. Existing switching remains.
- No offside, throw-ins, aerial headers, or dedicated keepers in this version.
- Deterministic tie-breaking for simultaneous claims/tackles, recovery and pickup lockout to prevent instant reattachment, safe wall interaction, and receiving/pass completion.
- Bots pressure opponents, support possession, pass and shoot, and recover loose balls.

### Arena and artwork

- Keep goals, perimeter, center line and architecture. Add restrained soccer-specific field cues without obscuring stone floor or player contrast.
- Share unarmed idle/run/slide/recovery with volley. Add trap/dribble, pass, and kick anticipation/contact/follow-through. Use a distinct readable ball and possession/contact cues.
- Match kick contact frame to simulation activation; do not reuse a bat-swing silhouette.

## Phase 3 — Rift Volley

### Gameplay

- Same court, teams constrained to their left/right halves. Seal end-goal openings for this mode.
- Center net runs along world x=0, far-to-near in the existing camera.
- Ball has authoritative height; net clearance, floor landing, perimeter faults, and hits are ordered deterministically. No merely cosmetic flight arc.
- At most three team contacts and no consecutive contact by one athlete. One action cannot trigger multiple contacts.
- Primary returns/attacks, secondary sets, slide digs, and attacks use contextual jump timing. No dedicated manual jump input required initially.
- Serve phases, readiness/timeout, rally resets, first to 11 with win-by-two capped at 15. Practice must remain playable with resets and no terminal match score.
- Bots predict landing locations and coordinate receiver/setter roles; bot takeover must handle serves and active rallies.

### Arena and artwork

- Stone goal closures and restrained half-court markings; reuse all surrounding masonry and crowd.
- Thin translucent spectral net with posts and depth-aware drawing. Avoid hiding the ball behind an opaque barrier.
- Airborne ball uses a ground shadow and landing cue; rendering follows simulation height. Keep floor anchors distinct from airborne sprite positions.
- Add ready/receive, overhead set, spike windup/contact/follow-through, jump/landing and diving dig. Reuse shared unarmed movement and recovery.

## Phase 4 — integration and acceptance

- Root reviews agent changes and cross-file contracts; independent ownership avoids simultaneous edits to shared modules.
- Unit/authority: preserve Cryptball tests; add soccer claim/tackle/pass/goals and volley contact/net/landing/serve/scoring cases; checkpoint restore and bounded values.
- Multiplayer: sport-filtered admission, invalid mode rejection, all supported participant counts, bot fill, pause/menu cover, reconnect, rematch and matching authoritative outcomes.
- Determinism: Node/Chromium/WebKit/Firefox hash equality for new sport scenarios including restore and participant takeover; representative replay timings.
- Browser: select each sport, solo/practice controls, actual four-athlete rendering, mode-specific assets/arena, score progression and online room/reload flow. Inspect screenshots, not only asset metadata.
- Run TypeScript, relevant game-boundary/purity checks, production client and server builds. Avoid rewriting unrelated dirty files.
- Record exact results and any remaining art/balance/human/WAN limitations. Automated tests do not establish fun or production hosting readiness.

## Ownership

- Simulation agent: shared sport/state contracts, both mode rules and bots, simulation tests.
- Network/UI agent: protocol, server rooms, online client, host selection/instructions and network tests.
- Presentation agent: generated weapon-free sources, atlas pipeline, animation, arena overlays, effects and presentation tests.
- Root: concrete plan, contract supervision, integrated tests, cross-runtime/browser review, correction routing and delivery documentation.
