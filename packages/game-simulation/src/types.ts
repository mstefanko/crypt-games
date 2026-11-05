import type {
  CompatibilityIdentity,
  DecoderState,
  GameDefinitions,
  Rect,
} from "../../game-project/src/runtime";
export interface HitLedger {
  targetId: number;
  count: number;
  lastTick: number;
}
export interface Execution {
  id: number;
  abilityId: string;
  tick: number;
  hits: HitLedger[];
}
export interface PlatformMotionState {
  supportId: string | null;
  ignoredSupportId: string | null;
  /** Additional still-overlapped ledges when closely stacked drops overlap. */
  ignoredSupportIds?: string[];
}
export interface MotionResult {
  requested: { x: number; y: number };
  accepted: { x: number; y: number };
  supportId: string | null;
  blockedX: boolean;
  blockedY: boolean;
  departure: "drop" | "jump" | "walk-off" | null;
}
export interface ActorState {
  combatState?: CombatRuntimeState;
  platformMotion?: PlatformMotionState;
  id: number;
  spawnId: string;
  archetypeId: string;
  slot: number | null;
  team: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: -1 | 1;
  health: number;
  grounded: boolean;
  coyoteTicks: number;
  jumpBuffer: number;
  attackBuffer: number;
  bufferedAbility: string | null;
  freezeTicks: number;
  stunTicks: number;
  motionEpoch: number;
  riderId: string | null;
  execution: Execution | null;
  ai: { direction: -1 | 1; decisionTicks: number };
}
export interface PlatformState {
  id: string;
  x: number;
  y: number;
  direction: -1 | 1;
  blocked: boolean;
}
export interface Collider extends Rect {
  id: string;
  oneWay: boolean;
}
export interface SpatialIndex {
  buckets: Map<string, Collider[]>;
}
export interface CampaignState {
  visitedLevelIds: string[];
  defeatedPlacementIds: string[];
}
export interface World {
  inputCodec?: "platform-input-v2";
  motionResults?: Map<number, MotionResult>;
  definitions: GameDefinitions;
  identity: CompatibilityIdentity;
  scenarioId: string;
  initialPlayerSlots: number[];
  tick: number;
  levelId: string;
  status: "playing" | "won" | "lost";
  actors: ActorState[];
  platforms: PlatformState[];
  decoder: DecoderState;
  rng: number;
  nextEntityId: number;
  nextExecutionId: number;
  motionEpochCounter: number;
  campaign: CampaignState;
  index: SpatialIndex;
}
export type TickEvent = {
  type:
    | "jump"
    | "strike"
    | "hit"
    | "guard"
    | "death"
    | "goal"
    | "level"
    | "restart"
    | "platform-blocked";
  tick: number;
  actorId?: number;
  targetId?: number;
  abilityId?: string;
  levelId?: string;
  platformId?: string;
};
export interface ActorObservation {
  platformMotion?: PlatformMotionState;
  motion?: MotionResult;
  id: number;
  spawnId: string;
  archetypeId: string;
  slot: number | null;
  team: number;
  x: number;
  y: number;
  width: number;
  height: number;
  facing: -1 | 1;
  health: number;
  maxHealth: number;
  freezeTicks: number;
  stunTicks: number;
  motionEpoch: number;
  abilityId: string | null;
  abilityTick: number;
  grounded: boolean;
  hurt: Rect;
  push: Rect;
  hit: Rect | null;
}
export interface Observation {
  tick: number;
  levelId: string;
  status: World["status"];
  actors: readonly ActorObservation[];
  platforms: readonly (PlatformState & { width: number; height: number })[];
  goal: Rect & { nextLevelId: string | null };
  campaign: CampaignState;
}

/** Optional action/loadout state. Legacy platform fixtures retain their original rules. */
export interface CombatRuntimeState {
  /** Compatibility view, derived from cooldownDeadlines during the actor update.
   * Removal milestone: the next WORLD checkpoint schema revision that changes
   * CombatRuntimeState must migrate remaining-tick readers to a read facade and
   * omit this stored view. Unrelated session-envelope revisions do not trigger it.
   * Current world saves validate it against the sole deadline authority on restore. */
  cooldowns?: Record<string, number>;
  cooldownDeadlines?: Record<string, number>;
  /** Actor-update clock; freezes pause ability cooldowns, matching legacy update order. */
  cooldownTick?: number;
  weapons: string[];
  equipped: number;
  skill: string;
  damageBonus: number;
  maxHealth: number;
  healCharges: number;
  healTicks: number;
  invulnerableTicks: number;
  rollTick: number;
  rollCooldown: number;
  skillCooldown: number;
  jumps: number;
  combo: number;
}
