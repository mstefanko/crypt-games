# Hosting Crypt Games

## Recommended initial setup

Keep source in `mstefanko/crypt-games`, serve the browser build through GitHub Pages, and run one Node.js multiplayer service on Render or another host supporting long-lived WebSockets. Players open one game URL and share room links. Your laptop can be off. Start with one server instance in a region close to the players: rooms live in process memory, so randomly routing connections across multiple replicas is not supported by this deployment.

GitHub Pages alone supports solo play but cannot execute the multiplayer server. GitHub Actions builds and deploys code; it is not the persistent match server.

## Multiplayer service (Render example)

Create a Node web service connected to this repository, branch `main`:

- Build command: `npm ci && npm run build:cryptball:server`
- Start command: `npm start`
- Node version: 24
- `HOST=0.0.0.0`
- `PORT`: use the host-provided port
- `CRYPTBALL_ORIGINS=https://mstefanko.github.io` (origin only, without a path)
- Health check: `/healthz`

Use the host's HTTPS endpoint as `wss://YOUR-SERVICE.onrender.com` in the browser configuration below. The host terminates TLS. Keep one instance; room state is not persistent across process restarts. An optional private `CRYPTBALL_METRICS_TOKEN` enables authenticated metrics; never put it in browser variables. No secret is required just to play.

Choose an always-on instance for reliable invitations. Review the provider's current pricing and sleep policies before purchasing. This repository does not provision or subscribe to a hosting plan.

## GitHub Pages

The repository must be eligible for Pages under your GitHub plan. Public repositories support Pages on GitHub Free; private repositories require an eligible paid plan. Keeping the source private does not necessarily make the published game private.

1. In repository Settings → Pages, choose GitHub Actions as the source.
2. Add repository Actions variable `VITE_CRYPTBALL_SERVER` with your `wss://` service address.
3. Run the **Publish Crypt Games** workflow from `main`.
4. Open `https://mstefanko.github.io/crypt-games/`.

The workflow sets `CRYPTBALL_BASE_PATH=/crypt-games/`, builds the client, and uploads only the browser distribution. The normal local path remains `/games/cryptball/`. If the server variable is empty, solo play works but online play remains unconfigured. Client and server must be built from the same revision because matchmaking verifies a source-derived build identity. Redeploy both after gameplay/protocol changes.

## Verify before inviting players

Test the published HTTPS game from two separate devices/networks: create a private room, join using its link, ready both players, finish a match, rematch, and reload/reconnect. Check WSS and origin configuration when joining fails. Local automated tests do not establish internet latency or production capacity. Earlier network reports retain unresolved performance and WAN qualification work; the 25-room cap is not a production capacity guarantee.

## Official references

- https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
- https://render.com/docs/websocket
- https://render.com/docs/deploy-node-express-app
