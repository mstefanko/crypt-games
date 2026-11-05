/** Consumers: arena attacks and settlement work. Timing is simulation-owned. */
export interface ActionTiming {
  tell: number;
  active: number;
  recover: number;
  cancelAfter?: number;
  /** Earliest recovery time that accepts the next buffered combo strike. */
  comboAfter?: number;
}
export interface ActionInstance {
  id: number;
  moveId?: string;
  clipId?: string;
  heading?: number;
  elapsed: number;
  timing: ActionTiming;
  hits: string[];
  special?: boolean;
  charge?: number;
  sweep?: boolean;
  dashStrike?: boolean;
  combo?: number;
}
export function actionPhase(action: ActionInstance): {
  phase: "tell" | "active" | "recover" | "done";
  progress: number;
} {
  const { tell, active, recover } = action.timing;
  const t = action.elapsed;
  if (t < tell) return { phase: "tell", progress: t / Math.max(0.001, tell) };
  if (t < tell + active)
    return { phase: "active", progress: (t - tell) / Math.max(0.001, active) };
  if (t < tell + active + recover)
    return {
      phase: "recover",
      progress: (t - tell - active) / Math.max(0.001, recover),
    };
  return { phase: "done", progress: 1 };
}
export function claimActionHit(
  action: ActionInstance,
  target: string,
): boolean {
  if (action.hits.includes(target)) return false;
  action.hits.push(target);
  return true;
}
/** Bounded, nonstacking impact slowdown; cooldown always advances in wall time. */
export class TimeScaleCurve {
  elapsed = 1;
  cooldown = 0;
  request(heavy = false) {
    if (this.cooldown <= 0) {
      this.elapsed = heavy ? -0.025 : 0;
      this.cooldown = 0.12;
    }
  }
  step(dt: number) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    const previous = this.elapsed;
    this.elapsed += dt;
    return previous < 0.035 ? 0 : previous < 0.08 ? 0.45 : 1;
  }
}

/** Authored contact spans 35–65% of the clip, independently of phase durations. */
export function actionAnimationPhase(action: ActionInstance): number {
  const { phase, progress } = actionPhase(action);
  return phase === "tell"
    ? progress * 0.35
    : phase === "active"
      ? 0.35 + progress * 0.3
      : phase === "recover"
        ? 0.65 + progress * 0.35
        : 1;
}
