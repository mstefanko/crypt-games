# Crypt Dodge and Crypt Guardian delivery — November 5, 2026

Historical first implementation report. See [pressure and teamplay delivery](cryptball-pressure-and-teamplay-delivery-2026-11-05.md) for the current two-ball rules, Guardian overhaul, protocol versions, validation and performance limitations.

The working tree implements **Crypt Dodge** (`crypt-dodge`) and **Crypt Guardian** (`crypt-guardian`) alongside the four existing sports. Both use the existing four-athlete session, controls, online authority and renderer. Wire protocol is **12** and simulation checkpoint is **14**; client and server must refresh together. No commit, public deployment, or paid hosting was performed.

The [implementation plan](cryptball-dodgeball-arena-plan-2026-11-05.md) remains the source for the intended rules and human tuning gates. This report describes the implemented prototype and its verified reuse boundaries.

## Implemented play

**Crypt Dodge** is 2v2 with three lives per athlete, one ball and best-of-three rounds. Closed court boundaries and player-only half restrictions apply during movement, dashes, dives and checkpoint restores. A press opens a timed standing catch; a committed hands-first dive has its own catch window and recovery. Holding through a catch cannot begin a throw without release and a fresh press. Throws have visible preparation, quick/charged speeds, a shallow arc, and one damage claim; swept contacts resolve the earliest world, catch or body contact with stable ties. Catches gain possession. Friendly passes never damage and give the receiver a shorter preparation window.

Dodge serializes held, friendly-pass, hostile-flight, dead-loose and reset states. Floor/wall contacts end hostile status. Elimination leaves a nonblocking spectator. Hit immunity and collection lockout are separate. The six-second team possession deadline survives passes, same-side pickups and same-side stuck-ball recovery. Rounds allow released throws to settle at the clock, compare survivors and lives, then use bounded sudden death; a still-tied round is replayed with reversed opening possession.

**Crypt Guardian** is four allied athletes versus one stationary south-facing guardian at the north wall. Vacant seats use bots. Players retain Cryptball movement, bat strikes, charge, passes, dash and defensive orb deflection; direct melee, friendly checks and friendly ball damage do not damage the party or boss. Only a new eligible orb-strike token can damage the guardian, once. Quick/fully charged damage is 8/12, a received ally pass adds 4 once, and recovery multiplies the result by 1.5 with integer floor. Return lanes and a warned stuck-orb reset preserve exactly one reachable orb.

Each athlete has five health. Attacks deal one health, claim each athlete at most once, and respect damage immunity. A first down leaves an invulnerable, nonblocking soul. An ally holds pass for 90 continuous ticks within range and line of sight to revive at two health with protection; damage, release or range loss cancels progress. A second down eliminates that athlete. All-party defeat and the 180-second limit lose the encounter; boss defeat wins an exactly simultaneous mutual finish. The boss escalates after 120 seconds and introduces the second family pattern at half health after a safe transition.

Resolved descriptors choose cannon, hook or maul; one of three palettes; size 90/100/110%; a name; and a legal layout. Cannon and hook use two destructible pillars; maul uses the open arena. Each family has two authored attacks plus an eligible proximity slam. Tells, lock points, active geometry, hit receipts, projectile endpoints and recovery are saved together. Hook pulls sweep against world, body and cover before committing their bounded displacement. Floor disks retain rescue clearance and separated double-slam footprints. Size, palette and weapon yield 27 appearance combinations before names; they are three authored mechanical families.

Solo retry keeps the encounter seed; New Guardian selects another. Practice exposes family selection, immortal athletes and restart separately from scored play. Selecting a practice family maps the seed into that family's legal descriptor/layout before restarting, so cover never appears beneath active players. Mascot specials are disabled in both new modes and hidden from their controls.

## Engine reuse and deliberate boundaries

The modes reuse the engine's reviewed fixed-flight integration, quantized circle sweeps, action timelines/hit claims, `DamageOwner`, and named `DeterministicRandom` streams. Boss and athlete health use `DamageOwner`; revival explicitly reconstructs a validated live body because `repair` does not resurrect zero health. Action origins survive buffered releases and hit tokens. Cosmetic descriptor selection does not consume Guardian's serialized gameplay stream.

Guardian adapts the circle kernel's existing limits: a combined boss/contact radius is split across two supported circles, and long warning rays are segmented into supported displacements. The adapter keeps the engine's deterministic contact clock and tie ordering. Circle/wall correction resolves their actual intersection near the north wall instead of projecting into the boss after a world clamp.

`ProjectileOwnerV1` was investigated but is **not used at runtime** for these modes. Its end-position boundary callback cannot order an earlier world/cover impact against a moving-athlete impact, and its complete module includes floating-root/homing paths outside this simulation's purity policy. Guardian therefore owns a bounded integer projectile lifecycle while using engine sweeps for contacts: at most three shots, at most 180 ticks, earliest world/cover/player contact, and serialized locked endpoints. The final segment reaches the same endpoint shown by the warning, including the pillar contact that consumes cover health. This is a documented reuse boundary, not a claim that the generic projectile primitive supplies those semantics. No purity exception or diagnostic baseline was added for it. The pure `DamageOwner` public import was explicitly registered for auditing.

The no-immediate-repeat rule has one necessary first-phase exception: when only the first family pattern is unlocked and no athlete has lingered near enough to make proximity slam eligible, the sole legal family pattern may repeat. Once another legal pattern exists, selection excludes the immediately previous pattern. This avoids firing fake proximity attacks at an empty floor to satisfy a selection invariant. Target selection still avoids a third consecutive lock on the same athlete when another is available.

## Multiplayer and presentation

Both modes preserve existing participant IDs, reserved seats, ordered command admission, action origins, takeover and reconnect behavior. Cooperative allegiance is separate from legacy cosmetic club slots. Guardian can manually start with one ready human and three bots; competitive online modes require at least two ready humans. Four ready humans still auto-start. A room-derived Guardian seed survives rematches. The shared lobby countdown preserves the new modes' subsequent opening possession/wake phase.

Guardian's held pass is carried through scheduled network slots and explicitly released or safely cancelled when a release expires. Dodge and Guardian dives are input edges. Checkpoints validate complete mode state and retain the existing 16 KiB wire cap and bounded object/array limits. Displayed lives, health, rescue state and terminal results come from authority; movement and eligible action tells can remain predicted, and contact audio comes from authoritative events. Touch targeting uses current controller ownership rather than stale original lobby seats.

The installed [art package](../apps/cryptball/art-src/new-modes-v1/README.md) uses all 96 selected source frames and packs **448 runtime frames on two nearest-sampled pages**. It provides eight-direction catch/carry/throw/pass/recoil poses, six athlete material variants, three guardian palettes, separate weapons, pillars/rubble, orb poses, bolts/chains, impact and soul markers. Authored hand, guardian weapon/crown and weapon grip sockets survive trimming. Existing weapon-free locomotion and hands-first dives are reused; Guardian bat strikes retain the established Cryptball art. Attack drawings use saved simulation disks, lanes and arcs. Cover is depth-sorted, HUD pips remain visible in fixed roster cards, and reduced-motion behavior retains warnings and status symbols. Synthesized catch, hit, down/revive, cover and family warning cues use the existing bounded audio owner.

Runtime atlas coverage and sockets have structural checks and native/3× review artifacts. The development visual fixture selects seeded appearances and actual locked shapes, including explicit defeat/revive review states; these constructed states are visual evidence, not proof of gameplay success. Source E/SE similarity and emblem variation remain. The generated art consists of discrete key poses rather than hand-cleaned inbetweens.

## Dodge bot tuning evidence

The [twelve-seed bot sample](evidence/cryptball-new-modes-2026-11-05/dodge-bot-tuning.json) identified mirrored reaction-slot asymmetry, insufficient seed variation and repeated defensive attempts on one throw. Bot responses now derive from original match seed, throw ID and side-local athlete slot; reflected sides preserve the response policy and reverse aim error. Each throw permits one catch attempt, with a 55% decision probability, 10–19 tick reaction delay and ±5 heading-step aim error. No catch windows, lives, damage or ball speeds changed for this tuning.

All twelve sampled matches completed. The sample recorded **532 catches from 1,064 throws (50.0%)**, with side wins **5–7**. The earlier four-seed diagnostic recorded 588/666 catches (88.3%) and wins 4–0; these are finite regression samples, not a population estimate or evidence of human balance. Round pace and Guardian encounter quality still require human sessions.

## Validation

Three GPT-6.1 Sol agents implemented simulation/shared contracts, Guardian mechanics, and presentation/art integration. The parent integrated authority/protocol changes, supervised cross-reviews, inspected screenshots, and ran integration checks. Review fixes include swept hook pulls, boss/world collision correction, locked projectile endpoints, renderer visibility, authoritative resources, current touch ownership, and prediction-only suppression of automatic down/out switching. Explicit manual switching and server automatic switching retain their behavior.

| Check | Result |
| --- | --- |
| `npm run test:cryptball` | 349 tests in 35 files pass on final source |
| `npm run test:cryptball:network` | 218 pass, 2 skipped; final ownership/display/scheduler/new-mode rerun adds 22 passing focused checks |
| `npm run test:cryptball:browser` | Full 26-test run passes; final new-mode/menu rerun passes 9 tests |
| `npm run test:cryptball:online-browser` | All 10 multiplayer scenarios pass; both new-mode reconnect scenarios pass again after ownership fix |
| `npm run test:cryptball:determinism` | 6 tests compare Node with Chromium, WebKit and Firefox, including complete matches and takeover hashes |
| Typecheck, client/server builds | Pass; client rebuilt with default settings after online test environment |
| Purity, boundaries, discovery | Pass; existing 186-diagnostic purity baseline retained without increase |
| Replay benchmark | New modes pass every tested horizon; whole-suite budget still fails for two existing modes, detailed below |

[Logs, benchmark JSON and screenshots](evidence/cryptball-new-modes-2026-11-05/) preserve the command evidence. The new-mode browser checks exercise real keyboard/held-pass input, mobile multitouch catch, practice family/immortality settings and atlas loading. Focused authority tests cover revive release/expiry and downed reconnect. Ownership regressions cover actual Guardian down, Dodge elimination, unchanged authority switching and manual Q.

The isolated replay benchmark measures decode/restore, simulation replay and event intake on this development host, excluding renderer and browser adapter costs. At 32 ticks, Dodge p95 is **0.495 ms** and Guardian **1.034 ms**, below the unchanged 4 ms budget; all their 12/20/24/32-tick samples pass. Original Cryptball records **4.515 ms** and Hockey **4.882 ms** at 32 ticks, so the overall benchmark correctly fails. This known broader qualification gap remains open; no threshold was weakened.

The existing local preview serves the rebuilt client at `http://127.0.0.1:4224/games/cryptball/`. Choose Crypt Dodge or Crypt Guardian, then Solo match or Practice. The build identity is `cryptball-v1-5c2b1d6f2c0631b19a0aa353`; multiplayer hosting needs its matching rebuilt server.

## Remaining qualification

Human novice/mixed/experienced sessions, physical-phone controls, orb engagement across all four Guardian athletes, delayed-link human play and the plan's catch/dive/revive balance targets have not been completed. Automated match completion and source/atlas coverage do not establish fun or readable reactions for people.

Deployment-like HTTPS/WSS, separate-machine WAN testing, sustained hosting capacity and target-device performance qualification remain open. Nothing here resolves the separately documented failed 4 ms replay release gate or establishes a new performance guarantee. The existing 60 Hz simulation and correctness assertions were retained. This delivery is a playable implementation for further testing, not staging or public-release approval.
