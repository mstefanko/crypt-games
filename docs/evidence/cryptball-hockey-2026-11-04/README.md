# Hockey integration evidence

- `legacy-baseline.json`, `legacy-current.json`, `legacy-comparison.json`: independent full bot and mixed-input replay comparison for all three original sports. Baseline captured before this implementation's simulation changes. Payload hashes include state/RNG/events, excluding added hockey null and outer schema version.
- `simulation-validation.json`: nine completed hockey seed runs, checkpoint restore counts and targeted test assertions.
- `determinism-{chromium,webkit,firefox}.json`: Node/browser checkpoint parity, complete-match/special/takeover scenarios and measured 12-tick replay costs.
- `visuals/contacts.json`: actual authoritative contact metadata for eight facings, three actions, and normal/reduced-motion presentation.
- `visuals/*.png`: actual Pixi renderer at native 640×400; debug captures use 2× display scaling. These are validated checkpoint + real command + emitted event fixtures, not concept art.

See the [delivery report](../../cryptball-hockey-delivery-2026-11-04.md) for acceptance limits and final test counts. Generated source provenance and extraction/atlas QA are in `apps/cryptball/art-src/hockey-v1/` at the repository root.
