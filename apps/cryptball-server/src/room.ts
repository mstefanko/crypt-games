import { Room, type Client } from "@colyseus/core";
import {
  BUILD,
  PROTOCOL,
  NETWORK_LIMITS,
  encodeSnapshot,
  resolveSportId,
  validatePing,
  validateResync,
  type ResyncRequest,
} from "@onepage/cryptball/protocol";
import { ROSTER } from "@onepage/cryptball/sim";
import { MatchAuthority } from "./model";
import { work } from "./metrics";
export const service = {
  draining: false,
  overloaded: false,
  rooms: new Set<CryptballRoom>(),
  snapshots: 0,
  bytes: 0,
  rejected: 0,
  droppedSlow: 0,
  debt: 0,
  maxRooms: 25,
  heartbeatsAccepted: 0,
  heartbeatsRejected: 0,
  resyncRequested: 0,
  resyncRejected: 0,
  resyncServed: 0,
  maxBacklogDuration: 0,
  peerOutbound: new Map<string, { bytes: number; backlogDuration: number }>(),
};
/** Transport-specific hook verified against @colyseus/ws-transport 0.18.4. */
export function pendingBytes(client: Client): number {
  const ref = client.ref as { bufferedAmount?: number };
  return typeof ref?.bufferedAmount === "number"
    ? ref.bufferedAmount
    : Infinity;
}
export class CryptballRoom extends Room {
  maxClients: number = ROSTER.playerCount;
  maxMessagesPerSecond = 100;
  authority!: MatchAuthority;
  private last = 0;
  private debt = 0;
  private emptyAt: number | null = null;
  private lobbyKey = "";
  private lobbyDirtyKey = "";
  private stableSince = 0;
  private resync = new Map<string, { at: number; request: ResyncRequest }>();
  private backlogSince = new Map<string, number>();
  async onCreate(options: {
    private?: boolean;
    shuffle?: boolean;
    build?: string;
    protocol?: number;
    sportId?: unknown;
  }) {
    if (
      service.draining ||
      service.overloaded ||
      service.rooms.size >= service.maxRooms
    )
      throw Error("Service unavailable");
    if (options.build !== BUILD || options.protocol !== PROTOCOL)
      throw Error("Refresh to update Cryptball");
    const sportId = resolveSportId(options.sportId);
    if (sportId === "crypt-guardian") throw Error("Crypt Guardian is solo only for now.");
    this.authority = new MatchAuthority(
      this.roomId,
      options.private === true,
      sportId,
      options.shuffle === true,
    );
    this.maxClients = this.authority.capacity;
    this.seatReservationTimeout = 10;
    await this.setPrivate(options.private === true);
    await this.setMetadata({
      sportId,
      build: BUILD,
      protocol: PROTOCOL,
      createdAt: Date.now(),
    });
    service.rooms.add(this);
    this.onMessage("ping", (c, v) => {
      if (validatePing(v))
        c.send("pong", {
          ...v,
          serverTime: performance.now(),
          tick: this.authority.session.getTick(),
          epoch: this.authority.epoch,
          phase: this.authority.phase,
          serverDebt: this.debt,
        });
    });
    this.onMessage("heartbeat", (c, v) =>
      this.authority.heartbeat(c.sessionId, v)
        ? service.heartbeatsAccepted++
        : service.heartbeatsRejected++,
    );
    this.onMessage("resync", (c, v) => {
      service.resyncRequested++;
      const p = this.authority.peers.get(c.sessionId),
        now = performance.now();
      if (
        !p ||
        !validateResync(v) ||
        v.epoch !== this.authority.epoch ||
        v.generation !== p.generation
      ) {
        service.resyncRejected++;
        return;
      }
      const previous = this.resync.get(c.sessionId);
      if (previous && now - previous.at < NETWORK_LIMITS.resyncMinMs) {
        service.resyncRejected++;
        return;
      }
      this.resync.set(c.sessionId, { at: now, request: v });
    });
    this.onMessage("team", (c, value) => {
      const teamId =
        value && typeof value === "object" ? value.teamId : undefined;
      if (!this.authority.selectTeam(c.sessionId, teamId))
        c.send(
          "team-error",
          "Choose an available team while the lobby is waiting.",
        );
      this.sendLobby();
    });
    this.onMessage("ready", (c) => this.authority.ready(c.sessionId));
    this.onMessage("start", () => this.authority.start());
    this.onMessage("rematch", (c) => {
      this.authority.rematch(c.sessionId);
      this.sendLobby(); // Announce playlist/epoch changes before new checkpoints.
    });
    this.onMessage("input", (c, v) => {
      if (!this.authority.receive(c.sessionId, v)) service.rejected++;
    });
    this.onMessage("suspend", (c) => this.authority.suspend(c.sessionId, true));
    this.onMessage("resume", (c) => this.resumePeer(c));
    this.last = performance.now();
    this.setSimulationInterval(() => this.pump(), 8);
  }
  onAuth(
    _client: Client,
    options: { build?: string; protocol?: number; sportId?: unknown },
  ) {
    if (
      service.draining ||
      options.build !== BUILD ||
      options.protocol !== PROTOCOL
    )
      throw Error("Refresh or retry matchmaking");
    if (
      options.sportId !== undefined &&
      resolveSportId(options.sportId) !== this.authority.sportId
    )
      throw Error(
        "This room plays a different sport. Select its sport to join.",
      );
    return true;
  }
  onJoin(
    client: Client,
    options: { name?: unknown; preferredTeamId?: unknown },
  ) {
    this.authority.join(
      client.sessionId,
      typeof options.name === "string" ? options.name : "Guest",
      options.preferredTeamId,
    );
    this.sendLobby();
    this.sendSnapshot(client, []);
  }
  async onDrop(client: Client) {
    this.authority.drop(client.sessionId);
    this.sendLobby();
    try {
      await this.allowReconnection(client, 15);
    } catch {
      /* onLeave removes the expired seat. */
    }
  }
  onReconnect(client: Client) {
    this.authority.reconnect(client.sessionId);
    this.sendLobby();
    this.sendSnapshot(client, []);
  }
  onLeave(client: Client) {
    this.resync.delete(client.sessionId);
    this.backlogSince.delete(client.sessionId);
    service.peerOutbound.delete(`${this.roomId}:${client.sessionId}`);
    this.authority.remove(client.sessionId);
    this.sendLobby();
  }
  onDispose() {
    for (const key of service.peerOutbound.keys())
      if (key.startsWith(`${this.roomId}:`)) service.peerOutbound.delete(key);
    service.rooms.delete(this);
  }
  private resumePeer(client: Client) {
    // Lifecycle transitions use the next regular broadcast, including in the lobby.
    // Repeated resume messages must never amplify into full checkpoint responses.
    this.authority.suspend(client.sessionId, false);
  }
  private pump() {
    const pumpStarted = performance.now();
    try {
      const now = performance.now();
      this.debt += now - this.last;
      this.last = now;
      if (this.debt <= 250) {
        this.stableSince ||= now;
        if (
          now - this.stableSince > 5000 &&
          [...service.rooms].every((r) => r.debt <= 250)
        )
          service.overloaded = false;
      } else this.stableSince = 0;
      if (this.debt > 250) {
        service.overloaded = true;
        service.debt = Math.max(service.debt, this.debt);
      }
      if (this.debt > 1000) {
        this.authority.phase = "closing";
        this.broadcast("interrupted", "The match server could not keep up.");
        void this.disconnect();
        return;
      }
      let steps = 0;
      let snapshotDue = false;
      while (this.debt >= 1000 / 60 && steps++ < 4) {
        this.debt -= 1000 / 60;
        const tickStarted = performance.now();
        this.authority.advance();
        work.tickMs.observe(performance.now() - tickStarted);
        snapshotDue ||= this.authority.tick % 3 === 0;
      }
      if (snapshotDue) {
        // Capture only the newest state after catch-up; drain once to retain every event.
        const events = this.authority.session.drainEvents();
        const checkpoint = this.authority.session.capture();
        for (const c of this.clients) this.sendSnapshot(c, events, checkpoint);
      }
      const phase = this.authority.phase;
      if (
        phase === "countdown" ||
        phase === "playing" ||
        phase === "results" ||
        service.draining
      ) {
        if (!this.locked) void this.lock();
      } else if (this.locked) void this.unlock();
      if (![...this.authority.peers.values()].some((p) => p.connected)) {
        this.emptyAt ??= now;
        if (now - this.emptyAt > 16000) {
          void this.disconnect();
          return;
        }
      } else this.emptyAt = null;
      if (phase === "closing") {
        void this.disconnect();
        return;
      }
      this.sendLobby(false);
    } finally {
      work.pumpMs.observe(performance.now() - pumpStarted);
    }
  }
  private sendSnapshot(
    client: Client,
    events: Parameters<MatchAuthority["snapshot"]>[1],
    checkpoint?: ReturnType<MatchAuthority["session"]["capture"]>,
  ) {
    if (!this.authority.peers.has(client.sessionId)) return;
    const pending = pendingBytes(client);
    if (pending > 0) {
      if (!this.backlogSince.has(client.sessionId))
        this.backlogSince.set(client.sessionId, performance.now());
    } else this.backlogSince.delete(client.sessionId);
    if (pending > 65536) {
      service.droppedSlow++;
      client.leave(4001, "Connection too slow; reconnect");
      return;
    }
    try {
      const snapshot = this.authority.snapshot(
        client.sessionId,
        events,
        checkpoint,
        performance.now(),
        this.debt,
      );
      const request = this.resync.get(client.sessionId);
      if (request && request.request.id >= 0) {
        snapshot.resyncId = request.request.id;
        service.resyncServed++;
        request.request = { ...request.request, id: -1 };
      }
      const encodeStarted = performance.now();
      const bytes = encodeSnapshot(snapshot);
      work.encodeMs.observe(performance.now() - encodeStarted);
      work.payloadBytes.observe(bytes.byteLength);
      service.snapshots++;
      service.bytes += bytes.byteLength;
      const backlogDuration =
        performance.now() -
        (this.backlogSince.get(client.sessionId) ?? performance.now());
      const key = `${this.roomId}:${client.sessionId}`;
      service.peerOutbound.set(key, {
        bytes: (service.peerOutbound.get(key)?.bytes ?? 0) + bytes.byteLength,
        backlogDuration: Math.max(0, backlogDuration),
      });
      service.maxBacklogDuration = Math.max(
        service.maxBacklogDuration,
        backlogDuration,
      );
      client.sendBytes("snapshot", bytes);
    } catch {
      this.authority.phase = "closing";
      this.broadcast("interrupted", "Match checkpoint exceeded its limit.");
    }
  }
  private sendLobby(force = true) {
    const dirtyKey = `${this.authority.lobbyRevision}:${this.authority.phase}:${Math.ceil(this.authority.countdown / 15)}`;
    if (!force && dirtyKey === this.lobbyDirtyKey) return;
    this.lobbyDirtyKey = dirtyKey;
    const lobby = this.authority.lobby(),
      key = JSON.stringify(lobby);
    if (key === this.lobbyKey) return;
    this.lobbyKey = key;
    this.broadcast("lobby", lobby);
  }
}
