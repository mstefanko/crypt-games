# Team specials — historical two-team proposal

Superseded by [the implemented six-team design](cryptball-team-specials-implementation-2026-11-04.md). The options below are retained as historical brainstorming; they are not the current game mechanics.

The current goal/charge fixes are separate from these proposed abilities. All timings, dimensions and meter rates below are initial playtest settings.

## Options

| Team | Option | Strength | Main cost |
| --- | --- | --- | --- |
| Rams | Stampede: each teammate earns one empowered straight dash | Both players participate independently, reinforces physical play, uses familiar dash input | Must cap checking and ball impulse to prevent stun chains |
| Rams | Horn Relay: a completed pass primes the receiver's next strike | Most explicitly cooperative, rewards passing | Relies on an attentive partner; interception can make a full meter feel wasted |
| Rams | Ground Slam: radial knockback around activator | Clear anticipation and strong fantasy | Broad area control is oppressive on a compact court and undermines positional defense |
| Fire | Cinder Gate: briefly create a small, telegraphed ball-only rebound surface | Changes passing/bank geometry; unique tactical identity; either teammate can exploit it | Needs precise placement preview and reliable anti-trap rules |
| Fire | Afterburn Shot: one accelerated fiery bank shot | Easy to understand and implement | Too similar to existing charged powered banks to justify a team-special slot |
| Fire | Flame Trail: dash leaves a persistent hazardous path | Visually dramatic and spatial | Clutter, contact ambiguity and movement punishment on a small arena |

Recommend **Rams = Stampede**, **Fire = Cinder Gate**. One emphasizes coordinated physical pressure, the other creates a temporary bank-shot opportunity. Neither takes movement control away from a teammate or requires simultaneous network inputs.

## Shared resource and input

One visible meter per team, beside its score/crest. Proposed capacity100; low passive income1/second while play is live, plus8 for a completed teammate pass (at most two credited passes in an uninterrupted team-possession sequence) and12 for a clean defensive interception. Start testing these values for roughly one or two opportunities per team per regulation match; do not claim that these rates produce that frequency until measured. No meter from goals, empty swings, ordinary own-team touches, or repeated hits on the same contact. A possession sequence ends on a deliberate opponent touch or restart; contested-touch farming still needs lab checks. Passive income pauses during stoppages. Ready charge may carry across goals; active effects do not.

Either teammate presses a single **team-special button** (proposed keyboard B, rebindable controller shoulder) to commit. No two-button chord and no simultaneous teammate confirmation. The UI tells both players READY and gives a short once-per-ready cue. Two same-tick requests produce one activation using an explicit stable ordering; only one meter deduction. The activator is shown beside the team's briefly pulsing crest. Keep ordinary shot charge and team meter visually different: small personal gold silhouette versus a team-colored HUD crest.

## Rams: Stampede

On activation, both field players receive one empowered dash token for a short shared window (start with3seconds). Players still decide when and where to use their normal dash button; no automatic teammate movement. Their next dash consumes their token and locks its direction as the ordinary committed dash already does. If already dashing, retain the token for the next eligible dash instead of changing the current action halfway through. Do not cancel ordinary recovery to admit it.

Visual: a short horn-shaped team-crest pulse, ivory/teal shoulder outline and a compact dust trail. After a brief readable lean/hoof-stomp anticipation (start with0.2seconds), the empowered dash has moderately longer travel and one stronger ball contact. Ball speed remains capped. Opponents can step aside, intercept the ball or block with a well-timed slide. Player contact can displace, but does not stack extra stun or repeated damage; each dash may affect each opponent once. No invulnerability and no guaranteed goal. Each player's token icon extinguishes on use; unused tokens expire visibly.

Implement as two checkpointed per-player tokens plus a shared expiry. Reuse the existing swept dash path, checked-target tracking and action-admission rules. Bots must explicitly understand when to spend their token; no separate rules or aim advantages for them.

## Fire: Cinder Gate

The activator places a short low flame arc a fixed distance ahead in their aim direction (starting values32world units ahead,24units wide). A floor preview shows the exact planned footprint. This fixed-distance placement works for mouse and stick/keyboard aiming without adding arbitrary client-supplied world coordinates. After a visible0.5second ember warning, the gate becomes a ball-only rebound surface for about2.5seconds. Players walk through it. It does not damage, stun or hide them. Only one gate per team may exist.

The gate uses ordinary visible reflection, adding no ball energy. Both teams can bank off it, making its geometry honest and providing counterplay. Fire's advantage is choosing the location and anticipating the bank; it should never silently allow friendly balls through while blocking enemy balls. The teammate can combine a pass or charged shot with it. Opponents can route around its short ends, use it themselves, or wait out its duration. It must not form a full-width wall or close a goal.

Visual: orange floor footprint, gathering embers, a low rising flame arc with bright endpoints, then collapse into ash. Keep the effect below athlete chest height and preserve the ball's unique white core. Generated eight-frame fire can supply flame motion, but the arc silhouette/endpoints need a dedicated asset. Its bright boundary must agree with its collision circles; decorative flame tongues are not extra reach.

Reject invalid placement before spending the meter: too close to a goal mouth, wall/post, existing gate or player-exclusion region needed to avoid an initial penetration. If the ball occupies the footprint at the activation tick, hold the gate non-solid until the ball exits, with a bounded timeout that fizzles it rather than ejecting/teleporting the ball. A static overlapping-circle chain can reuse the existing swept ball solver; repeated overlapping-circle contacts must resolve once per manifold and add no energy. Benchmark maximum-speed balls, posts, near-parallel grazes and contact-budget exhaustion before accepting it.

## Multiplayer contract

The authority owns meter, reservations, tokens, ability IDs, start/expiry ticks, quantized gate pose and collision-active state. Include all of them in complete checkpoints. Activation is an input edge with the existing command sequence/authority-tick handling; never infer it from wall-clock timing or animation frames. Define stable same-tick ordering and version the protocol/rules on release. No randomness is needed.

Clients can preview aim and optimistically show a pending HUD pulse, then reconcile against the authoritative checkpoint. Ability collision and impulse must replay exactly in prediction/rollback. FX derive from an ability ID and simulation tick so correction/reconnect does not duplicate a burst or reset expiry. Persistent gates/tokens reconstruct from state even if the original event was missed. A reconnect cannot recover a spent token or reset the meter. Disconnect/bot takeover retains the same team resource and actor token; bots follow the same input limits.

Required validation: meter-farming and duplicate-request cases; two requests on the same tick; max-speed sweep into both gate endpoints; ball initially overlapping a spawning gate; expiry during contact; charge/slide/dash interactions; goal/reset; inactive player and bot takeover; mid-effect checkpoint restore; complete cross-engine replay; full socket match. Then compare activation rate, goals immediately after specials, avoidable versus unavoidable contacts, and human readability. These are trial metrics, not automated definitions of fun.
