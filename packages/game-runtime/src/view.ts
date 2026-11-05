import { Application, BitmapText, Container, Graphics, Sprite } from "pixi.js";
import type { GameDefinitions } from "../../game-project/src/types.ts";
import { observe } from "../../game-simulation/src/index.ts";
import { makeArt } from "./art.ts";
import { interpolatePosition } from "./interpolation.ts";
import {
  applyViewportStyle,
  clientToLogical,
  type CssBounds,
  type ViewportMapping,
} from "./presentation/viewport.ts";
type Observation = ReturnType<typeof observe>;

export class GameView {
  readonly app = new Application();
  private art: ReturnType<typeof makeArt> | undefined;
  private world = new Container();
  private terrain = new Container();
  private actors = new Container();
  private effects = new Graphics();
  private hud: BitmapText | undefined;
  private sprites = new Map<string, Sprite>();
  private tileSprites = new Map<number, Sprite>();
  private levelId = "";
  private destroyed = false;
  private initialized = false;
  private viewport?: ViewportMapping;

  constructor(private definitions: GameDefinitions) {
    this.app.stage.addChild(this.world);
    this.world.addChild(this.terrain, this.actors, this.effects);
  }

  get logicalSize(): Readonly<{ width: number; height: number }> {
    return this.definitions.manifest.viewport;
  }
  get viewportMapping(): ViewportMapping | undefined {
    return this.viewport;
  }
  /** Host owns observation; resize redraws the retained scene even while paused. */
  resizeViewport(mapping: ViewportMapping, forceRedraw = false): void {
    if (this.destroyed || !this.initialized) return;
    if (
      mapping.logicalWidth !== this.logicalSize.width ||
      mapping.logicalHeight !== this.logicalSize.height
    )
      throw new RangeError(
        "Viewport logical dimensions do not match the presenter",
      );
    // Reject stale inverse mapping if renderer allocation or redraw fails.
    const needsRedraw = forceRedraw || !this.viewport;
    this.viewport = undefined;
    const resize =
      mapping.resolution > 0 &&
      (this.app.renderer.resolution !== mapping.resolution ||
        this.app.screen.width !== mapping.logicalWidth ||
        this.app.screen.height !== mapping.logicalHeight);
    if (resize)
      this.app.renderer.resize(
        mapping.logicalWidth,
        mapping.logicalHeight,
        mapping.resolution,
      );
    if (mapping.resolution > 0 && (resize || needsRedraw)) this.app.render();
    applyViewportStyle(this.app.canvas, mapping);
    this.viewport = mapping;
  }
  /** Current outer bounds include scrolling and axis-aligned CSS transforms. */
  pick(clientX: number, clientY: number, bounds?: CssBounds) {
    if (this.destroyed || !this.viewport || this.app.canvas.hidden) return null;
    const surface =
      bounds ?? this.app.canvas.parentElement?.getBoundingClientRect();
    return surface
      ? clientToLogical(this.viewport, surface, { x: clientX, y: clientY })
      : null;
  }

  async init(): Promise<void> {
    const { width, height } = this.definitions.manifest.viewport;
    try {
      await this.app.init({
        width,
        height,
        resolution: 1,
        antialias: false,
        autoStart: false,
        sharedTicker: false,
        background: "#142438",
        preference: "webgl",
        roundPixels: true,
      });
    } catch (error) {
      // Application.destroy assumes plugins finished initializing. They may not
      // exist yet when renderer initialization rejects, so release owned parts.
      this.destroyed = true;
      this.app.ticker?.destroy();
      this.app.stage?.destroy({ children: true });
      this.app.renderer?.destroy({
        removeView: true,
        releaseGlobalResources: false,
      });
      throw error;
    }
    this.initialized = true;
    this.app.stop();
    if (this.destroyed) {
      this.app.destroy(
        { removeView: true, releaseGlobalResources: false },
        { children: true },
      );
      return;
    }
    this.art = makeArt();
    const hudBackground = new Graphics()
      .rect(0, 0, width, 17)
      .fill({ color: 0x0b1724, alpha: 0.94 });
    this.app.stage.addChild(hudBackground);
    this.hud = new BitmapText({
      text: "",
      style: { fontFamily: this.art.fontName, fontSize: 5, fill: 0xe9f4ee },
    });
    this.hud.position.set(7, 6);
    this.app.stage.addChild(this.hud);
    this.app.canvas.setAttribute(
      "aria-label",
      "Game world. Live health and status also appear below.",
    );
    this.app.canvas.setAttribute("role", "img");
  }

  render(
    previous: Observation,
    current: Observation,
    alpha: number,
    previousEpoch: number,
    epoch: number,
  ): void {
    if (!this.art || this.destroyed) return;
    const level = this.definitions.levels.find(
      (candidate) => candidate.id === current.levelId,
    )!;
    const { width, height } = this.definitions.manifest.viewport;
    if (this.levelId !== level.id) {
      this.levelId = level.id;
      for (const sprite of this.tileSprites.values()) sprite.destroy();
      this.tileSprites.clear();
      for (const sprite of this.sprites.values()) sprite.destroy();
      this.sprites.clear();
    }
    const followed =
      current.actors.find((actor) => actor.slot === 0) ?? current.actors[0];
    const followedPose = followed
      ? interpolatePosition(
          previous.actors.find((actor) => actor.id === followed.id),
          followed,
          alpha,
          previousEpoch,
          epoch,
        )
      : { x: 0, y: 0 };
    const cameraX = Math.round(
      Math.max(
        0,
        Math.min(level.width - width, followedPose.x / 256 - width * 0.38),
      ),
    );
    const cameraY = Math.round(
      Math.max(
        0,
        Math.min(level.height - height, followedPose.y / 256 - height * 0.55),
      ),
    );
    this.world.position.set(-cameraX, -cameraY);
    this.effects.clear();
    const visible = new Set<number>();
    for (
      let y = Math.max(0, Math.floor(cameraY / level.tileSize) - 1);
      y <=
      Math.min(
        level.height / level.tileSize - 1,
        Math.ceil((cameraY + height) / level.tileSize) + 1,
      );
      y += 1
    ) {
      for (
        let x = Math.max(0, Math.floor(cameraX / level.tileSize) - 1);
        x <=
        Math.min(
          level.width / level.tileSize - 1,
          Math.ceil((cameraX + width) / level.tileSize) + 1,
        );
        x += 1
      ) {
        const index = y * (level.width / level.tileSize) + x;
        const tile = level.tiles[index];
        if (!tile) continue;
        visible.add(index);
        let sprite = this.tileSprites.get(index);
        if (!sprite) {
          sprite = new Sprite(this.art.frames[tile === 2 ? 1 : 0]);
          sprite.position.set(x * level.tileSize, y * level.tileSize);
          sprite.width = level.tileSize;
          sprite.height = level.tileSize;
          this.terrain.addChild(sprite);
          this.tileSprites.set(index, sprite);
        }
      }
    }
    for (const [index, sprite] of this.tileSprites)
      if (!visible.has(index)) {
        sprite.destroy();
        this.tileSprites.delete(index);
      }
    const live = new Set<string>();
    const rectSprite = (
      key: string,
      frame: number,
      x: number,
      y: number,
      w: number,
      h: number,
    ) => {
      live.add(key);
      let sprite = this.sprites.get(key);
      if (!sprite) {
        sprite = new Sprite(this.art!.frames[frame]);
        this.actors.addChild(sprite);
        this.sprites.set(key, sprite);
      }
      sprite.position.set(Math.round(x), Math.round(y));
      sprite.width = w;
      sprite.height = h;
      return sprite;
    };
    for (const rect of level.rectangles)
      rectSprite(
        `rect:${rect.id}`,
        rect.oneWay ? 1 : 0,
        rect.x / 256,
        rect.y / 256,
        rect.width / 256,
        rect.height / 256,
      );
    const goal = level.goal;
    rectSprite(
      "goal",
      4,
      goal.x / 256,
      goal.y / 256,
      goal.width / 256,
      goal.height / 256,
    );
    for (const platform of current.platforms) {
      const sprite = rectSprite(
        `platform:${platform.id}`,
        5,
        platform.x / 256,
        platform.y / 256,
        platform.width / 256,
        platform.height / 256,
      );
      sprite.tint = platform.blocked ? 0xffaf85 : 0xffffff;
    }
    for (const actor of current.actors) {
      const before = previous.actors.find(
        (candidate) => candidate.id === actor.id,
      );
      const pose = interpolatePosition(
        before,
        actor,
        alpha,
        previousEpoch,
        epoch,
      );
      const sprite = rectSprite(
        `actor:${actor.id}`,
        actor.slot === null ? 3 : 2,
        pose.x / 256 - 2,
        pose.y / 256 - 2,
        actor.width / 256 + 4,
        actor.height / 256 + 2,
      );
      sprite.anchor.set(0.5, 0);
      sprite.scale.x = Math.abs(sprite.scale.x) * actor.facing;
      sprite.x = Math.round((pose.x + actor.width / 2) / 256);
      sprite.tint =
        actor.freezeTicks > 0
          ? 0xffffff
          : actor.slot === 1
            ? 0xb8b3ff
            : 0xffffff;
      sprite.alpha = actor.health > 0 ? 1 : 0.35;
      // The observation owns active hit geometry; art never decides reach.
      if (actor.hit) {
        const offsetX = (pose.x - actor.x) / 256;
        const offsetY = (pose.y - actor.y) / 256;
        this.effects
          .rect(
            Math.round(actor.hit.x / 256 + offsetX),
            Math.round(actor.hit.y / 256 + offsetY),
            actor.hit.width / 256,
            actor.hit.height / 256,
          )
          .fill({ color: 0xffda85, alpha: 0.62 });
      }
    }
    for (const [key, sprite] of this.sprites)
      if (!live.has(key)) {
        sprite.destroy();
        this.sprites.delete(key);
      }
    const player = current.actors.find((actor) => actor.slot === 0);
    this.hud!.text = `HP ${player?.health ?? 0}/${player?.maxHealth ?? 0}  ${level.id.toUpperCase().replace(/[^A-Z0-9 -]/g, " ")}  T ${current.tick}`;
    if (current.status !== "playing")
      this.hud!.text += `  ${current.status.toUpperCase()}`;
    this.app.render();
  }

  // Renderer destruction must not clear Pixi global pools: another adopted or
  // initializing view can still own batches from those shared pools.
  dispose(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (!this.initialized) return; // init owns late-promise cleanup.
    this.app.destroy(
      { removeView: true, releaseGlobalResources: false },
      { children: true },
    );
    this.art?.dispose();
    this.art = undefined;
  }
}
