import { it, expect, vi } from "vitest";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import NodeWebSocket from "ws";
import type { Client, Room } from "@colyseus/sdk";
import type { Lobby, Snapshot } from "../protocol";
import type { SportId } from "../sim/contract";

// Run: CRYPTBALL_FRIENDS_LOAD=1 npx vitest run --config vitest.cryptball-network.config.ts apps/cryptball/tests/online-friends-load.test.ts
// Soak: additionally set CRYPTBALL_FRIENDS_LOAD_MS=1800000 and a distinct CRYPTBALL_FRIENDS_LOAD_REPORT.
// Work p95/p99 are bounded rolling server windows; event-loop values span server lifetime.
const enabled = process.env.CRYPTBALL_FRIENDS_LOAD === "1";
const durationMs = Number(process.env.CRYPTBALL_FRIENDS_LOAD_MS ?? 60000);
const reportPath =
  process.env.CRYPTBALL_FRIENDS_LOAD_REPORT ??
  "/tmp/cryptball-friends-load.json";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sports: SportId[] = [
  "cryptball",
  "cryptkick",
  "rift-volley",
  "cryptcheck",
  "crypt-dodge",
];
type Peer = {
  directory: Room;
  room: Room;
  sportId: SportId;
  lobby?: Lobby;
  snapshot?: Snapshot;
  seq: number;
  target: number;
  epoch: number;
  generation: number;
  snapshots: number;
  bytes: number;
  firstFrameMs: number;
  intervals: number[];
  lastFrame: number;
  closeCode?: number;
  errors: string[];
  seatedFrames: number;
  terminalProgress: number;
  rematches: number;
};

it.skipIf(!enabled)(
  "qualifies mixed friends courts on local real WebSockets",
  async () => {
    if (
      !Number.isFinite(durationMs) ||
      durationMs < 15000 ||
      durationMs > 86400000
    )
      throw Error(
        "CRYPTBALL_FRIENDS_LOAD_MS must be between 15000 and 86400000",
      );
    // Explicitly use ws so the slow receiver exercises real TCP backpressure.
    vi.stubGlobal("WebSocket", NodeWebSocket);
    vi.resetModules();
    let server: ChildProcess | undefined;
    let slowProxy: ChildProcess | undefined;
    let slowProxyEndpoint = "";
    let endpoint = "",
      serverOutput = "",
      timer: ReturnType<typeof setInterval> | undefined;
    let reportTimer: ReturnType<typeof setInterval> | undefined;
    const directories: Room[] = [],
      peers: Peer[] = [];
    const samples: unknown[] = [];
    const report: Record<string, unknown> = {
      scope:
        "Local loopback real WebSockets; scripted SDK controls without browser rendering/prediction; not WAN or hosting qualification",
      sports,
      spectators: [8, 0, 4, 8, 4],
      requestedDurationMs: durationMs,
      reportPath,
    };
    const flush = () =>
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
    const until = async (predicate: () => boolean, timeout = 15000) => {
      const deadline = Date.now() + timeout;
      while (!predicate()) {
        if (Date.now() >= deadline)
          throw Error(`Load condition timed out. ${serverOutput.slice(-2000)}`);
        await pause(25);
      }
    };
    const summarize = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return {
        count: sorted.length,
        p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
        p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
        p99: sorted[Math.floor(sorted.length * 0.99)] ?? 0,
        max: sorted.at(-1) ?? 0,
      };
    };
    try {
      await promisify(execFile)(process.execPath, [
        "apps/cryptball-server/build.mjs",
      ]);
      const { BUILD, PROTOCOL, decodeSnapshot } = await import("../protocol");
      const { Client: SDKClient } = await import("@colyseus/sdk");
      server = spawn(process.execPath, ["dist/cryptball-server/main.mjs"], {
        env: {
          ...process.env,
          HOST: "127.0.0.1",
          PORT: "0",
          CRYPTBALL_METRICS_TOKEN: "friends-load-local",
          CRYPTBALL_GROUP_SECRET: "local-load-test-only",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      server.stdout!.on("data", (chunk) => {
        serverOutput = (serverOutput + chunk.toString()).slice(-20000);
        const port = serverOutput.match(/"port":(\d+)/)?.[1];
        if (port) endpoint = `http://127.0.0.1:${port}`;
      });
      server.stderr!.on("data", (chunk) => {
        serverOutput = (serverOutput + chunk.toString()).slice(-20000);
      });
      await until(() => !!endpoint);
      report.endpoint = endpoint;
      const metrics = async () => {
        const response = await fetch(`${endpoint}/metrics`, {
          headers: { Authorization: "Bearer friends-load-local" },
        });
        if (!response.ok) throw Error(`Metrics HTTP ${response.status}`);
        return response.json();
      };
      let groupKey = "",
        requestCounter = 0;
      const addMember = async (name: string) => {
        const client = new SDKClient(endpoint);
        const directory = groupKey
          ? await client.joinOrCreate("friends", {
              build: BUILD,
              protocol: PROTOCOL,
              groupKey,
              name,
            })
          : await client.create("friends", {
              build: BUILD,
              protocol: PROTOCOL,
              foundingKey: "friends-load-founding-key",
              name,
            });
        directories.push(directory);
        directory.onMessage("directory", (value) => {
          groupKey = value.groupKey;
        });
        await until(() => !!groupKey);
        return { directory, client };
      };
      const joinCourt = async (
        directory: Room,
        client: Client,
        sportId: SportId,
        courtId?: string,
        intent = "play",
      ) => {
        const id = `load-${++requestCounter}`;
        const reservation = await new Promise<unknown>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(Error("Reservation timed out")),
            12000,
          );
          const offReservation = directory.onMessage(
            "court-reservation",
            (value) => {
              if (value.requestId !== id) return;
              clearTimeout(timeout);
              offReservation();
              offError();
              resolve(value.reservation);
            },
          );
          const offError = directory.onMessage("directory-error", (value) => {
            if (value.requestId !== id) return;
            clearTimeout(timeout);
            offReservation();
            offError();
            reject(Error(value.message));
          });
          directory.send("court", { requestId: id, sportId, courtId, intent });
        });
        const requestedAt = performance.now();
        const room = await client.consumeSeatReservation(
          reservation as Parameters<Client["consumeSeatReservation"]>[0],
        );
        const peer: Peer = {
          directory,
          room,
          sportId,
          seq: 0,
          target: -1,
          epoch: 0,
          generation: 0,
          snapshots: 0,
          bytes: 0,
          firstFrameMs: 0,
          intervals: [],
          lastFrame: 0,
          errors: [],
          seatedFrames: 0,
          terminalProgress: 0,
          rematches: 0,
        };
        peers.push(peer);
        room.onMessage("lobby", (value) => {
          peer.lobby = value;
        });
        room.onMessage("pong", () => {});
        room.onMessage("snapshot", (bytes: Uint8Array) => {
          try {
            const next = decodeSnapshot(bytes),
              now = performance.now();
            if (
              intent === "play" &&
              (next.observer === true || next.participantId !== room.sessionId)
            )
              peer.errors.push(
                "Seated player received another identity's checkpoint",
              );
            if (
              intent === "watch" &&
              (!next.observer ||
                next.participantId !== "observer" ||
                next.checkpoint.state.controllers.some(
                  (c) => c.id === room.sessionId,
                ))
            )
              peer.errors.push("Observer received a playable checkpoint");
            if (!peer.snapshots) peer.firstFrameMs = now - requestedAt;
            if (peer.lastFrame && peer.intervals.length < 50000)
              peer.intervals.push(now - peer.lastFrame);
            peer.lastFrame = now;
            peer.snapshots++;
            peer.bytes += bytes.byteLength;
            if (
              next.epoch !== peer.epoch ||
              next.generation !== peer.generation
            ) {
              if (peer.epoch && next.epoch !== peer.epoch) peer.rematches++;
              peer.epoch = next.epoch;
              peer.generation = next.generation;
              peer.seq = 0;
              peer.target = -1;
            }
            if (next.observer !== true) {
              peer.seatedFrames++;
              peer.terminalProgress += Math.max(
                0,
                next.terminalSeq -
                  (peer.snapshot?.epoch === next.epoch &&
                  peer.snapshot.generation === next.generation
                    ? peer.snapshot.terminalSeq
                    : 0),
              );
            }
            peer.snapshot = next;
          } catch (error) {
            peer.errors.push(String(error));
          }
        });
        room.onMessage("interrupted", (value) =>
          peer.errors.push(String(value)),
        );
        room.onLeave((code) => {
          peer.closeCode = code;
        });
        return peer;
      };
      const courts: Peer[][] = [];
      for (const sportId of sports) {
        const players: Peer[] = [];
        for (let i = 0; i < 4; i++) {
          const member = await addMember(`${sportId}-${i}`);
          players.push(
            await joinCourt(
              member.directory,
              member.client,
              sportId,
              players[0]?.room.roomId,
            ),
          );
        }
        courts.push(players);
      }
      await until(() => peers.every((peer) => !!peer.snapshot));
      let frames = 0;
      timer = setInterval(() => {
        frames++;
        for (const peer of peers) {
          if (peer.closeCode || !peer.snapshot || !peer.room.connection.isOpen)
            continue;
          const snapshot = peer.snapshot;
          if (snapshot.observer) continue;
          if (peer.lobby?.phase === "waiting") {
            if (frames % 15 === 0) peer.room.send("start");
            continue;
          }
          if (peer.lobby?.phase === "results") {
            if (frames % 30 === 0) peer.room.send("rematch");
            continue;
          }
          if (peer.lobby?.phase !== "playing") continue;
          const controller = snapshot.checkpoint.state.controllers.find(
            (c) => c.id === peer.room.sessionId,
          );
          if (!controller) continue;
          if (frames % 3 === 0)
            peer.room.send("heartbeat", {
              epoch: snapshot.epoch,
              generation: snapshot.generation,
              revision: controller.revision,
            });
          const target = snapshot.tick + 6;
          if (target <= peer.target) continue;
          peer.target = target;
          peer.room.send("input", {
            epoch: snapshot.epoch,
            generation: snapshot.generation,
            seq: ++peer.seq,
            tick: target,
            revision: controller.revision,
            command: {
              moveX: frames % 120 < 60 ? 1 : -1,
              moveY: frames % 180 < 90 ? 1 : -1,
              aim: frames % 256,
              strikePressed: frames % 30 === 0,
              strikeHeld: frames % 30 < 6,
              strikeReleased: frames % 30 === 6,
              dash: frames % 90 === 0,
            },
          });
        }
      }, 1000 / 30);
      await until(() =>
        courts.every((players) => players[0].lobby?.phase === "playing"),
      );
      const baselineStart = performance.now();
      const baselineBefore = await metrics();
      await pause(2000);
      report.playerOnlyBaseline = await metrics();
      report.playerOnlyBytesPerSecond =
        ((report.playerOnlyBaseline as { bytes: number }).bytes -
          baselineBefore.bytes) /
        ((performance.now() - baselineStart) / 1000);
      slowProxy = spawn(
        "python3",
        [
          "apps/cryptball-server/tests/slow-receiver-proxy.py",
          new URL(endpoint).port,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      slowProxy.stdout!.on("data", (chunk) => {
        const port = chunk.toString().match(/"port": (\d+)/)?.[1];
        if (port) slowProxyEndpoint = `http://127.0.0.1:${port}`;
      });
      await until(() => !!slowProxyEndpoint);
      const spectatorCounts = [8, 0, 4, 8, 4];
      for (let i = 0; i < sports.length; i++)
        for (let viewer = 0; viewer < spectatorCounts[i]; viewer++) {
          const member = await addMember(`Viewer-${i}-${viewer}`);
          await joinCourt(
            member.directory,
            i === 4 && viewer === 3
              ? new SDKClient(slowProxyEndpoint)
              : member.client,
            sports[i],
            courts[i][0].room.roomId,
            "watch",
          );
        }
      await until(() => peers.every((peer) => !!peer.snapshot));
      for (const players of courts)
        for (const peer of players) {
          expect(peer.lobby?.friends).toBe(true);
          expect(peer.snapshot?.observer).not.toBe(true);
          expect(peer.snapshot?.participantId).toBe(peer.room.sessionId);
        }
      report.sameIpMembers = directories.length;
      report.concurrentWebSockets = directories.length + peers.length;
      report.before = await metrics();
      const start = performance.now();
      const slow = peers.filter((peer) => peer.snapshot?.observer).at(-1)!;
      const slowBefore = (await metrics()).droppedSlow;
      slowProxy.stdin!.write("pause\n");
      report.slowReceiverPausedAtMs = performance.now() - start;
      let slowRecovered = false,
        reconnectVerified = false;
      reportTimer = setInterval(() => {
        void metrics()
          .then((value) => {
            samples.push({ elapsedMs: performance.now() - start, ...value });
            report.samples = samples;
            report.progress = peers.map((peer) => ({
              sportId: peer.sportId,
              observer: peer.snapshot?.observer === true,
              phase: peer.lobby?.phase,
              epoch: peer.snapshot?.epoch,
              snapshots: peer.snapshots,
              terminalProgress: peer.terminalProgress,
              rematches: peer.rematches,
              errors: peer.errors,
              closeCode: peer.closeCode,
            }));
            flush();
          })
          .catch((error) => {
            report.metricError = String(error);
          });
      }, 5000);
      while (performance.now() - start < durationMs) {
        await pause(1000);
        const elapsed = performance.now() - start;
        if (!reconnectVerified && elapsed > 3000) {
          const peer = courts[1][0],
            generation = peer.snapshot!.generation;
          peer.room.reconnection.minUptime = 0;
          peer.room.connection.close(4010, "load reconnect churn");
          await until(() => peer.snapshot!.generation > generation);
          peer.room.send("resume");
          report.playerReconnectMs = performance.now() - start - elapsed;
          reconnectVerified = true;
        }
        if (!slowRecovered && (await metrics()).droppedSlow > slowBefore) {
          slowProxy.stdin!.write("resume\n");
          await until(() => slow.closeCode === 4001, 10000);
          const recovered = await joinCourt(
            slow.directory,
            new SDKClient(endpoint),
            slow.sportId,
            slow.room.roomId,
            "watch",
          );
          await until(() => !!recovered.snapshot);
          expect(recovered.snapshot!.observer).toBe(true);
          report.slowRecovery = {
            droppedAfterMs: performance.now() - start,
            closeCode: slow.closeCode,
            firstFrameMs: recovered.firstFrameMs,
          };
          slowRecovered = true;
        }
      }
      slowProxy.stdin!.write("resume\n");
      report.elapsedMs = performance.now() - start;
      report.after = await metrics();
      const before = report.before as {
        bytes: number;
        snapshots: number;
        work: { encodeMs: { count: number } };
      };
      const after = report.after as typeof before;
      report.measured = {
        bytesPerSecond:
          (after.bytes - before.bytes) / ((report.elapsedMs as number) / 1000),
        snapshots: after.snapshots - before.snapshots,
        actualEncodes: after.work.encodeMs.count - before.work.encodeMs.count,
      };
      report.serverOutput = serverOutput;
      report.clients = peers.map((peer) => ({
        sportId: peer.sportId,
        observer: peer.snapshot?.observer === true,
        snapshots: peer.snapshots,
        bytes: peer.bytes,
        closeCode: peer.closeCode,
        errors: peer.errors,
        firstFrameMs: peer.firstFrameMs,
        checkpointSpacingMs: summarize(peer.intervals),
        seatedFrames: peer.seatedFrames,
        terminalProgress: peer.terminalProgress,
        rematches: peer.rematches,
      }));
      report.firstFrameMs = summarize(peers.map((peer) => peer.firstFrameMs));
      report.slowRecovered = slowRecovered;
      report.status = "complete";
      flush();
      expect(reconnectVerified).toBe(true);
      expect(
        slowRecovered,
        `Slow consumer did not fill TCP buffers within ${durationMs}ms; see ${reportPath}`,
      ).toBe(true);
      for (const peer of peers)
        expect(peer.errors, `${peer.sportId}: ${reportPath}`).toEqual([]);
      for (const players of courts)
        for (const peer of players) {
          expect(peer.snapshot?.observer).not.toBe(true);
          expect(peer.snapshot?.participantId).toBe(peer.room.sessionId);
          expect(peer.terminalProgress).toBeGreaterThan(50);
        }
      expect((report.after as { maxDebtMs: number }).maxDebtMs).toBeLessThan(
        250,
      );
    } catch (error) {
      report.status = "failed";
      report.error = String(error);
      report.serverOutput = serverOutput;
      flush();
      throw error;
    } finally {
      if (timer) clearInterval(timer);
      if (reportTimer) clearInterval(reportTimer);
      await Promise.allSettled(peers.map((peer) => peer.room.leave()));
      await Promise.allSettled(directories.map((room) => room.leave()));
      server?.kill("SIGKILL");
      slowProxy?.kill("SIGKILL");
      vi.unstubAllGlobals();
    }
  },
  durationMs + 90000,
);
