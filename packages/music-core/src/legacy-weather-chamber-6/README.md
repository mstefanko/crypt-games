# Frozen weather-chamber-6 regeneration

These sources were copied from the working chamber composer and its runtime dependencies before the weather-song-1 implementation changed the current composer/catalogs. This is the read-only regeneration implementation for known session envelope version 1 recordings whose `composerVersion` is `weather-chamber-6`.

Keep runtime imports within this directory. The only imports from current music-core are type-only PerformanceNote imports, which disappear at runtime. Weather command simulation is frozen here as well as tonality, grammar, orchestration, intent, and bar constants. Changes to current weather/song semantics must not be backported here.

`weather-song.test.ts` pins a 64-bar command-model/composer trace (seed 617, cold front at tick 240, FNV-1a symbolic trace fingerprint `954bf90e`) and checks version routing against this implementation. Existing chamber composer and modal tests explicitly exercise these frozen sources. This is symbolic regeneration compatibility; PCM/rendering fidelity is separately versioned by the audio and palette implementation.
