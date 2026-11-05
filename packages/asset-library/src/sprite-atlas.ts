export interface SpriteFrame {
  id: string;
  width: number;
  height: number;
}
export interface AtlasFrame extends SpriteFrame {
  x: number;
  y: number;
}
/** Deterministic shelf packing; consumers own pixel decoding and nearest-neighbor drawing. */
export function layoutSpriteAtlas(
  frames: readonly SpriteFrame[],
  maxWidth = 512,
  padding = 1,
): { width: number; height: number; frames: AtlasFrame[] } {
  if (
    !Number.isInteger(maxWidth) ||
    maxWidth < 1 ||
    !Number.isInteger(padding) ||
    padding < 0
  )
    throw new Error("Invalid atlas dimensions");
  const ids = new Set<string>();
  let x = 0,
    y = 0,
    row = 0,
    width = 0;
  const result: AtlasFrame[] = [];
  for (const frame of frames) {
    if (
      ids.has(frame.id) ||
      !frame.id ||
      !Number.isInteger(frame.width) ||
      !Number.isInteger(frame.height) ||
      frame.width < 1 ||
      frame.height < 1 ||
      frame.width > maxWidth
    )
      throw new Error("Invalid or duplicate sprite frame");
    ids.add(frame.id);
    if (x + frame.width > maxWidth) {
      x = 0;
      y += row + padding;
      row = 0;
    }
    result.push({ ...frame, x, y });
    width = Math.max(width, x + frame.width);
    row = Math.max(row, frame.height);
    x += frame.width + padding;
  }
  return {
    width: Math.max(1, width),
    height: Math.max(1, y + row),
    frames: result,
  };
}

/** Version 2 metadata is additive; absent fields retain legacy eight-facing playback. */
export interface SpriteClipMetadata {
  duration: number;
  loop: boolean;
  role?: string;
  directionCount?: number;
  /** Normalized phases of the edited clip, independent of simulation seconds. */
  markers?: {
    contact: number;
    activeEnd: number;
    release?: number;
    recovery?: number;
  };
}
export interface SpriteProjectionRecipe {
  id: string;
  tileWidth: number;
  tileHeight: number;
  origin: { x: number; y: number };
  pixelsPerWorldUnit: number;
  cameraElevationDegrees: number;
  orthographicScale: number;
}
export interface SpriteAtlasMetadata {
  version?: number;
  recipeId?: string;
  projection?: SpriteProjectionRecipe;
  roles?: Record<string, { directionCount: number }>;
  clipMetadata?: Record<string, SpriteClipMetadata>;
  effects?: Record<
    string,
    {
      pivot: { x: number; y: number };
      blend: "normal" | "add";
      depth: "ground" | "floor" | "actor" | "overlay";
      duration: number;
    }
  >;
}
/** Phase remapping preserves the simulation's tell/contact/recovery boundaries. */
export function editedClipPhase(
  phase: "tell" | "active" | "recover" | "done",
  progress: number,
  markers = { contact: 0.35, activeEnd: 0.65 },
): number {
  const p = Math.max(0, Math.min(1, progress));
  if (phase === "tell") return p * markers.contact;
  if (phase === "active")
    return markers.contact + p * (markers.activeEnd - markers.contact);
  if (phase === "recover")
    return markers.activeEnd + p * (1 - markers.activeEnd);
  return 1;
}
export function spriteDirectionCount(
  metadata: SpriteAtlasMetadata,
  role: string,
  clip?: string,
): number {
  return (
    metadata.clipMetadata?.[clip ?? ""]?.directionCount ??
    metadata.roles?.[role]?.directionCount ??
    8
  );
}
