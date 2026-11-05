/** Internal C1 ingress helpers. Inspect descriptors before reading untrusted data. */
export function characterPlain(value: unknown): unknown {
  let nodes = 0;
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > 100_000 || depth > 16) throw Error("Character data work cap");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string" && v.length <= 128) return v;
    if (typeof v === "number" && Number.isSafeInteger(v) && !Object.is(v, -0))
      return v;
    if (!v || typeof v !== "object")
      throw Error("Character plain data required");
    const keys = Reflect.ownKeys(v);
    if (Array.isArray(v)) {
      if (
        Object.getPrototypeOf(v) !== Array.prototype ||
        v.length > 256 ||
        keys.length !== v.length + 1
      )
        throw Error("Invalid character array");
      const result: unknown[] = [];
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d || !Object.hasOwn(d, "value"))
          throw Error("Character accessor or sparse array");
        result.push(visit(d.value, depth + 1));
      }
      return result;
    }
    if (
      Object.getPrototypeOf(v) !== Object.prototype ||
      keys.length > 32 ||
      keys.some(
        (k) => typeof k !== "string" || k === "__proto__" || k.length > 128,
      )
    )
      throw Error("Invalid character object");
    const result: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (!Object.hasOwn(d, "value") || !d.enumerable)
        throw Error("Character accessor or hidden property");
      result[key] = visit(d.value, depth + 1);
    }
    return result;
  };
  return visit(value, 0);
}
export function characterFields(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    throw Error("Unknown or missing character field");
  return value as Record<string, unknown>;
}
export function characterList(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw Error("Character list cap exceeded");
  return value;
}
export function characterInteger(
  value: unknown,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < min ||
    value > max
  )
    throw Error("Invalid character integer");
  return value;
}
export function characterId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value)
  )
    throw Error("Invalid character ID");
  return value;
}
export const compareCharacterBuildId = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
