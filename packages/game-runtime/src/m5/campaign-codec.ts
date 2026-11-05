/** Finite recovery containers. Gameplay campaign and exact codecs remain v1. */
import {
  boundedJSON,
  canonical,
  record,
} from "../../../game-project/src/runtime";
import {
  restoreCampaign,
  serializeCampaign,
  type AdventureDefinitions,
  type AdventureState,
} from "../../../game-simulation/src/m3/adventure";
import { sha256 } from "./hash";
export const CAMPAIGN_BYTES = 1048576;
export const BACKUP_BYTES = 4210696;
export const ENTRY_BASE64 = 1398104;
const encoder = new TextEncoder();
const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export interface BackupEntry {
  encoding: "base64";
  bytes: number;
  hash: string;
  data: string;
}
export interface CampaignBackup {
  version: 2;
  kind: "adventure-campaign-backup";
  gameId: string;
  characterId: string;
  slot: string;
  generation: number;
  current: BackupEntry;
  previous: BackupEntry | null;
  original: BackupEntry | null;
}
export class CampaignError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}
function fail(code: string, message: string): never {
  throw new CampaignError(code, message);
}
export function stableSlot(slot: string) {
  if (
    typeof slot !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(slot)
  )
    fail("CAMPAIGN_SLOT", "Use a bounded stable slot ID.");
  return slot;
}
export function inputBytes(
  input: string | Uint8Array,
  limit = BACKUP_BYTES,
): Uint8Array {
  if (input.length > limit)
    fail(
      "CAMPAIGN_LIMIT",
      `Import exceeds ${limit} bytes; keep the original file externally.`,
    );
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  if (bytes.length > limit)
    fail(
      "CAMPAIGN_LIMIT",
      `Import exceeds ${limit} bytes; keep the original file externally.`,
    );
  return bytes;
}
export function decodeUTF8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return fail(
      "CAMPAIGN_UTF8",
      "Invalid UTF-8; export the exact imported original.",
    );
  }
}
/** Fixed ASCII output avoids one temporary string object per three input bytes. */
export function encodeBase64(bytes: Uint8Array): string {
  if (bytes.length > CAMPAIGN_BYTES)
    fail("CAMPAIGN_LIMIT", "Base64 input exceeds the campaign entry limit.");
  const output = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  let cursor = 0;
  for (let i = 0; i < bytes.length; i += 3) {
    const n =
      bytes[i] * 65536 + (bytes[i + 1] ?? 0) * 256 + (bytes[i + 2] ?? 0);
    output[cursor++] = alphabet.charCodeAt((n >>> 18) & 63);
    output[cursor++] = alphabet.charCodeAt((n >>> 12) & 63);
    output[cursor++] =
      i + 1 < bytes.length ? alphabet.charCodeAt((n >>> 6) & 63) : 61;
    output[cursor++] = i + 2 < bytes.length ? alphabet.charCodeAt(n & 63) : 61;
  }
  return new TextDecoder().decode(output);
}
export function entryFor(source: string): BackupEntry {
  const bytes = inputBytes(source, CAMPAIGN_BYTES);
  return {
    encoding: "base64",
    bytes: bytes.length,
    hash: `sha256:${sha256(bytes)}`,
    data: encodeBase64(bytes),
  };
}
function readEntry(value: unknown, verify = true): string {
  let o: Record<string, unknown>;
  try {
    o = record(value, ["encoding", "bytes", "hash", "data"]);
  } catch {
    return fail(
      "CAMPAIGN_ENTRY",
      "Unknown or missing backup entry fields; export the original or recover a valid previous campaign.",
    );
  }
  if (
    o.encoding !== "base64" ||
    typeof o.data !== "string" ||
    o.data.length > ENTRY_BASE64 ||
    typeof o.bytes !== "number" ||
    !Number.isSafeInteger(o.bytes) ||
    o.bytes < 0 ||
    o.bytes > CAMPAIGN_BYTES ||
    Object.is(o.bytes, -0) ||
    typeof o.hash !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(o.hash)
  )
    fail("CAMPAIGN_ENTRY", "Invalid bounded backup entry.");
  const data = o.data;
  const padding = o.bytes % 3 === 0 ? 0 : 3 - (o.bytes % 3);
  if (data.length !== Math.ceil(o.bytes / 3) * 4 || data.length % 4)
    fail("CAMPAIGN_BASE64", "Invalid base64 or declared length.");
  for (let i = 0; i < data.length; i++)
    if (
      i < data.length - padding ? !alphabet.includes(data[i]) : data[i] !== "="
    )
      fail("CAMPAIGN_BASE64", "Invalid base64 alphabet or padding.");
  const result = new Uint8Array(o.bytes);
  let cursor = 0;
  for (let i = 0; i < data.length; i += 4) {
    const n =
      (alphabet.indexOf(data[i]) << 18) |
      (alphabet.indexOf(data[i + 1]) << 12) |
      (Math.max(0, alphabet.indexOf(data[i + 2])) << 6) |
      Math.max(0, alphabet.indexOf(data[i + 3]));
    if (cursor < result.length) result[cursor++] = n >>> 16;
    if (cursor < result.length) result[cursor++] = n >>> 8;
    if (cursor < result.length) result[cursor++] = n;
  }
  if (encodeBase64(result) !== data)
    fail("CAMPAIGN_BASE64", "Noncanonical base64 padding.");
  if (verify && `sha256:${sha256(result)}` !== o.hash)
    fail(
      "CAMPAIGN_HASH",
      "Corrupt backup hash; choose a valid previous backup or original file.",
    );
  return verify ? decodeUTF8(result) : "";
}
export function validatePayload(
  defs: AdventureDefinitions,
  source: string,
): AdventureState {
  inputBytes(source, CAMPAIGN_BYTES);
  try {
    return restoreCampaign(defs, source);
  } catch (error) {
    return fail(
      "CAMPAIGN_COMPATIBILITY",
      `${error instanceof Error ? error.message : String(error)}. Requires campaign v1, authored compatibility 1 and matching game/character/targets; exact checkpoints do not migrate.`,
    );
  }
}
function checkOriginal(source: string | null) {
  if (source === null) return;
  inputBytes(source, CAMPAIGN_BYTES);
  let value: unknown;
  try {
    // Provenance may be noncanonical JSON; canonical validation must not hide
    // a nested container behind a BOM, duplicate key, or negative zero.
    value = JSON.parse(source.replace(/^\uFEFF/, ""));
  } catch {
    return;
  }
  if (
    value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).kind === "adventure-campaign-backup"
  )
    fail(
      "CAMPAIGN_ORIGINAL",
      "Backup originals cannot recursively contain backup containers; export the complete input separately.",
    );
}
export function makeBackup(
  defs: AdventureDefinitions,
  current: string,
  previous: string | null = null,
  original: string | null = null,
  generation = 0,
  slot = "main",
): CampaignBackup {
  checkOriginal(original);
  validatePayload(defs, current);
  if (previous !== null) validatePayload(defs, previous);
  if (
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    Object.is(generation, -0)
  )
    fail("CAMPAIGN_GENERATION", "Invalid generation.");
  return {
    version: 2,
    kind: "adventure-campaign-backup",
    gameId: defs.gameId,
    characterId: defs.characterId,
    slot: stableSlot(slot),
    generation,
    current: entryFor(current),
    previous: previous === null ? null : entryFor(previous),
    original: original === null ? null : entryFor(original),
  };
}
export function encodeBackup(backup: CampaignBackup): string {
  const source = canonical(backup);
  inputBytes(source);
  return source;
}
export interface RecoveryCandidate {
  state: AdventureState;
  payload: string;
  previous: string | null;
  original: string | null;
  generation: number;
  migrated: boolean;
}
/** Inspect only top-level string fields before allocating an oversized raw campaign. */
function isRawCampaign(source: string): boolean {
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      const start = i;
      for (i++; i < source.length; i++) {
        if (source[i] === "\\") i++;
        else if (source[i] === '"') break;
      }
      if (depth !== 1) continue;
      let cursor = i + 1;
      while (/\s/.test(source[cursor] ?? "") && cursor < source.length)
        cursor++;
      if (source[cursor] !== ":") continue;
      try {
        if (JSON.parse(source.slice(start, i + 1)) !== "kind") continue;
        cursor++;
        while (/\s/.test(source[cursor] ?? "") && cursor < source.length)
          cursor++;
        if (source[cursor] !== '"') continue;
        const valueStart = cursor++;
        for (; cursor < source.length; cursor++) {
          if (source[cursor] === "\\") cursor++;
          else if (source[cursor] === '"') break;
        }
        if (
          JSON.parse(source.slice(valueStart, cursor + 1)) ===
          "adventure-campaign"
        )
          return true;
      } catch {
        /* The full bounded parser reports malformed JSON. */
      }
    } else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
  }
  return false;
}
export function parseCampaignInput(input: string | Uint8Array) {
  const bytes = inputBytes(input);
  const source = decodeUTF8(bytes);
  if (bytes.length > CAMPAIGN_BYTES && isRawCampaign(source))
    fail("CAMPAIGN_LIMIT", "Raw campaign exceeds the campaign entry limit.");
  try {
    return {
      source,
      data: boundedJSON(source, BACKUP_BYTES, {
        rejectNegativeZero: true,
      }) as Record<string, unknown>,
    };
  } catch (error) {
    return fail(
      "CAMPAIGN_JSON",
      `${error instanceof Error ? error.message : String(error)}; export the imported original.`,
    );
  }
}
export function prepareCampaignRecovery(
  defs: AdventureDefinitions,
  input: string | Uint8Array,
  slot = "main",
  selected: "current" | "previous" = "current",
): RecoveryCandidate {
  const { source, data } = parseCampaignInput(input);
  if (data?.version === 1)
    return restoreRawCampaign(defs, source, data, selected);
  return restoreBackupCampaign(defs, data, slot, selected);
}
export function restoreRawCampaign(
  defs: AdventureDefinitions,
  source: string,
  data: Record<string, unknown>,
  selected: "current" | "previous" = "current",
): RecoveryCandidate {
  if (data && data.version === 1 && data.kind === "adventure-campaign") {
    if (selected !== "current")
      fail("CAMPAIGN_PREVIOUS", "Raw v1 has no previous generation.");
    const state = validatePayload(defs, source);
    return {
      state,
      payload: serializeCampaign(defs, state.campaign),
      previous: null,
      original: source,
      generation: 0,
      migrated: true,
    };
  }
  return fail("CAMPAIGN_VERSION", "Unsupported campaign version or kind.");
}
export function restoreBackupCampaign(
  defs: AdventureDefinitions,
  data: Record<string, unknown>,
  slot = "main",
  selected: "current" | "previous" = "current",
): RecoveryCandidate {
  if (!data || data.version !== 2 || data.kind !== "adventure-campaign-backup")
    fail(
      "CAMPAIGN_VERSION",
      "Unsupported campaign/container version; export original or use the matching archived build.",
    );
  try {
    record(data, [
      "version",
      "kind",
      "gameId",
      "characterId",
      "slot",
      "generation",
      "current",
      "previous",
      "original",
    ]);
  } catch {
    return fail("CAMPAIGN_FIELDS", "Unknown or missing backup fields.");
  }
  if (
    data.gameId !== defs.gameId ||
    data.characterId !== defs.characterId ||
    data.slot !== stableSlot(slot)
  )
    fail("CAMPAIGN_IDENTITY", "Backup game, character or slot does not match.");
  if (
    typeof data.generation !== "number" ||
    !Number.isSafeInteger(data.generation) ||
    data.generation < 0 ||
    Object.is(data.generation, -0)
  )
    fail("CAMPAIGN_GENERATION", "Invalid backup generation.");
  // Explicit recovery can bypass a corrupt current hash, never its byte/shape bounds.
  const current = readEntry(data.current, selected === "current");
  const previous = data.previous === null ? null : readEntry(data.previous);
  const original = data.original === null ? null : readEntry(data.original);
  checkOriginal(original);
  const payload = selected === "previous" ? previous : current;
  if (payload === null)
    fail("CAMPAIGN_PREVIOUS", "No previous committed campaign is retained.");
  if (selected === "current" && previous !== null)
    validatePayload(defs, previous);
  const state = validatePayload(defs, payload);
  return {
    state,
    payload: serializeCampaign(defs, state.campaign),
    previous,
    original,
    generation: data.generation,
    migrated: false,
  };
}
