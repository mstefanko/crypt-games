import { validateTeamSelection } from "./sim/team-identities";
import { pack, unpack } from "msgpackr";
import type {
  CommandFrame,
  CryptballEvent,
  Team,
  SportId,
} from "./sim/contract";
import type { CryptballSession } from "./sim/contract";
import { isSportId } from "./sim/sports-spec";
export { isSportId };
// v17 adds bounded friends court observers with shared read-only checkpoints.
export const PROTOCOL = 17;
export const FRIENDS_OBSERVER_CAP = 8;
export function resolveSportId(value: unknown): SportId {
  if (value === undefined) return "cryptball";
  if (!isSportId(value))
    throw Error(
      "Unknown sport. Choose Cryptball, Cryptkick, Rift Volley, Cryptcheck · Hockey, Crypt Dodge, or Crypt Guardian.",
    );
  return value;
}
import { BUILD } from "./build-identity";
export { BUILD };
export const TICK_MS = 1000 / 60;
export const MAX_PACKET_BYTES = 16384;
export const HISTORY_LIMIT = 128;
export const NETWORK_LIMITS = Object.freeze({
  unsentEdges: 8,
  captureAgeMs: 100,
  pingWarmupMs: 2000,
  pingFastMs: 250,
  pingHealthyMs: 1000,
  heartbeatMs: 100,
  resyncMinMs: 500,
  resyncMaxMs: 4000,
  arrivalMargin: 2,
  maxArrivalLead: 20,
  maxFutureTicks: 24,
  replayTicks: 32,
  pendingFrames: 32,
  historyFrames: 128,
  lateGraceTicks: 3,
  quietTicks: 6,
  botTicks: 30,
});
export const INPUT_REJECTIONS = [
  "expired",
  "future",
  "capacity",
  "revision",
  "inactive",
  "sequence-gap",
  "cancelled",
] as const;
export type InputRejection = (typeof INPUT_REJECTIONS)[number];
export type RejectionReasons = Record<InputRejection, number>;
export function emptyRejectionReasons(): RejectionReasons {
  return Object.fromEntries(
    INPUT_REJECTIONS.map((reason) => [reason, 0]),
  ) as RejectionReasons;
}
export interface InputDisposition {
  seq: number;
  requestedTick: number;
  executionTick?: number;
  status: "accepted" | "executed" | "rejected";
  reason?: InputRejection;
}
export interface InputFeedback {
  sampleSeq: number;
  sampleCount: number;
  minimumMargin: number;
  lowMargin: number;
  lateReceipts: number;
  rejections: number;
  rejectionReasons: RejectionReasons;
  emptySlots: number;
  neutralizations: number;
  botTransitions: number;
}
export interface PingRequest {
  id: number;
  sent: number;
}
export interface Pong extends PingRequest {
  serverTime: number;
  tick: number;
  epoch: number;
  phase: RoomPhase;
  serverDebt: number;
}
export interface Heartbeat {
  epoch: number;
  generation: number;
  revision: number;
}
export interface ResyncRequest {
  id: number;
  epoch: number;
  generation: number;
  lastSnapshotSeq: number;
}
export function validatePing(value: unknown): value is PingRequest {
  const p = value as PingRequest;
  return (
    !!p &&
    Number.isSafeInteger(p.id) &&
    p.id >= 0 &&
    Number.isFinite(p.sent) &&
    p.sent >= 0 &&
    p.sent <= Number.MAX_SAFE_INTEGER
  );
}
export function validateResync(value: unknown): value is ResyncRequest {
  const p = value as ResyncRequest;
  return (
    !!p &&
    [p.id, p.epoch, p.generation, p.lastSnapshotSeq].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  );
}
export type RoomPhase =
  | "waiting"
  | "countdown"
  | "playing"
  | "results"
  | "closing";
export interface Seat {
  id: string;
  name: string;
  team: Team;
  playerId: string;
  role: "field";
  connected: boolean;
  ready: boolean;
  active: boolean;
  generation: number;
}
export interface Observer {
  id: string;
  name: string;
  connected: boolean;
  generation: number;
  queued: boolean;
}
export interface Lobby {
  returning?: string[];
  resultsTicksRemaining?: number;
  friends?: boolean;
  spectators?: Observer[];
  queue?: string[];
  shuffle?: boolean;
  teamIds: import("./sim/team-identities").TeamSelection;
  sportId: SportId;
  protocol: number;
  build: string;
  roomId: string;
  private: boolean;
  capacity: number;
  phase: RoomPhase;
  epoch: number;
  countdown: number;
  seats: Seat[];
}
export interface InputPacket {
  epoch: number;
  generation: number;
  seq: number;
  tick: number;
  revision: number;
  command: CommandFrame;
}
export interface Snapshot {
  observer?: boolean;
  snapshotSeq: number;
  serverTime: number;
  serverDebt: number;
  phase: RoomPhase;
  receivedSeq: number;
  terminalSeq: number;
  dispositions: InputDisposition[];
  feedback: InputFeedback;
  resyncId?: number;
  sportId: SportId;
  version: number;
  build: string;
  epoch: number;
  tick: number;
  ack: number;
  generation: number;
  participantId: string;
  remote: Record<string, CommandFrame>;
  checkpoint: ReturnType<CryptballSession["capture"]>;
  events: CryptballEvent[];
}
export function encodeSnapshot(snapshot: Snapshot): Uint8Array {
  const bytes = pack(snapshot);
  if (bytes.byteLength > MAX_PACKET_BYTES)
    throw Error("Checkpoint exceeds wire budget");
  return bytes;
}
export function decodeSnapshot(bytes: Uint8Array): Snapshot {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_PACKET_BYTES)
    throw Error("Invalid checkpoint size");
  const s = unpack(bytes) as Snapshot;
  if (
    !s ||
    (s.observer !== undefined && typeof s.observer !== "boolean") ||
    (s.observer === true && (s.participantId !== "observer" || s.generation !== 1 || s.receivedSeq !== 0 || s.terminalSeq !== 0 || Object.keys(s.remote ?? {}).length !== 0)) ||
    s.version !== PROTOCOL ||
    s.build !== BUILD ||
    !isSportId(s.sportId) ||
    !Number.isSafeInteger(s.epoch) ||
    !Number.isSafeInteger(s.tick) ||
    !Number.isSafeInteger(s.ack) ||
    !Number.isSafeInteger(s.snapshotSeq) ||
    s.snapshotSeq < 1 ||
    !Number.isFinite(s.serverTime) ||
    s.serverTime < 0 ||
    !Number.isFinite(s.serverDebt) ||
    s.serverDebt < 0 ||
    !Number.isSafeInteger(s.receivedSeq) ||
    !Number.isSafeInteger(s.terminalSeq) ||
    s.terminalSeq < 0 ||
    s.receivedSeq < s.terminalSeq ||
    s.ack !== s.terminalSeq ||
    !Array.isArray(s.dispositions) ||
    s.dispositions.length > HISTORY_LIMIT ||
    s.dispositions.length !== s.receivedSeq - s.terminalSeq ||
    !Number.isSafeInteger(s.generation) ||
    s.generation < 1 ||
    typeof s.participantId !== "string" ||
    !s.participantId ||
    s.dispositions.some(
      (d, index) =>
        !d ||
        d.seq !== s.terminalSeq + index + 1 ||
        !Number.isSafeInteger(d.seq) ||
        d.seq <= s.terminalSeq ||
        d.seq > s.receivedSeq ||
        !Number.isSafeInteger(d.requestedTick) ||
        d.requestedTick < 0 ||
        !["accepted", "executed", "rejected"].includes(d.status) ||
        (d.status === "rejected" &&
          ![
            "expired",
            "future",
            "capacity",
            "revision",
            "inactive",
            "sequence-gap",
            "cancelled",
          ].includes(d.reason!)) ||
        (d.status === "accepted" &&
          (!Number.isSafeInteger(d.executionTick) ||
            d.executionTick! <= s.tick)),
    ) ||
    !s.feedback ||
    !s.feedback.rejectionReasons ||
    Object.keys(s.feedback.rejectionReasons).length !==
      INPUT_REJECTIONS.length ||
    INPUT_REJECTIONS.some(
      (reason) =>
        !Number.isSafeInteger(s.feedback.rejectionReasons[reason]) ||
        s.feedback.rejectionReasons[reason] < 0,
    ) ||
    ![
      s.feedback.sampleSeq,
      s.feedback.sampleCount,
      s.feedback.lateReceipts,
      s.feedback.rejections,
      s.feedback.emptySlots,
      s.feedback.neutralizations,
      s.feedback.botTransitions,
    ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    !Number.isFinite(s.feedback.minimumMargin) ||
    !Number.isFinite(s.feedback.lowMargin) ||
    !["waiting", "countdown", "playing", "results", "closing"].includes(
      s.phase,
    ) ||
    !s.checkpoint ||
    s.checkpoint.state.sportId !== s.sportId ||
    s.tick !== s.checkpoint.state.tick ||
    !Array.isArray(s.events) ||
    s.events.some(
      (e) =>
        e.origin !== undefined &&
        (!e.origin ||
          ![
            e.origin.epoch,
            e.origin.generation,
            e.origin.seq,
            e.origin.ordinal,
          ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
          typeof e.origin.participantId !== "string" ||
          !e.origin.participantId ||
          e.origin.participantId.length > 96 ||
          e.origin.eventKind !== e.type),
    )
  )
    throw Error("Invalid checkpoint envelope");
  validateTeamSelection(s.checkpoint.state.teamIds);
  return s;
}
const FLAGS = [
  "pointerAim",
  "strikePressed",
  "strikeHeld",
  "strikeReleased",
  "pass",
  "passHeld",
  "dash",
  "special",
  "switch",
  "cancel",
  "slide",
  "check",
] as const;
export function validateInput(value: unknown): InputPacket | null {
  if (!value || typeof value !== "object") return null;
  const p = value as InputPacket;
  if (
    ![p.epoch, p.generation, p.seq, p.tick, p.revision].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    !p.command ||
    typeof p.command !== "object"
  )
    return null;
  const c = p.command;
  if (
    c.switchTarget !== undefined &&
    (typeof c.switchTarget !== "string" ||
      !/^player-[0-5]$/.test(c.switchTarget))
  )
    return null;
  if (
    (c.moveX !== undefined &&
      (!Number.isFinite(c.moveX) ||
        Math.abs(c.moveX) > 1 ||
        c.moveX !== Math.round(c.moveX * 127) / 127)) ||
    (c.moveY !== undefined &&
      (!Number.isFinite(c.moveY) ||
        Math.abs(c.moveY) > 1 ||
        c.moveY !== Math.round(c.moveY * 127) / 127)) ||
    (c.aim !== undefined &&
      (!Number.isInteger(c.aim) || c.aim < 0 || c.aim > 255))
  )
    return null;
  for (const k of FLAGS)
    if (c[k] !== undefined && typeof c[k] !== "boolean") return null;
  if (
    Object.keys(c).some(
      (k) => !["moveX", "moveY", "aim", "switchTarget", ...FLAGS].includes(k),
    )
  )
    return null;
  return {
    epoch: p.epoch,
    generation: p.generation,
    seq: p.seq,
    tick: p.tick,
    revision: p.revision,
    command: { ...c },
  };
}
export function heldCommand(
  c: CommandFrame,
  sportId: SportId = "cryptball",
): CommandFrame {
  return {
    moveX: c.moveX,
    moveY: c.moveY,
    aim: c.aim,
    pointerAim: c.pointerAim,
    strikeHeld: c.strikeHeld,
    ...(sportId === "crypt-guardian" && c.passHeld !== undefined
      ? { passHeld: c.passHeld }
      : {}),
    ...(!["cryptcheck", "crypt-dodge", "crypt-guardian"].includes(sportId) && c.slide !== undefined
      ? { slide: c.slide }
      : {}),
  };
}

export function quantizeCommand(c: CommandFrame): CommandFrame {
  const axis = (n: number | undefined) =>
    Number.isFinite(n)
      ? Math.round(Math.max(-1, Math.min(1, n!)) * 127) / 127
      : 0;
  return { ...c, moveX: axis(c.moveX), moveY: axis(c.moveY) };
}
