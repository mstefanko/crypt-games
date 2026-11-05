/** Stable public exploration facade. Authoritative owners import the narrow
 * rules module so presentation changes do not alter checkpoint compatibility. */
export {
  EXPLORATION_CAMPAIGN,
  EXPLORATION_DEFINITIONS,
  EXPLORATION_IDENTITY,
  createExplorationCampaign,
  createExplorationGame,
  explorationInput,
} from "./exploration-rules";
export { EXPLORATION_ROOMS } from "./exploration-rooms";
