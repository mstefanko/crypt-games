import type {
  AcceptCandidateOptions,
  AssetCandidate,
  AssetFamily,
  AssetLibraryDocument,
  AssetVersion,
  CandidateOptions,
  CandidateResult,
  InstallVersionOptions,
  InstallVersionResult,
  MediaResource,
  PublishVersionOptions,
  PublishVersionResult,
} from "./types";
import { assertAssetDocument, assertAssetFamily } from "./validate";
const clone = <T>(value: T): T => structuredClone(value);
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const uuid = () => crypto.randomUUID();
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function unique(base: string, used: Set<string>): string {
  let id = base,
    n = 2;
  while (used.has(id)) id = `${base}~${n++}`;
  return id;
}
function checkRevision(doc: AssetLibraryDocument, expected?: number) {
  if (expected !== undefined && expected !== doc.revision)
    throw new Error("Library revision conflict. Reload before saving.");
}
export function createEmptyLibrary(
  id: string = uuid(),
  name = "My asset library",
): AssetLibraryDocument {
  return {
    schemaVersion: 1,
    id,
    name,
    revision: 1,
    sources: [],
    media: [],
    families: [],
    versions: [],
    collections: [],
    installations: [],
  };
}
export function createAssetCandidate(
  base: AssetFamily | undefined,
  proposed: AssetFamily,
  options: CandidateOptions = {},
): AssetCandidate {
  return {
    id: options.id ?? uuid(),
    ...(base
      ? {
          baseFamilyId: base.id,
          baseFamilyRevision: base.revision,
          baseFamily: clone(base),
        }
      : {}),
    proposed: clone(proposed),
    source: options.source ?? "manual",
    createdAt: options.createdAt ?? new Date().toISOString(),
    ...(options.prompt ? { prompt: options.prompt } : {}),
  };
}
function remapFork(family: AssetFamily, newId: string) {
  family.id = newId;
  family.revision = 1;
  family.variants.forEach((v, vi) => {
    v.id = `${newId}:v${vi}`;
    v.actions.forEach((a, ai) => {
      a.id = `${v.id}:a${ai}`;
      a.directions.forEach((clip, di) =>
        clip.frames.forEach((f, fi) => {
          f.id = `${a.id}:d${di}:f${fi}`;
        }),
      );
    });
  });
}
export function acceptAssetCandidate(
  input: AssetLibraryDocument,
  candidate: AssetCandidate,
  options: AcceptCandidateOptions = {},
): CandidateResult {
  assertAssetDocument(input);
  if (
    options.mode !== undefined &&
    options.mode !== "fork" &&
    options.mode !== "update"
  )
    throw new Error("Candidate mode must be fork or update");
  const conflicts: string[] = [];
  if (
    options.expectedRevision !== undefined &&
    options.expectedRevision !== input.revision
  )
    conflicts.push("Library revision changed since review");
  const current = input.families.find((f) => f.id === candidate.baseFamilyId);
  const family = clone(candidate.proposed);
  assertAssetFamily(family, input.media);
  if ((options.mode ?? "fork") === "update") {
    if (!candidate.baseFamilyId || !candidate.baseFamily || !current)
      conflicts.push("Original family is unavailable; save a copy instead");
    else if (
      current.revision !== candidate.baseFamilyRevision ||
      !same(current, candidate.baseFamily)
    )
      conflicts.push(
        "Original family changed after this candidate was created",
      );
    if (family.id !== candidate.baseFamilyId)
      conflicts.push("Update candidate must retain the original family ID");
  }
  if (conflicts.length) return { document: clone(input), conflicts };
  const document = clone(input);
  if ((options.mode ?? "fork") === "fork") {
    const used = new Set(document.families.map((f) => f.id));
    const newId = unique(
      options.newFamilyId ??
        (candidate.baseFamilyId ? `${candidate.baseFamilyId}-copy` : family.id),
      used,
    );
    remapFork(family, newId);
    family.name =
      options.name ??
      (candidate.baseFamilyId ? `${family.name} Copy` : family.name);
    document.families.push(family);
  } else {
    family.revision = current!.revision + 1;
    document.families[
      document.families.findIndex((f) => f.id === current!.id)
    ] = family;
  }
  document.revision++;
  assertAssetDocument(document);
  return { document, family: clone(family), conflicts: [] };
}
function dependencies(
  family: AssetFamily,
  media: MediaResource[],
): MediaResource[] {
  const ids = new Set<string>();
  for (const v of family.variants)
    for (const a of v.actions)
      for (const clip of a.directions)
        for (const f of clip.frames)
          if (f.visual.kind === "raster") ids.add(f.visual.mediaId);
  return clone(media.filter((m) => ids.has(m.id)));
}
export function publishAssetVersion(
  input: AssetLibraryDocument,
  familyId: string,
  options: PublishVersionOptions = {},
): PublishVersionResult {
  assertAssetDocument(input);
  checkRevision(input, options.expectedRevision);
  const family = input.families.find((f) => f.id === familyId);
  if (!family) throw new Error("Family not found");
  const number =
    Math.max(
      0,
      ...input.versions
        .filter((v) => v.familyId === familyId)
        .map((v) => v.number),
    ) + 1;
  const source = input.sources.find((s) => s.id === family.sourcePackId);
  const version: AssetVersion = {
    id: options.id ?? uuid(),
    familyId,
    number,
    name: options.name ?? `Version ${number}`,
    createdAt: options.createdAt ?? new Date().toISOString(),
    family: clone(family),
    media: dependencies(family, input.media),
    ...(source ? { source: clone(source) } : {}),
  };
  if (input.versions.some((v) => v.id === version.id))
    throw new Error("Version ID already exists; saved versions are immutable");
  const document = clone(input);
  document.versions.push(clone(version));
  document.revision++;
  assertAssetDocument(document);
  return { document, version: freeze(version) };
}
export function installAssetVersion(
  input: AssetLibraryDocument,
  versionId: string,
  options: InstallVersionOptions,
): InstallVersionResult {
  assertAssetDocument(input);
  checkRevision(input, options.expectedRevision);
  const version = input.versions.find((v) => v.id === versionId);
  if (!version)
    throw new Error("Saved version not found; publish a version first");
  const installation = {
    id: options.id ?? uuid(),
    projectId: options.projectId,
    projectName: options.projectName,
    familyId: version.familyId,
    versionId,
    family: clone(version.family),
    media: clone(version.media),
  };
  if (input.installations.some((i) => i.id === installation.id))
    throw new Error("Installation ID already exists");
  const document = clone(input);
  document.installations.push(clone(installation));
  document.revision++;
  assertAssetDocument(document);
  return { document, installation };
}
export const acceptCandidate = acceptAssetCandidate;
export const publishVersion = publishAssetVersion;
export const installVersion = installAssetVersion;

/** Save boundary guard: published snapshots are append-only, including embedded media/provenance. */
export function assertImmutableVersions(
  previous: AssetLibraryDocument,
  next: AssetLibraryDocument,
): void {
  for (const version of previous.versions) {
    const incoming = next.versions.find((v) => v.id === version.id);
    if (!incoming)
      throw new Error(`Published version ${version.id} cannot be removed`);
    if (!same(version, incoming))
      throw new Error(`Published version ${version.id} is immutable`);
  }
}
