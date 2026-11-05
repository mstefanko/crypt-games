# Dodgeball duels and two-ally Guardian

Implemented November 5, 2026. Existing unrelated workspace changes were preserved. No commit or public deployment was performed.

## Dodgeball

- Ordinary ball outlines are faint. Powered flight has a warm tint, gold outline and trail; held-ball power feedback reflects the current charge/assist rather than the previous throw.
- Fully charged and pass-empowered throws require a standing catch during elapsed ticks 4–6 (three ticks / 50 ms). Diving cannot catch these shots; normal catches retain their existing window.
- One-versus-one still retires the spare dead ball. Bots commit to full charge on two of every three duel throw identities and mix in quicker throws. They no longer attempt powered dive catches.
- Possession uses a small shrinking arc at the rendered ball/hand socket, turning brighter near expiry. An explicit path start prevents the arc from drawing a connecting line from previous UI geometry. The overhead timer and holder floor ring were removed.

## Guardian

Two allied athletes replace the four-athlete party: one human plus one bot, or two humans. Simulation creation, participant validation, checkpoints, room capacity, lobby display, HUD cards and labels agree. Two ready humans fill the room and start automatically.

The old hurt volume was centered twelve units in front of the boss with a 24-unit scaled radius. Impacts then moved the ball to a fixed return point, and hit events inherited the thrower's location. The hurt volume is now centered on the boss with a 17-unit scaled radius; aiming and bot line checks use that same center. Events carry swept contact coordinates, and returns begin just outside that contact with an outward direction. Impacts render there. Damage flashes the boss and plays a heavier hit; blocks use a smaller blue impact and metallic sound without a damage flash.

Boss health remains 300. Projectiles increase from 165 to 195 units/second; hook reach from 146 to 185 and width from 5 to 9; sweep reach from 100 to 125; slam radius from 24 to 32. Most recovery windows and the between-attack pause are shorter. Ranged/hook commitment leaves twenty ticks before release; maul commitment leaves twenty-four. Physical tells remain visible and future floor previews remain practice-only.

Checkpoint version 16 and protocol 14 reject incompatible older sessions. Client and server must refresh together.

## Validation and balance

- 392 simulation tests pass, including exact catch-window boundaries, powered dive rejection, duel charge behavior, two-player ownership and swept impact/continuous return assertions.
- 28 browser tests pass; six final mode-specific browser checks also pass after the final visual/label edits. Final Guardian and Dodge screenshots were inspected.
- Both modes pass real browser invitation/start/reload/reconnect scenarios. Fourteen targeted network/complete-match authority checks pass; the complete nine-test new-mode network file also passed.
- TypeScript and game boundaries pass. Simulation purity passes with its existing 186-diagnostic baseline unchanged.
- Complete-match/takeover replay hashes match Node in Chromium, WebKit and Firefox (three tests passed, with existing browser performance assertions unchanged).

The final nine-seed, two-bot diagnostic produced two victories (both cannon) and seven defeats. Hook and maul were substantially harder for the existing bots; this is not proof of human balance. Raw outcomes and durations are in [guardian-bot-sample.json](evidence/cryptball-duels-2026-11-05/guardian-bot-sample.json). Human balance testing is still needed, especially maul escape timing and the 50 ms powered catch window.

The previously reported 4 ms replay budget gap was not optimized or rebenchmarked in this pass; passing deterministic replay checks does not resolve that release qualification.
