export * from "./types";
/** CSP-safe bounded primitives shared by content and checkpoint codecs. */
export function record(
  value: unknown,
  keys: readonly string[],
  path = "",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error(`${path}: expected object`);
  const o = value as Record<string, unknown>;
  if (
    Object.keys(o).some((k) => !keys.includes(k)) ||
    keys.some((k) => !Object.hasOwn(o, k))
  )
    throw Error(`${path}: unknown or missing field`);
  return o;
}
export function integer(
  v: unknown,
  min: number,
  max: number,
  path = "",
): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max)
    throw Error(`${path}: expected integer in [${min}, ${max}]`);
  return v === 0 ? 0 : v;
}
export function string(v: unknown, path = ""): string {
  if (typeof v !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(v))
    throw Error(`${path}: invalid stable ID`);
  return v;
}
export function boolean(v: unknown): boolean {
  if (typeof v !== "boolean") throw Error("expected boolean");
  return v;
}
export function array(v: unknown, cap: number, path = ""): unknown[] {
  if (!Array.isArray(v) || v.length > cap)
    throw Error(`${path}: expected array <= ${cap}`);
  return v;
}
export function boundedJSON(
  source: string,
  limit = 2097152,
  options: { rejectNegativeZero?: boolean } = {},
): unknown {
  // UTF-8 length without requiring TextEncoder or another host global.
  let bytes = 0,
    depth = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i);
    bytes +=
      c < 128
        ? 1
        : c < 2048
          ? 2
          : c >= 55296 &&
              c <= 56319 &&
              i + 1 < source.length &&
              source.charCodeAt(i + 1) >= 56320 &&
              source.charCodeAt(i + 1) <= 57343
            ? (i++, 4)
            : 3;
    if (bytes > limit) throw Error("JSON byte limit exceeded");
  }
  const stack: { object: boolean; keyExpected: boolean; keys: Set<string> }[] =
    [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      const start = i;
      let escaped = false;
      for (i++; i < source.length; i++) {
        if (escaped) escaped = false;
        else if (source[i] === "\\") escaped = true;
        else if (source[i] === '"') break;
      }
      const frame = stack[stack.length - 1];
      if (frame?.object && frame.keyExpected) {
        const key = JSON.parse(source.slice(start, i + 1)) as string;
        if (frame.keys.has(key)) throw Error("Duplicate JSON object key");
        frame.keys.add(key);
        frame.keyExpected = false;
      }
    } else if (c === "{" || c === "[") {
      if (++depth > 32) throw Error("JSON nesting limit exceeded");
      stack.push({
        object: c === "{",
        keyExpected: c === "{",
        keys: new Set(),
      });
    } else if (c === "}" || c === "]") {
      depth--;
      stack.pop();
    } else if (c === ",") {
      const frame = stack[stack.length - 1];
      if (frame?.object) frame.keyExpected = true;
    } else if (
      options.rejectNegativeZero &&
      (c === "-" || (c >= "0" && c <= "9"))
    ) {
      const start = i;
      while (i + 1 < source.length && /[0-9eE+.-]/.test(source[i + 1])) i++;
      if (Object.is(Number(source.slice(start, i + 1)), -0))
        throw Error("Negative zero is not canonical checkpoint state");
    }
  }
  return JSON.parse(source);
}
export function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}
