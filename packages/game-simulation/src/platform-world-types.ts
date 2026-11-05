import type {
  CompatibilityIdentity,
  GameDefinitions,
  Rect,
} from "@onepage/game-project/runtime";
import type {
  CampaignPlatformCommand,
  CampaignPlatformDefinition,
} from "./campaign-platform";

export interface PlatformWorldRecipe {
  format: "platform-world-recipe-v1";
  seed: number;
  rooms: number;
  includeTimed: boolean;
  gameId: string;
}
export interface PlatformRoomSelection {
  roomId: string;
  templateId: string;
  locked: boolean;
  originSeed: number;
}
export interface PlatformRouteDescriptor {
  beats: ("jump" | "drop" | "burst" | "ride")[];
  topology: string;
  distance: number;
  waitRideTicks: number;
  recoveryWidths: number;
}
export interface PlatformTraversalCertificate {
  format: "platform-traversal-certificate-v1";
  semanticDigest: string;
  rulesBuildId: string;
  source: { roomId: string; anchorId: string | null };
  destination: { roomId: string; region: Rect; requiredOutcomes: string[] };
  /** Ordinary campaign commands, run-length encoded only for identical frames. */
  tape: { command: CampaignPlatformCommand; repeat: number }[];
  milestones: { command: number; roomId: string; outcomes: string[] }[];
  finalDigest: string;
  ticks: number;
  descriptor: PlatformRouteDescriptor;
}
export interface PlatformWorldRealization {
  format: "platform-world-realization-v1";
  identity: CompatibilityIdentity;
  definitions: GameDefinitions;
  campaign: CampaignPlatformDefinition;
  recipe: PlatformWorldRecipe;
  rooms: PlatformRoomSelection[];
  certificates: PlatformTraversalCertificate[];
  digest: string;
}
export const PLATFORM_WORLD_LIMITS = Object.freeze({
  rooms: 8,
  templates: 16,
  selectionChecks: 1024,
  backtracks: 64,
  traceTicks: 1800,
  routeTicks: 18000,
  requestTicks: 250000,
  realizationBytes: 2 * 1024 * 1024,
});
