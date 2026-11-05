/** Immutable prepared content selected at app/build assembly, never by session services. */
import type { ArenaDefinition } from "../../game-simulation/src/m3/arena";
import type { GridDefinition } from "../../game-simulation/src/m3/grid";
import type { AdventureDefinitions } from "../../game-simulation/src/m3/adventure";
import type { GameDefinitions } from "./types";
export interface M3ProjectDefinitions {
  readonly arena: ArenaDefinition;
  readonly grid: GridDefinition;
  readonly adventure: AdventureDefinitions;
  readonly duel: GameDefinitions;
}

/** Trusted assembly may additionally export DEFAULT_M3_GENERATION. Preparation selects
 * retained output definitions before validation; runtime services receive definitions only. */
export interface M3ProjectAssembly {
  readonly DEFAULT_M3_PROJECT: M3ProjectDefinitions;
  readonly DEFAULT_M3_GENERATION?: import("./generation").M3GenerationCatalog;
}
