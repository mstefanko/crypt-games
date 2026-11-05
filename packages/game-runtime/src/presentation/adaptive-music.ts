import type { Score } from "@onepage/project";
import { compileScore } from "@onepage/music-core/runtime";

export type MusicState = "low" | "high";
export type MusicArrangements = Readonly<Record<MusicState, Score>>;
export interface MusicDecisionState {
  version: 1;
  state: MusicState;
}
/** Two frozen arrangements; one coalesced queue slot, owned by the existing device.
 * Requests are decisions, never gameplay or musical clock positions. */
export class AdaptiveMusic {
  private readonly arrangements: MusicArrangements;
  private state: MusicState = "low";
  private paused = true;
  private disposed = false;
  private requests = 0;
  constructor(
    arrangements: MusicArrangements,
    private readonly apply: (score: Score, energy: 1 | 2) => void,
  ) {
    let events = 0;
    for (const score of [arrangements.low, arrangements.high]) {
      // Arrangement replacement owns audible intensity at the boundary.
      // Immediate device energy changes must never gate existing voices.
      if (score.tracks.some((track) => track.minEnergy !== 1))
        throw Error("Adaptive music tracks must use minEnergy 1");
      if (
        !score.loop ||
        score.meter[0] !== 4 ||
        score.meter[1] !== 4 ||
        ![8, 16].includes(
          (score.loop.endTick - score.loop.startTick) / (480 * 4),
        ) ||
        score.tracks.length > 4 ||
        (events += compileScore(score).length) > 2048
      )
        throw Error("Adaptive music arrangement exceeds supported loop budget");
    }
    const dimensions = (score: Score) =>
      JSON.stringify([
        score.bpm,
        score.meter,
        score.scale,
        score.lengthTicks,
        score.loop,
      ]);
    if (dimensions(arrangements.low) !== dimensions(arrangements.high))
      throw Error(
        "Adaptive music arrangements must share tempo, meter, scale and loop dimensions",
      );
    this.arrangements = structuredClone(arrangements);
    this.publish();
  }
  private publish() {
    this.apply(
      structuredClone(this.arrangements[this.state]),
      this.state === "high" ? 2 : 1,
    );
  }
  request(state: MusicState): boolean {
    if (state !== "low" && state !== "high")
      throw Error("Unknown adaptive music state");
    if (this.disposed || this.state === state) return false;
    this.state = state;
    this.requests = Math.min(Number.MAX_SAFE_INTEGER, this.requests + 1);
    // While paused, keep only the desired decision. Resume publishes it once.
    if (!this.paused) this.publish();
    return true;
  }
  /** Cancel a requested intensity by replacing it with the declared low baseline.
   * Already audible/scheduled music changes only at the next unscheduled boundary. */
  cancel() {
    return this.request("low");
  }
  pause() {
    if (!this.disposed) this.paused = true;
  }
  resume() {
    if (!this.disposed && this.paused) {
      this.paused = false;
      this.publish();
    }
  }
  snapshot(): MusicDecisionState {
    return { version: 1, state: this.state };
  }
  restore(value: MusicDecisionState) {
    if (
      !value ||
      value.version !== 1 ||
      (value.state !== "low" && value.state !== "high")
    )
      throw Error("Invalid adaptive music decision");
    if (this.disposed) return;
    this.state = value.state;
    if (!this.paused) this.publish();
  }
  stats() {
    return {
      ...this.snapshot(),
      requests: this.requests,
      paused: this.paused,
      disposed: this.disposed,
    };
  }
  dispose() {
    this.disposed = true;
    this.paused = true;
  }
}
