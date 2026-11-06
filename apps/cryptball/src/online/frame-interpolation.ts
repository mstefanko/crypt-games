import type { Observation } from "../contract";
import { SPORT_BALL_PROFILES } from "../../sim/sports-spec";
import {
  applyPoses,
  extractPoses,
  sameGeneration,
  type EntityPose,
  type PoseFrame,
} from "./poses";

/** One render owner. Adjacent predicted ticks share a coherent timeline; never extrapolate. */
export class FrameInterpolation {
  private previous: PoseFrame | null = null;
  private current: PoseFrame | null = null;
  private source: Observation | null = null;
  private offsets = new Map<string, EntityPose>();
  private correctedAt = 0;
  private identity: string | number | undefined;
  private time = 0;
  reset() {
    this.previous = null;
    this.current = null;
    this.source = null;
    this.offsets.clear();
    this.identity = undefined;
    this.time = 0;
  }
  capture(state: Observation) {
    const next = extractPoses(state);
    if (
      !this.current ||
      next.key !== this.current.key ||
      next.tick < this.current.tick ||
      next.tick > this.current.tick + 1
    ) {
      this.previous = next;
      this.offsets.clear();
    } else if (next.tick > this.current.tick) this.previous = this.current;
    this.current = next;
    this.source = state;
  }
  /** Reconciliation inputs must represent the same simulated tick, never the last displayed pose. */
  correct(
    before: Observation,
    after: Observation,
    now: number,
    identity: string | number,
    reset = false,
  ) {
    const a = extractPoses(before),
      b = extractPoses(after);
    const decay = Math.exp(-Math.max(0, now - this.correctedAt) / 65),
      old = this.offsets;
    this.offsets = new Map();
    this.correctedAt = now;
    const continuous =
      !reset &&
      (this.identity === undefined || this.identity === identity) &&
      a.tick === b.tick &&
      a.key === b.key &&
      (!this.current || this.current.key === a.key);
    if (continuous) {
      for (const [id, next] of b.entities) {
        const previous = a.entities.get(id),
          oldOffset = old.get(id),
          offset =
            oldOffset && sameGeneration(oldOffset, next)
              ? oldOffset
              : undefined;
        if (!previous || !sameGeneration(previous, next)) continue;
        const x = previous.x - next.x + (offset?.x ?? 0) * decay,
          y = previous.y - next.y + (offset?.y ?? 0) * decay,
          z = previous.z - next.z + (offset?.z ?? 0) * decay;
        if (Math.hypot(x, y, z) <= 12 * 256)
          this.offsets.set(id, { ...next, x, y, z });
      }
    }
    this.identity = identity;
    // Rebase the adjacent sample by the same reconciliation delta. An exact
    // checkpoint must not erase the preceding tick at snapshot frequency.
    if (
      continuous &&
      this.current?.tick === a.tick &&
      this.previous?.key === a.key
    ) {
      const entities = new Map<string, EntityPose>();
      for (const [id, next] of b.entities) {
        const prior = this.previous.entities.get(id),
          oldPose = a.entities.get(id);
        entities.set(
          id,
          prior &&
            oldPose &&
            sameGeneration(prior, next) &&
            sameGeneration(oldPose, next)
            ? {
                ...prior,
                x: prior.x + next.x - oldPose.x,
                y: prior.y + next.y - oldPose.y,
                z: prior.z + next.z - oldPose.z,
              }
            : next,
        );
      }
      this.previous = { ...this.previous, entities };
    } else this.previous = b;
    this.current = b;
    this.source = after;
  }
  draw(state: Observation, now: number, alpha = 1): Observation {
    this.capture(state);
    return this.drawCaptured(state, now, alpha);
  }
  /** Host fast path: state is the detached observation just supplied to capture.
   * Reuse that compact pose rather than extracting it again during the same RAF. */
  drawCaptured(state: Observation, now: number, alpha = 1): Observation {
    if (now - this.time > 100 && this.time !== 0) this.reset();
    this.time = now;
    if (this.source !== state || this.current?.tick !== state.tick)
      this.capture(state);
    if (state.phase !== "play") return state;
    const a = this.previous!,
      b = this.current!,
      t = Math.max(0, Math.min(1, alpha)),
      decay = Math.exp(-Math.max(0, now - this.correctedAt) / 65);
    const poses = new Map<string, EntityPose>();
    for (const [id, next] of b.entities) {
      const previous = a.entities.get(id),
        offset = this.offsets.get(id);
      const continuous =
        previous &&
        sameGeneration(previous, next) &&
        Math.hypot(
          previous.x - next.x,
          previous.y - next.y,
          previous.z - next.z,
        ) <= Math.max(12 * 256, previous.speed * 2, next.speed * 2);
      if (!continuous) this.offsets.delete(id);
      const mix = (key: "x" | "y" | "z") =>
        Math.round(
          (continuous
            ? previous[key] + (next[key] - previous[key]) * t
            : next[key]) +
            (continuous && offset && sameGeneration(offset, next)
              ? offset[key] * decay
              : 0),
        );
      poses.set(id, {
        ...next,
        x: mix("x"),
        y: mix("y"),
        z: Math.max(
          state.sportId === "rift-volley" && id.startsWith("ball:")
            ? SPORT_BALL_PROFILES["rift-volley"].radius * 256
            : 0,
          mix("z"),
        ),
      });
    }
    return applyPoses(state, poses);
  }
}
