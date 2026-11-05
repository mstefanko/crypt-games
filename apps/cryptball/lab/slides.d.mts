import type { Observation, CryptballEvent } from "../sim/contract";
import type { LabMetrics } from "./metrics.mjs";
export class SlideTracker {
  observe(
    previous: Observation,
    current: Observation,
    events: CryptballEvent[],
  ): void;
  result(tick: number): LabMetrics["slideOutcomes"];
}
