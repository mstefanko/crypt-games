/** Versioned authored adventure generators. Saved proposals pin this complete source closure. */
import * as legacy from "./world-generation-v1";
import * as progression from "./world-progression";
export { WORLD_GENERATOR, WORLD_LIMITS } from "./world-generation-v1";
export type {
  WorldSocket,
  WorldRoom,
  WorldPlacement,
} from "./world-generation-v1";
export {
  WORLD_PROGRESSION_GENERATOR,
  WORLD_PROGRESSION_LIMITS,
} from "./world-progression";
export type {
  WorldProgressionRecipe,
  WorldPopulationLibrary,
  WorldPopulatedRoom,
  WorldProgressionRealization,
} from "./world-progression";
export type WorldRecipe =
  | legacy.WorldRecipe
  | progression.WorldProgressionRecipe;
export type WorldLibrary =
  | legacy.WorldLibrary
  | progression.WorldPopulationLibrary;
export type WorldRealization =
  | legacy.WorldRealization
  | progression.WorldProgressionRealization;
export function validateWorldInputs(
  recipe: WorldRecipe,
  library: WorldLibrary,
): void {
  if (recipe.format === "world-recipe-v2")
    progression.validateProgressionInputs(
      recipe,
      library as progression.WorldPopulationLibrary,
    );
  else legacy.validateWorldInputs(recipe, library as legacy.WorldLibrary);
}
export function generateWorld(
  recipe: WorldRecipe,
  library: WorldLibrary,
  previous?: WorldRealization,
  previousRecipe: WorldRecipe = recipe,
): WorldRealization {
  if (previous && previousRecipe.format !== recipe.format)
    throw Error("world: incompatible retained recipe version");
  if (recipe.format === "world-recipe-v2")
    return progression.generateProgressionWorld(
      recipe,
      library as progression.WorldPopulationLibrary,
      previous as progression.WorldProgressionRealization | undefined,
      previousRecipe as progression.WorldProgressionRecipe,
    );
  return legacy.generateWorld(
    recipe,
    library as legacy.WorldLibrary,
    previous as legacy.WorldRealization | undefined,
  );
}
export function validateWorldRandom(
  recipe: WorldRecipe,
  snapshot: unknown,
): void {
  if (recipe.format === "world-recipe-v2")
    progression.validateProgressionRandom(recipe, snapshot);
  else legacy.validateWorldRandom(recipe, snapshot);
}
