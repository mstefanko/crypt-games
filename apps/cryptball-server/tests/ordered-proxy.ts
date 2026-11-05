import { createServer, connect, type Socket } from "node:net";
/** TCP byte-stream proxy: independent ordered queues in each direction, never datagram reorder. */
export async function createOrderedProxy(
  targetPort: number,
  upMs: number,
  downMs: number,
) {
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((browser) => {
    const authority = connect(targetPort, "127.0.0.1");
    for (const socket of [browser, authority]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {
        browser.destroy();
        authority.destroy();
      });
    }
    const pipe = (from: Socket, to: Socket, delay: number) => {
      let due = 0;
      from.on("data", (bytes) => {
        due = Math.max(due, performance.now() + delay);
        const timer = setTimeout(
          () => {
            timers.delete(timer);
            if (!to.destroyed) to.write(bytes);
          },
          Math.max(0, due - performance.now()),
        );
        timers.add(timer);
      });
      from.on("end", () => {
        const timer = setTimeout(
          () => {
            timers.delete(timer);
            to.end();
          },
          Math.max(0, due - performance.now()),
        );
        timers.add(timer);
      });
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
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
