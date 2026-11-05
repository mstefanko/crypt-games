/** Presentation-only tile observations. Coordinates are tile units; entities use
 * authored feet pivots, independently of their simulation collision footprint. */
export type TileSceneLayer = "ground" | "actors" | "foreground";
export interface TileSceneVisual {
  frame: string;
  layer?: TileSceneLayer;
  tint?: number;
}
export interface TileSceneEntity {
  id: string;
  x: number;
  y: number;
  frame?: string;
  clip?: string;
  /** Normalized authored clip phase; omitted clips follow observation time. */
  phase?: number;
  layer?: TileSceneLayer;
  alpha?: number;
  /** Presentation-only uniform scale, independent of collision footprints. */
  scale?: number;
  tint?: number;
  label?: string;
  action?: string;
  shadow?: boolean;
  glow?: number;
  /** Cosmetic movement interpolation. Discontinuous moves should set false. */
  interpolate?: boolean;
}
export interface TileSceneObservation {
  sceneId: string;
  /** Only terrain revisions rebuild retained tiles. */
  revision: number;
  width: number;
  height: number;
  tiles: readonly string[];
  entities: readonly TileSceneEntity[];
  time: number;
  title?: string;
  subtitle?: string;
  status?: string;
  /** Cosmetic weather follows simulation time and never advances gameplay. */
  weather?: { exposure: number; sheltered?: boolean };
  controls?: readonly { frame?: string; text: string; action?: string }[];
}
export interface TileSceneOptions {
  atlasUrl: string;
  observe: () => TileSceneObservation;
  tiles?: Readonly<Record<string, TileSceneVisual>>;
  onAction?: (action: string) => void;
  isInteractive?: () => boolean;
  tileSize?: number;
  maxScale?: number;
  fontUrl?: string;
}
