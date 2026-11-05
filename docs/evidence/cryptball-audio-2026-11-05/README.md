# Original Cryptball audio listening samples

Generated with `node scripts/render-cryptball-audio.mjs` using the actual runtime score, patches, and renderer. No external samples or audio service. Stereo PCM16 at 22050 Hz; default game gain, no mastering or normalization.

Match: 32 bars / 144 BPM, eight-bar hook, answer, breakdown, return. Title: a complete four-bar loop. Overtime: same timeline with extra percussion/counterline, eligible immediately in game (up to 150ms scheduler lookahead).

Effects reel: 0s Charge; 2s Sidestep; 4s Focus; 6s Snap; 8s Flutter including separately triggered second burst; 10s Sting. Each includes an example of authoritative success at +1s. Then 12s body thud; 12.8s strike; 13.6s stone board; 14.4s metal post; 15.2s save; 16s pass; 16.8s goal. This reel deliberately triggers success for audition; game success only follows a legal contact event.

The manifest includes render hashes, peak/RMS, clipping count, and per-second RMS. Physical speaker/headphone and phone approval remains user playtesting.
