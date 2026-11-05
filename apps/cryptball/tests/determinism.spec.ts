import { mkdir, writeFile } from "node:fs/promises";
import { cpus, totalmem, platform, arch } from "node:os";
import { test, expect } from "@playwright/test";
import { runDeterminism, runReplayProfile } from "./determinism/run.ts";
import { SPORT_IDS } from "../sim/session";
import {
  runSportsDeterminism,
  runSportsReplayProfile,
} from "./determinism/sports";
const canonical = runDeterminism();
test("full match checkpoint hashes agree with Node at every tick", async ({
  page,
}, info) => {
  await page.goto("/games/cryptball/tests/determinism/");
  await page.waitForFunction(
    () => typeof (window as any).runDeterminism === "function",
  );
  const actual = (await page.evaluate(() =>
    (window as any).runDeterminism(),
  )) as ReturnType<typeof runDeterminism>;
  for (let tick = 0; tick < canonical.hashes.length; tick++)
    expect(
      actual.hashes[tick],
      `first divergent checkpoint at tick ${tick + 1}`,
    ).toBe(canonical.hashes[tick]);
  expect(actual.hashes.length).toBe(canonical.hashes.length);
  expect(actual.phase).toBe("results");
  expect(actual.scenarios).toEqual(canonical.scenarios);
  for (const scenario of actual.scenarios)
    expect(scenario.slides).toBeGreaterThan(0);
  await page.reload();
  await page.waitForFunction(
    () => typeof (window as any).runReplayProfile === "function",
  );
  const browserProfile = (await page.evaluate(() =>
    (window as any).runReplayProfile(),
  )) as ReturnType<typeof runReplayProfile>;
  const nodeProfile = runReplayProfile();
  expect(browserProfile.fixtureTick).toBe(nodeProfile.fixtureTick);
  expect(browserProfile.ballVelocity).toEqual(nodeProfile.ballVelocity);
  const browserReplayP95Ms = browserProfile.p95Ms;
  const nodeReplayP95Ms = nodeProfile.p95Ms;
  const profile = JSON.stringify(
    {
      engine: info.project.name,
      ticks: actual.hashes.length,
      scenarios: actual.scenarios,
      nodeReplayP95Ms,
      browserReplayP95Ms,
      warmupTrials: 20,
      measuredTrials: 40,
      targetP95Ms: 4,
      meetsTarget: browserReplayP95Ms <= 4 && nodeReplayP95Ms <= 4,
      frameBudgetMs: 16.67,
      hardware: {
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        memoryGiB: totalmem() / 2 ** 30,
        platform: platform(),
        arch: arch(),
      },
      aiReplanningForced: true,
      replayTicks: 12,
      scenario: "first-moving-ball-after-tick-500",
      fixtureTick: nodeProfile.fixtureTick,
      ballVelocity: nodeProfile.ballVelocity,
      ai: true,
    },
    null,
    2,
  );
  await mkdir(".local-game-tests/cryptball-determinism/profiles", {
    recursive: true,
  });
  await writeFile(
    `.local-game-tests/cryptball-determinism/profiles/${info.project.name}.json`,
    profile,
  );
  await info.attach("replay-profile.json", {
    body: profile,
    contentType: "application/json",
  });
  expect(browserReplayP95Ms).toBeLessThan(16.67);
});

test("new sports preserve complete match and takeover hashes across runtimes", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const expected = runSportsDeterminism();
  await page.goto("/games/cryptball/tests/determinism/");
  await page.waitForFunction(
    () => typeof (window as any).runSportsDeterminism === "function",
  );
  const actual = (await page.evaluate(() =>
    (window as any).runSportsDeterminism(),
  )) as ReturnType<typeof runSportsDeterminism>;
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const source = expected[i],
      result = actual[i];
    expect(result.sportId).toBe(source.sportId);
    expect(result.hashes.length).toBe(source.hashes.length);
    const mismatch = result.hashes.findIndex(
      (value, tick) => value !== source.hashes[tick],
    );
    expect(
      mismatch,
      `${source.sportId} humans=${source.humans} first divergent tick ${mismatch + 1}`,
    ).toBe(-1);
    expect(result.eventCounts).toEqual(source.eventCounts);
    expect(result.score).toEqual(source.score);
    if (!result.humans) {
      expect(result.phase, `${result.sportId} bots must finish a match`).toBe(
        "results",
      );
      if (result.sportId !== "crypt-guardian")
        expect(result.score[0] + result.score[1]).toBeGreaterThan(0);
    }
    if (result.sportId === "rift-volley")
      expect(result.maximumHeight).toBeGreaterThan(24 * 256);
  }
  for (const sportId of SPORT_IDS) {
    if (sportId === "crypt-dodge" || sportId === "crypt-guardian") continue;
    const specials = actual.filter((scenario) => scenario.sportId === sportId)
      .flatMap((scenario) => Object.keys(scenario.eventCounts).filter((key) => key.startsWith("special:")));
    for (const team of ["rams", "foxes", "owls", "gators", "bats", "hornets"])
      expect(specials, `${sportId} must exercise ${team}`).toContain(`special:${team}`);
  }
  await page.reload();
  await page.waitForFunction(
    () => typeof (window as any).runSportsReplayProfile === "function",
  );
  const browserProfiles = (await page.evaluate(() =>
    (window as any).runSportsReplayProfile(),
  )) as ReturnType<typeof runSportsReplayProfile>;
  const nodeProfiles = runSportsReplayProfile();
  for (let i = 0; i < nodeProfiles.length; i++) {
    expect(browserProfiles[i].fixtureHash).toBe(nodeProfiles[i].fixtureHash);
    expect(browserProfiles[i].p95Ms).toBeLessThan(16.67);
  }
  const report = {
    engine: info.project.name,
    scenarios: actual.map(({ hashes, ...summary }) => ({
      ...summary,
      ticks: hashes.length,
    })),
    browserProfiles,
    nodeProfiles,
    replayTicks: 12,
    warmupTrials: 20,
    measuredTrials: 40,
  };
  await mkdir("docs/evidence/cryptball-hockey-2026-11-04", { recursive: true });
  await writeFile(
    `docs/evidence/cryptball-hockey-2026-11-04/determinism-${info.project.name}.json`,
    JSON.stringify(report, null, 2),
  );
});
