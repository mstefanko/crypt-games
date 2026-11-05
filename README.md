# Crypt Games

Browser sports arenas with solo play and authoritative online multiplayer. This standalone repository includes the current game, server, artwork sources, runtime assets, tests, game documentation, and the shared toolkit packages it uses.

## Run locally

Use Node.js 24 or newer.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:4223/games/cryptball/. The command starts both the browser game and multiplayer service. Competitive online matches require at least two ready humans. Guardian is solo only.

```sh
npm run build
npm test
npm run typecheck
npm run test:cryptball:online-browser
```

Browser tests require `npx playwright install chromium` and free test ports. Existing generated artwork is included; optional asset regeneration requires Python/Pillow and the source paths described in the art recipes.

## Hosting

GitHub stores the complete source. GitHub Pages can host the browser game, but cannot run its Node.js multiplayer service. For online play without leaving your computer on, deploy the service to a cloud host supporting persistent WebSockets, then configure the browser build to connect to it.

See [the deployment guide](docs/HOSTING.md). No public multiplayer server has been provisioned. Offline modes work without one; online modes explain that an endpoint must be configured.

The shared libraries retain their original `@onepage` package names. This snapshot was extracted from the development workspace with its current uncommitted Crypt Games changes; [source metadata](docs/source-snapshot.json) records the source revision. Historical implementation reports describe the state at their respective dates, not necessarily the current release.

## Current validation status

The standalone browser/server builds, typecheck, and 386 offline tests pass. Multiplayer validation currently has failures, including matchmaking and a special-action checkpoint expectation reproduced in the original workspace. Public online launch needs those failures investigated and a real WSS/two-device playtest. See [packaging validation](docs/hosting-validation/README.md).
