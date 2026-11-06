import { TICK_MS } from "../../protocol";
import type { Observation } from "../contract";
import { applyPoses, extractPoses, sameGeneration, type PoseFrame } from "./poses";

type Sample = { state: Observation; poses: PoseFrame; at: number };

/** Detached authoritative snapshots only. The covered court never consumes prediction. */
export class CoveredViewBuffer {
  private samples: Sample[] = [];
  private identity = "";
  private cursor = -Infinity;
  private delay = 100;
  private stalled = false;
  private underruns = 0;
  private anchorTick = 0;
  private anchorAt = 0;

  reset() {
    this.samples.length = 0;
    this.identity = "";
    this.cursor = -Infinity;
    this.delay = 100;
    this.stalled = false;
  }

  ingest(state: Observation, at: number, identity: string) {
    const poses = extractPoses(state), last = this.samples.at(-1);
    if (identity !== this.identity || (last &&
      (poses.key !== last.poses.key || state.tick < last.state.tick))) this.reset();
    this.identity = identity;
    if (this.samples.at(-1)?.state.tick === state.tick) return;
    if (!this.samples.length || (last && at - last.at > 1000)) {
      this.anchorTick = state.tick;
      this.anchorAt = at;
      if (last && at - last.at > 1000) {
        this.samples.length = 0;
        this.cursor = -Infinity;
      }
    }
    // Session observations are already detached from the simulation.
    this.samples.push({ state, poses, at });
    // A bounded history also prevents hidden tabs retaining an entire match.
    if (this.samples.length > 32) this.samples.shift();
  }

  draw(now: number): { state: Observation; tick: number } | null {
    const latest = this.samples.at(-1);
    if (!latest) return null;
    const desired = this.anchorTick + Math.max(0, now - this.anchorAt) / TICK_MS - this.delay / TICK_MS;
    const target = Math.max(this.cursor, this.samples[0].state.tick, desired);
    if (target > latest.state.tick && !this.stalled) {
      this.underruns++;
      this.delay = Math.min(150, this.delay + 25);
      this.stalled = true;
    } else if (target < latest.state.tick) this.stalled = false;
    this.cursor = Math.min(target, latest.state.tick);
    while (this.samples.length > 2 && this.samples[1].state.tick <= this.cursor)
      this.samples.shift();
    const a = this.samples[0], b = this.samples[1];
    if (!b || this.cursor >= b.state.tick) return { state: latest.state, tick: this.cursor };
    const t = Math.max(0, Math.min(1, (this.cursor - a.state.tick) / (b.state.tick - a.state.tick)));
    const poses = new Map(a.poses.entities);
    for (const [id, previous] of poses) {
      const next = b.poses.entities.get(id);
      // Ownership/contact/life changes remain entirely on the older timeline
      // until the new authoritative sample is reached.
      if (!next || !sameGeneration(previous, next)) continue;
      const mix = (axis: "x" | "y" | "z") => Math.round(previous[axis] + (next[axis] - previous[axis]) * t);
      poses.set(id, { ...previous, x: mix("x"), y: mix("y"), z: mix("z") });
    }
    return { state: applyPoses(a.state, poses), tick: this.cursor };
  }

  get diagnostics() {
    return { coveredBufferUnderruns: this.underruns, coveredBufferDelayMs: this.delay,
      coveredBufferTick: Number.isFinite(this.cursor) ? this.cursor : -1 };
  }
}
