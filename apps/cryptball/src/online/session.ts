import { multiplayerEndpoint, reconnectAfterReload } from "./connection";
import type { MusicStamp } from "../audio-music-policy";
import { Client, type Room } from "@colyseus/sdk";
import { LateLaunchPresentation } from "./late-launch";
import { CoveredViewBuffer } from "./covered-view-buffer";
import { NetworkClock } from "./clock";
import { InputScheduler, replaySchedule } from "./input-scheduler";
import { Recovery } from "./recovery";
import { confirmedCombatPresentation, DodgeFlightPresentation } from "./confirmed-combat";
import { CosmeticLedger } from "./cosmetics";
import {
  createCryptballSession,
  supportsPassControlTransfer,
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
  groupKey?: string;
  autoReady?: boolean;
  name?: string;
  shuffle?: boolean;
  sportId?: SportId;
  preferredTeamId?: TeamId;
  onTeamError?: (message: string) => void;
  endpoint?: string;
  onStatus?: (status: OnlineStatus) => void;
  onPerformance?: (event: { kind: string; at: number; fields: Record<string, string | number | boolean | null> }) => void;
  onLobby?: (lobby: Lobby) => void;
  onError?: (message: string) => void;
  onCourtLeave?: (code: number) => void;
}
export function createOnlineSession(options: OnlineOptions = {}) {
  const endpoint = multiplayerEndpoint(options.endpoint);
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
    playingCheckpoint = false,
    neutralLatch = true,
    joinedAt = 0,
    lastPing = -Infinity,
    lastHeartbeat = -Infinity,
    lastSnapshotSeq = -1,
    lastSnapshotAt = 0,
    lastFeedbackSampleSeq = -1;
  const coveredView = new CoveredViewBuffer();
  let authorityCovered = false;
  let observer = false;
  const clock = new NetworkClock();
  const scheduler = new InputScheduler();
  const recovery = new Recovery();
  let presentationCorrection: { before: Observation; after: Observation; reset: boolean; key: string } | null = null;
  const cosmetics = new CosmeticLedger();
  let previousPrediction: Observation | null = null;
  let lastPresentedState: Observation | null = null;
  const pendingTransitions = new WeakSet<Observation>();
  const dodgeFlights = new DodgeFlightPresentation();
  const lateLaunch = new LateLaunchPresentation();
  let lastPresentedTick: number | null = null;
  let heldPoint: Observation | null = null;
  let rejectedPointFade: { started: number; scene: Observation } | null = null;
  function resetPresented() {
    lastPresentedState = null;
    heldPoint = null;
    rejectedPointFade = null;
    dodgeFlights.reset();
    lateLaunch.reset();
    lastPresentedTick = null;
  }
  let remote: Record<string, CommandFrame> = {};
  let localHeld: CommandFrame = {};
  let lastCheckpointPhase: Snapshot["phase"] | undefined;
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
    rejectedExpired: 0,
    rejectedFuture: 0,
    rejectedCancelled: 0,
    rejectedSequenceGap: 0,
    rejectedCapacity: 0,
    rejectedRevision: 0,
    botTransitions: 0,
    serverDebtMs: 0,
    cosmeticConfirmed: 0,
    cosmeticExpired: 0,
    capturedInputs: 0,
    predictedSteps: 0,
    allocatedInputs: 0,
    allocationSkips: 0,
    historySkips: 0,
    lastAppliedSeq: 0,
    lastAppliedTick: 0,
    lastAppliedAt: 0,
  };
  const storageBase = `cryptball-reconnect:v${PROTOCOL}:${BUILD}:${endpoint}` +
    (options.groupKey ? `:friends:${options.groupKey}` : "");
  const saved = (code?: string) => {
    try {
      return sessionStorage.getItem(
        code ? `${storageBase}:room:${code}` : `${storageBase}:${sportId}`,
      );
    } catch {
      return null;
    }
  };
  let persisted: { token: string; sport: typeof sportId; roomId?: string } | undefined;
  const save = (token: string | null, roomId = room?.roomId) => {
    if (token && persisted?.token === token && persisted.sport === sportId && persisted.roomId === roomId) return;
    persisted = undefined;
    try {
      const keys = options.groupKey ? [] : [`${storageBase}:${sportId}`];
      if (roomId) keys.push(`${storageBase}:room:${roomId}`);
      for (const key of keys) {
        if (token) sessionStorage.setItem(key, token);
        else sessionStorage.removeItem(key);
      }
      if (token) persisted = { token, sport: sportId, roomId };
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
  function participantObservation(participant: string): Observation {
    if (session.getControllerRevision(participant) !== undefined) return session.observeFor(participant);
    const view = session.observe(); view.controlledId = ""; return view;
  }
  function adopt(snapshot: Snapshot) {
    observer = snapshot.observer === true;
    acceptSport(snapshot.sportId);
    const hadAuthority = epoch > 0;
    const reset =
      snapshot.epoch !== epoch || snapshot.generation !== generation || snapshot.participantId !== id;
    const controlCheckpoint = reset || snapshot.phase !== lastCheckpointPhase;
    if (!reset && snapshot.snapshotSeq <= lastSnapshotSeq) return;
    if (!reset && snapshot.tick < lastTick) return;
    previousPrediction = null;
    const started = performance.now();
    const launchCandidate = !reset && !observer && lateLaunch.candidate(lastPresentedState);
    const launchSamples: ReturnType<typeof session.sampleBallPose>[] = [];
    const previous = id ? participantObservation(id) : session.observe();
    const previousRevision = id ? session.getControllerRevision(id) : undefined;
    const target = reset || observer ? snapshot.tick : session.getTick();
    // restore() validates into a detached value before mutating live state.
    const restoreStarted = performance.now();
    session.restore(snapshot.checkpoint);
    if (launchCandidate) launchSamples.push(session.sampleBallPose());
    options.onPerformance?.({ kind: "snapshot-restore", at: performance.now(), fields: { durationMs: performance.now() - restoreStarted, snapshotSeq: snapshot.snapshotSeq } });
    authority = participantObservation(snapshot.participantId);
    const coveredController = snapshot.checkpoint.state.controllers.find(c => c.id === snapshot.participantId);
    authorityCovered = !coveredController?.active;
    if (suspended || authorityCovered)
      coveredView.ingest(authority, performance.now(), `${snapshot.epoch}:${snapshot.generation}:${coveredController?.revision}:${coveredController?.active}`);
    else coveredView.reset();
    authoritativeControllers = snapshot.checkpoint.state.controllers.map(({id,team,playerId})=>({id,team,playerId}));
    remote = snapshot.remote ?? {};
    if (reset) {
      clock.resetTimeline();
      scheduler.reset();
      if (hadAuthority) scheduler.seed(diagnostics.rttMs);
      recovery.reset();
    }
    clock.checkpoint(snapshot.tick, snapshot.serverTime, snapshot.phase);
    recovery.satisfy(snapshot.snapshotSeq);
    playingCheckpoint = snapshot.phase === "playing";
    lastSnapshotSeq = snapshot.snapshotSeq;
    lastSnapshotAt = performance.now();
    diagnostics.serverDebtMs = snapshot.serverDebt;
    diagnostics.receivedSeq = snapshot.receivedSeq;
    diagnostics.terminalSeq = snapshot.terminalSeq;
    diagnostics.timingRejections = snapshot.feedback.rejections;
    diagnostics.rejectedExpired = snapshot.feedback.rejectionReasons.expired;
    diagnostics.rejectedFuture = snapshot.feedback.rejectionReasons.future;
    diagnostics.rejectedCancelled = snapshot.feedback.rejectionReasons.cancelled;
    diagnostics.rejectedSequenceGap = snapshot.feedback.rejectionReasons["sequence-gap"];
    diagnostics.rejectedCapacity = snapshot.feedback.rejectionReasons.capacity;
    diagnostics.rejectedRevision = snapshot.feedback.rejectionReasons.revision;
    if (reset || snapshot.feedback.sampleSeq !== lastFeedbackSampleSeq) {
      lastFeedbackSampleSeq = snapshot.feedback.sampleSeq;
      options.onPerformance?.({ kind: "input-feedback", at: performance.now(), fields: {
        sampleSeq: lastFeedbackSampleSeq, receivedSeq: snapshot.receivedSeq,
        rejectedExpired: diagnostics.rejectedExpired, rejectedFuture: diagnostics.rejectedFuture,
        rejectedCancelled: diagnostics.rejectedCancelled, rejectedSequenceGap: diagnostics.rejectedSequenceGap,
        rejectedCapacity: diagnostics.rejectedCapacity, rejectedRevision: diagnostics.rejectedRevision,
      } });
    }
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
    // A checkpoint may precede our queued predicted switch. Only a genuinely
    // new, unmatched authoritative ownership revision invalidates local intent.
    const rejectedSequences = new Set(snapshot.dispositions
      .filter(disposition => disposition.status === "rejected").map(disposition => disposition.seq));
    const restoredTransfer = session.getControllerTransfer(id);
    const supportsPassTransfer = supportsPassControlTransfer(sportId);
    let replayRevision = nextRevision === undefined ? undefined : nextRevision + (restoredTransfer?.pending ? 1 : 0);
    for (const packet of history)
      if (packet.seq > snapshot.terminalSeq && !rejectedSequences.has(packet.seq) &&
          (packet.command.switch || (supportsPassTransfer && restoredTransfer?.canSwitch && packet.command.pass)) &&
          packet.revision === replayRevision)
        replayRevision = replayRevision! + 1;
    const pendingOwnership = replayRevision === previousRevision;
    const ownershipReset = (previousRevision === nextRevision && previous.controlledId !== authority.controlledId) ||
      (previousRevision !== nextRevision && !pendingOwnership);
    if (reset) resetPresented();
    else if (ownershipReset) dodgeFlights.reset();
    if (ownershipReset) {
      localHeld = {};
      neutralLatch = true;
      scheduler.reset();
      if (hadAuthority) scheduler.seed(diagnostics.rttMs);
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
        (p) => p.seq > snapshot.terminalSeq && p.revision >= (nextRevision ?? 0),
      );
    }
    // Index once, preserving the earliest sequence at any colliding requested
    // tick until authority supplies its ordered execution assignment.
    const timeline = new Map<number, InputPacket>();
    for (const packet of replaySchedule(history, snapshot.dispositions))
      if (!timeline.has(packet.tick)) timeline.set(packet.tick, packet);
    let replayHeld = remote[id] ?? {};
    const replayTarget = Math.min(
      target,
      snapshot.tick + NETWORK_LIMITS.replayTicks,
    );
    diagnostics.predictionDegraded = target > replayTarget;
    const replayStarted = performance.now();
    for (let tick = snapshot.tick + 1; tick <= replayTarget; tick++) {
      const packet = timeline.get(tick);
      if (packet && packet.revision === session.getControllerRevision(id))
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
      if (launchCandidate) launchSamples.push(session.sampleBallPose());
      replayHeld = heldCommand(replayHeld, sportId);
    }
    options.onPerformance?.({ kind: "snapshot-replay", at: performance.now(), fields: { durationMs: performance.now() - replayStarted, snapshotSeq: snapshot.snapshotSeq, fromTick: snapshot.tick, toTick: session.getTick(), history: history.length } });
    localHeld = heldCommand(replayHeld, sportId);
    session.drainEvents();
    const current = participantObservation(id);
    if (lateLaunch.offer(lastPresentedState, launchSamples, performance.now()))
      rejectedPointFade = { started: performance.now(), scene: current };
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
    const correctionKey = `${epoch}:${generation}:${id}`;
    const pendingCorrection = presentationCorrection;
    const canCompose = pendingCorrection?.key === correctionKey &&
      pendingCorrection.after.tick === current.tick;
    presentationCorrection = {
      before: canCompose ? pendingCorrection!.before : confirmedObservation(previous),
      after: confirmedObservation(current),
      key: correctionKey,
      reset: reset || ownershipReset || target !== session.getTick() ||
        (pendingCorrection !== null && (!canCompose || pendingCorrection.reset)),
    };
    diagnostics.replayMs = performance.now() - started;
    options.onPerformance?.({ kind: "snapshot-reconcile", at: performance.now(), fields: { durationMs: diagnostics.replayMs, snapshotSeq: snapshot.snapshotSeq, fromTick: snapshot.tick, toTick: session.getTick(), history: history.length, epoch, generation, authorityRevision: nextRevision ?? -1, controlledId: authority.controlledId, ownershipReset } });
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
    if (observer && events.length > 256) events.splice(0, events.length - 256);
    if (events.length > 256) {
      events.length = 0;
      fail("Match event backlog exceeded its limit. Please rejoin.");
      void room?.leave();
      return;
    }
    diagnostics.cosmeticConfirmed = cosmetics.confirmed;
    diagnostics.cosmeticExpired = cosmetics.expired;
    if (room) save(room.reconnectionToken);
    const rejoined = status !== "joined";
    if (rejoined) setStatus("joined");
    lastCheckpointPhase = snapshot.phase;
    if (!observer && (rejoined || controlCheckpoint))
      room?.send(suspended ? "suspend" : "resume");
  }
  function bind(next: Room) {
    room = next;
    joinedAt = performance.now();
    next.reconnection.minUptime = 0;
    next.onMessage("pong", (v: unknown) => {
      if (clock.pong(v, performance.now(), epoch)) {
        diagnostics.rttMs = clock.rtt;
        options.onPerformance?.({ kind: "rtt", at: performance.now(), fields: { rttMs: clock.rtt } });
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
        const decodeStarted = performance.now();
        const snapshot = decodeSnapshot(bytes);
        options.onPerformance?.({ kind: "snapshot-decode", at: performance.now(), fields: { durationMs: performance.now() - decodeStarted, bytes: bytes.byteLength, snapshotSeq: snapshot.snapshotSeq } });
        adopt(snapshot);
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
      playingCheckpoint = false;
      recovery.reset();
      presentationCorrection = null;
      previousPrediction = null;
      cosmetics.reset();
      resetPresented();
      localHeld = {};
      neutralLatch = true;
      setStatus("reconnecting");
    });
    next.onReconnect(() => {
      lastTick = -1;
      neutralLatch = true;
      save(next.reconnectionToken);
    });
    next.onLeave((code) => {
      if (options.onCourtLeave && status !== "left") { setStatus("left"); options.onCourtLeave(code); return; }
      if (status !== "left" && status !== "interrupted")
        fail("Match interrupted. Please join again or play Solo.");
    });
    if (options.autoReady !== false) next.send("ready");
  }
  // Serve state and controller switches can change within one rally. They do
  // not invalidate a submitted court pose while a point is unconfirmed.
  function sameScoringPhase(a: Observation, b: Observation): boolean {
    return a.sportId === b.sportId && a.phase === b.phase &&
      a.volley?.rally === b.volley?.rally && a.score[0] === b.score[0] && a.score[1] === b.score[1];
  }
  function confirmedReadyStart(view: Observation): boolean {
    return !!authority &&
      (view.sportId === "cryptkick" || view.sportId === "rift-volley") &&
      view.sportId === authority.sportId && authority.phase === "ready" &&
      authority.phaseTicks > 0 && view.phase === "play" &&
      view.tick >= authority.tick + authority.phaseTicks &&
      view.score[0] === authority.score[0] && view.score[1] === authority.score[1] &&
      view.volley?.rally === authority.volley?.rally;
  }
  function confirmedObservation(observation: Observation): Observation {
      // A confirmed ready countdown has a deterministic end tick. Render play
      // coherently at that tick instead of hiding movement until its packet.
      const scheduledStart = confirmedReadyStart(observation);
      // Points and resets still require authority, including after early play.
      const awaitingTransition = authority && !scheduledStart && !sameScoringPhase(observation, authority);
      if (awaitingTransition) observation = structuredClone(authority!);
      if (authority) {
        observation = confirmedCombatPresentation(observation, authority);
        observation.score = [...authority.score];
        if (!scheduledStart) {
          observation.phase = authority.phase;
          observation.phaseTicks = authority.phaseTicks;
        }
        observation.winner = authority.winner;
        observation.remainingTicks = authority.remainingTicks;
        observation.overtime = authority.overtime;
        observation.stats = { ...authority.stats };
      }
      if (awaitingTransition) pendingTransitions.add(observation);
      return observation;
  }
  function update() {
    if (!room || status !== "joined" || suspended || observer) return;
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
    async waitForCourtReady(timeoutMs = 10000) {
      const deadline = performance.now() + timeoutMs;
      while (!lobby || status !== "joined" || lobby.epoch !== epoch ||
        observer === lobby.seats.some(seat => seat.id === room?.sessionId)) {
        if (status === "left" || status === "interrupted")
          throw Error("The destination court disconnected. Please choose again.");
        if (performance.now() >= deadline)
          throw Error("The destination court did not synchronize. Please choose again.");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    },
    async reconnectCourt(code: string) {
      const token = saved(code);
      if (!token) return false;
      discoveringSport = true;
      try {
        bind(await reconnectAfterReload(client, token));
        return true;
      } catch {
        save(null, code);
        return false;
      }
    },
    async connectReservation(reservation: Parameters<Client["consumeSeatReservation"]>[0]) {
      setStatus("connecting");
      discoveringSport = true;
      const next = await client.consumeSeatReservation(reservation);
      bind(next);
      return next.roomId;
    },
    playNext() { room?.send("play-next"); },
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
        observer ||
        suspended ||
        lobby?.phase !== "playing" ||
        lobby.epoch !== epoch ||
        !playingCheckpoint ||
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
        ) {
          // A safety cancellation must drain even while the physical action is held.
          if (!scheduler.pendingCancellation) return;
        } else neutralLatch = false;
        command = {};
      }
      const now = performance.now();
      diagnostics.capturedInputs++;
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
        diagnostics.historySkips++;
        diagnostics.predictionDegraded = true;
        return;
      }
      const allocation = scheduler.allocate(clock.fractionalTick, lastTick, now, session.getTick());
      if (!allocation) {
        diagnostics.allocationSkips++;
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
      diagnostics.allocatedInputs++;
      options.onPerformance?.({ kind: "input-allocated", at: performance.now(), fields: { seq: packet.seq, tick, epoch, generation, revision: packet.revision, queuedEdges: scheduler.queuedEdges } });
      history.push(packet);
      room.send("input", packet);
      diagnostics.actualLead = tick - clock.tick;
      diagnostics.predictionDegraded = false;
      previousPrediction = null;
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
        if (t === tick - 1) previousPrediction = confirmedObservation(participantObservation(id));
        diagnostics.predictedSteps++;
        if (t === tick) {
          diagnostics.lastAppliedSeq = packet.seq;
          diagnostics.lastAppliedTick = tick;
          diagnostics.lastAppliedAt = performance.now();
          options.onPerformance?.({ kind: "input-applied", at: diagnostics.lastAppliedAt, fields: { seq: packet.seq, tick } });
        }
        if (t !== tick) localHeld = heldCommand(localHeld, sportId);
      }
      localHeld = heldCommand(outgoing, sportId);
      for (const event of session.drainEvents())
        if (cosmetics.predict(event, id, now))
          events.push({ ...event, predicted: true });
    },
    observe(): Observation {
      return confirmedObservation(id ? participantObservation(id) : session.observe());
    },
    /** Final render boundary: retain the detached submitted view after interpolation. */
    presentFrame(state: Observation, source: Observation = state, renderTick = state.tick): Observation {
      if (pendingTransitions.has(source)) {
        const held = lastPresentedState;
        const scheduledStart = held && confirmedReadyStart(held);
        if (held && authority && (sameScoringPhase(held, authority) || scheduledStart) && held.tick >= authority.tick) {
          // Retain animation-driving fields as well as interpolated positions.
          // Clone only while holding; ordinary frames retain their detached view.
          heldPoint = held;
          rejectedPointFade = null;
          const frozen = confirmedCombatPresentation(structuredClone(held), authority);
          return { ...frozen, controlledId: state.controlledId, score: [...state.score],
            phase: scheduledStart ? held.phase : state.phase,
            phaseTicks: scheduledStart ? held.phaseTicks : state.phaseTicks, winner: state.winner,
            remainingTicks: state.remainingTicks, overtime: state.overtime, stats: { ...state.stats } };
        }
        lastPresentedState = null;
      }
      if (rejectedPointFade && (state.possessionId || state.volley?.serving || !sameScoringPhase(rejectedPointFade.scene, state))) rejectedPointFade = null;
      if (heldPoint) {
        // A rejected point can hand the free ball back at a distant corrected
        // position. Fade its appearance briefly; never draw a false trajectory.
        if (sameScoringPhase(heldPoint, state) && state.phase === "play" &&
            !state.possessionId && !state.volley?.serving && !heldPoint.possessionId && !state.dodge && !state.guardian &&
            Math.hypot(state.ball.x - heldPoint.ball.x, state.ball.y - heldPoint.ball.y,
              state.ball.z - heldPoint.ball.z) > 24 * 256)
          rejectedPointFade = { started: performance.now(), scene: state };
        heldPoint = null;
      }
      const launch = lateLaunch.draw(state, performance.now());
      state = launch.state;
      if (launch.fade && state.phase === "play" && !state.possessionId && !state.volley?.serving)
        rejectedPointFade = { started: performance.now(), scene: state };
      state = dodgeFlights.draw(state, authority ?? undefined);
      if (lastPresentedState && state.tick < lastPresentedState.tick)
        state = { ...state, tick: lastPresentedState.tick };
      lastPresentedTick = Math.max(lastPresentedTick ?? renderTick, renderTick);
      lastPresentedState = state;
      return state;
    },
    get presentationTick() { return lastPresentedTick; },
    ballCorrectionAlpha(reducedMotion = false) {
      if (!rejectedPointFade) return 1;
      const progress = (performance.now() - rejectedPointFade.started) / 120;
      if (reducedMotion || progress >= 1) { rejectedPointFade = null; return 1; }
      return 0.25 + 0.75 * Math.max(0, progress);
    },
    coveredObservation(now: number) {
      return suspended || authorityCovered ? coveredView.draw(now) : null;
    },
    takePreviousPrediction() {
      const previous = previousPrediction;
      previousPrediction = null;
      return previous;
    },
    /** Detached authority only: music must never consume replayed prediction.
     * Lobby packets may lead checkpoints during rematch/Shuffle. Wait for the
     * matching epoch and sport rather than exposing the previous match. */
    musicObservation(previous?: MusicStamp) {
      if (!authority || !room || !lobby || lobby.epoch !== epoch ||
        lobby.sportId !== authority.sportId ||
        (lobby.phase !== "playing" && lobby.phase !== "results")) return null;
      const matchId = `${endpoint}:${room.roomId}:${epoch}`;
      if (previous?.matchId === matchId && previous.epoch === epoch &&
        previous.generation === generation && previous.snapshotSeq === lastSnapshotSeq) return null;
      const state = structuredClone(authority);
      const controlledTeam = state.players.find(player => player.id === state.controlledId)?.team ?? null;
      return { state, stamp: { matchId, epoch, generation, snapshotSeq: lastSnapshotSeq }, controlledTeam };
    },
    /** Consumed once at the render boundary by the sole presentation owner. */
    takePresentationCorrection() {
      const correction = presentationCorrection;
      presentationCorrection = null;
      return correction;
    },
    get predictionRate() { return scheduler.predictionRate(clock.fractionalTick); },
    get simulationTick() { return session.getTick(); },
    rawObserve(): Observation {
      return id ? participantObservation(id) : session.observe();
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
    get spectator() { return observer || !!lobby && !lobby.seats.some(seat => seat.id === room?.sessionId); },
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
    get suspended() { return suspended; },
    releaseInput() {
      scheduler.cancelPendingInput();
      localHeld = {};
      neutralLatch = true;
    },
    suspend() {
      if (suspended) return;
      coveredView.reset();
      suspended = true;
      playingCheckpoint = false;
      scheduler.reset();
      recovery.reset();
      presentationCorrection = null;
      previousPrediction = null;
      cosmetics.reset();
      resetPresented();
      localHeld = {};
      neutralLatch = true;
      history = [];
      if (!observer && status === "joined") room?.send("suspend");
    },
    resume() {
      if (!suspended) return;
      coveredView.reset();
      suspended = false;
      scheduler.reset();
      clock.reset();
      playingCheckpoint = false;
      recovery.reset();
      presentationCorrection = null;
      previousPrediction = null;
      cosmetics.reset();
      resetPresented();
      localHeld = {};
      neutralLatch = true;
      history = [];
      if (!observer && status === "joined") room?.send(suspended ? "suspend" : "resume");
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
      presentationCorrection = null;
      previousPrediction = null;
      cosmetics.reset();
      save(null);
      history = [];
      if (room) await room.leave();
      room = undefined;
    },
    get diagnostics() {
      return { ...diagnostics, ...coveredView.diagnostics };
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
