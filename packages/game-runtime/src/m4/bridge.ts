/** Development-only operation grants, not authentication within the same realm. */
export const LAB_PROTOCOL = 1;
export const LAB_CAPABILITIES = [
  "observe",
  "control",
  "checkpoint",
  "artifact",
] as const;
export type LabCapability = (typeof LAB_CAPABILITIES)[number];
export const LAB_OPERATIONS = {
  observe: "observe",
  pause: "control",
  reset: "control",
  load: "control",
  step: "control",
  checkpoint: "checkpoint",
  restore: "checkpoint",
  record: "artifact",
  export: "artifact",
  import: "artifact",
  replay: "artifact",
  seek: "artifact",
  seekClock: "artifact",
} as const;
export type LabOperation = keyof typeof LAB_OPERATIONS;
export interface LabRequest {
  type: "pocket-lab-request";
  protocol: 1;
  session: string;
  requestId: string;
  capability: LabCapability;
  operation: LabOperation;
  revision: number;
  epoch: number;
  payload: unknown;
}
export interface LabResponse {
  type: "pocket-lab-response";
  protocol: 1;
  session: string;
  requestId: string;
  revision: number;
  epoch: number;
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string };
}
export interface LabAdapter {
  /** Validate and stage without mutation; returned synchronous commit cannot reject. */
  prepareReplacement?(
    operation: "reset" | "load",
    payload: unknown,
  ): () => unknown;
  dispatch(
    operation: LabOperation,
    payload: unknown,
    signal: AbortSignal,
  ): unknown | Promise<unknown>;
  dispose?(): void;
}
export interface LabBridgeOptions {
  origin: string;
  source: unknown;
  session: string;
  capabilities: readonly LabCapability[];
  adapter: LabAdapter;
}
const mutation = (op: LabOperation) =>
  !["observe", "checkpoint", "export"].includes(op);
const ownKeys = [
  "type",
  "protocol",
  "session",
  "requestId",
  "capability",
  "operation",
  "revision",
  "epoch",
  "payload",
]
  .sort()
  .join();
function detachedBounded(value: unknown): unknown {
  let nodes = 0,
    budget = 32 * 1024 * 1024;
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > 1000000 || depth > 32)
      throw Error("Payload structure exceeds limits");
    if (typeof v === "string") {
      if (v.length > budget) throw Error("Payload exceeds 32 MiB");
      budget -= new TextEncoder().encode(v).byteLength + 2;
    } else if (v === null || typeof v === "boolean") budget -= 5;
    else if (typeof v === "number" && Number.isFinite(v) && !Object.is(v, -0))
      budget -= 24;
    else {
      if (
        !v ||
        typeof v !== "object" ||
        Object.getPrototypeOf(v) !==
          (Array.isArray(v) ? Array.prototype : Object.prototype)
      )
        throw Error("Payload must be plain JSON");
      const descriptors = Object.getOwnPropertyDescriptors(v);
      if (Object.getOwnPropertySymbols(v).length)
        throw Error("Payload must have JSON keys");
      const isArray = Array.isArray(v);
      const entries = Object.entries(descriptors).filter(
        ([key]) => !(isArray && key === "length"),
      );
      if (isArray && (v.length > 1000000 || entries.length !== v.length))
        throw Error("Payload arrays must be bounded and dense");
      const copy: Record<string, unknown> | unknown[] = isArray ? [] : {};
      for (const [key, descriptor] of entries) {
        if (!("value" in descriptor) || !descriptor.enumerable)
          throw Error("Payload must contain enumerable data, not accessors");
        if (
          isArray &&
          (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= v.length)
        )
          throw Error("Payload arrays must have only indexed entries");
        budget -= key.length * 3 + 4;
        Object.defineProperty(copy, key, {
          value: visit(descriptor.value, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      if (budget < 0) throw Error("Payload exceeds 32 MiB");
      return copy;
    }
    if (budget < 0) throw Error("Payload exceeds 32 MiB");
    return v;
  };
  return visit(value, 0);
}
export function createLabBridge(options: LabBridgeOptions) {
  let origin: URL;
  try {
    origin = new URL(options.origin);
  } catch {
    throw Error(
      "Lab bridge requires an HTTP(S) origin; file:// is unsupported",
    );
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.origin !== options.origin
  )
    throw Error(
      "Lab bridge requires an HTTP(S) origin; file:// is unsupported",
    );
  const capabilities = new Set(options.capabilities);
  let revision = 0,
    epoch = 0,
    disposed = false,
    busy = false;
  const used = new Set<string>(),
    controllers = new Set<AbortController>();
  const snapshot = () => ({
    session: options.session,
    revision,
    epoch,
    protocol: LAB_PROTOCOL,
    capabilities: [...capabilities],
  });
  const cancel = () => {
    epoch++;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    busy = false;
  };
  async function handle(event: {
    origin: string;
    source: unknown;
    data: unknown;
  }): Promise<LabResponse | null> {
    if (event.origin !== options.origin || event.source !== options.source)
      return null;
    let raw: Partial<LabRequest> | null;
    try {
      raw = detachedBounded(event.data) as Partial<LabRequest> | null;
    } catch (error) {
      // Do not evaluate accessors, even to correlate an invalid direct call.
      const id =
        event.data && typeof event.data === "object"
          ? Object.getOwnPropertyDescriptor(event.data, "requestId")?.value
          : undefined;
      return {
        type: "pocket-lab-response",
        protocol: 1,
        session: options.session,
        requestId: typeof id === "string" ? id : "invalid",
        revision,
        epoch,
        ok: false,
        error: {
          code: "PAYLOAD",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (!raw || raw.type !== "pocket-lab-request") return null;
    const reply = (
      ok: boolean,
      value?: unknown,
      code?: string,
      message?: string,
    ): LabResponse => ({
      type: "pocket-lab-response",
      protocol: 1,
      session: options.session,
      requestId: typeof raw.requestId === "string" ? raw.requestId : "invalid",
      revision,
      epoch,
      ok,
      ...(ok ? { value } : { error: { code: code!, message: message! } }),
    });
    if (disposed)
      return reply(false, undefined, "DISPOSED", "Lab mount was disposed");
    if (
      Object.keys(raw).sort().join() !== ownKeys ||
      raw.protocol !== 1 ||
      typeof raw.requestId !== "string" ||
      !/^[a-zA-Z0-9._:-]{1,128}$/.test(raw.requestId)
    )
      return reply(
        false,
        undefined,
        "PROTOCOL",
        "Invalid request fields, version, or request ID",
      );
    if (raw.session !== options.session)
      return reply(
        false,
        undefined,
        "SESSION",
        "Stale or unknown mount session",
      );
    // Check before stale-revision errors: a retransmission must never replace
    // the original terminal reply, even after its mutation has completed.
    if (used.has(raw.requestId))
      return reply(
        false,
        undefined,
        "DUPLICATE",
        "Request ID already consumed",
      );
    if (
      typeof raw.operation !== "string" ||
      !Object.hasOwn(LAB_OPERATIONS, raw.operation)
    )
      return reply(false, undefined, "OPERATION", "Unsupported operation");
    const operation = raw.operation as LabOperation;
    if (
      raw.capability !== LAB_OPERATIONS[operation] ||
      !capabilities.has(raw.capability)
    )
      return reply(
        false,
        undefined,
        "CAPABILITY",
        "Operation capability was not granted",
      );
    if (
      !Number.isSafeInteger(raw.revision) ||
      !Number.isSafeInteger(raw.epoch) ||
      raw.revision !== revision ||
      raw.epoch !== epoch
    )
      return reply(false, undefined, "CONFLICT", "Revision or epoch is stale");
    if (
      mutation(operation) &&
      busy &&
      operation !== "reset" &&
      operation !== "load"
    )
      return reply(false, undefined, "BUSY", "A mutation is already pending");
    let replacement: (() => unknown) | undefined;
    if (operation === "reset" || operation === "load") {
      try {
        if (!options.adapter.prepareReplacement)
          throw Error("Adapter does not support staged replacement");
        replacement = options.adapter.prepareReplacement(
          operation,
          raw.payload,
        );
      } catch (error) {
        return reply(
          false,
          undefined,
          "REJECTED",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    if (used.size >= 200000)
      return reply(
        false,
        undefined,
        "LIMIT",
        "Mount request limit reached; remount the Lab",
      );
    used.add(raw.requestId);
    if (replacement) cancel();
    const controller = new AbortController(),
      operationEpoch = epoch;
    controllers.add(controller);
    if (mutation(operation)) busy = true;
    try {
      const value = await (replacement
        ? replacement()
        : options.adapter.dispatch(operation, raw.payload, controller.signal));
      if (disposed || controller.signal.aborted || operationEpoch !== epoch)
        return reply(
          false,
          undefined,
          "CANCELLED",
          "Request belongs to a cancelled epoch",
        );
      if (mutation(operation)) revision++;
      return reply(true, detachedBounded(value));
    } catch (error) {
      return reply(
        false,
        undefined,
        controller.signal.aborted ? "CANCELLED" : "REJECTED",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      controllers.delete(controller);
      if (operationEpoch === epoch && mutation(operation)) busy = false;
    }
  }
  return {
    handle,
    snapshot,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      options.adapter.dispose?.();
    },
  };
}
