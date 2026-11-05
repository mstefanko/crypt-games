import type {
  PuzzleCampaignDefinition,
  PuzzleCampaignObservation,
} from "@onepage/game-simulation/puzzle-campaign-session";
import type { PixiPresenter, PixiStage } from "./index";
import { TileScenePresenter } from "./tile-scene";
import type { TileSceneEntity, TileSceneObservation } from "./scene-contract";

export interface PuzzleCampaignPresenterOptions {
  observe: () => PuzzleCampaignObservation;
  definition: Pick<PuzzleCampaignDefinition, "clues">;
  atlasUrl: string;
  title?: string;
  status?: () => string;
  roomNames?: readonly string[];
  onAction?: (action: string) => void;
  isInteractive?: () => boolean;
  fontUrl?: string;
}
/** Puzzle genre adapter. All room state, progress, legality and input commands
 * remain in the simulation/session; this class only maps observations to art. */
export class PuzzleCampaignPresenter implements PixiPresenter {
  private tiles: TileScenePresenter;
  private facing = "down";
  private lastPlayer = -1;
  private lastRoom = -2;
  private lastRevision = -1;
  private mapped?: TileSceneObservation;
  constructor(private options: PuzzleCampaignPresenterOptions) {
    this.tiles = new TileScenePresenter({
      atlasUrl: options.atlasUrl,
      fontUrl: options.fontUrl ?? options.atlasUrl.replace(/[^/]+$/, "hud.ttf"),
      observe: () => this.scene(),
      onAction: options.onAction,
      isInteractive: options.isInteractive,
      tiles: {
        floor: { frame: "floor.a" },
        variation: { frame: "floor.b" },
        inlay: { frame: "floor.inlay" },
        wall: { frame: "wall" },
        cap: { frame: "wall.cap" },
      },
    });
  }
  init(stage: PixiStage) {
    return this.tiles.init(stage);
  }
  resize(width = 768, height = 512) {
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
  private scene(): TileSceneObservation {
    const state = this.options.observe();
    // The session revision excludes clock-only ticks. Reuse terrain/entities when
    // possible, while authored decorative clips follow the simulation clock.
    if (
      this.mapped &&
      state.revision === this.lastRevision &&
      state.room === this.lastRoom
    ) {
      const walking = state.cooldown > 0;
      const entities = this.mapped.entities.map((e) =>
        e.id === "hero" && state.room >= 0
          ? { ...e, clip: `hero.${walking ? "walk" : "idle"}:${this.facing}` }
          : e,
      );
      return {
        ...this.mapped,
        entities,
        time: state.clock,
        status: this.options.status?.() ?? this.mapped.status,
      };
    }
    const changed = state.room !== this.lastRoom;
    this.lastRevision = state.revision;
    this.lastRoom = state.room;
    this.mapped = state.room < 0 ? this.hub(state) : this.room(state, changed);
    return this.mapped;
  }
  private hub(state: PuzzleCampaignObservation): TileSceneObservation {
    this.lastPlayer = -1;
    this.facing = "down";
    const width = Math.max(18, state.rooms.length * 5 + 3),
      height = 10;
    const tiles = Array.from({ length: width * height }, (_, cell) => {
      const x = cell % width,
        y = Math.floor(cell / width);
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1)
        return y === 0 ? "cap" : "wall";
      if ((x - width / 2) ** 2 + (y - 6) ** 2 < 6) return "inlay";
      return (x + y) % 5 === 0 ? "variation" : "floor";
    });
    const entities: TileSceneEntity[] = [];
    state.rooms.forEach((room, i) => {
      const x = 3.5 + (i * (width - 7)) / Math.max(1, state.rooms.length - 1),
        clue = this.options.definition.clues[room.clueIndex];
      entities.push({
        id: `arch-${i}`,
        x,
        y: 4,
        frame: "door.arch",
        layer: "ground",
        interpolate: false,
      });
      entities.push({
        id: `door-${i}`,
        x,
        y: 3.95,
        frame: room.active ? "door.open" : "door",
        label: `${i + 1}  ${this.options.roomNames?.[i] ?? clue?.name ?? "Chamber"}${room.active ? " · LIT" : ""}`,
        action: `room-${i}`,
        glow: room.active ? 0x74d8e4 : undefined,
        tint: room.active ? 0xa7e5ea : 0xffffff,
        interpolate: false,
      });
      entities.push({
        id: `torch-${i}`,
        x: x - 1.65,
        y: 3,
        clip: "torch.burn",
        glow: 0xefad55,
        layer: "foreground",
        interpolate: false,
      });
    });
    entities.push({
      id: "crystal",
      x: width / 2,
      y: 7.4,
      clip: "crystal.pulse",
      glow: state.won ? 0xf7dc8b : 0x78e5f2,
      label: state.won ? "THE VAULT ANSWERS" : "CENTRAL RESONATOR",
      action: "crystal",
      shadow: true,
      interpolate: false,
    });
    entities.push(
      {
        id: "statue-left",
        x: 1.7,
        y: 7.6,
        frame: "statue",
        shadow: true,
        interpolate: false,
      },
      {
        id: "statue-right",
        x: width - 1.7,
        y: 7.6,
        frame: "statue",
        shadow: true,
        interpolate: false,
      },
    );
    entities.push({
      id: "hero",
      x: width / 2,
      y: 9,
      clip: "hero.idle:up",
      shadow: true,
      interpolate: false,
    });
    const active = state.rooms.filter((room) => room.active).length;
    return {
      sceneId: "hub",
      revision: state.rooms.length,
      width,
      height,
      tiles,
      entities,
      time: state.clock,
      title: this.options.title ?? "The Echo Vault",
      subtitle: `THE RESONANCE HALL  ·  ${active} / ${state.rooms.length} chambers restored`,
      status:
        this.options.status?.() ??
        "Choose a chamber. Restore its resonator, then return to the crystal.",
      controls: [
        { text: "1 / 2 / 3   Enter a chamber" },
        {
          frame: "ui.key.space",
          text: "E  Listen to the crystal",
          action: "crystal",
        },
      ],
    };
  }
  private room(
    state: PuzzleCampaignObservation,
    changed: boolean,
  ): TileSceneObservation {
    const room = state.rooms[state.room],
      grid = room.grid,
      def = grid.definition,
      width = def.width,
      height = def.height,
      walls = new Set(def.walls),
      crates = new Set(grid.position.crates),
      clue = this.options.definition.clues[room.clueIndex];
    const player = grid.position.player;
    if (changed) {
      this.lastPlayer = player;
      this.facing = "down";
    } else if (player !== this.lastPlayer) {
      const dx = (player % width) - (this.lastPlayer % width),
        dy = Math.floor(player / width) - Math.floor(this.lastPlayer / width);
      this.facing = dx > 0 ? "right" : dx < 0 ? "left" : dy > 0 ? "down" : "up";
      this.lastPlayer = player;
    }
    const tiles = Array.from({ length: width * height }, (_, cell) =>
      walls.has(cell)
        ? cell < width
          ? "cap"
          : "wall"
        : ((cell % width) + Math.floor(cell / width)) % 7 === 0
          ? "variation"
          : "floor",
    );
    const entities: TileSceneEntity[] = [];
    for (const [i, cell] of def.goals.entries())
      entities.push({
        id: `goal-${i}`,
        x: (cell % width) + 0.5,
        y: Math.floor(cell / width) + 1,
        frame: "goal",
        layer: "ground",
        glow: crates.has(cell) ? 0xa8dfb6 : 0x6f9caf,
        tint: crates.has(cell) ? 0xb7e9b5 : 0xb3b8ba,
        interpolate: false,
      });
    // Crate indices are not stable when the grid owner sorts positions. Match a
    // moved crate to its previous cell by proximity purely for visual continuity.
    const previous =
      this.mapped?.sceneId === `room-${state.room}`
        ? this.mapped.entities.filter((e) => e.id.startsWith("crate-"))
        : [];
    const reserved = new Map<number, TileSceneEntity>();
    const available = previous.filter((e) => {
      const cell = grid.position.crates.find(
        (c) => e.x === (c % width) + 0.5 && e.y === Math.floor(c / width) + 1,
      );
      if (cell !== undefined) {
        reserved.set(cell, e);
        return false;
      }
      return true;
    });
    for (const [i, cell] of grid.position.crates.entries()) {
      const x = (cell % width) + 0.5,
        y = Math.floor(cell / width) + 1;
      const near = available.findIndex(
        (e) => Math.abs(e.x - x) + Math.abs(e.y - y) <= 1,
      );
      const old =
        reserved.get(cell) ??
        (near >= 0 ? available.splice(near, 1)[0] : undefined);
      entities.push({
        id: old?.id ?? `crate-${i}`,
        x,
        y,
        frame: "crate",
        shadow: true,
        tint: def.goals.includes(cell) ? 0xbfe3bf : 0xffffff,
        interpolate: !changed,
      });
    }
    entities.push({
      id: "hero",
      x: (player % width) + 0.5,
      y: Math.floor(player / width) + 1,
      clip: `hero.${state.cooldown > 0 ? "walk" : "idle"}:${this.facing}`,
      shadow: true,
      interpolate: !changed,
    });
    entities.push({
      id: "plaque",
      x: (def.start % width) + 0.5,
      y: Math.max(1.8, Math.floor(def.start / width)),
      frame: "plaque",
      label: room.discovered ? clue?.name : "INSPECT · E",
      action: "clue",
      interpolate: false,
    });
    for (const x of [1.5, width - 1.5])
      entities.push({
        id: `torch-${x}`,
        x,
        y: 1.5,
        clip: "torch.burn",
        glow: 0xefad55,
        layer: "foreground",
        interpolate: false,
      });
    const goalsFilled = def.goals.filter((cell) => crates.has(cell)).length;
    return {
      sceneId: `room-${state.room}`,
      revision: 0,
      width,
      height,
      tiles,
      entities,
      time: state.clock,
      title: `${state.room + 1}  ${this.options.roomNames?.[state.room] ?? clue?.name ?? "Echo Chamber"}`,
      subtitle: room.discovered
        ? `${clue?.symbol ?? ""}  ${clue?.text ?? ""}`
        : "A silent chamber. Read the inscription beside the entrance.",
      status:
        this.options.status?.() ??
        `${goalsFilled} / ${def.goals.length} resonators aligned${room.active ? " · CHAMBER RESTORED" : ""}`,
      controls: [
        { frame: "ui.key.up", text: "Move" },
        { text: "E  Inspect / attune", action: "interact" },
        { text: "U  Undo", action: "undo" },
        { frame: "ui.key.r", text: "Reset", action: "reset" },
        { text: "H  Hall", action: "hub" },
      ],
    };
  }
}
