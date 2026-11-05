import type { ArenaIdentity } from "../../../game-simulation/src/m3/arena";
import type { M4Profile } from "./scenarios";
import { findScenario } from "./scenarios";
import type {
  HostState,
  LogEntry,
  M4Session,
  SessionSnapshot,
} from "./session";
import { validateCommand } from "./session";
import {
  record,
  integer,
  string,
  array,
  boolean,
  canonical,
  detached,
  parseBounded,
  hashId,
  sha256,
  text,
  MAX_COMMANDS,
} from "./codec";
export interface ArtifactEnvironment {
  runtime: string;
  platform: string;
  sourceRevision: string;
}
export interface Attachment {
  kind: "screenshot";
  mime: "image/png";
  index: number;
  width: number;
  height: number;
  base64: string;
  hash: string;
}
export interface HashedSnapshot extends SessionSnapshot {
  hash: string;
  stateHash: string;
}
export interface M4Artifact {
  format: "pocket-game-bug";
  version: 1;
  profile: M4Profile;
  scenario: string;
  identity: ArenaIdentity;
  buildId: string;
  runtimeBuildId: string;
  sourceRevision: string;
  seed: number;
  initial: HashedSnapshot;
  commands: LogEntry[];
  checkpoints: HashedSnapshot[];
  schedule: { requested: number[]; actual: number[] };
  firstDivergence: null | { index: number; jsonPointer: string };
  environment: ArtifactEnvironment;
  consoleErrors: string[];
  notes: { index: number; text: string }[];
  attachments: Attachment[];
}
function host(value: unknown): HostState {
  const o = record(value, ["paused", "epoch", "pendingCancel", "cinematic"]);
  boolean(o.paused);
  integer(o.epoch, 0, Number.MAX_SAFE_INTEGER);
  boolean(o.pendingCancel);
  if (o.cinematic !== null)
    throw Error("M4_CINEMATIC_BOUNDARY: snapshots exclude active cinematics");
  return o as unknown as HostState;
}
async function snapshot(
  value: unknown,
  profile: M4Profile,
  maxIndex: number,
): Promise<HashedSnapshot> {
  const o = record(value, ["index", "bytes", "host", "hash", "stateHash"]);
  integer(o.index, 0, maxIndex);
  host(o.host);
  hashId(o.hash);
  hashId(o.stateHash);
  const cap =
    profile === "grid" ? 262144 : profile === "adventure" ? 1048576 : 2097152;
  if (typeof o.bytes !== "string")
    throw Error("M4_CHECKPOINT: missing exact bytes");
  parseBounded(o.bytes, cap);
  if ((await sha256(o.bytes)) !== o.hash)
    throw Error("M4_HASH: checkpoint hash mismatch");
  if (
    (await sha256(
      canonical({ index: o.index, bytes: o.bytes, host: o.host }),
    )) !== o.stateHash
  )
    throw Error("M4_HASH: host checkpoint hash mismatch");
  return o as unknown as HashedSnapshot;
}
function decodeBase64(s: string): Uint8Array {
  if (
    s.length > 4 * 1024 * 1024 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)
  )
    throw Error("M4_ATTACHMENT: invalid bounded base64");
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
export async function screenshotAttachment(
  base64: string,
  index: number,
  width = 320,
  height = 180,
): Promise<Attachment> {
  const data = decodeBase64(base64);
  return {
    kind: "screenshot",
    mime: "image/png",
    index,
    width,
    height,
    base64,
    hash: await sha256(data),
  };
}
/** Validate bounded PNG framing and CRCs; decoding/pixel provenance is not attested. */
export function validatePNG(
  data: Uint8Array,
  width: number,
  height: number,
): void {
  const bad = () => {
    throw Error("M4_ATTACHMENT: malformed PNG structure or CRC");
  };
  if (
    data.length < 57 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => data[i] === n)
  )
    bad();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 8,
    chunks = 0,
    idat = false,
    ended = false;
  while (offset < data.length) {
    if (offset + 12 > data.length) bad();
    const size = view.getUint32(offset);
    if (size > data.length - offset - 12) bad();
    const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type)) bad();
    let crc = 0xffffffff;
    for (let i = offset + 4; i < offset + 8 + size; i++) {
      crc ^= data[i];
      for (let b = 0; b < 8; b++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    if ((crc ^ 0xffffffff) >>> 0 !== view.getUint32(offset + 8 + size)) bad();
    if (chunks++ === 0) {
      if (
        type !== "IHDR" ||
        size !== 13 ||
        view.getUint32(offset + 8) !== width ||
        view.getUint32(offset + 12) !== height
      )
        bad();
      const depth = data[offset + 16],
        color = data[offset + 17];
      const depths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !depths[color]?.includes(depth) ||
        data[offset + 18] !== 0 ||
        data[offset + 19] !== 0 ||
        data[offset + 20] > 1
      )
        bad();
    } else if (type === "IHDR") bad();
    if (type === "IDAT") idat = true;
    offset += 12 + size;
    if (type === "IEND") {
      if (size !== 0 || !idat || offset !== data.length) bad();
      ended = true;
      break;
    }
  }
  if (!ended) bad();
}
/** Validates all fields, identities, hashes and production codecs before returning detached data. */
export async function validateArtifact(
  value: unknown,
  session: M4Session,
): Promise<M4Artifact> {
  const o = record(parseBounded(value), [
    "format",
    "version",
    "profile",
    "scenario",
    "identity",
    "buildId",
    "runtimeBuildId",
    "sourceRevision",
    "seed",
    "initial",
    "commands",
    "checkpoints",
    "schedule",
    "firstDivergence",
    "environment",
    "consoleErrors",
    "notes",
    "attachments",
  ]);
  if (o.format !== "pocket-game-bug" || o.version !== 1)
    throw Error("M4_VERSION: unsupported artifact version");
  if (o.profile !== session.profile)
    throw Error("M4_PROFILE: artifact profile mismatch");
  const scenario = findScenario(string(o.scenario), session.profile);
  if (o.seed !== scenario.seed) throw Error("M4_SCENARIO: seed mismatch");
  const id = record(o.identity, ["gameId", "rulesBuildId", "contentId"]);
  for (const k of ["gameId", "rulesBuildId", "contentId"] as const) {
    string(id[k]);
    if (id[k] !== session.identity[k])
      throw Error(
        "M4_BUILD_UNAVAILABLE: exact rules/content identity differs; use its archived build.",
      );
  }
  string(o.buildId);
  if (o.buildId !== session.buildId)
    throw Error(
      "M4_BUILD_UNAVAILABLE: tool build mismatch; use its archived build.",
    );
  string(o.runtimeBuildId);
  if (o.runtimeBuildId !== session.runtimeBuildId)
    throw Error(
      "M4_BUILD_UNAVAILABLE: emitted player artifact identity mismatch",
    );
  string(o.sourceRevision);
  const commands = array(o.commands, MAX_COMMANDS, "/commands");
  commands.forEach((v, i) => {
    const c = record(v, ["index", "clock", "epoch", "command", "outcome"]);
    if (c.index !== i + 1) throw Error("M4_ORDER: nonsequential log");
    integer(c.clock, 0, Number.MAX_SAFE_INTEGER);
    integer(c.epoch, 0, Number.MAX_SAFE_INTEGER);
    validateCommand(session.profile, c.command);
    if (
      ![
        "playing",
        "won",
        "lost",
        "draw",
        "slot-0",
        "slot-1",
        "committed",
      ].includes(c.outcome as string)
    )
      throw Error("M4_OUTCOME: invalid outcome");
  });
  const initial = await snapshot(o.initial, session.profile, 0);
  if (initial.index !== 0) throw Error("M4_ORDER: initial index must be zero");
  const checks = array(o.checkpoints, 10000);
  if (!checks.length)
    throw Error("M4_CHECKPOINT: initial/final comparison required");
  let previous = -1;
  const checkpoints = [];
  for (const check of checks) {
    const s = await snapshot(check, session.profile, commands.length);
    if (s.index <= previous)
      throw Error("M4_ORDER: checkpoints must be strictly ordered");
    previous = s.index;
    checkpoints.push(s);
  }
  if (
    checkpoints[0].index !== 0 ||
    checkpoints.at(-1)!.index !== commands.length ||
    JSON.stringify(checkpoints[0]) !== JSON.stringify(initial)
  )
    throw Error("M4_CHECKPOINT: initial/final coverage mismatch");
  // Run codecs against a separate adapter. Rejection cannot alter the caller.
  const { createM4Session } = await import("./session");
  const verifier = createM4Session({
    project: session.project,
    profile: session.profile,
    identity: session.identity,
    buildId: session.buildId,
    runtimeBuildId: session.runtimeBuildId,
    scenario: scenario.id,
  });
  for (const s of [initial, ...checkpoints]) {
    verifier.restore(s.bytes);
    if (verifier.checkpoint() !== s.bytes)
      throw Error("M4_CHECKPOINT: noncanonical exact bytes");
  }
  const schedule = record(o.schedule, ["requested", "actual"]);
  for (const key of ["requested", "actual"])
    for (const n of array(schedule[key], MAX_COMMANDS)) integer(n, 1, 5);
  if (!(schedule.requested as unknown[]).length)
    throw Error("M4_SCHEDULE: requested schedule empty");
  if (
    (schedule.actual as number[]).reduce((n, x) => n + x, 0) !==
    commands.filter((c) => (c as LogEntry).command.kind === "frame").length
  )
    throw Error("M4_SCHEDULE: actual schedule does not cover consumed frames");
  if (o.firstDivergence !== null) {
    const d = record(o.firstDivergence, ["index", "jsonPointer"]);
    integer(d.index, 0, commands.length);
    const p = text(d.jsonPointer, 1024);
    if (!p.startsWith("/")) throw Error("M4_POINTER: expected JSON pointer");
  }
  const env = record(o.environment, ["runtime", "platform", "sourceRevision"]);
  for (const v of Object.values(env)) text(v, 256);
  if (env.sourceRevision !== o.sourceRevision)
    throw Error("M4_REVISION: inconsistent source revision");
  for (const error of array(o.consoleErrors, 64)) text(error, 4096);
  for (const n of array(o.notes, 256)) {
    const note = record(n, ["index", "text"]);
    integer(note.index, 0, commands.length);
    text(note.text, 4096);
  }
  let attachmentBytes = 0;
  for (const item of array(o.attachments, 4)) {
    const a = record(item, [
      "kind",
      "mime",
      "index",
      "width",
      "height",
      "base64",
      "hash",
    ]);
    if (a.kind !== "screenshot" || a.mime !== "image/png")
      throw Error("M4_ATTACHMENT: unsupported attachment kind");
    integer(a.index, 0, commands.length);
    if (a.width !== 320 || a.height !== 180)
      throw Error(
        "M4_ATTACHMENT: screenshots must use the320x180 logical resolution",
      );
    hashId(a.hash);
    if (typeof a.base64 !== "string")
      throw Error("M4_ATTACHMENT: missing base64");
    const data = decodeBase64(a.base64);
    attachmentBytes += data.length;
    if (data.length > 2097152 || attachmentBytes > 4194304)
      throw Error("M4_ATTACHMENT: aggregate attachment budget exceeded");
    validatePNG(data, a.width as number, a.height as number);
    if ((await sha256(data)) !== a.hash)
      throw Error("M4_HASH: attachment hash mismatch");
  }
  return detached(o) as unknown as M4Artifact;
}
