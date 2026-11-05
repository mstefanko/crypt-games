import { TEAM_IDS } from "../../sim/team-identities";
import { createCryptballSession } from "../../sim/session";

const legacySports = ["cryptkick", "rift-volley", "cryptcheck"] as const;
const sports = [...legacySports, "crypt-dodge", "crypt-guardian"] as const;
function hash(value: unknown) {
  const text = JSON.stringify(value);
  let a = 2166136261,
    b = 3335557771;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b ^ text.charCodeAt(i), 2246822519);
  }
  return `${a >>> 0}:${b >>> 0}`;
}
function command(tick: number, offset = 0) {
  const t = tick + offset;
  return {
    moveX: (Math.floor(t / 73) % 3) - 1,
    moveY: (Math.floor(t / 101) % 3) - 1,
    aim: (t * 7) % 256,
    strikePressed: t % 83 === 0,
    strikeHeld: t % 83 < 26,
    strikeReleased: t % 83 === 26,
    pass: t % 137 === 0,
    passHeld: t % 137 < 95,
    slide: t % 151 === 0,
    dash: t % 179 === 0,
    check: t % 193 === 0,
    switch: t % 307 === 0,
    special: t % 181 === 0,
  };
}

/** Exercise complete bot matches and mixed input/ownership transitions in every runtime. */
export function runSportsDeterminism() {
  const scenarios = [];
  for (const sportId of sports) {
    for (const humans of [false, true]) {
      const session = createCryptballSession({ sportId, seed: 71337 });
      session.setParticipants(
        humans
          ? [
              { id: "a", team: 0, playerId: "player-0" },
              { id: "b", team: sportId === "crypt-guardian" ? 0 : 1, playerId: sportId === "crypt-guardian" ? "player-1" : "player-2" },
            ]
          : [],
      );
      const hashes: string[] = [];
      const eventCounts: Record<string, number> = {};
      let maximumHeight = 0;
      for (let tick = 0; tick < (humans ? 2400 : 30000); tick++) {
        if (humans && tick === 700) session.setParticipantActive("a", false);
        if (humans && tick === 850) session.setParticipantActive("a", true);
        session.stepParticipants(
          humans ? { a: command(tick), b: command(tick, 41) } : {},
        );
        const events = session.drainEvents();
        for (const event of events) {
          const key =
            event.type +
            (typeof event.kind === "string" ? `:${event.kind}` : "");
          eventCounts[key] = (eventCounts[key] ?? 0) + 1;
        }
        const checkpoint = session.capture();
        maximumHeight = Math.max(maximumHeight, checkpoint.state.ball.z);
        // Restore real mid-rally/mid-possession states, not just initial fixtures.
        if (tick === 333 || tick === 1100) session.restore(checkpoint);
        hashes.push(hash({ checkpoint, events }));
        if (checkpoint.state.phase === "results") break;
      }
      const final = session.observe();
      scenarios.push({
        sportId,
        humans,
        hashes,
        eventCounts,
        maximumHeight,
        phase: final.phase,
        score: final.score,
      });
    }
  }
  // Each identity is exercised in each sport, including a restore during the effect.
  for (const sportId of ["cryptball", ...legacySports] as const)
    for (const team of TEAM_IDS) {
      const session = createCryptballSession({
        sportId,
        mode: "practice",
        teamIds: [team, team === "rams" ? "foxes" : "rams"],
        seed: 71337,
      });
      session.setParticipants([
        { id: "a", team: 0, playerId: "player-0" },
        { id: "b", team: 1, playerId: "player-2" },
      ]);
      const fixture = session.capture();
      fixture.state.specials[0].cooldownTicks = 0;
      if (fixture.state.volley) {
        fixture.state.volley.serving = false;
        fixture.state.ball.z = 80 * 256;
      }
      session.restore(fixture);
      const hashes: string[] = [],
        eventCounts: Record<string, number> = {};
      let maximumHeight = 0;
      for (let tick = 0; tick < 240; tick++) {
        session.stepParticipants({
          a: {
            special: tick === 0 || tick === 18,
            moveY: tick < 18 ? 1 : -1,
            strikePressed: tick === 20,
            strikeHeld: tick >= 20 && tick < 50,
            strikeReleased: tick === 50,
          },
        });
        const events = session.drainEvents();
        for (const event of events) {
          const key =
            event.type +
            (typeof event.kind === "string" ? `:${event.kind}` : "");
          eventCounts[key] = (eventCounts[key] ?? 0) + 1;
        }
        const checkpoint = session.capture();
        maximumHeight = Math.max(maximumHeight, checkpoint.state.ball.z);
        if (tick === 8 || tick === 25 || tick === 90)
          session.restore(checkpoint);
        hashes.push(hash({ checkpoint, events }));
      }
      const final = session.observe();
      scenarios.push({
        sportId,
        humans: true,
        hashes,
        eventCounts,
        maximumHeight,
        phase: final.phase,
        score: final.score,
      });
    }
  return scenarios;
}

export function runSportsReplayProfile() {
  return sports.map((sportId) => {
    const session = createCryptballSession({ sportId, seed: 71337 });
    session.setParticipants([]);
    for (let tick = 0; tick < 1800; tick++) {
      session.stepParticipants({});
      session.drainEvents();
      const s = session.observe();
      if (
        tick > 300 &&
        s.phase === "play" &&
        (s.ball.vx || s.ball.vy) &&
        (sportId !== "rift-volley" || s.ball.z > 0)
      )
        break;
    }
    const checkpoint = session.capture();
    if (
      checkpoint.state.phase !== "play" ||
      (!checkpoint.state.ball.vx && !checkpoint.state.ball.vy)
    )
      throw Error(`No active moving-ball replay fixture for ${sportId}`);
    const elapsed: number[] = [];
    for (let trial = 0; trial < 60; trial++) {
      session.restore(checkpoint);
      const start = performance.now();
      for (let tick = 0; tick < 12; tick++) session.stepParticipants({});
      const ms = performance.now() - start;
      if (trial >= 20) elapsed.push(ms);
    }
    elapsed.sort((a, b) => a - b);
    return {
      sportId,
      fixtureTick: checkpoint.state.tick,
      fixtureHash: hash(checkpoint),
      medianMs: elapsed[Math.floor(elapsed.length * 0.5)],
      p95Ms: elapsed[Math.floor(elapsed.length * 0.95)],
    };
  });
}
