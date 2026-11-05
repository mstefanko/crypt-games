import { Graphics, Container } from "pixi.js";
import {
  AtlasLoader,
  TileEntityPresenter,
  type TileEntity,
  type PixiPresenter,
  type PixiStage,
} from "./index";
import {
  productionActors,
  productionFootprint,
  type ProductionSceneState,
  type ProductionSceneStyle,
} from "./production-scene";
/** Retained semantic production view; time, jobs, cargo and selection are observations. */
export class SemanticProductionPresenter implements PixiPresenter {
  private atlas = new AtlasLoader();
  private retained: TileEntityPresenter;
  private ground: TileEntity[] = [];
  private ready = false;
  private disposed = false;
  private stage?: PixiStage;
  private marks = new Container();
  private selection = new Graphics();
  private construction = new Graphics();
  private beam = new Graphics();
  private shipPhase = 0;
  private lastOutcome?: string;
  constructor(
    private read: () => ProductionSceneState,
    private style: ProductionSceneStyle,
  ) {
    this.retained = new TileEntityPresenter(
      () =>
        this.ready
          ? [
              ...this.ground,
              ...productionActors(
                read(),
                style,
                this.atlas.manifest?.clips ?? {},
                this.shipPhase,
              ).map((e) => ({ ...e, texture: this.atlas.texture(e.frame) })),
            ]
          : [],
      () => read().offset,
    );
    this.marks.addChild(this.selection, this.construction, this.beam);
  }
  async init(stage: PixiStage) {
    this.stage = stage;
    stage.layers.actors.addChild(this.marks);
    this.marks.zIndex = 10000;
    this.retained.init(stage);
    this.resize();
    await this.atlas.loadUrl(this.style.atlasUrl);
    if (this.disposed) return;
    const s = this.style,
      n = s.cellSize;
    for (let y = 0; y < s.rows; y++)
      for (let x = 0; x < s.columns; x++) {
        const frame =
          x >= s.terrain.shoreColumn ? s.terrain.water : s.terrain.land;
        this.ground.push({
          id: `terrain:${x}:${y}`,
          texture: this.atlas.texture(frame),
          x: x * n,
          y: y * n,
          width: n,
          height: n,
          depth: -1000,
        });
        if (x < s.terrain.shoreColumn && (y === 3 || y === 5 || y === 7))
          this.ground.push({
            id: `path:${x}:${y}`,
            texture: this.atlas.texture(s.terrain.path),
            x: x * n,
            y: y * n + 12,
            width: n,
            height: 8,
            depth: -900,
            alpha: 0.45,
          });
      }
    this.ready = true;
  }
  resize() {
    if (this.stage) this.stage.canvas.style.imageRendering = "pixelated";
  }
  render(dt: number) {
    if (!this.ready) return;
    const state = this.read(),
      n = this.style.cellSize;
    if (state.outcome === "won")
      this.shipPhase = Math.min(1, this.shipPhase + dt / 4);
    else if (this.lastOutcome === "won") this.shipPhase = 0;
    this.lastOutcome = state.outcome;
    this.retained.render();
    this.selection.clear();
    this.construction.clear();
    this.beam.clear();
    const footprint = productionFootprint(state, this.style);
    if (footprint)
      this.selection
        .roundRect(
          footprint.x,
          footprint.y,
          footprint.width,
          footprint.height,
          3,
        )
        .stroke({ color: 0xffd88c, width: 2 });
    for (const site of state.sites)
      if (state.pending.includes(site.id)) {
        const x = (site.cell % this.style.columns) * n,
          y = Math.floor(site.cell / this.style.columns) * n;
        this.construction
          .rect(x, y + 18, n, 4)
          .fill(0x493d3c)
          .rect(x, y + 18, n * (0.2 + ((state.time % 2) / 2) * 0.8), 4)
          .fill(0xd6aa6f);
      }
    const light = state.sites.find(
      (s) => s.kind === "lighthouse" && s.repaired,
    );
    if (light) {
      const x = (light.cell % this.style.columns) * n + n / 2,
        y = Math.floor(light.cell / this.style.columns) * n - 36;
      this.beam
        .poly([x, y, x + 120, y - 30, x + 120, y + 30])
        .fill({ color: 0xffe9a3, alpha: 0.15 });
      this.beam.circle(x, y, 9).fill({ color: 0xffda82, alpha: 0.25 });
    }
  }
  renderOutcome(dt: number) {
    this.render(dt);
  }
  snapshot() {
    return {
      version: 1,
      shipPhase: this.shipPhase,
      lastOutcome: this.lastOutcome,
    };
  }
  restore(value: unknown) {
    const v = value as
      | { version: number; shipPhase: number; lastOutcome?: string }
      | undefined;
    if (!v) {
      this.shipPhase = 0;
      this.lastOutcome = undefined;
      return;
    }
    if (
      v.version !== 1 ||
      !Number.isFinite(v.shipPhase) ||
      v.shipPhase < 0 ||
      v.shipPhase > 1 ||
      (v.lastOutcome !== undefined &&
        !["playing", "won", "lost"].includes(v.lastOutcome))
    )
      throw Error("Invalid production presentation checkpoint");
    this.shipPhase = v.shipPhase;
    this.lastOutcome = v.lastOutcome;
  }
  dispose() {
    this.disposed = true;
    this.retained.dispose();
    this.atlas.dispose();
    this.marks.destroy({ children: true });
  }
}
