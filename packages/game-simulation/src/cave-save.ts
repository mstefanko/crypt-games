/** Fixed admission proof: no serialization or state traversal occurs in step(). */
export const CAVE_CHECKPOINT_BYTES = 4 * 1024 * 1024;
export const CAVE_PROGRESS_BYTES = 1024 * 1024;
export const CAVE_RULES_VERSION = "cave-integer-x-y-support-n0-v1";
/** Upper bounds include commas, signs, keys and 16-digit safe integer clocks.
 * N0: each search has distance/parent/closed/frontier/path <=4096 entries;
 * cell IDs/distances <=4095 (5 bytes incl comma), parents add a minus sign.
 * Remaining envelopes cover full terrain, receipts and all small owner fields.
 * Diagnostic history is presentation evidence and is excluded from saves.
 */
export function caveCheckpointAdmissionBound(
  contentBytes: number,
  droneCount: number,
): number {
  if (
    !Number.isSafeInteger(contentBytes) ||
    contentBytes < 0 ||
    contentBytes > 524288 ||
    !Number.isInteger(droneCount) ||
    droneCount < 0 ||
    droneCount > 7
  )
    throw Error("Cave save admission inputs");
  const terrain = 16384 * 12 + 64 * 32 + 1024;
  const navigation = droneCount * (5 * 4096 * 6 + 2048) + 3 * 4096 * 3 + 16384;
  const routes = droneCount * (4096 * 6 + 1024);
  const events = 1280 * 1024 + 256 * 512;
  const bound = contentBytes + terrain + navigation + routes + events + 65536;
  if (bound > CAVE_CHECKPOINT_BYTES)
    throw Error("Cave worst-case checkpoint exceeds 4MiB");
  return bound;
}
/** Safe-base progress resets search work and recent receipts before encoding. */
export function caveProgressAdmissionBound(contentBytes: number): number {
  if (
    !Number.isSafeInteger(contentBytes) ||
    contentBytes < 0 ||
    contentBytes > 524288
  )
    throw Error("Cave progress admission inputs");
  const bound =
    contentBytes +
    (16384 * 12 + 64 * 32 + 1024) +
    (3 * 4096 * 3 + 16384) +
    65536 +
    1024;
  if (bound > CAVE_PROGRESS_BYTES)
    throw Error("Cave worst-case progress exceeds 1MiB");
  return bound;
}
export function caveFields(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    throw Error("Invalid cave fields");
}
export function caveInteger(
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < min ||
    value > max
  )
    throw Error("Invalid cave integer");
}
/** Strict data validation before reading imported properties. Also measures UTF-8 JSON bytes. */
export function caveDataBytes(
  value: unknown,
  limit = CAVE_CHECKPOINT_BYTES,
): number {
  let bytes = 0,
    nodes = 0;
  const add = (n: number) => {
    bytes += n;
    if (bytes > limit) throw Error("Cave artifact byte cap");
  };
  const string = (s: string) => {
    let n = 2;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 34 || c === 92) n += 2;
      else if (c < 32) n += 6;
      else if (c < 128) n++;
      else if (c < 2048) n += 2;
      else if (
        c >= 55296 &&
        c <= 56319 &&
        s.charCodeAt(i + 1) >= 56320 &&
        s.charCodeAt(i + 1) <= 57343
      ) {
        n += 4;
        i++;
      } else if (c >= 55296 && c <= 57343) n += 6;
      else n += 3;
    }
    return n;
  };
  const walk = (v: unknown, depth: number) => {
    if (++nodes > 500000 || depth > 20)
      throw Error("Cave artifact structure cap");
    if (v === null) {
      add(4);
      return;
    }
    if (typeof v === "boolean") {
      add(v ? 4 : 5);
      return;
    }
    if (typeof v === "number") {
      caveInteger(v, -1);
      add(String(v).length);
      return;
    }
    if (typeof v === "string") {
      if (v.length > 128) throw Error("Cave string cap");
      add(string(v));
      return;
    }
    if (Array.isArray(v)) {
      if (
        v.length > 16384 ||
        Object.getPrototypeOf(v) !== Array.prototype ||
        Reflect.ownKeys(v).length !== v.length + 1
      )
        throw Error("Cave dense array required");
      add(2 + Math.max(0, v.length - 1));
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d || !d.enumerable || !("value" in d))
          throw Error("Cave array data required");
        walk(d.value, depth + 1);
      }
      return;
    }
    if (
      !v ||
      typeof v !== "object" ||
      Object.getPrototypeOf(v) !== Object.prototype
    )
      throw Error("Cave plain data required");
    const keys = Reflect.ownKeys(v);
    if (keys.length > 32) throw Error("Cave object cap");
    add(2 + Math.max(0, keys.length - 1));
    for (const key of keys) {
      if (typeof key !== "string" || key.length > 64 || key === "__proto__")
        throw Error("Cave data key");
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (!d.enumerable || !("value" in d))
        throw Error("Cave data properties required");
      add(string(key) + 1);
      walk(d.value, depth + 1);
    }
  };
  walk(value, 0);
  return bytes;
}
export const caveCopy = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;
