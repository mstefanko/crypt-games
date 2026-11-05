import { SlideTracker } from "./slides.mjs";
/** Observational metrics only: no inferred shots on target or fabricated saves. */
export function runMatch(
  createSession,
  { seed = 1, ticks = 7200, halfLength = 166, halfWidth = 96, config } = {},
) {
  const slideTracker = new SlideTracker();
  const session = createSession({ seed, config });
  session.setParticipants([]); // all four field players use deterministic AI
  let playTicks = 0,
    speedSum = 0,
    emptyTicks = 0,
    possessionChanges = 0;
  let firstShotTick = null,
    lastTeam = null,
    shots = 0,
    slides = 0,
    slideContacts = 0;
  const heatmap = Array(96).fill(0);
  const thirds = [0, 0, 0],
    touches = {},
    idle = {},
    goals = [0, 0];
  let previous = session.observe();
  const roster = previous.players.map((p) => ({
    id: p.id,
    team: p.team,
    role: p.role ?? (p.aiRole === "keeper" ? "keeper" : "field"),
  }));
  let lastGoalTick = 0;
  const rallies = [];
  for (let tick = 0; tick < ticks; tick++) {
    if (previous.phase === "results") break;
    session.stepParticipants({});
    const current = session.observe(),
      events = session.drainEvents();
    slideTracker.observe(previous, current, events);
    for (const event of events) {
      if (event.type === "strike") {
        shots++;
        firstShotTick ??= current.tick;
      }
      if (event.type === "slide") slides++;
      if (event.type === "slide-contact" || event.type === "slide-block")
        slideContacts++;
    }
    for (let team = 0; team < 2; team++)
      if (current.score[team] > previous.score[team]) {
        goals[team] += current.score[team] - previous.score[team];
        rallies.push((playTicks - lastGoalTick) / 60);
        lastGoalTick = playTicks;
      }
    if (previous.phase === "play") {
      playTicks++;
      const col = Math.max(
        0,
        Math.min(
          11,
          Math.floor(
            ((current.ball.x / 256 + halfLength) / (2 * halfLength)) * 12,
          ),
        ),
      );
      const row = Math.max(
        0,
        Math.min(
          7,
          Math.floor(
            ((current.ball.y / 256 + halfWidth) / (2 * halfWidth)) * 8,
          ),
        ),
      );
      heatmap[row * 12 + col]++;
      speedSum += Math.hypot(current.ball.vx, current.ball.vy) / 256;
      // Normalize thirds to observed outer actor extent only if spec is unavailable.

      thirds[
        current.ball.x / 256 < -halfLength / 3
          ? 0
          : current.ball.x / 256 > halfLength / 3
            ? 2
            : 1
      ]++;
      if (
        !current.players.some(
          (p) =>
            Math.hypot(p.x - current.ball.x, p.y - current.ball.y) <= 40 * 256,
        )
      )
        emptyTicks++;
      for (const p of current.players) {
        if (Math.hypot(p.vx, p.vy) < 256) idle[p.id] = (idle[p.id] ?? 0) + 1;
      }
      if (
        current.ball.lastTouch &&
        current.ball.lastTouch !== previous.ball.lastTouch
      ) {
        touches[current.ball.lastTouch] =
          (touches[current.ball.lastTouch] ?? 0) + 1;
        const team = current.players.find(
          (p) => p.id === current.ball.lastTouch,
        )?.team;
        if (lastTeam !== null && team !== lastTeam) possessionChanges++;
        lastTeam = team;
      }
    }
    previous = current;
  }
  const minutes = playTicks / 3600,
    perMinute = (n) => (minutes ? n / minutes : 0);
  return {
    seed,
    requestedTicks: ticks,
    elapsedTicks: previous.tick,
    playTicks,
    roster,
    score: goals,
    sampleSize: 1,
    halfLengthPx: halfLength,
    config: config ?? null,
    heatmap: { columns: 12, rows: 8, counts: heatmap },
    raw: {
      speedSum,
      emptyTicks,
      possessionChanges,
      thirds,
      touches,
      idle,
      rallies,
    },
    goalsPerMinute: perMinute(goals[0] + goals[1]),
    shots,
    shotsPerMinute: perMinute(shots),
    timeToFirstShotSeconds: firstShotTick === null ? null : firstShotTick / 60,
    meanBallSpeedPxPerSecond: playTicks ? speedSum / playTicks : 0,
    ballThirdFractions: thirds.map((n) => (playTicks ? n / playTicks : 0)),
    emptyRunningFraction: playTicks ? emptyTicks / playTicks : 0,
    possessionChangesPerMinute: perMinute(possessionChanges),
    touchChangesPerMinute: Object.fromEntries(
      roster.map((p) => [p.id, perMinute(touches[p.id] ?? 0)]),
    ),
    idleSeconds: Object.fromEntries(
      roster.map((p) => [p.id, (idle[p.id] ?? 0) / 60]),
    ),
    slides,
    slideContacts,
    meanCompletedRallySeconds: rallies.length
      ? rallies.reduce((a, b) => a + b, 0) / rallies.length
      : null,
    shotsOnTarget: null,
    savePercentage: null,
    slideWhiffs: slideTracker.result(previous.tick).whiffs,
    slideOutcomes: slideTracker.result(previous.tick),
  };
}
