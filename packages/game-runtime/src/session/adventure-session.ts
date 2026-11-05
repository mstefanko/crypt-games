/** Adventure authority and asynchronous operation ownership; presentation/storage stay in adapters. */
import { canonical } from "../../../game-project/src/runtime";
import {
  serializeAdventureCheckpoint,
  serializeCampaign,
  type AdventureCommand,
  type AdventureDefinitions,
  type AdventureState,
} from "../../../game-simulation/src/m3/adventure";
import {
  createAdventureExecution,
  executeAdventureCommand,
  prepareAdventureTravel,
  commitAdventureTravel,
  restoreAdventureExact,
} from "./execution";
import type { ProfileIdentity } from "../../../game-simulation/src/m3/grid";
import { snapshotDefinitions } from "../m3/project";
import { inputBytes, prepareCampaignRecovery } from "../m5/campaign-codec";

export type AdventureIntent = AdventureCommand extends infer Command
  ? Command extends AdventureCommand
    ? Omit<Command, "revision" | "sequence">
    : never
  : never;
export type AdventurePublication = "durable" | "memory" | undefined;
interface OperationAdapter {
  /** Presentation generation is separate from committed adventure ownership. */
  isCurrent?: () => boolean;
  onStart?: () => void;
  /** Called only when this operation still owns the pending slot. */
  onFinish?: () => void;
  loadMap?: (mapId: string, signal: AbortSignal) => Promise<string>;
}
export interface AdventureTravelAdapter extends OperationAdapter {
  onReady?: () => void;
}
export interface AdventureRecoveryAdapter extends OperationAdapter {
  preflight?: (candidate: AdventureState) => void;
  /** Reads through observation() now see the temporarily staged candidate. */
  stage?: () => void;
  publish?: (payload: string, original: string | null) => AdventurePublication;
  adopt?: (publication: AdventurePublication) => void;
  rollback?: () => void;
}
export interface AdventureImportAdapter {
  isCurrent?: () => boolean;
  /** Retain bounded exact bytes before a changed-baseline rejection. */
  receive?: (bytes: Uint8Array) => void;
}
interface Operation {
  controller: AbortController;
  kind: "travel" | "recovery" | "import";
  expectedMap: string;
  baseline: string;
  isCurrent?: () => boolean;
}
export class AdventureRecoveryError extends Error {
  readonly cleanupErrors: unknown[] = [];
  constructor(
    message: string,
    readonly published: boolean,
  ) {
    super(message);
    this.name = "AdventureRecoveryError";
  }
}
/** Adapters must finish synchronously inside the publication boundary. */
function synchronous<T>(value: T): T {
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  )
    throw Error("Adventure publication callbacks must be synchronous");
  return value;
}

export class AdventureSession {
  private readonly definitions: AdventureDefinitions;
  private readonly identity: ProfileIdentity;
  private state: AdventureState;
  private operation?: Operation;
  private disposed = false;

  constructor(definitions: AdventureDefinitions, identity: ProfileIdentity) {
    this.definitions = snapshotDefinitions(definitions);
    this.identity = snapshotDefinitions(identity);
    this.state = createAdventureExecution(this.definitions);
  }
  get pending(): boolean {
    return this.operation !== undefined;
  }
  get mapLoading(): boolean {
    return this.operation !== undefined && this.operation.kind !== "import";
  }
  observation(): AdventureState {
    return structuredClone(this.state);
  }
  campaignBytes(): string {
    return serializeCampaign(this.definitions, this.state.campaign);
  }
  checkpoint(): string {
    return serializeAdventureCheckpoint(
      this.definitions,
      this.state,
      this.identity,
    );
  }
  command(
    intent: AdventureIntent,
  ):
    | { ok: true; rewardStarted: boolean; sequence: number }
    | { ok: false; error: string } {
    if (this.disposed)
      return { ok: false, error: "Adventure session disposed" };
    const wasReward = Object.values(this.state.campaign.quests).includes(
      "complete",
    );
    const result = executeAdventureCommand(this.definitions, this.state, {
      ...intent,
      revision: this.state.campaign.revision,
      sequence: this.state.campaign.sequence + 1,
    });
    if (!result.ok) return { ok: false, error: result.error };
    this.state = result.state;
    return {
      ok: true,
      rewardStarted:
        !wasReward &&
        Object.values(this.state.campaign.quests).includes("complete"),
      sequence: this.state.campaign.sequence,
    };
  }
  reset(): void {
    this.available();
    const next = createAdventureExecution(this.definitions);
    this.cancelPending();
    this.state = next;
  }
  restore(bytes: string): void {
    this.available();
    // Rejected exact imports must leave a valid pending operation alive.
    const next = restoreAdventureExact(this.definitions, this.identity, bytes);
    this.cancelPending();
    this.state = next;
  }
  cancelPending(): void {
    this.operation?.controller.abort();
    this.operation = undefined;
  }
  dispose(): void {
    this.disposed = true;
    this.cancelPending();
  }
  private available(): void {
    if (this.disposed) throw Error("Adventure session disposed");
  }
  private begin(
    kind: Operation["kind"],
    expectedMap: string,
    isCurrent?: () => boolean,
  ): Operation {
    this.available();
    this.cancelPending();
    const operation: Operation = {
      kind,
      expectedMap,
      baseline: canonical(this.state),
      controller: new AbortController(),
      isCurrent,
    };
    this.operation = operation;
    return operation;
  }
  private current(operation: Operation): boolean {
    return (
      !this.disposed &&
      !operation.controller.signal.aborted &&
      this.operation === operation &&
      (operation.isCurrent?.() ?? true) &&
      // An adapter may synchronously transfer ownership while checking validity.
      this.operation === operation &&
      !operation.controller.signal.aborted
    );
  }
  private baseline(operation: Operation, message: string): void {
    if (canonical(this.state) !== operation.baseline) throw Error(message);
  }
  private finish(operation: Operation, callback?: () => void): void {
    if (this.operation !== operation) return;
    this.operation = undefined;
    synchronous(callback?.());
  }
  async readImport(
    read: (signal: AbortSignal) => Promise<Uint8Array>,
    adapter: AdventureImportAdapter = {},
  ): Promise<Uint8Array | undefined> {
    const operation = this.begin(
      "import",
      this.state.active.mapId,
      adapter.isCurrent,
    );
    try {
      const bytes = await read(operation.controller.signal);
      if (!this.current(operation)) return;
      const bounded = new Uint8Array(inputBytes(bytes));
      synchronous(adapter.receive?.(new Uint8Array(bounded)));
      if (!this.current(operation)) return;
      this.baseline(
        operation,
        "Campaign changed while reading file; retry the import.",
      );
      return bounded;
    } catch (error) {
      if (this.current(operation)) throw error;
      return;
    } finally {
      this.finish(operation);
    }
  }
  async travel(
    exitId: string,
    adapter: AdventureTravelAdapter = {},
  ): Promise<boolean> {
    this.available();
    const result = prepareAdventureTravel(this.definitions, this.state, {
      kind: "travel",
      exitId,
      token: `travel:${this.state.campaign.sequence + 1}`,
      revision: this.state.campaign.revision,
      sequence: this.state.campaign.sequence + 1,
    });
    if (!result.ok) throw Error(result.error);
    const operation = this.begin(
      "travel",
      result.transition.targetMapId,
      adapter.isCurrent,
    );
    try {
      synchronous(adapter.onStart?.());
      if (!this.current(operation)) return false;
      const loaded = await (adapter.loadMap?.(
        operation.expectedMap,
        operation.controller.signal,
      ) ?? Promise.resolve(operation.expectedMap));
      if (!this.current(operation)) return false;
      const committed = commitAdventureTravel(
        this.definitions,
        this.state,
        result.transition,
        loaded,
      );
      if (!committed.ok) throw Error(committed.error);
      this.state = committed.state;
      synchronous(adapter.onReady?.());
      return this.current(operation);
    } catch (error) {
      if (this.current(operation)) throw error;
      return false;
    } finally {
      this.finish(operation, adapter.onFinish);
    }
  }
  async recover(
    bytes: string | Uint8Array,
    adapter: AdventureRecoveryAdapter = {},
  ): Promise<boolean> {
    this.available();
    // Validation precedes supersession: malformed recovery cannot kill valid travel.
    const candidate = prepareCampaignRecovery(
      this.definitions,
      inputBytes(bytes),
    );
    const next = candidate.state;
    const operation = this.begin(
      "recovery",
      next.active.mapId,
      adapter.isCurrent,
    );
    const previous = this.state;
    let staged = false,
      published = false;
    let failure: AdventureRecoveryError | undefined;
    const rollback = (ownsState: boolean) => {
      if (!staged || published) return;
      staged = false; // A throwing adapter must never run twice.
      if (ownsState || this.state === next) this.state = previous;
      synchronous(adapter.rollback?.());
    };
    try {
      synchronous(adapter.onStart?.());
      if (!this.current(operation)) return false;
      const loaded = await (adapter.loadMap?.(
        operation.expectedMap,
        operation.controller.signal,
      ) ?? Promise.resolve(operation.expectedMap));
      if (!this.current(operation)) return false;
      this.baseline(
        operation,
        "Campaign changed during recovery; retry from the current state.",
      );
      if (loaded !== operation.expectedMap)
        throw Error("Loaded map identity mismatch");
      synchronous(adapter.preflight?.(structuredClone(next)));
      if (!this.current(operation)) return false;
      this.baseline(
        operation,
        "Campaign changed during recovery; retry from the current state.",
      );
      // No await may split candidate staging, UI preflight, publication and adoption.
      this.state = next;
      staged = true;
      synchronous(adapter.stage?.());
      if (!this.current(operation)) {
        rollback(false);
        return false;
      }
      if (this.state !== next)
        throw Error(
          "Campaign changed during recovery; retry from the current state.",
        );
      const publication = synchronous(
        adapter.publish?.(candidate.payload, candidate.original),
      );
      published = true;
      if (!this.current(operation)) return false;
      synchronous(adapter.adopt?.(publication));
      return this.current(operation);
    } catch (error) {
      const current = this.current(operation);
      failure = new AdventureRecoveryError(
        error instanceof Error ? error.message : String(error),
        published,
      );
      try {
        // Reentrant commands in our uncommitted stage roll back too, but a
        // superseding reset/restore owns its replacement state.
        rollback(current);
      } catch (rollbackError) {
        failure.cleanupErrors.push(rollbackError);
      }
      if (!current) return false;
      throw failure;
    } finally {
      const current = this.current(operation);
      try {
        this.finish(operation, adapter.onFinish);
      } catch (error) {
        if (failure) failure.cleanupErrors.push(error);
        else if (current)
          throw new AdventureRecoveryError(
            error instanceof Error ? error.message : String(error),
            published,
          );
      }
    }
  }
}
