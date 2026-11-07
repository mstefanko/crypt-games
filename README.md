# Crypt Games

Browser sports arenas with solo play and authoritative online multiplayer. This standalone repository includes the current game, server, artwork sources, runtime assets, tests, game documentation, and the shared toolkit packages it uses.

## Run locally

Use Node.js 24 or newer.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:4223/games/cryptball/. The command starts both the browser game and multiplayer service. Choose **Play online → Play with friends**, enter your name and copy the lobby link. Group members can start any of five sports with two players, open another court, watch, or queue for the next match. Guardian is solo only.

```sh
npm run build
npm test
npm run typecheck
npm run test:cryptball:online-browser
```

Browser tests require `npx playwright install chromium` and free test ports. Existing generated artwork is included; optional asset regeneration requires Python/Pillow and the source paths described in the art recipes.

## Match controls

On a laptop, use WASD or the arrows to move and hold and release J or left-click for the primary action. Right-click passes in Cryptkick possession and tackles when defending. K still passes and Shift still defends. Each sport lists its actions under **Settings → Controls**.

On a touchscreen, drag on the left half to move. Tap, hold, or flick on the right half to act, even while standing still. Swap sides in Settings. In hockey, a quick tap passes with the puck or pokes without it. A directional flick now body-checks. In Dodge, touching down empty-handed starts a catch immediately.

Tap or click the scoreboard to pause and reach Settings. Escape also opens the menu. Phones offer a closer landscape frame and a **Continue in portrait** option. In an online match the computer covers your player until you return.

## Hosting

GitHub stores the complete source. GitHub Pages can host the browser game, but cannot run its Node.js multiplayer service. For online play without leaving your computer on, deploy the service to a cloud host supporting persistent WebSockets, then configure the browser build to connect to it.

See [the deployment guide](docs/HOSTING.md). No public multiplayer server has been provisioned. Offline modes work without one; online modes explain that an endpoint must be configured.

The shared libraries retain their original `@onepage` package names. This snapshot was extracted from the development workspace with its current uncommitted Crypt Games changes; [source metadata](docs/source-snapshot.json) records the source revision. Historical implementation reports describe the state at their respective dates, not necessarily the current release.

## Current validation status

See the [friends lobby implementation and verification](docs/crypt-games-friends-lobby-implementation-plan-2026-11-06.md) for the current multiplayer checks. The [packaging validation](docs/hosting-validation/README.md) records the earlier source extraction. Hosting and two-device playtesting are covered in the [deployment guide](docs/HOSTING.md).
