import { Client, type Room } from "@colyseus/sdk";
import {
  BUILD,
  PROTOCOL,
  decodeSnapshot,
  quantizeCommand,
  type Lobby,
  type Snapshot,
} from "../../protocol";
import type { CommandFrame, SportId } from "../../sim/contract";
import { NetworkClock } from "../../src/online/clock";
import { InputScheduler } from "../../src/online/input-scheduler";
import { FixedScheduler } from "../../../../packages/game-runtime/src/scheduler";
/** Real SDK + production clock/scheduler, without 100 full-world predictors on the generator CPU. */
export function createSocketLoadClient(endpoint: string, sportId: SportId = "cryptball") {
  let room: Room,
    lobby: Lobby | null = null,
    snapshot: Snapshot | undefined,
    status = "connecting",
    seq = 0;
  let pingAt = -Infinity,
    heartbeatAt = -Infinity;
  const clock = new NetworkClock(),
    scheduler = new InputScheduler();
  const fixed = new FixedScheduler(() => {
    if (!snapshot || status !== "joined" || lobby?.phase !== "playing") return;
    const slot = scheduler.allocate(clock.fractionalTick, snapshot.tick, performance.now());
    if (slot) room.send("input", {
      epoch: snapshot.epoch, generation: snapshot.generation,
      revision: snapshot.checkpoint.state.controllers.find(c => c.id === room.sessionId)?.revision ?? 0,
      seq: ++seq, tick: slot.tick, command: slot.command,
    });
  }, () => fixed.resume());
  return {
    async connect(kind: "private" | "join", code?: string) {
      const client = new Client(endpoint),
        options = { build: BUILD, protocol: PROTOCOL, sportId };
      room =
        kind === "private"
          ? await client.create("cryptball", { ...options, private: true })
          : await client.joinById(code!, options);
      room.onMessage("lobby", (value: Lobby) => {
        const wasPlaying = lobby?.phase === "playing";
        lobby = value;
        if (value.phase === "playing" && !wasPlaying) fixed.resume();
        else if (value.phase !== "playing") fixed.pause();
      });
      room.onMessage("pong", (value) => {
        if (snapshot) clock.pong(value, performance.now(), snapshot.epoch);
      });
      room.onMessage("snapshot", (bytes: Uint8Array) => {
        const next = decodeSnapshot(bytes);
        if (snapshot && next.snapshotSeq <= snapshot.snapshotSeq) return;
        if (
          !snapshot ||
          next.epoch !== snapshot.epoch ||
          next.generation !== snapshot.generation
        ) {
          clock.reset();
          scheduler.reset();
          seq = 0;
          if (lobby?.phase === "playing") fixed.resume();
        }
        if (snapshot && next.epoch === snapshot.epoch && next.generation === snapshot.generation &&
          next.checkpoint.state.controllers.find(c => c.id === room.sessionId)?.revision !==
          snapshot.checkpoint.state.controllers.find(c => c.id === room.sessionId)?.revision) {
          scheduler.reset();
          fixed.resume();
        }
        snapshot = next;
        status = "joined";
        clock.checkpoint(next.tick, next.serverTime, next.phase);
        const f = next.feedback;
        scheduler.feedback(
          f.sampleSeq,
          f.sampleCount,
          f.lowMargin,
          f.minimumMargin,
          performance.now(),
        );
      });
      room.onMessage("interrupted", () => {
        status = "interrupted";
      });
      room.onDrop(() => {
        status = "interrupted";
      });
      room.onLeave(() => {
        status = "left";
      });
      return room.roomId;
    },
    step(command: CommandFrame) {
      if (!snapshot || status !== "joined") return;
      const now = performance.now(),
        revision =
          snapshot.checkpoint.state.controllers.find(
            (c) => c.id === room.sessionId,
          )?.revision ?? 0;
      if (now - pingAt >= 1000) {
        pingAt = now;
        room.send("ping", clock.ping(now));
      }
      if (now - heartbeatAt >= 100) {
        heartbeatAt = now;
        room.send("heartbeat", {
          epoch: snapshot.epoch,
          generation: snapshot.generation,
          revision,
        });
      }
      if (lobby?.phase !== "playing") return;
      scheduler.capture(quantizeCommand(command), now,
        ["cryptcheck", "crypt-dodge", "crypt-guardian"].includes(sportId), sportId);
      fixed.advance(now, scheduler.predictionRate(clock.fractionalTick));
    },
    ready() {
      room.send("ready");
    },
    start() {
      room.send("start");
    },
    async leave() {
      fixed.pause();
      await room?.leave();
    },
    get status() {
      return status;
    },
    get lobby() {
      return lobby;
    },
    get diagnostics() {
      return {
        terminalSeq: snapshot?.terminalSeq ?? 0,
        receivedSeq: snapshot?.receivedSeq ?? 0,
        botTransitions: snapshot?.feedback.botTransitions ?? 0,
        timingRejections: snapshot?.feedback.rejections ?? 0,
        rttMs: clock.rtt,
        desiredLead: scheduler.lead,
      };
    },
  };
}
