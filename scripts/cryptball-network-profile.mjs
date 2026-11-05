/** Two rendered browsers (PROFILE_PEER=sdk fallback), ordered TCP delay proxy.
 * Usage: node scripts/cryptball-network-profile.mjs [output.json]
 * PROFILE_ENDPOINT=https://... tests one private cloud room (no load test).
 * PROFILE_RTT=150 PROFILE_CPU=4 PROFILE_SECONDS=15 select a local case.
 */
import { createServer as viteServer } from "vite";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
const out = process.argv[2] ?? ".local-game-tests/network-profile.json";
await mkdir(".local-game-tests", { recursive: true });
await build({
  entryPoints: [
    "apps/cryptball-server/tests/ordered-proxy.ts",
    "apps/cryptball/tests/helpers/socket-load-client.ts",
  ],
  outdir: ".local-game-tests/profile-tools",
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
});
const { createOrderedProxy } = await import(
  "../.local-game-tests/profile-tools/cryptball-server/tests/ordered-proxy.js"
);
const { createSocketLoadClient } = await import(
  "../.local-game-tests/profile-tools/cryptball/tests/helpers/socket-load-client.js"
);
const variant = process.env.PROFILE_VARIANT ?? "optimized";
if (variant === "baseline") throw new Error("Use a separate full matching git checkout for a historical baseline; partial source transforms are unsupported.");
const sport = process.env.PROFILE_SPORT ?? "rift-volley";
const solo = sport === "crypt-guardian" || process.env.PROFILE_PLAY === "solo";
const seconds = Math.min(600, Math.max(1, Number(process.env.PROFILE_SECONDS ?? 15))),
  rtt = Number(process.env.PROFILE_RTT ?? 150),
  cpu = Number(process.env.PROFILE_CPU ?? 1);
let server, proxy, vite, browser, peer, peerPage;
const peerKind = process.env.PROFILE_PEER ?? "browser";
const rematch = process.env.PROFILE_REMATCH === "1";
const restart = process.env.PROFILE_RESTART === "1" ||
  (sport === "crypt-guardian" && process.env.PROFILE_RESTART !== "0");
if (restart && !solo) throw Error("PROFILE_RESTART=1 requires solo play; use PROFILE_REMATCH=1 online.");
if (rematch && (solo || peerKind !== "browser")) throw Error("PROFILE_REMATCH=1 requires online play with the default browser peer.");
try {
  let endpoint = process.env.PROFILE_ENDPOINT;
  if (!endpoint && !solo) {
    server = spawn(process.execPath, ["dist/cryptball-server/main.mjs"], {
      env: {
        ...process.env,
        PORT: "2579",
        HOST: "127.0.0.1",
        CRYPTBALL_ORIGINS: "http://127.0.0.1:4239",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    server.stdout.on("data", (x) => (logs += x));
    server.stderr.on("data", (x) => (logs += x));
    for (let i = 0; i < 100 && !logs.includes("cryptball_listening"); i++)
      await new Promise((r) => setTimeout(r, 100));
    if (!logs.includes("cryptball_listening")) throw Error(logs);
    proxy = await createOrderedProxy(2579, rtt / 2, rtt / 2);
    endpoint = proxy.endpoint;
  }
  endpoint ??= "http://127.0.0.1:2579";
  vite = await viteServer({
    configFile: "vite.cryptball.config.ts",
    server: {
      host: "127.0.0.1",
      port: 4239,
      strictPort: true,
      proxy: process.env.PROFILE_ENDPOINT
        ? {
            "/cloud": {
              target: process.env.PROFILE_ENDPOINT,
              changeOrigin: true,
              ws: true,
              rewrite: (p) => p.replace(/^\/cloud/, ""),
              headers: { Origin: "https://mstefanko.github.io" },
            },
          }
        : undefined,
    },
    define: {
      "import.meta.env.VITE_CRYPTBALL_SERVER": JSON.stringify(
        process.env.PROFILE_ENDPOINT ? "http://127.0.0.1:4239/cloud" : endpoint,
      ),
    },
    plugins: [
      {
        name: "profile-only-observer",
        enforce: "pre",
        transform(code, id) {
          if (id.endsWith("/src/host.ts")) {
            if (!code.includes("presenter.render(state,")) throw Error("Profiler host render hook missing");
            return code.replace(
              "presenter.render(state,",
              "globalThis.__profileDraw = state; globalThis.__profileLocal = session; session.rawObserve ??= session.observe.bind(session); session.diagnostics ??= {}; session.status ??= 'local'; for (const event of pendingEvents) globalThis.__cryptballPerformance?.record('simulation-event', { event: event.type, tick: event.tick, ballId: event.ballId ?? null }); presenter.render(state,",
            );
          }
          if (id.endsWith("/src/online/session.ts")) {
            if (!code.includes("return {\n    async connect")) throw Error("Profiler online session hook missing");
            return code.replace(
              "return {\n    async connect",
              "return globalThis.__profileOnline = {\n    async connect",
            );
          }
        },
      },
    ],
  });
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    args: [
      "--use-gl=angle",
      `--use-angle=${process.platform === "darwin" ? "metal" : "swiftshader"}`,
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:4239/games/cryptball/?diagnostics=1&diagnosticEvents=100000&sport=" + sport);
  let timer;
  if (solo) {
    await page.getByRole("button", { name: "Single player", exact: true }).click();
  } else {
  await page.getByRole("button", { name: "Play online", exact: true }).click();
  await page
    .getByRole("button", { name: "Play with friends", exact: true })
    .click();
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await page.getByLabel("Player name", { exact: true }).fill("Profile");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForFunction(
    () => globalThis.__profileOnline?.lobby?.roomId,
    {},
    { timeout: 30000 },
  );
  const room = await page.evaluate(
    () => globalThis.__profileOnline.lobby.roomId,
  );
  if (peerKind === "sdk") {
    peer = createSocketLoadClient(endpoint, sport);
    await peer.connect("join", room);
    let tick = 0;
    timer = setInterval(() => {
      const t = tick++ % 180;
      peer.step({ moveX: t < 90 ? -1 : 1, aim: 128,
        strikePressed: t === 20, strikeHeld: t >= 20 && t < 32,
        strikeReleased: t === 32, pass: t === 60 });
    }, 1000 / 60);
  } else {
    peerPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    peerPage.on("pageerror", e => errors.push("peer: " + e.message));
    await peerPage.goto("http://127.0.0.1:4239/games/cryptball/?diagnostics=1&diagnosticEvents=100000&sport=" + sport);
    await peerPage.getByRole("button", { name: "Play online", exact: true }).click();
    await peerPage.getByRole("button", { name: "Play with friends", exact: true }).click();
    await peerPage.getByLabel("Room code or invite link").fill(room);
    await peerPage.getByRole("button", { name: "Join room", exact: true }).click();
    await peerPage.getByLabel("Player name", { exact: true }).fill("Profile peer");
    await peerPage.getByRole("button", { name: "Continue", exact: true }).click();
    await peerPage.waitForFunction(() => globalThis.__profileOnline?.lobby?.roomId);
  }
  }
  try {
    await new Promise((r) => setTimeout(r, 500));
    if (peer) peer.ready();
    if (peerPage) {
      const ready = peerPage.getByRole("button", { name: "Ready", exact: true });
      if (await ready.count()) await ready.click();
    }
    if (!solo) await page
      .getByRole("button", { name: "Start with bots", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelector("#game")?.dataset.menu === "play",
      {},
      { timeout: 30000 },
    );
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
    const installTape = async (target, seed) => target.evaluate(({ seed, sport }) => {
      let s = globalThis.__profileOnline ?? globalThis.__profileLocal, step = s.step.bind(s), localEpoch = 0;
      let tick = 0, last = performance.now();
      globalThis.__measurementStart = last;
      globalThis.__profileOriginalStep = step;
      globalThis.__healthBaseline = null;
      globalThis.__stepTimes = [];
      globalThis.__frames = []; globalThis.__steps = []; globalThis.__entities = [];
      globalThis.__inputTape = [];
      const entities = state => [
        ...state.players.map(p => ({ id: "player:" + p.id, ...p })),
        ...(state.dodge ? state.dodge.balls.filter(b => !b.retired).map(b => ({ id: b.id, ...b.physical, owner: b.mode.holderId })) :
          state.guardian ? state.guardian.orbs.map(b => ({ id: b.id, ...b.ball, owner: b.possessionId })) : [{ id: "ball", ...state.ball }]),
        ...(state.guardian ? [{ id: "guardian", ...state.guardian.descriptor }, ...(state.guardian.projectiles ?? []).map(p => ({ ...p, id: "projectile:" + p.id }))] : []),
      ].map(({ id, x, y, z, vx, vy, vz, owner }) => ({ id, x, y, z, vx, vy, vz, owner }));
      const scriptedStep = () => {
        const start = performance.now(), t = tick++;
        // Logical-tick tape, independent of send pacing and wall clock. Different peer seed.
        const cycle = (t + seed) % 240, angle = Math.floor((t + seed) / 90) * Math.PI / 2;
        const combat = sport === "crypt-dodge" || sport === "crypt-guardian";
        const command = { moveX: Math.cos(angle), moveY: Math.sin(angle),
          aim: (Math.floor((t + seed) / 90) * 64 + (combat ? 32 : 0)) % 256,
          strikePressed: cycle === 30, strikeHeld: cycle >= 30 && cycle < (sport === "rift-volley" ? 36 : 48),
          strikeReleased: cycle === (sport === "rift-volley" ? 36 : 48),
          pass: cycle === 90, special: cycle === 150, switch: cycle === 190 };
        globalThis.__inputTape.push({ tick: t, command });
        const d = globalThis.__cryptballPerformance;
        const id = d?.captureInput("synthetic", start, start);
        const online = !!globalThis.__profileOnline;
        const before = online ? s.diagnostics.lastAppliedSeq : s.rawObserve().tick;
        step(command);
        if (id && (online ? s.diagnostics.lastAppliedSeq > before : s.rawObserve().tick > before)) d.appliedInput(id, s.rawObserve().tick);
        globalThis.__steps.push(performance.now() - start);
        globalThis.__stepTimes.push(start);
      };
      s.step = scriptedStep;
      function sample(t) {
        if (!globalThis.__profileOnline && globalThis.__profileLocal !== s) {
          s = globalThis.__profileLocal;
          step = s.step.bind(s);
          globalThis.__profileOriginalStep = step;
          s.step = scriptedStep;
          localEpoch++;
        }
        if (!globalThis.__healthBaseline && t >= globalThis.__measurementStart + 2000)
          globalThis.__healthBaseline = { at: t, counters: { ...s.diagnostics } };
        globalThis.__frames.push(t - last); last = t;
        const state = globalThis.__profileDraw ?? s.rawObserve();
        globalThis.__entities.push({ at: t, tick: state.tick, phase: state.phase, epoch: s.lobby?.epoch ?? localEpoch, lobbyPhase: s.lobby?.phase ?? null, entities: entities(state) });
        globalThis.__profileRaf = requestAnimationFrame(sample);
      }
      globalThis.__profileRaf = requestAnimationFrame(sample);
    }, { seed, sport });
    await installTape(page, 0);
    if (peerPage) await installTape(peerPage, 73);
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(Math.min(500, deadline - Date.now()));
      if (!solo) {
        for (const target of [page, peerPage].filter(Boolean)) {
          const status = await target.evaluate(() => globalThis.__profileOnline.status);
          if (status !== "joined") throw Error(`Profiler client unexpectedly ${status}`);
        }
        if (peer && peer.status !== "joined") throw Error(`Profiler SDK peer unexpectedly ${peer.status}`);
      }
      if (restart) {
        const retry = page.getByRole("button", { name: sport === "crypt-guardian" ? "Retry Guardian" : "Rematch", exact: true });
        if (await retry.isVisible() && await retry.isEnabled()) await retry.click();
      }
      if (!rematch) continue;
      for (const target of [page, peerPage]) {
        const button = target.getByRole("button", { name: "Rematch", exact: true });
        if (await button.isVisible() && await button.isEnabled()) await button.click();
      }
      const canStart = await page.evaluate(() => {
        const lobby = globalThis.__profileOnline.lobby;
        return lobby?.phase === "waiting" && lobby.seats.length >= 2 && lobby.seats.every(seat => seat.connected && seat.ready);
      });
      if (canStart) {
        const start = page.getByRole("button", { name: "Start with bots", exact: true });
        if (await start.isVisible() && await start.isEnabled()) await start.click();
      }
    }
    // Freeze both measurement boundaries before returning any large JSON payload.
    // Serial browser serialization can otherwise stall/extend the other client.
    await Promise.all([page, peerPage].filter(Boolean).map(target => target.evaluate(() => {
      cancelAnimationFrame(globalThis.__profileRaf);
      const session = globalThis.__profileOnline ?? globalThis.__profileLocal;
      const end = performance.now();
      globalThis.__profileResult = {
        measurementEnd: end, healthBaseline: globalThis.__healthBaseline,
        lastNetworkDiagnostics: { ...(globalThis.__profileOnline?.diagnostics ?? {}) },
        measurementStart: globalThis.__measurementStart, stepTimes: globalThis.__stepTimes,
        frames: globalThis.__frames, steps: globalThis.__steps, entities: globalThis.__entities,
        inputTape: globalThis.__inputTape, status: session.status,
        menu: document.querySelector("#game").dataset.menu,
        // Counter/state boundary is taken before the bounded recorder clone.
        diagnostics: globalThis.__cryptballPerformance?.export() ?? null,
      };
      session.step = globalThis.__profileOriginalStep;
    })));
    const collect = target => target.evaluate(() => globalThis.__profileResult);
    const [data, peerData] = await Promise.all([collect(page), peerPage ? collect(peerPage) : null]);
    function dist(xs) {
      xs = xs.filter(Number.isFinite).sort((a, b) => a - b);
      return { n: xs.length, p50: xs[Math.floor(xs.length * .5)], p95: xs[Math.floor(xs.length * .95)], p99: xs[Math.floor(xs.length * .99)], max: xs.at(-1) };
    }
    const summarize = client => {
      const start = client.healthBaseline?.at ?? client.measurementStart + 2000;
      const events = (client.diagnostics?.events ?? []).filter(e => e.at >= start && e.at <= client.measurementEnd);
      const eventMetrics = {};
      for (const e of events) for (const [key, value] of Object.entries(e.fields)) {
        if (typeof value === "number") (eventMetrics[e.kind + "." + key] ??= []).push(value);
      }
      const measuredFrames = client.entities.filter(f => f.at >= start && f.at <= client.measurementEnd);
      const activeFrames = measuredFrames.filter(f => f.phase === "play");
      const retained = client.diagnostics?.events ?? [];
      return { status: client.status, menu: client.menu, metadata: client.diagnostics?.metadata ?? {}, measurementFrom: start, measurementEnd: client.measurementEnd,
        droppedEvents: client.diagnostics?.dropped ?? 0,
        retainedWindow: { firstAt: retained[0]?.at ?? null, lastAt: retained.at(-1)?.at ?? null,
          durationMs: retained.length ? retained.at(-1).at - retained[0].at : 0,
          coversMeasurementStart: !client.diagnostics?.dropped || (retained[0]?.at ?? Infinity) <= start },
        epochsObserved: [...new Set(measuredFrames.map(frame => frame.epoch))],
        measuredFrames: measuredFrames.length, activeFrames: activeFrames.length,
        activeFraction: activeFrames.length / Math.max(1, measuredFrames.length),
        framesMs: dist(client.frames.filter((_, i) => client.entities[i].at >= start)),
        stepMs: dist(client.steps.filter((_, i) => client.stepTimes[i] >= start)),
        replayMs: dist(events.filter(e => e.kind === "snapshot-replay").map(e => e.fields.durationMs)),
        appWorkMs: dist(events.filter(e => e.kind === "frame").map(e => e.fields.workMs)),
        captureToRenderSubmissionMs: dist(events.filter(e => e.kind === "input-render-submission").map(e => e.fields.captureToSubmissionMs)),
        inputCounts: Object.fromEntries(["input-capture", "input-allocated", "input-applied", "input-application", "input-render-submission"].map(kind => [kind, events.filter(e => e.kind === kind).length])),
        ownershipCancellations: Number.isFinite(client.healthBaseline?.counters.rejectedRevision) && Number.isFinite(client.lastNetworkDiagnostics.rejectedRevision)
          ? client.lastNetworkDiagnostics.rejectedRevision - client.healthBaseline.counters.rejectedRevision : null,
        healthBaseline: client.healthBaseline,
        lastNetworkDiagnostics: client.lastNetworkDiagnostics,
        rejectionMaxima: Object.fromEntries(["Expired", "Future", "Cancelled", "SequenceGap", "Capacity", "Revision"].map(reason => [reason, Math.max(0, ...(eventMetrics["input-feedback.rejected" + reason] ?? []))])),
        metricsByEvent: Object.fromEntries(Object.entries(eventMetrics).map(([k, v]) => [k, dist(v)])),
      };
    };
    const clientSummary = summarize(data), peerSummary = peerData ? summarize(peerData) : null;
    const report = {
      variant, sport, play: solo ? "solo" : "online", peerKind: solo ? "none" : peerKind, endpoint: process.env.PROFILE_ENDPOINT ? "cloud" : "local",
      rttAdded: solo || process.env.PROFILE_ENDPOINT ? 0 : rtt, cpu, seconds, rematch, restart, errors,
      limitations: ["Synthetic input to render submission is not physical input-to-photon latency.",
        "Ordered delay proxy models delay, not packet loss.", "Desktop browser run; actual phone capture required separately.",
        "Scripted actions do not establish every mode scenario occurred; inspect event annotations.",
        ...(peerKind === "sdk" && !solo ? ["SDK peer drives the fixed-step input clock but omits rendering and full-world prediction; it is not a second device responsiveness measurement."] : [])],
      framesMs: clientSummary.framesMs, stepMs: clientSummary.stepMs,
      metricsByEvent: clientSummary.metricsByEvent,
      clientSummary, peerSummary,
      client: data, peer: peerData,
    };
    const healthRequested = process.env.PROFILE_ASSERT_HEALTH === "1";
    const failures = [];
    if (healthRequested) {
      if (solo || !peerSummary) failures.push("Health acceptance requires two online browser clients.");
      if (errors.length) failures.push(`Browser errors: ${errors.join("; ")}`);
      const keys = ["resyncRequested", "botTransitions", "rejectedSequenceGap", "rejectedExpired", "rejectedFuture", "rejectedCapacity"];
      for (const [label, summary] of [["client", clientSummary], ["peer", peerSummary]]) {
        if (!summary) continue;
        if (summary.status !== "joined") failures.push(`${label}: ended with connection status ${summary.status}`);
        const baseline = summary.healthBaseline?.counters;
        if (!baseline) failures.push(`${label}: no post-warmup counter baseline captured`);
        const deltas = {};
        for (const key of keys) {
          const before = baseline?.[key], after = summary.lastNetworkDiagnostics[key];
          if (!Number.isFinite(before) || !Number.isFinite(after)) {
            failures.push(`${label}: ${key} counters unavailable`); continue;
          }
          deltas[key] = after - before;
          if (deltas[key] !== 0) failures.push(`${label}: ${key} changed by ${deltas[key]} after warmup`);
        }
        summary.healthCounterDeltas = deltas;
        if (seconds >= 60 && summary.activeFraction < .5) failures.push(`${label}: activeFraction ${summary.activeFraction.toFixed(3)} below 0.5`);
      }
    }
    report.acceptance = { requested: healthRequested, passed: healthRequested ? failures.length === 0 : null,
      failures, scope: "Counters from the captured post-warmup baseline to frozen measurement end; retained timing distributions may cover a shorter window when events were dropped." };
    await writeFile(out, JSON.stringify(report, null, 2) + "\n");
    const compact = summary => { if (!summary) return null; const { metricsByEvent, ...rest } = summary; return rest; };
    console.log(JSON.stringify({ out, sport, play: report.play, peerKind: report.peerKind, client: compact(clientSummary), peer: compact(peerSummary), acceptance: report.acceptance, errors }));
    if (healthRequested && failures.length) throw Error(`Profile health acceptance failed; report saved to ${out}: ${failures.join("; ")}`);
  } finally {
    clearInterval(timer);
    await peer?.leave();
    peer = null;
  }
} finally {
  await browser?.close();
  await vite?.close();
  await proxy?.close();
  server?.kill("SIGKILL");
}
