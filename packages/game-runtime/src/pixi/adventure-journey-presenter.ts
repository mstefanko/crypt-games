import type { AdventureJourneyObservation } from "@onepage/game-simulation/adventure-journey-session";
import type { PixiPresenter, PixiStage } from "./index";
import { TileScenePresenter } from "./tile-scene";
import type {
  TileSceneEntity,
  TileSceneObservation,
  TileSceneVisual,
} from "./scene-contract";

export interface AdventureJourneyRegionVisual {
  ground: string;
  sheltered?: boolean;
  variation?: string;
  wall: string;
  wallEntity?: string;
  scenery?: readonly TileSceneEntity[];
  waterCells?: readonly number[];
  waterClip?: string;
}
export interface AdventureJourneySceneDefinition {
  tiles: Readonly<Record<string, TileSceneVisual>>;
  path: string;
  pathVariation?: string;
  markerFrame: string;
  controls: TileSceneObservation["controls"];
  labels: {
    recipient: string;
    deliver: string;
    delivered: string;
    cargo: string;
    home: string;
    returnHome: string;
    homeComplete: string;
    sheltered: string;
    storm: string;
    rain: string;
    exposure: string;
  };
  regions: Readonly<Record<string, AdventureJourneyRegionVisual>>;
  home: { mapId: string; cell: number };
  outwardRoute: string;
  returnRoute: string;
  completion: string;
}
export interface AdventureJourneyPresenterOptions {
  scene: AdventureJourneySceneDefinition;
  observe: () => AdventureJourneyObservation;
  atlasUrl: string;
  title?: string;
  status?: () => string;
  onAction?: (action: string) => void;
  isInteractive?: () => boolean;
  fontUrl?: string;
}

/** Adventure presentation adapter. Map collision, travel, inventory, exposure and
 * objectives are owned by AdventureJourneySession; this maps immutable state to
 * retained native scene objects and samples accepted movement visually. */
export class AdventureJourneyPresenter implements PixiPresenter {
  private tiles: TileScenePresenter;
  private mapId = "";
  private terrain: readonly string[] = [];
  private scenery: readonly TileSceneEntity[] = [];
  constructor(private options: AdventureJourneyPresenterOptions) {
    this.tiles = new TileScenePresenter({
      atlasUrl: options.atlasUrl,
      fontUrl: options.fontUrl,
      observe: () => this.scene(),
      onAction: options.onAction,
      isInteractive: options.isInteractive,
      tiles: options.scene.tiles,
    });
  }
  init(stage: PixiStage) {
    return this.tiles.init(stage);
  }
  resize(width = 800, height = 672) {
    this.tiles.resize(width, height);
  }
  render(dt: number) {
    this.tiles.render(dt);
  }
  renderOutcome() {
    this.tiles.render(0);
  }
  dispose() {
    this.tiles.dispose();
  }

  private sceneryFor(state: AdventureJourneyObservation) {
    const { map } = state,
      width = map.width;
    const walls = new Set(map.walls);
    const visual = this.options.scene.regions[map.id];
    if (!visual) throw Error(`Missing adventure scene region ${map.id}`);
    // A connected visual path follows the actual authored entry/exit sockets.
    // This never supplies collision or routes back to the simulation.
    const path = new Set<number>();
    const entry = map.entrances[0]?.cell ?? width + 1;
    const ey = Math.floor(entry / width),
      ex = entry % width;
    for (const socket of [...map.exits, ...map.dialogues]) {
      const sx = socket.cell % width,
        sy = Math.floor(socket.cell / width);
      for (let x = Math.min(ex, sx); x <= Math.max(ex, sx); x++)
        path.add(ey * width + x);
      for (let y = Math.min(ey, sy); y <= Math.max(ey, sy); y++)
        path.add(y * width + sx);
    }
    this.terrain = Array.from({ length: width * map.height }, (_, cell) => {
      if (walls.has(cell)) return visual.wall;
      if (path.has(cell))
        return cell % 3 || !this.options.scene.pathVariation
          ? this.options.scene.path
          : this.options.scene.pathVariation;
      const x = cell % width,
        y = Math.floor(cell / width);
      // Mix both coordinates before selecting a sparse patch. A linear modulo
      // pattern aliases into stripes on maps whose width matches its period.
      let hash = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263);
      hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
      hash = (hash ^ (hash >>> 16)) >>> 0;
      return visual.variation && hash % 9 === 0
        ? visual.variation
        : visual.ground;
    });
    const entities: TileSceneEntity[] = [...(visual.scenery ?? [])];
    for (const cell of visual.waterCells ?? [])
      entities.push({
        id: `water-${cell}`,
        x: cell % width,
        y: Math.floor(cell / width),
        clip: visual.waterClip,
        layer: "ground",
        interpolate: false,
      });
    if (visual.wallEntity)
      for (const cell of map.walls) {
        const x = cell % width,
          y = Math.floor(cell / width);
        if (x > 0 && x < width - 1 && y > 0 && y < map.height - 1)
          entities.push({
            id: `obstacle-${cell}`,
            x: x + 0.5,
            y: y + 1,
            frame: visual.wallEntity,
            shadow: true,
            interpolate: false,
          });
      }
    this.scenery = entities;
    this.mapId = map.id;
  }

  private scene(): TileSceneObservation {
    const state = this.options.observe(),
      { map } = state;
    const labels = this.options.scene.labels;
    const changed = this.mapId !== map.id;
    if (changed) this.sceneryFor(state);
    const width = map.width,
      entities: TileSceneEntity[] = [...this.scenery];
    const near = (cell: number) =>
      Math.abs((cell % width) - (state.player % width)) +
        Math.abs(Math.floor(cell / width) - Math.floor(state.player / width)) <=
      1;
    for (const exit of map.exits) {
      const destination = state.maps.find((m) => m.id === exit.mapId);
      const shelter = this.options.scene.regions[exit.mapId]?.sheltered;
      entities.push({
        id: exit.id,
        x: (exit.cell % width) + 0.5,
        y: Math.floor(exit.cell / width) + 1,
        frame: this.options.scene.markerFrame,
        label: `${near(exit.cell) ? "E · " : ""}${shelter ? "◈ " : "→ "}${destination?.name ?? "Trail"}`,
        action: near(exit.cell) ? "interact" : undefined,
        glow: near(exit.cell) ? 0xf4d99b : undefined,
        interpolate: false,
      });
    }
    if (map.id === this.options.scene.home.mapId) {
      const cell = this.options.scene.home.cell;
      entities.push({
        id: "home",
        x: (cell % width) + 0.5,
        y: Math.floor(cell / width) + 0.7,
        frame: this.options.scene.markerFrame,
        label: state.won
          ? labels.homeComplete
          : state.delivered
            ? labels.returnHome
            : labels.home,
        action: near(cell) ? "interact" : undefined,
        glow: state.delivered ? 0xffde99 : undefined,
        interpolate: false,
      });
    }
    for (const dialogue of map.dialogues)
      entities.push({
        id: `npc-${dialogue.id}`,
        x: (dialogue.cell % width) + 0.5,
        y: Math.floor(dialogue.cell / width) + 1,
        clip: "keeper.idle:down",
        shadow: true,
        glow: state.delivered ? 0xffdf9c : 0x89d4d5,
        label: state.delivered
          ? labels.delivered
          : near(dialogue.cell)
            ? labels.deliver
            : labels.recipient,
        action: near(dialogue.cell) ? "interact" : undefined,
        interpolate: false,
      });
    const p = Math.max(0, Math.min(1, state.moveProgress));
    const px =
      (state.previousPlayer % width) +
      ((state.player % width) - (state.previousPlayer % width)) * p;
    const py =
      Math.floor(state.previousPlayer / width) +
      (Math.floor(state.player / width) -
        Math.floor(state.previousPlayer / width)) *
        p;
    entities.push({
      id: "hero",
      x: px + 0.5,
      y: py + 1,
      clip: `hero.${p < 1 && state.player !== state.previousPlayer ? "walk" : "idle"}:${state.facing}`,
      shadow: true,
      interpolate: false,
    });
    const weather = state.sheltered
      ? labels.sheltered
      : state.storm
        ? labels.storm
        : labels.rain;
    const objective = state.won
      ? this.options.scene.completion
      : state.delivered
        ? this.options.scene.returnRoute
        : this.options.scene.outwardRoute;
    return {
      sceneId: map.id,
      revision: 0,
      width,
      height: map.height,
      tiles: this.terrain,
      entities,
      time: state.time,
      weather: { exposure: state.exposure, sheltered: state.sheltered },
      title: `${this.options.title ?? "Journey"} · ${map.name}`,
      subtitle: `${weather}  ·  ${labels.exposure} ${Math.round(state.exposure * 100)}%  ·  ${state.delivered ? labels.delivered : labels.cargo}`,
      status: `${objective}\n${this.options.status?.() ?? state.status}`,
      controls: this.options.scene.controls,
    };
  }
}
