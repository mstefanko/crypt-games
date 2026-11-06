/** Reproducible, two rendered browser Dodge gate. Build server first:
 * npm run build:cryptball:server && node scripts/cryptball-dodge-motion-gate.mjs [report.json]
 * MOTION_RTT=80 sets ordered round-trip delay. Samples are taken at render submission,
 * never in an independent rAF observer. Requires local Chromium Playwright install.
 */
import { createServer } from "vite";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
const out = process.argv[2] ?? ".local-game-tests/dodge-motion-gate.json";
await mkdir(".local-game-tests", { recursive: true });
await build({
  entryPoints: ["apps/cryptball-server/tests/ordered-proxy.ts"],
  outfile: ".local-game-tests/motion-proxy.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
});
const { createOrderedProxy } = await import(
  "../.local-game-tests/motion-proxy.mjs"
);
let server, proxy, vite, browser;
const errors = [],
  failures = [],
  scenarios = [];
const assert = (ok, message) => {
  if (!ok) failures.push(message);
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  server = spawn(process.execPath, ["dist/cryptball-server/main.mjs"], {
    env: {
      ...process.env,
      PORT: "2589",
      HOST: "127.0.0.1",
      CRYPTBALL_ORIGINS: "http://127.0.0.1:4249",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  server.stdout.on("data", (x) => (logs += x));
  server.stderr.on("data", (x) => (logs += x));
  for (let i = 0; i < 100 && !logs.includes("cryptball_listening"); i++)
    await pause(100);
  if (!logs.includes("cryptball_listening")) throw Error(logs);
  const rtt = Number(process.env.MOTION_RTT ?? 80);
  proxy = await createOrderedProxy(2589, rtt / 2, rtt / 2, {
    seed: 42,
    jitterMs: 0,
    stallRate: 0,
    stallMs: 0,
  });
  vite = await createServer({
    configFile: "vite.cryptball.config.ts",
    server: {
      host: "127.0.0.1",
      port: 4249,
      strictPort: true,
      watch: null,
      hmr: false,
    },
    define: {
      "import.meta.env.VITE_CRYPTBALL_SERVER": JSON.stringify(proxy.endpoint),
    },
    plugins: [
      {
        name: "draw-motion-gate",
        enforce: "pre",
        transform(code, id) {
          if (id.endsWith("/src/host.ts")) {
            if (!code.includes("stage.render(0);"))
              throw Error("Missing render submission hook");
            return code.replace(
              "stage.render(0);",
              `stage.render(0); globalThis.__motionDraw?.({...state, players: state.players.map(p=>{ const position=presenter.sprites.get("shadow."+p.id)?.position; return {...p, worldX:p.x, worldY:p.y, x:position ? Math.round(position.x) : NaN, y:position ? Math.round(position.y) : NaN}; })}, performance.now(), screen, online?.diagnostics);`,
            );
          }
          if (id.endsWith("/src/online/frame-interpolation.ts"))
            return code.replace(
              "const a = extractPoses(before),",
              `globalThis.__motionCorrections ??= []; const ca = extractPoses(before), cb = extractPoses(after); for (const [id, b] of cb.entities) { const a = ca.entities.get(id); if (a) globalThis.__motionCorrections.push({at:now,id,distance:Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)/256,reset}); } const a = extractPoses(before),`,
            );
          if (id.endsWith("/src/online/session.ts"))
            return code.replace(
              "return {\n    async connect",
              "return globalThis.__motionOnline = {\n    async connect",
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
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  });
  const pages = await Promise.all(
    [0, 1].map(async () => {
      const p = await browser.newPage({
        viewport: { width: 1000, height: 760 },
      });
      p.on("pageerror", (e) => errors.push(e.message));
      await p.addInitScript(() => {
        globalThis.__motionSamples = [];
        globalThis.__motionLabel = "setup";
        globalThis.__motionDraw = (s, at, screen, diagnostics) => {
          if (!globalThis.__motionRecording) return;
          globalThis.__motionSamples.push({
            at,
            screen,
            phase: s.phase,
            label: globalThis.__motionLabel,
            tick: s.tick,
            controlledId: s.controlledId,
            players: s.players.map((p) => ({
              id: p.id,
              x: p.x,
              y: p.y,
              worldX: p.worldX,
              worldY: p.worldY,
              vx: p.vx,
              vy: p.vy,
            })),
            balls: (s.dodge?.balls ?? [])
              .filter((b) => !b.retired)
              .map((b) => ({ id: b.id, ...b.physical })),
            diagnostics: { ...diagnostics },
          });
        };
      });
      await p.goto(
        "http://127.0.0.1:4249/games/cryptball/?sport=crypt-dodge&diagnostics=1&diagnosticEvents=100000",
      );
      await p.getByRole("button", { name: "Play online", exact: true }).click();
      await p
        .getByRole("button", { name: "Play with friends", exact: true })
        .click();
      return p;
    }),
  );
  const [host, peer] = pages;
  await host.getByRole("button", { name: "Create room", exact: true }).click();
  await host.getByLabel("Player name", { exact: true }).fill("Motion host");
  await host.getByRole("button", { name: "Continue", exact: true }).click();
  await host.waitForFunction(() => globalThis.__motionOnline?.lobby?.roomId);
  const room = await host.evaluate(
    () => globalThis.__motionOnline.lobby.roomId,
  );
  await peer.getByLabel("Room code or invite link").fill(room);
  await peer.getByRole("button", { name: "Join room", exact: true }).click();
  await peer.getByLabel("Player name", { exact: true }).fill("Motion peer");
  await peer.getByRole("button", { name: "Continue", exact: true }).click();
  await peer.waitForFunction(() => globalThis.__motionOnline?.lobby?.roomId);
  const ready = peer.getByRole("button", { name: "Ready", exact: true });
  if (await ready.count()) await ready.click();
  await peer.evaluate(() => window.dispatchEvent(new Event("blur")));
  await host
    .getByRole("button", { name: "Start with bots", exact: true })
    .click();
  await Promise.all(
    pages.map((p) =>
      p.waitForFunction(
        () => document.querySelector("#game")?.dataset.menu === "play",
        null,
        { timeout: 30000 },
      ),
    ),
  );
  await pause(700);
  assert(
    (await peer
      .getByRole("button", { name: "Return to play", exact: true })
      .count()) === 0,
    "Blur before kickoff opened cover",
  );
  await peer.evaluate(() => window.dispatchEvent(new Event("focus")));
  const label = async (name) =>
    Promise.all(
      pages.map((p) =>
        p.evaluate((name) => {
          globalThis.__motionLabel = name;
          globalThis.__motionRecording = true;
        }, name),
      ),
    );
  // Real keyboard events through host input handling; no session.step replacement.
  async function keyboardMoves(page, key, name) {
    await label(name);
    await pause(50);
    const before = await page.evaluate(() => {
      const s = globalThis.__motionSamples.at(-1);
      globalThis.__motionKeyAt = performance.now();
      globalThis.__motionAllocatedBefore =
        globalThis.__motionOnline.diagnostics.allocatedInputs;
      return s.players.find((p) => p.id === s.controlledId);
    });
    const start = Date.now();
    await page.keyboard.down(key);
    await page
      .waitForFunction(
        ({ id, x, y }) =>
          globalThis.__motionSamples.some(
            (s) =>
              s.at > globalThis.__motionKeyAt &&
              s.players.some(
                (p) =>
                  p.id === id &&
                  Math.hypot(p.x - x, p.y - y) > 2 &&
                  globalThis.__motionOnline.diagnostics.allocatedInputs >
                    globalThis.__motionAllocatedBefore,
              ),
          ),
        before,
        { timeout: 1500 },
      )
      .catch(() =>
        failures.push(
          `${name}: keyboard did not move drawn controlled athlete within 1500ms`,
        ),
      );
    await page.keyboard.up(key);
    scenarios.push({ name, responseUpperBoundMs: Date.now() - start });
  }
  await peer.evaluate(() => (globalThis.__motionKeyAt = performance.now()));
  await keyboardMoves(peer, "ArrowRight", "refocus-keyboard");
  // Steady crossings and deliberate reversals stay short enough to avoid arena walls.
  for (let i = 0; i < 8; i++) {
    await label(`crossing-${i}`);
    await Promise.all(
      pages.map((p, j) =>
        p.keyboard.down((i + j) % 2 ? "ArrowLeft" : "ArrowRight"),
      ),
    );
    await pause(450);
    await Promise.all(
      pages.map((p, j) =>
        p.keyboard.up((i + j) % 2 ? "ArrowLeft" : "ArrowRight"),
      ),
    );
  }
  // Visibility event exercises the same hidden path without relying on headless tab policy.
  await peer.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await pause(400);
  await peer.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  await peer
    .getByRole("button", { name: "Return to play", exact: true })
    .waitFor({ timeout: 3000 });
  await label("covered");
  const coverBefore = await peer.evaluate(() => ({
    ...globalThis.__motionOnline.diagnostics,
  }));
  for (let i = 0; i < 6; i++) {
    await label(`covered-${i}`);
    const key = i % 2 ? "ArrowRight" : "ArrowLeft";
    await host.keyboard.down(key);
    await pause(450);
    await host.keyboard.up(key);
  }
  const coverAfter = await peer.evaluate(() => ({
    ...globalThis.__motionOnline.diagnostics,
  }));
  assert(
    coverAfter.allocatedInputs === coverBefore.allocatedInputs,
    "Covered client allocated input",
  );
  assert(
    coverAfter.coveredBufferTick > coverBefore.coveredBufferTick,
    "Covered playout cursor did not advance",
  );
  scenarios.push({ name: "cover", before: coverBefore, after: coverAfter });
  await peer
    .getByRole("button", { name: "Return to play", exact: true })
    .click();
  await peer.evaluate(() => (globalThis.__motionKeyAt = performance.now()));
  await keyboardMoves(peer, "ArrowLeft", "cover-resume-keyboard");
  await label("settle");
  await pause(500);
  const raw = await Promise.all(
    pages.map((p) =>
      p.evaluate(() => {
        globalThis.__motionRecording = false;
        return {
          samples: globalThis.__motionSamples,
          corrections: globalThis.__motionCorrections ?? [],
          events: globalThis.__cryptballPerformance?.export(),
          diagnostics: { ...globalThis.__motionOnline.diagnostics },
        };
      }),
    ),
  );
  function distribution(a) {
    a = a.filter(Number.isFinite).sort((a, b) => a - b);
    return {
      count: a.length,
      p95: a[Math.floor(a.length * 0.95)] ?? null,
      max: a.at(-1) ?? null,
    };
  }
  const summaries = raw.map((data, index) => {
    const changed = [],
      holds = [],
      reversals = [];
    let last = null,
      lastChange = null,
      previousDx = 0;
    for (const s of data.samples) {
      const p = s.players.find((p) => p.id === s.controlledId);
      if (!p || !s.label.startsWith("crossing-") || s.screen !== "play") {
        last = null;
        lastChange = null;
        continue;
      }
      if (last && last.label === s.label) {
        const dx = p.x - last.p.x,
          dy = p.y - last.p.y;
        if (Math.hypot(dx, dy) > 0.01) {
          if (lastChange !== null) {
            changed.push(s.at - lastChange);
            holds.push({ ms: s.at - lastChange, label: s.label, at: s.at });
          }
          lastChange = s.at;
          if (previousDx * dx < 0)
            reversals.push({
              at: s.at,
              label: s.label,
              distance: Math.hypot(dx, dy),
            });
          previousDx = dx;
        }
      } else {
        lastChange = s.at;
        previousDx = 0;
      }
      last = { ...s, p };
    }
    const cadence = distribution(changed);
    assert(
      cadence.count >= 80,
      `client ${index}: insufficient crossing samples (${cadence.count})`,
    );
    assert(
      cadence.p95 !== null && cadence.p95 < 34,
      `client ${index}: changed drawn position p95 ${cadence.p95}ms exceeds 34ms`,
    );
    const entityCadence = {};
    const remoteId = raw[1 - index].samples.find((s) =>
      s.label.startsWith("crossing-"),
    )?.controlledId;
    for (const id of [
      ...new Set(data.samples.flatMap((s) => s.players.map((p) => p.id))),
    ]) {
      const rows = data.samples.filter((s) => s.label.startsWith("crossing-"));
      const gaps = [],
        jumps = [];
      let prev = null,
        changedAt = null;
      for (const row of rows) {
        const p = row.players.find((p) => p.id === id);
        if (!p) continue;
        if (prev && prev.row.label === row.label) {
          const dx = p.x - prev.p.x,
            dy = p.y - prev.p.y;
          if (Math.hypot(dx, dy) > 0.01) {
            if (changedAt !== null) gaps.push(row.at - changedAt);
            changedAt = row.at;
            if (prev.dx !== undefined && prev.dx * dx < 0)
              jumps.push({
                at: row.at,
                label: row.label,
                distancePx: Math.hypot(dx, dy),
              });
          }
          prev = { row, p, dx };
        } else {
          prev = { row, p };
          changedAt = row.at;
        }
      }
      entityCadence[id] = {
        changedIntervals: distribution(gaps),
        reversals: jumps,
      };
    }
    const remoteCadence = entityCadence[remoteId]?.changedIntervals;
    assert(
      remoteCadence?.count >= 80,
      `client ${index}: insufficient remote crossing samples`,
    );
    assert(
      remoteCadence?.p95 < 34,
      `client ${index}: remote drawn crossing p95 ${remoteCadence?.p95}ms exceeds 34ms`,
    );
    const covered = data.samples.filter((s) => s.label.startsWith("covered-"));
    if (index === 1)
      assert(covered.length >= 30, "Peer lacked covered rendered samples");
    const coveredGaps = [];
    let coveredPrevious = null,
      lastCoveredChange = null;
    for (const row of covered) {
      const p = row.players.find((p) => p.id === remoteId);
      if (!p) continue;
      if (
        coveredPrevious?.label === row.label &&
        Math.hypot(p.x - coveredPrevious.x, p.y - coveredPrevious.y) > 0.01
      ) {
        if (lastCoveredChange !== null)
          coveredGaps.push(row.at - lastCoveredChange);
        lastCoveredChange = row.at;
      } else if (coveredPrevious?.label !== row.label)
        lastCoveredChange = row.at;
      coveredPrevious = { ...p, label: row.label };
    }
    const coveredCadence = distribution(coveredGaps);
    if (index === 1) {
      assert(
        coveredCadence.count >= 60,
        "Insufficient covered remote crossing samples",
      );
      assert(
        coveredCadence.p95 < 34,
        `Covered remote crossing p95 ${coveredCadence.p95}ms exceeds 34ms`,
      );
    }
    const events = data.events?.events ?? [];
    return {
      client: index,
      cadence,
      entityCadence,
      coveredCadence,
      longestHolds: holds.sort((a, b) => b.ms - a.ms).slice(0, 10),
      reversals,
      corrections: {
        perEntity: Object.fromEntries(
          [...new Set(data.corrections.map((c) => c.id))].map((id) => [
            id,
            distribution(
              data.corrections
                .filter((c) => c.id === id && !c.reset)
                .map((c) => c.distance),
            ),
          ]),
        ),
        events: events
          .filter((e) => /correct|reconcil/.test(e.kind))
          .map((e) => ({ kind: e.kind, ...e.fields })),
      },
      underruns: data.diagnostics.coveredBufferUnderruns ?? null,
      diagnostics: data.diagnostics,
    };
  });
  assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  await writeFile(
    out,
    JSON.stringify(
      {
        passed: failures.length === 0,
        failures,
        rtt,
        scenarios,
        summaries,
        raw,
        limitations: [
          "Render submission, not physical display scanout.",
          "Hidden state is deterministic visibilitychange injection; blur and keyboard use browser DOM input paths.",
          "Crossing cadence excludes covered/neutral/boundary intervals.",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      out,
      passed: failures.length === 0,
      failures,
      scenarios,
      summaries: summaries.map(({ corrections, ...s }) => ({
        ...s,
        correctionEvents: corrections.events.length,
      })),
    }),
  );
  if (failures.length) throw Error("Dodge drawn-motion gate failed");
} finally {
  await browser?.close();
  await vite?.close();
  await proxy?.close();
  server?.kill("SIGKILL");
}
