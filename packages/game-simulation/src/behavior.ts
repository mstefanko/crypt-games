/** B0's finite pattern: one decision/transition per actor per integer tick. */
export const BEHAVIOR_LIMITS = Object.freeze({
  ticks: 256,
  actors: 2,
  transitionsPerActor: 1,
});
export type BehaviorRole = "bruiser" | "ranger";
export type BehaviorState = "approach" | "windup" | "recover" | "retreat";
export interface BehaviorActor {
  readonly role: BehaviorRole;
  readonly state: BehaviorState;
  readonly timer: number;
  readonly position: number;
  readonly attacks: number;
  readonly transitions: number;
}
export interface BehaviorInput {
  readonly target: number;
  readonly threatened: boolean;
}
export const BEHAVIOR_DESCRIPTORS = Object.freeze({
  version: "b0-two-role-v1",
  priority: Object.freeze([
    "threat-retreat",
    "finish-timer",
    "enter-range",
  ] as const),
  states: Object.freeze(["approach", "windup", "recover", "retreat"] as const),
  bruiser: Object.freeze({
    range: 1,
    windup: 2,
    recovery: 3,
    retreat: 2,
    damage: 3,
  }),
  ranger: Object.freeze({
    range: 4,
    windup: 3,
    recovery: 1,
    retreat: 3,
    damage: 1,
  }),
});
export interface BehaviorParameters {
  readonly range: number;
  readonly windup: number;
  readonly recovery: number;
  readonly retreat: number;
}
export const BEHAVIOR_PARAMETER_FIELDS = Object.freeze({
  range: Object.freeze({ minimum: 1, maximum: 16, units: "16-pixel cells" }),
  windup: Object.freeze({ minimum: 1, maximum: 120, units: "decision ticks" }),
  recovery: Object.freeze({
    minimum: 1,
    maximum: 120,
    units: "decision ticks",
  }),
  retreat: Object.freeze({ minimum: 1, maximum: 120, units: "decision ticks" }),
});
export function validateBehaviorParameters(value: unknown): BehaviorParameters {
  const keys = Object.keys(BEHAVIOR_PARAMETER_FIELDS);
  if (
    value &&
    typeof value === "object" &&
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && !Object.hasOwn(descriptor, "value");
    })
  )
    throw Error("Accessor behavior parameters are unsupported");
  const source = fields(value, keys);
  for (const [key, bounds] of Object.entries(BEHAVIOR_PARAMETER_FIELDS)) {
    const number = source[key];
    if (
      !Number.isSafeInteger(number) ||
      Object.is(number, -0) ||
      (number as number) < bounds.minimum ||
      (number as number) > bounds.maximum
    )
      throw Error(`Invalid behavior parameter ${key}`);
  }
  return { ...source } as unknown as BehaviorParameters;
}
export interface BehaviorSnapshot {
  readonly format: "b0-two-role-v1";
  readonly tick: number;
  readonly targetHealth: number;
  readonly actors: readonly BehaviorActor[];
  readonly inputs: readonly BehaviorInput[];
}
function fields(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw Error("Invalid behavior fields");
  return value as Record<string, unknown>;
}
function input(value: unknown): BehaviorInput {
  const source = fields(value, ["target", "threatened"]);
  if (
    !Number.isSafeInteger(source.target) ||
    Object.is(source.target, -0) ||
    (source.target as number) < -32 ||
    (source.target as number) > 32 ||
    typeof source.threatened !== "boolean"
  )
    throw Error("Invalid behavior input");
  return { target: source.target as number, threatened: source.threatened };
}
function canonical(
  value: unknown,
  depth = 0,
  budget = { remaining: 4096 },
): string {
  if (--budget.remaining < 0) throw Error("Behavior checkpoint node cap");
  if (depth > 8) throw Error("Behavior checkpoint depth cap");
  if (typeof value === "string" && value.length > 64)
    throw Error("Behavior checkpoint string cap");
  if (typeof value === "string" || typeof value === "boolean" || value === null)
    return JSON.stringify(value);
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0)
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > BEHAVIOR_LIMITS.ticks ||
      Reflect.ownKeys(value).length !== value.length + 1
    )
      throw Error("Invalid behavior array");
    return `[${Array.from(value, (item) => canonical(item, depth + 1, budget)).join(",")}]`;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw Error("Invalid behavior data");
  const keys = Reflect.ownKeys(value);
  if (keys.length > 12 || keys.some((key) => typeof key !== "string"))
    throw Error("Invalid behavior keys");
  return `{${(keys as string[])
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1, budget)}`,
    )
    .join(",")}}`;
}
export function createBehaviorActor(role: BehaviorRole): BehaviorActor {
  if (role !== "bruiser" && role !== "ranger")
    throw Error("Invalid behavior role");
  return {
    role,
    state: "approach",
    timer: 0,
    position: role === "bruiser" ? -5 : 7,
    attacks: 0,
    transitions: 0,
  };
}
function validateActor(
  value: unknown,
  parameters?: BehaviorParameters,
): BehaviorActor {
  const source = fields(value, [
    "role",
    "state",
    "timer",
    "position",
    "attacks",
    "transitions",
  ]);
  if (source.role !== "bruiser" && source.role !== "ranger")
    throw Error("Invalid behavior role");
  if (
    source.state !== "approach" &&
    source.state !== "windup" &&
    source.state !== "recover" &&
    source.state !== "retreat"
  )
    throw Error("Invalid behavior state");
  const spec = parameters ?? BEHAVIOR_DESCRIPTORS[source.role];
  const timerMax =
    source.state === "approach"
      ? 0
      : source.state === "windup"
        ? spec.windup
        : source.state === "recover"
          ? spec.recovery
          : spec.retreat;
  for (const [key, min, max] of [
    ["timer", timerMax ? 1 : 0, timerMax],
    ["position", -32, 32],
    ["attacks", 0, Number.MAX_SAFE_INTEGER],
    ["transitions", 0, Number.MAX_SAFE_INTEGER],
  ] as const) {
    const number = source[key];
    if (
      !Number.isSafeInteger(number) ||
      Object.is(number, -0) ||
      (number as number) < min ||
      (number as number) > max
    )
      throw Error("Invalid behavior actor integer");
  }
  return source as unknown as BehaviorActor;
}
/** Typed pattern; geometry/pathfinding and target selection remain consumer-owned.
 * Threat interrupts before timer completion; an interrupted windup never hits. */
export function stepBehavior(
  actor: BehaviorActor,
  intent: BehaviorInput,
  parameters?: BehaviorParameters,
): { actor: BehaviorActor; damage: number } {
  if (parameters !== undefined)
    parameters = validateBehaviorParameters(parameters);
  actor = validateActor(actor, parameters);
  intent = input(intent);
  const definition = { ...BEHAVIOR_DESCRIPTORS[actor.role], ...parameters };
  let state = actor.state,
    timer = Math.max(0, actor.timer - 1),
    position = actor.position,
    damage = 0;
  if (intent.threatened && (state !== "retreat" || timer === 0)) {
    state = "retreat";
    timer = definition.retreat;
  } else if (state !== "approach" && timer === 0) {
    if (state === "windup") {
      state = "recover";
      timer = definition.recovery;
      damage = definition.damage;
    } else state = "approach";
  } else if (
    state === "approach" &&
    Math.abs(position - intent.target) <= definition.range
  ) {
    state = "windup";
    timer = definition.windup;
  }
  // Position is clamped so indefinitely threatened targets cannot exhaust bounds.
  if (
    state === "approach" &&
    Math.abs(position - intent.target) > definition.range
  )
    position += Math.sign(intent.target - position);
  if (state === "retreat")
    position = Math.max(
      -32,
      Math.min(32, position + (position >= intent.target ? 1 : -1)),
    );
  const next = {
    actor: {
      role: actor.role,
      state,
      timer,
      position,
      // Diagnostic totals must never stop the reusable runner.
      attacks: Math.min(
        Number.MAX_SAFE_INTEGER,
        actor.attacks + (damage ? 1 : 0),
      ),
      transitions: Math.min(
        Number.MAX_SAFE_INTEGER,
        actor.transitions + (state !== actor.state ? 1 : 0),
      ),
    },
    damage,
  };
  validateActor(next.actor, parameters);
  return next;
}
/** Exact proof owner. All future-affecting state is captured, and bounded input
 * replay rejects impossible states atomically instead of trusting edited timers. */
export class BehaviorEncounterFixture {
  private actors = [
    createBehaviorActor("bruiser"),
    createBehaviorActor("ranger"),
  ];
  private inputs: BehaviorInput[] = [];
  private targetHealth = 1000;
  step(value: BehaviorInput): BehaviorSnapshot {
    const accepted = input(value);
    if (this.inputs.length >= BEHAVIOR_LIMITS.ticks)
      throw Error("Behavior tick cap exceeded");
    const results = this.actors.map((actor) => stepBehavior(actor, accepted));
    this.actors = results.map((result) => result.actor);
    this.targetHealth -= results.reduce(
      (sum, result) => sum + result.damage,
      0,
    );
    this.inputs.push(accepted);
    return this.capture();
  }
  capture(): BehaviorSnapshot {
    return {
      format: "b0-two-role-v1",
      tick: this.inputs.length,
      targetHealth: this.targetHealth,
      actors: this.actors.map((actor) => ({ ...actor })),
      inputs: this.inputs.map((entry) => ({ ...entry })),
    };
  }
  restore(value: unknown): void {
    const normalized = canonical(value);
    const source = fields(value, [
      "format",
      "tick",
      "targetHealth",
      "actors",
      "inputs",
    ]);
    if (
      source.format !== "b0-two-role-v1" ||
      !Array.isArray(source.inputs) ||
      source.inputs.length > BEHAVIOR_LIMITS.ticks
    )
      throw Error("Incompatible behavior checkpoint");
    const staged = new BehaviorEncounterFixture();
    for (const entry of source.inputs) staged.step(input(entry));
    if (normalized !== canonical(staged.capture()))
      throw Error("Inconsistent behavior checkpoint");
    this.actors = staged.actors;
    this.inputs = staged.inputs;
    this.targetHealth = staged.targetHealth;
  }
}
