/** Reject accessors and hidden/sparse entries without reading array elements. */
export function requireNavigationDataElements(value: readonly unknown[]): void {
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
      throw Error("Navigation data array required");
  }
}

/** Shared descriptor-safe traversal. Canonical copies are only needed by saves. */
function navigationData(value: unknown, canonicalize: boolean): unknown {
  let nodes = 0;
  function walk(v: unknown, depth: number): unknown {
    if (++nodes > 3000000 || depth > 12)
      throw Error("Navigation checkpoint cap");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v) || Object.is(v, -0) || v < -1)
        throw Error("Invalid navigation integer");
      return v;
    }
    if (typeof v === "string" && v.length <= 64) return v;
    if (Array.isArray(v)) {
      if (
        v.length > 8192 ||
        Object.getPrototypeOf(v) !== Array.prototype ||
        Reflect.ownKeys(v).length !== v.length + 1
      )
        throw Error("Navigation array cap");
      requireNavigationDataElements(v);
      if (canonicalize) return Array.from(v, (x) => walk(x, depth + 1));
      for (const item of v) walk(item, depth + 1);
      return undefined;
    }
    if (
      !v ||
      typeof v !== "object" ||
      Object.getPrototypeOf(v) !== Object.prototype
    )
      throw Error("Navigation plain data required");
    const result: Record<string, unknown> | undefined = canonicalize
      ? {}
      : undefined;
    const ownKeys = Reflect.ownKeys(v);
    if (
      ownKeys.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
        return !descriptor.enumerable || !("value" in descriptor);
      })
    )
      throw Error("Navigation data properties required");
    if (ownKeys.some((key) => typeof key !== "string"))
      throw Error("Navigation key");
    const keys = canonicalize
      ? (ownKeys as string[]).sort()
      : (ownKeys as string[]);
    if (keys.length > 24) throw Error("Navigation object cap");
    for (const key of keys) {
      if (key.length > 64 || key === "__proto__") throw Error("Navigation key");
      const item = walk((v as Record<string, unknown>)[key], depth + 1);
      if (result) result[key] = item;
    }
    return result;
  }
  return walk(value, 0);
}

/** Live ingress validates bounded plain data without serialization or copies. */
export function assertNavigationData(value: unknown): void {
  navigationData(value, false);
}

/** Bounds traversal before replay; rejects sparse/exotic/cyclic/oversized data. */
export function canonicalNavigationData(value: unknown): string {
  return JSON.stringify(navigationData(value, true));
}
