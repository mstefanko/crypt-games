import { Client, type Room } from "@colyseus/sdk";
import { NetworkClock } from "./clock";
import { InputScheduler, replaySchedule } from "./input-scheduler";
import { Recovery } from "./recovery";
import { PresentationCorrections } from "./corrections";
import { confirmedCombatPresentation } from "./confirmed-combat";
import { CosmeticLedger } from "./cosmetics";
import {
  createCryptballSession,
  type CommandFrame,
  type Observation,
  type CryptballEvent,
  type SportId,
  type TeamId,
} from "@onepage/cryptball/sim";
import {
  BUILD,
  PROTOCOL,
  HISTORY_LIMIT,
  NETWORK_LIMITS,
  decodeSnapshot,
  heldCommand,
  quantizeCommand,
  resolveSportId,
  isSportId,
  type Lobby,
  type InputPacket,
  type Snapshot,
} from "@onepage/cryptball/protocol";
export type OnlineStatus =
  | "connecting"
  | "joined"
  | "reconnecting"
  | "interrupted"
  | "left";
export interface OnlineOptions {
  autoReady?: boolean;
  name?: string;
  shuffle?: boolean;
  sportId?: SportId;
  preferredTeamId?: TeamId;
  onTeamError?: (message: string) => void;
  endpoint?: string;
  onStatus?: (status: OnlineStatus) => void;
  onLobby?: (lobby: Lobby) => void;
  onError?: (message: string) => void;
}
export function createOnlineSession(options: OnlineOptions = {}) {
  const local = typeof location !== "undefined" && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  if (!options.endpoint && !import.meta.env.VITE_CRYPTBALL_SERVER && !local)
    throw Error("Online play is not configured for this website yet. Solo and Practice are available.");
  const endpoint =
    options.endpoint ??
    import.meta.env.VITE_CRYPTBALL_SERVER ??
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.hostname}:2567`;
  let sportId = resolveSportId(options.sportId);
  let discoveringSport = false;
  const client = new Client(endpoint);
  let room: Room | undefined;
  const session = createCryptballSession({ mode: "practice", sportId });
  let lobby: Lobby | null = null,
    status: OnlineStatus = "connecting",
    id = "",
    generation = 0,
    epoch = 0,
    seq = 0,
    lastTick = -1,
    suspended = false,
    neutralLatch = true,
    joinedAt = 0,
    lastPing = -Infinity,
    lastHeartbeat = -Infinity,
    lastSnapshotSeq = -1,
    lastSnapshotAt = 0;
  const clock = new NetworkClock();
  const scheduler = new InputScheduler();
  const recovery = new Recovery();
  const corrections = new PresentationCorrections();
  const cosmetics = new CosmeticLedger();
  let remote: Record<string, CommandFrame> = {};
  let localHeld: CommandFrame = {};
  let authority: Observation | null = null;
  let authoritativeControllers: {id:string;team:0|1;playerId:string}[] = [];

  const diagnostics = {
    rttMs: 80,
    correctionPx: 0,
    ballCorrectionPx: 0,
    replayMs: 0,
    replayedTicks: 0,
    snapshotBytes: 0,
    desiredLead: 2,
    actualLead: 0,
    queuedEdges: 0,
    expiredEdges: 0,
    resyncRequested: 0,
    heartbeats: 0,
    predictionDegraded: false,
    receivedSeq: 0,
    terminalSeq: 0,
    timingRejections: 0,
    botTransitions: 0,
    serverDebtMs: 0,
    cosmeticConfirmed: 0,
    cosmeticExpired: 0,
  };
  const storageBase = `cryptball-reconnect:v${PROTOCOL}:${BUILD}:${endpoint}`;
  const saved = (code?: string) => {
    try {
      return sessionStorage.getItem(
        code ? `${storageBase}:room:${code}` : `${storageBase}:${sportId}`,
      );
    } catch {
      return null;
    }
  };
  const save = (token: string | null) => {
    try {
      const keys = [`${storageBase}:${sportId}`];
      if (room) keys.push(`${storageBase}:room:${room.roomId}`);
      for (const key of keys) {
        if (token) sessionStorage.setItem(key, token);
        else sessionStorage.removeItem(key);
      }
    } catch {}
  };
  let history: InputPacket[] = [];
  const events: CryptballEvent[] = [];
  const seen = new Set<string>();
  const setStatus = (s: OnlineStatus) => {
    status = s;
    options.onStatus?.(s);
  };
  const fail = (message: string) => {
    setStatus("interrupted");
    options.onError?.(message);
  };
  function acceptSport(value: unknown) {
    if (!isSportId(value)) throw Error("Unknown room sport");
    const authoritativeSport = value;
    if (discoveringSport) {
      sportId = authoritativeSport;
      discoveringSport = false;
    }
    if (authoritativeSport !== sportId)
      throw Error("Snapshot sport does not match this room");
  }
  function adopt(snapshot: Snapshot) {
    acceptSport(snapshot.sportId);
    const reset =
      snapshot.epoch !== epoch || snapshot.generation !== generation;
    if (!reset && snapshot.snapshotSeq <= lastSnapshotSeq) return;
    if (!reset && snapshot.tick < lastTick) return;
    const started = performance.now();
    const previous = id ? session.observeFor(id) : session.observe();
    const previousRevision = id ? session.getControllerRevision(id) : undefined;
    const target = reset ? snapshot.tick : session.getTick();
    // restore() validates into a detached value before mutating live state.
    session.restore(snapshot.checkpoint);
    authority = session.observeFor(snapshot.participantId);
    authoritativeControllers = snapshot.checkpoint.state.controllers.map(({id,team,playerId})=>({id,team,playerId}));
    remote = snapshot.remote ?? {};
    if (reset) {
      clock.reset();
      scheduler.reset();
      recovery.reset();
    }
    clock.checkpoint(snapshot.tick, snapshot.serverTime, snapshot.phase);
    recovery.satisfy(snapshot.snapshotSeq);
    lastSnapshotSeq = snapshot.snapshotSeq;
    lastSnapshotAt = performance.now();
    diagnostics.serverDebtMs = snapshot.serverDebt;
    diagnostics.receivedSeq = snapshot.receivedSeq;
    diagnostics.terminalSeq = snapshot.terminalSeq;
    diagnostics.timingRejections = snapshot.feedback.rejections;
    diagnostics.botTransitions = snapshot.feedback.botTransitions;
    if (snapshot.feedback) {
      const f = snapshot.feedback;
      scheduler.feedback(
        f.sampleSeq,
        f.sampleCount,
        f.lowMargin,
        f.minimumMargin,
        performance.now(),
      );
    }
    id = snapshot.participantId;
    epoch = snapshot.epoch;
    generation = snapshot.generation;
    lastTick = snapshot.tick;
    const nextRevision = snapshot.checkpoint.state.controllers.find(
      (c) => c.id === id,
    )?.revision;
    if (previousRevision !== nextRevision) {
      localHeld = {};
      neutralLatch = true;
      scheduler.reset();
      history = [];
    }
    if (reset) {
      seq = 0;
      history = [];
      localHeld = {};
      seen.clear();
      cosmetics.reset();
      events.length = 0;
      neutralLatch = true;
    } else {
      history = history.filter(
        (p) => p.seq > snapshot.terminalSeq && p.revision === nextRevision,
      );
    }
    const timeline = replaySchedule(history, snapshot.dispositions);
    let replayHeld = remote[id] ?? {};
    const replayTarget = Math.min(
      target,
      snapshot.tick + NETWORK_LIMITS.replayTicks,
    );
    diagnostics.predictionDegraded = target > replayTarget;
    for (let tick = snapshot.tick + 1; tick <= replayTarget; tick++) {
      const packet = timeline.find((p) => p.tick === tick);
      if (packet)
        replayHeld = {
          ...packet.command,
          origin: {
            epoch: packet.epoch,
            generation: packet.generation,
            participantId: id,
            seq: packet.seq,
          },
        };
      session.stepParticipants({ ...remote, [id]: replayHeld }, { automaticSwitches: !["crypt-dodge", "crypt-guardian"].includes(sportId) });
      replayHeld = heldCommand(replayHeld, sportId);
    }
    localHeld = heldCommand(replayHeld, sportId);
    session.drainEvents();
    const current = session.observeFor(id);
    const oldPlayer = previous.players.find(
        (p) => p.id === current.controlledId,
      ),
      newPlayer = current.players.find((p) => p.id === current.controlledId);
    diagnostics.correctionPx =
      oldPlayer && newPlayer
        ? Math.hypot(oldPlayer.x - newPlayer.x, oldPlayer.y - newPlayer.y) / 256
        : 0;
    diagnostics.ballCorrectionPx = reset || target < snapshot.tick ? 0 :
      Math.hypot(previous.ball.x - current.ball.x,
        previous.ball.y - current.ball.y,
        previous.ball.z - current.ball.z) / 256;
    corrections.correct(
      current,
      performance.now(),
      `${epoch}:${generation}:${id}:${nextRevision}`,
      reset || previousRevision !== nextRevision,
    );
    diagnostics.replayMs = performance.now() - started;
    diagnostics.replayedTicks = Math.max(
      0,
      Math.min(NETWORK_LIMITS.replayTicks, target - snapshot.tick),
    );
    for (const disposition of snapshot.dispositions)
      if (disposition.status === "rejected") cosmetics.reject(disposition.seq);
    snapshot.events.forEach((event, index) => {
      const key = `${epoch}:${event.tick}:${event.counter ?? index}:${event.type}:${event.ballId ?? ""}:${event.actionId ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        if (cosmetics.authority(event, performance.now())) events.push(event);
      }
    });
    while (seen.size > 2048) seen.delete(seen.values().next().value!);
    if (events.length > 256) {
      events.length = 0;
      fail("Match event backlog exceeded its limit. Please rejoin.");
      void room?.leave();
      return;
    }
    diagnostics.cosmeticConfirmed = cosmetics.confirmed;
    diagnostics.cosmeticExpired = cosmetics.expired;
    if (room) save(room.reconnectionToken);
    if (status !== "joined") {
      setStatus("joined");
      room?.send(suspended ? "suspend" : "resume");
    }
  }
  function bind(next: Room) {
    room = next;
    joinedAt = performance.now();
    next.reconnection.minUptime = 0;
    next.onMessage("pong", (v: unknown) => {
      if (clock.pong(v, performance.now(), epoch)) {
        diagnostics.rttMs = clock.rtt;
        if (performance.now() - joinedAt < 2000) scheduler.seed(clock.rtt);
      }
    });
    next.onMessage("lobby", (value: Lobby) => {
      try {
        if (lobby?.shuffle && value.shuffle && value.epoch > lobby.epoch && value.phase === "waiting") discoveringSport = true;
        acceptSport(value.sportId);
      } catch {
        fail("This room uses a different sport. Please rejoin.");
        void next.leave();
        return;
      }
      if (value.build !== BUILD || value.protocol !== PROTOCOL) {
        fail(
          "This room uses a different sport or game version. Please rejoin.",
        );
        void next.leave();
        return;
      }
      const newWaiting =
        value.phase === "waiting" && lobby?.epoch !== value.epoch;
      lobby = value;
      if (newWaiting && options.autoReady !== false) next.send("ready");
      options.onLobby?.(value);
    });
    next.onMessage("snapshot", (bytes: Uint8Array) => {
      try {
        diagnostics.snapshotBytes = bytes.byteLength;
        adopt(decodeSnapshot(bytes));
      } catch {
        fail("The match could not be synchronized. Please rejoin.");
        void next.leave();
      }
    });
    next.onMessage("team-error", (message: string) =>
      options.onTeamError?.(message),
    );
    next.onMessage("interrupted", (message: string) => fail(message));
    next.onError((_code, message) =>
      options.onError?.(message ?? "Connection error"),
    );
    next.onDrop(() => {
      events.length = 0;
      history = [];
      scheduler.reset();
      clock.reset();
      recovery.reset();
      corrections.reset();
      cosmetics.reset();
      localHeld = {};
      neutralLatch = true;
      setStatus("reconnecting");
    });
    next.onReconnect(() => {
      lastTick = -1;
      neutralLatch = true;
      save(next.reconnectionToken);
    });
    next.onLeave(() => {
      if (status !== "left" && status !== "interrupted")
        fail("Match interrupted. Please join again or play Solo.");
    });
    if (options.autoReady !== false) next.send("ready");
  }
  function update() {
    if (!room || status !== "joined" || suspended) return;
    const now = performance.now();
    const interval =
      now - joinedAt < 2000 || recovery.pending || lobby?.phase === "countdown"
        ? 250
        : 1000;
    if (now - lastPing >= interval) {
      lastPing = now;
      room.send("ping", clock.ping(now));
    }
    if (id && now - lastHeartbeat >= 100) {
      lastHeartbeat = now;
      room.send("heartbeat", {
        epoch,
        generation,
        revision: session.getControllerRevision(id) ?? 0,
      });
      diagnostics.heartbeats++;
    }
    const checkpointStale =
      now - lastSnapshotAt > Math.max(500, 2 * clock.rtt + 100);
    if (
      (diagnostics.predictionDegraded && checkpointStale) ||
      history.length >= HISTORY_LIMIT ||
      recovery.pending
    ) {
      const request = recovery.request(
        now,
        clock.rtt,
        epoch,
        generation,
        lastSnapshotSeq,
      );
      if (request) room.send("resync", request);
      diagnostics.resyncRequested = recovery.requested;
    }
  }
  return {
    async connect(kind: "quick" | "private" | "join", code?: string) {
      setStatus("connecting");
      discoveringSport = kind === "join";
      const join = {
        ...(kind === "join" ? {} : { sportId }),
        build: BUILD,
        protocol: PROTOCOL,
        name: options.name?.trim() || "Guest",
        preferredTeamId: options.preferredTeamId,
        private: kind === "private",
        shuffle: options.shuffle === true,
      };
      try {
        let next: Room | undefined;
        const token = saved(kind === "join" ? code : undefined);
        if (
          kind !== "private" &&
          token &&
          (kind !== "join" || token.split(":")[0] === code)
        ) {
          try {
            next = await client.reconnect(token);
          } catch {
            save(null);
          }
        }
        next ??=
          kind === "join"
            ? await client.joinById(code ?? "", join)
            : kind === "private"
              ? await client.create("cryptball", join)
              : await client.joinOrCreate("cryptball", join);
        bind(next);
        return next.roomId;
      } catch (error) {
        fail(
          error instanceof Error
            ? error.message
            : "Could not join. Please retry.",
        );
        throw error;
      }
    },
    update,
    step(command: CommandFrame = {}) {
      update();
      if (
        status !== "joined" ||
        suspended ||
        lobby?.phase !== "playing" ||
        !room ||
        !id
      )
        return;
      if (performance.now() - joinedAt > 1000 && lastTick < 0) return;
      if (neutralLatch) {
        if (
          command.strikeHeld ||
          command.passHeld ||
          command.slide ||
          command.check ||
          command.special ||
          command.strikePressed ||
          command.strikeReleased
        )
          return;
        neutralLatch = false;
        command = {};
      }
      const now = performance.now();
      scheduler.capture(
        quantizeCommand(command),
        now,
        ["cryptcheck", "crypt-dodge", "crypt-guardian"].includes(sportId),
        sportId,
      );
      diagnostics.queuedEdges = scheduler.queuedEdges;
      diagnostics.expiredEdges = scheduler.expired;
      diagnostics.desiredLead = scheduler.lead;
      // The SDK transport exposes no supported browser bufferedAmount accessor. Keep app
      // work bounded and rely on lifecycle/socket close rather than inspecting private ws.
      if (history.length >= HISTORY_LIMIT) {
        diagnostics.predictionDegraded = true;
        return;
      }
      const allocation = scheduler.allocate(clock.tick, lastTick, now);
      if (!allocation) {
        diagnostics.predictionDegraded =
          clock.tick + scheduler.lead > lastTick + NETWORK_LIMITS.replayTicks;
        return;
      }
      const { tick, command: outgoing } = allocation;
      const packet: InputPacket = {
        epoch,
        generation,
        seq: ++seq,
        tick,
        revision: session.getControllerRevision(id) ?? 0,
        command: outgoing,
      };
      history.push(packet);
      room.send("input", packet);
      diagnostics.actualLead = tick - clock.tick;
      diagnostics.predictionDegraded = false;
      const predicted = {
        ...outgoing,
        origin: { epoch, generation, participantId: id, seq: packet.seq },
      };
      for (
        let t = session.getTick() + 1;
        t <= tick && t <= lastTick + NETWORK_LIMITS.replayTicks;
        t++
      ) {
        session.stepParticipants({
          ...remote,
          [id]: t === tick ? predicted : localHeld,
        }, { automaticSwitches: !["crypt-dodge", "crypt-guardian"].includes(sportId) });
        if (t !== tick) localHeld = heldCommand(localHeld, sportId);
      }
      localHeld = heldCommand(outgoing, sportId);
      for (const event of session.drainEvents())
        if (cosmetics.predict(event, id, now))
          events.push({ ...event, predicted: true });
    },
    observe(): Observation {
      let observation = id ? session.observeFor(id) : session.observe();
      // A predicted point must not reveal the next serve before authority confirms it.
      const awaitingTransition =
        authority &&
        (observation.phase !== authority.phase ||
          observation.volley?.rally !== authority.volley?.rally ||
          observation.score[0] !== authority.score[0] ||
          observation.score[1] !== authority.score[1]);
      if (awaitingTransition) observation = structuredClone(authority!);
      observation = corrections.draw(
        observation,
        performance.now(),
        !!awaitingTransition,
      );
      if (authority) {
        observation = confirmedCombatPresentation(observation, authority);
        observation.score = [...authority.score];
        observation.phase = authority.phase;
        observation.phaseTicks = authority.phaseTicks;
        observation.winner = authority.winner;
        observation.remainingTicks = authority.remainingTicks;
        observation.overtime = authority.overtime;
        observation.stats = { ...authority.stats };
      }
      return observation;
    },
    /** Detached authority only: music must never consume replayed prediction.
     * Lobby packets may lead checkpoints during rematch/Shuffle. Wait for the
     * matching epoch and sport rather than exposing the previous match. */
    musicObservation() {
      if (!authority || !room || !lobby || lobby.epoch !== epoch ||
        lobby.sportId !== authority.sportId ||
        (lobby.phase !== "playing" && lobby.phase !== "results")) return null;
      const state = structuredClone(authority);
      const controlledTeam = state.players.find(player => player.id === state.controlledId)?.team ?? null;
      return { state, stamp: { matchId: `${endpoint}:${room.roomId}:${epoch}`, epoch, generation, snapshotSeq: lastSnapshotSeq }, controlledTeam };
    },
    rawObserve(): Observation {
      return id ? session.observeFor(id) : session.observe();
    },
    drainEvents() {
      return events.splice(0);
    },
    ready() {
      if (lobby?.phase === "waiting") room?.send("ready");
    },
    selectTeam(teamId: TeamId) {
      if (lobby?.phase === "waiting") room?.send("team", { teamId });
    },
    get controllerOwners() { return authoritativeControllers.map(c=>({...c})); },
    get participantId() {
      return room?.sessionId ?? id;
    },
    start() {
      room?.send("start");
    },
    rematch() {
      history = [];
      room?.send("rematch");
    },
    suspend() {
      suspended = true;
      scheduler.reset();
      recovery.reset();
      corrections.reset();
      cosmetics.reset();
      localHeld = {};
      neutralLatch = true;
      history = [];
      if (status === "joined") room?.send("suspend");
    },
    resume() {
      suspended = false;
      scheduler.reset();
      clock.reset();
      recovery.reset();
      corrections.reset();
      cosmetics.reset();
      localHeld = {};
      neutralLatch = true;
      history = [];
      if (status === "joined") room?.send(suspended ? "suspend" : "resume");
    },
    disconnectForReload() {
      history = [];
      neutralLatch = true;
      if (room) {
        room.reconnection.enabled = false;
        room.connection.close(4010, "reload");
      }
    },
    async leave() {
      setStatus("left");
      scheduler.reset();
      recovery.reset();
      corrections.reset();
      cosmetics.reset();
      save(null);
      history = [];
      if (room) await room.leave();
      room = undefined;
    },
    get diagnostics() {
      return { ...diagnostics };
    },
    get lobby() {
      return lobby;
    },
    get status() {
      return status;
    },
  };
}
export type OnlineSession = ReturnType<typeof createOnlineSession>;
