// From the repository root, build the server, then run this script with Node.
// --check <trace.json> reapplies the same rules to previously submitted frames.
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

// Minimal independent snapshots distinguish simulation, authority and submitted pose.
function ballEvidence(state) {
  if (!state) return null;
  const b = state.ball;
  return {
    tick: state.tick,
    phase: state.phase,
    score: state.score.join("-"),
    x: b.x / 256,
    y: b.y / 256,
    z: (b.z ?? 0) / 256,
    vx: b.vx / 256,
    vy: b.vy / 256,
    vz: (b.vz ?? 0) / 256,
    lastTouch: b.lastTouch,
    possessionId: state.possessionId,
    restartTeam: state.restartTeam,
    protection: state.restartProtection,
    serving: state.volley?.serving,
    rally: state.volley?.rally,
    contactTick: state.volley?.contactTick,
  };
}

// Injected after the host submits a render. Keep probes out of the game bundle.
function recordFrame(
  state,
  screen,
  presenter,
  online,
  frames,
  pendingAuthorityTick,
  covered,
  evidence,
  submitted,
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
  const frame = frames.length;
  const at = performance.now();
  const stamp = document.getElementById("motion-sync");
  if (stamp)
    stamp.textContent = `frame=${frame} at=${at.toFixed(3)} tick=${state.tick}`;
  frames.push({
    frame,
    at,
    evidence: { ...evidence, submitted, source: "pre-merge-v1" },
    tick: state.tick,
    ballAlpha: presenter.sprites.get("ball")?.alpha,
    screen,
    phase: state.phase,
    pendingAuthorityTick,
    controlledId: state.controlledId,
    epoch: online?.lobby?.epoch,
    round: state.dodge?.round ?? state.volley?.rally,
    serving: state.volley?.serving,
    serveTeam: state.volley?.serveTeam,
    serveTicks: state.volley?.serveTicks,
    restartTeam: state.restartTeam,
    restartProtection: state.restartProtection,
    possessionId: state.possessionId,
    faceoffLead: state.hockey?.faceoffLead,
    dropSide: state.hockey?.dropSide,
    score: state.score.join("-"),
    covered: Boolean(covered || online?.suspended),
    balls,
    bodies,
  });
}

export function inspect(sport, frames, scenario) {
  let playFrames = 0,
    flightPairs = 0,
    heldFrames = 0,
    softenedHandoffs = 0;
  const failures = [],
    largeSteps = [],
    transitions = [],
    launchOpportunities = [];
  let activeLaunch = null;
  const transitionFields = [
    "epoch",
    "round",
    "score",
    "phase",
    "serving",
    "serveTeam",
    "restartTeam",
    "restartProtection",
    "possessionId",
    "dropSide",
    "faceoffLead",
  ];
  const classification = (a, b) => {
    if (a.serving !== b.serving || a.serveTeam !== b.serveTeam)
      return "serve transition";
    if (
      a.restartTeam !== b.restartTeam ||
      (a.restartProtection === 0 && b.restartProtection > 0) ||
      JSON.stringify(a.faceoffLead) !== JSON.stringify(b.faceoffLead) ||
      a.dropSide !== b.dropSide
    )
      return "restart transition";
    if (
      a.epoch !== b.epoch ||
      a.round !== b.round ||
      a.score !== b.score ||
      a.phase !== b.phase
    )
      return "round/score/phase transition";
    if (a.possessionId !== b.possessionId) return "possession transition";
    return "continuous play";
  };
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1],
      next = frames[i];
    // Launch checks precede phase filtering, including ready→play. Each launch
    // owns a 250ms window so a delayed correction cannot evade the edge check.
    const a = prev.evidence?.submitted,
      b = next.evidence?.submitted;
    const speed = (v) => v && Math.hypot(v.vx, v.vy, v.vz);
    const distance = (x, y) =>
      x && y ? Math.hypot(y.x - x.x, y.y - x.y, y.z - x.z) : null;
    const eligible =
      a &&
      b &&
      prev.screen === "play" &&
      next.screen === "play" &&
      !prev.covered &&
      !next.covered &&
      prev.epoch === next.epoch &&
      prev.score === next.score &&
      prev.round === next.round;
    const serveLaunch =
      sport === "rift-volley" && a?.serving === true && b?.serving === false;
    // The actual untouched stationary restart anchor remains valid after the
    // protection countdown expires. An ordinary possession release cannot arm it.
    const kickLaunch =
      sport === "cryptkick" &&
      a?.lastTouch === null &&
      a?.restartTeam != null &&
      speed(a) <= 1 &&
      speed(b) > 10;
    const launchEdge = eligible && (serveLaunch || kickLaunch);
    const reset =
      !eligible ||
      (prev.phase !== next.phase &&
        !(prev.phase === "ready" && next.phase === "play")) ||
      (!launchEdge &&
        (a?.lastTouch !== b?.lastTouch ||
          a?.contactTick !== b?.contactTick ||
          b?.serving));
    if (activeLaunch && (reset || next.at - activeLaunch.at > 250))
      activeLaunch = null;
    if (launchEdge) {
      activeLaunch = {
        frame: i,
        at: next.at,
        tick: next.tick,
        kind: serveLaunch ? "volley serve launch" : "kick restart launch",
        possessionId: b.possessionId,
        lastTouch: b.lastTouch,
        fromPhase: prev.phase,
        toPhase: next.phase,
        visibleJumps: 0,
        fadedJumps: 0,
        samples: [],
        excessive: false,
      };
      launchOpportunities.push(activeLaunch);
    }
    if (activeLaunch && eligible) {
      const step = distance(a, b);
      const seconds = Math.max(0, (next.at - prev.at) / 1000);
      const allowance = 8 + Math.max(speed(a), speed(b)) * (seconds + 1 / 60);
      const rawStep = distance(prev.evidence?.raw, next.evidence?.raw);
      const rawToDrawn = distance(next.evidence?.raw, b);
      const excessive = step > allowance;
      const faded = Number.isFinite(next.ballAlpha) && next.ballAlpha < 0.99;
      const sample = {
        frame: i,
        at: next.at,
        step,
        allowance,
        rawStep,
        rawToDrawn,
        alpha: next.ballAlpha,
        classification: excessive
          ? faded
            ? "softened fallback"
            : "visible jump"
          : "continuous launch",
        before: prev.evidence,
        after: next.evidence,
      };
      activeLaunch.samples.push(sample);
      if (excessive) {
        activeLaunch[faded ? "fadedJumps" : "visibleJumps"]++;
        if (!faded && !activeLaunch.excessive) {
          activeLaunch.excessive = true;
          failures.push({
            frame: i,
            kind: "excessive " + activeLaunch.kind,
            launchFrame: activeLaunch.frame,
            ...sample,
          });
        }
      }
    }
    const category = classification(prev, next);
    if (category !== "continuous play")
      transitions.push({
        frame: i,
        at: next.at,
        tick: next.tick,
        category,
        changes: Object.fromEntries(
          transitionFields
            .filter(
              (key) => JSON.stringify(prev[key]) !== JSON.stringify(next[key]),
            )
            .map((key) => [key, { from: prev[key], to: next[key] }]),
        ),
      });
    if (
      [prev, next].some(
        (f) => f.screen !== "play" || f.phase !== "play" || f.covered,
      )
    )
      continue;
    if (category !== "continuous play") {
      for (const body of next.bodies ?? []) {
        const old = (prev.bodies ?? []).find((p) => p.id === body.id);
        if (!old) continue;
        const step = Math.hypot(body.x - old.x, body.y - old.y, body.z - old.z);
        if (step > 12)
          largeSteps.push({
            frame: i,
            at: next.at,
            tick: next.tick,
            id: body.id,
            step,
            category,
          });
      }
    }
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
      if (step > travel + 12 && category === "continuous play")
        largeSteps.push({
          frame: i,
          at: next.at,
          tick: next.tick,
          id: body.id,
          step,
          travel,
          category,
        });
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
  if (
    playFrames < 60 ||
    (sport === "crypt-dodge"
      ? !flightPairs
      : scenario === "kick-restart"
        ? false
        : !heldFrames)
  )
    failures.push({
      kind: "insufficient active play, pending point, or flight coverage",
    });
  if (
    ["cryptkick", "rift-volley"].includes(sport) &&
    !launchOpportunities.length
  )
    failures.push({
      kind: frames.some((f) => f.evidence?.raw && f.evidence?.submitted)
        ? "insufficient restart/serve launch coverage"
        : "insufficient historical evidence for restart/serve launch gate",
    });
  if (scenario === "kick-restart") {
    const freeKick = launchOpportunities.find(
      (launch) => !launch.possessionId && launch.lastTouch === "player-2",
    );
    if (!freeKick)
      failures.push({
        kind: "focused fixture did not produce actual remote free kick",
      });
    else if (
      !freeKick.samples.some((sample) => sample.rawStep > sample.allowance)
    )
      failures.push({
        kind: "remote free kick did not exercise a late prediction correction",
      });
  }
  return {
    sport,
    playFrames,
    flightPairs,
    heldFrames,
    softenedHandoffs,
    evidenceQuality: frames.some((f) => f.evidence?.source === "pre-merge-v1")
      ? "pre-merge raw, authority and submitted snapshots"
      : "historical: raw snapshots absent or captured after merge; submitted launch checks only",
    launchCoverage: {
      visibleJumps: launchOpportunities.reduce((n, l) => n + l.visibleJumps, 0),
      fadedJumps: launchOpportunities.reduce((n, l) => n + l.fadedJumps, 0),
      failingOpportunities: launchOpportunities.filter((l) => l.excessive)
        .length,
      kickRestart: launchOpportunities.filter(
        (l) => l.kind === "kick restart launch",
      ).length,
      volleyServe: launchOpportunities.filter(
        (l) => l.kind === "volley serve launch",
      ).length,
    },
    launchOpportunities,
    failures,
    largeSteps,
    transitions,
  };
}

async function collect() {
  const scenario = process.env.MOTION_SCENARIO;
  if (scenario && scenario !== "kick-restart")
    throw Error("Unknown motion scenario: " + scenario);
  const requested =
    process.env.MOTION_SPORTS ??
    process.env.MOTION_SPORT ??
    (scenario === "kick-restart" ? "cryptkick" : undefined);
  const selected = requested
    ? [...new Set(requested.split(",").map((s) => s.trim()))]
    : sports;
  if (selected.some((s) => !sports.includes(s)))
    throw Error("Unknown online sport: " + requested);
  const videoDir =
    process.env.MOTION_VIDEO_DIR && resolve(process.env.MOTION_VIDEO_DIR);
  const port = Number(process.env.MOTION_WEB_PORT ?? 4268);
  const origin = "http://127.0.0.1:" + port;
  let serverEntry = "dist/cryptball-server/main.mjs";
  if (scenario === "kick-restart") {
    if (selected.some((s) => s !== "cryptkick"))
      throw Error("kick-restart requires cryptkick only");
    serverEntry = ".local-game-tests/kick-restart-authority.mjs";
    await mkdir(dirname(serverEntry), { recursive: true });
    await build({
      entryPoints: ["apps/cryptball-server/src/main.ts"],
      outfile: serverEntry,
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      external: ["@colyseus/*", "msgpackr", "ws"],
      plugins: [
        {
          name: "restart-fixture",
          setup(builder) {
            builder.onLoad(
              { filter: /\/cryptball-server\/src\/model\.ts$/ },
              async ({ path }) => {
                const code = await readFile(path, "utf8");
                const hook =
                  "      this.session.restore(checkpoint);\n      for (const p of this.peers.values()) {";
                const offset = code.indexOf(
                  hook,
                  code.indexOf("// New modes retain their opening"),
                );
                if (offset < 0)
                  throw Error("Missing authority start fixture hook");
                const fixture = `
      if (this.sportId === "cryptkick") {
        resetCourt(checkpoint.state, 1);
        checkpoint.state.phase = "ready";
        checkpoint.state.phaseTicks = 120;
        checkpoint.state.score = [1, 0];
      }
`;
                return {
                  contents:
                    'import { resetCourt } from "../../cryptball/sim/match";\n' +
                    code.slice(0, offset) +
                    fixture +
                    code.slice(offset),
                  loader: "ts",
                };
              },
            );
          },
        },
      ],
    });
  }
  const authority = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      CRYPTBALL_ORIGINS: origin,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
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
              const entry =
                "function confirmedObservation(observation: Observation): Observation {";
              if (!code.includes(entry))
                throw Error("Missing pre-merge observation hook");
              return code
                .replace(
                  entry,
                  entry +
                    "const motionRaw = (" +
                    ballEvidence.toString() +
                    ")(observation);",
                )
                .replace(
                  stamp,
                  stamp +
                    "if (awaitingTransition) (window.motionPending ??= new WeakMap()).set(observation, authority.tick);" +
                    "(window.motionEvidence ??= new WeakMap()).set(observation,{raw:motionRaw,authority:(" +
                    ballEvidence.toString() +
                    ")(authority)});",
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
                ")(state,screen,presenter,online,window.motionFrames,window.motionPending?.get(observation),covered,window.motionEvidence?.get(observation),(" +
                ballEvidence.toString() +
                ")(state));",
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
      schemaVersion: 3,
      scenario: scenario ?? "public-matchmaking",
      provenance: {
        collectedAt: new Date().toISOString(),
        label: process.env.MOTION_LABEL ?? null,
        scenario: scenario ?? "public-matchmaking",
        fixture: scenario
          ? "Normal resetCourt(team=1), score 1-0, ready 120 ticks; player-2 remote strikes untouched free ball at default restart position"
          : null,
        commit: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        workingTree: execFileSync("git", ["status", "--short"], {
          encoding: "utf8",
        }).trim(),
        trackedDiffSha256: createHash("sha256")
          .update(
            execFileSync("git", [
              "diff",
              "HEAD",
              "--",
              "apps",
              "packages",
              "scripts",
            ]),
          )
          .digest("hex"),
        serverSha256: createHash("sha256")
          .update(await readFile(serverEntry))
          .digest("hex"),
        node: process.version,
        platform: process.platform,
      },
      videos: {},
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
            ...(videoDir && name === "Alpha"
              ? {
                  recordVideo: {
                    dir: videoDir,
                    size: { width: 800, height: 600 },
                  },
                }
              : {}),
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
        await host.evaluate(() => (window.motionFrames = []));
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
        await host.evaluate((showSync) => {
          if (showSync) {
            const stamp = document.createElement("div");
            stamp.id = "motion-sync";
            stamp.style.cssText =
              "position:fixed;top:0;left:0;z-index:999999;background:#000;color:#fff;font:14px monospace;padding:3px;pointer-events:none";
            document.body.append(stamp);
          }
        }, Boolean(videoDir));
        if (scenario === "kick-restart") {
          await host.waitForFunction(
            () => {
              const f = window.motionFrames?.at(-1);
              return (
                f?.phase === "play" &&
                f.score === "1-0" &&
                f.evidence?.authority?.phase === "play"
              );
            },
            undefined,
            { timeout: 20000 },
          );
          for (const remote of [peer, departing]) {
            await remote.evaluate(() => (window.motionFrames = []));
            await remote.waitForFunction(
              () => window.motionFrames?.at(-1)?.phase === "play",
            );
          }
          const remoteIds = await Promise.all(
            [peer, departing].map((page) =>
              page.evaluate(() => window.motionFrames.at(-1).controlledId),
            ),
          );
          const striker = [peer, departing][remoteIds.indexOf("player-2")];
          if (!striker)
            throw Error(
              "Restart athlete is not controlled by either remote browser: " +
                remoteIds,
            );
          for (let attempt = 0; attempt < 3; attempt++) {
            await striker.keyboard.down("KeyJ");
            await delay(350);
            await striker.keyboard.up("KeyJ");
            await delay(350);
            if (
              await host.evaluate(() =>
                window.motionFrames.some(
                  (f) => f.evidence?.authority?.lastTouch === "player-2",
                ),
              )
            )
              break;
          }
          await delay(1500);
        } else {
          for (
            let i = 0;
            i <
            Number(
              process.env.MOTION_STEPS ??
                (["cryptkick", "rift-volley"].includes(sport) ? 48 : 18),
            );
            i++
          ) {
            const key = ["KeyD", "KeyS", "KeyA", "KeyW"][i % 4];
            await host.keyboard.down(key);
            await host.keyboard.down("KeyJ");
            // Hold the remote strike across simulation ticks as well; a zero-delay
            // press can fall entirely between input samples and miss the serve.
            if (["cryptkick", "rift-volley"].includes(sport))
              await peer.keyboard.down("KeyJ");
            await delay(350);
            await host.keyboard.up("KeyJ");
            if (["cryptkick", "rift-volley"].includes(sport))
              await peer.keyboard.up("KeyJ");
            await delay(260);
            await host.keyboard.up(key);
            await peer.keyboard.press(i % 2 ? "KeyK" : "KeyJ");
            if (i === 7) await departing.close();
          }
        }
        report.sports[sport] = await host.evaluate(() => window.motionFrames);
        console.log(sport, report.sports[sport].length, "render samples");
        if (host.video())
          report.videos[sport] = {
            path: await host.video().path(),
            sync: "Read the burned-in frame index to address sports[sport][frame] exactly. Video frames may repeat or omit render samples; do not infer sync from video time alone.",
            traceTimeOrigin: await host.evaluate(() => performance.timeOrigin),
          };
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const offline = process.argv[2] === "--check";
  const file =
    process.argv[offline ? 3 : 2] ??
    ".local-game-tests/matchmaking-motion.json";
  const report = offline
    ? JSON.parse(await readFile(file, "utf8"))
    : await collect();
  if (!offline) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(report));
  }
  const results = (report.selected ?? sports).map((s) =>
    inspect(s, report.sports[s] ?? [], report.scenario),
  );
  console.log(
    JSON.stringify(
      {
        file,
        provenance: report.provenance,
        videos: report.videos,
        results,
        errors: report.errors,
      },
      null,
      2,
    ),
  );
  if (report.errors.length || results.some((r) => r.failures.length))
    process.exitCode = 1;
}
