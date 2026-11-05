/** Gameplay time is integer 60 Hz. Calendar, command revisions, run identity and
 * presentation session epochs are independent domains; none reads a wall clock. */
export const GAMEPLAY_HZ = 60;
export const TIMED_ENCOUNTER_PHASES = Object.freeze([
  "command-acceptance",
  "intent",
  "motion",
  "collect",
  "commit",
  "observation",
  "cue-emission",
] as const);
export type TimedEncounterPhase = (typeof TIMED_ENCOUNTER_PHASES)[number];

/** Descriptive contracts for inherited implementations, not a replacement
 * scheduler. Keep each family's actual order and participant freeze semantics. */
export const TIME_POLICIES = Object.freeze({
  platform: Object.freeze({
    clock: "60hz-gameplay-ticks",
    order:
      "input -> buffers/AI -> platform proposals -> motion -> separation -> combat/trades -> deaths/flow -> tick commit -> observation",
    hitStop:
      "participant intent/execution freeze; platform proposals and tick continue",
    pause:
      "host stops steps and cancels unsafe device input; no new tactical queue is added to this legacy family",
  }),
  arena: Object.freeze({
    clock: "60hz-gameplay-ticks-while-playing",
    order:
      "preflight/input -> eligible AI/timers/motion -> gather shove/melee/projectile contacts -> trades/shoves -> deaths -> tick/result -> observation",
    hitStop:
      "participants frozen at tick start; their timers/motion stop; input buffers, existing projectiles and global tick continue",
    pause:
      "host stops steps and cancels unsafe device input; no new tactical queue is added to this legacy family",
  }),
  duel: Object.freeze({
    clock: "platform-60hz-gameplay-ticks",
    order: "platform step with two slots -> observation -> derived duel result",
    hitStop: "inherits platform participant freeze",
    pause: "inherits host safety pause; no new tactical queue is added",
  }),
  m2: Object.freeze({
    clock: "separate-gameplay-and-cinematic-ticks",
    order:
      "play: platform step -> gameplay tick copy -> terminal flow dispatch; cinematic: separate Director/cinematic step",
    hitStop:
      "play inherits platform participant freeze; cinematic time has its separate owner",
    pause:
      "host pauses gameplay/Director scheduling and cancels unsafe device input",
  }),
  grid: Object.freeze({
    clock: "accepted-command-sequence-and-revision-no-idle-ticks",
    order:
      "validate sequence/revision -> stage move/undo/restart -> validate position -> atomic state/revision commit -> observation",
    hitStop: "not applicable to discrete commands",
    pause: "host blocks intake; idle has no simulation tick",
  }),
  adventure: Object.freeze({
    clock: "accepted-command-sequence-and-revision-no-idle-ticks",
    order:
      "validate order -> stage active/campaign effects -> validate -> atomic commit; travel prepares -> loads outside authority -> revalidates current state -> commits",
    hitStop: "not applicable to discrete commands",
    pause:
      "host blocks intake/cancels unsafe input; staged travel is owned separately",
  }),
});

export interface RulesCue {
  /** A new run must use a distinct (runId, runEpoch) pair; restore preserves it. */
  readonly runId: string;
  readonly runEpoch: number;
  /** Monotonic within the run; the identity does not include a render epoch. */
  readonly sequence: number;
  readonly tick: number;
  readonly kind: "encounter" | "reward" | "retreat";
}
export const CUE_COUNTER_MAX = 1_000_000;
export function validateRunIdentity(runId: unknown, runEpoch: unknown): void {
  if (
    typeof runId !== "string" ||
    !/^[a-z][a-z0-9.-]{0,63}$/.test(runId) ||
    typeof runEpoch !== "number" ||
    !Number.isInteger(runEpoch) ||
    runEpoch < 0 ||
    runEpoch > CUE_COUNTER_MAX
  )
    throw Error("Invalid rules run identity");
}
export function parseRulesCue(value: unknown): RulesCue {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw Error("Invalid rules cue");
  const cue = value as Record<string, unknown>;
  const keys = ["runId", "runEpoch", "sequence", "tick", "kind"];
  if (
    Object.keys(cue).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(cue, key))
  )
    throw Error("Invalid rules cue fields");
  validateRunIdentity(cue.runId, cue.runEpoch);
  if (
    typeof cue.sequence !== "number" ||
    !Number.isInteger(cue.sequence) ||
    cue.sequence < 1 ||
    cue.sequence > CUE_COUNTER_MAX ||
    typeof cue.tick !== "number" ||
    !Number.isInteger(cue.tick) ||
    cue.tick < 0 ||
    cue.tick > CUE_COUNTER_MAX ||
    (cue.kind !== "encounter" &&
      cue.kind !== "reward" &&
      cue.kind !== "retreat")
  )
    throw Error("Invalid rules cue counters or kind");
  return {
    runId: cue.runId as string,
    runEpoch: cue.runEpoch as number,
    sequence: cue.sequence,
    tick: cue.tick,
    kind: cue.kind,
  };
}
export function rulesCueId(value: RulesCue): string {
  const cue = parseRulesCue(value);
  return `${cue.runId}:${cue.runEpoch}:${cue.sequence}`;
}
