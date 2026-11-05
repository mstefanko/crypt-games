/** Validate descriptors before reading values: imported accessors never run. */
export function assertCavePlainData(value: unknown, byteLimit = 4194304): void {
  let nodes = 0,
    bytes = 0;
  const seen = new Set<object>();
  const add = (n: number) => {
    bytes += n;
    if (bytes > byteLimit) throw Error("cave data: UTF-8 byte budget exceeded");
  };
  function stringBytes(s: string): void {
    add(2);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 34 || c === 92) add(2);
      else if (c === 8 || c === 9 || c === 10 || c === 12 || c === 13) add(2);
      else if (c < 32) add(6);
      else if (c < 128) add(1);
      else if (c < 2048) add(2);
      else if (
        c >= 55296 &&
        c <= 56319 &&
        i + 1 < s.length &&
        s.charCodeAt(i + 1) >= 56320 &&
        s.charCodeAt(i + 1) <= 57343
      ) {
        add(4);
        i++;
      } else if (c >= 55296 && c <= 57343) add(6);
      else add(3);
    }
  }
  function visit(v: unknown, depth: number): void {
    if (++nodes > 150000 || depth > 24)
      throw Error("cave data: structural budget exceeded");
    if (v === null || typeof v === "boolean") {
      add(v === null ? 4 : v ? 4 : 5);
      return;
    }
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v) || Object.is(v, -0))
        throw Error("cave data: noncanonical number");
      add(String(v).length);
      return;
    }
    if (typeof v === "string") {
      if (v.length > byteLimit)
        throw Error("cave data: string budget exceeded");
      stringBytes(v);
      return;
    }
    if (typeof v !== "object") throw Error("cave data: expected plain data");
    if (seen.has(v)) throw Error("cave data: cyclic reference");
    seen.add(v);
    const array = Array.isArray(v),
      proto = Object.getPrototypeOf(v);
    if (proto !== (array ? Array.prototype : Object.prototype))
      throw Error("cave data: invalid prototype");
    const keys = Reflect.ownKeys(v);
    if (keys.length > 32769) throw Error("cave data: member budget exceeded");
    if (
      array &&
      ((v as unknown[]).length > 32768 ||
        keys.length !== (v as unknown[]).length + 1)
    )
      throw Error("cave data: sparse/oversized array");
    add(2);
    let count = 0;
    for (const key of keys) {
      if (typeof key !== "string") throw Error("cave data: symbol key");
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (!("value" in d) || (key !== "length" && !d.enumerable))
        throw Error("cave data: accessor or hidden property");
      if (array && key === "length") continue;
      if (array && !/^(0|[1-9][0-9]*)$/.test(key))
        throw Error("cave data: array property");
      if (count++) add(1);
      if (!array) {
        stringBytes(key);
        add(1);
      }
      visit(d.value, depth + 1);
    }
    seen.delete(v);
  }
  visit(value, 0);
}
export function caveRecord(
  v: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw Error(`${path}: expected object`);
  const o = v as Record<string, unknown>;
  if (
    Object.keys(o).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(o, k))
  )
    throw Error(`${path}: unknown/missing field`);
  return o;
}
export function caveInteger(
  v: unknown,
  min: number,
  max: number,
  path: string,
): number {
  if (
    typeof v !== "number" ||
    !Number.isSafeInteger(v) ||
    Object.is(v, -0) ||
    v < min ||
    v > max
  )
    throw Error(`${path}: expected integer [${min},${max}]`);
  return v;
}
export function caveId(v: unknown, path: string): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/.test(v))
    throw Error(`${path}: invalid ID`);
  return v;
}
export function caveArray(v: unknown, max: number, path: string): unknown[] {
  if (!Array.isArray(v) || v.length > max)
    throw Error(`${path}: expected array <=${max}`);
  return v;
}
export function caveClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
export function caveFreeze<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const child of Object.values(v)) caveFreeze(child);
    Object.freeze(v);
  }
  return v;
}
