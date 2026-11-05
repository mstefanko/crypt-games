import { resolveAnchors } from "../../assets-core/src/pixels.ts";
import { sampleAtlasAnimation } from "./presentation/sprites.ts";
import type {
  AssetFrame,
  AssetVariant,
  Anchors,
} from "../../assets-core/src/types.ts";

import type { ActorObservation } from "../../game-simulation/src/types.ts";

export const GUARD_CUE_COLOR = 0x8cf4ff;
/** Held input is presentation state; authoritative health/stun still controls the pose. */
export function showsGuard(
  actor: Pick<ActorObservation, "slot" | "health" | "stunTicks">,
  held: boolean,
): boolean {
  return (
    held && actor.slot !== null && actor.health > 0 && actor.stunTicks === 0
  );
}
export function actorSkinAction(
  actor: Pick<
    ActorObservation,
    "health" | "stunTicks" | "abilityId" | "grounded"
  >,
  moving: boolean,
  guard: boolean,
): string {
  if (actor.health <= 0 || actor.stunTicks > 0) return "hurt";
  if (actor.abilityId)
    return actor.abilityId.includes("heavy") ? "heavy" : "attack";
  if (guard) return "guard";
  if (!actor.grounded) return "jump";
  return moving ? "walk" : "idle";
}

export type SkinRole = "hero" | "sentinel" | "environment";
export interface PreparedFrame extends AssetFrame {
  trim: { x: number; y: number; width: number; height: number };
}
export interface PreparedSkin {
  schemaVersion: 1;
  id: string;
  versionId: string;
  sourceSha256: string;
  atlas: {
    file: string;
    sha256: string;
    width: number;
    height: number;
    bytes: number;
  };
  roles: Record<SkinRole, string>;
  variants: AssetVariant[];
  frames: Record<string, PreparedFrame>;
  notice: string;
}
export interface SkinSample {
  frame: PreparedFrame;
  anchors: Anchors;
  mirrored: boolean;
  diagnostic?: string;
}
/** Prepared/pinned data only. No library, schema compiler, service or simulation writes. */
export function sampleSkin(
  skin: PreparedSkin,
  role: SkinRole,
  actionName: string,
  tick: number,
  facing: -1 | 1,
): SkinSample {
  const variant = skin.variants.find((v) => v.id === skin.roles[role]);
  if (!variant) throw new Error(`Skin ${skin.id}: missing ${role} variant`);
  const action =
    variant.actions.find((a) => a.name === actionName) ??
    variant.actions.find((a) => a.name === "idle");
  if (!action)
    throw new Error(`Skin ${skin.id}: no ${actionName} or idle fallback`);
  const direction = facing === -1 ? "left" : "right";
  const clip = action.directions.find((c) => c.direction === direction);
  if (!clip)
    throw new Error(`Skin ${skin.id}: missing ${action.name}:${direction}`);
  const chosen = sampleAtlasAnimation(clip.frames, tick, action.loop);
  if (!chosen) throw new Error(`Skin ${skin.id}: invalid animation tick`);
  const frame = skin.frames[chosen.id];
  if (!frame)
    throw new Error(`Skin ${skin.id}: missing prepared frame ${chosen.id}`);
  return {
    frame,
    anchors: resolveAnchors(variant, frame),
    mirrored: facing === -1,
    ...(action.name !== actionName
      ? { diagnostic: `SKIN_ACTION_FALLBACK: ${actionName} -> idle` }
      : {}),
  };
}
/** Sprite origin is the authored ground socket; trim never changes gameplay dimensions. */
export function skinPlacement(
  sample: SkinSample,
  groundX: number,
  groundY: number,
) {
  const { frame, anchors, mirrored } = sample;
  const sign = mirrored ? -1 : 1;
  return {
    x: groundX - sign * (anchors.ground.x - frame.trim.x),
    y: groundY - (anchors.ground.y - frame.trim.y),
    scaleX: sign,
    hand: {
      x: groundX + sign * (anchors.hand.x - anchors.ground.x),
      y: groundY + anchors.hand.y - anchors.ground.y,
    },
    speech: {
      x: groundX + sign * (anchors.speech.x - anchors.ground.x),
      y: groundY + anchors.speech.y - anchors.ground.y,
    },
  };
}
