import { sideViewLayout } from "./side-view-layout";
import type { PlatformJourneyObservation } from "@onepage/game-simulation/platform-journey-session";
import {
  AtlasLoader,
  ClipPlayer,
  Container,
  Graphics,
  Sprite,
  type PixiPresenter,
  type PixiStage,
} from "./index";
import { PixelSceneHud, type PixelSceneHudState } from "./pixel-scene-hud";

export interface PlatformSceneDefinition {
  viewport: { width: number; height: number; maxScale?: number };
  palette: { sky: number; horizon: number; void: number };
  terrain: { top: string; fill: string; platform: string };
  hero: {
    scale?: number;
    clips: Record<"idle" | "run" | "jump" | "fall" | "land", string>;
  };
  collectible: { frame?: string; clip?: string };
  spring: string;
  signal: { off: string; on: string };
  checkpoint: string;
  checkpointActive?: string;
  checkpointX: number;
  goalHeights?: readonly number[];
  scenery?: readonly { frame: string; x: number; y: number }[];
  goal: string;
  backgrounds?: readonly {
    frame: string;
    x: number;
    y: number;
    parallax: number;
    scale?: number;
    repeat?: number;
  }[];
  controls: PixelSceneHudState["controls"];
  roomHints: readonly string[];
}
export interface PlatformPresenterOptions {
  scene: PlatformSceneDefinition;
  observe: () => PlatformJourneyObservation;
  atlasUrl: string;
  fontUrl?: string;
  title?: string;
  status?: () => string;
  onAction?: (action: string) => void;
  isInteractive?: () => boolean;
}
type Visual = { sprite: Sprite; clip: ClipPlayer };
/** Native side-view presentation. Coordinates and actor velocity are read-only
 * owner observations; cosmetic clips use the simulation clock, never a ticker. */
export class PlatformPresenter implements PixiPresenter {
  private stage?: PixiStage;
  private atlas = new AtlasLoader();
  private backdrop = new Container();
  private background = new Container();
  private terrain = new Container();
  private objects = new Container();
  private hero = new ClipPlayer();
  private frame = new Graphics();
  private sky = new Graphics();
  private mask = new Graphics();
  private world = new Container();
  private hud = new PixelSceneHud(
    this.atlas,
    (action) => this.options.onAction?.(action),
    () => this.interactive && (this.options.isInteractive?.() ?? true),
  );
  private visuals = new Map<string, Visual>();
  private backgroundSprites: { sprite: Sprite; x: number; parallax: number }[] =
    [];
  private room = -1;
  private ready = false;
  private disposed = false;
  private interactive = false;
  private width = 960;
  private height = 720;
  private scale = 1;
  private offset = { x: 0, y: 0 };
  private previousGrounded = true;
  private landedAt = -100;
  private lastElapsed = 0;
  private resetCamera = true;
  private previousImageRendering = "";
  constructor(private options: PlatformPresenterOptions) {}
  async init(stage: PixiStage) {
    if (this.disposed || this.stage)
      throw new Error("Platform presenter is already initialized or disposed");
    this.resetCamera = true;
    stage.camera.reset();
    stage.camera.pan(0, 0);
    stage.camera.zoom = 1;
    this.stage = stage;
    this.previousImageRendering = stage.canvas.style.imageRendering;
    this.world.addChild(this.terrain, this.objects, this.hero.sprite);
    stage.layers.ground.addChild(this.world);
    this.backdrop.addChild(this.frame, this.sky, this.background, this.mask);
    stage.app.stage.addChildAt(this.backdrop, 0);
    this.world.mask = this.mask;
    this.background.mask = this.mask;
    stage.layers.hud.addChild(this.hud.root);
    this.hud.update({ title: "Opening the skyline…" });
    this.resize(stage.width, stage.height);
    try {
      await this.atlas.loadUrl(this.options.atlasUrl);
      if (this.disposed) return;
      this.hud.load(this.options.fontUrl);
      this.ready = true;
      this.render(0);
    } catch (error) {
      if (!this.disposed)
        this.hud.update({
          title: "Artwork could not load",
          status: "Reload the scene to retry loading its atlas.",
        });
      throw error;
    }
  }
  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    if (this.stage) this.stage.canvas.style.imageRendering = "pixelated";
    const view = this.options.scene.viewport;
    const layout = sideViewLayout(width, height, view);
    const oldOriginX = -this.offset.x / this.scale;
    const oldOriginY = -this.offset.y / this.scale;
    this.scale = layout.scale;
    this.offset = layout.offset;
    if (this.stage && !this.resetCamera)
      this.stage.camera.pan(
        this.stage.camera.x - oldOriginX - this.offset.x / this.scale,
        this.stage.camera.y - oldOriginY - this.offset.y / this.scale,
      );
    this.hud.resize(width, height);
    this.frame.clear().rect(0, 0, width, height).fill(0x0b141e);
    this.sky
      .clear()
      .rect(
        this.offset.x,
        this.offset.y,
        view.width * this.scale,
        view.height * this.scale,
      )
      .fill(this.options.scene.palette.sky);
    this.mask
      .clear()
      .rect(
        this.offset.x,
        this.offset.y,
        view.width * this.scale,
        view.height * this.scale,
      )
      .fill(0xffffff);
    this.background.position.set(this.offset.x, this.offset.y);
    this.background.scale.set(this.scale);
  }
  private sprite(frame: string) {
    const metadata = this.atlas.manifest!.frames[frame];
    if (!metadata) throw Error(`Missing platform scene frame ${frame}`);
    const sprite = new Sprite(this.atlas.texture(frame));
    sprite.pivot.set(
      (metadata.pivot?.x ?? 0) - (metadata.trim?.x ?? 0),
      (metadata.pivot?.y ?? 0) - (metadata.trim?.y ?? 0),
    );
    return sprite;
  }
  private rebuild(state: PlatformJourneyObservation) {
    this.terrain
      .removeChildren()
      .forEach((child) => child.destroy({ children: true }));
    this.background
      .removeChildren()
      .forEach((child) => child.destroy({ children: true }));
    this.backgroundSprites = [];
    for (const bg of this.options.scene.backgrounds ?? []) {
      const metadata = this.atlas.manifest!.frames[bg.frame];
      if (!metadata) throw Error(`Missing background frame ${bg.frame}`);
      const scale = bg.scale ?? 1;
      for (let i = 0; i < (bg.repeat ?? 1); i++) {
        const sprite = this.sprite(bg.frame),
          x = bg.x + i * metadata.width * scale;
        sprite.position.set(x, bg.y);
        sprite.scale.set(scale);
        this.background.addChild(sprite);
        this.backgroundSprites.push({ sprite, x, parallax: bg.parallax });
      }
    }
    const { level } = state,
      size = level.tileSize,
      columns = Math.round(level.width / size);
    for (let i = 0; i < level.tiles.length; i++) {
      if (!level.tiles[i]) continue;
      const frame =
        i < columns || !level.tiles[i - columns]
          ? this.options.scene.terrain.top
          : this.options.scene.terrain.fill;
      const sprite = this.sprite(frame);
      sprite.pivot.set(0);
      sprite.position.set((i % columns) * size, Math.floor(i / columns) * size);
      sprite.width = size;
      sprite.height = size;
      this.terrain.addChild(sprite);
    }
    for (const rect of level.rectangles)
      this.surface(
        this.terrain,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        this.options.scene.terrain.platform,
      );
    this.resetCamera = true;
    this.room = state.room;
    this.previousGrounded = state.player.grounded;
    this.landedAt = -100;
  }
  private surface(
    parent: Container,
    x: number,
    y: number,
    width: number,
    height: number,
    frame: string,
  ) {
    const size = 16;
    for (let py = 0; py < height; py += size)
      for (let px = 0; px < width; px += size) {
        const sprite = this.sprite(frame);
        sprite.pivot.set(0);
        sprite.position.set(x + px, y + py);
        sprite.width = Math.min(size, width - px);
        sprite.height = Math.min(size, height - py);
        parent.addChild(sprite);
      }
  }
  render(dt: number) {
    if (!this.ready || this.disposed || !this.stage) return;
    this.interactive = dt > 0;
    const state = this.options.observe(),
      scene = this.options.scene,
      p = state.player;
    if (state.room !== this.room) this.rebuild(state);
    const view = scene.viewport;
    const rewound = state.elapsed < this.lastElapsed;
    if (rewound) this.landedAt = -100;
    this.lastElapsed = state.elapsed;
    const lookAhead = Math.max(-48, Math.min(48, p.vx * 18));
    const target = p.x + lookAhead - view.width * 0.4;
    const originX = -this.offset.x / this.scale;
    const originY = -this.offset.y / this.scale;
    this.stage.camera.zoom = this.scale;
    if (this.resetCamera) this.stage.camera.pan(originX, originY);
    this.stage.camera.followBounded(
      target + originX,
      originY,
      12,
      {
        x: originX,
        y: originY,
        width: Math.max(0, state.level.width - view.width),
        height: 0,
      },
      rewound,
    );
    this.resetCamera = false;
    const cameraX = this.stage.camera.x - originX;
    for (const bg of this.backgroundSprites)
      bg.sprite.x = bg.x - cameraX * bg.parallax;
    const seen = new Set<string>();
    const object = (
      id: string,
      x: number,
      y: number,
      frame?: string,
      clipId?: string,
      width?: number,
      height?: number,
    ) => {
      seen.add(id);
      let visual = this.visuals.get(id);
      if (!visual) {
        const clip = new ClipPlayer();
        visual = { sprite: clip.sprite, clip };
        this.visuals.set(id, visual);
        this.objects.addChild(visual.sprite);
      }
      const sprite = visual.sprite;
      sprite.position.set(x, y);
      sprite.scale.set(1);
      if (clipId) {
        const clip = this.atlas.clip(clipId);
        if (!clip.frames.length) throw Error(`Missing platform clip ${clipId}`);
        visual.clip.sample(
          clip,
          (state.elapsed % (clip.metadata?.duration ?? 1)) /
            (clip.metadata?.duration ?? 1),
          clipId,
        );
      } else if (frame) {
        const f = this.atlas.manifest!.frames[frame];
        if (!f) throw Error(`Missing platform frame ${frame}`);
        sprite.texture = this.atlas.texture(frame);
        sprite.pivot.set(
          (f.pivot?.x ?? 0) - (f.trim?.x ?? 0),
          (f.pivot?.y ?? 0) - (f.trim?.y ?? 0),
        );
      }
      if (width !== undefined) {
        sprite.pivot.set(0);
        sprite.width = width;
      }
      if (height !== undefined) sprite.height = height;
    };
    for (const platform of state.platforms)
      object(
        `platform-${platform.id}`,
        platform.x,
        platform.y,
        scene.terrain.platform,
        undefined,
        platform.width,
        platform.height,
      );
    for (const token of state.collectibles)
      if (!token.collected)
        object(
          token.id,
          token.x,
          token.y + Math.sin(state.elapsed * 3 + token.x) * 2,
          scene.collectible.frame,
          scene.collectible.clip,
        );
    if (state.spring)
      object("spring", state.spring.x, state.spring.y, scene.spring);
    if (state.signal)
      object(
        "signal",
        state.signal.x,
        state.signal.y,
        state.signal.active ? scene.signal.on : scene.signal.off,
      );
    object(
      "checkpoint",
      scene.checkpointX,
      state.floor,
      state.checkpoint >= scene.checkpointX
        ? (scene.checkpointActive ?? scene.checkpoint)
        : scene.checkpoint,
    );
    for (const [index, item] of (scene.scenery ?? []).entries())
      object(`scenery-${index}`, item.x, item.y, item.frame);
    object(
      "goal",
      state.level.width - 26,
      scene.goalHeights?.[state.room] ?? state.floor,
      scene.goal,
    );
    for (const [id, visual] of this.visuals)
      if (!seen.has(id)) {
        visual.sprite.destroy();
        this.visuals.delete(id);
      }
    if (p.grounded && !this.previousGrounded) this.landedAt = state.elapsed;
    this.previousGrounded = p.grounded;
    const pose = !p.grounded
      ? p.vy < 0
        ? "jump"
        : "fall"
      : state.elapsed - this.landedAt < 0.14
        ? "land"
        : Math.abs(p.vx) > 0.1
          ? "run"
          : "idle";
    const clipId = scene.hero.clips[pose],
      clip = this.atlas.clip(clipId);
    if (!clip.frames.length) throw Error(`Missing hero clip ${clipId}`);
    clip.mirrorable = true;
    const duration = clip.metadata?.duration ?? 1;
    this.hero.sprite.scale.set(scene.hero.scale ?? 1);
    this.hero.sample(
      clip,
      pose === "land"
        ? Math.min(0.999, (state.elapsed - this.landedAt) / 0.14)
        : (state.elapsed % duration) / duration,
      `${state.room}:${clipId}`,
      p.facing < 0,
    );
    this.hero.sprite.position.set(p.x, p.y);
    this.hud.update({
      title: `${this.options.title ?? "Platform journey"} · ${state.roomName}`,
      subtitle: `ROUTE ${state.room + 1}/${state.roomCount}   ·   POSTAGE ${state.tokens}   ·   FLOW ${Math.round(state.flow * 100)}%   ·   RECOVERIES ${state.deaths}`,
      status: state.won
        ? "The last delivery is aboard. Skyline route complete."
        : `${scene.roomHints[state.room] ?? "Reach the next departure."}\n${this.options.status?.() ?? ""}`,
      controls: scene.controls,
    });
  }
  renderOutcome() {
    this.render(0);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.interactive = false;
    this.world.destroy({ children: true });
    this.backdrop.destroy({ children: true });
    this.hud.dispose();
    this.atlas.dispose();
    if (this.stage) {
      this.stage.canvas.style.imageRendering = this.previousImageRendering;
      this.stage.camera.pan(0, 0);
      this.stage.camera.zoom = 1;
    }
    this.stage = undefined;
  }
}
