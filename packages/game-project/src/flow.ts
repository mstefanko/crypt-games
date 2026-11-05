import {
  array,
  boundedJSON,
  canonical,
  integer,
  record,
  string,
} from "./runtime.ts";

export type FlowKind = "title" | "play" | "loss" | "cinematic" | "result";
export type FlowSignal =
  | "start"
  | "lost"
  | "won"
  | "retry"
  | "complete"
  | "skip"
  | "cancel"
  | "restart";
const kinds: readonly FlowKind[] = [
  "title",
  "play",
  "loss",
  "cinematic",
  "result",
];
const signals: readonly FlowSignal[] = [
  "start",
  "lost",
  "won",
  "retry",
  "complete",
  "skip",
  "cancel",
  "restart",
];
const legal: Record<FlowKind, readonly FlowSignal[]> = {
  title: ["start"],
  play: ["lost", "won", "restart"],
  loss: ["retry", "restart"],
  cinematic: ["complete", "skip", "cancel"],
  result: ["restart"],
};
export interface FlowDocument {
  readonly version: 1;
  readonly initial: string;
  readonly nodes: readonly {
    readonly id: string;
    readonly kind: FlowKind;
    readonly levelId?: string;
    readonly sceneId?: string;
  }[];
  readonly edges: readonly {
    readonly from: string;
    readonly signal: FlowSignal;
    readonly to: string;
  }[];
}
export interface FlowState {
  node: string;
  epoch: number;
  slotInstance: number;
  sequence: number;
  gameplayTick: number;
  cinematicTick: number;
}
export interface HostCommand {
  slotInstance: number;
  flowEpoch: number;
  sequence: number;
  gameplayTick: number;
  cinematicTick: number;
  signal: FlowSignal;
  outcomeToken: string;
}
export interface FlowTransition {
  from: string;
  to: string;
  signal: FlowSignal;
  slotInstance: number;
}
export function validateFlow(raw: unknown): FlowDocument {
  const value = record(raw, ["version", "initial", "nodes", "edges"], "flow");
  integer(value.version, 1, 1);
  const initial = string(value.initial);
  const nodes = array(value.nodes, 16).map((rawNode) => {
    const kindValue = (rawNode as { kind?: unknown })?.kind;
    const node = record(
      rawNode,
      kindValue === "play"
        ? ["id", "kind", "levelId"]
        : kindValue === "cinematic"
          ? ["id", "kind", "sceneId"]
          : ["id", "kind"],
    );
    const id = string(node.id),
      kind = node.kind as FlowKind;
    if (!kinds.includes(kind)) throw Error("Unknown flow node kind");
    return Object.freeze({
      id,
      kind,
      ...(kind === "play" ? { levelId: string(node.levelId) } : {}),
      ...(kind === "cinematic" ? { sceneId: string(node.sceneId) } : {}),
    });
  });
  const ids = new Set(nodes.map((node) => node.id));
  if (!nodes.length || ids.size !== nodes.length || !ids.has(initial))
    throw Error("Invalid flow node identities");
  if (nodes.find((node) => node.id === initial)?.kind !== "title")
    throw Error("Flow must begin at a title node");
  const seen = new Set<string>();
  const edges = array(value.edges, 64).map((rawEdge) => {
    const edge = record(rawEdge, ["from", "signal", "to"]);
    const from = string(edge.from),
      to = string(edge.to),
      signal = edge.signal as FlowSignal;
    const kind = nodes.find((node) => node.id === from)?.kind;
    if (
      !ids.has(to) ||
      !kind ||
      !signals.includes(signal) ||
      !legal[kind].includes(signal)
    )
      throw Error("Invalid flow edge");
    const expected: Record<FlowSignal, FlowKind> = {
      start: "play",
      retry: "play",
      lost: "loss",
      won: "cinematic",
      complete: "result",
      skip: "result",
      cancel: "title",
      restart: "title",
    };
    if (nodes.find((node) => node.id === to)?.kind !== expected[signal])
      throw Error("Invalid flow edge destination");
    const key = `${from}:${signal}`;
    if (seen.has(key)) throw Error("Ambiguous flow edge");
    seen.add(key);
    return Object.freeze({ from, signal, to });
  });
  for (const node of nodes) {
    const required = legal[node.kind].filter(
      (signal) => signal !== "restart" || node.kind === "result",
    );
    if (required.some((signal) => !seen.has(`${node.id}:${signal}`)))
      throw Error(`Missing declared flow control for ${node.id}`);
  }
  const reachable = new Set([initial]);
  for (let i = 0; i < nodes.length; i++)
    for (const edge of edges)
      if (reachable.has(edge.from)) reachable.add(edge.to);
  if (reachable.size !== nodes.length) throw Error("Unreachable flow node");
  return Object.freeze({
    version: 1,
    initial,
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
  });
}
export function flowKind(document: FlowDocument, state: FlowState): FlowKind {
  const node = document.nodes.find((node) => node.id === state.node);
  if (!node) throw Error("Unknown flow state node");
  return node.kind;
}
export function createFlow(document: FlowDocument): FlowState {
  return {
    node: document.initial,
    epoch: 1,
    slotInstance: 1,
    sequence: 0,
    gameplayTick: 0,
    cinematicTick: 0,
  };
}
export function outcomeToken(state: FlowState): string {
  return `outcome:${state.epoch}:${state.slotInstance}`;
}
export function hostCommand(
  state: FlowState,
  signal: FlowSignal,
  sequence = state.sequence + 1,
): HostCommand {
  return {
    slotInstance: state.slotInstance,
    flowEpoch: state.epoch,
    sequence,
    gameplayTick: state.gameplayTick,
    cinematicTick: state.cinematicTick,
    signal,
    outcomeToken: ["lost", "won", "complete", "skip", "cancel"].includes(signal)
      ? outcomeToken(state)
      : "",
  };
}
function validateCommand(raw: unknown): HostCommand {
  const c = record(raw, [
    "slotInstance",
    "flowEpoch",
    "sequence",
    "gameplayTick",
    "cinematicTick",
    "signal",
    "outcomeToken",
  ]);
  for (const key of ["slotInstance", "flowEpoch", "sequence"])
    integer(c[key], 1, Number.MAX_SAFE_INTEGER);
  for (const key of ["gameplayTick", "cinematicTick"])
    integer(c[key], 0, Number.MAX_SAFE_INTEGER);
  if (
    !signals.includes(c.signal as FlowSignal) ||
    typeof c.outcomeToken !== "string" ||
    c.outcomeToken.length > 128
  )
    throw Error("Invalid host command");
  return c as unknown as HostCommand;
}
/** Bounded explicit dispatch. Validate the complete batch before committing any transition. */
export function dispatchFlow(
  document: FlowDocument,
  state: FlowState,
  raw: readonly HostCommand[],
): FlowTransition[] {
  const commands = array(raw, 32)
    .map(validateCommand)
    .sort((a, b) => a.sequence - b.sequence);
  const unique = new Map<number, string>();
  for (const command of commands) {
    const bytes = canonical(command),
      prior = unique.get(command.sequence);
    if (prior && prior !== bytes)
      throw Error("Conflicting host command sequence");
    unique.set(command.sequence, bytes);
  }
  const next = { ...state },
    transitions: FlowTransition[] = [];
  for (const command of commands) {
    if (command.sequence <= next.sequence) continue;
    next.sequence = command.sequence;
    if (
      command.flowEpoch !== next.epoch ||
      command.slotInstance !== next.slotInstance ||
      command.gameplayTick !== next.gameplayTick ||
      command.cinematicTick !== next.cinematicTick
    )
      continue;
    const edge = document.edges.find(
      (edge) => edge.from === next.node && edge.signal === command.signal,
    );
    if (!edge) continue;
    const outcome = ["lost", "won", "complete", "skip", "cancel"].includes(
      command.signal,
    );
    if (command.outcomeToken !== (outcome ? outcomeToken(next) : "")) continue;
    if (next.slotInstance === Number.MAX_SAFE_INTEGER)
      throw Error("Flow instance exhausted");
    transitions.push({
      from: next.node,
      to: edge.to,
      signal: command.signal,
      slotInstance: next.slotInstance + 1,
    });
    next.node = edge.to;
    next.slotInstance++;
    next.cinematicTick = 0;
  }
  Object.assign(state, next);
  return transitions;
}
export function saveFlow(document: FlowDocument, state: FlowState): string {
  if (flowKind(document, state) === "cinematic")
    throw Error("Save before or after cinematic slots");
  return canonical(state);
}
export function restoreFlow(
  document: FlowDocument,
  current: FlowState,
  json: string,
): FlowState {
  const raw = record(boundedJSON(json, 2048, { rejectNegativeZero: true }), [
    "node",
    "epoch",
    "slotInstance",
    "sequence",
    "gameplayTick",
    "cinematicTick",
  ]);
  const node = string(raw.node);
  for (const key of ["epoch", "slotInstance"])
    integer(raw[key], 1, Number.MAX_SAFE_INTEGER - 1);
  for (const key of ["sequence", "gameplayTick"])
    integer(raw[key], 0, Number.MAX_SAFE_INTEGER);
  integer(raw.cinematicTick, 0, 0);
  const saved = raw as unknown as FlowState;
  if (
    !document.nodes.some((entry) => entry.id === node) ||
    flowKind(document, saved) === "cinematic"
  )
    throw Error("Invalid saved flow node");
  integer(current.epoch, 1, Number.MAX_SAFE_INTEGER - 1);
  integer(current.slotInstance, 1, Number.MAX_SAFE_INTEGER - 1);
  return {
    ...saved,
    epoch: Math.max(current.epoch, saved.epoch) + 1,
    slotInstance: Math.max(current.slotInstance, saved.slotInstance) + 1,
    sequence: Math.max(current.sequence, saved.sequence),
  };
}
