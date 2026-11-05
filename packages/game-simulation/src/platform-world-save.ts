/** Portable realized content, deliberately independent of authoring certificates/search. */
import { boundedJSON, canonical, record } from "@onepage/game-project/runtime";
import type {
  CompatibilityIdentity,
  GameDefinitions,
} from "@onepage/game-project/runtime";
import { validateDefinitions } from "@onepage/game-project/validation";
import {
  CampaignPlatformOwner,
  copyCampaignPlainData,
  campaignJSONByteSize,
  CAMPAIGN_PLATFORM_LIMITS,
  type CampaignPlatformDefinition,
} from "./campaign-platform";

export interface EmbeddedPlatformWorld {
  readonly definitions: GameDefinitions;
  readonly campaign: CampaignPlatformDefinition;
  readonly identity: CompatibilityIdentity;
  /** Bounded variant/provenance identities retained verbatim; never trusted evidence. */
  readonly provenance?: unknown;
}
export type PlatformWorldSaveKind = "checkpoint" | "progress";
export const PLATFORM_WORLD_SAVE_LIMITS = Object.freeze({
  checkpoint: 8 * 1024 * 1024,
  progress: 2 * 1024 * 1024,
});
function checked(content: EmbeddedPlatformWorld): EmbeddedPlatformWorld {
  const value = copyCampaignPlainData(content, 2 * 1024 * 1024);
  record(value, [
    "definitions",
    "campaign",
    "identity",
    ...(Object.hasOwn(value, "provenance") ? ["provenance"] : []),
  ]);
  if (value.provenance !== undefined)
    boundedJSON(canonical(value.provenance), 256 * 1024, {
      rejectNegativeZero: true,
    });
  validateDefinitions(value.definitions);
  // Campaign constructor validates anchors, graph, transaction and input semantics.
  new CampaignPlatformOwner(value.definitions, value.identity, value.campaign);
  return value;
}
export function serializePlatformWorldSave(
  content: EmbeddedPlatformWorld,
  owner: CampaignPlatformOwner,
  kind: PlatformWorldSaveKind = "checkpoint",
): string {
  if (kind !== "checkpoint" && kind !== "progress")
    throw Error("Unsupported platform save kind");
  content = copyCampaignPlainData(content, 2 * 1024 * 1024);
  const state = kind === "checkpoint" ? owner.checkpoint() : owner.progress();
  const authority = JSON.parse(state);
  if (canonical(authority.identity) !== canonical(content.identity))
    throw Error("Embedded campaign content mismatch");
  const bytes = canonical({
    format: "platform-world-save-v1",
    kind,
    content,
    state,
  });
  boundedJSON(bytes, PLATFORM_WORLD_SAVE_LIMITS[kind], {
    rejectNegativeZero: true,
  });
  return bytes;
}
/** Install before gameplay; a rejected frame/entry/import retains prior authority. */
export function attachPlatformWorldSaveGuard(
  content: EmbeddedPlatformWorld,
  owner: CampaignPlatformOwner,
): void {
  const embedded = checked(content);
  const expectedKey = new CampaignPlatformOwner(
    embedded.definitions,
    embedded.identity,
    embedded.campaign,
  ).persistenceContentKey();
  const checkedOwners = new WeakSet<CampaignPlatformOwner>();
  const overhead = (kind: PlatformWorldSaveKind) =>
    campaignJSONByteSize({
      format: "platform-world-save-v1",
      kind,
      content: embedded,
      state: "",
    }).bytes - 2;
  const checkpointOverhead = overhead("checkpoint"),
    progressOverhead = overhead("progress");
  owner.setPersistenceGuard((candidate) => {
    if (!checkedOwners.has(candidate)) {
      if (candidate.persistenceContentKey() !== expectedKey)
        throw Error("Embedded campaign content mismatch");
      checkedOwners.add(candidate);
    }
    const sizes = candidate.persistenceByteSizes();
    if (
      checkpointOverhead + sizes.checkpoint.quotedBytes >
        PLATFORM_WORLD_SAVE_LIMITS.checkpoint ||
      progressOverhead + sizes.progress.quotedBytes >
        PLATFORM_WORLD_SAVE_LIMITS.progress
    )
      throw Error("Platform world combined save byte cap exceeded");
  });
}
export function createPortableCampaignPlatformOwner(
  content: EmbeddedPlatformWorld,
): CampaignPlatformOwner {
  const embedded = checked(content);
  const owner = new CampaignPlatformOwner(
    embedded.definitions,
    embedded.identity,
    embedded.campaign,
  );
  attachPlatformWorldSaveGuard(embedded, owner);
  return owner;
}
export function restorePlatformWorldSave(bytes: string): {
  content: EmbeddedPlatformWorld;
  owner: CampaignPlatformOwner;
  kind: PlatformWorldSaveKind;
} {
  if (typeof bytes !== "string")
    throw Error("Platform world save bytes required");
  const value = record(
    boundedJSON(bytes, PLATFORM_WORLD_SAVE_LIMITS.checkpoint, {
      rejectNegativeZero: true,
    }),
    ["format", "kind", "content", "state"],
  );
  if (
    value.format !== "platform-world-save-v1" ||
    (value.kind !== "checkpoint" && value.kind !== "progress") ||
    typeof value.state !== "string"
  )
    throw Error("Unsupported platform world save");
  boundedJSON(bytes, PLATFORM_WORLD_SAVE_LIMITS[value.kind], {
    rejectNegativeZero: true,
  });
  const content = checked(value.content as EmbeddedPlatformWorld);
  const owner = createPortableCampaignPlatformOwner(content);
  if (value.kind === "checkpoint") {
    boundedJSON(value.state, CAMPAIGN_PLATFORM_LIMITS.bytes);
    owner.restore(value.state);
  } else owner.restoreProgress(value.state);
  return { content, owner, kind: value.kind };
}
