/** The only wall-clock accumulator in the player. Simulation ticks are never skipped. */
export class FixedScheduler {
  static readonly tickMs = 1000 / 60;
  private previousTime: number | undefined;
  private debt = 0;
  paused = true;

  constructor(
    private readonly tick: () => void,
    private readonly onDebt: () => void,
  ) {}

  resume(): void {
    this.debt = 0;
    this.previousTime = undefined;
    this.paused = false;
  }

  pause(): void {
    this.paused = true;
    this.previousTime = undefined;
    this.debt = 0;
  }

  advance(now: number): number {
    if (this.paused) return 0;
    if (!Number.isFinite(now)) throw new Error("Invalid animation timestamp");
    if (this.previousTime === undefined) {
      this.previousTime = now;
      return 0;
    }
    this.debt += Math.max(0, now - this.previousTime);
    this.previousTime = now;
    let count = 0;
    while (this.debt + 1e-7 >= FixedScheduler.tickMs && count < 5) {
      this.tick();
      this.debt -= FixedScheduler.tickMs;
      count += 1;
      if (this.paused) return 0;
    }
    if (this.debt + 1e-7 >= FixedScheduler.tickMs) {
      this.pause();
      this.onDebt();
      return 0;
    }
    return Math.max(0, this.debt / FixedScheduler.tickMs);
  }
}
