import { afterEach, expect, it, vi } from "vitest";
import { OrderedDeliveryQueue } from "../../cryptball-server/tests/ordered-proxy";
afterEach(() => vi.useRealTimers());
it("keeps fractional-time bursts and FIN FIFO with one head timer, even on early wakeup", () => {
  vi.useFakeTimers();
  let clock = 100;
  const delivered: string[] = [];
  const queue = new OrderedDeliveryQueue(() => clock);
  queue.enqueue(() => delivered.push("first"), 75);
  clock = 100.2;
  queue.enqueue(() => delivered.push("second"), 75);
  clock = 100.9;
  queue.enqueue(() => delivered.push("FIN"), 75);
  expect(vi.getTimerCount()).toBe(1);
  // Timer time can advance before the independent monotonic clock/deadline.
  vi.advanceTimersByTime(75);
  expect(delivered).toEqual([]);
  expect(vi.getTimerCount()).toBe(1);
  clock = 175.3;
  vi.advanceTimersByTime(75);
  expect(delivered).toEqual(["first", "second"]);
  expect(vi.getTimerCount()).toBe(1);
  clock = 176;
  vi.advanceTimersByTime(1);
  expect(delivered).toEqual(["first", "second", "FIN"]);
  expect(vi.getTimerCount()).toBe(0);
});
it("cancels queued deliveries on close", () => {
  vi.useFakeTimers();
  const deliver = vi.fn(), queue = new OrderedDeliveryQueue();
  queue.enqueue(deliver, 75); queue.close();
  vi.runAllTimers();
  expect(deliver).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
