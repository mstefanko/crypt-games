/** P4 owned integer cave. Coordinates are fixed units (256/pixel). */
export const CAVE_LIMITS = Object.freeze({
  width: 128,
  height: 128,
  cellSize: 1024,
  chunkSize: 16,
  extent: 131072,
  actorSize: 2048,
  speed: 512,
  materials: 9,
  actors: 8,
  damage: 1024,
  effects: 5,
  cellsPerEffect: 256,
  touchedCells: 1280,
  nodes: 16,
  edges: 32,
  zones: 8,
  anchorCells: 256,
  contentBytes: 524288,
});
export type CaveDirection = "up" | "right" | "down" | "left";
export interface CaveRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface CavePoint {
  readonly x: number;
  readonly y: number;
}
export interface CaveMaterial {
  readonly id: string;
  readonly solid: boolean;
  readonly hp: number;
  readonly drillResistance: number;
  readonly blastResistance: number;
  readonly oreYield: number;
  readonly cue: string;
}
export interface CaveSpawn extends CavePoint {
  readonly id: string;
}
export interface CaveSupportNode {
  readonly id: string;
  readonly anchorCells: readonly number[];
}
export interface CaveRoofZone {
  readonly id: string;
  readonly rect: CaveRect;
  readonly nodeIds: readonly string[];
}
export interface CaveBraceSocket extends CavePoint {
  readonly id: string;
  readonly nodeId: string;
}
export interface CaveRoof {
  readonly nodes: readonly CaveSupportNode[];
  readonly edges: readonly (readonly [string, string])[];
  readonly zones: readonly CaveRoofZone[];
  readonly braceSockets: readonly CaveBraceSocket[];
}
export interface CaveTools {
  readonly drillDamage: number;
  readonly drillReach: number;
  readonly drillInterval: 6;
  readonly chargeDamage: number;
  readonly chargeRadius: number;
  readonly chargeFuse: number;
  readonly charges: number;
  readonly braces: number;
  readonly braceReach: number;
  readonly roofWarningTicks: 120;
  readonly roofDamage: number;
}
export interface CaveContent {
  readonly version: "cave-content-v1";
  readonly id: string;
  readonly width: 128;
  readonly height: 128;
  readonly cellSize: 1024;
  readonly chunkSize: 16;
  readonly materials: readonly CaveMaterial[];
  readonly cells: readonly number[];
  readonly protected: readonly boolean[];
  readonly player: CaveSpawn & { readonly hp: number };
  /** Immune, nonblocking rescue objectives. */ readonly drones: readonly CaveSpawn[];
  readonly extraction: CaveRect;
  readonly roof: CaveRoof;
  readonly tools: CaveTools;
}
