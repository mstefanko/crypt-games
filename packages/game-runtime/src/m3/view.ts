import { Graphics } from "pixi.js";
import { M2View } from "../m2-view.ts";
import type { PreparedSkin } from "../m2-assets.ts";
import type { GameDefinitions } from "../../../game-project/src/types.ts";
import type { Observation } from "../../../game-simulation/src/types.ts";
import type { ArenaObservation } from "../../../game-simulation/src/m3/arena.ts";
import type { GridState } from "../../../game-simulation/src/m3/grid.ts";
import {
  applyViewportStyle,
  clientToLogical,
  type CssBounds,
  type ViewportMapping,
} from "../presentation/viewport.ts";

/** The shared Pixi owner retains the reviewed prepared-atlas cancellation and disposal path. */
export class M3View {
  readonly base: M2View;
  private graphics = new Graphics();
  private disposed = false;
  private submissions = 0;
  private viewport?: ViewportMapping;
  readonly logicalSize: Readonly<{ width: number; height: number }>;
  private actorTemplate = {
    spawnId: "presentation",
    archetypeId: "hero",
    team: 0,
    stunTicks: 0,
    grounded: true,
    hurt: { x: 0, y: 0, width: 1, height: 1 },
    push: { x: 0, y: 0, width: 1, height: 1 },
  };
  constructor(
    skin: PreparedSkin & { atlasUrl: string },
    duelDefinitions: GameDefinitions,
    profile = "duel",
  ) {
    const definitions =
      profile === "duel"
        ? duelDefinitions
        : {
            ...duelDefinitions,
            levels: duelDefinitions.levels.map((level) => ({
              ...level,
              id: "arena-ring",
              height: 180,
              tiles: [],
              rectangles: [],
              goal: { ...level.goal, x: -10000 },
            })),
          };
    this.base = new M2View(definitions, skin);
    this.logicalSize = Object.freeze({ ...definitions.manifest.viewport });
  }
  get canvas() {
    return this.base.canvas;
  }
  async init() {
    await this.base.init();
    if (!this.disposed) this.base.addWorldBackground(this.graphics);
  }
  /** The caller owns resize observation; the presenter owns its renderer. */
  resizeViewport(mapping: ViewportMapping): void {
    if (this.disposed) return;
    if (
      mapping.logicalWidth !== this.logicalSize.width ||
      mapping.logicalHeight !== this.logicalSize.height
    )
      throw new RangeError(
        "Viewport logical dimensions do not match the presenter",
      );
    if (
      mapping.resolution > 0 &&
      (this.base.app.renderer.resolution !== mapping.resolution ||
        this.base.app.screen.width !== mapping.logicalWidth ||
        this.base.app.screen.height !== mapping.logicalHeight)
    ) {
      this.base.app.renderer.resize(
        mapping.logicalWidth,
        mapping.logicalHeight,
        mapping.resolution,
      );
      // Resize can clear the backing buffer while the host clock is paused.
      this.base.app.render();
      this.submissions++;
    }
    applyViewportStyle(this.canvas, mapping);
    this.viewport = mapping;
  }
  /** Current surface bounds avoid stale page offsets after scroll or layout changes. */
  pick(clientX: number, clientY: number, bounds?: CssBounds) {
    if (this.disposed || !this.viewport || this.canvas.hidden) return null;
    const surface =
      bounds ?? this.canvas.parentElement?.getBoundingClientRect();
    const logical = surface
      ? clientToLogical(this.viewport, surface, { x: clientX, y: clientY })
      : null;
    return logical ? this.base.worldPoint(logical) : null;
  }
  setPresentationOptions(
    options: Parameters<M2View["setPresentationOptions"]>[0],
  ): void {
    this.base.setPresentationOptions(options);
  }
  duel(
    previous: Observation,
    current: Observation,
    alpha: number,
    epoch: number,
    guards: number[],
  ) {
    this.graphics.clear();
    this.base.setGuardSlots(guards);
    this.base.render(previous, current, alpha, epoch, epoch);
    this.submissions++;
  }
  arena(observation: ArenaObservation, epoch = 0) {
    const g = this.graphics;
    g.clear().rect(0, 0, 320, 180).fill(0x142438);
    for (const wall of observation.walls)
      g.rect(
        wall.x / 256,
        wall.y / 256,
        wall.width / 256,
        wall.height / 256,
      ).fill(0x45616e);
    for (const p of observation.projectiles)
      g.rect(p.x / 256, p.y / 256, p.width / 256, p.height / 256).fill(
        0xfff0ba,
      );
    const actors = observation.actors.map((actor) => ({
      ...this.actorTemplate,
      id: actor.id,
      slot: actor.kind === "player" ? 0 : null,
      x: actor.x,
      y: actor.y,
      width: actor.width,
      height: actor.height,
      health: actor.hp,
      maxHealth: 5,
      freezeTicks: actor.freezeTicks,
      motionEpoch: actor.motionEpoch,
      facing: (actor.aim > 64 && actor.aim < 192 ? -1 : 1) as -1 | 1,
      abilityId: null,
      abilityTick: 0,
      hit: null,
    }));
    const current: Observation = {
      tick: observation.tick,
      levelId: "arena-ring",
      status: "playing",
      actors,
      platforms: [],
      goal: { x: -10000, y: 0, width: 1, height: 1, nextLevelId: null },
      campaign: { visitedLevelIds: [], defeatedPlacementIds: [] },
    };
    this.base.render(current, current, 1, epoch, epoch);
    this.submissions++;
  }
  board(state: GridState) {
    this.base.resetWorldPresentation();
    const g = this.graphics;
    g.clear().rect(0, 0, 320, 180).fill(0x142438);
    const def = state.definition,
      size = Math.min(26, 150 / def.height),
      ox = (320 - def.width * size) / 2,
      oy = 15;
    for (let cell = 0; cell < def.width * def.height; cell++) {
      const x = ox + (cell % def.width) * size,
        y = oy + Math.floor(cell / def.width) * size;
      g.rect(x, y, size - 1, size - 1).fill(
        def.walls.includes(cell) ? 0x45616e : 0x203a46,
      );
      if (def.goals.includes(cell))
        g.circle(x + size / 2, y + size / 2, size / 4).fill(0x79c99e);
      if (state.position.crates.includes(cell))
        g.roundRect(x + 3, y + 3, size - 7, size - 7, 2).fill(
          def.goals.includes(cell) ? 0x79c99e : 0xe6ac64,
        );
      if (state.position.player === cell)
        g.circle(x + size / 2, y + size / 2, size / 3).fill(0xd8ecff);
    }
    this.base.app.render();
    this.submissions++;
  }
  adventure(
    map: {
      width: number;
      height: number;
      walls: readonly number[];
      pickups: readonly { id: string; cell: number }[];
      exits: readonly { cell: number }[];
      npcs?: readonly { cell: number }[];
    },
    player: number,
    removed: readonly string[],
  ) {
    this.base.resetWorldPresentation();
    const g = this.graphics;
    g.clear().rect(0, 0, 320, 180).fill(0x142438);
    const size = Math.min(22, 150 / map.height),
      ox = (320 - map.width * size) / 2,
      oy = 15;
    for (let cell = 0; cell < map.width * map.height; cell++) {
      const x = ox + (cell % map.width) * size,
        y = oy + Math.floor(cell / map.width) * size;
      g.rect(x, y, size - 1, size - 1).fill(
        map.walls.includes(cell) ? 0x45616e : 0x203a46,
      );
      if (map.exits.some((e) => e.cell === cell))
        g.rect(x + 3, y + 3, size - 7, size - 7).fill(0x79c99e);
      if (map.pickups.some((p) => p.cell === cell && !removed.includes(p.id)))
        g.circle(x + size / 2, y + size / 2, 4).fill(0xffd080);
      if (map.npcs?.some((p) => p.cell === cell))
        g.circle(x + size / 2, y + size / 2, 6).fill(0xb8b3ff);
      if (player === cell)
        g.circle(x + size / 2, y + size / 2, size / 3).fill(0xd8ecff);
    }
    this.base.app.render();
    this.submissions++;
  }
  stats() {
    return {
      ...this.base.metrics,
      submissions: this.submissions,
      viewport: this.viewport ?? null,
      presentation: this.base.presentationStats(),
    };
  }
  dispose() {
    this.disposed = true;
    this.base.dispose();
    if (!this.graphics.destroyed) this.graphics.destroy();
  }
}
