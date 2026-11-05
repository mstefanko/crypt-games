import { DEFAULT_GRID } from "../../../../examples/game-m3/project";
import { describe, expect, it } from "vitest";
import {
  applyGridCommand,
  createGrid,
  gridWon,
  restoreGridCheckpoint,
  serializeGridCheckpoint,
  type GridDirection,
  type GridState,
} from "./grid";
const identity = {
  gameId: "m3-grid",
  rulesBuildId: "rules-actual-source",
  contentId: "content-authored",
};
function command(
  state: GridState,
  kind: "move" | "undo" | "restart",
  direction: GridDirection = "right",
) {
  return applyGridCommand(
    state,
    kind === "move"
      ? {
          kind,
          direction,
          revision: state.revision,
          sequence: state.sequence + 1,
        }
      : { kind, revision: state.revision, sequence: state.sequence + 1 },
  );
}
describe("M3 ordered grid", () => {
  it("solves, undoes after goal, takes a different route and restarts", () => {
    let state = createGrid(DEFAULT_GRID);
    for (let n = 0; n < 2; n++) {
      const result = command(state, "move");
      expect(result.ok).toBe(true);
      state = result.state;
    }
    expect(gridWon(state)).toBe(true);
    state = command(state, "undo").state;
    expect(gridWon(state)).toBe(false);
    state = command(state, "move", "up").state;
    expect(state.position.player).toBe(8);
    state = command(state, "restart").state;
    expect(state.position).toEqual({ player: 13, crates: [14] });
    expect(state.history).toEqual([]);
    expect(state.sequence).toBe(5);
  });
  it("rejects blocked, duplicate, stale and out-of-order commands without consuming order", () => {
    const initial = createGrid(DEFAULT_GRID),
      before = serializeGridCheckpoint(initial, identity);
    for (const c of [
      { kind: "move", direction: "left", revision: 0, sequence: 1 },
      { kind: "move", direction: "right", revision: 1, sequence: 1 },
      { kind: "move", direction: "right", revision: 0, sequence: 2 },
      { kind: "undo", revision: 0, sequence: 1 },
    ] as const) {
      const result = applyGridCommand(initial, c);
      expect(result.ok).toBe(false);
      expect(result.state).toBe(initial);
    }
    expect(serializeGridCheckpoint(initial, identity)).toBe(before);
    const accepted = command(initial, "move").state;
    expect(
      applyGridCommand(accepted, {
        kind: "move",
        direction: "right",
        revision: 0,
        sequence: 1,
      }).ok,
    ).toBe(false);
  });
  it("bounds snapshot history and restores exact bytes independently of idle display frames", () => {
    let state = createGrid({ ...DEFAULT_GRID, undoLimit: 3 });
    for (let n = 0; n < 20; n++)
      state = command(state, "move", n % 2 ? "up" : "down").state;
    expect(state.history).toHaveLength(3);
    const bytes = serializeGridCheckpoint(state, identity);
    for (let frame = 0; frame < 1000; frame++) gridWon(state);
    expect(serializeGridCheckpoint(state, identity)).toBe(bytes);
    expect(
      serializeGridCheckpoint(
        restoreGridCheckpoint(
          { ...DEFAULT_GRID, undoLimit: 3 },
          identity,
          bytes,
        ),
        identity,
      ),
    ).toBe(bytes);
    expect(() =>
      restoreGridCheckpoint(
        DEFAULT_GRID,
        { ...identity, rulesBuildId: "other" },
        bytes,
      ),
    ).toThrow(/identity/);
    expect(() =>
      restoreGridCheckpoint(
        DEFAULT_GRID,
        { ...identity, gameId: "other" },
        bytes,
      ),
    ).toThrow(/identity/);
  });
  it("rejects corrupt occupancy, counters, oversized history and unknown envelope fields", () => {
    const bytes = serializeGridCheckpoint(createGrid(DEFAULT_GRID), identity);
    for (const edit of [
      (d: any) => (d.position.crates = [13]),
      (d: any) => (d.position.player = 0),
      (d: any) => (d.sequence = 1),
      (d: any) => (d.history = Array(65).fill(d.position)),
      (d: any) => (d.tick = 0),
      (d: any) => (d.position.extra = true),
    ]) {
      const raw = JSON.parse(bytes);
      edit(raw);
      expect(() =>
        restoreGridCheckpoint(DEFAULT_GRID, identity, JSON.stringify(raw)),
      ).toThrow();
    }
  });
  it("does not wrap row boundaries and validates authored occupancy", () => {
    const def = {
      id: "open",
      width: 3,
      height: 3,
      walls: [],
      start: 2,
      crates: [4],
      goals: [7],
    };
    expect(command(createGrid(def), "move", "right").ok).toBe(false);
    expect(() => createGrid({ ...def, crates: [2] })).toThrow(/occupancy/);
    expect(() => createGrid({ ...def, goals: [7, 7] })).toThrow();
  });

  it("rejects fabricated undo chains while preserving legal pushes, undos and truncated histories", () => {
    let state = createGrid(DEFAULT_GRID);
    state = command(state, "move", "right").state;
    state = command(state, "move", "right").state;
    const bytes = serializeGridCheckpoint(state, identity);
    for (const edit of [
      // Both positions are individually legal, but this would teleport on undo.
      (d: any) => (d.history[1].player = 7),
      // Adjacent player cells do not permit moving a different crate elsewhere.
      (d: any) => (d.history[1].crates = [9]),
      // Repeating a position is not a committed move.
      (d: any) => (d.history[1] = d.history[0]),
      (d: any) => d.history.reverse(),
      (d: any) => (d.position = { player: 8, crates: [16] }),
    ]) {
      const changed = JSON.parse(bytes);
      edit(changed);
      expect(() =>
        restoreGridCheckpoint(DEFAULT_GRID, identity, JSON.stringify(changed)),
      ).toThrow();
      expect(serializeGridCheckpoint(state, identity)).toBe(bytes);
    }
    state = command(state, "undo").state;
    const afterUndo = serializeGridCheckpoint(state, identity);
    expect(
      serializeGridCheckpoint(
        restoreGridCheckpoint(DEFAULT_GRID, identity, afterUndo),
        identity,
      ),
    ).toBe(afterUndo);
    let limited = createGrid({ ...DEFAULT_GRID, undoLimit: 3 });
    for (const direction of [
      "up",
      "right",
      "left",
      "down",
      "up",
      "right",
    ] as const)
      limited = command(limited, "move", direction).state;
    for (let n = 0; n < 3; n++) {
      const snapshot = serializeGridCheckpoint(limited, identity);
      expect(
        serializeGridCheckpoint(
          restoreGridCheckpoint(limited.definition, identity, snapshot),
          identity,
        ),
      ).toBe(snapshot);
      limited = command(limited, "undo").state;
    }
    expect(limited.history).toEqual([]);
    // A fully undone truncated history may end at its oldest retained position,
    // rather than at the authored start; restoring it must remain supported.
    expect(limited.position.player).not.toBe(DEFAULT_GRID.start);
    const empty = serializeGridCheckpoint(limited, identity);
    expect(
      serializeGridCheckpoint(
        restoreGridCheckpoint(limited.definition, identity, empty),
        identity,
      ),
    ).toBe(empty);
  });

  it("rejects noncanonical crate ordering in current and historical positions instead of sorting imports", () => {
    const def = {
      id: "two-crates",
      width: 5,
      height: 4,
      walls: [],
      start: 0,
      crates: [6, 8],
      goals: [11, 13],
    };
    const initial = createGrid(def),
      moved = command(initial, "move", "right").state;
    const bytes = serializeGridCheckpoint(moved, identity);
    for (const edit of [
      (d: any) => d.position.crates.reverse(),
      (d: any) => d.history[0].crates.reverse(),
    ]) {
      const changed = JSON.parse(bytes);
      edit(changed);
      expect(() =>
        restoreGridCheckpoint(def, identity, JSON.stringify(changed)),
      ).toThrow(/canonical/);
    }
    const zero = JSON.parse(serializeGridCheckpoint(initial, identity));
    zero.position.player = 1;
    expect(() =>
      restoreGridCheckpoint(def, identity, JSON.stringify(zero)),
    ).toThrow(/Initial/);
    const falseOrigin = JSON.parse(bytes);
    falseOrigin.history[0].player = 2;
    expect(() =>
      restoreGridCheckpoint(def, identity, JSON.stringify(falseOrigin)),
    ).toThrow(/origin/);
    expect(
      serializeGridCheckpoint(
        restoreGridCheckpoint(def, identity, bytes),
        identity,
      ),
    ).toBe(bytes);
  });
});
