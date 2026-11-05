import { Camera2D, type CameraTransform } from "../presentation/camera";
import type {
  SpriteAtlasMetadata,
  SpriteClipMetadata,
} from "@onepage/asset-library/sprite-atlas";
import {
  Application,
  Assets,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  Texture,
} from "pixi.js";
export { Container, Graphics, Sprite, Text, Texture } from "pixi.js";
export interface PixiPresenter {
  init(stage: PixiStage): void | Promise<void>;
  resize(width: number, height: number): void;
  render(dt: number): void;
  renderOutcome?(dt: number): void;
  dispose(): void;
}
export class PixiStage {
  readonly app = new Application();
  readonly world = new Container();
  readonly layers = {
    ground: new Container(),
    actors: new Container(),
    foreground: new Container(),
    effects: new Container(),
    hud: new Container(),
  };
  readonly camera = new PixiCamera();
  width = 1280;
  height = 720;
  private disposed = false;
  constructor(readonly canvas: HTMLCanvasElement) {}
  async init() {
    await this.app.init({
      canvas: this.canvas,
      preference: "webgl",
      autoStart: false,
      sharedTicker: false,
      resolution: Math.min(2, devicePixelRatio || 1),
      autoDensity: true,
      background: "#14252d",
    });
    if (this.disposed) {
      this.app.destroy(false, { children: true });
      return;
    }
    this.app.stop();
    this.layers.actors.sortableChildren = true;
    this.world.addChild(
      this.layers.ground,
      this.layers.actors,
      this.layers.foreground,
      this.layers.effects,
    );
    this.app.stage.addChild(this.world, this.layers.hud);
  }
  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    const bounds = this.canvas.parentElement!.getBoundingClientRect();
    const availableHeight = bounds.height > 1 ? bounds.height : height;
    const fit = Math.min(bounds.width / width, availableHeight / height, 2);
    const w = Math.max(1, width * fit);
    const h = Math.max(1, height * fit);
    this.app.renderer.resize(w, h);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.style.imageRendering = "auto";
    this.app.stage.scale.set(w / width);
  }
  pointer(clientX: number, clientY: number) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: ((clientX - r.left) * this.width) / r.width,
      y: ((clientY - r.top) * this.height) / r.height,
    };
  }
  render(dt: number) {
    this.camera.advance(dt);
    this.camera.apply(this.world);
    this.app.render();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.app.renderer) this.app.destroy(false, { children: true });
  }
}
/** Public origin-coordinate adapter. Manual pan stays unbounded; shake seconds
 * convert once to the shared model's milliseconds. apply never advances time.
 * Presentation observations are tolerant: nonfinite requests are ignored, finite
 * zoom/shake requests clamp to supported ranges (.1–4, 0–32, 0–1 seconds),
 * negative deltas are ignored and large deltas cap at 1e6 seconds. Invalid points
 * or bounds leave the previous transform intact. Camera2D remains strict. */
export class PixiCamera {
  private model = new Camera2D({
    width: 1,
    height: 1,
    bounds: null,
    anchor: { x: 0, y: 0 },
    roundPixels: false,
    shakeMode: "pixi-legacy",
  });
  private zoomValue = 1;
  private reduced = false;
  private displayed: CameraTransform = this.model.inspect();
  get x() {
    return this.model.positionValue.x;
  }
  set x(x: number) {
    this.pan(x, this.y);
  }
  get y() {
    return this.model.positionValue.y;
  }
  set y(y: number) {
    this.pan(this.x, y);
  }
  get zoom() {
    return this.zoomValue;
  }
  set zoom(zoom: number) {
    if (!Number.isFinite(zoom)) return;
    zoom = Math.max(0.1, Math.min(4, zoom));
    this.configure(zoom, 0);
    this.zoomValue = zoom;
  }
  set reducedMotion(value: boolean) {
    if (typeof value !== "boolean") return;
    this.reduced = value;
    this.configure(this.zoom, 0);
  }
  private configure(zoom: number, deadZone: number) {
    this.model.configure({
      width: Math.max(1, deadZone * zoom),
      height: Math.max(1, deadZone * zoom),
      bounds: null,
      zoom,
      anchor: { x: 0, y: 0 },
      deadzone: { x: deadZone * zoom, y: deadZone * zoom },
      roundPixels: false,
      reducedMotion: this.reduced,
      shakeMode: "pixi-legacy",
    });
  }
  follow(x: number, y: number, deadZone = 0) {
    if (!this.validPoint(x, y) || !Number.isFinite(deadZone)) return;
    deadZone = Math.max(0, Math.min(1e6, deadZone));
    this.configure(this.zoom, deadZone);
    // Old Pixi follow starts from the current origin, even on the first call.
    this.model.position(this.model.positionValue);
    this.model.follow({ x, y });
  }
  /** Follow an origin inside explicit origin limits. Limits are world units;
   * the model receives their equivalent world rectangle and screen deadzone. */
  followBounded(
    x: number,
    y: number,
    deadZone: number,
    limits: { x: number; y: number; width: number; height: number },
    snap = false,
  ) {
    if (
      !this.validPoint(x, y) ||
      !limits ||
      !this.validPoint(limits.x, limits.y) ||
      !Number.isFinite(deadZone) ||
      !Number.isFinite(limits.width) ||
      !Number.isFinite(limits.height) ||
      limits.width < 0 ||
      limits.height < 0 ||
      limits.width > 1e8 ||
      limits.height > 1e8
    )
      return;
    deadZone = Math.max(0, Math.min(1e6, deadZone));
    const width = Math.max(1, deadZone * this.zoom),
      height = width;
    this.model.configure({
      width,
      height,
      zoom: this.zoom,
      bounds: {
        x: limits.x,
        y: limits.y,
        width: limits.width + width / this.zoom,
        height: limits.height + height / this.zoom,
      },
      anchor: { x: 0, y: 0 },
      deadzone: { x: deadZone * this.zoom, y: deadZone * this.zoom },
      roundPixels: false,
      reducedMotion: this.reduced,
      shakeMode: "pixi-legacy",
    });
    this.model.position(this.model.positionValue);
    this.model.follow({ x, y }, snap);
  }
  private validPoint(x: number, y: number) {
    return (
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Math.abs(x) <= 1e9 &&
      Math.abs(y) <= 1e9
    );
  }
  pan(x: number, y: number) {
    if (!this.validPoint(x, y)) return;
    this.configure(this.zoom, 0);
    this.model.position({ x, y });
  }
  shake(magnitude: number, seconds: number) {
    if (!Number.isFinite(magnitude) || !Number.isFinite(seconds)) return false;
    return this.model.shake(
      Math.max(0, Math.min(32, magnitude)),
      Math.max(0, Math.min(1, seconds)) * 1000,
    );
  }
  reset() {
    this.model.reset();
  }
  advance(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.model.advance(Math.min(1e6, seconds) * 1000);
  }
  inverse(x: number, y: number) {
    const t = this.displayed;
    return {
      x: (x - t.offsetX) / t.zoom + t.x,
      y: (y - t.offsetY) / t.zoom + t.y,
    };
  }
  apply(world: Container) {
    const t = this.model.inspect();
    this.displayed = t;
    world.position.set(-t.x * t.zoom + t.offsetX, -t.y * t.zoom + t.offsetY);
    world.scale.set(t.zoom);
  }
}

export class LegacyCanvasPresenter implements PixiPresenter {
  private canvas = document.createElement("canvas");
  private hud = document.createElement("canvas");
  private texture?: Texture;
  private overlay?: Texture;
  private sprite?: Sprite;
  private hudSprite?: Sprite;
  constructor(
    private width: number,
    private height: number,
    private draw: (ctx: CanvasRenderingContext2D) => void,
    private drawHud?: (ctx: CanvasRenderingContext2D) => void,
  ) {}
  init(stage: PixiStage) {
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.texture = Texture.from(this.canvas);
    this.texture.source.scaleMode = "nearest";
    this.sprite = new Sprite(this.texture);
    stage.layers.ground.addChild(this.sprite);
    this.hudSprite = new Sprite();
    stage.layers.hud.addChild(this.hudSprite);
  }
  resize(width: number, height: number) {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const scale = Math.max(
      1,
      (this.sprite?.parent?.parent?.parent?.scale.x ?? 1) * dpr,
    );
    const pixelWidth = Math.ceil(width * scale),
      pixelHeight = Math.ceil(height * scale);
    if (
      this.overlay &&
      this.hud.width === pixelWidth &&
      this.hud.height === pixelHeight
    )
      return;
    this.hud.width = pixelWidth;
    this.hud.height = pixelHeight;
    this.overlay?.destroy(true);
    this.overlay = Texture.from(this.hud);
    if (this.hudSprite) {
      this.hudSprite.texture = this.overlay;
      this.hudSprite.width = width;
      this.hudSprite.height = height;
    }
  }
  render() {
    const c = this.canvas.getContext("2d")!;
    c.save();
    c.clearRect(0, 0, this.width, this.height);
    this.draw(c);
    c.restore();
    this.texture!.source.update();
    const h = this.hud.getContext("2d")!;
    h.setTransform(1, 0, 0, 1, 0, 0);
    h.clearRect(0, 0, this.hud.width, this.hud.height);
    h.save();
    h.scale(this.hud.width / this.width, this.hud.height / this.height);
    this.drawHud?.(h);
    h.restore();
    this.overlay!.source.update();
  }
  dispose() {
    this.sprite?.destroy();
    this.hudSprite?.destroy();
    this.texture?.destroy(true);
    this.overlay?.destroy(true);
  }
}
export interface AtlasFrame {
  pageId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  originalSize?: { width: number; height: number };
  trim?: { x: number; y: number };
  pivot?: { x: number; y: number };
  duration?: number;
  direction?: number;
  mirrorable?: boolean;
  markers?: readonly string[];
  anchors?: {
    hand?: { x: number; y: number };
    weaponTip?: { x: number; y: number };
  };
}
export interface AtlasManifest extends SpriteAtlasMetadata {
  pages: Record<string, string>;
  frames: Record<string, AtlasFrame>;
  sampling?: "nearest" | "linear";
  clips?: Record<string, string[]>;
}
/** Per-scene leases keep decoded pages alive until the last presenter releases them. */
export class AtlasLoader {
  private static pages = new Map<
    string,
    { ready: Promise<Texture>; refs: number }
  >();
  private urls: string[] = [];
  private frames = new Map<string, Texture>();
  private disposed = false;
  manifest?: AtlasManifest;
  async loadUrl(url: string): Promise<AtlasManifest> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Atlas could not load: ${url}`);
    const manifest = (await response.json()) as AtlasManifest;
    manifest.pages = Object.fromEntries(
      Object.entries(manifest.pages).map(([id, page]) => [
        id,
        new URL(page, new URL(url, document.baseURI)).href,
      ]),
    );
    await this.load(manifest);
    return manifest;
  }
  async load(manifest: AtlasManifest): Promise<void> {
    this.manifest = manifest;
    for (const [id, url] of Object.entries(manifest.pages)) {
      if (this.disposed) return;
      let page = AtlasLoader.pages.get(url);
      if (!page) {
        page = { ready: Assets.load<Texture>(url), refs: 0 };
        AtlasLoader.pages.set(url, page);
      }
      page.refs++;
      this.urls.push(url);
      const texture = await page.ready;
      if (this.disposed) return;
      texture.source.scaleMode = manifest.sampling ?? "linear";
      for (const [name, f] of Object.entries(manifest.frames))
        if (f.pageId === id)
          this.frames.set(
            name,
            new Texture({
              source: texture.source,
              frame: new Rectangle(f.x, f.y, f.width, f.height),
            }),
          );
    }
  }
  /** Adopt an externally owned atlas page, including legacy CPU-packed art.
   * Frame handles are owned here; the caller retains the page's lifetime. */
  adopt(
    page: Texture,
    frames: Readonly<
      Record<string, { x: number; y: number; width: number; height: number }>
    >,
  ) {
    if (this.disposed) return;
    for (const [name, f] of Object.entries(frames)) {
      this.frames.get(name)?.destroy();
      this.frames.set(
        name,
        new Texture({
          source: page.source,
          frame: new Rectangle(f.x, f.y, f.width, f.height),
        }),
      );
    }
  }
  clip(id: string): PhaseClip {
    return {
      frames: (this.manifest?.clips?.[id] ?? []).map((name) => ({
        texture: this.texture(name),
        ...this.manifest!.frames[name],
      })),
      metadata:
        this.manifest?.clipMetadata?.[id] ??
        this.manifest?.clipMetadata?.[id.replace(/:\d+$/, "")],
      mirrorable: false,
    };
  }
  texture(id: string) {
    return this.frames.get(id) ?? Texture.EMPTY;
  }
  dispose() {
    this.disposed = true;
    for (const t of this.frames.values()) t.destroy();
    this.frames.clear();
    for (const url of this.urls) {
      const page = AtlasLoader.pages.get(url);
      if (!page) continue;
      page.refs--;
      if (page.refs === 0)
        void page.ready.then(
          () => {
            if (page.refs === 0 && AtlasLoader.pages.get(url) === page) {
              AtlasLoader.pages.delete(url);
              void Assets.unload(url);
            }
          },
          () => {
            if (AtlasLoader.pages.get(url) === page)
              AtlasLoader.pages.delete(url);
          },
        );
    }
    this.urls = [];
  }
}
export interface PhaseClip {
  metadata?: SpriteClipMetadata;
  frames: readonly {
    texture: Texture;
    duration?: number;
    pivot?: { x: number; y: number };
    trim?: { x: number; y: number };
    markers?: readonly string[];
    anchors?: {
      hand?: { x: number; y: number };
      weaponTip?: { x: number; y: number };
    };
  }[];
  mirrorable?: boolean;
}
export class ClipPlayer {
  readonly sprite = new Sprite();
  sampledAnchors?: {
    hand?: { x: number; y: number };
    weaponTip?: { x: number; y: number };
  };
  sampledPivot = { x: 0, y: 0 };
  private instance = "";
  private phase = -1;
  sample(
    clip: PhaseClip,
    phase: number,
    instance: string,
    mirror = false,
  ): string[] {
    const p = Math.max(0, Math.min(0.999999, phase));
    const total = clip.frames.reduce((n, f) => n + (f.duration ?? 1), 0);
    let end = 0;
    let selected = clip.frames[0];
    const markers: string[] = [];
    const start = instance === this.instance ? this.phase : -1;
    for (const f of clip.frames) {
      const before = end / total;
      end += f.duration ?? 1;
      if (before > start && before <= p) markers.push(...(f.markers ?? []));
      if (p >= before) selected = f;
    }
    if (selected) {
      this.sampledAnchors = selected.anchors;
      this.sampledPivot = selected.pivot ?? { x: 0, y: 0 };
      this.sprite.texture = selected.texture;
      this.sprite.pivot.set(
        (selected.pivot?.x ?? 0) - (selected.trim?.x ?? 0),
        (selected.pivot?.y ?? 0) - (selected.trim?.y ?? 0),
      );
      this.sprite.scale.x =
        Math.abs(this.sprite.scale.x) *
        (mirror && clip.mirrorable !== false ? -1 : 1);
    }
    this.instance = instance;
    this.phase = p;
    return markers;
  }
}
export class SpringTransform {
  x = 0;
  y = 0;
  rotation = 0;
  scale = 1;
  target = { x: 0, y: 0, rotation: 0, scale: 1 };
  private velocity = { x: 0, y: 0, rotation: 0, scale: 0 };
  private pulse = 0;
  snapshot() {
    return {
      x: this.x,
      y: this.y,
      rotation: this.rotation,
      scale: this.scale,
      target: { ...this.target },
      velocity: { ...this.velocity },
      pulse: this.pulse,
    };
  }
  restore(state: ReturnType<SpringTransform["snapshot"]>) {
    this.x = state.x;
    this.y = state.y;
    this.rotation = state.rotation;
    this.scale = state.scale;
    this.target = { ...state.target };
    this.velocity = { ...state.velocity };
    this.pulse = state.pulse;
  }
  juice(amount = 0.18) {
    this.pulse = amount;
  }
  update(dt: number, target?: Container) {
    dt = Math.min(0.05, Math.max(0, dt));
    for (const k of ["x", "y", "rotation", "scale"] as const) {
      this.velocity[k] += (this.target[k] - this[k]) * 180 * dt;
      this.velocity[k] *= Math.exp(-18 * dt);
      this[k] += this.velocity[k] * dt;
    }
    this.pulse *= Math.exp(-10 * dt);
    if (target) {
      target.position.set(this.x, this.y);
      target.rotation = this.rotation;
      target.scale.set(this.scale + this.pulse, this.scale - this.pulse * 0.5);
    }
  }
}
export {
  PresentationQueue,
  type PresentationEvent,
  type PresentationQueueSnapshot,
} from "../presentation/event-queue";
export class ParticlePool {
  readonly container = new Container();
  private particles: {
    sprite: Sprite;
    life: number;
    vx: number;
    vy: number;
  }[] = [];
  constructor(readonly capacity = 128) {}
  emit(
    texture: Texture,
    x: number,
    y: number,
    vx: number,
    vy: number,
    life: number,
  ) {
    let p = this.particles.find((p) => p.life <= 0);
    if (!p) {
      if (this.particles.length >= this.capacity) return;
      p = { sprite: new Sprite(), life: 0, vx: 0, vy: 0 };
      this.particles.push(p);
      this.container.addChild(p.sprite);
    }
    Object.assign(p, { life, vx, vy });
    p.sprite.texture = texture;
    p.sprite.position.set(x, y);
    p.sprite.visible = true;
    p.sprite.alpha = 1;
  }
  update(dt: number) {
    for (const p of this.particles)
      if (p.life > 0) {
        p.life -= dt;
        p.sprite.x += p.vx * dt;
        p.sprite.y += p.vy * dt;
        p.sprite.visible = p.life > 0;
        p.sprite.alpha = Math.min(1, p.life * 3);
      }
  }
  /** Discard transient samples after restore/branch changes; retain renderer allocation.
   * Particle life and update deltas are seconds, including Winter's 26-second snow. */
  reset(): void {
    for (const p of this.particles) {
      p.life = 0;
      p.sprite.visible = false;
    }
  }
  dispose() {
    this.container.destroy({ children: true });
    this.particles = [];
  }
}
export class PanelController {
  readonly element = document.createElement("section");
  constructor(host: HTMLElement, label: string) {
    // Keep readable controls outside the aspect-constrained graphics viewport.
    if (host.parentElement?.querySelector(":scope > canvas"))
      host.parentElement.after(host);
    this.element.setAttribute("aria-label", label);
    this.element.className = "game-panel-content";
    host.append(this.element);
  }
  render(
    lines: readonly string[],
    choices: readonly { id: string; label: string; disabled?: boolean }[],
    choose: (id: string) => void,
  ) {
    const focused = (document.activeElement as HTMLElement)?.dataset.choice;
    this.element.replaceChildren(
      ...lines.map((line) => {
        const p = document.createElement("p");
        p.textContent = line;
        return p;
      }),
      ...choices.map((c) => {
        const b = document.createElement("button");
        b.textContent = c.label;
        b.disabled = !!c.disabled;
        b.dataset.choice = c.id;
        b.onclick = () => choose(c.id);
        return b;
      }),
    );
    if (focused)
      this.element
        .querySelector<HTMLButtonElement>(
          `button[data-choice="${CSS.escape(focused)}"]`,
        )
        ?.focus();
  }
  dispose() {
    this.element.remove();
  }
}
export interface TileEntity {
  id: string;
  texture: Texture;
  x: number;
  y: number;
  width?: number;
  height?: number;
  depth?: number;
  alpha?: number;
  rotation?: number;
  label?: string;
}
/** Retained entity reconciler shared by native tile maps and moving actor scenes. */
export class TileEntityPresenter implements PixiPresenter {
  private stage?: PixiStage;
  private sprites = new Map<string, Sprite>();
  private labels = new Map<string, Text>();
  constructor(
    private read: () => readonly TileEntity[],
    private offset: () => { x: number; y: number } = () => ({ x: 0, y: 0 }),
  ) {}
  init(stage: PixiStage) {
    this.stage = stage;
  }
  resize() {}
  render() {
    const seen = new Set<string>();
    for (const e of this.read()) {
      seen.add(e.id);
      let s = this.sprites.get(e.id);
      if (!s) {
        s = new Sprite();
        this.sprites.set(e.id, s);
        this.stage!.layers.actors.addChild(s);
      }
      s.texture = e.texture;
      s.position.set(e.x, e.y);
      if (e.width !== undefined) s.width = e.width;
      if (e.height !== undefined) s.height = e.height;
      s.zIndex = e.depth ?? e.y;
      s.alpha = e.alpha ?? 1;
      s.rotation = e.rotation ?? 0;
      if (e.label) {
        let t = this.labels.get(e.id);
        if (!t) {
          t = new Text({
            text: e.label,
            style: { fontFamily: "monospace", fontSize: 10, fill: "#ffe0a0" },
          });
          this.labels.set(e.id, t);
          this.stage!.layers.actors.addChild(t);
        }
        t.text = e.label;
        t.position.set(e.x, e.y - 12);
        t.zIndex = s.zIndex + 0.1;
      } else {
        this.labels.get(e.id)?.destroy();
        this.labels.delete(e.id);
      }
    }
    for (const [id, s] of this.sprites)
      if (!seen.has(id)) {
        s.destroy();
        this.sprites.delete(id);
        this.labels.get(id)?.destroy();
        this.labels.delete(id);
      }
    const p = this.offset();
    this.stage!.camera.pan(p.x, p.y);
  }
  dispose() {
    for (const s of this.sprites.values()) s.destroy();
    for (const t of this.labels.values()) t.destroy();
    this.sprites.clear();
    this.labels.clear();
  }
}
