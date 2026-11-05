# Crypt Games menu artwork v2

Generated on 2026-11-05 with the built-in ImageGen tool. The eight original PNGs and exact prompt set are preserved in this directory. No source-game imagery was copied into these assets.

Art direction combines a carved ivory/gold title with violet depth and teal jewels, seven distinct sports-action vignettes, and consistent purple crypt masonry, gold-armored chibi athletes, teal/coral uniforms, and torch lighting. Readable live HTML nameplates sit outside the generated artwork. Selected frames use warm gold plus a teal corner pointer; keyboard focus remains independently visible.

## Research references

- [Nintendo's original Super Mario Kart manual](https://www.nintendo.co.jp/clvs/manuals/common/pdf/CLV-P-SAAFE.pdf): staged selection hierarchy.
- [Super Mario Kart character selection screenshot](https://www.toomuchgaming.net/blog-news/2017/3/growing-up-with-mario-kart-part-1-the-origins-and-success-of-the-legendary-kart-racer): framed illustrated roster, used as a layout reference rather than a claim about its mode menu.
- [Super Bomberman screenshot gallery](https://www.mobygames.com/game/6749/super-bomberman/screenshots/): playful multiplayer presentation and separation of title, setup, and stage selection.
- [Super Castlevania IV title screens](https://www.vgmuseum.com/mrp/cv4/game-media.htm): gothic masonry and warm title contrast.

The result is original SNES-inspired artwork, not an imitation of an existing game's logo or characters.

## Assets

- `logo.png`: transparent CRYPT GAMES emblem, friendly skull, stone letters, brass and teal accents.
- `cryptball.png`: bat striking a cyan orb.
- `cryptkick.png`: soccer kick.
- `rift-volley.png`: spike across a spectral net.
- `cryptcheck.png`: skating, hockey stick, and puck.
- `crypt-dodge.png`: evasive dodge under an orange ball.
- `crypt-guardian.png`: orb-wielding athlete facing a stone guardian.
- `shuffle.png`: five sports' equipment orbiting a teal portal.

Generated lettering is limited to the brand logo. Activity names, subtitles, actions, and accessibility names remain live DOM text. These are static menu illustrations; gameplay atlases are unchanged.

## Runtime packaging

Runtime assets are WebP encoded with `cwebp -q 92 -m 6 -sharp_yuv -alpha_q 100 -exact`. No resizing, drawing, compositing, or frame cropping is applied to generated sources. Logo alpha is preserved. Original PNGs remain here; WebP delivery reduces transfer size while DOM/CSS controls layout. `manifest.json` records source/runtime hashes and byte counts, and `prompts.json` records the exact built-in generation prompts.

## Integration and verification

Implemented by GPT-6.1 Sol agents, with separate research, frontend implementation, and independent review. The title screen uses six equal cards (three columns on desktop, two on portrait phones), followed by a full-width Shuffle banner. All seven cards use the same title-bar treatment. Artwork fills its frame with intentional cropping rather than letterboxing, following the updated user preference. Small constrained windows scroll without hiding art or overlapping actions. Screen-reader heading text, keyboard focus, pressed selection state, Guardian's solo-only availability, and existing mode/room behavior are retained. The main actions are Single player and Play online; the online submenu separates public matchmaking (Find a match) from private rooms (Play with friends). The redundant descriptive paragraph has been removed.

Eight menu browser tests pass, covering the four existing viewports, 844×390 and 320×568 constrained scrolling, decoded unique assets, keyboard selection, Guardian restrictions, and mobile practice. Independent visual review found no outstanding actionable issues after fixes. TypeScript and the production build pass. Final integrated screenshots are in `docs/evidence/cryptball-menu-art-2026-11-05/`.
