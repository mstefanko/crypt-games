import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { runMatch } from "./metrics.mjs";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const args = process.argv.slice(2);
const option = (key, fallback) => {
  const i = args.indexOf(key);
  return i < 0 ? fallback : args[i + 1];
};
const ticks = Number(option("--ticks", "7200"));
const seeds = option("--seeds", "1,2,3").split(",").map(Number);
if (
  !Number.isSafeInteger(ticks) ||
  ticks < 1 ||
  ticks > 1000000 ||
  seeds.some((n) => !Number.isSafeInteger(n))
)
  throw Error("Invalid seeds or ticks");
const temporary = await mkdtemp(join(tmpdir(), "cryptball-lab-"));
try {
  let sim = option("--sim", null);
  if (!sim) {
    sim = join(temporary, "sim.mjs");
    await build({
      absWorkingDir: root,
      entryPoints: ["apps/cryptball/sim/session.ts"],
      outfile: sim,
      bundle: true,
      platform: "node",
      format: "esm",
    });
  }
  const { createCryptballSession } = await import(
    pathToFileURL(resolve(sim)).href
  );
  const sweep = option("--slide-speeds", null);
  if (sweep && option("--sim", null))
    throw Error("Cannot sweep archived simulation");
  const speeds = sweep ? sweep.split(",").map(Number) : [null];
  if (
    speeds.some(
      (n) => n !== null && (!Number.isInteger(n) || n < 120 || n > 380),
    )
  )
    throw Error("Invalid slide speed");
  const matches = speeds.flatMap((slideLaunchSpeed) =>
    seeds.map((seed) =>
      runMatch(createCryptballSession, {
        seed,
        ticks,
        halfLength: Number(option("--half-length", "166")),
        halfWidth: Number(option("--half-width", "96")),
        config:
          slideLaunchSpeed === null
            ? undefined
            : { slideLaunchSpeed, slideEndSpeed: 120 },
      }),
    ),
  );
  const rankedDiagnostics = speeds
    .map((speed) => {
      const group = matches.filter(
        (m) => (m.config?.slideLaunchSpeed ?? null) === speed,
      );
      const mean = (key) =>
        group.reduce((sum, m) => sum + m[key], 0) / group.length;
      return {
        slideLaunchSpeed: speed,
        samples: group.length,
        goalsPerMinute: mean("goalsPerMinute"),
        shotsPerMinute: mean("shotsPerMinute"),
        emptyRunningFraction: mean("emptyRunningFraction"),
        slideInterceptFraction:
          group.reduce((sum, m) => sum + m.slideOutcomes.intercepts, 0) /
          Math.max(
            1,
            group.reduce(
              (sum, m) =>
                sum +
                m.slideOutcomes.attempts -
                m.slideOutcomes.pendingAttempts,
              0,
            ),
          ),
        slideWhiffs: group.reduce((sum, m) => sum + m.slideWhiffs, 0),
      };
    })
    .sort((a, b) => b.goalsPerMinute - a.goalsPerMinute);
  const report = {
    schema: 1,
    label: option("--label", "current"),
    command: process.argv.slice(2),
    simulationSha256: createHash("sha256")
      .update(await readFile(sim))
      .digest("hex"),
    rankedDiagnostics,
    ranking:
      "Descending goals/min diagnostic only; no best or preferred candidate is inferred.",
    matches,
    limitations: [
      "Shots count strike contact events; shots on target and save percentage require shot trajectory attribution and are null.",
      "Touches count changes in lastTouch; consecutive touches by the same player are not counted.",
      "Idle means speed below 1 px/s during play; completed rallies measure play time between goals.",
      "Thirds use explicit --half-length extent (default 166 px); no human preference is measured.",
    ],
  };
  const output = resolve(root, option("--out", "generated/lab/current.json"));
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  if (sweep) {
    const panels = speeds
      .map((speed, index) => {
        const group = matches.filter(
          (m) => m.config?.slideLaunchSpeed === speed,
        );
        const counts = Array.from({ length: 96 }, (_, i) =>
          group.reduce((sum, m) => sum + m.heatmap.counts[i], 0),
        );
        const max = Math.max(1, ...counts);
        return `<g transform="translate(12 ${index * 210 + 12})"><text x="0" y="15">Slide launch ${speed} px/s; ${group.length} paired seeds</text>${counts.map((n, i) => `<rect x="${(i % 12) * 24}" y="${Math.floor(i / 12) * 20 + 25}" width="23" height="19" fill="rgb(${Math.round((255 * n) / max)},${Math.round(80 + (140 * n) / max)},90)"/>`).join("")}</g>`;
      })
      .join("");
    await writeFile(
      output.replace(/\.json$/, " ").trim() + ".svg",
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="${speeds.length * 210}" style="background:#eee;font:13px sans-serif">${panels}</svg>`,
    );
  }
  console.log(
    JSON.stringify(
      {
        output,
        matches: matches.map(
          ({ seed, goalsPerMinute, shots, emptyRunningFraction }) => ({
            seed,
            goalsPerMinute,
            shots,
            emptyRunningFraction,
          }),
        ),
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
