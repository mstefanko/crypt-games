import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { CryptballRoom, service } from "./room";
import { readWorkMetrics } from "./metrics";
import {
  emptyRejectionReasons,
  INPUT_REJECTIONS,
  resolveSportId,
} from "@onepage/cryptball/protocol";
const origins = new Set(
  (
    process.env.CRYPTBALL_ORIGINS ??
    "http://127.0.0.1:4223,http://localhost:4223,http://127.0.0.1:4224,http://localhost:4224"
  ).split(","),
);
const admissions = new Map<string, { at: number; count: number }>();
const server = new Server({
  greet: false,
  gracefullyShutdown: false,
  transport: new WebSocketTransport({
    maxPayload: 2048,
    perMessageDeflate: false,
    beforeUpgrade: (_req, ctx) => {
      const origin = _req.headers.get("origin");
      if (origin && !origins.has(origin))
        return new Response("Origin denied", { status: 403 });
    },
  }),
  express: (app) => {
    app.set("trust proxy", "loopback");
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && !origins.has(origin)) {
        res.status(403).end();
        return;
      }
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization",
        );
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.status(204).end();
        return;
      }
      if (req.url.startsWith("/matchmake")) {
        const ip = req.ip ?? req.socket.remoteAddress ?? "unknown",
          now = Date.now();
        if (admissions.size >= 4096)
          for (const [key, v] of admissions)
            if (now - v.at > 60000) admissions.delete(key);
        if (!admissions.has(ip) && admissions.size >= 4096) {
          res.status(429).json({ error: "Please retry shortly" });
          return;
        }
        const p = admissions.get(ip) ?? { at: now, count: 0 };
        if (now - p.at > 60000) {
          p.at = now;
          p.count = 0;
        }
        admissions.set(ip, p);
        if (
          ++p.count > 60 ||
          admissions.size > 4096 ||
          service.draining ||
          service.overloaded
        ) {
          res.status(429).json({ error: "Please retry shortly" });
          return;
        }
      }
      next();
    });
    app.get("/healthz", (_req, res) => res.json({ ok: true }));
    app.get("/readyz", (_req, res) =>
      res
        .status(service.draining || service.overloaded ? 503 : 200)
        .json({ ready: !service.draining && !service.overloaded }),
    );
    app.get("/metrics", (req, res) => {
      if (
        !process.env.CRYPTBALL_METRICS_TOKEN ||
        req.headers.authorization !==
          `Bearer ${process.env.CRYPTBALL_METRICS_TOKEN}`
      ) {
        res.status(403).end();
        return;
      }
      const feedback = {
        lateReceipts: 0,
        rejections: 0,
        emptySlots: 0,
        neutralizations: 0,
        botTransitions: 0,
        sampleCount: 0,
      };
      const rejectionReasons = emptyRejectionReasons();
      for (const room of service.rooms)
        for (const peer of room.authority.peers.values()) {
          for (const reason of INPUT_REJECTIONS)
            rejectionReasons[reason] += peer.feedback.rejectionReasons[reason];
          for (const key of Object.keys(feedback) as (keyof typeof feedback)[])
            feedback[key] += peer.feedback[key];
        }
      res.json({
        work: readWorkMetrics(),
        activePeerFeedback: { ...feedback, rejectionReasons },
        heartbeats: {
          accepted: service.heartbeatsAccepted,
          rejected: service.heartbeatsRejected,
        },
        resync: {
          requested: service.resyncRequested,
          rejected: service.resyncRejected,
          served: service.resyncServed,
        },
        outbound: {
          bytes: service.bytes,
          bufferedPeers: [...service.peerOutbound.values()].filter(
            (p) => p.backlogDuration > 0,
          ).length,
          maxBacklogDurationMs: service.maxBacklogDuration,
        },
        rooms: service.rooms.size,
        snapshots: service.snapshots,
        bytes: service.bytes,
        rejected: service.rejected,
        droppedSlow: service.droppedSlow,
        maxDebtMs: service.debt,
      });
    });
  },
});
const matches = server
  .define("cryptball", CryptballRoom)
  .filterBy(["build", "protocol", "sportId", "shuffle"])
  .sortBy({ "metadata.createdAt": 1, roomId: 1 });
// Colyseus filters only supplied properties. Normalize the public filter hook so
// old/default Quick Play callers share the Cryptball queue and concurrency key.
// Explicit joinById bypasses filters and discovers the room sport on admission.
const extractFilters = matches.getFilterOptions.bind(matches);
matches.getFilterOptions = (options: { sportId?: unknown; shuffle?: boolean }) =>
  extractFilters({ ...options, shuffle: options.shuffle === true, sportId: resolveSportId(options.sportId) });
await server.listen(
  Number(process.env.PORT ?? 2567),
  process.env.HOST ?? "127.0.0.1",
);
console.log(
  JSON.stringify({
    event: "cryptball_listening",
    port:
      (server.transport.server?.address() as { port: number } | null)?.port ??
      Number(process.env.PORT ?? 2567),
  }),
);
let stopping = false;
async function drain() {
  if (stopping) return;
  stopping = true;
  service.draining = true;
  for (const room of service.rooms) void room.lock();
  const deadline = Date.now() + 300000;
  const timer = setInterval(() => {
    if (service.rooms.size === 0 || Date.now() >= deadline) {
      clearInterval(timer);
      void server.gracefullyShutdown(false).then(() => process.exit(0));
    }
  }, 1000);
}
process.on("SIGTERM", drain);
process.on("SIGINT", drain);
