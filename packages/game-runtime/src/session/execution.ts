/** Shared production/Lab execution boundary. Recording and live cancellation belong to callers. */
import {
  array,
  ACTIONS,
  boolean,
  integer,
  record,
  string,
  type GameDefinitions,
  type CompatibilityIdentity,
  type InputFrame,
  type Held,
  type Edge,
} from "../../../game-project/src/runtime";
import { DuelGame } from "../m3/duel";
import type { TickEvent } from "../../../game-simulation/src/types";
import {
  createArena,
  advanceArena,
  restoreArenaCheckpoint,
  type ArenaWorld,
  type ArenaIdentity,
  type ArenaInput,
} from "../../../game-simulation/src/m3/arena";
import type { ArenaDefinition } from "../../../game-simulation/src/m3/arena-types";
import {
  createGrid,
  applyGridCommand,
  restoreGridCheckpoint,
  type GridState,
  type ProfileIdentity,
  type GridCommand,
  type GridDefinition,
  type GridResult,
} from "../../../game-simulation/src/m3/grid";
import {
  createAdventure,
  applyAdventureCommand,
  prepareAdventureTransition,
  commitAdventureTransition,
  restoreAdventureCheckpoint,
  type AdventureCommand,
  type AdventureTravelCommand,
  type AdventureDefinitions,
  type AdventureState,
  type AdventureResult,
  type AdventureTransition,
  type AdventureTransitionResult,
} from "../../../game-simulation/src/m3/adventure";

/** Validate every field before entering mutable rules, including finished-world no-ops.
 * Explicit copies keep this bounded hot path independent of JSON serialization. */
export function validateArenaInput(value: unknown): ArenaInput {
  const optional = ["cancel", "edges"].filter((k) =>
    Object.hasOwn(value ?? {}, k),
  );
  const f = record(value, [
    "moveX",
    "moveY",
    "aim",
    "fire",
    "dash",
    "shove",
    ...optional,
  ]);
  for (const key of ["moveX", "moveY", "aim"])
    if (Object.is(f[key], -0)) throw Error("M4_VALUE: invalid number");
  const input: ArenaInput = {
    moveX: integer(f.moveX, -127, 127),
    moveY: integer(f.moveY, -127, 127),
    aim: integer(f.aim, 0, 255),
    fire: boolean(f.fire),
    dash: boolean(f.dash),
    shove: boolean(f.shove),
  };
  if ("cancel" in f) input.cancel = boolean(f.cancel);
  if ("edges" in f)
    input.edges = Array.from(array(f.edges, 32), (edge) => {
      const e = record(edge, ["action", "kind"]);
      if (
        !["fire", "dash", "shove"].includes(e.action as string) ||
        !["pressed", "released", "cancel"].includes(e.kind as string)
      )
        throw Error("M4_INPUT: invalid semantic edge");
      return { action: e.action, kind: e.kind } as NonNullable<
        ArenaInput["edges"]
      >[number];
    });
  return input;
}

export function validateGridCommand(value: unknown): GridCommand {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (!["move", "undo", "restart"].includes(kind as string))
    throw Error("M4_COMMAND: unsupported profile command");
  const c = record(value, [
    "kind",
    "revision",
    "sequence",
    ...(kind === "move" ? ["direction"] : []),
  ]);
  if (Object.is(c.revision, -0) || Object.is(c.sequence, -0))
    throw Error("M4_VALUE: invalid number");
  const revision = integer(c.revision, 0, Number.MAX_SAFE_INTEGER - 1);
  const sequence = integer(c.sequence, 1, Number.MAX_SAFE_INTEGER);
  if (kind === "move") {
    if (!["left", "right", "up", "down"].includes(c.direction as string))
      throw Error("M4_COMMAND: invalid direction");
    return {
      kind,
      revision,
      sequence,
      direction: c.direction as Extract<
        GridCommand,
        { kind: "move" }
      >["direction"],
    };
  }
  return { kind: kind as "undo" | "restart", revision, sequence };
}

/** A detached ordered command shared by live ownership and recorded execution. */
export function validateAdventureCommand(
  value: unknown,
): AdventureCommand | AdventureTravelCommand {
  if (!value || typeof value !== "object")
    throw Error("M4_COMMAND: missing command");
  const kind = (value as { kind?: unknown }).kind;
  const extra =
    kind === "move"
      ? ["direction"]
      : kind === "pickup"
        ? ["placementId", "token"]
        : kind === "dialogue"
          ? ["dialogueId", "choiceId", "token"]
          : kind === "travel"
            ? ["exitId", "token"]
            : null;
  if (extra === null) throw Error("M4_COMMAND: unsupported profile command");
  const c = record(value, ["kind", "revision", "sequence", ...extra]);
  const revision = integer(c.revision, 0, Number.MAX_SAFE_INTEGER - 1);
  const sequence = integer(c.sequence, 1, Number.MAX_SAFE_INTEGER);
  if (kind === "move") {
    if (!["left", "right", "up", "down"].includes(c.direction as string))
      throw Error("M4_COMMAND: invalid direction");
    return {
      kind,
      revision,
      sequence,
      direction: c.direction as Extract<
        AdventureCommand,
        { kind: "move" }
      >["direction"],
    };
  }
  if (kind === "pickup")
    return {
      kind,
      revision,
      sequence,
      placementId: string(c.placementId),
      token: string(c.token),
    };
  if (kind === "dialogue")
    return {
      kind,
      revision,
      sequence,
      dialogueId: string(c.dialogueId),
      choiceId: string(c.choiceId),
      token: string(c.token),
    };
  return {
    kind: "travel",
    revision,
    sequence,
    exitId: string(c.exitId),
    token: string(c.token),
  };
}

/** The two-slot production frame is copied before mutable decoder execution. */
export function validateDuelFrame(value: unknown): InputFrame {
  const f = record(value, [
    "slots",
    ...(Object.hasOwn(value ?? {}, "commands") ? ["commands"] : []),
  ]);
  const slots = array(f.slots, 2);
  if (slots.length !== 2) throw Error("M4_INPUT: exactly two slots required");
  const frame: InputFrame = {
    slots: Array.from(slots, (value, index) => {
      const slot = record(value, ["slot", "held", "axes", "edges"]);
      if (slot.slot !== index) throw Error("M4_INPUT: ordered slots required");
      const sourceHeld = record(slot.held, ACTIONS);
      const held = {} as Held;
      for (const action of ACTIONS) held[action] = boolean(sourceHeld[action]);
      const axes = record(slot.axes, ["moveX"]);
      const moveX = integer(axes.moveX, -127, 127);
      const edges = Array.from(array(slot.edges, 32), (value): Edge => {
        const edge = record(value, ["action", "kind"]);
        if (
          !ACTIONS.includes(edge.action as Edge["action"]) ||
          !["pressed", "released", "cancel"].includes(edge.kind as string)
        )
          throw Error("M4_INPUT: invalid semantic edge");
        return {
          action: edge.action as Edge["action"],
          kind: edge.kind as Edge["kind"],
        };
      });
      return { slot: index, held, axes: { moveX }, edges };
    }),
  };
  if ("commands" in f)
    frame.commands = Array.from(array(f.commands, 1), (value) => {
      const command = record(value, ["type"]);
      if (command.type !== "restart")
        throw Error("M4_COMMAND: unsupported frame command");
      return { type: "restart" };
    });
  return frame;
}

export function createArenaExecution(
  definition: ArenaDefinition,
  identity: ArenaIdentity,
  seed = 1,
): ArenaWorld {
  return createArena(definition, identity, seed);
}
export function createGridExecution(definition: GridDefinition): GridState {
  return createGrid(definition);
}
export function createAdventureExecution(
  definitions: AdventureDefinitions,
): AdventureState {
  return createAdventure(definitions);
}
export function createDuelExecution(
  definitions: GameDefinitions,
  identity: CompatibilityIdentity,
): DuelGame {
  return new DuelGame(definitions, identity);
}
/** One accepted frame advances the arena's existing integer tick rules. */
export function executeArenaFrame(world: ArenaWorld, input: unknown): void {
  advanceArena(world, validateArenaInput(input));
}
export function executeDuelFrame(game: DuelGame, frame: unknown): TickEvent[] {
  return game.step(validateDuelFrame(frame));
}
/** Grid execution advances only through ordered commands; no frame or wall clock exists. */
export function executeGridCommand(
  state: GridState,
  command: unknown,
): GridResult {
  let validated: GridCommand;
  try {
    validated = validateGridCommand(command);
  } catch (error) {
    return {
      ok: false,
      state,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return applyGridCommand(state, validated);
}
export function executeAdventureCommand(
  definitions: AdventureDefinitions,
  state: AdventureState,
  command: unknown,
): AdventureResult {
  let validated: AdventureCommand;
  try {
    const ordered = validateAdventureCommand(command);
    if (ordered.kind === "travel")
      throw Error("M4_COMMAND: unsupported profile command");
    validated = ordered;
  } catch (error) {
    return {
      ok: false,
      state,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return applyAdventureCommand(definitions, state, validated);
}
/** Resource readiness is a caller concern; preparing travel never adopts state. */
export function prepareAdventureTravel(
  definitions: AdventureDefinitions,
  state: AdventureState,
  command: unknown,
): AdventureTransitionResult {
  let validated: AdventureTravelCommand;
  try {
    const ordered = validateAdventureCommand(command);
    if (ordered.kind !== "travel")
      throw Error("M4_COMMAND: unsupported profile command");
    validated = ordered;
  } catch (error) {
    return {
      ok: false,
      state,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return prepareAdventureTransition(definitions, state, validated);
}
export function commitAdventureTravel(
  definitions: AdventureDefinitions,
  state: AdventureState,
  transition: AdventureTransition,
  loadedMapId: string,
): AdventureResult {
  return commitAdventureTransition(definitions, state, transition, loadedMapId);
}
/** Exact restore preserves held decoder state. Live owners cancel controls separately. */
export function restoreArenaExact(world: ArenaWorld, bytes: string): void {
  restoreArenaCheckpoint(world, bytes);
}
export function restoreGridExact(
  definition: GridDefinition,
  identity: ProfileIdentity,
  bytes: string,
): GridState {
  return restoreGridCheckpoint(definition, identity, bytes);
}
export function restoreAdventureExact(
  definitions: AdventureDefinitions,
  identity: ProfileIdentity,
  bytes: string,
): AdventureState {
  return restoreAdventureCheckpoint(definitions, identity, bytes);
}
export function restoreDuelExact(game: DuelGame, bytes: string): void {
  game.restore(bytes);
}
