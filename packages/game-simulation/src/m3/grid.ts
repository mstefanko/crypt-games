import { boundedJSON, canonical } from "../../../game-project/src/runtime";

export interface ProfileIdentity {
  gameId: string;
  rulesBuildId: string;
  contentId: string;
}
export interface GridDefinition {
  id: string;
  width: number;
  height: number;
  walls: readonly number[];
  start: number;
  crates: readonly number[];
  goals: readonly number[];
  undoLimit?: number;
}
export interface GridPosition {
  player: number;
  crates: number[];
}
export interface GridState {
  definition: GridDefinition;
  revision: number;
  sequence: number;
  position: GridPosition;
  history: GridPosition[];
}
export type GridDirection = "up" | "down" | "left" | "right";
export type GridCommand = { sequence: number; revision: number } & (
  | { kind: "move"; direction: GridDirection }
  | { kind: "undo" | "restart" }
);
export type GridResult =
  | { ok: true; state: GridState }
  | { ok: false; state: GridState; error: string };
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
function integer(n: unknown, lo: number, hi: number): asserts n is number {
  if (!Number.isSafeInteger(n) || (n as number) < lo || (n as number) > hi)
    throw Error("Invalid grid integer");
}
function position(def: GridDefinition, value: GridPosition): GridPosition {
  integer(value.player, 0, def.width * def.height - 1);
  if (!Array.isArray(value.crates) || value.crates.length !== def.crates.length)
    throw Error("Invalid crate count");
  const occupied = [value.player, ...value.crates];
  for (const cell of occupied) {
    integer(cell, 0, def.width * def.height - 1);
    if (def.walls.includes(cell)) throw Error("Grid occupancy overlaps wall");
  }
  if (new Set(occupied).size !== occupied.length)
    throw Error("Duplicate grid occupancy");
  return {
    player: value.player,
    crates: [...value.crates].sort((a, b) => a - b),
  };
}
export function createGrid(definition: GridDefinition): GridState {
  const def = JSON.parse(JSON.stringify(definition)) as GridDefinition;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(def.id))
    throw Error("Invalid grid ID");
  integer(def.width, 2, 64);
  integer(def.height, 2, 64);
  integer(def.undoLimit ?? 64, 1, 256);
  if (
    !Array.isArray(def.walls) ||
    !Array.isArray(def.goals) ||
    !Array.isArray(def.crates) ||
    def.crates.length < 1 ||
    def.crates.length > 64 ||
    def.goals.length !== def.crates.length
  )
    throw Error("Invalid grid bounds");
  for (const cells of [def.walls, def.goals]) {
    if (
      cells.length > def.width * def.height ||
      new Set(cells).size !== cells.length
    )
      throw Error("Duplicate grid cell");
    for (const cell of cells) integer(cell, 0, def.width * def.height - 1);
  }
  if (def.goals.some((cell) => def.walls.includes(cell)))
    throw Error("Goal overlaps wall");
  const initial = position(def, { player: def.start, crates: [...def.crates] });
  Object.freeze(def.walls);
  Object.freeze(def.goals);
  Object.freeze(def.crates);
  Object.freeze(def);
  return {
    definition: def,
    revision: 0,
    sequence: 0,
    position: initial,
    history: [],
  };
}
export function gridWon(state: GridState): boolean {
  return state.position.crates.every((cell) =>
    state.definition.goals.includes(cell),
  );
}
function neighbor(
  def: GridDefinition,
  cell: number,
  direction: GridDirection,
): number | undefined {
  const x = cell % def.width,
    y = Math.floor(cell / def.width);
  const delta = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[
    direction
  ];
  if (!delta) throw Error("Invalid grid direction");
  const nx = x + delta[0],
    ny = y + delta[1];
  if (nx < 0 || nx >= def.width || ny < 0 || ny >= def.height) return undefined;
  const next = ny * def.width + nx;
  return def.walls.includes(next) ? undefined : next;
}
function movePosition(
  def: GridDefinition,
  before: GridPosition,
  direction: GridDirection,
): GridPosition {
  const cell = neighbor(def, before.player, direction);
  if (cell === undefined) throw Error("Blocked move");
  const crates = [...before.crates],
    index = crates.indexOf(cell);
  if (index !== -1) {
    const pushed = neighbor(def, cell, direction);
    if (pushed === undefined || crates.includes(pushed))
      throw Error("Blocked crate");
    crates[index] = pushed;
  }
  return position(def, { player: cell, crates });
}
/** Commands resolve once; render frames and wall time never enter authoritative state. */
export function applyGridCommand(
  state: GridState,
  command: GridCommand,
): GridResult {
  try {
    integer(command.sequence, 1, MAX_COUNTER);
    integer(command.revision, 0, MAX_COUNTER - 1);
    if (
      command.sequence !== state.sequence + 1 ||
      command.revision !== state.revision
    )
      throw Error("Stale or unordered grid command");
    const def = state.definition;
    let next: GridPosition,
      history = [...state.history];
    if (command.kind === "restart") {
      next = position(def, { player: def.start, crates: [...def.crates] });
      history = [];
    } else if (command.kind === "undo") {
      const previous = history.pop();
      if (!previous) throw Error("Nothing to undo");
      next = position(def, previous);
    } else if (command.kind === "move") {
      next = movePosition(def, state.position, command.direction);
      history.push(position(def, state.position));
      history = history.slice(-(def.undoLimit ?? 64));
    } else throw Error("Unknown grid command");
    return {
      ok: true,
      state: {
        definition: def,
        sequence: command.sequence,
        revision: state.revision + 1,
        position: next,
        history,
      },
    };
  } catch (error) {
    return {
      ok: false,
      state,
      error: error instanceof Error ? error.message : "Invalid grid command",
    };
  }
}
export function serializeGridCheckpoint(
  state: GridState,
  identity: ProfileIdentity,
): string {
  return canonical({
    version: 1,
    kind: "grid-exact",
    gameId: identity.gameId,
    rulesBuildId: identity.rulesBuildId,
    contentId: identity.contentId,
    definitionId: state.definition.id,
    revision: state.revision,
    sequence: state.sequence,
    position: state.position,
    history: state.history,
  });
}
export function restoreGridCheckpoint(
  def: GridDefinition,
  identity: ProfileIdentity,
  bytes: string,
): GridState {
  const data = boundedJSON(bytes, 262144, {
    rejectNegativeZero: true,
  }) as Record<string, unknown>;
  if (
    !data ||
    Object.keys(data).sort().join() !==
      [
        "version",
        "kind",
        "gameId",
        "rulesBuildId",
        "contentId",
        "definitionId",
        "revision",
        "sequence",
        "position",
        "history",
      ]
        .sort()
        .join() ||
    data.version !== 1 ||
    data.kind !== "grid-exact" ||
    data.gameId !== identity.gameId ||
    data.rulesBuildId !== identity.rulesBuildId ||
    data.contentId !== identity.contentId ||
    data.definitionId !== def.id
  )
    throw Error("Grid checkpoint identity mismatch");
  const state = createGrid(def);
  integer(data.revision, 0, MAX_COUNTER);
  integer(data.sequence, 0, MAX_COUNTER);
  if (
    data.revision !== data.sequence ||
    !Array.isArray(data.history) ||
    data.history.length > (def.undoLimit ?? 64) ||
    data.history.length > data.revision
  )
    throw Error("Invalid grid history");
  const decode = (value: unknown) => {
    if (
      !value ||
      typeof value !== "object" ||
      Object.keys(value).sort().join() !== "crates,player"
    )
      throw Error("Invalid grid position");
    const result = position(state.definition, value as GridPosition);
    const crates = (value as GridPosition).crates;
    if (crates.some((cell, index) => cell !== result.crates[index]))
      throw Error("Noncanonical grid crate order");
    return result;
  };
  const current = decode(data.position),
    history = data.history.map(decode);
  for (let i = 0; i < history.length; i++) {
    const before = history[i],
      after = history[i + 1] ?? current;
    const direction = (["up", "down", "left", "right"] as const).find(
      (direction) =>
        neighbor(state.definition, before.player, direction) === after.player,
    );
    if (
      !direction ||
      canonical(movePosition(state.definition, before, direction)) !==
        canonical(after)
    )
      throw Error("Grid undo history is not a legal move chain");
  }
  if (
    data.revision <= (state.definition.undoLimit ?? 64) &&
    canonical(history[0] ?? current) !== canonical(state.position)
  )
    // Until more than undoLimit commands have committed, no oldest snapshot
    // can have been evicted. Moves, undo and restart all retain this origin.
    throw Error("Initial grid checkpoint history origin mismatch");
  return {
    ...state,
    revision: data.revision,
    sequence: data.sequence,
    position: current,
    history,
  };
}
