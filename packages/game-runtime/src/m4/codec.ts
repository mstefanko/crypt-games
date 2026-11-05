import {
  boundedJSON,
  canonical,
  record,
  integer,
  string,
  array,
  boolean,
} from "../../../game-project/src/runtime";
export { canonical, record, integer, string, array, boolean };
export const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
export const MAX_COMMANDS = 200000;
export function detached<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}
export function parseBounded(v: unknown, cap = MAX_ARTIFACT_BYTES): unknown {
  if (typeof v === "string")
    return boundedJSON(v, cap, { rejectNegativeZero: true });
  // Bound structured input before stringification (including cycles and deep graphs).
  let budget = cap,
    nodes = 0;
  const seen = new Set<object>();
  function visit(x: unknown, depth: number): void {
    if (++nodes > 8000000 || depth > 32)
      throw Error("M4_LIMIT: excessive input structure");
    if (x === null || typeof x === "boolean") {
      budget -= 5;
    } else if (typeof x === "string") {
      if (x.length > budget)
        throw Error("M4_LIMIT: input byte budget exceeded");
      budget -= new TextEncoder().encode(x).length + 2;
    } else if (typeof x === "number") {
      if (!Number.isFinite(x) || Object.is(x, -0))
        throw Error("M4_VALUE: invalid number");
      budget -= 24;
    } else if (typeof x === "object") {
      if (seen.has(x)) throw Error("M4_VALUE: cyclic input");
      seen.add(x);
      if (
        !Array.isArray(x) &&
        Object.getPrototypeOf(x) !== Object.prototype &&
        Object.getPrototypeOf(x) !== null
      )
        throw Error("M4_VALUE: expected JSON data");
      for (const [k, v] of Object.entries(x)) {
        budget -= k.length * 3 + 4;
        visit(v, depth + 1);
      }
      seen.delete(x);
    } else throw Error("M4_VALUE: expected JSON data");
    if (budget < 0) throw Error("M4_LIMIT: input byte budget exceeded");
  }
  visit(v, 0);
  return boundedJSON(JSON.stringify(v), cap, { rejectNegativeZero: true });
}
export async function sha256(bytes: string | Uint8Array): Promise<string> {
  const input =
    typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return (
    "sha256:" +
    Array.from(
      new Uint8Array(
        await globalThis.crypto.subtle.digest("SHA-256", input as BufferSource),
      ),
      (n) => n.toString(16).padStart(2, "0"),
    ).join("")
  );
}
export function hashId(v: unknown): string {
  if (typeof v !== "string" || !/^sha256:[a-f0-9]{64}$/.test(v))
    throw Error("M4_HASH: expected SHA-256");
  return v;
}
export function text(v: unknown, cap = 4096): string {
  if (
    typeof v !== "string" ||
    v.length > cap ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)
  )
    throw Error("M4_TEXT: invalid bounded text");
  return v;
}
export function firstDifference(
  a: unknown,
  b: unknown,
  path = "",
): string | null {
  if (Object.is(a, b)) return null;
  if (
    !a ||
    !b ||
    typeof a !== "object" ||
    typeof b !== "object" ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return path || "/";
  const x = a as Record<string, unknown>,
    y = b as Record<string, unknown>;
  for (const k of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) {
    const p = path + "/" + k.replaceAll("~", "~0").replaceAll("/", "~1");
    if (!Object.hasOwn(x, k) || !Object.hasOwn(y, k)) return p;
    const d = firstDifference(x[k], y[k], p);
    if (d) return d;
  }
  return null;
}
