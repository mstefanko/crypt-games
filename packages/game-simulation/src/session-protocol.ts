/** Minimal inspection protocol proven by Skyline; commands and results remain owner-specific. */
export interface CommandMetadata {
  readonly sequence?: number;
  readonly revision?: number;
}
export interface SnapshotIdentity {
  readonly kind: string;
  readonly version: number;
  readonly contentId: string;
  readonly rulesBuildId: string;
  readonly seed: number;
}
export interface OrderedSessionEvent {
  readonly sequence: number;
  readonly tick: number;
  readonly sourceId: string;
  readonly kind: string;
}
/** No browser clock, event subscription, implicit stepping or renderer lifetime. */
export interface SessionProtocol<
  Command,
  Observation,
  Event,
  Snapshot,
  Result = boolean,
> {
  command(command: Command): Result;
  step(dt: number): void;
  observe(): Observation;
  drainEvents(): Event[];
  snapshot(): Snapshot;
  restore(value: unknown): void;
}
/** Machine-readable discovery accompanies a concrete owner's own TypeScript schemas. */
export interface SessionProtocolDescriptor {
  readonly protocolVersion: 1;
  readonly owner: string;
  readonly observationSchema: string;
  readonly snapshot: Omit<SnapshotIdentity, "seed">;
  readonly commands: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly semantics: {
    readonly commandResult: string;
    readonly metadata: string;
    readonly step: string;
    readonly events: string;
    readonly restore: string;
  };
}

/** Version 1: finite JSON numbers unchanged, sorted object keys, ordered arrays. */
export function canonicalJson(value: unknown): string {
  function project(v: unknown, array = false): unknown {
    if (v === undefined) {
      if (array) throw new Error("Undefined array element");
      return undefined;
    }
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error("Nonfinite number");
      return v;
    }
    if (Array.isArray(v)) return Array.from(v, (x) => project(x, true));
    if (typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype)
      throw new Error("Non-JSON value");
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, project((v as Record<string, unknown>)[k])]),
    );
  }
  if (value === undefined) throw new Error("Undefined root");
  return JSON.stringify(project(value));
}
export function firstDivergence(
  a: unknown,
  b: unknown,
  path = "$",
): { path: string; expected: unknown; actual: unknown } | undefined {
  if (Object.is(a, b)) return;
  if (
    a &&
    b &&
    typeof a === "object" &&
    typeof b === "object" &&
    Array.isArray(a) === Array.isArray(b)
  ) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      const found = firstDivergence(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`,
      );
      if (found) return found;
    }
    if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length)
      return { path: `${path}.length`, expected: a.length, actual: b.length };
    return;
  }
  return { path, expected: a, actual: b };
}
