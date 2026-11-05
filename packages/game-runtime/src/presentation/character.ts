/** Read-only C1 character assembly above the shared animation/layer kit. */
import type { CharacterCatalog, CharacterController } from "@onepage/game-project/characters";
import { orderPresentation, PRESENTATION_LAYERS, sampleAtlasAnimation } from "./sprites";
export { CHARACTER_ARENA_VISUAL_ASSETS } from "./character-fixture-visuals";

export type CharacterVisualAction = "idle" | "move" | "dash" | "hurt" | "dead";
export interface CharacterVisualPart {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  /** Authored visual anchor; never a physics body or hurt region. */
  readonly anchorX: number;
  readonly anchorY: number;
  readonly rows: readonly string[];
}
export interface CharacterVisualFrame {
  readonly id: string;
  readonly durationTicks: number;
  readonly parts: readonly CharacterVisualPart[];
}
export interface CharacterVisualAsset {
  readonly id: string;
  readonly palettes: readonly { readonly id: string; readonly colors: readonly string[] }[];
  readonly animationSets: readonly {
    readonly id: string;
    readonly clips: readonly { readonly action: CharacterVisualAction; readonly loop: boolean; readonly frames: readonly CharacterVisualFrame[] }[];
  }[];
}
export interface CharacterPresentationSelection {
  readonly archetypeId: string;
  readonly appearanceId: string;
  readonly displayName: string;
}
export interface CharacterPresentationPose {
  readonly controller: CharacterController;
  readonly definitionId: string;
  readonly entityId: number;
  readonly tick: number;
  readonly x: number;
  readonly y: number;
  readonly facing: -1 | 1;
  readonly action: CharacterVisualAction;
  readonly reducedMotion?: boolean;
}
/** Prepared, application-owned visual assets. Explicit pose/action/tick come from detached
 * observations; this sampler retains no clock, RNG, async resource or rules reference.
 * Missing actions deliberately fall back to idle. Missing pins fail before drawing. */
export function sampleCharacterPresentation(
  catalog: CharacterCatalog,
  selection: CharacterPresentationSelection,
  pose: CharacterPresentationPose,
  assets: readonly CharacterVisualAsset[],
) {
  if (!Number.isSafeInteger(pose.tick) || pose.tick < 0 ||
      !Number.isSafeInteger(pose.entityId) || pose.entityId < 1 ||
      !Number.isFinite(pose.x) || !Number.isFinite(pose.y) ||
      (pose.facing !== -1 && pose.facing !== 1) ||
      !["idle", "move", "dash", "hurt", "dead"].includes(pose.action) ||
      (pose.reducedMotion !== undefined && typeof pose.reducedMotion !== "boolean") ||
      assets.length > 256)
    throw Error("Invalid character presentation pose");
  const archetype = catalog.archetypes.find(a => a.id === selection.archetypeId);
  const appearance = catalog.appearances.find(a => a.id === selection.appearanceId);
  if (!archetype || !appearance || archetype.controller !== pose.controller || archetype.definitionId !== pose.definitionId)
    throw Error("Character presentation controller mismatch");
  if (new Set(assets.map(a => a.id)).size !== assets.length)
    throw Error("Duplicate character visual asset");
  const asset = assets.find(a => a.id === appearance.assetId);
  if (asset && (asset.animationSets.length > 32 || asset.palettes.length > 16 ||
      new Set(asset.animationSets.map(a => a.id)).size !== asset.animationSets.length ||
      new Set(asset.palettes.map(p => p.id)).size !== asset.palettes.length))
    throw Error("Invalid character presentation asset");
  const animationSetId = appearance.animations[pose.controller];
  const animation = asset?.animationSets.find(a => a.id === animationSetId);
  const palette = asset?.palettes.find(p => p.id === appearance.paletteIds[0]);
  if (!asset || !animation || !palette || appearance.paletteIds.length !== 1 ||
      appearance.partIds.length < 1 || appearance.partIds.length > 16 ||
      new Set(appearance.partIds).size !== appearance.partIds.length ||
      palette.colors.length < 1 || palette.colors.length > 16 ||
      palette.colors.some(c => !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c)))
    throw Error("Character presentation asset pin missing");
  const validatePart = (part: CharacterVisualPart | undefined) => {
    if (!part || !Number.isSafeInteger(part.width) || part.width < 1 || part.width > 128 ||
        !Number.isSafeInteger(part.height) || part.height < 1 || part.height > 128 ||
        !Number.isSafeInteger(part.anchorX) || Math.abs(part.anchorX) > 128 ||
        !Number.isSafeInteger(part.anchorY) || Math.abs(part.anchorY) > 128 ||
        part.rows.length !== part.height || part.rows.some(row => row.length !== part.width ||
          !/^[0-9a-f]+$/i.test(row) || [...row].some(c => parseInt(c, 16) >= palette.colors.length)))
      throw Error("Invalid character presentation part");
    return part;
  };
  // Validate the entire selected animation before its first draw, including clips
  // and frames that this pose does not sample. Idle is the required fallback.
  if (animation.clips.length > 5 || new Set(animation.clips.map(c => c.action)).size !== animation.clips.length ||
      !animation.clips.some(c => c.action === "idle"))
    throw Error("Invalid character presentation actions");
  for (const candidate of animation.clips) {
    if (!["idle", "move", "dash", "hurt", "dead"].includes(candidate.action) || typeof candidate.loop !== "boolean")
      throw Error("Invalid character presentation actions");
    if (!sampleAtlasAnimation(candidate.frames, 0, candidate.loop))
      throw Error("Character presentation clip missing");
    for (const frame of candidate.frames) {
      if (frame.parts.length > 16 || new Set(frame.parts.map(p => p.id)).size !== frame.parts.length)
        throw Error("Invalid character presentation parts");
      for (const part of frame.parts) validatePart(part);
      for (const id of appearance.partIds) validatePart(frame.parts.find(p => p.id === id));
    }
  }
  const clip = animation.clips.find(c => c.action === pose.action) ?? animation.clips.find(c => c.action === "idle")!;
  const frame = sampleAtlasAnimation(clip.frames, pose.reducedMotion ? 0 : pose.tick, clip.loop);
  if (!frame) throw Error("Character presentation clip missing");
  const parts = appearance.partIds.map((partId, depth) => {
    const part = validatePart(frame.parts.find(p => p.id === partId));
    return {
      id: `${pose.entityId}:${partId}`, partId, layer: PRESENTATION_LAYERS.actors, depth,
      width: part.width, height: part.height, anchorX: part.anchorX, anchorY: part.anchorY,
      rows: [...part.rows], colors: [...palette.colors],
    };
  });
  return {
    entityId: pose.entityId, appearanceId: appearance.id, assetId: asset.id,
    animationSetId, paletteId: palette.id, displayName: selection.displayName,
    action: clip!.action, frameId: frame.id, x: pose.x, y: pose.y, facing: pose.facing,
    parts: orderPresentation(parts),
  };
}
