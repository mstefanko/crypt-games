import {
  applyGridCommand,
  createGrid,
  gridWon,
  type GridDefinition,
  type GridDirection,
} from "./m3/grid";
export interface GridSolution {
  status: "solved" | "exhausted" | "unsolvable";
  commands: GridDirection[];
  pushes: number;
  visited: number;
}
/** Bounded breadth-first search through the exact same moves used by gameplay. */
export function solveGrid(
  definition: GridDefinition,
  maxVisited = 50000,
): GridSolution {
  if (!Number.isInteger(maxVisited) || maxVisited < 1 || maxVisited > 50000)
    throw Error("Invalid solver budget");
  const initial = createGrid(definition),
    queue = [{ state: initial, path: [] as GridDirection[], pushes: 0 }],
    seen = new Set<string>();
  const key = (s: typeof initial) =>
    `${s.position.player}:${s.position.crates.join(",")}`;
  seen.add(key(initial));
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    if (gridWon(node.state))
      return {
        status: "solved",
        commands: node.path,
        pushes: node.pushes,
        visited: seen.size,
      };
    for (const direction of ["up", "down", "left", "right"] as const) {
      const result = applyGridCommand(node.state, {
        kind: "move",
        direction,
        sequence: node.state.sequence + 1,
        revision: node.state.revision,
      });
      if (!result.ok || seen.has(key(result.state))) continue;
      if (seen.size >= maxVisited)
        return {
          status: "exhausted",
          commands: [],
          pushes: 0,
          visited: seen.size,
        };
      seen.add(key(result.state));
      const pushes =
        node.pushes +
        Number(
          result.state.position.crates.join(",") !==
            node.state.position.crates.join(","),
        );
      queue.push({
        state: { ...result.state, history: [] },
        path: [...node.path, direction],
        pushes,
      });
    }
  }
  return { status: "unsolvable", commands: [], pushes: 0, visited: seen.size };
}
