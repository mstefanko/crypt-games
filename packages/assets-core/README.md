# Pocket Assets core

Portable cross-game library contracts and pure transformations. No model calls or browser storage. Original demo artwork is explicitly a fixture, never a generated result.

`AssetLibraryDocument` separates drafts (`families`), source packs, source bytes (`media`), immutable published snapshots (`versions`), collections and pinned independent project copies (`installations`). A family contains variants → named actions → directions → timed frames. Time is integer 60 Hz ticks. Ground, hand and speech anchors are frame-local; per-frame overrides replace individual defaults.

Editable pixel art uses at most 16 hex colors and `rows:string[]`, one hexadecimal palette index per pixel; index 0 is transparent. Maximum editable frame size is 128×128. Model-generated pixels enter through this same validated format. Raster frames preserve a source image and explicit rectangle; arbitrary raster content cannot be semantically edited through pixel-row operations.

Public functions:

- `createEmptyLibrary(id?, name?)`, `createDemoLibrary()`.
- `validateAssetDocument(unknown): AssetDiagnostic[]`, `assertAssetDocument(unknown)`, `validateAssetFamily(unknown, media?)`, `assertAssetFamily(unknown, media?)`.
- `frameToRgba(frame | indexedVisual): Uint8ClampedArray`, `frameAtTick(clip, tick, loop = true): AssetFrame | undefined`, `resolveAnchors(variant, frame?)`, `capabilityReport(variant, {actions?, directions?})`.
- `createAssetCandidate(baseFamily | undefined, proposedFamily, {id?, source?, prompt?, createdAt?})` snapshots the original and proposed family.
- `acceptAssetCandidate(document, candidate, {mode?: "fork" | "update", newFamilyId?, name?, expectedRevision?})` returns `{document, family?, conflicts}`. Fork is the default. An explicit update checks the original revision and full original snapshot; conflicts never partially apply. Fork IDs, variants, actions and frames are remapped.
- `assertImmutableVersions(previous, next)` guards persistence boundaries: existing snapshots cannot be changed or removed; appending versions is allowed.
- `publishAssetVersion(document, familyId, {id?, name?, createdAt?, expectedRevision?})` returns `{document, version}`. Published media dependencies and provenance are copied. Returned version is deeply frozen.
- `installAssetVersion(document, versionId, {id?, projectId, projectName, expectedRevision?})` returns `{document, installation}` containing an independent family/media copy. Deleting library drafts or versions does not affect that copy.
- `exportDirectorPack(document, {familyIds?, direction?, styleMap?, id?, name?, version?})` returns `{pack, warnings}`. Indexed frames are baked into a real PNG atlas without Canvas; raster variants require one sheet. Canonical action names select the requested direction or explicitly warn on fallback; all named directions also export as `action:direction` clips. Unknown catalog styles map to Director's 16-bit style with a warning. Director's existing types remain unchanged.

Every successful mutation returns a new document and increments document revision exactly once. Save drafts with expected document revisions in the storage layer. Source/license fields are optional and never block editing. Empty metadata remains empty during export rather than inventing rights.
