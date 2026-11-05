import {
  beforeAll,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { Client, type Room } from "@colyseus/sdk";
import { SPORT_IDS } from "../sim/session";
import type { Lobby, Snapshot } from "../protocol";
let BUILD: string,
  PROTOCOL: number,
  decodeSnapshot: (typeof import("../protocol"))["decodeSnapshot"];
let process: ChildProcess,
  endpoint = "",
  output = "";
const rooms: Room[] = [];
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw Error(`Socket test timed out: ${output}`);
    await pause(20);
  }
}
function track(room: Room) {
  rooms.push(room);
  let lobby: Lobby | undefined, snapshot: Snapshot | undefined;
  room.onMessage("lobby", (v) => {
    lobby = v;
  });
  room.onMessage("snapshot", (bytes) => {
    snapshot = decodeSnapshot(bytes);
  });
  return {
    room,
    get lobby() {
      return lobby;
    },
    get snapshot() {
      return snapshot;
    },
  };
}
beforeAll(async () => {
  await promisify(execFile)(globalThis.process.execPath, [
    "apps/cryptball-server/build.mjs",
  ]);
  vi.resetModules();
  ({ BUILD, PROTOCOL, decodeSnapshot } = await import("../protocol"));
  process = spawn(
    globalThis.process.execPath,
    ["dist/cryptball-server/main.mjs"],
    {
      cwd: globalThis.process.cwd(),
      env: {
        ...globalThis.process.env,
        PORT: "0",
        CRYPTBALL_METRICS_TOKEN: "socket-test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  process.stdout!.on("data", (chunk) => {
    output += chunk.toString();
    const match = output.match(/"port":(\d+)/);
    if (match) endpoint = `http://127.0.0.1:${match[1]}`;
  });
  process.stderr!.on("data", (chunk) => {
    output += chunk.toString();
  });
  await until(() => !!endpoint);
}, 12000);
afterEach(async () => {
  await Promise.allSettled(rooms.splice(0).map((room) => room.leave()));
});
afterAll(async () => {
  await Promise.allSettled(rooms.map((room) => room.leave()));
  process?.kill("SIGKILL");
});
describe("real Colyseus sockets", () => {
  it("serves health, guards metrics and incompatible admission", async () => {
    expect((await fetch(`${endpoint}/healthz`)).status).toBe(200);
    const ready = await fetch(`${endpoint}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ready: true });
    expect((await fetch(`${endpoint}/metrics`)).status).toBe(403);
    expect(
      (
        await fetch(`${endpoint}/metrics`, {
          headers: { Authorization: "Bearer socket-test" },
        })
      ).status,
    ).toBe(200);
    const metrics = await (
      await fetch(`${endpoint}/metrics`, {
        headers: { Authorization: "Bearer socket-test" },
      })
    ).json();
    expect(metrics.work.pumpMs.sampleCount).toBeLessThanOrEqual(256);
    expect(metrics.work.eventLoopMs).toHaveProperty("p95");
    expect(metrics.activePeerFeedback).toHaveProperty("neutralizations");
    expect(metrics.activePeerFeedback.rejectionReasons).toHaveProperty(
      "cancelled",
    );
    expect(metrics.resync).toHaveProperty("served");
    expect(metrics.heartbeats).toHaveProperty("accepted");
    expect(metrics.outbound).toHaveProperty("maxBacklogDurationMs");
    await expect(
      new Client(endpoint).joinOrCreate("cryptball", {
        build: "old",
        protocol: 0,
      }),
    ).rejects.toThrow();
  });
  it("isolates sport queues, discovers private-room sport by code, and rejects unknown or mismatched sport", async () => {
    const options = { build: BUILD, protocol: PROTOCOL };
    const groups = [];
    for (const sportId of SPORT_IDS.filter(id => id !== "crypt-guardian")) {
      const a = track(
        await new Client(endpoint).joinOrCreate("cryptball", {
          ...options,
          sportId,
        }),
      );
      const b = track(
        await new Client(endpoint).joinOrCreate("cryptball", {
          ...options,
          sportId,
        }),
      );
      expect(a.room.roomId).toBe(b.room.roomId);
      await until(() => !!a.snapshot);
      expect(a.snapshot!.sportId).toBe(sportId);
      expect(a.snapshot!.checkpoint.state.sportId).toBe(sportId);
      groups.push(a.room.roomId);
    }
    expect(new Set(groups).size).toBe(SPORT_IDS.length - 1);
    await expect(new Client(endpoint).create("cryptball", { ...options, sportId: "crypt-guardian" })).rejects.toThrow("solo only");
    const shuffle = track(await new Client(endpoint).joinOrCreate("cryptball", { ...options, shuffle: true }));
    const shufflePeer = track(await new Client(endpoint).joinOrCreate("cryptball", { ...options, shuffle: true }));
    expect(shuffle.room.roomId).toBe(shufflePeer.room.roomId);
    expect(groups).not.toContain(shuffle.room.roomId);
    const defaultSport = track(
      await new Client(endpoint).joinOrCreate("cryptball", options),
    );
    expect(defaultSport.room.roomId).toBe(groups[0]);
    await until(() => !!defaultSport.snapshot);
    expect(defaultSport.snapshot!.sportId).toBe("cryptball");
    const privateRoom = track(
      await new Client(endpoint).create("cryptball", {
        ...options,
        private: true,
        sportId: "rift-volley",
      }),
    );
    const guest = track(
      await new Client(endpoint).joinById(privateRoom.room.roomId, options),
    );
    await until(() => !!guest.snapshot);
    expect(guest.snapshot!.sportId).toBe("rift-volley");
    await expect(
      new Client(endpoint).joinById(privateRoom.room.roomId, {
        ...options,
        sportId: "cryptkick",
      }),
    ).rejects.toThrow();
    await expect(
      new Client(endpoint).joinOrCreate("cryptball", {
        ...options,
        sportId: "soccer",
      }),
    ).rejects.toThrow();
    await Promise.allSettled(rooms.map((room) => room.leave()));
  });
  it.each(["cryptkick", "rift-volley", "cryptcheck"] as const)(
    "runs %s with bot coverage and restores the same sport after reconnect",
    async (sportId) => {
      const options = { build: BUILD, protocol: PROTOCOL, sportId };
      const a = track(
        await new Client(endpoint).create("cryptball", {
          ...options,
          private: true,
        }),
      );
      const b = track(
        await new Client(endpoint).joinById(a.room.roomId, options),
      );
      a.room.send("ready");
      b.room.send("ready");
      await until(() => a.lobby?.seats.every((p) => p.ready) === true);
      a.room.send("start");
      await until(
        () =>
          a.lobby?.phase === "playing" && !!a.snapshot && a.snapshot.tick > 3,
      );
      a.room.send("suspend");
      await until(
        () =>
          a.lobby?.seats.find((p) => p.id === a.room.sessionId)?.active ===
          false,
      );
      const tick = a.snapshot!.tick;
      await until(() => a.snapshot!.tick > tick + 3);
      const generation = a.snapshot!.generation;
      const playerId = a.snapshot!.checkpoint.state.controllers.find(
        (c) => c.id === a.room.sessionId,
      )!.playerId;
      a.room.reconnection.minUptime = 0;
      a.room.connection.close(4010, "sport reconnect test");
      await until(() => a.snapshot!.generation > generation);
      expect(a.snapshot!.sportId).toBe(sportId);
      expect(a.snapshot!.checkpoint.state.sportId).toBe(sportId);
      expect(
        a.snapshot!.checkpoint.state.controllers.find(
          (c) => c.id === a.room.sessionId,
        )?.playerId,
      ).toBe(playerId);
      a.room.send("resume");
    },
    15000,
  );
  it("isolates private rooms, joins 2 opposing humans, advances authority and resumes a dropped seat", async () => {
    const options = { build: BUILD, protocol: PROTOCOL },
      client = new Client(endpoint);
    const privateRoom = track(
      await client.create("cryptball", { ...options, private: true }),
    );
    const a = track(
      await new Client(endpoint).joinOrCreate("cryptball", options),
    );
    const b = track(
      await new Client(endpoint).joinOrCreate("cryptball", options),
    );
    expect(a.room.roomId).toBe(b.room.roomId);
    expect(a.room.roomId).not.toBe(privateRoom.room.roomId);
    a.room.send("ready");
    b.room.send("ready");
    await until(() => a.lobby?.seats.every((p) => p.ready) === true);
    a.room.send("start");
    await until(
      () => a.lobby?.phase === "playing" && !!a.snapshot && a.snapshot.tick > 3,
    );
    expect(a.lobby!.seats.map((s) => s.team)).toEqual([0, 1]);
    expect(a.snapshot!.tick).toBe(a.snapshot!.checkpoint.state.tick);
    const before = a.snapshot!.tick;
    a.room.send("suspend");
    await until(
      () =>
        a.lobby?.seats.find((p) => p.id === a.room.sessionId)?.active === false,
    );
    await until(() => a.snapshot!.tick > before + 3);
    const generation = a.snapshot!.generation;
    a.room.reconnection.minUptime = 0;
    a.room.connection.close(4010, "test network drop");
    await until(() => !!a.snapshot && a.snapshot.generation > generation);
    expect(a.snapshot!.generation).toBe(generation + 1);
    a.room.send("resume");
  }, 15000);
  it("keeps cosmetic-club specials disabled across both peers and reconnect", async () => {
    const options = { build: BUILD, protocol: PROTOCOL };
    const a = track(await new Client(endpoint).create("cryptball", { ...options, private: true }));
    const b = track(await new Client(endpoint).joinById(a.room.roomId, options));
    for (const peer of [a, b]) peer.room.send("ready");
    await until(() => a.lobby?.seats.every(seat => seat.ready) === true);
    a.room.send("start");
    await until(() => a.lobby?.phase === "playing" && !!a.snapshot && !!b.snapshot);
    const snapshot = a.snapshot!, controller = snapshot.checkpoint.state.controllers.find(c => c.id === a.room.sessionId)!;
    const before = snapshot.checkpoint.state.specials.map(s => ({ ...s }));
    a.room.send("input", { epoch: snapshot.epoch, generation: snapshot.generation,
      seq: 1, tick: snapshot.tick + 6, revision: controller.revision, command: { special: true } });
    await until(() => (a.snapshot?.terminalSeq ?? 0) >= 1);
    const executedAt = a.snapshot!.tick;
    await until(() => !!b.snapshot && b.snapshot.tick >= executedAt);
    for (const peer of [a, b]) expect(peer.snapshot!.checkpoint.state.specials).toEqual(before);
    const generation = a.snapshot!.generation;
    a.room.reconnection.minUptime = 0;
    a.room.connection.close(4010, "cosmetic-club reconnect test");
    await until(() => a.snapshot!.generation > generation);
    expect(a.snapshot!.checkpoint.state.specials).toEqual(before);
    expect(a.snapshot!.checkpoint.state.controllers.find(c => c.id === a.room.sessionId)?.playerId).toBe(controller.playerId);
    a.room.send("resume");
  }, 15000);
  it("bounds concurrent fifth arrival and allows a three-human private start", async () => {
    const options = { build: BUILD, protocol: PROTOCOL };
    const arrivals = await Promise.all(
      Array.from({ length: 5 }, async () =>
        track(await new Client(endpoint).joinOrCreate("cryptball", options)),
      ),
    );
    const groups = new Map<string, number>();
    for (const peer of arrivals)
      groups.set(peer.room.roomId, (groups.get(peer.room.roomId) ?? 0) + 1);
    expect([...groups.values()].sort()).toEqual([1, 4]);
    const group = arrivals.filter((peer) => groups.get(peer.room.roomId) === 4);
    for (const peer of group) peer.room.send("ready");
    await until(() => group.every((peer) => peer.lobby?.phase === "countdown"));
    const first = track(
      await new Client(endpoint).create("cryptball", {
        ...options,
        private: true,
      }),
    );
    const second = track(
      await new Client(endpoint).joinById(first.room.roomId, options),
    );
    const third = track(
      await new Client(endpoint).joinById(first.room.roomId, options),
    );
    for (const peer of [first, second, third]) peer.room.send("ready");
    await until(() => first.lobby?.seats.every((seat) => seat.ready) === true);
    second.room.send("start");
    await until(() => first.lobby?.phase === "countdown");
    await third.room.leave();
    await until(() => first.lobby?.phase === "waiting");
    expect(
      (
        await fetch(`${endpoint}/healthz`, {
          headers: { Origin: "https://untrusted.example" },
        })
      ).status,
    ).toBe(403);
  });
  it("fills four private field seats and reconnects without changing ownership", async () => {
    const options = { build: BUILD, protocol: PROTOCOL };
    const first = track(
      await new Client(endpoint).create("cryptball", {
        ...options,
        private: true,
      }),
    );
    const peers = [first];
    for (let i = 1; i < 4; i++)
      peers.push(
        track(await new Client(endpoint).joinById(first.room.roomId, options)),
      );
    for (const peer of peers) peer.room.send("ready");
    await until(() => first.lobby?.phase === "playing", 10000);
    expect(first.lobby!.capacity).toBe(4);
    expect(first.snapshot!.checkpoint.state.players).toHaveLength(4);
    const returning = peers[2];
    expect(
      first.lobby!.seats.find((s) => s.id === returning.room.sessionId)?.role,
    ).toBe("field");
    const generation = returning.snapshot!.generation;
    returning.room.reconnection.minUptime = 0;
    returning.room.connection.close(4010, "field reconnect test");
    await until(() => returning.snapshot!.generation > generation);
    expect(
      returning.snapshot!.checkpoint.state.controllers.find(
        (c) => c.id === returning.room.sessionId,
      )?.playerId,
    ).toBe("player-1");
    expect(
      returning.lobby!.seats.find((s) => s.id === returning.room.sessionId)
        ?.role,
    ).toBe("field");
    returning.room.send("resume");
  }, 18000);
  it.skipIf(globalThis.process.env.CRYPTBALL_FULL_SOCKET !== "1")(
    "finishes simultaneous full real-time 2/3/4-human socket matches",
    async () => {
      const options = { build: BUILD, protocol: PROTOCOL };
      const matches: ReturnType<typeof track>[][] = [];
      for (const count of [2, 3, 4]) {
        const first = track(
          await new Client(endpoint).create("cryptball", {
            ...options,
            private: true,
          }),
        );
        const peers = [first];
        for (let i = 1; i < count; i++)
          peers.push(
            track(
              await new Client(endpoint).joinById(first.room.roomId, options),
            ),
          );
        matches.push(peers);
        for (const peer of peers) peer.room.send("ready");
        await until(
          () => first.lobby?.seats.every((seat) => seat.ready) === true,
        );
        first.room.send("start");
      }
      const state = new Map<
        Room,
        { seq: number; seenTick: number; sentTick: number; at: number }
      >();
      const timer = setInterval(() => {
        for (const peers of matches)
          for (const peer of peers) {
            const snapshot = peer.snapshot;
            if (!snapshot || peer.lobby?.phase !== "playing") continue;
            let cursor = state.get(peer.room);
            if (!cursor) {
              cursor = {
                seq: 0,
                seenTick: snapshot.tick,
                sentTick: -1,
                at: Date.now(),
              };
              state.set(peer.room, cursor);
            }
            if (cursor.seenTick !== snapshot.tick) {
              cursor.seenTick = snapshot.tick;
              cursor.at = Date.now();
            }
            const controller = snapshot.checkpoint.state.controllers.find(
              (c) => c.id === peer.room.sessionId,
            )!;
            const target =
              snapshot.tick +
              Math.floor((Date.now() - cursor.at) / (1000 / 60)) +
              3;
            if (target <= cursor.sentTick) continue;
            cursor.sentTick = target;
            peer.room.send("input", {
              epoch: snapshot.epoch,
              generation: snapshot.generation,
              seq: ++cursor.seq,
              tick: target,
              revision: controller.revision,
              command: { moveX: 0, moveY: 0 },
            });
          }
      }, 1000 / 60);
      try {
        await until(
          () =>
            matches.every((peers) =>
              peers.every((peer) => peer.lobby?.phase === "results"),
            ),
          180000,
        );
      } finally {
        clearInterval(timer);
      }
      for (const peers of matches) {
        expect(peers[0].snapshot!.tick).toBeGreaterThanOrEqual(5400);
        expect(peers[0].snapshot!.checkpoint.state.phase).toBe("results");
        expect(peers[0].lobby!.seats).toHaveLength(peers.length);
        expect(
          peers.every(
            (peer) =>
              peer.snapshot!.checkpoint.state.score.join() ===
              peers[0].snapshot!.checkpoint.state.score.join(),
          ),
        ).toBe(true);
      }
    },
    190000,
  );
});

it("runs four real browser adapters through an ordered 150ms RTT TCP proxy", async () => {
  const { createOrderedProxy } = await import("../../cryptball-server/tests/ordered-proxy");
  const { createOnlineSession } = await import("../src/online/session");
  const proxy = await createOrderedProxy(
    Number(new URL(endpoint).port),
    75,
    75,
  );
  vi.stubGlobal("sessionStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
  const traceEnabled = globalThis.process.env.CRYPTBALL_SOCKET_TRACE === "1";
  const traces: { kind: string; at: number; fields: Record<string, string | number | boolean | null> }[][] = Array.from({ length: 4 }, () => []);
  const phases: unknown[] = [];
  const metrics = async () => (await fetch(`${endpoint}/metrics`, { headers: { Authorization: "Bearer socket-test" } })).json();
  const adapters = Array.from({ length: 4 }, (_, i) =>
    createOnlineSession({ endpoint: proxy.endpoint,
      onPerformance: traceEnabled ? event => { if (traces[i].length < 12_000) traces[i].push(event); } : undefined,
    }),
  );
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    await Promise.all(adapters.map((adapter) => adapter.connect("quick")));
    const { FixedScheduler } = await import("../../../packages/game-runtime/src/scheduler");
    const clocks = adapters.map(adapter => {
      let tick = 0;
      const clock = new FixedScheduler(() => {
        adapter.step({ moveX: 1, aim: 0, dash: tick++ % 120 === 0 });
      }, () => { throw new Error("Socket adapter exceeded bounded catch-up work"); });
      clock.resume();
      return clock;
    });
    timer = setInterval(() => {
      const now = performance.now();
      adapters.forEach((adapter, i) => clocks[i].advance(now, adapter.predictionRate));
    }, 8);
    await until(
      () => adapters.every((adapter) => adapter.lobby?.phase === "playing"),
      12000,
    );
    if (traceEnabled) phases.push({ at: performance.now(), phase: "all-playing", metrics: await metrics(), diagnostics: adapters.map(a => a.diagnostics) });
    await pause(6000);
    if (traceEnabled) phases.push({ at: performance.now(), phase: "measurement-end", metrics: await metrics(), diagnostics: adapters.map(a => a.diagnostics) });
    for (const adapter of adapters) {
      expect(adapter.status).toBe("joined");
      expect(adapter.lobby?.seats.every((seat) => seat.active)).toBe(true);
      expect(adapter.diagnostics.terminalSeq).toBeGreaterThan(150);
      expect(adapter.diagnostics.botTransitions).toBe(0);
      expect(adapter.diagnostics.resyncRequested).toBe(0);
      expect(adapter.diagnostics.timingRejections, JSON.stringify(adapter.diagnostics)).toBeLessThan(5);
    }
  } finally {
    if (timer) clearInterval(timer);
    if (traceEnabled) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile("/tmp/crypt-four-adapter-trace.json", JSON.stringify({ phases, traces, diagnostics: adapters.map(a => a.diagnostics) }));
    }
    await Promise.allSettled(adapters.map((adapter) => adapter.leave()));
    await proxy.close();
    vi.unstubAllGlobals();
  }
}, 30000);

it.skipIf(globalThis.process.env.CRYPTBALL_CAPACITY !== "1")(
  "measures 1 then 25 active rooms with real adapter controls and server metrics",
  async () => {
    const { createOnlineSession } = await import("../src/online/session");
    const { createSocketLoadClient } = await import(
      "./helpers/socket-load-client"
    );
    const { performance: realClock } = await import("node:perf_hooks");
    const { writeFileSync } = await import("node:fs");
    vi.stubGlobal("sessionStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
    const reports: unknown[] = [];
    const metrics = async () =>
      (
        await fetch(`${endpoint}/metrics`, {
          headers: { Authorization: "Bearer socket-test" },
        })
      ).json();
    try {
      for (const count of [1, 25]) {
        const adapters: (
          | ReturnType<typeof createOnlineSession>
          | ReturnType<typeof createSocketLoadClient>
        )[] = [];
        const spacing: number[] = [];
        let timer: ReturnType<typeof setInterval> | undefined;
        let frames = 0,
          previous = realClock.now();
        try {
          timer = setInterval(() => {
            const now = realClock.now();
            spacing.push(now - previous);
            previous = now;
            frames++;
            for (const adapter of adapters)
              adapter.step({
                moveX: Math.floor(frames / 120) % 2 ? 1 : -1,
                moveY: Math.floor(frames / 60) % 2 ? 1 : -1,
                aim: frames % 256,
                strikePressed: frames % 60 === 0,
                strikeHeld: frames % 60 < 12,
                strikeReleased: frames % 60 === 12,
                dash: frames % 90 === 0,
              });
          }, 1000 / 60);
          let admissions = 0;
          for (let i = 0; i < count; i++) {
            let roomId = "";
            for (let peer = 0; peer < 4; peer++) {
              // Respect the production 60/minute per-IP admission limiter rather than
              // weakening it for load tests. Includes the preceding one-room phase.
              if (admissions === 50) await pause(61000);
              const adapter =
                globalThis.process.env.CRYPTBALL_CAPACITY_PREDICT === "1"
                  ? createOnlineSession({ endpoint, autoReady: false })
                  : createSocketLoadClient(endpoint);
              adapters.push(adapter);
              const joined = await adapter.connect(
                peer === 0 ? "private" : "join",
                roomId || undefined,
              );
              if (peer === 0) roomId = joined;
              admissions++;
            }
          }
          await until(() =>
            adapters.every((adapter) => adapter.status === "joined"),
          );
          for (const adapter of adapters) adapter.ready();
          for (const adapter of adapters) adapter.start();
          await until(
            () =>
              adapters.every((adapter) => adapter.lobby?.phase === "playing"),
            12000,
          );
          await pause(2000);
          const before = await metrics(),
            start = realClock.now();
          const terminalBefore = adapters.map(
            (adapter) => adapter.diagnostics.terminalSeq,
          );
          spacing.length = 0;
          await pause(6000);
          const elapsedMs = realClock.now() - start,
            after = await metrics();
          spacing.sort((a, b) => a - b);
          const report = {
            rooms: count,
            scope:
              "four real SDK connections per room using production clock/scheduler and scripted controls; full-world predictors only when CRYPTBALL_CAPACITY_PREDICT=1; local ws; six-second measured interval after two-second warmup; not production-device or WAN qualification",
            elapsedMs,
            before,
            after,
            observedTimerSpacingMs: {
              p50: spacing[Math.floor(spacing.length * 0.5)],
              p95: spacing[Math.floor(spacing.length * 0.95)],
              max: spacing.at(-1),
            },
            clients: adapters.map((adapter, i) => ({
              status: adapter.status,
              terminalProgress:
                adapter.diagnostics.terminalSeq - terminalBefore[i]!,
              ...adapter.diagnostics,
            })),
          };
          reports.push(report);
          if (globalThis.process.env.CRYPTBALL_CAPACITY_REPORT)
            writeFileSync(
              globalThis.process.env.CRYPTBALL_CAPACITY_REPORT,
              JSON.stringify(reports, null, 2),
            );
          for (const client of report.clients) {
            expect(client.status, JSON.stringify(report)).toBe("joined");
            expect(
              client.terminalProgress,
              JSON.stringify(report),
            ).toBeGreaterThan(200);
            expect(client.botTransitions, JSON.stringify(report)).toBe(0);
          }
        } catch (error) {
          reports.push({
            rooms: count,
            error: String(error),
            metrics: await metrics(),
            clients: adapters.map((adapter) => ({
              status: adapter.status,
              phase: adapter.lobby?.phase,
              ...adapter.diagnostics,
            })),
          });
          if (globalThis.process.env.CRYPTBALL_CAPACITY_REPORT)
            writeFileSync(
              globalThis.process.env.CRYPTBALL_CAPACITY_REPORT,
              JSON.stringify(reports, null, 2),
            );
          throw error;
        } finally {
          if (timer) clearInterval(timer);
          await Promise.allSettled(adapters.map((adapter) => adapter.leave()));
          await pause(100);
        }
      }
    } finally {
      vi.unstubAllGlobals();
    }
  },
  180000,
);
