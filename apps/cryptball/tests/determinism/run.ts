import { createCryptballSession } from "../../sim/session.ts";
export { runSportsDeterminism, runSportsReplayProfile } from "./sports";

function scriptedCommand(tick: number, offset: number) {
  const t = tick + offset;
  return {
    moveX: (Math.floor(t / 90) % 3) - 1,
    moveY: (Math.floor(t / 67) % 3) - 1,
    aim: (t * 7) % 256,
    pointerAim: true,
    strikePressed: t % 80 === 0,
    strikeHeld: t % 80 < 25,
    strikeReleased: t % 80 === 25,
    dash: t % 173 === 0,
    pass: t % 191 === 0,
    slide: t % 120 === 0,
    switch: t % 239 === 0,
  };
}

/** Identical workload executes inside Node and every browser engine. */
export function runDeterminism() {
  const hashes: string[] = [];
  const scenarios: {
    name: string;
    ticks: number;
    phase: string;
    slides: number;
  }[] = [];
  for (const fullHumanRoster of [false, true]) {
    const session = createCryptballSession({ seed: 41373 });
    const seats = fullHumanRoster ? [0, 2, 1, 3] : [0, 2];
    session.setParticipants(
      seats.map((seat) => ({
        id: `human-${seat}`,
        team: (seat < 2 ? 0 : 1) as 0 | 1,
        playerId: `player-${seat}`,
      })),
    );
    const initialHashes = hashes.length;
    let slides = 0;
    for (let tick = 0; tick < 12000; tick++) {
      if (fullHumanRoster && tick === 1000)
        session.setParticipantActive("human-1", false);
      if (fullHumanRoster && tick === 1050)
        session.setParticipantActive("human-1", true);
      session.stepParticipants(
        Object.fromEntries(
          seats.map((seat, i) => [
            `human-${seat}`,
            scriptedCommand(tick, i * 37),
          ]),
        ),
      );
      slides += session
        .drainEvents()
        .filter((event) => event.type === "slide").length;
      const checkpoint = session.capture();
      if (tick === 333 || tick === 1100) session.restore(checkpoint);
      const text = JSON.stringify(checkpoint);
      // Two independent 32-bit words avoid shipping 12,000 full checkpoints.
      let first = 2166136261,
        second = 3335557771;
      for (let i = 0; i < text.length; i++) {
        first = Math.imul(first ^ text.charCodeAt(i), 16777619);
        second = Math.imul(second ^ text.charCodeAt(i), 2246822519);
      }
      hashes.push(`${first >>> 0}:${second >>> 0}`);
      if (checkpoint.state.phase === "results") break;
    }
    scenarios.push({
      name: fullHumanRoster
        ? "four-humans-field-reconnect"
        : "two-humans-two-field-bots",
      ticks: hashes.length - initialHashes,
      phase: session.capture().state.phase,
      slides,
    });
  }
  return {
    hashes,
    scenarios,
    phase: scenarios.every((s) => s.phase === "results")
      ? "results"
      : "incomplete",
  };
}

/** A fresh realm avoids checkpoint JSON/hash garbage polluting replay timings. */
export function runReplayProfile() {
  const session = createCryptballSession({ seed: 41373 });
  session.setParticipants([
    { id: "a", team: 0, playerId: "player-0" },
    { id: "b", team: 1, playerId: "player-2" },
  ]);
  for (let tick = 0; tick < 1500; tick++) {
    session.stepParticipants({
      a: scriptedCommand(tick, 0),
      b: scriptedCommand(tick, 37),
    });
    const state = session.observe();
    if (
      tick >= 500 &&
      state.phase === "play" &&
      (state.ball.vx || state.ball.vy)
    )
      break;
  }
  const replayCheckpoint = session.capture();
  if (
    replayCheckpoint.state.phase !== "play" ||
    (!replayCheckpoint.state.ball.vx && !replayCheckpoint.state.ball.vy)
  )
    throw new Error("Replay profile requires an active moving ball");
  // Force AI planning into the first replay tick instead of timing an idle gap.
  for (const player of replayCheckpoint.state.players) player.aiNext = 0;
  const replayMs: number[] = [];
  for (let trial = 0; trial < 60; trial++) {
    session.restore(replayCheckpoint);
    const start = performance.now();
    for (let tick = 0; tick < 12; tick++)
      session.stepParticipants({
        a: { moveX: 1, strikeHeld: true },
        b: { moveY: -1 },
      });
    const elapsed = performance.now() - start;
    if (trial >= 20) replayMs.push(elapsed);
  }
  replayMs.sort((a, b) => a - b);
  return {
    p95Ms: replayMs[Math.floor(replayMs.length * 0.95)],
    fixtureTick: replayCheckpoint.state.tick,
    ballVelocity: [
      replayCheckpoint.state.ball.vx,
      replayCheckpoint.state.ball.vy,
    ],
  };
}
