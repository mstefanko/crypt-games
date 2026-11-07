# Friends lobby implementation and acceptance plan

Reviewed November 6, 2026 against the Crypt Games source at db8983f. The build sequence delivers the directory, manual starts, watching and next-match seating together for human playtesting. Automated checks can run between those steps.

## What players do

1. Choose **Play with friends**, enter a name, and land in a new group. Copy the lobby link and post it in Slack. Someone opening the link enters their own name to reach the same directory. Opening a link preview never claims a seat.
2. Pick Cryptball, Cryptkick, Rift Volley, Cryptcheck or Crypt Dodge. See who needs one more player, who is playing, and how many people are watching. A sport can contain several independent courts. An empty sport costs no simulation time. Guardian stays solo.
3. Joining a waiting court takes a seat. Either of two connected players can choose **Start**. A third or fourth arrival can join before countdown. Every start is deliberate, including a full four-person game. Computers fill the other slots.
4. Open the directory from a court to see the rest of the group. Explicitly switching courts releases the previous position. The group survives its creator leaving. Names are display labels. Duplicate names within a group receive a numeric suffix, such as Mike #2. Membership and seat ownership use separate server identities. There is no host moderation or kick control in this friends release.
5. Join a running game as a watcher, with the option to choose **Play next**. A queued person watches the rest of the current match even when a player leaves. A disconnected player gets their existing 15-second grace and bot coverage. An intentional departure releases the reservation.
6. At results, seated players choose **Play again** to request another seat. After ten seconds, connected queued spectators get first choice in FIFO order. Returning opt-ins fill remaining seats. A spectator never votes on the outcome of the current match. In the new waiting court a seated player starts when two are present.

[Phone lobby](evidence/friends-lobby-2026-11-06/phone.png) · [Two-player waiting court](evidence/friends-lobby-2026-11-06/waiting-court.png)

## What the code review established

| Baseline behavior | Consequence for implementation |
| --- | --- |
| Each Colyseus court runs its own 60 Hz simulation and sends full checkpoints roughly 20 times per second. A historical local smoke ran 25 four-player courts for six measured seconds. | Independent games are routine. Measure actual player/viewer mixes and duration separately. |
| Room transport capacity equals athlete capacity. join() accepts only waiting rooms. The pump locks countdown, playing and results. start has no caller check. | Separate athlete and viewer limits, admit watchers in active phases and authorize seat-only operations server-side. |
| ready() starts when all four are ready. start() also requires everyone present to be ready. selectTeam() clears readiness. | Friends use a manual, two-connected-player start. Team changes cannot block it. Preserve the existing public-ready path. |
| All rooms previously used the same 25 slots. The HTTP code in main.ts also expressed a 60-per-IP/minute limit and a blanket overload rejection. | Budget actual simulations separately from directories, preserve public room headroom, keep groups available during simulation overload, and test the effective HTTP route. |
| Colyseus 0.18 dispatches recognized matchmaking requests before Express. HTTP middleware in the Express fallback cannot enforce that limit on the SDK route. Twenty people making two calls each would use 40 requests; switches and retries add traffic. | Apply a broad unauthenticated limit at a reachable boundary and limit court requests by server-issued group membership. Verify with real requests on one IP. |
| During live play remove() deletes the peer but leaves its simulation controller inactive. setParticipants() replaces controllers, clears pending switches, resets revisions/personal stats and sets controlledId to the first participant. | Rebuild the roster only at a fresh match boundary. Verify observer departures never try to deactivate an unknown simulation controller. |
| One human on a side can switch athletes. A second human on that side changes switch eligibility. | With next-match seating, Mike can finish this match with his existing controls. When he starts the next match with Jeff as a human teammate, each controls their own athlete. |
| A dropped player gets a 15-second reservation. An empty running room was closed after roughly 16 seconds. The old results path wanted every connected player to vote. | Separate transient loss from voluntary leave and separate results opt-in from unanimous voting. Bound the results window so an idle player cannot stall a group. |

## Implementation and verification checklist

### 1. Directory and two-person start

- Serve a reusable opaque signed group key in the URL. Scope directory access and court reservations to the group. Never put membership or reconnection credentials in copied links.
- Resolve simultaneous first joins to one court. An explicit additional-court request creates a separate simulation in the same sport. Preserve legacy direct room links and public matchmaking.
- Use a lightweight directory connection and one court connection per member. Scope recovery to the group, court, build and tab. A directory outage must allow a healthy court to keep playing.
- Keep public matchmaking headroom under friends load. Check allocation while a room is still being created. Apply overload refusal to new simulation work. Drain new admission separately during shutdown.
- Test link isolation, restart/reopen with the same signing secret, seat limits, concurrent first joins, manual starts at two and four, and leaving without stranding the group.

### 2. Watching and next-match seating

- Separate read-only observers from athlete controllers. Render a neutral court view without local-player controls or prediction. Count watchers separately from athletes and block crafted game commands from watch sockets.
- Encode the common spectator checkpoint once per broadcast. Retain player-specific acknowledgements for each player. Test the real 64 KiB pending-write guard and code 4001 recovery as a watcher with bounded retries.
- Represent watching and queueing independently. Enforce FIFO and one entry per member. At the match boundary, preserve queue order, seat eligible watchers before returning opt-ins and give a fresh authoritative baseline before accepting input.
- Check results with zero votes, four incumbents, a longer queue than the roster, voluntary departure, reconnect and a busy/slow viewer. Confirm that background tabs and reloads preserve the correct role.
- Check the browser layout at short desktop and portrait sizes. Copy link, joining, seat status, watching and switching must be usable with a keyboard or touch. Directories should show each sport without repeated roster or screen-reader announcements on every game tick.

### 3. Conditional experiment after the human playtest

Measure how often people who choose Play next leave before their next game, the actual queue wait, and whether a second court solves that problem. Match duration varies by sport. Three minutes is a hypothesis for the playtest.

If the group wants live substitutions, add a separate **Play now** action. Keep **Play next** bound to match boundaries. The experiment must replace an inactive or otherwise available controller on the actual free athlete at an authoritative tick. Preserve other controllers, team score, personal stats, RNG, ball and clock. Flush stale inputs and pending pass/switch actions on affected athletes. Give Mike a visible notification that Jeff has joined his side and show Mike's fixed athlete. Test a reconnect racing a join, a pending pass and an eliminated Dodge athlete before enabling that feature.

## Qualification

Exercise the actual server and browser entry points. Cover at least two parallel courts, two sports, two independent groups, four players plus viewers, observer backpressure, queue promotions and reload within grace. Exercise five sports with one office IP and active players. Record how long the workload ran, which load came from rendered browsers versus SDK peers, stream size, server debt and disconnects. Local runs exercise the game and transport; internet quality and hosting headroom require measurements on the intended deployment. Keep human feedback until after the build.

## Local acceptance results

- **One-link browser flow.** Three isolated Chromium sessions created a group, joined Dodge, started with two players, watched, queued and reloaded into the same match. A forced viewer close exercised automatic watch-only re-entry. The portrait and short-screen captures above come from this flow.
- **Next-match seating.** A browser watched through an actual vacancy and the rest of a complete match. After the results window, the viewer started the next match and controlled an athlete. A separate failed WebSocket upgrade kept the original seat until a subsequent court switch succeeded.
- **Deployment mechanics.** Two browser clients opened the production Vite bundle under the GitHub Pages base path through a loopback Caddy TLS proxy, using separate HTTPS frontend and WSS service origins. After reloading a player, the browser had made six WSS connections and returned to the same athlete with zero page errors. The certificate was local to the test.
- **Admission policy.** Real socket tests covered forged and stale invites/tickets, explicit leave, same-IP admissions, duplicate names, full 12-connection reconnects, and a signed invite reopened after restarting the Node process. A deliberately paused server kept directory admission, existing court joins and routing readiness while it refused new courts. The limit of 15 friends courts leaves at least ten slots outside the friends budget. Public games can borrow all 25. A separate opt-in public 1/25-room capacity test passed.
- **Viewer cost.** A 60-second run drove four seated SDK players in each of five sports plus 24 watchers (8, 0, 4, 8, 4). Forty-four group members held 88 WebSockets on one loopback address. The release run delivered 53,127 snapshots from 28,984 encodes at roughly 4.28 MB/s of application payload. An intentionally stalled viewer reached code 4001 and rejoined as an observer. These are local measurements. [Release load report](evidence/friends-local-load-2026-11-06.json)
- **Thirty-minute soak.** An integration build sustained five courts, 44 members and 88 WebSockets for 1,800.7 measured seconds. All five courts appeared in every sample. The run recorded zero client errors, zero bot takeovers in sampled active-player feedback, and one intentionally induced slow-viewer disconnect. The workload included 3–28 rematches per player. Aggregate application payload averaged 4.27 MB/s. The worst sampled rolling p99 simulation step was 6.88 ms; individual steps reached 129 ms. The final server was rechecked with the separate 60-second run above. [Soak summary](evidence/friends-lobby-2026-11-06/soak-summary.json)
- **Regression suites.** The build and TypeScript check passed. The default suites passed 421 simulation/game tests and 315 network tests. Twelve multiplayer browser scenarios and eight menu-layout scenarios passed.
- **Separate rollout.** The default enables watching with eight viewer slots per court. Set `CRYPTBALL_FRIENDS_VIEWERS_PER_COURT=0` to ship the directory and two-player starts alone, or choose an intermediate cap for the host. A real socket test exercises this configuration.

Run `npm test` for the default simulation and network suites, and `npm run test:cryptball:online-browser` for the browser flows. The mixed-load fixture uses the installed SDK, a dedicated local Node process and Python 3 for the slow TCP receiver. Run it independently so other benchmarks do not compete for CPU.

```sh
CRYPTBALL_FRIENDS_LOAD=1 npx vitest run --config vitest.cryptball-network.config.ts apps/cryptball/tests/online-friends-load.test.ts
```

For a 30-minute run, also set `CRYPTBALL_FRIENDS_LOAD_MS=1800000` and point `CRYPTBALL_FRIENDS_LOAD_REPORT` at a separate JSON file. In production, set a stable `CRYPTBALL_GROUP_SECRET` across server restarts. [Hosting settings](HOSTING.md)

For the human playtest, share one deployed group link with at least five people. Have two start a match while another watches and queues, and let the others try a second court. Observe whether newcomers notice the player who needs one opponent, whether they understand when they will get a seat, and whether they prefer starting another court over waiting. This feedback determines whether a separate live takeover feature is worth building.

## Stack references

- Colyseus 0.18's public LobbyRoom omits private/unlisted courts. Its listing and filters are useful for discovery. Group access requires an independent server-side check. [LobbyRoom](https://docs.colyseus.io/matchmaker/lobby)
- The matchmaker issues room reservations. Reconnection preserves an existing seat across transient loss or reload. [Matchmaking](https://docs.colyseus.io/matchmaker) · [Reconnection](https://docs.colyseus.io/room/reconnection)
- Each court belongs to one process. Reusable group links across restarts require a persistent signing secret. Recovering a running match after process loss would require additional persistence. [Colyseus scaling](https://docs.colyseus.io/scalability) · [Render WebSockets](https://render.com/docs/websocket)
