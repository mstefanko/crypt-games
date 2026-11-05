import type { Observation } from "../contract";
import { TICK_MS } from "../../protocol";

type Pose = {
  tick: number;
  players: { id: string; x: number; y: number }[];
  ball: { x: number; y: number; z: number };
};
const pose = (s: Observation): Pose => ({
  tick: s.tick,
  players: s.players.map(({ id, x, y }) => ({ id, x, y })),
  ball: { x: s.ball.x, y: s.ball.y, z: s.ball.z },
});
const identity = (s: Observation) =>
  JSON.stringify([
    s.sportId,
    s.phase,
    s.controlledId,
    s.possessionId,
    s.score,
    s.volley?.rally,
    s.volley?.serving,
    s.volley?.serveTeam,
    s.hockey?.faceoffLead,
    s.hockey?.dropSide,
  ]);
/** Two simulation ticks of render-only buffering. Network input allocation can
 * skip a frame then advance several ticks, even while requestAnimationFrame is
 * perfectly steady. Interpolate poses on a separate monotonic display clock;
 * never feed interpolated positions back to simulation or input targeting. */
export class FrameInterpolation {
  private samples: Pose[] = [];
  private key = "";
  private time = 0;
  private tick = 0;
  reset() {
    this.samples = [];
    this.key = "";
    this.time = 0;
  }
  draw(state: Observation, now: number): Observation {
    const key = identity(state),
      newest = this.samples.at(-1);
    if (
      !newest ||
      key !== this.key ||
      state.tick < newest.tick ||
      now - this.time > 100 ||
      state.phase !== "play"
    ) {
      this.samples = [pose(state)];
      this.key = key;
      this.time = now;
      this.tick = state.tick - 2;
      return state;
    }
    const sample = pose(state);
    if (sample.tick === newest.tick)
      this.samples[this.samples.length - 1] = sample;
    else this.samples.push(sample);
    const elapsed = Math.max(0, now - this.time) / TICK_MS;
    this.time = now;
    const target = state.tick - 2;
    // Adjust buffer depth gradually, rather than copying a jittering clock.
    const error = target - (this.tick + elapsed);
    const rate = 1 + Math.max(-0.1, Math.min(0.1, error * 0.05));
    this.tick = Math.min(state.tick, this.tick + elapsed * rate);
    if (state.tick - this.tick > 8) this.tick = target;
    while (this.samples.length > 2 && this.samples[1].tick <= this.tick)
      this.samples.shift();
    while (this.samples.length > 32) this.samples.shift();
    const a = this.samples[0],
      b = this.samples.find((p) => p.tick >= this.tick) ?? this.samples.at(-1)!;
    const t =
      a.tick === b.tick
        ? 0
        : Math.max(0, Math.min(1, (this.tick - a.tick) / (b.tick - a.tick)));
    const mix = (x: number, y: number) => Math.round(x + (y - x) * t);
    return {
      ...state,
      players: state.players.map((p) => {
        const from = a.players.find((q) => q.id === p.id),
          to = b.players.find((q) => q.id === p.id);
        return from && to
          ? { ...p, x: mix(from.x, to.x), y: mix(from.y, to.y) }
          : p;
      }),
      ball: {
        ...state.ball,
        x: mix(a.ball.x, b.ball.x),
        y: mix(a.ball.y, b.ball.y),
        z: mix(a.ball.z, b.ball.z),
      },
    };
  }
}
