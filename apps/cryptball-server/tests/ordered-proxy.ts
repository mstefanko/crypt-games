import { createServer, connect, type Socket } from "node:net";

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
export async function createOrderedProxy(targetPort: number, upMs: number, downMs: number) {
  const sockets = new Set<Socket>();
  const queues = new Set<OrderedDeliveryQueue>();
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
      queues.add(queue);
      from.on("data", bytes => queue.enqueue(() => { if (!to.destroyed) to.write(bytes); }, delay));
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
    async close() {
      for (const queue of queues) queue.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
