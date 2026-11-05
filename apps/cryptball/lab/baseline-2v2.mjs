// packages/game-simulation/src/rng.ts
var RANDOM_ALGORITHM = "splitmix32-21f0aaad-735a2d97-v1";
var RANDOM_LIMITS = Object.freeze({
  streams: 16,
  draws: 1e6,
  attempts: 64
});
var RANGE = 4294967296;
var INCREMENT = 2654435769;
function integer(value, min, max) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw Error("Invalid random integer");
  return value;
}
function identity(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9.-]{0,63}$/.test(value))
    throw Error("Invalid random stream identity");
  return value;
}
function object(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    throw Error("Invalid random snapshot fields");
  return value;
}
function mix(value) {
  value = Math.imul(value ^ value >>> 16, 569420461) >>> 0;
  value = Math.imul(value ^ value >>> 15, 1935289751) >>> 0;
  return (value ^ value >>> 15) >>> 0;
}
function raw(state) {
  state = state + INCREMENT >>> 0;
  return { state, value: mix(state) };
}
var DeterministicRandom = class {
  definitions;
  streams;
  constructor(definitions) {
    if (!Array.isArray(definitions) || definitions.length < 1 || definitions.length > RANDOM_LIMITS.streams)
      throw Error("Random stream cap exceeded");
    this.definitions = Array.from(definitions, (definition) => {
      const source = object(definition, ["name", "owner", "seed"]);
      return {
        name: identity(source.name),
        owner: identity(source.owner),
        seed: integer(source.seed, 0, RANGE - 1)
      };
    }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (this.definitions.some(
      (definition, i) => i > 0 && definition.name === this.definitions[i - 1].name
    ))
      throw Error("Duplicate random stream");
    this.streams = this.definitions.map((definition) => ({
      ...definition,
      state: definition.seed,
      draws: 0
    }));
  }
  stream(owner, name) {
    const index = this.streams.findIndex((stream) => stream.name === name);
    if (index < 0 || this.streams[index].owner !== owner)
      throw Error("Random stream owner mismatch");
    return index;
  }
  /** A singleton range still consumes one draw; the full uint32 range is valid. */
  drawInteger(owner, name, maxExclusive) {
    integer(maxExclusive, 1, RANGE);
    const index = this.stream(owner, name);
    let stream = { ...this.streams[index] };
    const ceiling = Math.floor(RANGE / maxExclusive) * maxExclusive;
    for (let attempt = 0; attempt < RANDOM_LIMITS.attempts; attempt++) {
      if (stream.draws === RANDOM_LIMITS.draws)
        throw Error("Random draw cap exceeded");
      const draw = raw(stream.state);
      stream = { ...stream, state: draw.state, draws: stream.draws + 1 };
      if (draw.value < ceiling) {
        this.streams[index] = stream;
        return draw.value % maxExclusive;
      }
    }
    throw Error("Random rejection attempt cap exceeded");
  }
  drawUint32(owner, name) {
    return this.drawInteger(owner, name, RANGE);
  }
  capture() {
    return {
      algorithm: RANDOM_ALGORITHM,
      streams: this.streams.map((stream) => ({ ...stream }))
    };
  }
  /** Exact configured names, owners, seeds, order and state/counter consistency.
   * Stages the complete bounded value before replacing any committed stream. */
  restore(value) {
    const source = object(value, ["algorithm", "streams"]);
    if (source.algorithm !== RANDOM_ALGORITHM || !Array.isArray(source.streams) || source.streams.length !== this.definitions.length)
      throw Error("Incompatible random snapshot");
    const restoredStreams = source.streams;
    const staged = this.definitions.map((definition, i) => {
      const stream = object(restoredStreams[i], [
        "name",
        "owner",
        "seed",
        "state",
        "draws"
      ]);
      if (stream.name !== definition.name || stream.owner !== definition.owner || stream.seed !== definition.seed)
        throw Error("Incompatible random stream");
      const state = integer(stream.state, 0, RANGE - 1);
      const draws = integer(stream.draws, 0, RANDOM_LIMITS.draws);
      if (state !== definition.seed + Math.imul(INCREMENT, draws) >>> 0)
        throw Error("Inconsistent random state and draw count");
      return { ...definition, state, draws };
    });
    this.streams = staged;
  }
};

// apps/cryptball/sim/checkpoint.ts
function validateCheckpoint(value, configured) {
  if (!value || typeof value !== "object") throw Error("Invalid checkpoint");
  const checkpoint = structuredClone(value);
  if (checkpoint.version !== 2 || !checkpoint.state || !checkpoint.rng)
    throw Error("Incompatible checkpoint");
  const s = checkpoint.state;
  const bounded = (n, min, max) => {
    if (!Number.isSafeInteger(n) || n < min || n > max)
      throw Error("Invalid checkpoint integer");
  };
  let nodes = 0;
  function finite(v, depth = 0) {
    if (++nodes > 4096 || depth > 12) throw Error("Checkpoint bounds exceeded");
    if (typeof v === "number") {
      if (!Number.isFinite(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER)
        throw Error("Invalid checkpoint number");
    } else if (typeof v === "string") {
      if (v.length > 96) throw Error("Checkpoint string too long");
    } else if (v && typeof v === "object") {
      if (Array.isArray(v) && v.length > 64)
        throw Error("Checkpoint array too long");
      for (const x of Object.values(v)) finite(x, depth + 1);
    } else if (v !== null && v !== void 0 && typeof v !== "boolean")
      throw Error("Invalid checkpoint value");
  }
  finite(s);
  bounded(s.tick, 0, 1e7);
  bounded(s.epoch, 1, 2147483647);
  bounded(s.nextAction, 1, 1e7);
  bounded(s.nextEvent, 0, 1e8);
  if (!["match", "practice"].includes(s.mode) || !["ready", "play", "goal", "results"].includes(s.phase) || !Array.isArray(s.players) || s.players.length !== 4 || !Array.isArray(s.controllers) || s.controllers.length > 4 || !Array.isArray(s.events) || s.events.length !== 0)
    throw Error("Invalid checkpoint state");
  bounded(s.remainingTicks, 0, 7200);
  bounded(s.phaseTicks, 0, 1800);
  bounded(s.score?.[0], 0, 1e4);
  bounded(s.score?.[1], 0, 1e4);
  if (s.score.length !== 2 || typeof s.overtime !== "boolean" || ![0, 1, "draw", null].includes(s.winner) || ![0, 1, null].includes(s.restartTeam) || ![0, 1, null].includes(s.goalTeam))
    throw Error("Invalid match fields");
  bounded(s.restartProtection, 0, 60);
  bounded(s.switchReady, 0, 10000100);
  bounded(s.touchTick, -100, 1e7);
  const ids = s.players.map((p) => p.id);
  for (const [i, p] of s.players.entries()) {
    if (p.id !== `player-${i}` || p.team !== (i < 2 ? 0 : 1) || !["warrior", "knight"].includes(p.archetype))
      throw Error("Invalid athlete");
    for (const key of ["x", "y", "vx", "vy", "rx", "ry"])
      bounded(p[key], -2e5, 2e5);
    for (const flag of [p.charging, p.checked, p.guardContact, p.aiPass])
      if (typeof flag !== "boolean") throw Error("Invalid athlete flag");
    if (typeof p.aiRole !== "string" || !["support", "intercept", "defend-lane", "feed"].includes(p.aiRole))
      throw Error("Invalid AI role");
    for (const n of [p.aiX, p.aiY]) bounded(n, -2e5, 2e5);
    bounded(p.aiAim, 0, 255);
    bounded(p.dashHeading, 0, 255);
    bounded(p.distance, 0, 1e9);
    bounded(p.roleTouch, -100, 1e7);
    bounded(p.heading, 0, 255);
    bounded(p.chargeTicks, 0, 42);
    bounded(p.guardTicks, 0, 1e7);
    for (const key of [
      "dashTicks",
      "dashCooldown",
      "staggerTicks",
      "immunityTicks",
      "guardRecovery",
      "guardPerfectUntil",
      "perfectReady",
      "aiNext",
      "aiGuardStart",
      "aiGuardUntil",
      "roleUntil"
    ])
      bounded(p[key], 0, 10000100);
    if (p.buffer) {
      if (!["strike", "pass"].includes(p.buffer.kind))
        throw Error("Invalid action buffer");
      bounded(p.buffer.until, 0, 10000100);
      bounded(p.buffer.charge, 0, 24);
    }
    if (p.action) {
      if (!["strike", "pass"].includes(p.action.kind) || !Array.isArray(p.action.hits) || p.action.hits.length > 5 || p.action.hits.some((h) => typeof h !== "string"))
        throw Error("Invalid action");
      if (Object.keys(p.action.timing).sort().join(",") !== "active,recover,tell")
        throw Error("Invalid timing");
      if (p.action.heading !== void 0) bounded(p.action.heading, 0, 255);
      if (p.action.charge !== void 0) bounded(p.action.charge, 0, 24);
      bounded(p.action.id, 1, s.nextAction);
      bounded(p.action.elapsed, 0, 100);
      for (const n of Object.values(p.action.timing)) bounded(n, 0, 100);
      if (p.action.targetId && !ids.includes(p.action.targetId))
        throw Error("Invalid action target");
    }
  }
  const used = /* @__PURE__ */ new Set(), participants = /* @__PURE__ */ new Set();
  for (const c of s.controllers) {
    if (typeof c.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(c.id) || participants.has(c.id) || used.has(c.playerId) || !s.players.some((p) => p.id === c.playerId && p.team === c.team) || typeof c.active !== "boolean" || typeof c.canSwitch !== "boolean")
      throw Error("Invalid controller");
    participants.add(c.id);
    used.add(c.playerId);
    bounded(c.revision, 0, 1e7);
    bounded(c.switchReady, 0, 10000100);
    if (c.pendingSwitch && !s.players.some((p) => p.id === c.pendingSwitch && p.team === c.team))
      throw Error("Invalid switch");
  }
  for (const key of ["x", "y", "vx", "vy", "rx", "ry"])
    bounded(s.ball[key], -2e5, 2e5);
  if (![0, 1, null].includes(s.ball.passTeam) || ![0, 1, null].includes(s.ball.powerTeam))
    throw Error("Invalid ball team");
  bounded(s.ball.passTick, 0, 1e7);
  bounded(s.ball.powerExpires, 0, 10000100);
  bounded(s.ball.bankBonusRemaining, 0, 1);
  bounded(s.ball.dragCarry, 0, 1e5);
  if (s.ball.powerActionKey !== null)
    bounded(s.ball.powerActionKey, 1, s.nextAction);
  if (!ids.includes(s.controlledId)) throw Error("Invalid controlled athlete");
  for (const ref of [
    s.ball.lastTouch,
    s.ball.passFrom,
    s.ball.passTarget,
    s.pendingSwitch
  ])
    if (ref !== null && !ids.includes(ref))
      throw Error("Invalid ball reference");
  if (!Array.isArray(s.teamStats) || s.teamStats.length !== 2)
    throw Error("Invalid statistics");
  if (Object.keys(s.participantStats).sort().join(",") !== [...participants].sort().join(","))
    throw Error("Invalid participant statistics");
  for (const stats of [...s.teamStats, ...Object.values(s.participantStats)])
    for (const n of [stats.shots, stats.goals, stats.passes])
      bounded(n, 0, 1e5);
  if (!Array.isArray(checkpoint.rng.streams) || checkpoint.rng.streams.length !== configured.streams.length || checkpoint.rng.streams.some(
    (stream, i) => stream.name !== configured.streams[i].name || stream.owner !== configured.streams[i].owner
  ))
    throw Error("Invalid random ownership");
  const stagedRng = new DeterministicRandom(
    checkpoint.rng.streams.map(({ owner, name, seed }) => ({
      owner,
      name,
      seed
    }))
  );
  stagedRng.restore(checkpoint.rng);
  return checkpoint;
}

// packages/game-simulation/src/tick-deadline.ts
function validateTick(tick) {
  if (!Number.isSafeInteger(tick) || tick < 0)
    throw new Error("Tick must be a nonnegative safe integer");
  return tick;
}

// apps/cryptball/sim/rules.ts
var FIXED = 256;
var RULES = Object.freeze({
  version: 2,
  hz: 60,
  substeps: 4,
  regulationTicks: 5400,
  overtimeTicks: 1800,
  readyTicks: 60,
  celebrationTicks: 54,
  restartReadyTicks: 24,
  playerRadius: 7 * FIXED,
  ballRadius: 3 * FIXED,
  runSpeed: 96 * FIXED,
  dashSpeed: 192 * FIXED,
  shotSpeed: 250 * FIXED,
  maxBallSpeed: 380 * FIXED,
  passSpeed: 210 * FIXED,
  reach: 19 * FIXED,
  chargeCap: 24,
  dashTicks: 10,
  dashReuse: 66,
  staggerTicks: 10,
  immunityTicks: 36,
  drag: 30 * FIXED,
  restSpeed: 8 * FIXED
});
var DIRECTIONS = [
  { x: 65536, y: 0 },
  { x: 65516, y: 1608 },
  { x: 65457, y: 3216 },
  { x: 65358, y: 4821 },
  { x: 65220, y: 6424 },
  { x: 65043, y: 8022 },
  { x: 64827, y: 9616 },
  { x: 64571, y: 11204 },
  { x: 64277, y: 12785 },
  { x: 63944, y: 14359 },
  { x: 63572, y: 15924 },
  { x: 63162, y: 17479 },
  { x: 62714, y: 19024 },
  { x: 62228, y: 20557 },
  { x: 61705, y: 22078 },
  { x: 61145, y: 23586 },
  { x: 60547, y: 25080 },
  { x: 59914, y: 26558 },
  { x: 59244, y: 28020 },
  { x: 58538, y: 29466 },
  { x: 57798, y: 30893 },
  { x: 57022, y: 32303 },
  { x: 56212, y: 33692 },
  { x: 55368, y: 35062 },
  { x: 54491, y: 36410 },
  { x: 53581, y: 37736 },
  { x: 52639, y: 39040 },
  { x: 51665, y: 40320 },
  { x: 50660, y: 41576 },
  { x: 49624, y: 42806 },
  { x: 48559, y: 44011 },
  { x: 47464, y: 45190 },
  { x: 46341, y: 46341 },
  { x: 45190, y: 47464 },
  { x: 44011, y: 48559 },
  { x: 42806, y: 49624 },
  { x: 41576, y: 50660 },
  { x: 40320, y: 51665 },
  { x: 39040, y: 52639 },
  { x: 37736, y: 53581 },
  { x: 36410, y: 54491 },
  { x: 35062, y: 55368 },
  { x: 33692, y: 56212 },
  { x: 32303, y: 57022 },
  { x: 30893, y: 57798 },
  { x: 29466, y: 58538 },
  { x: 28020, y: 59244 },
  { x: 26558, y: 59914 },
  { x: 25080, y: 60547 },
  { x: 23586, y: 61145 },
  { x: 22078, y: 61705 },
  { x: 20557, y: 62228 },
  { x: 19024, y: 62714 },
  { x: 17479, y: 63162 },
  { x: 15924, y: 63572 },
  { x: 14359, y: 63944 },
  { x: 12785, y: 64277 },
  { x: 11204, y: 64571 },
  { x: 9616, y: 64827 },
  { x: 8022, y: 65043 },
  { x: 6424, y: 65220 },
  { x: 4821, y: 65358 },
  { x: 3216, y: 65457 },
  { x: 1608, y: 65516 },
  { x: 0, y: 65536 },
  { x: -1608, y: 65516 },
  { x: -3216, y: 65457 },
  { x: -4821, y: 65358 },
  { x: -6424, y: 65220 },
  { x: -8022, y: 65043 },
  { x: -9616, y: 64827 },
  { x: -11204, y: 64571 },
  { x: -12785, y: 64277 },
  { x: -14359, y: 63944 },
  { x: -15924, y: 63572 },
  { x: -17479, y: 63162 },
  { x: -19024, y: 62714 },
  { x: -20557, y: 62228 },
  { x: -22078, y: 61705 },
  { x: -23586, y: 61145 },
  { x: -25080, y: 60547 },
  { x: -26558, y: 59914 },
  { x: -28020, y: 59244 },
  { x: -29466, y: 58538 },
  { x: -30893, y: 57798 },
  { x: -32303, y: 57022 },
  { x: -33692, y: 56212 },
  { x: -35062, y: 55368 },
  { x: -36410, y: 54491 },
  { x: -37736, y: 53581 },
  { x: -39040, y: 52639 },
  { x: -40320, y: 51665 },
  { x: -41576, y: 50660 },
  { x: -42806, y: 49624 },
  { x: -44011, y: 48559 },
  { x: -45190, y: 47464 },
  { x: -46341, y: 46341 },
  { x: -47464, y: 45190 },
  { x: -48559, y: 44011 },
  { x: -49624, y: 42806 },
  { x: -50660, y: 41576 },
  { x: -51665, y: 40320 },
  { x: -52639, y: 39040 },
  { x: -53581, y: 37736 },
  { x: -54491, y: 36410 },
  { x: -55368, y: 35062 },
  { x: -56212, y: 33692 },
  { x: -57022, y: 32303 },
  { x: -57798, y: 30893 },
  { x: -58538, y: 29466 },
  { x: -59244, y: 28020 },
  { x: -59914, y: 26558 },
  { x: -60547, y: 25080 },
  { x: -61145, y: 23586 },
  { x: -61705, y: 22078 },
  { x: -62228, y: 20557 },
  { x: -62714, y: 19024 },
  { x: -63162, y: 17479 },
  { x: -63572, y: 15924 },
  { x: -63944, y: 14359 },
  { x: -64277, y: 12785 },
  { x: -64571, y: 11204 },
  { x: -64827, y: 9616 },
  { x: -65043, y: 8022 },
  { x: -65220, y: 6424 },
  { x: -65358, y: 4821 },
  { x: -65457, y: 3216 },
  { x: -65516, y: 1608 },
  { x: -65536, y: 0 },
  { x: -65516, y: -1608 },
  { x: -65457, y: -3216 },
  { x: -65358, y: -4821 },
  { x: -65220, y: -6424 },
  { x: -65043, y: -8022 },
  { x: -64827, y: -9616 },
  { x: -64571, y: -11204 },
  { x: -64277, y: -12785 },
  { x: -63944, y: -14359 },
  { x: -63572, y: -15924 },
  { x: -63162, y: -17479 },
  { x: -62714, y: -19024 },
  { x: -62228, y: -20557 },
  { x: -61705, y: -22078 },
  { x: -61145, y: -23586 },
  { x: -60547, y: -25080 },
  { x: -59914, y: -26558 },
  { x: -59244, y: -28020 },
  { x: -58538, y: -29466 },
  { x: -57798, y: -30893 },
  { x: -57022, y: -32303 },
  { x: -56212, y: -33692 },
  { x: -55368, y: -35062 },
  { x: -54491, y: -36410 },
  { x: -53581, y: -37736 },
  { x: -52639, y: -39040 },
  { x: -51665, y: -40320 },
  { x: -50660, y: -41576 },
  { x: -49624, y: -42806 },
  { x: -48559, y: -44011 },
  { x: -47464, y: -45190 },
  { x: -46341, y: -46341 },
  { x: -45190, y: -47464 },
  { x: -44011, y: -48559 },
  { x: -42806, y: -49624 },
  { x: -41576, y: -50660 },
  { x: -40320, y: -51665 },
  { x: -39040, y: -52639 },
  { x: -37736, y: -53581 },
  { x: -36410, y: -54491 },
  { x: -35062, y: -55368 },
  { x: -33692, y: -56212 },
  { x: -32303, y: -57022 },
  { x: -30893, y: -57798 },
  { x: -29466, y: -58538 },
  { x: -28020, y: -59244 },
  { x: -26558, y: -59914 },
  { x: -25080, y: -60547 },
  { x: -23586, y: -61145 },
  { x: -22078, y: -61705 },
  { x: -20557, y: -62228 },
  { x: -19024, y: -62714 },
  { x: -17479, y: -63162 },
  { x: -15924, y: -63572 },
  { x: -14359, y: -63944 },
  { x: -12785, y: -64277 },
  { x: -11204, y: -64571 },
  { x: -9616, y: -64827 },
  { x: -8022, y: -65043 },
  { x: -6424, y: -65220 },
  { x: -4821, y: -65358 },
  { x: -3216, y: -65457 },
  { x: -1608, y: -65516 },
  { x: 0, y: -65536 },
  { x: 1608, y: -65516 },
  { x: 3216, y: -65457 },
  { x: 4821, y: -65358 },
  { x: 6424, y: -65220 },
  { x: 8022, y: -65043 },
  { x: 9616, y: -64827 },
  { x: 11204, y: -64571 },
  { x: 12785, y: -64277 },
  { x: 14359, y: -63944 },
  { x: 15924, y: -63572 },
  { x: 17479, y: -63162 },
  { x: 19024, y: -62714 },
  { x: 20557, y: -62228 },
  { x: 22078, y: -61705 },
  { x: 23586, y: -61145 },
  { x: 25080, y: -60547 },
  { x: 26558, y: -59914 },
  { x: 28020, y: -59244 },
  { x: 29466, y: -58538 },
  { x: 30893, y: -57798 },
  { x: 32303, y: -57022 },
  { x: 33692, y: -56212 },
  { x: 35062, y: -55368 },
  { x: 36410, y: -54491 },
  { x: 37736, y: -53581 },
  { x: 39040, y: -52639 },
  { x: 40320, y: -51665 },
  { x: 41576, y: -50660 },
  { x: 42806, y: -49624 },
  { x: 44011, y: -48559 },
  { x: 45190, y: -47464 },
  { x: 46341, y: -46341 },
  { x: 47464, y: -45190 },
  { x: 48559, y: -44011 },
  { x: 49624, y: -42806 },
  { x: 50660, y: -41576 },
  { x: 51665, y: -40320 },
  { x: 52639, y: -39040 },
  { x: 53581, y: -37736 },
  { x: 54491, y: -36410 },
  { x: 55368, y: -35062 },
  { x: 56212, y: -33692 },
  { x: 57022, y: -32303 },
  { x: 57798, y: -30893 },
  { x: 58538, y: -29466 },
  { x: 59244, y: -28020 },
  { x: 59914, y: -26558 },
  { x: 60547, y: -25080 },
  { x: 61145, y: -23586 },
  { x: 61705, y: -22078 },
  { x: 62228, y: -20557 },
  { x: 62714, y: -19024 },
  { x: 63162, y: -17479 },
  { x: 63572, y: -15924 },
  { x: 63944, y: -14359 },
  { x: 64277, y: -12785 },
  { x: 64571, y: -11204 },
  { x: 64827, y: -9616 },
  { x: 65043, y: -8022 },
  { x: 65220, y: -6424 },
  { x: 65358, y: -4821 },
  { x: 65457, y: -3216 },
  { x: 65516, y: -1608 }
];
function headingVector(h) {
  return DIRECTIONS[(Math.round(h) % 256 + 256) % 256];
}
function aimHeading(x, y) {
  if (!x && !y) return 0;
  let best = 0, score = -Infinity;
  for (let i = 0; i < DIRECTIONS.length; i++) {
    const d = DIRECTIONS[i], dot = x * d.x + y * d.y;
    const candidate = dot;
    if (candidate > score) {
      best = i;
      score = candidate;
    }
  }
  return best;
}
var ROOT_SEEDS = [
  1,
  2,
  4,
  8,
  16,
  32,
  64,
  128,
  256,
  512,
  1024,
  2048,
  4096,
  8192,
  16384,
  32768,
  65536,
  131072,
  262144,
  524288,
  1048576,
  2097152,
  4194304,
  8388608,
  16777216,
  33554432,
  67108864,
  134217728
];
function integerSqrt(n) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw Error("Invalid square-root domain");
  if (n < 2) return n;
  let low = 0, high = ROOT_SEEDS.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (ROOT_SEEDS[mid] * ROOT_SEEDS[mid] < n) low = mid + 1;
    else high = mid;
  }
  let root = ROOT_SEEDS[low];
  for (; ; ) {
    const next = Math.floor((root + Math.floor(n / root)) / 2);
    if (next >= root) break;
    root = next;
  }
  while (root * root > n) root--;
  while ((root + 1) * (root + 1) <= n) root++;
  return root;
}
function length(x, y) {
  const ax = Math.round(x * 256), ay = Math.round(y * 256);
  const squared2 = ax * ax + ay * ay;
  if (Number.isSafeInteger(squared2)) return integerSqrt(squared2) / 256;
  const n = BigInt(ax) * BigInt(ax) + BigInt(ay) * BigInt(ay);
  let lo = 0n, hi = n + 1n;
  while (hi - lo > 1n) {
    const m = (lo + hi) / 2n;
    if (m * m <= n) lo = m;
    else hi = m;
  }
  return Number(lo) / 256;
}
function normalized(x, y) {
  const n = length(x, y);
  return n ? { x: x / n, y: y / n } : { x: 0, y: 0 };
}

// packages/game-simulation/src/action-timeline.ts
function actionPhase(action) {
  const { tell, active, recover } = action.timing;
  const t = action.elapsed;
  if (t < tell) return { phase: "tell", progress: t / Math.max(1e-3, tell) };
  if (t < tell + active)
    return { phase: "active", progress: (t - tell) / Math.max(1e-3, active) };
  if (t < tell + active + recover)
    return {
      phase: "recover",
      progress: (t - tell - active) / Math.max(1e-3, recover)
    };
  return { phase: "done", progress: 1 };
}
function claimActionHit(action, target) {
  if (action.hits.includes(target)) return false;
  action.hits.push(target);
  return true;
}

// packages/game-simulation/src/geometry.ts
var GEOMETRY_LIMITS = Object.freeze({
  unitsPerPixel: 256,
  coordinate: 262144,
  terrainCellPixels: 16,
  terrainCellUnits: 4096,
  terrainCellsPerAxis: 64,
  displacement: 8192,
  shapes: 256,
  identityLength: 96,
  priority: 1024
});
var GEOMETRY_PHASES = Object.freeze([
  "commands",
  "controller-intent",
  "movement-queries",
  "gather-effects",
  "commit",
  "observations"
]);

// packages/game-simulation/src/circle-geometry.ts
var CIRCLE_LIMITS = Object.freeze({
  coordinate: GEOMETRY_LIMITS.coordinate,
  radius: 4096,
  displacement: GEOMETRY_LIMITS.displacement,
  shapes: GEOMETRY_LIMITS.shapes,
  timeScale: 65536
});
function circleInteger(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw Error("Circle geometry integer outside supported bounds");
}
function point(p) {
  circleInteger(p.x, -CIRCLE_LIMITS.coordinate, CIRCLE_LIMITS.coordinate);
  circleInteger(p.y, -CIRCLE_LIMITS.coordinate, CIRCLE_LIMITS.coordinate);
}
function validateGeometryCircle(c) {
  point(c);
  circleInteger(c.radius, 1, CIRCLE_LIMITS.radius);
  point({ x: c.x - c.radius, y: c.y - c.radius });
  point({ x: c.x + c.radius, y: c.y + c.radius });
}
function rect(r) {
  point(r);
  circleInteger(r.width, 1, CIRCLE_LIMITS.coordinate);
  circleInteger(r.height, 1, CIRCLE_LIMITS.coordinate);
  point({ x: r.x + r.width, y: r.y + r.height });
}
function motion(p, d) {
  circleInteger(d.x, -CIRCLE_LIMITS.displacement, CIRCLE_LIMITS.displacement);
  circleInteger(d.y, -CIRCLE_LIMITS.displacement, CIRCLE_LIMITS.displacement);
  if (d.x * d.x + d.y * d.y > CIRCLE_LIMITS.displacement * CIRCLE_LIMITS.displacement)
    throw Error("Circle displacement cap exceeded");
  point({ x: p.x + d.x, y: p.y + d.y });
}
function nearest(p, r) {
  return {
    x: Math.max(r.x, Math.min(p.x, r.x + r.width)),
    y: Math.max(r.y, Math.min(p.y, r.y + r.height))
  };
}
function squared(x, y) {
  return x * x + y * y;
}
function circleOverlapsCircle(a, b) {
  validateGeometryCircle(a);
  validateGeometryCircle(b);
  return squared(a.x - b.x, a.y - b.y) <= (a.radius + b.radius) * (a.radius + b.radius);
}
function circleOverlapsRect(c, r) {
  validateGeometryCircle(c);
  rect(r);
  const p = nearest(c, r);
  return squared(c.x - p.x, c.y - p.y) <= c.radius * c.radius;
}
function integerSqrt2(n) {
  let lo = 0n, hi = n + 1n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (mid * mid <= n) lo = mid;
    else hi = mid;
  }
  return lo;
}
function ceilDiv(n, d) {
  return n >= 0n ? (n + d - 1n) / d : n / d;
}
function diskEntry(p, d, center, radius) {
  const x = BigInt(p.x - center.x), y = BigInt(p.y - center.y);
  const dx = BigInt(d.x), dy = BigInt(d.y), r = BigInt(radius);
  const a = dx * dx + dy * dy;
  const b = 2n * (x * dx + y * dy);
  const c = x * x + y * y - r * r;
  if (c <= 0n) return 0;
  if (a === 0n || b >= 0n) return null;
  const discriminant = b * b - 4n * a * c;
  if (discriminant < 0n) return null;
  if (-b > 2n * a && (b + 2n * a) * (b + 2n * a) > discriminant) return null;
  const scale = BigInt(CIRCLE_LIMITS.timeScale);
  const root = integerSqrt2(discriminant * scale * scale);
  const tick = Number(ceilDiv(-b * scale - root, 2n * a));
  return tick <= CIRCLE_LIMITS.timeScale ? tick : null;
}
function boxEntry(p, d, r) {
  let n = 0, den = 1, farN = 1, farD = 1;
  for (const [origin, speed, min, max] of [
    [p.x, d.x, r.x, r.x + r.width],
    [p.y, d.y, r.y, r.y + r.height]
  ]) {
    if (speed === 0) {
      if (origin < min || origin > max) return null;
      continue;
    }
    const divisor = Math.abs(speed);
    const a = speed > 0 ? min - origin : origin - max;
    const b = speed > 0 ? max - origin : origin - min;
    if (a * den > n * divisor) {
      n = a;
      den = divisor;
    }
    if (b * farD < farN * divisor) {
      farN = b;
      farD = divisor;
    }
  }
  if (n * farD > farN * den) return null;
  return Math.ceil(n * CIRCLE_LIMITS.timeScale / den);
}
function initial(p, d, center, radius) {
  const x = p.x - center.x, y = p.y - center.y;
  const distance2 = squared(x, y), r2 = radius * radius;
  if (distance2 < r2) return 0;
  if (distance2 === r2) {
    if (d.x === 0 && d.y === 0) return 0;
    return x * d.x + y * d.y < 0 ? 0 : null;
  }
  return void 0;
}
function circleSweepCircle(c, d, target) {
  validateGeometryCircle(c);
  validateGeometryCircle(target);
  motion(c, d);
  validateGeometryCircle({ ...c, x: c.x + d.x, y: c.y + d.y });
  const start = initial(c, d, target, c.radius + target.radius);
  return start === void 0 ? diskEntry(c, d, target, c.radius + target.radius) : start;
}
function circleSweepRect(c, d, target) {
  validateGeometryCircle(c);
  rect(target);
  motion(c, d);
  validateGeometryCircle({ ...c, x: c.x + d.x, y: c.y + d.y });
  const start = initial(c, d, nearest(c, target), c.radius);
  if (start !== void 0) return start;
  const entries = [
    boxEntry(c, d, { x: target.x - c.radius, y: target.y, width: target.width + 2 * c.radius, height: target.height }),
    boxEntry(c, d, { x: target.x, y: target.y - c.radius, width: target.width, height: target.height + 2 * c.radius })
  ];
  for (const x of [target.x, target.x + target.width])
    for (const y of [target.y, target.y + target.height])
      entries.push(diskEntry(c, d, { x, y }, c.radius));
  const times = entries.filter((v) => v !== null);
  return times.length ? Math.min(...times) : null;
}
function circleSegment(origin, d, target) {
  point(origin);
  motion(origin, d);
  validateGeometryCircle(target);
  const start = initial(origin, d, target, target.radius);
  return start === void 0 ? diskEntry(origin, d, target, target.radius) : start;
}
function circleContactNormal(c, d, time, target) {
  const p = { x: c.x + Math.trunc(d.x * time / CIRCLE_LIMITS.timeScale), y: c.y + Math.trunc(d.y * time / CIRCLE_LIMITS.timeScale) };
  const q = target.kind === "circle" ? target.circle : nearest(p, target.rect);
  const normal = { x: p.x - q.x, y: p.y - q.y };
  if (normal.x !== 0 || normal.y !== 0) return normal;
  if (target.kind === "rect") {
    const faces = [
      { depth: p.x - target.rect.x, x: -1, y: 0 },
      { depth: target.rect.x + target.rect.width - p.x, x: 1, y: 0 },
      { depth: p.y - target.rect.y, x: 0, y: -1 },
      { depth: target.rect.y + target.rect.height - p.y, x: 0, y: 1 }
    ].sort((a, b) => a.depth - b.depth);
    return { x: faces[0].x, y: faces[0].y };
  }
  return d.x !== 0 || d.y !== 0 ? { x: 0 - d.x, y: 0 - d.y } : { x: 1, y: 0 };
}
var categories = ["world", "actor", "projectile", "pickup", "sensor", "ghost"];
var regions = ["body", "hurt", "attack", "selection"];
function identity2(id) {
  if (typeof id !== "string" || id.length > 96 || !/^[A-Za-z0-9][A-Za-z0-9:_.\/-]*$/.test(id)) throw Error("Invalid circle geometry identity");
}
function lexical(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function queryCircleGeometry(shapes, query, filter = {}) {
  if (shapes.length > CIRCLE_LIMITS.shapes) throw Error("Circle shape cap exceeded");
  if (query.kind === "segment") {
    point(query.origin);
    motion(query.origin, query.delta);
  } else if (query.kind === "overlap" || query.kind === "sweep") {
    validateGeometryCircle(query.circle);
    if (query.kind === "sweep") {
      motion(query.circle, query.delta);
      validateGeometryCircle({ ...query.circle, x: query.circle.x + query.delta.x, y: query.circle.y + query.delta.y });
    }
  } else throw Error("Unsupported circle query");
  for (const [values, allowed] of [[filter.categories, categories], [filter.regions, regions]])
    if (values && (values.length > allowed.length || values.some((v) => !allowed.includes(v)))) throw Error("Unsupported circle filter");
  if (filter.sensors !== void 0 && !["include", "exclude", "only"].includes(filter.sensors)) throw Error("Unsupported circle sensor filter");
  if (filter.excludeBodyIds) {
    if (filter.excludeBodyIds.length > CIRCLE_LIMITS.shapes) throw Error("Circle exclusion cap exceeded");
    filter.excludeBodyIds.forEach(identity2);
  }
  const ordered = shapes.map((s) => {
    identity2(s.bodyId);
    identity2(s.shapeId);
    identity2(s.owner);
    circleInteger(s.priority, -1024, 1024);
    if (!categories.includes(s.category) || !regions.includes(s.region) || typeof s.sensor !== "boolean" || "velocity" in s || "delta" in s) throw Error("Unsupported circle shape/static target pair");
    if (s.kind === "circle") {
      validateGeometryCircle(s.circle);
      return { ...s, circle: { ...s.circle } };
    }
    if (s.kind === "rect") {
      rect(s.rect);
      return { ...s, rect: { ...s.rect } };
    }
    throw Error("Unsupported circle shape");
  }).sort((a, b) => lexical(a.bodyId, b.bodyId) || lexical(a.shapeId, b.shapeId));
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1], b = ordered[i];
    if (a.bodyId === b.bodyId && a.shapeId === b.shapeId) throw Error("Duplicate circle geometry identity");
    if (a.bodyId === b.bodyId && a.owner !== b.owner) throw Error("Conflicting circle movement owners");
  }
  const candidates = ordered.filter((s) => (!filter.categories || filter.categories.includes(s.category)) && (filter.regions ?? ["body"]).includes(s.region) && !(filter.excludeBodyIds ?? []).includes(s.bodyId) && (filter.sensors === "only" ? s.sensor : filter.sensors === "include" || !s.sensor));
  const contacts = [];
  for (const s of candidates) {
    if (query.kind === "segment" && s.kind !== "circle") throw Error("P1 segment query supports circle targets only; use P0 for rectangles");
    const c = query.kind === "segment" ? { ...query.origin, radius: 0 } : query.circle;
    const d = query.kind === "overlap" ? { x: 0, y: 0 } : query.delta;
    const time = query.kind === "overlap" ? (s.kind === "circle" ? circleOverlapsCircle(c, s.circle) : circleOverlapsRect(c, s.rect)) ? 0 : null : query.kind === "segment" && s.kind === "circle" ? circleSegment(query.origin, d, s.circle) : s.kind === "circle" ? circleSweepCircle(c, d, s.circle) : circleSweepRect(c, d, s.rect);
    if (time === null) continue;
    contacts.push({ bodyId: s.bodyId, shapeId: s.shapeId, owner: s.owner, category: s.category, region: s.region, sensor: s.sensor, priority: s.priority, time: { n: time, d: CIRCLE_LIMITS.timeScale }, normal: circleContactNormal(c, d, time, s) });
  }
  contacts.sort((a, b) => a.time.n - b.time.n || a.priority - b.priority || lexical(a.bodyId, b.bodyId) || lexical(a.shapeId, b.shapeId));
  return { candidates, contacts, counters: { scanned: shapes.length, filtered: shapes.length - candidates.length, tested: candidates.length, contacts: contacts.length } };
}

// apps/cryptball/sim/court.ts
var base = {
  owner: "court",
  category: "world",
  region: "body",
  sensor: false,
  priority: 0
};
var rect2 = (id, x, y, width, height) => ({
  ...base,
  bodyId: id,
  shapeId: id,
  kind: "rect",
  rect: { x: x * FIXED, y: y * FIXED, width: width * FIXED, height: height * FIXED }
});
var POSTS = [-144, 144].flatMap(
  (x) => [-26, 26].map((y) => ({
    ...base,
    bodyId: `post:${x}:${y}`,
    shapeId: "body",
    kind: "circle",
    circle: { x: x * FIXED, y: y * FIXED, radius: 3 * FIXED }
  }))
);
var BALL_GEOMETRY = [
  rect2("north", -160, -90, 320, 10),
  rect2("south", -160, 80, 320, 10),
  ...[-1, 1].flatMap((s) => [
    rect2(`end:${s}:n`, s < 0 ? -160 : 144, -90, 16, 64),
    rect2(`end:${s}:s`, s < 0 ? -160 : 144, 26, 16, 64),
    rect2(`net:${s}`, s < 0 ? -166 : 156, -26, 10, 52)
  ]),
  ...POSTS
];
var PLAYER_GEOMETRY = [
  rect2("actor:north", -160, -90, 320, 10),
  rect2("actor:south", -160, 80, 320, 10),
  rect2("actor:west", -160, -90, 16, 180),
  rect2("actor:east", 144, -90, 16, 180)
];
function clampActor(p) {
  p.x = Math.max(-137 * FIXED, Math.min(137 * FIXED, p.x));
  p.y = Math.max(-73 * FIXED, Math.min(73 * FIXED, p.y));
}
var ballBounds = BALL_GEOMETRY.map(
  (shape) => shape.kind === "rect" ? {
    minX: shape.rect.x,
    minY: shape.rect.y,
    maxX: shape.rect.x + shape.rect.width,
    maxY: shape.rect.y + shape.rect.height
  } : {
    minX: shape.circle.x - shape.circle.radius,
    minY: shape.circle.y - shape.circle.radius,
    maxX: shape.circle.x + shape.circle.radius,
    maxY: shape.circle.y + shape.circle.radius
  }
);
function queryCourtSweep(circle, delta) {
  const minX = Math.min(circle.x, circle.x + delta.x) - circle.radius;
  const maxX = Math.max(circle.x, circle.x + delta.x) + circle.radius;
  const minY = Math.min(circle.y, circle.y + delta.y) - circle.radius;
  const maxY = Math.max(circle.y, circle.y + delta.y) + circle.radius;
  const candidates = BALL_GEOMETRY.filter((_, i) => {
    const bounds = ballBounds[i];
    return minX <= bounds.maxX && maxX >= bounds.minX && minY <= bounds.maxY && maxY >= bounds.minY;
  });
  return queryCircleGeometry(candidates, { kind: "sweep", circle, delta });
}

// apps/cryptball/sim/ball.ts
function touchBall(b, player, tick, emit) {
  b.bankBonusRemaining = 0;
  b.powerTeam = null;
  b.powerActionKey = null;
  b.lastTouch = player.id;
  if (b.passFrom && player.id === b.passTarget) {
    emit({
      type: "pass-complete",
      tick,
      playerId: player.id,
      team: player.team,
      passerId: b.passFrom,
      x: b.x,
      y: b.y
    });
    b.passFrom = b.passTarget = null;
    b.passTeam = null;
  } else if (b.passFrom && player.team !== b.passTeam) {
    b.passFrom = b.passTarget = null;
    b.passTeam = null;
  }
}
function capBall(b) {
  const n = length(b.vx, b.vy);
  if (n > RULES.maxBallSpeed) {
    b.vx = Math.round(b.vx * RULES.maxBallSpeed / n);
    b.vy = Math.round(b.vy * RULES.maxBallSpeed / n);
  }
}
function moveInterval(b, paths, tick, emit, interval, budget) {
  b.rx += Math.round(b.vx * interval);
  b.ry += Math.round(b.vy * interval);
  let dx = Math.trunc(b.rx / 240), dy = Math.trunc(b.ry / 240);
  b.rx -= dx * 240;
  b.ry -= dy * 240;
  let elapsed = 0, remaining = 1;
  const manifold = [];
  for (; ; ) {
    const count = budget.contacts;
    const staticHit = queryCourtSweep(
      { x: b.x, y: b.y, radius: RULES.ballRadius },
      { x: dx, y: dy }
    ).contacts.find((h) => h.normal.x * dx + h.normal.y * dy < 0);
    let candidate = staticHit ? {
      hit: staticHit,
      t: staticHit.time.n / staticHit.time.d,
      vx: 0,
      vy: 0,
      player: null,
      guard: false
    } : null;
    for (const path of paths) {
      const target = {
        bodyId: path.player.id,
        shapeId: "body",
        owner: "players",
        category: "actor",
        region: "body",
        sensor: false,
        priority: 1,
        kind: "circle",
        circle: {
          x: Math.round(path.x + path.dx * elapsed),
          y: Math.round(path.y + path.dy * elapsed),
          radius: RULES.playerRadius
        }
      };
      const relative = {
        x: Math.round(dx - path.dx * remaining),
        y: Math.round(dy - path.dy * remaining)
      };
      if (path.player.guardTicks >= 4) {
        const facing = headingVector(path.player.heading), offset = RULES.playerRadius + 2 * FIXED;
        const weapons = [-35, -18, 0, 18, 35].map(
          (turn, i) => {
            const direction = headingVector(path.player.heading + turn);
            return {
              ...target,
              shapeId: `guard-${i}`,
              circle: {
                x: Math.round(target.circle.x + direction.x * offset / 65536),
                y: Math.round(target.circle.y + direction.y * offset / 65536),
                radius: 2 * FIXED
              }
            };
          }
        );
        const approach = (b.vx - path.player.vx) * facing.x + (b.vy - path.player.vy) * facing.y;
        if (approach < 0) {
          const guardHit = queryCircleGeometry(weapons, {
            kind: "sweep",
            circle: { x: b.x, y: b.y, radius: RULES.ballRadius },
            delta: relative
          }).contacts.find((h) => {
            const t2 = h.time.n / h.time.d, cx = b.x + relative.x * t2 - target.circle.x, cy = b.y + relative.y * t2 - target.circle.y;
            return h.normal.x * relative.x + h.normal.y * relative.y < 0 && cx * facing.x + cy * facing.y >= length(cx, cy) * 65536 * 0.64279;
          });
          if (guardHit) {
            const t2 = guardHit.time.n / guardHit.time.d;
            if (!candidate || t2 < candidate.t)
              candidate = {
                hit: guardHit,
                t: t2,
                vx: path.player.vx,
                vy: path.player.vy,
                player: path.player,
                guard: true
              };
          }
        }
        if (length(b.x - target.circle.x, b.y - target.circle.y) > 20 * FIXED)
          path.player.guardContact = false;
      }
      const hit2 = queryCircleGeometry([target], {
        kind: "sweep",
        circle: { x: b.x, y: b.y, radius: RULES.ballRadius },
        delta: relative
      }).contacts.find(
        (h) => h.normal.x * relative.x + h.normal.y * relative.y < 0
      );
      if (hit2) {
        const t2 = hit2.time.n / hit2.time.d;
        if (!candidate || t2 < candidate.t)
          candidate = {
            hit: hit2,
            t: t2,
            vx: path.dx * 240 / interval,
            vy: path.dy * 240 / interval,
            player: path.player,
            guard: false
          };
      }
    }
    let goal = null, goalT = Infinity;
    for (const side of [-1, 1])
      if (side * dx > 0) {
        const t2 = (side * 147 * FIXED - b.x) / dx;
        if (t2 >= 0 && t2 <= 1 && Math.abs(b.y + dy * t2) <= 23 * FIXED && t2 < goalT) {
          goalT = t2;
          goal = side === 1 ? 0 : 1;
        }
      }
    if (goal !== null && (!candidate || goalT < candidate.t)) {
      b.x += Math.round(dx * goalT);
      b.y += Math.round(dy * goalT);
      return goal;
    }
    if (!candidate) {
      b.x += dx;
      b.y += dy;
      return null;
    }
    if (budget.contacts >= 4) {
      emit({
        type: "diagnostic",
        tick,
        reason: "ball-contact-budget",
        x: b.x,
        y: b.y
      });
      budget.stopped = true;
      return null;
    }
    budget.contacts++;
    const { hit, t, player, guard } = candidate;
    let { vx, vy } = candidate;
    let n = normalized(hit.normal.x, hit.normal.y);
    if (!n.x && !n.y) n = normalized(-dx, -dy);
    b.x += Math.round(dx * t + n.x);
    b.y += Math.round(dy * t + n.y);
    if (player && !guard) {
      const path = paths.find((p) => p.player.id === player.id);
      const px = path.x + path.dx * (elapsed + remaining * t), py = path.y + path.dy * (elapsed + remaining * t);
      const penetration = RULES.ballRadius + RULES.playerRadius - length(b.x - px, b.y - py);
      if (penetration > -4) {
        const correction = {
          x: Math.round(n.x * (Math.max(0, penetration) + 2 * FIXED)),
          y: Math.round(n.y * (Math.max(0, penetration) + 2 * FIXED))
        };
        const blocked = queryCourtSweep(
          { x: b.x, y: b.y, radius: RULES.ballRadius },
          correction
        ).contacts.some(
          (h) => h.normal.x * correction.x + h.normal.y * correction.y < 0
        );
        if (blocked || penetration > 0 || t < 0.01 || count > 0) {
          const push = penetration + 2 * FIXED;
          player.x = Math.round(px - n.x * push);
          player.y = Math.round(py - n.y * push);
          player.x = Math.max(-137 * FIXED, Math.min(137 * FIXED, player.x));
          player.y = Math.max(-73 * FIXED, Math.min(73 * FIXED, player.y));
          player.vx = player.vy = 0;
          path.x = player.x;
          path.y = player.y;
          path.dx = path.dy = 0;
          candidate.vx = candidate.vy = 0;
          vx = vy = 0;
        }
      }
    }
    const dot = (b.vx - vx) * n.x + (b.vy - vy) * n.y;
    const enhancedBank = !player && (hit.bodyId === "north" || hit.bodyId === "south") && b.bankBonusRemaining > 0 && tick < b.powerExpires;
    const restitution = enhancedBank ? 0.98 : player ? 0.6 : hit.bodyId.startsWith("post") ? 0.85 : 0.9;
    if (guard && player && dot < 0) {
      const incomingSquared = b.vx * b.vx + b.vy * b.vy, incoming = length(b.vx, b.vy), facing = headingVector(player.heading);
      const perfect = tick < player.guardPerfectUntil && !player.guardContact;
      const speed = perfect ? Math.min(RULES.shotSpeed, incoming) : Math.min(
        incoming,
        Math.max(Math.min(24 * FIXED, incoming), Math.round(incoming * 0.55))
      );
      if (perfect) {
        b.vx = Math.round(facing.x * speed / 65536);
        b.vy = Math.round(facing.y * speed / 65536);
        player.perfectReady = tick + 18;
        player.staggerTicks = 3;
      } else {
        const reflected = normalized(
          b.vx - 2 * dot * n.x,
          b.vy - 2 * dot * n.y
        );
        b.vx = Math.round(reflected.x * speed);
        b.vy = Math.round(reflected.y * speed);
        if (b.bankBonusRemaining) {
          player.x = Math.max(
            -137 * FIXED,
            Math.min(
              137 * FIXED,
              player.x - Math.round(facing.x * 2 * FIXED / 65536)
            )
          );
          player.y = Math.max(
            -73 * FIXED,
            Math.min(73 * FIXED, player.y - Math.round(facing.y * 2 * FIXED / 65536))
          );
        }
      }
      const energyCap = Math.min(
        incomingSquared,
        RULES.shotSpeed * RULES.shotSpeed
      );
      while (b.vx * b.vx + b.vy * b.vy > energyCap) {
        if (Math.abs(b.vx) >= Math.abs(b.vy)) b.vx -= Math.sign(b.vx);
        else b.vy -= Math.sign(b.vy);
      }
      player.guardContact = true;
      emit({
        type: perfect ? "perfect-block" : "block",
        tick,
        playerId: player.id,
        team: player.team,
        x: b.x,
        y: b.y
      });
      b.bankBonusRemaining = 0;
      b.powerTeam = null;
      b.powerActionKey = null;
    } else if (dot < 0) {
      b.vx = Math.round(b.vx - (1 + restitution) * dot * n.x);
      b.vy = Math.round(b.vy - (1 + restitution) * dot * n.y);
      capBall(b);
    }
    if (enhancedBank) {
      b.bankBonusRemaining = 0;
      b.powerTeam = null;
      b.powerActionKey = null;
      emit({ type: "power-bank", tick, x: b.x, y: b.y });
    }
    for (let k = manifold.length - 1; k >= 0; k--)
      if (Math.abs(
        (b.x - manifold[k].x) * manifold[k].nx + (b.y - manifold[k].y) * manifold[k].ny
      ) > 2 * FIXED)
        manifold.splice(k, 1);
    manifold.push({ x: b.x, y: b.y, nx: n.x, ny: n.y, vx, vy });
    if (manifold.length > 1)
      for (let pass = 0; pass < 4; pass++)
        for (const plane of manifold) {
          const inward = (b.vx - plane.vx) * plane.nx + (b.vy - plane.vy) * plane.ny;
          if (inward < 0) {
            b.vx = Math.round(b.vx - inward * plane.nx);
            b.vy = Math.round(b.vy - inward * plane.ny);
          }
        }
    if (player) {
      touchBall(b, player, tick, emit);
    } else
      emit({
        type: hit.bodyId.startsWith("post") ? "post" : "board",
        tick,
        x: b.x,
        y: b.y
      });
    elapsed += remaining * t;
    remaining *= 1 - t;
    dx = Math.round(b.vx / 240 * remaining * interval);
    dy = Math.round(b.vy / 240 * remaining * interval);
    if (!dx && !dy) return null;
  }
}
function dragBall(b) {
  const speed = length(b.vx, b.vy);
  b.dragCarry += RULES.drag;
  const drag = Math.trunc(b.dragCarry / 60);
  b.dragCarry -= drag * 60;
  const next = Math.max(0, speed - drag);
  if (next < RULES.restSpeed) {
    b.vx = b.vy = b.rx = b.ry = 0;
  } else {
    b.vx = Math.round(b.vx * next / speed);
    b.vy = Math.round(b.vy * next / speed);
  }
}
function moveBall(b, paths, tick, emit) {
  const budget = { contacts: 0, stopped: false };
  const times = [
    .../* @__PURE__ */ new Set([
      0,
      1,
      ...paths.flatMap(
        (p) => (p.segments ?? []).flatMap((s) => [s.start, s.end])
      )
    ])
  ].sort((a, b2) => a - b2);
  for (let i = 1; i < times.length; i++) {
    const start = times[i - 1], end = times[i];
    if (end <= start) continue;
    const pieces = paths.map((p) => {
      const segment = p.segments?.find(
        (s) => s.start <= start && s.end >= end && s.end > s.start
      );
      if (!segment)
        return {
          ...p,
          x: Math.trunc(p.x + p.dx * start),
          y: Math.trunc(p.y + p.dy * start),
          dx: Math.round(p.dx * (end - start)),
          dy: Math.round(p.dy * (end - start))
        };
      const duration = segment.end - segment.start, f = (start - segment.start) / duration;
      return {
        ...p,
        x: Math.round(segment.x + segment.dx * f),
        y: Math.round(segment.y + segment.dy * f),
        dx: Math.round(segment.dx * (end - start) / duration),
        dy: Math.round(segment.dy * (end - start) / duration)
      };
    });
    const goal = moveInterval(b, pieces, tick, emit, end - start, budget);
    if (goal !== null) return goal;
    if (budget.stopped) return null;
    for (const path of paths)
      if (path.player.vx === 0 && path.player.vy === 0 && (path.dx || path.dy)) {
        path.x = path.player.x;
        path.y = path.player.y;
        path.dx = path.dy = 0;
        path.segments = [
          { x: path.x, y: path.y, dx: 0, dy: 0, start: 0, end: 1 }
        ];
      }
  }
  return null;
}

// apps/cryptball/sim/prediction.ts
function predictBall(ball, ticks = 45, startTick = 0) {
  const b = { ...ball }, points = [];
  for (let t = 1; t <= Math.min(45, ticks); t++) {
    for (let i = 0; i < 4; i++)
      if (moveBall(b, [], startTick + t, () => {
      }) !== null) {
        points.push({ x: b.x, y: b.y, tick: t });
        return points;
      }
    dragBall(b);
    if (t % 3 === 0) points.push({ x: b.x, y: b.y, tick: t });
    if (!b.vx && !b.vy && !b.rx && !b.ry) {
      for (let next = t + 1; next <= Math.min(45, ticks); next++)
        if (next % 3 === 0) points.push({ x: b.x, y: b.y, tick: next });
      break;
    }
  }
  return points;
}
function clearLane(from, to, players, exclude = []) {
  const targets = [
    ...BALL_GEOMETRY,
    ...players.filter((p) => !exclude.includes(p.id)).map((p) => ({
      bodyId: p.id,
      shapeId: "body",
      owner: "players",
      category: "actor",
      region: "body",
      sensor: false,
      priority: 1,
      kind: "circle",
      circle: { x: p.x, y: p.y, radius: RULES.playerRadius }
    }))
  ];
  const dx = to.x - from.x, dy = to.y - from.y, steps = Math.max(1, Math.ceil(length(dx, dy) / (31 * FIXED)));
  for (let i = 0; i < steps; i++) {
    const x = Math.round(from.x + dx * i / steps), y = Math.round(from.y + dy * i / steps), delta = {
      x: Math.round(from.x + dx * (i + 1) / steps) - x,
      y: Math.round(from.y + dy * (i + 1) / steps) - y
    };
    if (queryCircleGeometry(targets, {
      kind: "sweep",
      circle: { x, y, radius: RULES.ballRadius },
      delta
    }).contacts.some((h) => h.normal.x * delta.x + h.normal.y * delta.y < 0))
      return false;
  }
  return true;
}
function bankHeading(ball, side, team, startTick = 0) {
  const goalX = (team === 0 ? 147 : -147) * FIXED, mirrorY = side * 154 * FIXED, heading = aimHeading(goalX - ball.x, mirrorY - ball.y), v = headingVector(heading), copy = {
    ...ball,
    vx: Math.round(v.x * RULES.shotSpeed / 65536),
    vy: Math.round(v.y * RULES.shotSpeed / 65536)
  };
  let bank = false;
  for (let t = 0; t < 90; t++) {
    for (let i = 0; i < 4; i++) {
      let goal = moveBall(copy, [], startTick + t, (e) => {
        if (e.type === "board") bank = true;
      });
      if (goal !== null) return goal === team && bank ? heading : null;
    }
    dragBall(copy);
    if (!copy.vx && !copy.vy && !copy.rx && !copy.ry) return null;
  }
  return null;
}

// apps/cryptball/sim/actions.ts
function event(s, type, p, extra = {}) {
  s.events.push({
    type,
    tick: s.tick,
    epoch: s.epoch,
    counter: s.nextEvent++,
    ...p ? { playerId: p.id, team: p.team, x: p.x, y: p.y } : {},
    ...extra
  });
}
function swing(s, p, kind, charge) {
  const target = s.players.find((q) => q.team === p.team && q.id !== p.id);
  if (kind === "pass" && target) {
    p.heading = aimHeading(
      Math.max(
        -137 * FIXED,
        Math.min(
          137 * FIXED,
          target.x + Math.max(
            -24 * FIXED,
            Math.min(
              24 * FIXED,
              target.vx * Math.min(
                0.2,
                length(target.x - p.x, target.y - p.y) / RULES.passSpeed
              )
            )
          )
        )
      ) - p.x,
      Math.max(
        -73 * FIXED,
        Math.min(
          73 * FIXED,
          target.y + Math.max(
            -24 * FIXED,
            Math.min(
              24 * FIXED,
              target.vy * Math.min(
                0.2,
                length(target.x - p.x, target.y - p.y) / RULES.passSpeed
              )
            )
          )
        )
      ) - p.y
    );
    event(s, "pass-target", target);
  }
  p.action = {
    id: s.nextAction++,
    elapsed: 0,
    timing: {
      tell: kind === "pass" ? 3 : charge > 0 ? 6 : 4,
      active: kind === "pass" ? 2 : 3,
      recover: kind === "pass" ? 6 : charge >= RULES.chargeCap ? 16 : charge > 0 ? 12 : 9
    },
    hits: [],
    heading: p.heading,
    kind,
    charge,
    targetId: kind === "pass" ? target?.id : void 0
  };
  p.charging = false;
  p.chargeTicks = 0;
  event(s, "swing", p, { kind, charge });
}
function admitAction(s, p, c) {
  if (c.cancel) {
    if (p.guardTicks) p.guardRecovery = 8;
    p.guardTicks = 0;
    p.guardContact = false;
    p.charging = false;
    p.chargeTicks = 0;
    p.buffer = null;
    return;
  }
  if (c.aim !== void 0 && !p.action && !p.dashTicks) {
    const heading = (Math.round(c.aim) % 256 + 256) % 256;
    const turn = (heading - p.heading + 384) % 256 - 128;
    p.heading = p.guardTicks ? (p.heading + Math.max(-4, Math.min(4, turn)) + 256) % 256 : heading;
  }
  if (p.staggerTicks) {
    p.charging = false;
    p.chargeTicks = 0;
    return;
  }
  if (c.dash && !p.dashCooldown && !p.action) {
    p.charging = false;
    p.chargeTicks = 0;
    p.guardTicks = 0;
    p.guardRecovery = 0;
    p.guardContact = false;
    p.dashTicks = RULES.dashTicks;
    p.dashCooldown = RULES.dashReuse;
    p.dashHeading = p.heading;
    p.checked = false;
    p.buffer = null;
    event(s, "dash", p);
    return;
  }
  if (c.dash) return;
  if (c.guard && !p.action && !p.dashTicks && !p.guardRecovery) {
    p.charging = false;
    p.chargeTicks = 0;
    p.buffer = null;
    if (!p.guardTicks) {
      p.guardTicks = 1;
      p.guardContact = false;
      p.guardPerfectUntil = s.tick >= p.perfectReady ? s.tick + 9 : 0;
      p.perfectReady = Math.max(p.perfectReady, s.tick + 18);
      event(s, "guard", p);
    }
    return;
  }
  if (p.guardTicks && !c.guard) {
    p.guardTicks = 0;
    p.guardRecovery = 8;
    p.guardContact = false;
  }
  if (p.guardTicks || p.guardRecovery) return;
  if (c.pass) {
    if (!p.action && !p.dashTicks) swing(s, p, "pass", 0);
    else p.buffer = { kind: "pass", charge: 0, until: s.tick + 6 };
    return;
  }
  if (c.strikePressed && !p.action && !p.dashTicks) {
    p.charging = true;
    p.chargeTicks = 0;
  }
  if (p.charging) {
    if (c.strikeHeld) {
      p.chargeTicks++;
      if (p.chargeTicks === RULES.chargeCap) event(s, "charge-ready", p);
    }
    if (c.strikeReleased || !c.strikeHeld || p.chargeTicks >= RULES.chargeCap + 18) {
      if (s.controllers.some((q) => q.active && q.playerId === p.id) && !c.pointerAim) {
        const goal = { x: (p.team === 0 ? 147 : -147) * FIXED, y: 0 }, h = aimHeading(goal.x - p.x, goal.y - p.y), difference = Math.abs((h - p.heading + 384) % 256 - 128);
        if (difference <= 8 && clearLane(s.ball, goal, s.players, [p.id]))
          p.heading = h;
      }
      swing(s, p, "strike", Math.min(RULES.chargeCap, p.chargeTicks));
    }
  } else if (c.strikeReleased && p.action)
    p.buffer = { kind: "strike", charge: 0, until: s.tick + 6 };
  if (p.buffer) {
    if (p.buffer.until < s.tick) p.buffer = null;
    else if (!p.action && !p.dashTicks) {
      swing(s, p, p.buffer.kind, p.buffer.charge);
      p.buffer = null;
    }
  }
}
function resolveStrikes(s) {
  const b = s.ball;
  const candidates = s.players.filter(
    (p2) => p2.action && actionPhase(p2.action).phase === "active" && !p2.action.hits.includes("ball")
  ).filter((p2) => {
    const dx = b.x - p2.x, dy = b.y - p2.y, d = length(dx, dy), v2 = headingVector(p2.action.heading ?? p2.heading);
    return d <= RULES.reach && (d === 0 || (dx * v2.x + dy * v2.y) / (d * 65536) >= 0.64279);
  }).sort(
    (a2, b2) => length(a2.x - s.ball.x, a2.y - s.ball.y) - length(b2.x - s.ball.x, b2.y - s.ball.y) || (a2.id < b2.id ? -1 : a2.id > b2.id ? 1 : 0)
  );
  if (!candidates.length) return;
  const p = candidates[0], a = p.action, other = candidates[1];
  if (other && other.team !== p.team && Math.abs(
    length(p.x - b.x, p.y - b.y) - length(other.x - b.x, other.y - b.y)
  ) <= 1) {
    claimActionHit(a, "ball");
    claimActionHit(other.action, "ball");
    const n = normalized(p.x - other.x, p.y - other.y), dot = b.vx * n.x + b.vy * n.y;
    b.vx = Math.round(b.vx - dot * n.x);
    b.vy = Math.round(b.vy - dot * n.y);
    event(s, "clash", p);
    return;
  }
  if (!claimActionHit(a, "ball")) return;
  const v = headingVector(a.heading ?? p.heading), speed = a.kind === "pass" ? RULES.passSpeed : RULES.shotSpeed + Math.round(
    (RULES.maxBallSpeed - RULES.shotSpeed) * (a.charge ?? 0) / RULES.chargeCap
  );
  b.vx = Math.round(v.x * speed / 65536);
  b.vy = Math.round(v.y * speed / 65536);
  b.rx = b.ry = 0;
  if (b.passFrom && b.passTarget === p.id) {
    const from = s.players.find((q) => q.id === b.passFrom);
    if (from) recordStat(s, from, "passes");
    event(s, "pass-complete", p, { passerId: b.passFrom });
  }
  b.lastTouch = p.id;
  b.passFrom = a.kind === "pass" ? p.id : null;
  b.passTarget = a.kind === "pass" ? a.targetId ?? null : null;
  s.touchTick = s.tick;
  s.restartProtection = 0;
  b.passTeam = a.kind === "pass" ? p.team : null;
  b.passTick = s.tick;
  b.bankBonusRemaining = a.kind === "strike" && (a.charge ?? 0) >= RULES.chargeCap ? 1 : 0;
  b.powerTeam = b.bankBonusRemaining ? p.team : null;
  b.powerActionKey = b.bankBonusRemaining ? a.id : null;
  b.powerExpires = s.tick + 60;
  if (a.kind === "pass" && a.targetId) {
    const controller = s.controllers.find(
      (c) => c.playerId === p.id && c.active && c.canSwitch
    );
    if (controller && !s.controllers.some((c) => c.playerId === a.targetId))
      controller.pendingSwitch = a.targetId;
  }
  if (a.kind === "strike") recordStat(s, p, "shots");
  event(s, a.kind, p, { charge: a.charge ?? 0, heading: a.heading });
}
function recordStat(s, p, key) {
  s.teamStats[p.team][key]++;
  s.stats = s.teamStats[0];
  const controller = s.controllers.find((c) => c.playerId === p.id);
  if (controller && s.participantStats[controller.id])
    s.participantStats[controller.id][key]++;
}
function resolveChecks(s) {
  for (const p of s.players) {
    if (!p.dashTicks || p.checked) continue;
    for (const q of s.players) {
      if (q.team === p.team || q.immunityTicks || length(p.x - q.x, p.y - q.y) > 2 * RULES.playerRadius + FIXED)
        continue;
      p.checked = true;
      const facing = headingVector(q.heading), dx = p.x - q.x, dy = p.y - q.y;
      if (q.guardTicks >= 4 && dx * facing.x + dy * facing.y > length(dx, dy) * 65536 * 0.64279) {
        event(s, "check-resist", q);
        break;
      }
      q.guardTicks = 0;
      q.guardContact = false;
      q.staggerTicks = RULES.staggerTicks;
      q.immunityTicks = RULES.immunityTicks;
      q.charging = false;
      q.chargeTicks = 0;
      q.buffer = null;
      if (q.action && actionPhase(q.action).phase === "tell") q.action = null;
      const v = headingVector(p.dashHeading);
      q.vx += Math.round(v.x * 48 * FIXED / 65536);
      q.vy += Math.round(v.y * 48 * FIXED / 65536);
      event(s, "check", p, { targetId: q.id });
      break;
    }
  }
}
function finishActions(s) {
  for (const p of s.players) {
    if (p.action) {
      p.action.elapsed++;
      if (actionPhase(p.action).phase === "done") {
        if (!p.action.hits.length)
          event(s, "whiff", p, { kind: p.action.kind });
        p.action = null;
      }
    }
    if (p.guardTicks) p.guardTicks++;
    p.guardRecovery = Math.max(0, p.guardRecovery - 1);
    p.dashTicks = Math.max(0, p.dashTicks - 1);
    p.dashCooldown = Math.max(0, p.dashCooldown - 1);
    p.staggerTicks = Math.max(0, p.staggerTicks - 1);
    p.immunityTicks = Math.max(0, p.immunityTicks - 1);
  }
}
function steer(p, c) {
  let n = normalized(c.moveX ?? 0, c.moveY ?? 0), speed = RULES.runSpeed;
  if (p.staggerTicks) speed *= 0.35;
  else if (p.action) speed *= 0.75;
  else if (p.guardTicks) speed *= 0.45;
  else if (p.charging) speed *= p.chargeTicks >= RULES.chargeCap ? 0.45 : 0.65;
  else if (p.dashCooldown > 50 && p.dashCooldown <= 56) speed *= 0.75;
  if (p.dashTicks) {
    const d = headingVector(p.dashHeading);
    n = { x: d.x / 65536, y: d.y / 65536 };
    speed = RULES.dashSpeed;
    p.vx = Math.round(n.x * speed);
    p.vy = Math.round(n.y * speed);
    return;
  }
  const target = { x: Math.round(n.x * speed), y: Math.round(n.y * speed) }, delta = normalized(target.x - p.vx, target.y - p.vy), amount = RULES.runSpeed / (n.x || n.y ? 6 : 4), distance2 = length(target.x - p.vx, target.y - p.vy);
  p.vx = Math.round(p.vx + delta.x * Math.min(amount, distance2));
  p.vy = Math.round(p.vy + delta.y * Math.min(amount, distance2));
  if (c.aim === void 0 && !p.action && !p.charging && (n.x || n.y))
    p.heading = aimHeading(n.x, n.y);
}

// apps/cryptball/sim/match.ts
function makePlayer(i) {
  return {
    id: `player-${i}`,
    team: i < 2 ? 0 : 1,
    archetype: i % 2 ? "knight" : "warrior",
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    heading: i < 2 ? 0 : 128,
    action: null,
    guardTicks: 0,
    guardRecovery: 0,
    guardPerfectUntil: 0,
    perfectReady: 0,
    guardContact: false,
    chargeTicks: 0,
    charging: false,
    dashTicks: 0,
    dashCooldown: 0,
    dashHeading: 0,
    checked: false,
    staggerTicks: 0,
    immunityTicks: 0,
    distance: 0,
    aiRole: "support",
    aiX: 0,
    aiY: 0,
    aiAim: 0,
    aiNext: 0,
    roleUntil: 0,
    roleTouch: -1,
    aiPass: false,
    aiGuardStart: 0,
    aiGuardUntil: 0,
    buffer: null,
    rx: 0,
    ry: 0
  };
}
function resetCourt(s, team = null) {
  const poses = team === null ? [
    [-48, -24],
    [-96, 32],
    [48, 24],
    [96, -32]
  ] : team === 0 ? [
    [-88, 0],
    [-108, 40],
    [48, -20],
    [92, 35]
  ] : [
    [-48, -20],
    [-92, 35],
    [88, 0],
    [108, 40]
  ];
  s.players = s.players.map((p, i) => ({
    ...makePlayer(i),
    x: poses[i][0] * FIXED,
    y: poses[i][1] * FIXED,
    distance: p.distance,
    aiNext: s.tick + i % 3 * 2
  }));
  s.ball = {
    x: team === null ? 0 : (team === 0 ? -70 : 70) * FIXED,
    y: 0,
    vx: 0,
    vy: 0,
    rx: 0,
    ry: 0,
    dragCarry: 0,
    lastTouch: null,
    passFrom: null,
    passTarget: null,
    passTeam: null,
    passTick: 0,
    powerTeam: null,
    powerActionKey: null,
    bankBonusRemaining: 0,
    powerExpires: 0
  };
  s.restartTeam = team;
  s.restartProtection = team === null ? 0 : 60;
  s.pendingSwitch = null;
  for (const controller of s.controllers) controller.pendingSwitch = null;
  s.goalTeam = null;
}
function finishMatch(s) {
  s.phase = "results";
  s.phaseTicks = 0;
  s.winner = s.score[0] === s.score[1] ? "draw" : s.score[0] > s.score[1] ? 0 : 1;
  event(s, "match-end", void 0, { winner: s.winner });
}
function expireClock(s) {
  if (s.mode === "practice") return;
  if (s.remainingTicks > 0) return;
  if (!s.overtime && s.score[0] === s.score[1]) {
    s.overtime = true;
    s.remainingTicks = RULES.overtimeTicks;
    s.phase = "ready";
    s.phaseTicks = 60;
    resetCourt(s);
    event(s, "overtime");
  } else finishMatch(s);
}
function scoreGoal(s, team) {
  s.score[team]++;
  const scorer = s.players.find(
    (p) => p.id === s.ball.lastTouch && p.team === team
  );
  if (scorer) recordStat(s, scorer, "goals");
  else s.teamStats[team].goals++;
  s.stats = s.teamStats[0];
  s.ball.passFrom = s.ball.passTarget = null;
  s.ball.passTeam = null;
  s.ball.bankBonusRemaining = 0;
  s.ball.powerTeam = null;
  s.ball.powerActionKey = null;
  s.goalTeam = team;
  event(
    s,
    "goal",
    s.players.find((p) => p.id === s.ball.lastTouch),
    { team, x: s.ball.x, y: s.ball.y }
  );
  if (s.overtime && s.mode === "match") {
    finishMatch(s);
    return;
  }
  s.phase = "goal";
  s.phaseTicks = 54;
}
function advancePhase(s) {
  if (s.phase === "results") return;
  if (--s.phaseTicks > 0) return;
  if (s.phase === "goal") {
    if (s.mode === "match" && s.remainingTicks === 0) {
      expireClock(s);
      return;
    }
    const conceding = s.goalTeam === 0 ? 1 : 0;
    resetCourt(s, conceding);
    s.phase = "ready";
    s.phaseTicks = 24;
  } else {
    s.phase = "play";
    event(s, "whistle");
  }
}

// apps/cryptball/sim/motion.ts
function correctActor(p, dx, dy, ball) {
  const shapes = ball ? [
    ...PLAYER_GEOMETRY,
    {
      bodyId: "orb",
      shapeId: "body",
      owner: "orb",
      category: "projectile",
      region: "body",
      sensor: false,
      priority: 1,
      kind: "circle",
      circle: { x: ball.x, y: ball.y, radius: RULES.ballRadius }
    }
  ] : PLAYER_GEOMETRY;
  const hit = queryCircleGeometry(shapes, {
    kind: "sweep",
    circle: { x: p.x, y: p.y, radius: RULES.playerRadius },
    delta: { x: dx, y: dy }
  }).contacts.find((h) => h.normal.x * dx + h.normal.y * dy < 0);
  const t = hit ? hit.time.n / hit.time.d : 1;
  p.x += Math.trunc(dx * t);
  p.y += Math.trunc(dy * t);
  clampActor(p);
}
function movePlayers(players, ball, tick = 0, emit = () => {
}) {
  const paths = players.map((p) => {
    const x = p.x, y = p.y, segments = [];
    p.rx += p.vx;
    p.ry += p.vy;
    let dx = Math.trunc(p.rx / 240), dy = Math.trunc(p.ry / 240);
    p.rx -= dx * 240;
    p.ry -= dy * 240;
    let elapsed = 0;
    for (let i = 0; i < 2 && (dx || dy); i++) {
      const geometry = ball ? [
        ...PLAYER_GEOMETRY,
        {
          bodyId: "orb",
          shapeId: "body",
          owner: "orb",
          category: "projectile",
          region: "body",
          sensor: false,
          priority: 1,
          kind: "circle",
          circle: { x: ball.x, y: ball.y, radius: RULES.ballRadius }
        }
      ] : PLAYER_GEOMETRY;
      const hit = queryCircleGeometry(geometry, {
        kind: "sweep",
        circle: { x: p.x, y: p.y, radius: RULES.playerRadius },
        delta: { x: dx, y: dy }
      }).contacts.find((h) => dx * h.normal.x + dy * h.normal.y < 0);
      const t = hit ? hit.time.n / hit.time.d : 1, n = hit ? normalized(hit.normal.x, hit.normal.y) : { x: 0, y: 0 };
      const mx = Math.round(dx * t), my = Math.round(dy * t), end = elapsed + (1 - elapsed) * t;
      segments.push({ x: p.x, y: p.y, dx: mx, dy: my, start: elapsed, end });
      p.x += mx;
      p.y += my;
      elapsed = end;
      if (!hit) break;
      if (hit.bodyId === "orb" && ball && length(ball.vx - p.vx, ball.vy - p.vy) < 100 * 256) {
        const speed = Math.min(
          90 * 256,
          Math.max(24 * 256, length(p.vx, p.vy))
        );
        ball.vx = Math.round(-n.x * speed);
        ball.vy = Math.round(-n.y * speed);
        touchBall(ball, p, tick, emit);
      }
      p.x += Math.round(n.x);
      p.y += Math.round(n.y);
      dx = Math.round(dx * (1 - t));
      dy = Math.round(dy * (1 - t));
      const dot = dx * n.x + dy * n.y;
      dx = Math.round(dx - dot * n.x);
      dy = Math.round(dy - dot * n.y);
    }
    if (elapsed < 1)
      segments.push({ x: p.x, y: p.y, dx: 0, dy: 0, start: elapsed, end: 1 });
    clampActor(p);
    return { player: p, x, y, dx: p.x - x, dy: p.y - y, segments };
  });
  for (let k = 0; k < 2; k++)
    for (let i = 0; i < players.length; i++)
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i], b = players[j], dx = b.x - a.x, dy = b.y - a.y, d = length(dx, dy), overlap = 2 * RULES.playerRadius - d;
        if (overlap > 0) {
          const n = d ? { x: dx / d, y: dy / d } : { x: 1, y: 0 };
          const push = Math.ceil(overlap / 2);
          correctActor(
            a,
            -Math.round(n.x * push),
            -Math.round(n.y * push),
            ball
          );
          correctActor(b, Math.round(n.x * push), Math.round(n.y * push), ball);
        }
      }
  if (ball)
    for (const p of players) {
      const dx = p.x - ball.x, dy = p.y - ball.y, d = length(dx, dy), overlap = RULES.playerRadius + RULES.ballRadius - d;
      if (overlap <= 0 || !d) continue;
      const n = normalized(dx, dy), push = {
        x: Math.round(-n.x * (overlap + 2)),
        y: Math.round(-n.y * (overlap + 2))
      };
      const blocked = queryCircleGeometry(PLAYER_GEOMETRY, {
        kind: "sweep",
        circle: { x: ball.x, y: ball.y, radius: RULES.ballRadius },
        delta: push
      }).contacts.some((h) => push.x * h.normal.x + push.y * h.normal.y < 0);
      if (blocked || overlap > 1) {
        p.x += Math.round(n.x * (overlap + 2));
        p.y += Math.round(n.y * (overlap + 2));
        clampActor(p);
      }
    }
  for (const path of paths) {
    const p = path.player, ex = path.x + path.dx, ey = path.y + path.dy;
    if (ex !== p.x || ey !== p.y)
      path.segments.push({
        x: ex,
        y: ey,
        dx: p.x - ex,
        dy: p.y - ey,
        start: 1,
        end: 1
      });
    p.distance += Math.round(length(p.x - path.x, p.y - path.y));
  }
  return paths;
}

// apps/cryptball/sim/team-ai.ts
var distance = (a, b) => length(a.x - b.x, a.y - b.y);
function aiCommands(s, rng) {
  const commands = /* @__PURE__ */ new Map(), due = s.players.filter(
    (p) => !s.controllers.some((c) => c.active && c.playerId === p.id) && !(s.mode === "practice" && p.team === 1) && s.tick >= p.aiNext
  );
  const forecast = due.length ? predictBall(s.ball, 45, s.tick) : [];
  for (const team of [0, 1]) {
    const roster = s.players.filter((p) => p.team === team), direction = team === 0 ? 1 : -1;
    const estimate = (p) => {
      const point2 = forecast.find(
        (f) => distance(p, f) <= RULES.runSpeed * (f.tick - 6) / 60
      ) ?? s.ball;
      return distance(p, point2) / RULES.runSpeed;
    };
    const challenger = [...roster].sort(
      (a, b) => estimate(a) - estimate(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    )[0];
    for (const p of roster) {
      if (s.controllers.some((c2) => c2.active && c2.playerId === p.id) || s.mode === "practice" && team === 1)
        continue;
      const human = roster.find(
        (q) => s.controllers.some((c2) => c2.active && c2.playerId === q.id)
      ) ?? roster[0], teammate = roster.find((q) => q.id !== p.id);
      if (s.tick >= p.aiNext) {
        p.aiNext = s.tick + 6;
        if (s.tick >= p.aiGuardUntil && !p.action && !p.charging && distance(p, s.ball) < 48 * FIXED && length(s.ball.vx, s.ball.vy) > 100 * FIXED) {
          const toward = (p.x - s.ball.x) * s.ball.vx + (p.y - s.ball.y) * s.ball.vy;
          if (toward > 0) {
            p.aiGuardStart = s.tick + 6;
            p.aiGuardUntil = s.tick + 21;
            p.aiAim = aimHeading(s.ball.x - p.x, s.ball.y - p.y);
          }
        }
        const supportingHuman = s.controllers.some(
          (c2) => c2.active && c2.team === team && distance(s.players.find((q) => q.id === c2.playerId), s.ball) < 38 * FIXED
        );
        const danger = direction * s.ball.x < -70 * FIXED;
        if (s.tick >= p.roleUntil || p.roleTouch !== s.touchTick || danger) {
          p.aiRole = p.id === challenger.id && !supportingHuman ? "intercept" : direction * s.ball.x < -25 * FIXED ? "defend-lane" : "support";
          p.roleUntil = s.tick + 18;
          p.roleTouch = s.touchTick;
        }
        let target;
        if (p.aiRole === "intercept") {
          const point2 = forecast.find(
            (f) => distance(p, f) <= RULES.runSpeed * Math.max(0, f.tick - 6) / 60
          ) ?? s.ball;
          const goalDir = normalized(direction * 147 * FIXED - point2.x, -point2.y);
          target = {
            x: point2.x - goalDir.x * 12 * FIXED,
            y: point2.y - goalDir.y * 12 * FIXED
          };
        } else if (p.aiRole === "defend-lane")
          target = {
            x: -direction * 108 * FIXED,
            y: Math.max(-38 * FIXED, Math.min(38 * FIXED, s.ball.y * 0.6))
          };
        else
          target = {
            x: Math.max(
              -112 * FIXED,
              Math.min(112 * FIXED, s.ball.x + direction * 42 * FIXED)
            ),
            y: s.ball.y > 0 ? -40 * FIXED : 40 * FIXED
          };
        if (s.mode === "practice") {
          p.aiRole = "feed";
          if (distance(human, s.ball) < 28 * FIXED)
            target = {
              x: Math.max(-100 * FIXED, Math.min(100 * FIXED, human.x + 48 * FIXED)),
              y: human.y > 0 ? -38 * FIXED : 38 * FIXED
            };
          else {
            const toward = normalized(human.x - s.ball.x, human.y - s.ball.y);
            target = {
              x: s.ball.x - toward.x * 12 * FIXED,
              y: s.ball.y - toward.y * 12 * FIXED
            };
          }
        }
        p.aiX = Math.round(Math.max(-135 * FIXED, Math.min(135 * FIXED, target.x)));
        p.aiY = Math.round(Math.max(-71 * FIXED, Math.min(71 * FIXED, target.y)));
        p.aiPass = false;
        if (distance(p, s.ball) < 30 * FIXED) {
          const goal = { x: direction * 147 * FIXED, y: 0 };
          const direct = clearLane(s.ball, goal, s.players, [p.id]);
          let aim = aimHeading(goal.x - s.ball.x, goal.y - s.ball.y);
          if (!direct) {
            const teammateOpen = clearLane(s.ball, teammate, s.players, [
              p.id,
              teammate.id
            ]);
            if (teammateOpen && distance(teammate, s.ball) > 30 * FIXED && teammate.x * direction > p.x * direction - 12 * FIXED)
              p.aiPass = true;
            else {
              const banks = [-1, 1].map(
                (side) => bankHeading(s.ball, side, team, s.tick)
              );
              const bank = banks.find((h) => h !== null);
              if (bank !== void 0 && bank !== null) aim = bank;
            }
          }
          p.aiAim = (aim + rng.drawInteger("cryptball", "ai", 9) - 4 + 256) % 256;
        } else p.aiAim = aimHeading(direction * 147 * FIXED - p.x, -p.y);
      }
      let dx = p.aiX - p.x, dy = p.aiY - p.y;
      if (due.includes(p) && distance(p, { x: p.aiX, y: p.aiY }) > 36 * FIXED && !clearLane(p, { x: p.aiX, y: p.aiY }, roster, [p.id])) {
        const lanes = [-48, 0, 48].map((y) => ({
          x: Math.round((p.x + p.aiX) / 2),
          y: y * FIXED
        }));
        const waypoint = lanes.filter((w) => clearLane(p, w, roster, [p.id])).sort(
          (a, b) => distance(p, a) + distance(a, { x: p.aiX, y: p.aiY }) - distance(p, b) - distance(b, { x: p.aiX, y: p.aiY })
        )[0];
        if (waypoint) {
          dx = waypoint.x - p.x;
          dy = waypoint.y - p.y;
        }
      }
      for (const q of roster)
        if (q.id !== p.id) {
          const d = distance(p, q);
          if (d < 22 * FIXED && d) {
            dx += (p.x - q.x) * (22 * FIXED - d) / d;
            dy += (p.y - q.y) * (22 * FIXED - d) / d;
          }
        }
      if (s.restartProtection && s.restartTeam !== team && direction * (p.x + dx) < 0)
        dx = -p.x;
      if (distance(p, s.ball) < 20 * FIXED && (Math.abs(s.ball.x) > 130 * FIXED || Math.abs(s.ball.y) > 67 * FIXED)) {
        p.aiAim = aimHeading(s.ball.x - p.x, s.ball.y - p.y);
      }
      const n = distance(p, { x: p.aiX, y: p.aiY }) < 2 * FIXED ? { x: 0, y: 0 } : normalized(dx, dy), c = {
        moveX: n.x,
        moveY: n.y,
        aim: p.aiAim,
        guard: s.tick >= p.aiGuardStart && s.tick < p.aiGuardUntil
      };
      if (distance(p, s.ball) < 19 * FIXED && !p.action && !p.charging && !p.dashTicks && s.tick - s.touchTick >= 6) {
        const v = headingVector(p.aiAim), bx = s.ball.x - p.x, by = s.ball.y - p.y, front = bx * v.x + by * v.y > length(bx, by) * 65536 * 0.65;
        if (front || s.mode === "practice") {
          if (s.mode === "practice" || p.aiPass) c.pass = true;
          else {
            const safe = s.players.filter((q) => q.team !== team).every((q) => distance(p, q) > 55 * FIXED) && length(s.ball.vx, s.ball.vy) < 40 * FIXED;
            c.strikePressed = true;
            c.strikeHeld = safe;
            c.strikeReleased = !safe;
          }
        }
      }
      if (p.charging) {
        c.strikeHeld = p.chargeTicks < RULES.chargeCap;
        c.strikeReleased = p.chargeTicks >= RULES.chargeCap;
      }
      commands.set(p.id, c);
    }
  }
  return commands;
}

// apps/cryptball/sim/session.ts
function createInitialState(mode = "match") {
  const s = {
    tick: 0,
    epoch: 1,
    nextEvent: 0,
    controllers: [
      {
        id: "local",
        team: 0,
        playerId: "player-0",
        active: true,
        canSwitch: true,
        pendingSwitch: null,
        switchReady: 0,
        revision: 0
      }
    ],
    teamStats: [
      { shots: 0, goals: 0, passes: 0 },
      { shots: 0, goals: 0, passes: 0 }
    ],
    participantStats: { local: { shots: 0, goals: 0, passes: 0 } },
    mode,
    phase: mode === "practice" ? "play" : "ready",
    phaseTicks: mode === "practice" ? 0 : 60,
    remainingTicks: RULES.regulationTicks,
    overtime: false,
    score: [0, 0],
    controlledId: "player-0",
    players: [0, 1, 2, 3].map(makePlayer),
    ball: {
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      rx: 0,
      ry: 0,
      dragCarry: 0,
      lastTouch: null,
      passFrom: null,
      passTarget: null,
      passTeam: null,
      passTick: 0,
      powerTeam: null,
      powerActionKey: null,
      bankBonusRemaining: 0,
      powerExpires: 0
    },
    stats: { shots: 0, goals: 0, passes: 0 },
    winner: null,
    restartTeam: null,
    restartProtection: 0,
    pendingSwitch: null,
    switchReady: 0,
    nextAction: 1,
    events: [],
    goalTeam: null,
    touchTick: -100
  };
  resetCourt(s);
  if (mode === "practice") {
    s.players[0].x = -24 * 256;
    s.players[0].y = 0;
    s.players[1].x = 56 * 256;
    s.players[1].y = -34 * 256;
    s.ball.x = -8 * 256;
  }
  return s;
}
function stepState(s, c, rng, participantCommands) {
  validateTick(s.tick + 1);
  const frames = participantCommands ?? {
    [s.controllers[0]?.id ?? "local"]: c
  };
  for (const frame of Object.values(frames))
    for (const n of [frame.moveX, frame.moveY, frame.aim])
      if (n !== void 0 && (!Number.isFinite(n) || Math.abs(n) > 65536))
        throw Error("Invalid command");
  s.tick++;
  const humanCommands = /* @__PURE__ */ new Map();
  for (const controller of s.controllers) {
    if (!controller.active) continue;
    let frame = frames[controller.id] ?? {};
    const old = s.players.find((p) => p.id === controller.playerId);
    if (frame.cancel) {
      old.charging = false;
      old.chargeTicks = 0;
      old.buffer = null;
      old.guardTicks = 0;
      frame = { cancel: true };
    } else if (frame.switch && controller.canSwitch && s.tick >= controller.switchReady) {
      controller.pendingSwitch = s.players.find(
        (p) => p.team === controller.team && p.id !== controller.playerId && !s.controllers.some((q) => q.playerId === p.id)
      )?.id ?? null;
      controller.switchReady = s.tick + 18;
      frame = { moveX: frame.moveX, moveY: frame.moveY, aim: frame.aim };
    }
    if (controller.pendingSwitch) {
      const target = s.players.find(
        (p) => p.id === controller.pendingSwitch && p.team === controller.team
      );
      if (target && !s.controllers.some((q) => q !== controller && q.playerId === target.id)) {
        old.charging = false;
        old.chargeTicks = 0;
        old.buffer = null;
        old.guardTicks = 0;
        controller.playerId = target.id;
        controller.revision++;
        frame = { moveX: frame.moveX, moveY: frame.moveY, aim: frame.aim };
        event(s, "switch", target, {
          participantId: controller.id,
          revision: controller.revision
        });
      }
      controller.pendingSwitch = null;
    }
    humanCommands.set(controller.playerId, frame);
  }
  s.controlledId = s.controllers[0]?.playerId ?? "player-0";
  if (s.phase !== "play") {
    advancePhase(s);
    return;
  }
  const commands = aiCommands(s, rng);
  for (const [id, frame] of humanCommands) commands.set(id, frame);
  for (const p of s.players) {
    if (s.mode === "practice" && p.team === 1) {
      p.vx = p.vy = 0;
      continue;
    }
    const input = commands.get(p.id) ?? {};
    admitAction(s, p, input);
    steer(p, input);
    if (s.restartProtection && s.restartTeam !== p.team) {
      if (p.team === 0 && p.x >= -RULES.playerRadius && p.vx > 0) p.vx = 0;
      if (p.team === 1 && p.x <= RULES.playerRadius && p.vx < 0) p.vx = 0;
    }
  }
  let goal = false;
  for (let sub = 0; sub < 4; sub++) {
    resolveStrikes(s);
    const active = s.mode === "practice" ? s.players.filter((p) => p.team === 0) : s.players;
    const emit = (e) => {
      if (e.type === "pass-complete" && typeof e.passerId === "string") {
        const passer = s.players.find((p) => p.id === e.passerId);
        if (passer) recordStat(s, passer, "passes");
      }
      s.events.push({ ...e, epoch: s.epoch, counter: s.nextEvent++ });
    };
    const paths = movePlayers(active, s.ball, s.tick, emit);
    resolveChecks(s);
    const team = moveBall(s.ball, paths, s.tick, emit);
    if (team !== null) {
      if (s.mode === "match")
        s.remainingTicks = Math.max(0, s.remainingTicks - 1);
      scoreGoal(s, team);
      goal = true;
      break;
    }
  }
  if (!goal) {
    dragBall(s.ball);
    if (s.ball.passFrom && s.tick - s.ball.passTick >= 90) {
      s.ball.passFrom = s.ball.passTarget = null;
      s.ball.passTeam = null;
    }
    if (s.tick >= s.ball.powerExpires) {
      s.ball.bankBonusRemaining = 0;
      s.ball.powerTeam = null;
      s.ball.powerActionKey = null;
    }
    finishActions(s);
    s.restartProtection = Math.max(0, s.restartProtection - 1);
    if (s.mode === "match") {
      s.remainingTicks = Math.max(0, s.remainingTicks - 1);
      expireClock(s);
    }
  }
}
function createCryptballSession(options = {}) {
  let state = createInitialState(options.mode);
  let rng = new DeterministicRandom([
    {
      owner: "cryptball",
      name: "ai",
      seed: (Math.trunc(options.seed ?? 13089297) % 4294967296 + 4294967296) % 4294967296
    }
  ]);
  return {
    step(c = {}) {
      stepState(state, c, rng);
    },
    stepParticipants(commands = {}) {
      stepState(state, {}, rng, commands);
    },
    setParticipants(participants) {
      if (participants.length > 4 || new Set(participants.map((p) => p.id)).size !== participants.length || new Set(participants.map((p) => p.playerId)).size !== participants.length)
        throw Error("Invalid participants");
      for (const p of participants)
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(p.id) || !state.players.some((q) => q.id === p.playerId && q.team === p.team))
          throw Error("Invalid participant ownership");
      state.controllers = participants.map((p) => ({
        ...p,
        active: p.active ?? true,
        canSwitch: participants.filter((q) => q.team === p.team).length === 1,
        pendingSwitch: null,
        switchReady: state.tick,
        revision: 0
      }));
      state.participantStats = Object.fromEntries(
        participants.map((p) => [p.id, { shots: 0, goals: 0, passes: 0 }])
      );
      state.controlledId = participants[0]?.playerId ?? "player-0";
    },
    setParticipantActive(id, active) {
      const controller = state.controllers.find((p) => p.id === id);
      if (!controller) throw Error("Unknown participant");
      if (controller.active !== active) {
        controller.active = active;
        controller.revision++;
        controller.pendingSwitch = null;
        const p = state.players.find((p2) => p2.id === controller.playerId);
        p.charging = false;
        p.chargeTicks = 0;
        p.buffer = null;
        p.guardTicks = 0;
      }
    },
    capture() {
      const snapshot = structuredClone(state);
      snapshot.events = [];
      return { version: 2, state: snapshot, rng: rng.capture() };
    },
    restore(value) {
      const staged = validateCheckpoint(value, rng.capture());
      const stagedRng = new DeterministicRandom(
        staged.rng.streams.map(({ owner, name, seed }) => ({
          owner,
          name,
          seed
        }))
      );
      stagedRng.restore(staged.rng);
      rng = stagedRng;
      state = staged.state;
    },
    observeFor(id) {
      const snapshot = this.observe();
      const controller = state.controllers.find((p) => p.id === id);
      if (!controller) throw Error("Unknown participant");
      snapshot.controlledId = controller.playerId;
      snapshot.stats = structuredClone(state.teamStats[controller.team]);
      return snapshot;
    },
    observe() {
      const {
        pendingSwitch,
        switchReady,
        nextAction,
        events,
        goalTeam,
        touchTick,
        ...observation
      } = state;
      return structuredClone(observation);
    },
    drainEvents() {
      return state.events.splice(0);
    }
  };
}
export {
  createCryptballSession,
  createInitialState,
  stepState
};
