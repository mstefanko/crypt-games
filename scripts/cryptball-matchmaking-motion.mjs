// From the repository root, build the server, then run this script with Node.
// --check <trace.json> reapplies the same rules to previously submitted frames.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "vite";

const sports = [
  "cryptball",
  "cryptkick",
  "rift-volley",
  "cryptcheck",
  "crypt-dodge",
];
const impairment = { seed: 42, jitterMs: 20, stallRate: 0.008, stallMs: 90 };

// Injected after the host submits a render. Keep probes out of the game bundle.
function recordFrame(
  state,
  screen,
  presenter,
  online,
  frames,
  pendingAuthorityTick,
  covered,
) {
  if (!frames) return;
  const balls = (state.dodge?.balls ?? [])
    .filter((b) => !b.retired)
    .map((b) => {
      const sprite = presenter.sprites.get(
        b.id === "dodge-0" ? "ball" : "ball.extra." + b.id,
      );
      return {
        id: b.id,
        throwId: b.mode.throwId,
        mode: b.mode.state,
        holder: b.mode.holderId,
        x: b.physical.x / 256,
        y: b.physical.y / 256,
        vx: b.physical.vx / 256,
        vy: b.physical.vy / 256,
        sprite: sprite?.visible ? [sprite.x, sprite.y] : null,
      };
    });
  const freeBall = !state.dodge && !state.possessionId ? state.ball : null;
  const bodies = [
    ...state.players,
    ...(freeBall ? [{ ...freeBall, id: "ball" }] : []),
  ].map((p) => ({
    id: p.id,
    x: p.x / 256,
    y: p.y / 256,
    z: (p.z ?? 0) / 256,
    speed: Math.hypot(p.vx, p.vy, p.vz ?? 0) / 256,
  }));
  frames.push({
    at: performance.now(),
    tick: state.tick,
    ballAlpha: presenter.sprites.get("ball")?.alpha,
    screen,
    phase: state.phase,
    pendingAuthorityTick,
    controlledId: state.controlledId,
    epoch: online?.lobby?.epoch,
    round: state.dodge?.round ?? state.volley?.rally,
    score: state.score.join("-"),
    covered: Boolean(covered || online?.suspended),
    balls,
    bodies,
  });
}

function inspect(sport, frames) {
  let playFrames = 0,
    flightPairs = 0,
    heldFrames = 0,
    softenedHandoffs = 0;
  const failures = [],
    largeSteps = [];
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1],
      next = frames[i];
    if (
      [prev, next].some(
        (f) => f.screen !== "play" || f.phase !== "play" || f.covered,
      )
    )
      continue;
    if (
      prev.epoch !== next.epoch ||
      prev.round !== next.round ||
      prev.score !== next.score
    )
      continue;
    playFrames++;
    if (next.tick < prev.tick)
      failures.push({
        frame: i,
        kind: "court rewind",
        from: prev.tick,
        to: next.tick,
      });
    if (
      Number.isFinite(next.pendingAuthorityTick) &&
      next.pendingAuthorityTick <= prev.tick &&
      !next.balls.length &&
      prev.bodies &&
      next.bodies
    ) {
      heldFrames++;
      for (const body of next.bodies) {
        const old = prev.bodies.find((p) => p.id === body.id);
        if (
          old &&
          Math.hypot(body.x - old.x, body.y - old.y, body.z - old.z) > 1
        ) {
          failures.push({
            frame: i,
            kind: "pre-point pose moved during hold",
            id: body.id,
          });
          break;
        }
      }
    }
    // Advisory: contacts, separation and authoritative corrections also move bodies.
    // These belong in the trace, even when there is no evidence of a rewind.
    const seconds = Math.max(
      (next.at - prev.at) / 1000,
      (next.tick - prev.tick) / 60,
    );
    for (const body of next.bodies ?? []) {
      const old = prev.bodies.find((p) => p.id === body.id);
      if (!old) continue;
      const step = Math.hypot(body.x - old.x, body.y - old.y, body.z - old.z);
      if (
        body.id === "ball" &&
        Number.isFinite(prev.pendingAuthorityTick) &&
        prev.pendingAuthorityTick <= prev.tick &&
        !Number.isFinite(next.pendingAuthorityTick) &&
        step > 24 &&
        Number.isFinite(next.ballAlpha)
      ) {
        if (next.ballAlpha < 1) softenedHandoffs++;
        else
          failures.push({
            frame: i,
            kind: "large rejected-point handoff at full opacity",
            step,
          });
      }
      const travel = Math.max(body.speed, old.speed) * (seconds + 1 / 60);
      if (step > travel + 12)
        largeSteps.push({ frame: i, id: body.id, step, travel });
    }
    for (const b of next.balls) {
      if (b.mode !== "hostile-flight" && b.mode !== "friendly-pass") continue;
      const a = prev.balls.find((ball) => ball.id === b.id);
      if (
        !a?.sprite ||
        !b.sprite ||
        a.throwId !== b.throwId ||
        a.mode !== b.mode ||
        a.holder !== b.holder
      )
        continue;
      const speed = Math.hypot(b.vx, b.vy);
      // A rebound can legitimately reverse motion. Require both velocities to
      // agree and check displacement along their flight in world coordinates.
      if (!speed || a.vx * b.vx + a.vy * b.vy <= 0) continue;
      flightPairs++;
      const retreat = -((b.x - a.x) * b.vx + (b.y - a.y) * b.vy) / speed;
      const elapsed = Math.max(
        (next.at - prev.at) / 1000,
        (next.tick - prev.tick) / 60,
      );
      const allowance =
        2 + Math.max(speed, Math.hypot(a.vx, a.vy)) * (elapsed + 1 / 60);
      if (retreat > allowance)
        failures.push({
          frame: i,
          kind: "same-throw reversal",
          ball: b.id,
          throwId: b.throwId,
          tick: next.tick,
          retreat,
          allowance,
        });
    }
  }
  if (playFrames < 60 || (sport === "crypt-dodge" ? !flightPairs : !heldFrames))
    failures.push({
      kind: "insufficient active play, pending point, or flight coverage",
    });
  return {
    sport,
    playFrames,
    flightPairs,
    heldFrames,
    softenedHandoffs,
    failures,
    largeSteps,
  };
}

async function collect() {
  const requested = process.env.MOTION_SPORT;
  if (requested && !sports.includes(requested))
    throw Error("Unknown online sport: " + requested);
  const selected = requested ? [requested] : sports;
  const port = Number(process.env.MOTION_WEB_PORT ?? 4268);
  const origin = "http://127.0.0.1:" + port;
  const authority = spawn(
    process.execPath,
    ["dist/cryptball-server/main.mjs"],
    {
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: "0",
        CRYPTBALL_ORIGINS: origin,
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  let proxy, vite, browser;
  try {
    let log = "";
    authority.stdout.on("data", (chunk) => (log += chunk));
    for (
      let i = 0;
      i < 100 &&
      !log.includes("cryptball_listening") &&
      authority.exitCode === null;
      i++
    )
      await delay(100);
    const address = log
      .split("\n")
      .find((line) => line.includes("cryptball_listening"));
    if (!address)
      throw Error(
        "Local game server did not start. Run npm run build:cryptball:server first.",
      );
    const compiled = await build({
      entryPoints: ["apps/cryptball-server/tests/ordered-proxy.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
    });
    const { createOrderedProxy } = await import(
      "data:text/javascript;base64," +
        Buffer.from(compiled.outputFiles[0].contents).toString("base64")
    );
    proxy = await createOrderedProxy(
      JSON.parse(address).port,
      65,
      65,
      impairment,
    );
    vite = await createServer({
      configFile: "vite.cryptball.config.ts",
      server: {
        host: "127.0.0.1",
        port,
        strictPort: true,
        hmr: false,
        watch: null,
      },
      define: {
        "import.meta.env.VITE_CRYPTBALL_SERVER": JSON.stringify(proxy.endpoint),
      },
      plugins: [
        {
          name: "motion-probe",
          enforce: "pre",
          transform(code, id) {
            if (id.endsWith("/src/online/session.ts")) {
              const stamp = "observation.stats = { ...authority.stats };";
              if (!code.includes(stamp))
                throw Error("Missing authoritative observation hook");
              return code.replace(
                stamp,
                stamp +
                  "if (awaitingTransition) (window.motionPending ??= new WeakMap()).set(observation, authority.tick);",
              );
            }
            if (!id.endsWith("/src/host.ts")) return;
            const submit = "stage.render(0);";
            if (!code.includes(submit))
              throw Error("Missing render submission hook");
            return code.replace(
              submit,
              submit +
                "(" +
                recordFrame.toString() +
                ")(state,screen,presenter,online,window.motionFrames,window.motionPending?.get(observation),covered);",
            );
          },
        },
      ],
    });
    await vite.listen();
    browser = await chromium.launch({
      args: [
        "--use-gl=angle",
        "--use-angle=" +
          (process.env.CRYPTBALL_ANGLE ??
            (process.platform === "darwin" ? "metal" : "swiftshader")),
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
      ],
    });
    const report = {
      oneWayDelayMs: 65,
      impairment,
      selected,
      sports: {},
      errors: [],
    };
    for (const sport of selected) {
      const pages = [];
      try {
        for (const name of ["Alpha", "Bravo", "Charlie"]) {
          const page = await browser.newPage({
            viewport: { width: 800, height: 600 },
          });
          pages.push(page);
          page.on("pageerror", (error) =>
            report.errors.push({ sport, message: error.message }),
          );
          await page.goto(origin + "/games/cryptball/?sport=" + sport);
          for (const label of ["Play online", "Find a match"])
            await page
              .getByRole("button", { name: label, exact: true })
              .click();
          await page.getByLabel("Player name", { exact: true }).fill(name);
          await page.locator("form button[type=submit]").click();
          await expect(page.locator(".lobby-roster")).toContainText(name);
        }
        const [host, peer, departing] = pages;
        await expect(host.locator(".lobby-roster")).toContainText("Charlie");
        await host
          .getByRole("button", { name: "Start with bots", exact: true })
          .click();
        for (const p of pages) {
          await expect(p.locator("#game")).toHaveAttribute("data-sport", sport);
          await expect(p.locator("#game")).toHaveAttribute(
            "data-menu",
            "play",
            { timeout: 20000 },
          );
        }
        await host.evaluate(() => (window.motionFrames = []));
        for (let i = 0; i < 18; i++) {
          const key = ["KeyD", "KeyS", "KeyA", "KeyW"][i % 4];
          await host.keyboard.down(key);
          await host.keyboard.down("KeyJ");
          await delay(350);
          await host.keyboard.up("KeyJ");
          await delay(260);
          await host.keyboard.up(key);
          await peer.keyboard.press(i % 2 ? "KeyK" : "KeyJ");
          if (i === 7) await departing.close();
        }
        report.sports[sport] = await host.evaluate(() => window.motionFrames);
        console.log(sport, report.sports[sport].length, "render samples");
      } finally {
        await Promise.all(
          pages.filter((p) => !p.isClosed()).map((p) => p.close()),
        );
      }
    }
    report.transport = proxy.impairmentStats.reduce(
      (total, s) => ({
        chunks: total.chunks + s.chunks,
        stalls: total.stalls + s.stalls,
      }),
      { chunks: 0, stalls: 0 },
    );
    return report;
  } finally {
    await browser?.close();
    await vite?.close();
    await proxy?.close();
    authority.kill("SIGKILL");
  }
}

const offline = process.argv[2] === "--check";
const file =
  process.argv[offline ? 3 : 2] ?? ".local-game-tests/matchmaking-motion.json";
const report = offline
  ? JSON.parse(await readFile(file, "utf8"))
  : await collect();
if (!offline) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(report));
}
const results = (report.selected ?? sports).map((s) =>
  inspect(s, report.sports[s] ?? []),
);
console.log(JSON.stringify({ file, results, errors: report.errors }, null, 2));
if (report.errors.length || results.some((r) => r.failures.length))
  process.exitCode = 1;
