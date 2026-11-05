export {
  createArcadeExperimentPhrase,
  createArcadeBacking,
  arcadeBarTicks,
  type ArcadeExperiment,
  type ArcadeIntent,
  type ArcadeBacking,
  type ArcadeExperimentOptions,
} from "./arcade-experiments";
import { assertScore, type Score } from "@onepage/project";
export {
  createArcadePhrase,
  type ArcadeAction,
  type ArcadePhrase,
  type ArcadePhraseOptions,
} from "./arcade";
export { ticksToSeconds, secondsToTicks, type CompiledNote } from "./runtime";
import { compileScore as compilePlaybackScore } from "./runtime";
/** Authoring entry retains full document/schema diagnostics. */
export function compileScore(
  score: Score,
  options: { startTick?: number; endTick?: number; energy?: number } = {},
) {
  assertScore(score);
  return compilePlaybackScore(score, options);
}

export * from "./expressive-performance";
export * from "./weather-expression";

export * from "./weather-narrative";
export * from "./weather-narrative-memory";
export * from "./weather-narrative-transition";
export * from "./weather-narrative-live";
