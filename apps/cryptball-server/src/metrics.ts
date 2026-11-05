import { monitorEventLoopDelay } from "node:perf_hooks";
/** Lifetime totals plus a bounded rolling sample for work percentiles. Units are explicit. */
export class WorkDistribution {
  private samples: number[] = [];
  private cursor = 0;
  private count = 0;
  private total = 0;
  private max = 0;
  constructor(private readonly capacity = 256) {}
  observe(value: number) {
    if (!Number.isFinite(value) || value < 0) return;
    this.count++;
    this.total += value;
    this.max = Math.max(this.max, value);
    if (this.samples.length < this.capacity) this.samples.push(value);
    else {
      this.samples[this.cursor] = value;
      this.cursor = (this.cursor + 1) % this.capacity;
    }
  }
  read() {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const percentile = (p: number) =>
      sorted.length ? sorted[Math.ceil((sorted.length - 1) * p)] : 0;
    return {
      count: this.count,
      sampleCount: sorted.length,
      mean: this.count ? this.total / this.count : 0,
      max: this.max,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
    };
  }
}
export const work = {
  pumpMs: new WorkDistribution(),
  tickMs: new WorkDistribution(),
  encodeMs: new WorkDistribution(),
  payloadBytes: new WorkDistribution(),
};
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();
export function readWorkMetrics() {
  const ms = (value: number) => (Number.isFinite(value) ? value / 1e6 : 0);
  return {
    pumpMs: work.pumpMs.read(),
    tickMs: work.tickMs.read(),
    encodeMs: work.encodeMs.read(),
    payloadBytes: work.payloadBytes.read(),
    eventLoopMs: {
      sampleCount: eventLoop.count,
      min: eventLoop.count ? ms(eventLoop.min) : 0,
      mean: ms(eventLoop.mean),
      max: ms(eventLoop.max),
      p95: ms(eventLoop.percentile(95)),
      p99: ms(eventLoop.percentile(99)),
    },
  };
}
