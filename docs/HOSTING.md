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
- `CRYPTBALL_GROUP_SECRET` should be a stable, randomly generated server secret. All deployments serving the same friends links must use the same value. Without one, the server creates a temporary signing key at boot and older group links expire on restart.

Use the host's HTTPS endpoint as `wss://YOUR-SERVICE.onrender.com` in the browser configuration below. The host terminates TLS. Keep one instance; room state is not persistent across process restarts. An optional private `CRYPTBALL_METRICS_TOKEN` enables authenticated metrics; never put it in browser variables. Keep the signing key and metrics token out of browser settings and invite URLs.

Choose an always-on instance for reliable invitations. Review the provider's current pricing and sleep policies before purchasing. This repository does not provision or subscribe to a hosting plan.

## GitHub Pages

The repository must be eligible for Pages under your GitHub plan. Public repositories support Pages on GitHub Free; private repositories require an eligible paid plan. Keeping the source private does not necessarily make the published game private.

1. In repository Settings → Pages, choose GitHub Actions as the source.
2. Add repository Actions variable `VITE_CRYPTBALL_SERVER` with your `wss://` service address.
3. Run the **Publish Crypt Games** workflow from `main`.
4. Open `https://mstefanko.github.io/crypt-games/`.

The workflow sets `CRYPTBALL_BASE_PATH=/crypt-games/`, builds the client, and uploads only the browser distribution. The normal local path remains `/games/cryptball/`. If the server variable is empty, solo play works but online play remains unconfigured. Client and server must be built from the same revision because matchmaking verifies a source-derived build identity. Redeploy both after gameplay/protocol changes.

## Friends lobby capacity and recovery

The service hosts one lightweight directory per active friends group. Five empty sport rows use no match simulations. Each court supports four players. Set `CRYPTBALL_FRIENDS_VIEWERS_PER_COURT` from 0 to 8 (default 8). Set it to 0 to release the shared lobby and manual starts on their own, or lower it to fit a measured bandwidth limit. At most 15 friends courts may use the 25 total simulation slots. Public matchmaking can use all available slots, including unused friends capacity. The directory itself has separate limits of 100 groups and 64 memberships per group. These are admission ceilings. Measure sustainable capacity on your host.

Each member can make 30 court requests per minute through their directory connection. The broader HTTP matchmaking limit defaults to 1,200 requests per minute per transport peer address and can be set with `CRYPTBALL_IP_ADMISSIONS_PER_MINUTE`. A reverse proxy can combine many visitors into one transport address. Set this ceiling for the proxy topology. The group limit still applies to individual members. Overload refuses new simulations. Keep routing traffic to the process so existing courts and the directory remain reachable. `/readyz` reflects draining and the authenticated metrics include `simulationOverloaded`.

When rolling out, release a matching static build and Node service. A group link with the same signing key reopens its directory after a restart. Running matches and queues live in server memory. Browser reconnection credentials are scoped to a tab and should never be logged. To roll back, deploy a matched previous pair and allow active games to drain first.

## Verify before inviting players

Test the published HTTPS game from two separate devices/networks. Open a friends link, start a court with two humans, watch from another browser, queue for the next match, and reload during play. Confirm legacy room links and public matchmaking still work. Check WSS and origin configuration when joining fails. Local automated tests do not establish internet latency or production capacity. Earlier network reports retain unresolved performance and WAN qualification work; the 25-room cap is not a production capacity guarantee.

## Official references

- https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
- https://render.com/docs/websocket
- https://render.com/docs/deploy-node-express-app
