/** Asynchronous resource staging belongs above the synchronous campaign authority. */
import type {
  CompatibilityIdentity,
  GameDefinitions,
  InputFrame,
} from "@onepage/game-project/runtime";
import type { PlatformInputFrameV2 } from "@onepage/game-simulation/platform-input-v2";
import {
  CampaignPlatformOwner,
  CAMPAIGN_PLATFORM_LIMITS,
  type CampaignPlatformDefinition,
  type CampaignEntryPlan,
} from "@onepage/game-simulation/campaign-platform";

export interface CampaignRoomResources {
  readonly roomId: string;
  readonly assetIds: readonly string[];
  /** Release prepared resources. The loader owns cleanup before it returns a handle. */
  dispose(): void;
}
export interface CampaignRoomLoad {
  readonly roomId: string;
  readonly assetIds: readonly string[];
  readonly signal?: AbortSignal;
}
export type CampaignRoomLoader = (
  request: CampaignRoomLoad,
) => Promise<CampaignRoomResources>;
export type CampaignLoadResult = {
  readonly status: "committed" | "stale";
  readonly roomId: string;
};

/** Rejected imports retain the exact supplied text/bytes for external recovery.
 * Version one portable progress has no registered migration. Exact v1/v2 saves
 * belong to restore(), never this portable reader. */
export class CampaignPlatformRecoveryError extends Error {
  constructor(
    readonly original: unknown,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "CampaignPlatformRecoveryError";
  }
}
export type CampaignPlatformRecovery =
  | {
      readonly status: "ready";
      readonly original: string | Uint8Array;
      readonly owner: CampaignPlatformOwner;
      readonly migrated: false;
    }
  | {
      readonly status: "rejected";
      readonly original: unknown;
      readonly error: CampaignPlatformRecoveryError;
    };
export function prepareCampaignPlatformRecovery(
  platform: GameDefinitions,
  identity: CompatibilityIdentity,
  authored: CampaignPlatformDefinition,
  input: unknown,
  createOwner?: () => CampaignPlatformOwner,
): CampaignPlatformRecovery {
  let original = input;
  try {
    if (typeof input !== "string" && !(input instanceof Uint8Array))
      throw Error("Portable campaign input must be text or bytes");
    // Oversized originals remain by reference: do not copy/decode unbounded data.
    if (input.length > CAMPAIGN_PLATFORM_LIMITS.progressBytes)
      throw Error("Portable campaign byte cap exceeded");
    const retained = typeof input === "string" ? input : new Uint8Array(input);
    original = retained;
    const bytes =
      typeof retained === "string"
        ? retained
        : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            retained,
          );
    const owner =
      createOwner?.() ??
      new CampaignPlatformOwner(platform, identity, authored);
    owner.restoreProgress(bytes);
    return { status: "ready", original: retained, owner, migrated: false };
  } catch (cause) {
    const error = new CampaignPlatformRecoveryError(original, cause);
    return { status: "rejected", original, error };
  }
}

/** At most four unresolved loads. Latest request wins, but only a still-current
 * authority revision can commit. Rejected/stale prepared resources are disposed.
 * A successful handle is selected synchronously with authority publication. */
export class CampaignPlatformSession {
  private owner: CampaignPlatformOwner;
  private generation = 0;
  private pending = 0;
  private disposed = false;
  private resources: CampaignRoomResources | null = null;
  private readonly platform: GameDefinitions;
  private readonly identity: CompatibilityIdentity;
  private readonly authored: CampaignPlatformDefinition;
  constructor(
    platform: GameDefinitions,
    identity: CompatibilityIdentity,
    authored: CampaignPlatformDefinition,
    private readonly loadTimeoutMs = 30_000,
    private readonly createOwner?: () => CampaignPlatformOwner,
  ) {
    if (!Number.isSafeInteger(loadTimeoutMs) || loadTimeoutMs < 1)
      throw Error("Invalid campaign load timeout");
    this.platform = structuredClone(platform);
    this.identity = structuredClone(identity);
    this.authored = structuredClone(authored);
    this.owner = this.freshOwner();
  }
  private freshOwner(): CampaignPlatformOwner {
    return (
      this.createOwner?.() ??
      new CampaignPlatformOwner(this.platform, this.identity, this.authored)
    );
  }
  private live(): void {
    if (this.disposed) throw Error("Campaign session disposed");
  }
  /** Detached extension observation. No live authority is exposed. */
  ownerObservation(): unknown {
    return this.owner.observation();
  }
  /** Trusted synchronous assembly callback. Do not retain the staged owner.
   * Throws discard all changes; publication invalidates pending resource loads. */
  changeOwner(operation: (owner: CampaignPlatformOwner) => void): void {
    this.live();
    const staged = this.freshOwner();
    staged.restore(this.owner.checkpoint());
    operation(staged);
    this.owner = staged;
    this.generation++;
  }
  observation() {
    return this.owner.observation();
  }
  checkpoint(): string {
    return this.owner.checkpoint();
  }
  progress(): string {
    return this.owner.progress();
  }
  step(input: InputFrame | PlatformInputFrameV2, ticks = 1): void {
    this.live();
    this.owner.executeFrames(input, ticks);
  }
  pickup(id: string): void {
    this.live();
    this.owner.execute({ kind: "pickup", id });
  }
  setCheckpoint(): void {
    this.live();
    this.owner.execute({ kind: "checkpoint" });
  }
  async travel(
    exitId: string,
    loader: CampaignRoomLoader,
  ): Promise<CampaignLoadResult> {
    this.live();
    return this.load(this.owner.stageEntry("exit", exitId), loader);
  }
  async recover(loader: CampaignRoomLoader): Promise<CampaignLoadResult> {
    this.live();
    return this.load(this.owner.stageEntry("recover"), loader);
  }
  async reset(loader: CampaignRoomLoader): Promise<CampaignLoadResult> {
    this.live();
    return this.load(this.owner.stageEntry("reset"), loader);
  }
  /** Validate and replay an import before requesting resources. On any rejection,
   * the current exact checkpoint and resource handle remain available for export. */
  async restore(
    bytes: string,
    loader: CampaignRoomLoader,
  ): Promise<CampaignLoadResult> {
    this.live();
    this.capacity();
    const next = this.freshOwner();
    next.restore(bytes);
    const observation = next.observation();
    const revision = this.owner.observation().revision;
    return this.load(
      {
        roomId: observation.roomId,
        assets: observation.room.assets,
        revision,
        from: this.owner.observation().roomId,
        exitId: null,
        kind: "reset",
      },
      loader,
      next,
    );
  }
  async restoreProgress(
    input: unknown,
    loader: CampaignRoomLoader,
  ): Promise<CampaignLoadResult> {
    this.live();
    this.capacity();
    const recovery = prepareCampaignPlatformRecovery(
      this.platform,
      this.identity,
      this.authored,
      input,
      this.createOwner,
    );
    if (recovery.status === "rejected") throw recovery.error;
    const next = recovery.owner;
    const observation = next.observation();
    return this.load(
      {
        roomId: observation.roomId,
        assets: observation.room.assets,
        revision: this.owner.observation().revision,
        from: this.owner.observation().roomId,
        exitId: null,
        kind: "reset",
      },
      loader,
      next,
    );
  }
  private capacity(): void {
    if (this.pending >= 4) throw Error("Campaign pending load cap exceeded");
  }
  private async load(
    plan: CampaignEntryPlan,
    loader: CampaignRoomLoader,
    restored?: CampaignPlatformOwner,
  ): Promise<CampaignLoadResult> {
    this.capacity();
    const generation = ++this.generation;
    const source = this.owner;
    this.pending++;
    let prepared: CampaignRoomResources | null = null;
    const controller = new AbortController();
    let expired = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const loading = Promise.resolve()
        .then(() =>
          loader({
            roomId: plan.roomId,
            assetIds: [...plan.assets],
            signal: controller.signal,
          }),
        )
        .then((value) => {
          if (expired) {
            this.release(value);
            throw Error("Campaign load expired");
          }
          return value;
        });
      prepared = await Promise.race([
        loading,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            expired = true;
            controller.abort();
            reject(Error("Campaign room load timeout"));
          }, this.loadTimeoutMs);
        }),
      ]);
      if (
        !prepared ||
        prepared.roomId !== plan.roomId ||
        !Array.isArray(prepared.assetIds) ||
        prepared.assetIds.length !== plan.assets.length ||
        new Set(prepared.assetIds).size !== prepared.assetIds.length ||
        plan.assets.some((id) => !prepared!.assetIds.includes(id)) ||
        typeof prepared.dispose !== "function"
      )
        throw Error("Campaign loaded resources mismatch");
      if (
        this.disposed ||
        generation !== this.generation ||
        source !== this.owner ||
        this.owner.observation().revision !== plan.revision
      ) {
        return { status: "stale", roomId: plan.roomId };
      }
      if (restored) this.owner = restored;
      else this.owner.commitEntry(plan);
      const previous = this.resources;
      this.resources = prepared;
      prepared = null;
      this.release(previous);
      return { status: "committed", roomId: plan.roomId };
    } finally {
      clearTimeout(timeout);
      this.pending--;
      this.release(prepared);
    }
  }
  private release(value: CampaignRoomResources | null): void {
    // Resource destructors are host cleanup; their failure cannot roll back a
    // published authority or allow a stale completion to replace it.
    try {
      value?.dispose();
    } catch {
      /* detached cleanup failure */
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.release(this.resources);
    this.resources = null;
  }
}
