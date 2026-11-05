# Dodgeball and Guardian: pressure and teamplay

User-authorized implementation plan, November 5, 2026. This supersedes the single-ball and stickball combat decisions in the original new-modes plan. Values are initial tuning hypotheses; automated tests cannot establish human enjoyment.

## Dodgeball

Two balls begin loose, symmetrically placed just inside the legal inner boundary of each half, offset along the center. Athletes begin behind them. Countdown prohibits collection and attacks. No player crosses center; each opening ball is reachable by its corresponding side. A neutral shared center pickup is deliberately avoided because it conflicts with the current separation strip and introduces contentious ownership without improving the core loop.

Each ball has a stable identity, independent physics, possession clock and attack identity. One ball per athlete. Friendly passes auto-receive only into empty hands; passes never damage. A holder cannot catch a second ball. Diving while holding drops the held ball. Failed catches retain movement but incur recovery; a successful catch consumes the catch attempt. Preserve one life per hostile hit and existing immunity against simultaneous life loss. Resolve contacts deterministically, preserving earliest-impact ordering within each ball.

Initial quick/full speeds: 210/350 units per second. Ordinary standing catch active duration: 9 ticks; powered precision window: central 6 ticks. Failed recovery: 24 ticks. Receive a friendly pass, then release within 48 ticks to produce full-power speed without a charge requirement. No stacking speed or multi-life damage. Power must be visibly and audibly distinct. Pass chains do not reset possession deadlines.

Bots consider both balls, occupied teammates, imminent threats and imperfect catch reactions. In one-versus-one, retire one ball only when it becomes dead; never remove a hostile shot midflight. Reset both balls at the next round. Preserve three lives, restricted halves, best-of-three and bounded round handling.

## Guardian

Use carry, charge/release, automatic friendly reception and teammate passing instead of striking a moving loose orb. Movement and defensive actions remain familiar. A forgiving directional aim cone assists shots toward the boss; lock trajectory on release, preserve cover collision and offer manual aim. Highlight selected target and blocked lanes. A friendly pass gives a short empowered follow-up opportunity.

Build the controls with one ball, then use two independently tracked balls for four-player participation. No player carries two. Ball recovery must return play to reachable areas; downing drops possession and restoring/reconnecting never duplicates it.

Boss defense is deterministic and visible: directional guard with limited tracking, attack commitment exposing an angle, and recovery vulnerability. Ordinary guarded shots rebound safely. Powered combinations pressure a bounded guard meter and create a timed stagger. No random block chance or unavoidable instant defense rotation. Occasional hostile deflection has an explicit tell, one damage claim, and an empty-handed catch/evade response. Preserve seed reproducibility and all three authored weapon families.

Normal play removes geometric future attack previews and instructional attack prompts. Practice retains overlays. Physical cannon aim, hook windup, and visible descending/traveling slam effects communicate actual threats. Removing the slam circle requires a replacement physical cue before damage. Targets lock early enough to permit escape; no hidden last-instant tracking. Keep health, cover, cooperative revives and practice controls. Input priority must prevent pass/revive ambiguity, especially while carrying.

Advance locomotion animation by actual traveled distance, including collision-constrained movement. Use weapon-free running/carry/throw poses consistently across directions; charge and release art must align with simulation events.

## Integration and acceptance

Retain authoritative per-ball state in checkpoints and validate identities, ownership, deadlines and bounded arrays. Update protocol/checkpoint versions together. Prediction, rendering, bot takeover and reconnect must all see both balls. Authoritative hit/catch/guard sounds must not duplicate on replay. Preserve legacy sport behavior.

Sequence: mode rules and focused tests; shared rendering/input/network integration; cross-review; unit/network/type/build checks; browser controls and visual inspection; cross-engine determinism and reconnect checks. Test simultaneous shots, occupied-hand catches, opening countdown, pass deadlines, 1v1 retirement, boss guard sides, deflection ownership and revival interruption. Keep performance thresholds intact and disclose preexisting failures separately.

Human tuning follows implementation: catch rates by shot type, time between life losses, useful pass frequency, boss misses versus blocks, idle time per player, and learning over repeat attempts. Initial targets: 45–75 second Dodge rounds and 90–150 second Guardian fights. Do not increase boss health to compensate for unreliable aiming or inactive players.
