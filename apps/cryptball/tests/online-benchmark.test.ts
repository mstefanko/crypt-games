import { expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { MatchAuthority } from "../../cryptball-server/src/model";
import { decodeSnapshot, encodeSnapshot, heldCommand } from "../protocol";
import { createCryptballSession, SPORT_IDS } from "../sim/session";

it("measures simulation decode/restore/replay/event intake at bounded horizons with a real clock", () => {
  const report: {
    sport: string;
    horizon: number;
    samples: number;
    p95Ms: number;
    maxMs: number;
    bytes: number;
  }[] = [];
  for (const sport of SPORT_IDS) {
    const authority = new MatchAuthority("benchmark", false, sport);
    for (let i = 0; i < 4; i++) {
      authority.join(`p${i}`, "Guest");
      authority.ready(`p${i}`);
    }
    authority.start();
    for (let tick = 0; tick < 240; tick++) authority.advance();
    const bytes = encodeSnapshot(
      authority.snapshot("p0", authority.session.drainEvents()),
    );
    const session = createCryptballSession({ sportId: sport });
    for (const horizon of [12, 20, 24, 32]) {
      const timings: number[] = [];
      for (let sample = 0; sample < 120; sample++) {
        const started = performance.now();
        const snapshot = decodeSnapshot(bytes);
        session.restore(snapshot.checkpoint);
        let command = {
          moveX: 1,
          moveY: 0.5,
          aim: sample % 16,
          strikePressed: true,
          dash: true,
        };
        for (let tick = 0; tick < horizon; tick++) {
          session.stepParticipants(
            Object.fromEntries([0, 1, 2, 3].map((i) => [`p${i}`, command])),
          );
          command = heldCommand(command) as typeof command;
        }
        session.drainEvents();
        session.observeFor("p0");
        const seen = new Set<string>();
        for (const event of snapshot.events)
          seen.add(`${event.epoch}:${event.counter}`);
        if (sample >= 20) timings.push(performance.now() - started);
      }
      timings.sort((a, b) => a - b);
      report.push({
        sport,
        horizon,
        samples: timings.length,
        p95Ms: timings[Math.floor(timings.length * 0.95)]!,
        maxMs: timings.at(-1)!,
        bytes: bytes.byteLength,
      });
    }
  }
  if (process.env.CRYPTBALL_BENCHMARK_REPORT)
    writeFileSync(
      process.env.CRYPTBALL_BENCHMARK_REPORT,
      JSON.stringify(
        {
          clock: "node:perf_hooks real monotonic",
          referenceDevice:
            "local development host; not supported-device release qualification",
          scope:
            "simulation path only; excludes adapter disposition handling, correction offsets, renderer and browser costs",
          report,
        },
        null,
        2,
      ),
    );
  console.info("Cryptball real-clock replay benchmark", JSON.stringify(report));
  for (const row of report)
    expect(row.p95Ms, JSON.stringify(row)).toBeLessThan(4);
}, 30000);
