import { createServer, connect, type Socket } from "node:net";

/** Application-stream impairment, not kernel packet loss or TCP congestion control. */
export interface StreamImpairment {
  jitterMs?: number;
  stallRate?: number;
  stallMs?: number;
  seed?: number;
}
export function createImpairmentSampler(options: StreamImpairment = {}) {
  const jitter = options.jitterMs ?? 0, rate = options.stallRate ?? 0, stall = options.stallMs ?? 0;
  if (![jitter, rate, stall].every(Number.isFinite) || jitter < 0 || stall < 0 || rate < 0 || rate > 1)
    throw Error("Invalid stream impairment parameters");
  let seed = (options.seed ?? 1) >>> 0, enabled = true;
  const stats = { chunks: 0, impairedChunks: 0, stalls: 0 };
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  return {
    stats,
    enable(value: boolean) { enabled = value; },
    delay(base: number) {
      stats.chunks++;
      if (!enabled) return base;
      stats.impairedChunks++;
      const variation = (random() * 2 - 1) * jitter;
      const blocked = random() < rate;
      if (blocked) stats.stalls++;
      return Math.max(0, base + variation + (blocked ? stall : 0));
    },
  };
}

/** One timer owns the head; rounded/early timers can never overtake prior bytes. */
export class OrderedDeliveryQueue {
  private jobs: { due: number; deliver: () => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  constructor(private readonly now = () => performance.now()) {}
  enqueue(deliver: () => void, delay: number) {
    if (this.stopped) return;
    this.jobs.push({ due: Math.max(this.jobs.at(-1)?.due ?? 0, this.now() + delay), deliver });
    this.schedule();
  }
  private schedule() {
    if (this.timer !== undefined || !this.jobs.length || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      while (!this.stopped && this.jobs.length && this.jobs[0].due <= this.now())
        this.jobs.shift()!.deliver();
      this.schedule();
    }, Math.max(1, Math.ceil(this.jobs[0].due - this.now())));
  }
  close() {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.jobs = [];
  }
}

/** TCP delay, not packet loss: independent FIFO streams including delayed FIN. */
export async function createOrderedProxy(targetPort: number, upMs: number, downMs: number, impairment: StreamImpairment = {}) {
  const sockets = new Set<Socket>();
  const queues = new Set<OrderedDeliveryQueue>();
  const samplers: ReturnType<typeof createImpairmentSampler>[] = [];
  let enabled = true;
  // Preserve half-closes until the corresponding delayed FIN reaches its peer.
  const server = createServer({ allowHalfOpen: true }, browser => {
    const authority = connect({ port: targetPort, host: "127.0.0.1", allowHalfOpen: true });
    for (const socket of [browser, authority]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => { browser.destroy(); authority.destroy(); });
    }
    const pipe = (from: Socket, to: Socket, delay: number) => {
      const queue = new OrderedDeliveryQueue();
      const sampler = createImpairmentSampler({ ...impairment, seed: (impairment.seed ?? 1) + samplers.length });
      sampler.enable(enabled);
      samplers.push(sampler);
      queues.add(queue);
      from.on("data", bytes => queue.enqueue(() => { if (!to.destroyed) to.write(bytes); }, sampler.delay(delay)));
      from.on("end", () => queue.enqueue(() => { if (!to.destroyed) to.end(); }, delay));
      to.on("close", () => { queue.close(); queues.delete(queue); });
    };
    pipe(browser, authority, upMs);
    pipe(authority, browser, downMs);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    setImpairmentEnabled(value: boolean) { enabled = value; samplers.forEach(s => s.enable(value)); },
    get impairmentStats() { return samplers.map(s => ({ ...s.stats })); },
    async close() {
      for (const queue of queues) queue.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
