import { describe, expect, it } from "vitest";
import { RtsTacticalSimulation, type RtsSimulationOptions } from "./rts";

function start(options: RtsSimulationOptions = {}) {
  const simulation = new RtsTacticalSimulation(options);
  simulation.applyCommand({
    kind: "move",
    unitIds: [1, 2, 3, 4],
    destination: 0,
  });
  simulation.applyCommand({ kind: "pause", paused: false });
  return simulation;
}

describe("host-only RTS navigation diagnostics", () => {
  it("preserves legacy authority with indexed queries, callbacks and pending restore", () => {
    const phases: string[] = [];
    const requests: number[] = [];
    const baseline = start();
    const options: RtsSimulationOptions = {
      navigation: { strategy: "indexed" },
      onNavigationAdvance: ({ phase, tick }) => phases.push(`${tick}:${phase}`),
      onNavigationRequest: ({ requestId, orderKind, team }) => {
        if (team === 0 && orderKind === "move") requests.push(requestId);
      },
    };
    let measured = start(options);
    for (let tick = 1; tick <= 40; tick++) {
      baseline.advance();
      measured.advance();
      expect(measured.capture()).toEqual(baseline.capture());
      if (tick === 3) {
        const checkpoint = measured.capture();
        measured = new RtsTacticalSimulation(options);
        measured.restore(checkpoint);
      }
    }
    expect(requests.length).toBeGreaterThanOrEqual(4);
    expect(phases).toHaveLength(80);
    expect(phases.slice(0, 2)).toEqual(["1:before", "1:after"]);
    measured.applyCommand({ kind: "pause", paused: true });
    measured.advance();
    expect(phases).toHaveLength(80);
  });

  it("isolates observer failures and copies constructor options", () => {
    const baseline = start();
    const fail = () => {
      throw new Error("observer failed");
    };
    const options: RtsSimulationOptions = {
      navigation: { strategy: "indexed", diagnostics: fail },
      onNavigationAdvance: fail,
      onNavigationRequest: fail,
    };
    const measured = start(options);
    let replacementCalls = 0;
    options.onNavigationAdvance = () => {
      replacementCalls++;
    };
    options.onNavigationRequest = () => {
      replacementCalls++;
    };
    options.navigation!.strategy = "legacy";
    options.navigation!.diagnostics = () => {
      replacementCalls++;
    };
    for (let tick = 0; tick < 8; tick++) {
      baseline.advance();
      expect(() => measured.advance()).not.toThrow();
    }
    expect(measured.capture()).toEqual(baseline.capture());
    expect(replacementCalls).toBe(0);
  });
});
