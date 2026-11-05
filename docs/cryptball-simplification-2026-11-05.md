# Crypt Games simplification — 2026-11-05

Implemented in `apps/cryptball` and `apps/cryptball-server`.

## Gameplay

Team specials are unavailable in all six activities. B and the special HUD are removed; retired special commands have no simulation effect. Cosmetic club identities retain their uniforms and banners. Dormant special state remains in the checkpoint schema for compatibility, but active specials are rejected.

Dodge holders previously targeted the same throwing line while friendly-body separation continually pushed them apart. Holders now occupy distinct lanes, and bots route around nearby teammates blocking their path. Existing Dodge invariants and the new two-holder regression pass. This addresses a concrete jitter cause; broader human playtesting may reveal other collision cases.

A missed Guardian attack could settle with its attack token intact. The token excluded players from collection, while a nearby player prevented the stuck-ball reset. Low-energy missed attacks now release the token and become collectible. A regression places a stopped attack beside a player and verifies collection. The carried-orb line and target label to the boss are removed.

## Multiplayer

The previous fallback connected to port 2567 on any website hostname, even though no public match service is provisioned. Hosted builds now require an explicit `VITE_CRYPTBALL_SERVER`; loopback development retains its port-2567 fallback. Network failures explain the missing service instead of presenting an unexplained interrupted match. Local startup is `npm run dev:cryptball:online`. Public deployment still needs a running HTTPS/WSS service with the website origin allowed in `CRYPTBALL_ORIGINS`.

Hosts choose the room activity before creation. Guardian creation is rejected by the server and its multiplayer buttons are disabled. All five competitive sports remain online. Players enter a name before joining; authoritative ownership maps white, shadowed labels onto the athlete they control. Two browser clients named Ada and Bea joined a private room, started with bots, and rendered their labels without page errors.

Shuffle is a playlist above the simulation, not a seventh ruleset. It changes after a full match, including a complete best-of-three Dodge match. The results button becomes Next activity, preserving the existing unanimous rematch flow. Server rotation uses a room-seeded traversal of all five competitive modes before repeating; local play cycles through the five activities. New lobby epochs announce mode changes before checkpoints; clients load the next sport's art before play. Guardian never enters the rotation.

## Presentation decisions

Crypt Games is the umbrella title. Existing activity names remain, with plain sport subtitles to make them understandable immediately. This avoids renaming every mode while removing ambiguity around Cryptcheck and Rift Volley. Rams, Foxes, Owls, Gators, Bats and Hornets remain cosmetic clubs and are assigned randomly instead of occupying the main menu.

The title screen prioritizes six large activity tiles plus a full-width Shuffle tile. Existing pixel-art banners provide matching crypt texture; no new generated art was needed for this pass. Future bespoke activity illustrations should be composed from the same arena camera, palette and athlete silhouettes, leaving titles as live text. Generate individual small vignettes, validate their silhouettes at native size, and keep nearest-neighbor scaling rather than generating text inside the art.

Confirmed scoring events trigger a 650 ms, seven-pixel scorer hop. Dodge round winners and the Guardian victory party hop together. Reduced motion disables displacement; simulation timing is unchanged.

## Validation

- Complete unit/simulation suite: 373 passing before the final added Dodge regression; the targeted Dodge suite then passed all 52 tests, including that regression.
- Network client suite: 36 passing, including name transmission and Shuffle epoch/mode adoption.
- Menu/keyboard browser suite: six passing, including 1280×800, 800×500, 640×480 and 390×844 layouts.
- Two rendered browser clients successfully played a local private Shuffle room.
- TypeScript check and production build passed.
- Evidence: `docs/evidence/cryptball-simplification-2026-11-05/`.

The public site was not deployed. Public network latency, mobile touch comfort, and longer human Dodge sessions remain outside this local verification.
