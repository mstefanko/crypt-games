export const ARENA_UNIT = 256;
export const ARENA_MAX_POSITION = 16777216;
export interface ArenaIdentity {
  gameId: string;
  rulesBuildId: string;
  contentId: string;
}
export interface ArenaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ArenaWall extends ArenaRect {
  id: string;
}
export interface ArenaSpawn extends ArenaRect {
  id: string;
  hp: number;
}
export interface ArenaDefinition {
  id: string;
  width: number;
  height: number;
  walls: readonly ArenaWall[];
  player: ArenaSpawn;
  enemies: readonly ArenaSpawn[];
  moveSpeed: number;
  enemySpeed: number;
  projectileSpeed: number;
  projectileSize: number;
  projectileTicks: number;
  projectileDamage: number;
  fireCooldown: number;
  dashSpeed: number;
  dashTicks: number;
  dashCooldown: number;
  shoveRange: number;
  shoveDistance: number;
  shoveDamage: number;
  shoveCooldown: number;
  enemyDamage: number;
  enemyCooldown: number;
  hitstopTicks: number;
  maxProjectiles: number;
}
export interface ArenaHeld {
  fire: boolean;
  dash: boolean;
  shove: boolean;
}
export interface ArenaEdge {
  action: keyof ArenaHeld;
  kind: "pressed" | "released" | "cancel";
}
export interface ArenaInput extends ArenaHeld {
  moveX: number;
  moveY: number;
  aim: number;
  cancel?: boolean;
  /** With edges, fire/dash/shove are the complete resulting held state.
   * Without edges, booleans retain the simple pulse/autofire fixture API. */
  edges?: readonly ArenaEdge[];
}
export interface ArenaActor extends ArenaRect {
  id: number;
  spawnId: string;
  kind: "player" | "enemy";
  hp: number;
  freezeTicks: number;
  motionEpoch: number;
  aim: number;
  aiTicks: number;
  attackCooldown: number;
  dashCooldown: number;
  shoveCooldown: number;
  dashTicks: number;
  dashAim: number;
  fireBuffer: number;
  dashBuffer: number;
  shoveBuffer: number;
}
export interface ArenaProjectile extends ArenaRect {
  id: number;
  ownerId: number;
  vx: number;
  vy: number;
  remainingTicks: number;
}
export type ArenaResult = "playing" | "won" | "lost";
export interface ArenaObservation {
  tick: number;
  result: ArenaResult;
  width: number;
  height: number;
  walls: ArenaWall[];
  actors: ArenaActor[];
  projectiles: ArenaProjectile[];
}
/** Runner-owned mutable state. Views must consume observeArena's detached value. */
export interface ArenaWorld {
  readonly definition: ArenaDefinition;
  readonly identity: ArenaIdentity;
  readonly seed: number;
  tick: number;
  result: ArenaResult;
  actors: ArenaActor[];
  projectiles: ArenaProjectile[];
  nextEntityId: number;
  restartCount: number;
  held: ArenaHeld;
}
