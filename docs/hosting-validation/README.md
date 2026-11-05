# Standalone packaging validation — November 5, 2026

- Independent locked dependency installation passed.
- Browser and server production builds passed.
- GitHub Pages base-path build passed; generated entry references `/crypt-games/assets/`.
- Typecheck passed after explicitly including the shared asset-library dependency.
- Offline suite: 39 files, 386 tests passed.
- Real-socket service health/metrics/admission smoke passed.
- Broad networking suite did not pass: five socket cases and one receipts case reported failure before the run stopped making progress. The bounded run was terminated; this is not a complete suite result.
- Focused matchmaking smoke failed because two public joins received different room IDs. The same test failed in the original development workspace.
- Origin-bearing special checkpoint test failed in both standalone and original workspaces (expected special origin was absent).
- The initial sandbox run could not start sockets and was terminated in favor of the socket-enabled run. Its log contains the complete successful offline result.

No public server, TLS/WSS test, separate-device playtest, browser qualification, or production capacity qualification was completed. Preserve the current source; investigate these failures before public online launch. Historical reports are not evidence that this current snapshot passes.
