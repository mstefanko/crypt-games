import type { PackManifest } from "../../director-core/src/types";
export interface Point {
  x: number;
  y: number;
}
export interface Anchors {
  ground: Point;
  hand: Point;
  speech: Point;
}
/** Palette index zero is always transparent. Rows use one hexadecimal digit per pixel. */
export interface IndexedPixelFrame {
  kind: "indexed";
  width: number;
  height: number;
  palette: string[];
  rows: string[];
}
export interface RasterFrame {
  kind: "raster";
  mediaId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export type FrameVisual = IndexedPixelFrame | RasterFrame;
export interface AssetFrame {
  id: string;
  durationTicks: number;
  anchors?: Partial<Anchors>;
  visual: FrameVisual;
}
export interface DirectionalClip {
  direction: string;
  frames: AssetFrame[];
}
export interface AssetAction {
  id: string;
  name: string;
  loop: boolean;
  directions: DirectionalClip[];
}
export interface AssetVariant {
  id: string;
  name: string;
  style: string;
  logicalHeight: number;
  anchors: Anchors;
  actions: AssetAction[];
}
export interface AssetFamily {
  id: string;
  name: string;
  revision: number;
  kind: "character" | "prop" | "set";
  sourcePackId?: string;
  description?: string;
  tags?: string[];
  variants: AssetVariant[];
}
export interface MediaResource {
  id: string;
  name: string;
  mime: string;
  dataUrl: string;
  width?: number;
  height?: number;
}
export interface SourcePack {
  id: string;
  name: string;
  mediaIds: string[];
  source?: string;
  license?: string;
  author?: string;
}
export interface AssetVersion {
  id: string;
  familyId: string;
  number: number;
  name: string;
  createdAt: string;
  family: AssetFamily;
  media: MediaResource[];
  source?: SourcePack;
}
export interface AssetCollection {
  id: string;
  name: string;
  familyIds: string[];
}
/** Independent dependency copy, pinned to an immutable library version. */
export interface AssetInstallation {
  id: string;
  projectId: string;
  projectName: string;
  familyId: string;
  versionId: string;
  family: AssetFamily;
  media: MediaResource[];
}
export interface AssetLibraryDocument {
  schemaVersion: 1;
  id: string;
  name: string;
  revision: number;
  sources: SourcePack[];
  media: MediaResource[];
  families: AssetFamily[];
  versions: AssetVersion[];
  collections: AssetCollection[];
  installations: AssetInstallation[];
}
export interface AssetDiagnostic {
  code: string;
  path: string;
  message: string;
  severity: "error" | "warning";
}
export interface AssetCandidate {
  id: string;
  baseFamilyId?: string;
  baseFamilyRevision?: number;
  baseFamily?: AssetFamily;
  proposed: AssetFamily;
  source: "manual" | "claude";
  createdAt: string;
  prompt?: string;
}
export interface CandidateOptions {
  id?: string;
  source?: "manual" | "claude";
  prompt?: string;
  createdAt?: string;
}
export interface AcceptCandidateOptions {
  mode?: "fork" | "update";
  newFamilyId?: string;
  name?: string;
  expectedRevision?: number;
}
export interface CandidateResult {
  document: AssetLibraryDocument;
  family?: AssetFamily;
  conflicts: string[];
}
export interface PublishVersionOptions {
  id?: string;
  name?: string;
  createdAt?: string;
  expectedRevision?: number;
}
export interface PublishVersionResult {
  document: AssetLibraryDocument;
  version: AssetVersion;
}
export interface InstallVersionOptions {
  id?: string;
  projectId: string;
  projectName: string;
  expectedRevision?: number;
}
export interface InstallVersionResult {
  document: AssetLibraryDocument;
  installation: AssetInstallation;
}
export interface DirectorExportOptions {
  familyIds?: string[];
  direction?: string;
  styleMap?: Record<string, "8-bit" | "16-bit" | "realistic">;
  id?: string;
  name?: string;
  version?: string;
}
export interface DirectorExportResult {
  pack: PackManifest;
  warnings: string[];
}
