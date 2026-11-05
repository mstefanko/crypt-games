import { PixelSceneHud } from "./pixel-scene-hud";
import {
  AtlasLoader,
  Container,
  Graphics,
  Sprite,
  Text,
  ClipPlayer,
  type PixiPresenter,
  type PixiStage,
} from "./index";
import type {
  TileSceneEntity,
  TileSceneLayer,
  TileSceneObservation,
  TileSceneOptions,
} from "./scene-contract";

type RetainedEntity = {
  root: Container;
  sprite: Sprite;
  clip: ClipPlayer;
  shadow: Graphics;
  halo: Graphics;
  label: Text;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  action?: string;
};
/** Native retained pixel scene, shared by grid-puzzle and adventure presenters.
 * AtlasLoader owns page leases; the scene owns only its containers/frame handles.
 * Terrain updates on revisions, while stable entity IDs retain display objects. */
export class TileScenePresenter implements PixiPresenter {
  private stage?: PixiStage;
  private atlas = new AtlasLoader();
  private board = new Container();
  private layers: Record<TileSceneLayer, Container> = {
    ground: new Container(),
    actors: new Container(),
    foreground: new Container(),
  };
  private hud = new Container();
  private weather = new Graphics();
  private border = new Graphics();
  private pixelHud = new PixelSceneHud(
    this.atlas,
    (action) => this.options.onAction?.(action),
    () => this.interactive && (this.options.isInteractive?.() ?? true),
  );
  private entities = new Map<string, RetainedEntity>();
  private terrainKey = "";
  private ready = false;
  private disposed = false;
  private interactive = false;
  private width = 768;
  private height = 512;
  private observation?: TileSceneObservation;
  private previousImageRendering = "";
  constructor(private options: TileSceneOptions) {}
  async init(stage: PixiStage) {
    this.stage = stage;
    this.previousImageRendering = stage.canvas.style.imageRendering;
    this.board.addChild(
      this.layers.ground,
      this.layers.actors,
      this.layers.foreground,
      this.weather,
    );
    this.layers.actors.sortableChildren = true;
    stage.camera.pan(0, 0);
    stage.camera.zoom = 1;
    stage.layers.ground.addChild(this.border, this.board);
    stage.layers.hud.addChild(this.hud);
    this.hud.addChild(this.pixelHud.root);
    this.pixelHud.update({ title: "Opening the journey…" });
    this.resize(stage.width, stage.height);
    try {
      await this.atlas.loadUrl(this.options.atlasUrl);
      if (this.disposed) return;
      this.pixelHud.load(this.options.fontUrl);
      this.ready = true;
      this.render(0);
    } catch (error) {
      if (this.disposed) return;
      this.pixelHud.update({
        title: "Artwork could not load",
        status: "Reload the scene to retry loading its atlas.",
      });
      throw error;
    }
  }
  resize(width = 768, height = 512) {
    this.width = width;
    this.height = height;
    if (this.stage) this.stage.canvas.style.imageRendering = "pixelated";
    this.layout();
  }
  private layout() {
    const w = this.width,
      h = this.height;
    this.pixelHud.resize(w, h);
    this.border.clear().rect(0, 0, w, h).fill(0x0b141e);
    // A quiet outer frame; native UI geometry complements the selected art.
    this.border
      .rect(18, 79, w - 36, h - 177)
      .fill(0x111d2a)
      .stroke({ color: 0x384b61, width: 1 });
    const s = this.observation;
    if (!s) return;
    const size = this.options.tileSize ?? 16;
    const fit = Math.min(
      (w - 70) / (s.width * size),
      (h - 186) / (s.height * size),
    );
    const scale =
      fit >= 1 ? Math.min(this.options.maxScale ?? 4, Math.floor(fit)) : fit;
    this.board.scale.set(scale);
    this.board.position.set(
      Math.round((w - s.width * size * scale) / 2),
      Math.round(83 + (h - 186 - s.height * size * scale) / 2),
    );
  }
  /** Same displayed transform as native sprite picking, including camera pan/zoom. */
  cellAt(clientX: number, clientY: number) {
    if (!this.stage) return undefined;
    const logical = this.stage.pointer(clientX, clientY),
      world = this.stage.camera.inverse(logical.x, logical.y),
      size = this.options.tileSize ?? 16;
    return {
      x: Math.floor((world.x - this.board.x) / this.board.scale.x / size),
      y: Math.floor((world.y - this.board.y) / this.board.scale.y / size),
    };
  }
  render(dt: number) {
    if (this.disposed) return;
    this.interactive = dt > 0 && (this.options.isInteractive?.() ?? true);
    if (!this.ready) return;
    const s = this.options.observe();
    this.observation = s;
    const key = `${s.sceneId}:${s.revision}:${s.width}:${s.height}`;
    if (key !== this.terrainKey) {
      const sceneChanged = s.sceneId !== this.terrainKey.split(":")[0];
      if (sceneChanged) this.clearEntities();
      this.terrainKey = key;
      this.rebuildTerrain(s);
      this.layout();
    }
    this.pixelHud.update(s);
    this.updateWeather(s);
    const seen = new Set<string>(),
      size = this.options.tileSize ?? 16;
    for (const e of s.entities) {
      seen.add(e.id);
      let item = this.entities.get(e.id);
      if (!item) {
        item = this.createEntity(e);
        this.entities.set(e.id, item);
      }
      const layer = this.layers[e.layer ?? "actors"];
      if (item.root.parent !== layer) layer.addChild(item.root);
      const tx = e.x * size,
        ty = e.y * size;
      if (item.targetX !== tx || item.targetY !== ty) {
        item.targetX = tx;
        item.targetY = ty;
      }
      const interpolate = e.interpolate !== false && dt > 0;
      const blend = interpolate ? Math.min(1, dt * 18) : 1;
      item.x += (tx - item.x) * blend;
      item.y += (ty - item.y) * blend;
      if (Math.abs(tx - item.x) < 0.05) item.x = tx;
      if (Math.abs(ty - item.y) < 0.05) item.y = ty;
      item.root.position.set(item.x, item.y);
      item.root.zIndex = ty;
      item.root.alpha = e.alpha ?? 1;
      item.sprite.tint = e.tint ?? 0xffffff;
      item.sprite.scale.set(e.scale ?? 1);
      item.action = e.action;
      item.root.eventMode = e.action && this.interactive ? "static" : "none";
      item.root.cursor = e.action ? "pointer" : "default";
      if (e.clip) {
        const clip = this.atlas.clip(e.clip),
          duration = clip.metadata?.duration ?? 1;
        if (!clip.frames.length) throw Error(`Missing entity clip ${e.clip}`);
        item.clip.sample(
          clip,
          e.phase ?? (s.time % duration) / duration,
          e.clip,
        );
      } else if (e.frame) {
        const f = this.atlas.manifest!.frames[e.frame];
        if (!f) throw Error(`Missing entity frame ${e.frame}`);
        item.sprite.texture = this.atlas.texture(e.frame);
        item.sprite.pivot.set(
          (f?.pivot?.x ?? 0) - (f?.trim?.x ?? 0),
          (f?.pivot?.y ?? 0) - (f?.trim?.y ?? 0),
        );
      }
      item.shadow.visible = !!e.shadow;
      item.halo.visible = e.glow !== undefined;
      if (e.glow !== undefined) {
        item.halo.tint = e.glow;
        item.halo.alpha = 0.12 + Math.sin(s.time * 3) * 0.025;
      }
      item.label.text = e.label ?? "";
      item.label.visible = !!e.label;
      item.label.position.set(
        this.board.x + item.x * this.board.scale.x,
        this.board.y +
          (item.y - item.sprite.pivot.y * (e.scale ?? 1) - 3) *
            this.board.scale.y,
      );
      item.label.alpha = e.alpha ?? 1;
    }
    for (const [id, e] of this.entities)
      if (!seen.has(id)) {
        e.root.destroy({ children: true });
        e.label.destroy();
        this.entities.delete(id);
      }
  }
  renderOutcome() {
    this.render(0);
  }
  private updateWeather(s: TileSceneObservation) {
    this.weather.clear();
    const exposure = Math.max(0, Math.min(1, s.weather?.exposure ?? 0));
    if (!exposure || s.weather?.sheltered) return;
    const size = this.options.tileSize ?? 16,
      w = s.width * size,
      h = s.height * size;
    this.weather
      .rect(0, 0, w, h)
      .fill({ color: 0x10283f, alpha: exposure * 0.22 });
    // A bounded native line field: motion is sampled from the owner's clock,
    // so pause/outcome renders hold rain in place without another ticker.
    const count = Math.floor(12 + exposure * 60);
    for (let i = 0; i < count; i++) {
      const x = (i * 79 + s.time * 41) % w,
        y = (i * 53 + s.time * 102) % h;
      this.weather.moveTo(x, y).lineTo(Math.max(0, x - 2), Math.min(h, y + 5));
    }
    this.weather.stroke({
      color: 0xb5deeb,
      alpha: 0.18 + exposure * 0.35,
      width: 0.65,
    });
  }
  private rebuildTerrain(s: TileSceneObservation) {
    for (const layer of [this.layers.ground, this.layers.foreground])
      for (const child of [...layer.children])
        if (child.label === "terrain") child.destroy({ children: true });
    if (s.tiles.length !== s.width * s.height)
      throw Error("Tile scene dimensions do not match terrain");
    const size = this.options.tileSize ?? 16;
    s.tiles.forEach((semantic, index) => {
      const visual = this.options.tiles?.[semantic] ?? { frame: semantic };
      if (!visual.frame) return;
      const f = this.atlas.manifest!.frames[visual.frame];
      if (!f) throw Error(`Missing tile frame ${visual.frame}`);
      const sprite = new Sprite(this.atlas.texture(visual.frame));
      sprite.label = "terrain";
      sprite.position.set(
        (index % s.width) * size + (f.trim?.x ?? 0),
        Math.floor(index / s.width) * size + (f.trim?.y ?? 0),
      );
      sprite.tint = visual.tint ?? 0xffffff;
      this.layers[visual.layer ?? "ground"].addChild(sprite);
    });
  }
  private createEntity(e: TileSceneEntity): RetainedEntity {
    const root = new Container(),
      clip = new ClipPlayer(),
      shadow = new Graphics()
        .ellipse(0, -2, 6, 2)
        .fill({ color: 0x030813, alpha: 0.5 }),
      halo = new Graphics().ellipse(0, -8, 17, 15).fill(0xffffff);
    const label = new Text({
      style: {
        fontFamily: "monospace",
        fontSize: 14,
        fontWeight: "bold",
        fill: 0xf2e1b2,
        stroke: { color: 0x111825, width: 3 },
        align: "center",
      },
    });
    label.anchor.set(0.5, 1);
    root.addChild(halo, shadow, clip.sprite);
    this.hud.addChild(label);
    const size = this.options.tileSize ?? 16;
    const retained = {
      root,
      sprite: clip.sprite,
      clip,
      shadow,
      halo,
      label,
      x: e.x * size,
      y: e.y * size,
      targetX: e.x * size,
      targetY: e.y * size,
      action: e.action,
    };
    root.on("pointertap", () => {
      if (
        this.interactive &&
        retained.action &&
        (this.options.isInteractive?.() ?? true)
      )
        this.options.onAction?.(retained.action);
    });
    return retained;
  }
  private clearEntities() {
    for (const e of this.entities.values()) {
      e.root.destroy({ children: true });
      e.label.destroy();
    }
    this.entities.clear();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.interactive = false;
    this.clearEntities();
    this.board.destroy({ children: true });
    this.border.destroy();
    this.pixelHud.dispose();
    this.hud.destroy({ children: true });
    this.atlas.dispose();
    if (this.stage)
      this.stage.canvas.style.imageRendering = this.previousImageRendering;
    this.stage = undefined;
  }
}
