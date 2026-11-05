import { it, expect } from "vitest";
import {
  WorkDistribution,
  readWorkMetrics,
} from "../../cryptball-server/src/metrics";
it("bounds work samples while preserving lifetime totals and detached output", () => {
  const metric = new WorkDistribution(4);
  for (let i = 1; i <= 10; i++) metric.observe(i);
  metric.observe(NaN);
  metric.observe(-1);
  metric.observe(Infinity);
  expect(metric.read()).toEqual({
    count: 10,
    sampleCount: 4,
    mean: 5.5,
    max: 10,
    p50: 9,
    p95: 10,
    p99: 10,
  });
  const record = metric.read();
  record.max = 0;
  expect(metric.read().max).toBe(10);
});
it("reports zero-safe event loop timings in milliseconds", () => {
  const metrics = readWorkMetrics();
  expect(metrics.eventLoopMs.mean).toBeGreaterThanOrEqual(0);
  expect(metrics.eventLoopMs.p95).toBeGreaterThanOrEqual(0);
  expect(metrics.payloadBytes.sampleCount).toBeLessThanOrEqual(256);
});
