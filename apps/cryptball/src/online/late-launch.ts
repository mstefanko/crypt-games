import type { BallPoseSample, Observation } from "../contract";

const F = 256;
const distance = (a: BallPoseSample, b: BallPoseSample) =>
  Math.hypot(a.ball.x - b.ball.x, a.ball.y - b.ball.y, a.ball.z - b.ball.z);
const speed = (s: BallPoseSample) => Math.hypot(s.ball.vx, s.ball.vy, s.ball.vz);
const turned = (a: BallPoseSample, b: BallPoseSample) => {
  const av = a.ball, bv = b.ball;
  return av.vx * bv.vx + av.vy * bv.vy < 0 ||
    Math.abs(av.vx * bv.vy - av.vy * bv.vx) > Math.max(1, Math.hypot(av.vx, av.vy) * Math.hypot(bv.vx, bv.vy)) * 0.01;
};
const scene = (s: BallPoseSample) => JSON.stringify([
  s.sportId, s.phase === "ready" ? "play" : s.phase, s.score,
  s.sportId === "cryptkick" ? s.restartTeam : s.volley?.serveTeam, s.volley?.rally,
]);

/** Only recorded simulation positions are replayed. This is a short presentation
 * catch-up after a launch arrives late, never a second ball simulation. */
export class LateLaunchPresentation {
  private path: BallPoseSample[] = [];
  private cursor = 0;
  private time = 0;
  private contact: string | null = null;
  private scene = "";

  reset() { this.path = []; this.time = 0; }
  get active() { return this.path.length > 0; }
  candidate(state: BallPoseSample | null): boolean {
    return !!state && (state.phase === "play" || state.phase === "ready") && !state.possessionId &&
      speed(state) === 0 &&
      ((state.sportId === "cryptkick" && state.restartTeam !== null && state.ball.lastTouch === null &&
        state.ball.x === (state.restartTeam === 0 ? -70 : 70) * F && state.ball.y === 0) ||
        (state.sportId === "rift-volley" && !!state.volley?.serving));
  }
  /** Returns true when a distant correction has no complete recorded approach. */
  offer(submitted: BallPoseSample | null, samples: BallPoseSample[], now: number): boolean {
    if (this.active || !this.candidate(submitted) || !submitted || !samples.length) return false;
    const end = samples[samples.length - 1];
    if (scene(submitted) !== scene(end) || end.possessionId ||
      (end.volley?.serving ?? false) || distance(submitted, end) <= 12 * F) return false;
    const anchor = samples.findIndex(s => scene(s) === scene(submitted) && distance(submitted, s) <= 2 * F);
    let path = anchor < 0 ? [] : samples.slice(anchor);
    // A checkpoint may begin just after release. Join only the short, aligned
    // first interval supported by its recorded flight; never bridge the court.
    if (!path.length && samples.length > 1) {
      const first = samples[0], next = samples[1], d = distance(submitted, first);
      const dx = first.ball.x - submitted.ball.x, dy = first.ball.y - submitted.ball.y;
      const planar = Math.hypot(first.ball.vx, first.ball.vy);
      if (d <= Math.max(2 * F, speed(first) * 3 / 60) && d <= 12 * F &&
        scene(first) === scene(submitted) && !turned(first, next) &&
        dx * first.ball.vx + dy * first.ball.vy >= 0 &&
        Math.abs(dx * first.ball.vy - dy * first.ball.vx) <= Math.max(1, planar) * 2 * F) {
        path = [{ ...submitted, tick: first.tick - Math.max(1, Math.ceil(d * 60 / Math.max(1, speed(first)))) }, ...samples];
      }
    }
    const released = path.findIndex(s => speed(s) > 0);
    if (released < 0 || path.some(s => s.possessionId || scene(s) !== scene(submitted))) return true;
    const contact = path[released].ball.lastTouch;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      if ((b.tick !== a.tick + 1 && i !== 1) ||
        distance(a, b) > Math.max(speed(a), speed(b)) * (b.tick - a.tick) / 60 + 2 * F ||
        (i >= released && b.ball.lastTouch !== contact) ||
        (i > released && turned(a, b))) return true;
    }
    // The anchor is at the submitted resting pose. Skip its stationary prefix,
    // preserving the adjacent recorded position immediately before the release.
    this.path = path.slice(Math.max(0, released - 1));
    this.cursor = this.path[0].tick;
    this.time = now;
    this.contact = contact;
    this.scene = scene(end);
    return false;
  }
  draw(state: Observation, now: number): { state: Observation; fade: boolean } {
    if (!this.active) return { state, fade: false };
    const last = this.path[this.path.length - 1];
    if (scene(state) !== this.scene || state.possessionId || state.ball.lastTouch !== this.contact ||
      now - this.time > 100) {
      this.reset();
      return { state, fade: true };
    }
    if (state.tick > last.tick) {
      const gap = state.tick - last.tick;
      if (gap > 2 || distance(last, state) > Math.max(speed(last), speed(state)) * gap / 60 + 2 * F ||
        turned(last, state)) {
        this.reset();
        return { state, fade: true };
      }
      this.path.push(state);
    }
    this.cursor += Math.max(0, now - this.time) * 120 / 1000;
    this.time = now;
    const end = this.path[this.path.length - 1];
    if (this.cursor >= end.tick) {
      this.reset();
      return { state, fade: false };
    }
    let i = 0;
    while (i + 1 < this.path.length && this.path[i + 1].tick <= this.cursor) i++;
    const a = this.path[i], b = this.path[i + 1] ?? a;
    const alpha = b.tick === a.tick ? 0 : (this.cursor - a.tick) / (b.tick - a.tick);
    const mix = (k: "x" | "y" | "z") => Math.round(a.ball[k] + (b.ball[k] - a.ball[k]) * alpha);
    if (i > 0) this.path.splice(0, i);
    return { state: { ...state, ball: { ...state.ball, x: mix("x"), y: mix("y"), z: mix("z") } }, fade: false };
  }
}
