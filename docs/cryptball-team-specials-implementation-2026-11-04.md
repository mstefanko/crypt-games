# Team banners and specials

## Decision

Arena club flags follow authoritative `teamIds`, just like uniforms and HUD. Replace the eight colored foreground/side flag faces with registered cloth overlays, preserving the surrounding stone, perspective and depth order. Use newly generated blank pixel cloth and the existing six original mascot marks; independently generating every emblem would introduce inconsistent team identities. Rear architectural skull hangings remain neutral arena decoration. Cache assets and only change the selected pair when identities change, including lobby changes and rematches.

## Ability comparison

| Team | Recommended move | Other option considered | Why this choice |
| --- | --- | --- | --- |
| Rams | Charge: telegraphed, committed straight rush with ordinary single-check rules and recovery | Radial ground slam | Direction and recovery offer counterplay; radial stun would dominate a small court and have little Volley value. |
| Foxes | Sidestep: short steerable evasive acceleration, without a body check | False ball decoy | Feint through movement preserves readable ball identity; a fake ball would be frustrating at this scale. |
| Owls | Focus: brief improved movement during shot preparation | Reveal future ball flight | Preparation rewards positioning in all modes; prediction would duplicate Volley's landing cue and mislead when contacts intervene. |
| Gators | Snap: extended committed slide/dive with ordinary contact limits and longer recovery | Ball grab | A defensive lunge fits the animal without violating free-ball or Volley possession rules. |
| Bats | Flutter: two short steerable bursts separated by a slower gap | Teleport | Two beats allow a direction change while preserving swept collision and readable travel. |
| Hornets | Sting: prime one faster strike/pass windup and recovery, unchanged power and reach | Poison or repeated extra hits | A quick precise action fits all sports; damage has no existing meaning and extra hits would bypass Volley contact rules. |

Rams can pressure a lane or cross their own Volley half; Foxes dodge a defender or adjust under a descending ball; Owls reposition while charging a shot/attack; Gators intercept ground play or dig low Volley returns; Bats make a two-stage approach in any mode; Hornets release an accurate ground pass/shot or Volley set/attack earlier. None changes scoring, net clearance, ball collision size, maximum shot power, team contact allowance or same-player contact restrictions. Their value is situational rather than a universal damage multiplier.

## Resource and balance

One shared cooldown per team. The first opportunity arrives after 12 seconds of live play; a successful activation starts a 24-second recharge. A ready resource can be held indefinitely, cannot stack and cannot be farmed by passes or contacts. This permits roughly four activations within 90 live seconds if used immediately, fewer when held. Either teammate activates with B; the activating athlete receives the move. Stable authoritative arbitration handles simultaneous requests. Human-controlled sides reserve bot spending for full bot takeover; bots follow the same admission/cooldown rules.

Activation cannot erase an existing action, stagger or defensive recovery, and Volley serve setup blocks specials. Short anticipation tells precede advantages, and committed abilities expose recovery. Rejected requests do not consume charge. Scoring/restarts clear active effects but preserve cooldown; stoppages and offline pause do not recharge. Online menus continue authority play as before. Checkpoints preserve cooldown, activator, phase and progress; reconnect cannot replenish a spent move.

The initial numbers are playtest tuning, not proof of competitive equality. Validation must check legal contacts, bounded movement, mode restrictions, deterministic replay and resource lifecycle. Human playtesting should compare useful activations and possession/points shortly after use, adjusting individual duration/recovery before changing shot power.

## Presentation and implementation

Show both teams' special names, crest/color and countdown/progress near the score, with B/READY for the local side and clear ACTIVE/activator status. A single readiness cue accompanies recharge completion. Selection/help explains the actual move. Do not conflate this team resource with personal gold shot charge.

Reuse existing eight-direction athlete run/charge/slide/dive/strike/recovery poses wherever anatomy is already correct. Team-specific small crest/trail cues and readable anticipation communicate the special; they must remain below/behind athletes and keep the ball visible. Gators use the existing hands-first dive in Volley, feet-first slide on ground. Bats show two separated pulses, Owls a focus cue, Hornets a brief sting cue; reduced motion retains static phase information. Cosmetic state reconstructs from authoritative ticks instead of relying on receiving an event once.

Three GPT-6.1 Sol agents implement arena/art, authoritative mechanics/networking, and controls/HUD/presentation, with parent integration review and validation. Implementation constants and actual verification results are recorded in the delivery document.
