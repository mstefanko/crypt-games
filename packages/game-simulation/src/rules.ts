/** Shared policy core. Consumers: arena upgrades, card scoring, narrative and settlement. */
export interface RuleState {
  flags: Record<string, boolean>;
  stats: Record<string, number>;
  inventory: Record<string, number>;
  tags?: string[];
  facts?: Record<string, string | number | boolean>;
}
export type RuleCondition =
  | { kind: "all" | "any"; conditions: RuleCondition[] }
  | { kind: "not"; condition: RuleCondition }
  | { kind: "flag"; key: string; value?: boolean }
  | { kind: "tag"; tag: string }
  | {
      kind: "stat" | "item";
      key: string;
      op: "eq" | "gte" | "lte" | "gt" | "lt";
      value: number;
    }
  | { kind: "fact"; key: string; value: string | number | boolean };
export function evaluateCondition(
  condition: RuleCondition | undefined,
  state: RuleState,
): boolean {
  if (!condition) return true;
  switch (condition.kind) {
    case "all":
      return condition.conditions.every((c) => evaluateCondition(c, state));
    case "any":
      return condition.conditions.some((c) => evaluateCondition(c, state));
    case "not":
      return !evaluateCondition(condition.condition, state);
    case "flag":
      return !!state.flags[condition.key] === (condition.value ?? true);
    case "tag":
      return !!state.tags?.includes(condition.tag);
    case "fact":
      return state.facts?.[condition.key] === condition.value;
    default: {
      const n =
        (condition.kind === "stat" ? state.stats : state.inventory)[
          condition.key
        ] ?? 0;
      switch (condition.op) {
        case "eq":
          return n === condition.value;
        case "gte":
          return n >= condition.value;
        case "lte":
          return n <= condition.value;
        case "gt":
          return n > condition.value;
        case "lt":
          return n < condition.value;
      }
    }
  }
}
export interface StatModifier {
  id: string;
  source: string;
  stat: string;
  operation: "add" | "multiply" | "set";
  value: number;
  phase?: number;
  priority?: number;
  order?: number;
  sourceTags?: string[];
  targetTags?: string[];
  expiresAt?: number;
  stacking?: "stack" | "replace";
}
/** Ascending phase/priority/order/id; derive from the base every time, never undo clamped deltas. */
export function modifiedStat(
  base: number,
  stat: string,
  modifiers: readonly StatModifier[],
  tags: readonly string[] = [],
  now = 0,
): number {
  const eligible = modifiers.filter(
    (m) =>
      m.stat === stat &&
      (m.expiresAt === undefined || m.expiresAt > now) &&
      (!m.targetTags || m.targetTags.every((t) => tags.includes(t))),
  );
  const sorted = [...eligible].sort(
    (a, b) =>
      (a.phase ?? 0) - (b.phase ?? 0) ||
      (a.priority ?? 0) - (b.priority ?? 0) ||
      (a.order ?? 0) - (b.order ?? 0) ||
      a.id.localeCompare(b.id),
  );
  let value = base;
  for (const m of sorted) {
    if (
      m.stacking === "replace" &&
      sorted.some(
        (n) =>
          n !== m &&
          n.source === m.source &&
          n.stat === m.stat &&
          sorted.indexOf(n) > sorted.indexOf(m),
      )
    )
      continue;
    value =
      m.operation === "set"
        ? m.value
        : m.operation === "add"
          ? value + m.value
          : value * m.value;
    if (!Number.isFinite(value)) throw Error("Non-finite modified stat");
  }
  return value;
}
export type StateEffect =
  | { kind: "flag"; key: string; value: boolean }
  | { kind: "stat"; key: string; amount: number; min?: number; max?: number }
  | { kind: "item"; key: string; amount: number };
export interface EffectTrace {
  source: string;
  operation: string;
  before: number | string | boolean;
  after: number | string | boolean;
}
export function applyStateEffect(
  state: RuleState,
  effect: StateEffect,
): EffectTrace {
  if (effect.kind === "flag") {
    const before = !!state.flags[effect.key];
    state.flags[effect.key] = effect.value;
    return {
      source: effect.key,
      operation: "flag",
      before,
      after: effect.value,
    };
  }
  const table = effect.kind === "stat" ? state.stats : state.inventory;
  const before = table[effect.key] ?? 0;
  const after =
    effect.kind === "stat"
      ? Math.min(
          effect.max ?? Infinity,
          Math.max(effect.min ?? -Infinity, before + effect.amount),
        )
      : before + effect.amount;
  if (
    !Number.isFinite(after) ||
    (effect.kind === "item" && (!Number.isInteger(after) || after < 0))
  )
    throw Error("Invalid effect quantity");
  table[effect.key] = after;
  return { source: effect.key, operation: effect.kind, before, after };
}
export interface RuleTrigger<E> {
  id: string;
  hook: string;
  condition?: RuleCondition;
  effects: readonly E[];
  priority?: number;
  order?: number;
  cooldown?: number;
  excludedSources?: string[];
  oncePerAction?: boolean;
  oncePerTurn?: boolean;
  maxStacks?: number;
  uses?: number;
}
export interface TriggerMemory {
  lastAt: Record<string, number>;
  actions: Record<string, string>;
  turns: Record<string, string>;
  uses: Record<string, number>;
}
export const createTriggerMemory = (): TriggerMemory => ({
  lastAt: {},
  actions: {},
  turns: {},
  uses: {},
});
export interface TriggerContext {
  hook: string;
  now: number;
  actionId: string;
  turnId: string;
  sources: readonly string[];
  stacks?: Record<string, number>;
}
export function eligibleTriggers<E>(
  triggers: readonly RuleTrigger<E>[],
  state: RuleState,
  context: TriggerContext,
  memory: TriggerMemory,
): RuleTrigger<E>[] {
  return triggers
    .filter(
      (t) =>
        t.hook === context.hook &&
        evaluateCondition(t.condition, state) &&
        !t.excludedSources?.some((s) => context.sources.includes(s)) &&
        context.now - (memory.lastAt[t.id] ?? -Infinity) >= (t.cooldown ?? 0) &&
        (!t.oncePerAction || memory.actions[t.id] !== context.actionId) &&
        (!t.oncePerTurn || memory.turns[t.id] !== context.turnId) &&
        (memory.uses[t.id] ?? 0) < (t.uses ?? Infinity) &&
        (context.stacks?.[t.id] ?? 1) <= (t.maxStacks ?? Infinity),
    )
    .sort(
      (a, b) =>
        (a.priority ?? 0) - (b.priority ?? 0) ||
        (a.order ?? 0) - (b.order ?? 0) ||
        a.id.localeCompare(b.id),
    );
}
export function markTrigger(
  id: string,
  context: TriggerContext,
  memory: TriggerMemory,
): void {
  memory.lastAt[id] = context.now;
  memory.actions[id] = context.actionId;
  memory.turns[id] = context.turnId;
  memory.uses[id] = (memory.uses[id] ?? 0) + 1;
}
export class RuleBudget {
  private count = 0;
  constructor(readonly limit = 64) {}
  step(): void {
    if (++this.count > this.limit) throw Error("Rule work limit exceeded");
  }
  get used(): number {
    return this.count;
  }
}
/** Engine domain handlers run on staged state. Caller commits the returned state exactly once. */
export function resolveRuleTransaction<S, E>(
  original: S,
  effects: readonly E[],
  handler: (
    state: S,
    effect: E,
    budget: RuleBudget,
  ) => EffectTrace | readonly EffectTrace[],
  limit = 64,
): { state: S; trace: readonly EffectTrace[] } {
  const state = structuredClone(original);
  const budget = new RuleBudget(limit);
  const trace: EffectTrace[] = [];
  for (const effect of effects) {
    budget.step();
    const result = handler(state, effect, budget);
    trace.push(...(Array.isArray(result) ? result : [result as EffectTrace]));
  }
  return { state, trace: Object.freeze(trace.map((t) => Object.freeze(t))) };
}
