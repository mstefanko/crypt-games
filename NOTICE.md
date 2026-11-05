# Attribution and content boundaries

The root MIT license applies to new original framework code and documentation. Third-party code and content retain their own notices and terms. The current static composer bundles the pinned production dependencies recorded in package-lock.json. The build generates THIRD_PARTY_NOTICES.txt into the static distribution with their complete license texts. Downloaded player HTML embeds the licenses for its smaller runtime dependency set. BeepBox is a development comparison dependency, not part of the distributed composer/player.

The `archive/2026-10-16-pre-consolidation` directory preserves pre-existing documents, including supplied review reports, unchanged for research provenance. Their inclusion does not relicense third-party material or claims. The archived hash manifest is checked by `npm run check`.

The Terminator game remains an external reference in its own repository. Its film characters, artwork and musical material are not starter assets for this project. User-created/imported assets require per-asset author, source and license metadata; the framework license is not a license to those assets.

The six starter melodies, arrangement fixtures, synthesized patch recipes and Lantern Courier preview are original material created for this implementation and released under the root MIT license. See [original asset provenance](docs/10-original-assets.md). Imported user music retains its own rights; import never grants a redistribution license.

The optional `import:terminator` adapter copies a user-supplied Terminator single-file game and derives editable score data into ignored `apps/composer/public/local-games/terminator/`. This local output includes the source game's film-related artwork and musical material, is not covered by this project's MIT license, and must not be committed or published as part of the framework. The importer and adapter implementation are original framework code. The public composer displays import instructions when no local source is available.

First Light (game runtime M1) uses original placeholder pixel sprites, terrain and hand-authored bitmap glyphs in `packages/game-runtime/src/art.ts`, under the root MIT license. PixiJS and its dependencies retain their own licenses in the pinned package distribution. No film, personal-library or generated third-party artwork is included in this fixture.

Beacon Return's original `beacon-strike` decoded audio sample is authored for this repository (October 21, 2026) and released under the root MIT license. Its frozen 120 ms mono PCM16 WAV is embedded in `packages/game-runtime/src/presentation/exploration-sample.ts`; the source preserves the waveform recipe and SHA-256. It contains no recording or third-party sample. See [selected sample provenance and limits](docs/158-sample-playback.md).

## Optional P4 Salvage Rig backend

The separately loaded `@dimforge/rapier2d-deterministic` 0.21.0 JavaScript/WASM
artifact is from the Rapier project and contributors, licensed under Apache
License 2.0. The optional export includes the upstream,
unmodified license as `RAPIER-LICENSE.txt` and exact binary/JS provenance in
`rapier-artifact-manifest.json`. The owned Vite bridge adapts loading of the
unmodified package bytes; it does not modify the WASM binary. See
`docs/p4-backend-qualification.md` for identity and the remaining acceptance gates.
