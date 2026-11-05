import { describe, expect, it } from "vitest";
import document from "../../../examples/game-m2/flow.json";
import {
  createFlow,
  dispatchFlow,
  hostCommand,
  restoreFlow,
  saveFlow,
  validateFlow,
} from "./flow.ts";
const flow = validateFlow(document);
describe("bounded explicit flow", () => {
  it("replays declared title, loss, retry, cinematic, result, restart without a renderer", () => {
    const state = createFlow(flow);
    for (const signal of [
      "start",
      "lost",
      "retry",
      "won",
      "skip",
      "restart",
    ] as const) {
      expect(
        dispatchFlow(flow, state, [hostCommand(state, signal)]),
      ).toHaveLength(1);
    }
    expect(state.node).toBe("title");
    expect(state.slotInstance).toBe(7);
  });
  it("orders commands by monotonic sequence and consumes duplicate outcomes once", () => {
    const state = createFlow(flow);
    dispatchFlow(flow, state, [hostCommand(state, "start")]);
    const won = hostCommand(state, "won"),
      duplicate = { ...won, sequence: won.sequence + 1 };
    expect(dispatchFlow(flow, state, [duplicate, won, won])).toHaveLength(1);
    expect(state.node).toBe("cinematic");
    expect(dispatchFlow(flow, state, [duplicate])).toHaveLength(0);
  });
  it("rejects malformed/conflicting and excessive batches atomically", () => {
    const state = createFlow(flow),
      command = hostCommand(state, "start"),
      before = { ...state };
    expect(() =>
      dispatchFlow(flow, state, [command, { ...command, signal: "restart" }]),
    ).toThrow("Conflicting");
    expect(state).toEqual(before);
    expect(() => dispatchFlow(flow, state, Array(33).fill(command))).toThrow();
    expect(() =>
      dispatchFlow(flow, state, [{ ...command, gameplayTick: NaN }]),
    ).toThrow();
  });
  it("ignores undeclared terminal controls, clock mismatches and wrong tokens", () => {
    const state = createFlow(flow);
    expect(
      dispatchFlow(flow, state, [hostCommand(state, "retry")]),
    ).toHaveLength(0);
    dispatchFlow(flow, state, [hostCommand(state, "start")]);
    expect(
      dispatchFlow(flow, state, [
        { ...hostCommand(state, "won"), outcomeToken: "forged" },
      ]),
    ).toHaveLength(0);
    expect(
      dispatchFlow(flow, state, [
        { ...hostCommand(state, "won"), gameplayTick: 1 },
      ]),
    ).toHaveLength(0);
    expect(state.node).toBe("play");
  });
  it("restores before slot entry, bumps epoch and rejects callbacks from old slots", () => {
    let state = createFlow(flow);
    dispatchFlow(flow, state, [hostCommand(state, "start")]);
    const saved = saveFlow(flow, state),
      oldWon = hostCommand(state, "won");
    dispatchFlow(flow, state, [oldWon]);
    const callback = hostCommand(state, "complete");
    expect(() => saveFlow(flow, state)).toThrow("before or after");
    state = restoreFlow(flow, state, saved);
    expect(
      dispatchFlow(flow, state, [
        { ...callback, sequence: state.sequence + 1 },
      ]),
    ).toHaveLength(0);
    expect(state.node).toBe("play");
  });
  it("validates edge completeness, identity, reachability and legal actions", () => {
    expect(() =>
      validateFlow({ ...document, edges: document.edges.slice(1) }),
    ).toThrow();
    expect(() =>
      validateFlow({
        ...document,
        edges: [...document.edges, document.edges[0]],
      }),
    ).toThrow();
    expect(() =>
      validateFlow({
        ...document,
        nodes: [...document.nodes, { id: "orphan", kind: "title" }],
      }),
    ).toThrow();
    expect(() =>
      validateFlow({
        ...document,
        edges: [
          ...document.edges,
          { from: "title", signal: "skip", to: "result" },
        ],
      }),
    ).toThrow();
  });
});
