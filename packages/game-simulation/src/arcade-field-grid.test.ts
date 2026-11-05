import { describe, it, expect } from "vitest";
import { solveGrid } from "./grid-solver";
import { applyGridCommand, createGrid, gridWon } from "./m3/grid";
import { sampleTickField } from "./tick-field";

describe("grid solver and tick field", () => {
  it("returns a legal solution witness and reports exhausted work", () => {
    const definition = {
      id: "solver-test",
      width: 6,
      height: 3,
      walls: [0, 1, 2, 3, 4, 5, 6, 11, 12, 13, 14, 15, 16, 17],
      start: 7,
      crates: [8],
      goals: [10],
    };
    const solution = solveGrid(definition);
    expect(solution.status).toBe("solved");
    expect(solution.pushes).toBe(2);
    let state = createGrid(definition);
    for (const direction of solution.commands) {
      const result = applyGridCommand(state, {
        kind: "move",
        direction,
        sequence: state.sequence + 1,
        revision: state.revision,
      });
      expect(result.ok).toBe(true);
      state = result.state;
    }
    expect(gridWon(state)).toBe(true);
    expect(solveGrid(definition, 1).status).toBe("exhausted");
  });
  it("samples deterministic periodic weather and respects full shelter", () => {
    const field = { period: 100, phase: 4, direction: 1 as const, speed: 0.2 };
    expect(sampleTickField(field, 500, 2, 4)).toBe(
      sampleTickField(field, 500, 2, 4),
    );
    expect(sampleTickField(field, 500, 2, 4)).toBeCloseTo(
      sampleTickField(field, 1000, 2, 4),
      12,
    );
    expect(sampleTickField(field, 5, 2, 4, 0)).toBe(0);
    expect(sampleTickField(field, 5, 2, 4, 0.5)).toBeCloseTo(
      sampleTickField(field, 5, 2, 4) * 0.5,
      12,
    );
  });
});
