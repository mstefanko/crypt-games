/** Real rendered browser + real SDK peer through an ordered TCP delay proxy.
 * Usage: node scripts/cryptball-network-profile.mjs [output.json]
 * PROFILE_ENDPOINT=https://... tests one private cloud room (no load test).
 * PROFILE_RTT=150 PROFILE_CPU=4 PROFILE_SECONDS=15 select a local case.
 */
import { createServer as viteServer } from "vite";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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
const baseline = new Map();
if (variant === "baseline")
  for (const file of [
    "apps/cryptball/src/online/input-scheduler.ts",
    "packages/game-simulation/src/circle-geometry.ts",
  ])
    baseline.set(
      resolve(file),
      execFileSync("git", ["show", "2492946:" + file], { encoding: "utf8" }),
    );
const sport = process.env.PROFILE_SPORT ?? "rift-volley";
const seconds = Number(process.env.PROFILE_SECONDS ?? 15),
  rtt = Number(process.env.PROFILE_RTT ?? 150),
  cpu = Number(process.env.PROFILE_CPU ?? 1);
let server, proxy, vite, browser, peer;
try {
  let endpoint = process.env.PROFILE_ENDPOINT;
  if (!endpoint) {
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
          if (baseline.has(id)) return baseline.get(id);
          if (id.endsWith("/src/host.ts")) {
            if (variant === "baseline")
              code = code.replace(
                "frameInterpolation.draw(observation, time)",
                "observation",
              );
            return code.replace(
              "presenter.render(state,",
              "globalThis.__profileDraw = state; presenter.render(state,",
            );
          }
          if (id.endsWith("/src/online/session.ts"))
            return code.replace(
              "return {\n    async connect",
              "return globalThis.__profileOnline = {\n    async connect",
            );
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
  await page.goto("http://127.0.0.1:4239/games/cryptball/?sport=" + sport);
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
  peer = createSocketLoadClient(endpoint, sport);
  await peer.connect("join", room);
  const timer = setInterval(
    () =>
      peer.step({
        moveX: -1,
        aim: 128,
        strikeHeld: Math.floor(performance.now() / 500) % 2 === 0,
        strikeReleased: Math.floor(performance.now() / 500) % 2 === 1,
      }),
    1000 / 60,
  );
  try {
    await new Promise((r) => setTimeout(r, 500));
    peer.ready();
    await page
      .getByRole("button", { name: "Start with bots", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelector("#game")?.dataset.menu === "play",
      {},
      { timeout: 30000 },
    );
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
    await page.evaluate(() => {
      const s = globalThis.__profileOnline,
        step = s.step.bind(s);
      let frame = 0,
        last = performance.now();
      globalThis.__samples = [];
      globalThis.__frames = [];
      globalThis.__steps = [];
      globalThis.__ball = [];
      s.step = () => {
        const now = performance.now(),
          state = s.rawObserve(),
          p = state.players.find((p) => p.id === state.controlledId),
          dx = state.ball.x - p.x,
          dy = state.ball.y - p.y,
          n = Math.hypot(dx, dy) || 1;
        frame++;
        step({
          moveX: dx / n,
          moveY: dy / n,
          aim: Math.round(
            ((Math.atan2(dy, dx) / (2 * Math.PI)) * 256 + 256) % 256,
          ),
          strikePressed: frame % 40 === 0,
          strikeHeld: frame % 40 < 8,
          strikeReleased: frame % 40 === 8,
        });
        globalThis.__steps.push(performance.now() - now);
      };
      function sample(t) {
        globalThis.__frames.push(t - last);
        last = t;
        globalThis.__samples.push(s.diagnostics);
        const state = globalThis.__profileDraw ?? s.rawObserve(),
          b = state.ball;
        globalThis.__ball.push({
          tick: state.tick,
          phase: state.phase,
          x: b.x,
          y: b.y,
          z: b.z,
          vx: b.vx,
          vy: b.vy,
          vz: b.vz,
        });
        globalThis.__profileRaf = requestAnimationFrame(sample);
      }
      globalThis.__profileRaf = requestAnimationFrame(sample);
    });
    await page.waitForTimeout(seconds * 1000);
    const data = await page.evaluate(() => ({
      samples: globalThis.__samples,
      frames: globalThis.__frames,
      steps: globalThis.__steps,
      ball: globalThis.__ball,
      status: globalThis.__profileOnline.status,
      menu: document.querySelector("#game").dataset.menu,
    }));
    const movingDeltas = data.ball.flatMap((b, i) =>
      i > 120 &&
      b.phase === "play" &&
      data.ball[i - 1].phase === "play" &&
      (b.vx || b.vy || b.vz)
        ? [b.tick - data.ball[i - 1].tick]
        : [],
    );
    function dist(xs) {
      xs = xs.filter(Number.isFinite).sort((a, b) => a - b);
      return {
        n: xs.length,
        p50: xs[Math.floor(xs.length * 0.5)],
        p95: xs[Math.floor(xs.length * 0.95)],
        p99: xs[Math.floor(xs.length * 0.99)],
        max: xs.at(-1),
      };
    }
    const samples = data.samples.slice(120),
      report = {
        variant,
        sport,
        endpoint: process.env.PROFILE_ENDPOINT ? "cloud" : "local",
        rttAdded: process.env.PROFILE_ENDPOINT ? 0 : rtt,
        cpu,
        seconds,
        status: data.status,
        menu: data.menu,
        errors,
        framesMs: dist(data.frames.slice(120)),
        stepMs: dist(data.steps.slice(120)),
        movingTickDeltas: {
          ...dist(movingDeltas),
          repeated: movingDeltas.filter((x) => x === 0).length,
          jumped: movingDeltas.filter((x) => x > 1).length,
          backward: movingDeltas.filter((x) => x < 0).length,
        },
        stationaryMovingFrames: data.ball.filter(
          (b, i) =>
            i > 120 &&
            b.phase === "play" &&
            data.ball[i - 1].phase === "play" &&
            (b.vx || b.vy || b.vz) &&
            b.x === data.ball[i - 1].x &&
            b.y === data.ball[i - 1].y &&
            b.z === data.ball[i - 1].z,
        ).length,
        movingBallSamples: data.ball.filter((b) => b.vx || b.vy || b.vz).length,
        activeReplayMs: dist(
          data.samples
            .filter(
              (s, i) =>
                i >= 120 &&
                (data.ball[i].vx || data.ball[i].vy || data.ball[i].vz),
            )
            .map((s) => s.replayMs),
        ),
        metrics: Object.fromEntries(
          [
            "rttMs",
            "replayMs",
            "replayedTicks",
            "correctionPx",
            "ballCorrectionPx",
            "serverDebtMs",
            "snapshotBytes",
            "desiredLead",
            "actualLead",
            "timingRejections",
            "resyncRequested",
            "botTransitions",
          ].map((k) => [k, dist(samples.map((s) => s[k]))]),
        ),
      };
    await writeFile(out, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
  } finally {
    clearInterval(timer);
    await peer.leave();
    peer = null;
  }
} finally {
  await browser?.close();
  await vite?.close();
  await proxy?.close();
  server?.kill("SIGKILL");
}
