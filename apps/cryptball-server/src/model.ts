import {
  ROSTER,
  createCryptballSession,
  supportsPassControlTransfer,
  isTeamId,
  TEAM_IDS,
  type TeamSelection,
} from "@onepage/cryptball/sim";
import type {
  CommandFrame,
  CryptballSession,
  SportId,
} from "@onepage/cryptball/sim";
import {
  BUILD,
  NETWORK_LIMITS,
  emptyRejectionReasons,
  type InputDisposition,
  type InputFeedback,
  type Heartbeat,
  PROTOCOL,
  heldCommand,
  resolveSportId,
  validateInput,
  type InputPacket,
  type Lobby,
  type RoomPhase,
  type Seat,
  type Snapshot,
} from "@onepage/cryptball/protocol";
interface Peer extends Seat {
  safetyCancel: boolean;
  queue: (InputPacket & { executionTick: number })[];
  ledger: InputDisposition[];
  lastRequested: number;
  lastControl: number;
  margins: number[];
  feedback: InputFeedback;
  ack: number;
  lastSeq: number;
  lastInput: number;
  held: CommandFrame;
  suspended: boolean;
  rematch: boolean;
  window: number;
  received: number;
  effective: CommandFrame;
}
/** One shared authoritative step per tick. Client timestamps never advance the clock. */
export class MatchAuthority {
  session: CryptballSession;
  peers = new Map<string, Peer>();
  phase: RoomPhase = "waiting";
  epoch = 1;
  countdown = 0;
  lobbyRevision = 0;
  tick = 0;
  private resultsAt = 0;
  private snapshotSeq = 0;
  private claimedSides = new Set<number>();
  /** Stable for a room's retries; distinct rooms select distinct encounters. */
  private readonly encounterSeed: number;
  constructor(
    readonly roomId: string,
    readonly privateRoom = false,
    public sportId: SportId = "cryptball",
    readonly shuffle = false,
  ) {
    resolveSportId(sportId);
    let seed = 2166136261;
    for (const char of roomId) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
    this.encounterSeed = seed >>> 0 || 1;
    this.session = createCryptballSession({ sportId, teamIds: [TEAM_IDS[this.encounterSeed%6]!, TEAM_IDS[(this.encounterSeed%6+1+(this.encounterSeed>>>8)%5)%6]!], seed: sportId === "crypt-guardian" ? this.encounterSeed : undefined });
  }
  get seatOrder() {
    return this.sportId === "crypt-guardian" ? [0, 1] : ROSTER.seatOrder;
  }
  get capacity() {
    return this.seatOrder.length;
  }
  get teamIds(): TeamSelection {
    return this.session.observe().teamIds;
  }
  selectTeam(id: string, teamId: unknown): boolean {
    this.lobbyRevision++;
    const peer = this.peers.get(id);
    if (this.phase !== "waiting" || !peer?.connected || !isTeamId(teamId))
      return false;
    const ids = [...this.teamIds] as [typeof teamId, typeof teamId];
    if (ids[1 - peer.team] === teamId) return false;
    if (ids[peer.team] === teamId) return true;
    ids[peer.team] = teamId;
    const checkpoint = this.session.capture();
    checkpoint.state.teamIds = ids;
    this.session.restore(checkpoint);
    for (const p of this.peers.values()) p.ready = false;
    return true;
  }
  join(id: string, name: string, preferredTeamId?: unknown) {
    this.lobbyRevision++;
    if (preferredTeamId !== undefined && !isTeamId(preferredTeamId))
      throw Error("Unknown team.");
    if (this.phase !== "waiting" || this.peers.size >= this.capacity)
      throw Error("Room unavailable");
    const peer: Peer = {
      id,
      name: name.slice(0, 24),
      team: 0,
      playerId: `player-${this.seatOrder.find((slot) => ![...this.peers.values()].some((p) => p.playerId === `player-${slot}`))}`,
      role: "field",
      connected: true,
      ready: false,
      active: false,
      generation: 1,
      safetyCancel: false,
      queue: [],
      ledger: [],
      lastRequested: -1,
      lastControl: this.tick,
      margins: [],
      feedback: {
        sampleSeq: 0,
        sampleCount: 0,
        minimumMargin: 0,
        lowMargin: 0,
        lateReceipts: 0,
        rejections: 0,
        rejectionReasons: emptyRejectionReasons(),
        emptySlots: 0,
        neutralizations: 0,
        botTransitions: 0,
      },
      ack: 0,
      lastSeq: 0,
      lastInput: this.tick,
      held: {},
      suspended: false,
      rematch: false,
      window: this.tick,
      received: 0,
      effective: {},
    };
    this.peers.set(id, peer);
    this.assign();
    if (isTeamId(preferredTeamId) && !this.claimedSides.has(peer.team)) {
      const opposingSide = peer.team === 0 ? 1 : 0;
      if (
        preferredTeamId === this.teamIds[opposingSide] &&
        !this.claimedSides.has(opposingSide)
      ) {
        // An unclaimed default must not consume the first player's preference.
        const checkpoint = this.session.capture();
        const ids = [...this.teamIds] as [
          typeof preferredTeamId,
          typeof preferredTeamId,
        ];
        ids[peer.team] = preferredTeamId;
        ids[opposingSide] = TEAM_IDS.find((team) => team !== preferredTeamId)!;
        checkpoint.state.teamIds = ids;
        this.session.restore(checkpoint);
        for (const p of this.peers.values()) p.ready = false;
      } else {
        const selected =
          preferredTeamId === this.teamIds[opposingSide]
            ? TEAM_IDS.find((team) => team !== this.teamIds[opposingSide])!
            : preferredTeamId;
        this.selectTeam(id, selected);
      }
    }
    this.claimedSides.add(peer.team);
    return peer;
  }
  private assign() {
    for (const p of this.peers.values()) {
      const slot = Number(p.playerId.slice(7));
      p.team = slot < ROSTER.teamSize ? 0 : 1;
      p.role = ROSTER.roles[slot % ROSTER.teamSize];
    }
    this.session.setParticipants(
      [...this.peers.values()].map((p) => ({
        id: p.id,
        team: p.team,
        playerId: p.playerId,
        active: p.connected && !p.suspended,
      })),
    );
  }
  ready(id: string) {
    this.lobbyRevision++;
    const p = this.peers.get(id);
    if (p) p.ready = true;
    if (this.phase === "waiting" && this.readyCount === this.capacity)
      this.start();
  }
  get readyCount() {
    return [...this.peers.values()].filter((p) => p.connected && p.ready)
      .length;
  }
  start() {
    this.lobbyRevision++;
    if (
      this.phase !== "waiting" ||
      this.readyCount < (this.sportId === "crypt-guardian" ? 1 : 2) ||
      this.readyCount !== this.peers.size
    )
      return false;
    this.phase = "countdown";
    this.countdown = 180;
    return true;
  }
  drop(id: string) {
    this.lobbyRevision++;
    const p = this.peers.get(id);
    if (!p) return;
    p.connected = false;
    this.suspend(id, true);
    if (this.phase === "countdown") {
      this.phase = "waiting";
      this.countdown = 0;
    }
  }
  remove(id: string) {
    this.lobbyRevision++;
    this.peers.delete(id);
    if (this.phase === "countdown") {
      this.phase = "waiting";
      this.countdown = 0;
    }
    if (this.phase === "waiting") this.assign();
    else this.session.setParticipantActive(id, false);
  }
  reconnect(id: string) {
    this.lobbyRevision++;
    const p = this.peers.get(id);
    if (!p) throw Error("Seat expired");
    p.connected = true;
    p.generation++;
    p.lastSeq = p.ack = 0;
    p.lastRequested = -1;
    p.ledger = [];
    p.margins = [];
    p.safetyCancel = false;
    p.queue = [];
    p.held = {};
    p.effective = {};
    p.lastInput = p.lastControl = this.tick;
    p.feedback = {
      sampleSeq: 0,
      sampleCount: 0,
      minimumMargin: 0,
      lowMargin: 0,
      lateReceipts: 0,
      rejections: 0,
      rejectionReasons: emptyRejectionReasons(),
      emptySlots: 0,
      neutralizations: 0,
      botTransitions: 0,
    };
    p.suspended = true;
    p.active = false;
    return p;
  }
  suspend(id: string, suspended: boolean) {
    const p = this.peers.get(id);
    if (!p) return;
    if (p.suspended === suspended && p.active === (!suspended && p.connected))
      return;
    this.lobbyRevision++;
    p.suspended = suspended;
    p.active = !suspended && p.connected;
    for (const q of p.queue) this.terminal(p, q.seq, "inactive");
    p.safetyCancel = false;
    p.queue = [];
    p.held = {};
    p.effective = {};
    p.lastInput = p.lastControl = this.tick;
    this.session.setParticipantActive(id, p.active);
  }
  private terminal(p: Peer, seq: number, reason?: InputDisposition["reason"]) {
    const d = p.ledger.find((d) => d.seq === seq);
    if (d) {
      d.status = reason ? "rejected" : "executed";
      if (reason) {
        d.reason = reason;
        p.feedback.rejections++;
        p.feedback.rejectionReasons[reason]++;
      }
    }
    while (p.ledger.length && p.ledger[0].status !== "accepted")
      p.ack = p.ledger.shift()!.seq;
  }
  heartbeat(id: string, value: unknown) {
    const p = this.peers.get(id),
      v = value as Heartbeat;
    if (
      !p ||
      !v ||
      !p.connected ||
      p.suspended ||
      v.epoch !== this.epoch ||
      v.generation !== p.generation ||
      v.revision !== this.session.getControllerRevision(id)
    )
      return false;
    // Bound heartbeat liveness independently of command admission.
    if (this.tick - p.lastInput < 6) return false;
    p.lastInput = this.tick;
    return true;
  }
  receive(id: string, value: unknown) {
    const p = this.peers.get(id),
      v = validateInput(value);
    if (!p || !v || !p.connected || p.suspended || this.phase !== "playing")
      return false;
    if (this.tick - p.window >= 60) {
      p.window = this.tick;
      p.received = 0;
    }
    if (++p.received > 90) return false;
    const currentRevision = this.session.getControllerRevision(id);
    const transfer = this.session.getControllerTransfer(id);
    const supportsPassTransfer = supportsPassControlTransfer(this.sportId);
    let queuedRevision = currentRevision === undefined ? undefined : currentRevision +
      (transfer?.pending ? 1 : 0);
    // Prediction can already own the next athlete while its ordered switch is
    // still in flight. Admit only revisions justified by earlier queued switch
    // intentions; exact ownership is checked again at execution. A failed switch
    // therefore never authorizes the following command to control another player.
    for (const queued of p.queue)
      if (queued.revision === queuedRevision &&
          (queued.command.switch || (supportsPassTransfer && transfer?.canSwitch && queued.command.pass)) &&
          queued.epoch === this.epoch && queued.generation === p.generation)
        queuedRevision = queuedRevision! + 1;
    const staleRevision = currentRevision !== undefined && v.revision < currentRevision;
    const admissibleRevision = currentRevision !== undefined &&
      v.revision >= currentRevision && v.revision <= queuedRevision!;
    if (
      v.epoch !== this.epoch ||
      v.generation !== p.generation ||
      p.ledger.length + (v.seq - p.lastSeq) > NETWORK_LIMITS.historyFrames ||
      v.seq <= p.lastSeq ||
      v.seq - p.lastSeq > NETWORK_LIMITS.historyFrames ||
      v.tick <= p.lastRequested ||
      (!admissibleRevision && !staleRevision)
    )
      return false;
    // Reactivation changes revision; let the client receive that revision before accepting commands.
    if (!p.active) {
      p.active = true;
      this.lobbyRevision++;
      this.session.setParticipantActive(id, true);
      p.lastInput = this.tick;
      return false;
    }
    const next = this.session.getTick() + 1;
    for (let seq = p.lastSeq + 1; seq < v.seq; seq++) {
      p.ledger.push({
        seq,
        requestedTick: 0,
        status: "rejected",
        reason: "sequence-gap",
      });
      p.feedback.rejections++;
      p.feedback.rejectionReasons["sequence-gap"]++;
    }
    // Missing sequence numbers are now explicitly terminal, not silently skipped.
    while (p.ledger.length && p.ledger[0].status !== "accepted")
      p.ack = p.ledger.shift()!.seq;
    p.lastSeq = v.seq;
    p.lastRequested = v.tick;
    p.lastInput = this.tick;
    if (staleRevision) {
      // This packet arrived reliably but belongs to an athlete no longer owned
      // by this participant. Terminate its exact sequence without executing it;
      // a later valid command must not misreport it as transport loss.
      p.ledger.push({ seq: v.seq, requestedTick: v.tick, status: "accepted" });
      this.terminal(p, v.seq, "revision");
      return false;
    }
    const margin = v.tick - next;
    p.margins.push(margin);
    if (p.margins.length > 60) p.margins.shift();
    const sorted = [...p.margins].sort((a, b) => a - b);
    p.feedback.sampleSeq = v.seq;
    p.feedback.sampleCount++;
    p.feedback.minimumMargin = sorted[0];
    p.feedback.lowMargin = sorted[Math.floor((sorted.length - 1) * 0.1)];
    if (margin < 0) p.feedback.lateReceipts++;
    const executionTick = Math.max(
      v.tick,
      next + (p.safetyCancel ? 1 : 0),
      (p.queue.at(-1)?.executionTick ?? 0) + 1,
    );
    const d: InputDisposition = {
      seq: v.seq,
      requestedTick: v.tick,
      executionTick,
      status: "accepted",
    };
    p.ledger.push(d);
    const reason =
      executionTick - v.tick > NETWORK_LIMITS.lateGraceTicks
        ? "expired"
        : executionTick > this.session.getTick() + NETWORK_LIMITS.maxFutureTicks
          ? "future"
          : p.queue.length >= NETWORK_LIMITS.pendingFrames ||
              p.ledger.length > NETWORK_LIMITS.historyFrames
            ? "capacity"
            : undefined;
    if (reason) {
      // An expired release cancels unsafe held charge at current time, never shoots late.
      if (v.command.strikeReleased || v.command.cancel ||
          (this.sportId === "crypt-guardian" && v.command.passHeld === false)) {
        for (const queued of p.queue) this.terminal(p, queued.seq, "cancelled");
        p.queue = [];
        p.safetyCancel = true;
        p.held = {};
        p.effective = { cancel: true };
        p.lastControl = -Infinity;
      }
      this.terminal(p, v.seq, reason);
      return false;
    }
    p.queue.push({ ...v, executionTick });
    return true;
  }
  rematch(id: string) {
    this.lobbyRevision++;
    const p = this.peers.get(id);
    if (!p || this.phase !== "results") return;
    p.rematch = true;
    if (
      [...this.peers.values()]
        .filter((x) => x.connected)
        .every((x) => x.rematch)
    ) {
      for (const [key, peer] of this.peers)
        if (!peer.connected) this.peers.delete(key);
      this.epoch++;
      if (this.shuffle) {
        const modes: SportId[] = ["cryptball","cryptkick","rift-volley","cryptcheck","crypt-dodge"];
        // A seeded coprime stride visits all five activities before repeating.
        const stride = 1 + this.encounterSeed % 4;
        this.sportId = modes[(modes.indexOf(this.sportId)+stride)%modes.length]!;
      }
      this.phase = "waiting";
      this.session = createCryptballSession({
        sportId: this.sportId,
        teamIds: this.teamIds,
        seed: this.sportId === "crypt-guardian" ? this.encounterSeed : undefined,
      });
      const checkpoint = this.session.capture();
      checkpoint.state.epoch = this.epoch;
      this.session.restore(checkpoint);
      for (const p of this.peers.values()) {
        p.ready = false;
        p.rematch = false;
        p.safetyCancel = false;
        p.queue = [];
        p.ack = p.lastSeq = 0;
        p.lastRequested = -1;
        p.ledger = [];
        p.margins = [];
        p.feedback = {
          ...p.feedback,
          sampleSeq: 0,
          sampleCount: 0,
          minimumMargin: 0,
          lowMargin: 0,
        };
        p.generation++;
        p.held = {};
        p.effective = {};
      }
      this.assign();
    }
  }
  advance() {
    this.tick++;
    if (this.phase === "countdown" && --this.countdown <= 0) {
      this.phase = "playing";
      this.session = createCryptballSession({
        teamIds: this.teamIds,
        seed: this.sportId === "crypt-guardian" ? this.encounterSeed : this.epoch,
        sportId: this.sportId,
      });
      this.session.setParticipants(
        [...this.peers.values()].map((p) => ({
          id: p.id,
          team: p.team,
          playerId: p.playerId,
          active: p.connected && !p.suspended,
        })),
      );
      const checkpoint = this.session.capture();
      checkpoint.state.epoch = this.epoch;
      // New modes retain their opening possession/guardian wake tells.
      if (!["cryptcheck", "crypt-dodge", "crypt-guardian"].includes(this.sportId)) {
        checkpoint.state.phase = "play";
        checkpoint.state.phaseTicks = 0;
      }
      this.session.restore(checkpoint);
      for (const p of this.peers.values()) {
        p.active = p.connected && !p.suspended;
        p.lastInput = p.lastControl = this.tick;
        p.safetyCancel = false;
        p.queue = [];
        p.held = {};
        p.effective = {};
      }
    }
    if (this.phase !== "playing") {
      if (this.phase === "results" && this.tick - this.resultsAt > 3600)
        this.phase = "closing";
      return;
    }
    const commands: Record<string, CommandFrame> = {};
    const target = this.session.getTick() + 1;
    for (const p of this.peers.values()) {
      if (
        !p.connected ||
        p.suspended ||
        this.tick - p.lastInput >= NETWORK_LIMITS.botTicks
      ) {
        if (p.active) {
          p.active = false;
          this.lobbyRevision++;
          p.feedback.botTransitions++;
          this.session.setParticipantActive(p.id, false);
        }
        for (const q of p.queue) this.terminal(p, q.seq, "inactive");
        p.safetyCancel = false;
        p.queue = [];
        p.held = {};
        p.effective = {};
        continue;
      }
      if (!p.active) continue;
      let cmd: CommandFrame = heldCommand(p.held, this.sportId);
      const next = p.queue[0];
      if (p.safetyCancel) {
        cmd = { cancel: true };
        p.held = {};
        p.lastControl = this.tick;
        p.safetyCancel = false;
      } else if (next && next.executionTick <= target) {
        p.queue.shift();
        const valid =
          next.executionTick === target &&
          next.revision === this.session.getControllerRevision(p.id) &&
          next.generation === p.generation &&
          next.epoch === this.epoch;
        if (valid) {
          cmd = {
            ...next.command,
            origin: {
              epoch: this.epoch,
              generation: p.generation,
              participantId: p.id,
              seq: next.seq,
            },
          };
          p.held = heldCommand(cmd, this.sportId);
          p.lastControl = this.tick;
        }
        this.terminal(p, next.seq, valid ? undefined : "revision");
      } else p.feedback.emptySlots++;
      if (
        !p.queue.length &&
        this.tick - p.lastControl >= NETWORK_LIMITS.quietTicks
      ) {
        if (!p.effective.cancel) p.feedback.neutralizations++;
        cmd = { cancel: true };
        p.held = {};
      }
      p.effective = cmd.cancel
        ? { cancel: true }
        : heldCommand(cmd, this.sportId);
      commands[p.id] = cmd;
    }
    const revisions = new Map([...this.peers.values()].map(peer =>
      [peer.id, this.session.getControllerRevision(peer.id)]));
    this.session.stepParticipants(commands);
    for (const peer of this.peers.values()) {
      if (revisions.get(peer.id) !== this.session.getControllerRevision(peer.id)) {
        // Held state belongs to the athlete/revision that admitted it. The new
        // athlete receives only a fresh command bearing its exact revision.
        peer.held = {};
        peer.effective = {};
      }
    }
    if (this.session.getPhase() === "results") {
      this.phase = "results";
      this.resultsAt = this.tick;
    }
  }
  snapshot(
    id: string,
    events: Snapshot["events"],
    checkpoint = this.session.capture(),
    serverTime = performance.now(),
    serverDebt = 0,
  ): Snapshot {
    const p = this.peers.get(id)!;
    return {
      snapshotSeq: ++this.snapshotSeq,
      serverTime,
      serverDebt,
      phase: this.phase,
      receivedSeq: p.lastSeq,
      terminalSeq: p.ack,
      dispositions: p.ledger.map((d) => ({ ...d })),
      feedback: {
        ...p.feedback,
        rejectionReasons: { ...p.feedback.rejectionReasons },
      },
      sportId: this.sportId,
      version: PROTOCOL,
      build: BUILD,
      epoch: this.epoch,
      tick: checkpoint.state.tick,
      ack: p.ack,
      generation: p.generation,
      participantId: id,
      remote: Object.fromEntries(
        [...this.peers.values()]
          .filter((p) => p.active)
          .map((p) => [p.id, { ...p.effective }]),
      ),
      checkpoint,
      events,
    };
  }
  lobby(): Lobby {
    return {
      shuffle: this.shuffle,
      teamIds: this.teamIds,
      sportId: this.sportId,
      protocol: PROTOCOL,
      build: BUILD,
      roomId: this.roomId,
      private: this.privateRoom,
      capacity: this.capacity,
      phase: this.phase,
      epoch: this.epoch,
      countdown: this.countdown,
      seats: [...this.peers.values()].map(
        ({
          id,
          name,
          team,
          playerId,
          role,
          connected,
          ready,
          active,
          generation,
        }) => ({
          id,
          name,
          team,
          playerId,
          role,
          connected,
          ready,
          active,
          generation,
        }),
      ),
    };
  }
}
