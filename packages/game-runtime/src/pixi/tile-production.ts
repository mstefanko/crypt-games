import {
  TileEntityPresenter,
  type TileEntity,
  type PixiPresenter,
  type PixiStage,
  type Texture,
} from "./index";
export interface TilePart {
  pack: string;
  frame: number;
  x: number;
  y: number;
  width: number;
  height?: number;
  depth?: number;
}
export interface TileProductionState {
  variation: number;
  time: number;
  selected: number;
  offset: { x: number; y: number };
  pending: readonly string[];
  sites: readonly {
    id: string;
    name: string;
    cell: number;
    kind: string;
    cost: number;
    repaired: boolean;
  }[];
  workers: readonly {
    id: string;
    cell: number;
    state: string;
    payload?: { resource: string } | null;
  }[];
}
export interface TileProductionStyle {
  columns: number;
  cellSize: number;
  terrain: readonly {
    from: number;
    to: number;
    pack: string;
    frames: readonly number[];
  }[];
  terrainColumns: number;
  terrainRows: number;
  terrainSize: number;
  paths: { pack: string; frame: number; columns: number; rows: number };
  dock?: { pack: string; frame: number; from: number; to: number; row: number };
  appearances: Readonly<Record<string, readonly TilePart[]>>;
  siteParts?: Readonly<Record<string, readonly TilePart[]>>;
  repairedParts?: Readonly<Record<string, readonly TilePart[]>>;
  worker: { pack: string; firstFrame: number; width: number };
  cargo: Readonly<Record<string, { pack: string; frame: number }>>;
}
/** Native retained tile/production scene. Harbor is the first consumer; the
 * renderer accepts state and art mappings without owning its economy. */
export class TileProductionPresenter implements PixiPresenter {
  private retained: TileEntityPresenter;
  constructor(
    read: () => TileProductionState,
    style: TileProductionStyle,
    texture: (pack: string, frame: number) => Texture,
  ) {
    this.retained = new TileEntityPresenter(
      () => {
        const state = read(),
          items: TileEntity[] = [];
        const add = (
          id: string,
          part: TilePart,
          x: number,
          y: number,
          depth: number,
          label?: string,
          alpha = 1,
        ) =>
          items.push({
            id,
            texture: texture(part.pack, part.frame),
            x: x + part.x,
            y: y + part.y,
            width: part.width,
            height: part.height ?? part.width,
            depth: depth + (part.depth ?? 0),
            label,
            alpha,
          });
        const n = style.terrainSize;
        for (let y = 0; y < style.terrainRows; y++)
          for (let x = 0; x < style.terrainColumns; x++) {
            const band = style.terrain.find((b) => x >= b.from && x < b.to);
            if (!band) continue;
            add(
              `terrain-${x}-${y}`,
              {
                pack: band.pack,
                frame:
                  band.frames[(x + y + state.variation) % band.frames.length]!,
                x: 0,
                y: 0,
                width: n,
              },
              x * n,
              y * n,
              -1000,
            );
          }
        for (let y = 1; y < style.paths.rows; y++)
          for (let x = 1; x < style.paths.columns; x++)
            add(
              `path-${x}-${y}`,
              {
                pack: style.paths.pack,
                frame: style.paths.frame,
                x: 0,
                y: 0,
                width: style.cellSize,
                height: n,
              },
              x * style.cellSize,
              y * style.cellSize,
              -900,
            );
        if (style.dock)
          for (let x = style.dock.from; x < style.dock.to; x++)
            add(
              `dock-${x}`,
              { ...style.dock, x: 0, y: 0, width: n },
              x * n,
              style.dock.row * n,
              -800,
            );
        state.sites.forEach((site, index) => {
          const x = (site.cell % style.columns) * style.cellSize,
            y = Math.floor(site.cell / style.columns) * style.cellSize;
          const label = `${index === state.selected ? "▸ " : ""}${site.name}${!site.repaired ? (state.pending.includes(site.id) ? " · BUILD" : ` · ${site.cost} S`) : ""}`;
          const parts = site.repaired
            ? (style.repairedParts?.[site.kind] ?? style.appearances[site.kind])
            : style.appearances[site.kind];
          (parts ?? []).forEach((part, i) =>
            add(
              `${site.id}-${i}`,
              part,
              x,
              y,
              y,
              i === 0 ? label : undefined,
              site.repaired ? 1 : 0.65,
            ),
          );
          (style.siteParts?.[site.id] ?? []).forEach((part, i) =>
            add(`${site.id}-detail-${i}`, part, x, y, y + 1),
          );
        });
        state.workers.forEach((worker, index) => {
          const x = (worker.cell % style.columns) * style.cellSize + 8,
            y = Math.floor(worker.cell / style.columns) * style.cellSize + 8;
          const moving =
            worker.state.includes("travel") || worker.state.includes("carry");
          add(
            worker.id,
            {
              pack: style.worker.pack,
              frame: style.worker.firstFrame + index,
              x: 0,
              y: moving ? Math.sin(state.time * 9) * 1.3 : 0,
              width: style.worker.width,
            },
            x,
            y,
            y + 20,
            worker.state === "blocked" ? "!" : undefined,
          );
          if (worker.payload) {
            const cargo = style.cargo[worker.payload.resource];
            if (cargo)
              add(
                `${worker.id}-cargo`,
                { ...cargo, x: 12, y: -4, width: 12 },
                x,
                y,
                y + 21,
              );
          }
        });
        return items;
      },
      () => read().offset,
    );
  }
  init(stage: PixiStage) {
    this.retained.init(stage);
  }
  resize() {
    this.retained.resize();
  }
  render() {
    this.retained.render();
  }
  dispose() {
    this.retained.dispose();
  }
}

// Semantic art contract shares the retained production mechanism without numeric pack IDs.
export { SemanticProductionPresenter } from "./semantic-production";
export type {
  ProductionSceneStyle,
  ProductionSceneState,
} from "./production-scene";

export { pickProductionSite } from "./production-scene";
