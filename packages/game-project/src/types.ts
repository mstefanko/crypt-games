export const UNIT = 256;
export const SNAPSHOT_VERSION = 1;
export const ACTIONS = [
  "left",
  "right",
  "jump",
  "attack",
  "heavy",
  "guard",
] as const;
export type Action = (typeof ACTIONS)[number];
export type Held = Record<Action, boolean>;
export interface Edge {
  action: Action;
  kind: "pressed" | "released" | "cancel";
}
export interface SlotInput {
  slot: number;
  held: Held;
  axes: { moveX: number };
  edges: Edge[];
}
export interface InputFrame {
  slots: SlotInput[];
  commands?: { type: "restart" }[];
}
export interface InputRecord {
  tick: number;
  slot: number;
  sequence: number;
  heldPatch?: Partial<Held>;
  axesPatch?: { moveX?: number };
  edges: Edge[];
}
export interface DecoderState {
  slots: { held: Held; axes: { moveX: number } }[];
  lastTick: number;
}
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface StaticRect extends Rect {
  readonly id: string;
  readonly oneWay: boolean;
}
export interface Platform extends Rect {
  readonly id: string;
  readonly endX: number;
  readonly speed: number;
}
export interface Spawn {
  readonly id: string;
  readonly archetypeId: string;
  readonly x: number;
  readonly y: number;
  readonly slot: number | null;
  readonly team: number;
  readonly facing: -1 | 1;
}
export interface LevelDefinition {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly tileSize: 8 | 16 | 32;
  readonly tiles: readonly number[];
  readonly rectangles: readonly StaticRect[];
  readonly platforms: readonly Platform[];
  readonly spawns: readonly Spawn[];
  readonly goal: Rect & { readonly nextLevelId: string | null };
  readonly deathY: number;
}
export interface ArchetypeDefinition {
  readonly id: string;
  readonly body: Rect;
  readonly hurt: Rect;
  readonly push: Rect;
  readonly health: number;
  readonly speed: number;
  readonly jumpSpeed: number;
  readonly gravity: number;
  readonly maxFallSpeed: number;
  readonly coyoteTicks: number;
  readonly jumpBufferTicks: number;
  readonly attackBufferTicks: number;
  readonly abilities: readonly string[];
  readonly ai: "none" | "patrol";
  readonly aiRange: number;
}
export interface AbilityDefinition {
  readonly tags?: readonly string[];
  readonly cooldownTicks?: number;
  readonly cancelAfterTick?: number;
  readonly invulnerableWindow?: readonly [number, number];
  readonly id: string;
  readonly startup: number;
  readonly active: number;
  readonly recovery: number;
  readonly hit: Rect;
  readonly damage: number;
  readonly knockbackX: number;
  readonly knockbackY: number;
  readonly stunTicks: number;
  readonly hitStopTicks: number;
  readonly guardDamage: number;
  readonly maxHits: number;
  readonly rehitTicks: number;
}
export type AssertionValue =
  | null
  | string
  | number
  | boolean
  | readonly AssertionValue[]
  | { readonly [key: string]: AssertionValue };
export interface ScenarioDefinition {
  readonly id: string;
  readonly levelId: string;
  readonly seed: number;
  readonly playerSlots: readonly number[];
  readonly ticks: number;
  readonly actions: readonly InputRecord[];
  readonly commands?: readonly {
    readonly tick: number;
    readonly type: "restart";
  }[];
  readonly assertions: readonly {
    readonly tick: number;
    readonly path: string;
    readonly equals: AssertionValue;
  }[];
}
export interface GameManifest {
  readonly schemaVersion: 1;
  readonly gameId: string;
  readonly title: string;
  readonly rulesModule: "platform-combat-v1";
  readonly initialLevelId: string;
  readonly initialScenarioId: string;
  readonly levelIds: readonly string[];
  readonly archetypeIds: readonly string[];
  readonly abilityIds: readonly string[];
  readonly scenarioIds: readonly string[];
  readonly viewport: { readonly width: number; readonly height: number };
}
export interface GameDefinitions {
  readonly manifest: GameManifest;
  readonly levels: readonly LevelDefinition[];
  readonly archetypes: readonly ArchetypeDefinition[];
  readonly abilities: readonly AbilityDefinition[];
  readonly scenarios: readonly ScenarioDefinition[];
}
export interface CompatibilityIdentity {
  rulesBuildId: string;
  contentId: string;
}
export interface Diagnostic {
  code: string;
  severity: "error" | "warning";
  file: string;
  jsonPointer: string;
  message: string;
  repair: string;
}
