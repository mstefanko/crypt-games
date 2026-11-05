import {
  Application,
  BitmapText,
  Container,
  Graphics,
  Sprite,
  Texture,
  Rectangle,
} from "pixi.js";
import type { GameDefinitions } from "../../game-project/src/types.ts";
import { observe } from "../../game-simulation/src/index.ts";
import { makeM2Font } from "./m2-font.ts";
import { interpolatePosition } from "./interpolation.ts";
import { Camera2D, type CameraPoint } from "./presentation/camera.ts";
import {
  orderPresentation,
  PRESENTATION_LAYERS,
} from "./presentation/sprites.ts";
import { CosmeticEffects } from "./presentation/effects.ts";
import {
  sampleSkin,
  skinPlacement,
  showsGuard,
  actorSkinAction,
  GUARD_CUE_COLOR,
  type PreparedSkin,
} from "./m2-assets.ts";
type LoadableSkin = PreparedSkin & { atlasUrl: string };
import {
  applyViewportStyle,
  clientToLogical,
  type CssBounds,
  type ViewportMapping,
} from "./presentation/viewport.ts";
type Observation = ReturnType<typeof observe>;

export class M2View {
  readonly app = new Application();
  private art: ReturnType<typeof makeM2Font> | undefined;
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
  private guardSlots = new Set<number>();
  private camera?: Camera2D;
  private cameraFrame?: {
    epoch: number;
    actorId?: number;
    motionEpoch?: number;
    tick: number;
  };
  private cameraSettings = { zoom: 1, deadzone: { x: 0, y: 0 } };
  private cosmetic = new CosmeticEffects(0);
  private motionOverride?: boolean;

  /** Presentation controls only; the HUD remains attached to the untransformed stage. */
  setPresentationOptions(options: {
    zoom?: number;
    deadzone?: CameraPoint;
    reducedMotion?: boolean;
  }): void {
    const next = {
      zoom: options.zoom ?? this.cameraSettings.zoom,
      deadzone: { ...(options.deadzone ?? this.cameraSettings.deadzone) },
    };
    // Validate before replacing retained settings, including calls before initialization.
    new Camera2D({
      ...this.definitions.manifest.viewport,
      bounds: { x: 0, y: 0, ...this.definitions.manifest.viewport },
      ...next,
      reducedMotion: options.reducedMotion ?? this.motionOverride ?? false,
    });
    this.cameraSettings = next;
    if (options.reducedMotion !== undefined)
      this.motionOverride = options.reducedMotion;
  }
  cameraTransform() {
    return (
      this.camera?.inspect() ?? { x: 0, y: 0, zoom: 1, offsetX: 0, offsetY: 0 }
    );
  }
  worldPoint(point: CameraPoint): CameraPoint {
    return this.camera?.toWorld(point) ?? { ...point };
  }
  /** Board scenes use logical coordinates without a retained actor camera. */
  resetWorldPresentation(): void {
    this.camera = undefined;
    this.cameraFrame = undefined;
    this.world.scale.set(1);
    this.world.position.set(0, 0);
    this.terrain.visible = this.actors.visible = false;
    this.effects.clear();
    this.cosmetic.reset();
    if (this.hud) this.hud.visible = false;
  }
  addWorldBackground(graphics: Graphics): void {
    this.world.addChildAt(graphics, 0);
  }
  presentationStats() {
    return {
      camera: this.cameraTransform(),
      cosmetic: this.cosmetic.inspect(),
    };
  }

  readonly metrics = {
    decodeMs: 0,
    fetchMs: 0,
    preparationMs: 0,
    rendererSetupMs: 0,
    textureSetupMs: 0,
    activeTextures: 0,
    closedBitmaps: 0,
    disposals: 0,
    renderSubmitMs: 0,
    guardingActors: 0,
    skinId: "",
    skinLoading: false,
    skinLoadsCancelled: 0,
  };
  private skinTextures = new Map<string, Texture>();
  private atlas: Texture | undefined;
  private bitmap: ImageBitmap | undefined;
  private loadEpoch = 0;
  private skinLoad?: AbortController;
  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }
  constructor(
    private definitions: GameDefinitions,
    private skin: LoadableSkin,
  ) {
    this.metrics.skinId = skin.id;
    this.app.stage.addChild(this.world);
    this.world.addChild(this.terrain, this.actors, this.effects);
  }

  /** Presentation input copied after a successful simulation tick; clear on cancel/pause. */
  setGuardSlots(slots: readonly number[]): void {
    this.guardSlots = new Set(slots);
    if (!slots.length) this.metrics.guardingActors = 0;
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
    const rendererStarted = performance.now();
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
    this.metrics.rendererSetupMs = performance.now() - rendererStarted;
    this.initialized = true;
    this.app.stop();
    if (this.destroyed) {
      this.app.destroy(
        { removeView: true, releaseGlobalResources: false },
        { children: true },
      );
      return;
    }
    this.art = makeM2Font();
    await this.setSkin(this.skin);
    if (this.destroyed) return;
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
    this.terrain.visible = this.actors.visible = true;
    if (this.hud) this.hud.visible = true;
    const level = this.definitions.levels.find(
      (candidate) => candidate.id === current.levelId,
    )!;
    const { width, height } = this.definitions.manifest.viewport;
    if (this.levelId !== level.id) {
      this.levelId = level.id;
      this.camera?.reset();
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
    const reducedMotion =
      this.motionOverride ??
      (typeof matchMedia === "function" &&
        matchMedia("(prefers-reduced-motion: reduce)").matches);
    const cameraOptions = {
      width,
      height,
      bounds: { x: 0, y: 0, width: level.width, height: level.height },
      anchor: { x: 0.38, y: 0.55 },
      ...this.cameraSettings,
      reducedMotion,
    };
    if (!this.camera) this.camera = new Camera2D(cameraOptions);
    else this.camera.configure(cameraOptions);
    // Hosts often pass the same epoch for both observation samples after restore.
    // Compare against the last rendered frame as well as interpolation samples.
    const frame = {
      epoch,
      actorId: followed?.id,
      motionEpoch: followed?.motionEpoch,
      tick: current.tick,
    };
    const snap =
      previousEpoch !== epoch ||
      !this.cameraFrame ||
      this.cameraFrame.epoch !== epoch ||
      this.cameraFrame.actorId !== frame.actorId ||
      this.cameraFrame.motionEpoch !== frame.motionEpoch ||
      current.tick < this.cameraFrame.tick ||
      current.tick > this.cameraFrame.tick + 1;
    const camera = this.camera.follow(
      { x: followedPose.x / 256, y: followedPose.y / 256 },
      snap,
    );
    this.cameraFrame = frame;
    const cameraX = camera.x,
      cameraY = camera.y;
    this.world.scale.set(camera.zoom);
    this.world.position.set(
      -cameraX * camera.zoom + camera.offsetX,
      -cameraY * camera.zoom + camera.offsetY,
    );
    // This continuous pose effect is resampled, never accumulated across redraws.
    this.cosmetic.reset(current.tick >>> 0);
    this.cosmetic.setReducedMotion(reducedMotion);
    this.effects.clear();
    this.metrics.guardingActors = 0;
    const visible = new Set<number>();
    for (
      let y = Math.max(0, Math.floor(cameraY / level.tileSize) - 1);
      y <=
      Math.min(
        level.height / level.tileSize - 1,
        Math.ceil((cameraY + height / camera.zoom) / level.tileSize) + 1,
      );
      y += 1
    ) {
      for (
        let x = Math.max(0, Math.floor(cameraX / level.tileSize) - 1);
        x <=
        Math.min(
          level.width / level.tileSize - 1,
          Math.ceil((cameraX + width / camera.zoom) / level.tileSize) + 1,
        );
        x += 1
      ) {
        const index = y * (level.width / level.tileSize) + x;
        const tile = level.tiles[index];
        if (!tile) continue;
        visible.add(index);
        let sprite = this.tileSprites.get(index);
        if (!sprite) {
          sprite = new Sprite(this.environmentTexture(tile === 2 ? 1 : 0));
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
        sprite = new Sprite(this.environmentTexture(frame));
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
    for (const { actor } of orderPresentation(
      current.actors.map((actor) => ({
        actor,
        id: String(actor.id),
        layer: PRESENTATION_LAYERS.actors,
        depth: actor.id,
      })),
    )) {
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
      const guard = showsGuard(
        actor,
        actor.slot !== null && this.guardSlots.has(actor.slot),
      );
      const action = actorSkinAction(actor, pose.x !== before?.x, guard);
      const sample = sampleSkin(
        this.skin,
        actor.slot === null ? "sentinel" : "hero",
        action,
        actor.abilityId ? actor.abilityTick : current.tick,
        actor.facing,
      );
      const placement = skinPlacement(
        sample,
        (pose.x + actor.width / 2) / 256,
        (pose.y + actor.height) / 256,
      );
      const sprite = rectSprite(
        `actor:${actor.id}`,
        2,
        placement.x,
        placement.y,
        sample.frame.visual.width,
        sample.frame.visual.height,
      );
      sprite.texture = this.skinTextures.get(sample.frame.id)!;
      sprite.anchor.set(0, 0);
      sprite.width = sample.frame.visual.width;
      sprite.height = sample.frame.visual.height;
      sprite.scale.x = Math.abs(sprite.scale.x) * placement.scaleX;
      sprite.position.set(Math.round(placement.x), Math.round(placement.y));
      // The hand socket is presentation only; the simulation still supplies hit shapes.
      if (actor.hit) {
        if (reducedMotion)
          this.effects
            .circle(placement.hand.x, placement.hand.y, 2)
            .fill(0xfff0ba);
        else
          this.cosmetic.emit({
            id: `hit:${actor.id}`,
            priority: 1,
            x: placement.hand.x,
            y: placement.hand.y,
            burst: 1,
            ratePerSecond: 0,
            durationMs: 0,
            lifetimeMs: 200,
            speed: 0,
            radius: 2,
            color: 0xfff0ba,
          });
      }
      sprite.tint =
        actor.freezeTicks > 0
          ? 0xffffff
          : actor.slot === 1
            ? 0xb8b3ff
            : 0xffffff;
      sprite.alpha = actor.health > 0 ? 1 : 0.35;
      if (guard) {
        this.metrics.guardingActors++;
        const x = Math.round(placement.hand.x + actor.facing),
          y = Math.round((pose.y + actor.height) / 256 - 12);
        this.effects
          .poly([
            x - 2,
            y - 5,
            x + 2,
            y - 5,
            x + 2,
            y + 2,
            x,
            y + 5,
            x - 2,
            y + 2,
          ])
          .fill(GUARD_CUE_COLOR)
          .stroke({ color: 0xeaffff, width: 1 });
      }
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
    // Total layer/key order remains stable after removal, recreation and skin loads.
    const ordered = orderPresentation(
      [...this.sprites].map(([id, sprite]) => ({
        id,
        sprite,
        layer: id.startsWith("actor:")
          ? PRESENTATION_LAYERS.actors
          : PRESENTATION_LAYERS.props,
        depth: id.startsWith("actor:")
          ? Number(id.slice(6))
          : id.startsWith("rect:")
            ? 0
            : id === "goal"
              ? 1
              : 2,
      })),
    );
    ordered.forEach(({ sprite }, index) =>
      this.actors.setChildIndex(sprite, index),
    );
    if (this.cosmetic.inspect().particles.length)
      this.cosmetic.tween({
        id: "hit-glint",
        priority: 1,
        from: 0.8,
        to: 1,
        durationMs: 100,
      });
    // A pose-derived phase, not a new clock: same observation produces same pixels.
    this.cosmetic.advance(((current.tick % 7) * 100) / 6);
    const cosmetic = this.cosmetic.inspect();
    const glint =
      cosmetic.tweens.find((tween) => tween.id === "hit-glint")?.value ?? 1;
    for (const particle of cosmetic.particles)
      this.effects
        .circle(particle.x, particle.y, particle.radius)
        .fill({ color: particle.color, alpha: particle.alpha * glint });
    const player = current.actors.find((actor) => actor.slot === 0);
    this.hud!.text = `HP ${player?.health ?? 0}/${player?.maxHealth ?? 0}  ${level.id.toUpperCase().replace(/[^A-Z0-9 -]/g, " ")}  T ${current.tick}`;
    if (current.status !== "playing")
      this.hud!.text += `  ${current.status.toUpperCase()}`;
    const started = performance.now();
    this.app.render();
    this.metrics.renderSubmitMs = performance.now() - started;
  }

  private environmentTexture(frame: number): Texture {
    const action =
      (
        { 0: "terrain", 1: "oneway", 4: "goal", 5: "platform" } as Record<
          number,
          string
        >
      )[frame] ?? "terrain";
    return this.skinTextures.get(
      sampleSkin(this.skin, "environment", action, 0, 1).frame.id,
    )!;
  }
  get skinId(): string {
    return this.skin.id;
  }
  /** Cancellation resolves false; an active load failure rejects without changing the current skin. */
  async setSkin(next: LoadableSkin): Promise<boolean> {
    if (this.destroyed) return false;
    this.cancelSkinLoad();
    const controller = new AbortController(),
      signal = controller.signal;
    this.skinLoad = controller;
    const epoch = ++this.loadEpoch;
    const current = () =>
      !this.destroyed && !signal.aborted && epoch === this.loadEpoch;
    this.metrics.skinLoading = true;
    let bitmap: ImageBitmap | undefined, atlas: Texture | undefined;
    const textures = new Map<string, Texture>();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
      finishedReading = false,
      installed = false;
    const cancelReader = () => {
      if (reader && !finishedReading) void reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", cancelReader, { once: true });
    try {
      const a = next.atlas;
      if (
        !Number.isSafeInteger(a.bytes) ||
        a.bytes < 1 ||
        a.bytes > 1024 * 1024 ||
        !Number.isSafeInteger(a.width) ||
        !Number.isSafeInteger(a.height) ||
        a.width < 1 ||
        a.height < 1 ||
        a.width * a.height > 512 * 512
      )
        throw new Error("Skin atlas exceeds player budget");
      const frames = Object.values(next.frames);
      if (frames.length > 128)
        throw new Error("Skin frame count exceeds player budget");
      for (const frame of frames) {
        const v = frame.visual,
          t = frame.trim;
        if (
          v.kind !== "raster" ||
          ![v.x, v.y, v.width, v.height, t.x, t.y, t.width, t.height].every(
            Number.isSafeInteger,
          ) ||
          v.x < 0 ||
          v.y < 0 ||
          v.width < 1 ||
          v.height < 1 ||
          v.x + v.width > a.width ||
          v.y + v.height > a.height ||
          t.x < 0 ||
          t.y < 0 ||
          t.width < 1 ||
          t.height < 1 ||
          t.x + v.width > t.width ||
          t.y + v.height > t.height
        )
          throw new Error("Prepared skin frame clips outside atlas");
        if (
          frame.id.startsWith(next.roles.environment + "-") &&
          (v.x - t.x < 0 ||
            v.y - t.y < 0 ||
            v.x - t.x + t.width > a.width ||
            v.y - t.y + t.height > a.height)
        )
          throw new Error("Prepared environment frame clips outside atlas");
      }
      const fetchStarted = performance.now();
      const response = await fetch(next.atlasUrl, { signal });
      if (!current()) {
        void response.body?.cancel().catch(() => {});
        return false;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`Skin atlas unavailable: ${response.status}`);
      }
      reader = response.body?.getReader();
      if (!reader) throw new Error("Skin atlas stream unavailable");
      const bytes = new Uint8Array(a.bytes);
      let offset = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (!current()) return false;
        if (done) {
          finishedReading = true;
          break;
        }
        if (offset + value.byteLength > bytes.length)
          throw new Error("Skin atlas exceeds pinned byte count");
        bytes.set(value, offset);
        offset += value.byteLength;
      }
      if (offset !== bytes.length)
        throw new Error("Skin atlas byte count differs from content lock");
      if (!current()) return false;
      const fetchedAt = performance.now();
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
      if (!current()) return false;
      if (digest !== a.sha256)
        throw new Error("Skin atlas hash differs from content lock");
      const decodeStarted = performance.now();
      this.metrics.fetchMs = fetchedAt - fetchStarted;
      this.metrics.preparationMs = decodeStarted - fetchedAt;
      bitmap = await this.decodeSkin(
        new Blob([bytes], { type: "image/png" }),
        signal,
      );
      if (!current()) return false;
      if (bitmap.width !== a.width || bitmap.height !== a.height)
        throw new Error("Skin atlas decoded dimensions differ from pin");
      const decodeMs = performance.now() - decodeStarted,
        setupStarted = performance.now();
      atlas = Texture.from(bitmap);
      atlas.source.scaleMode = "nearest";
      for (const frame of frames) {
        if (frame.visual.kind !== "raster")
          throw new Error("Prepared skin requires atlas frames");
        const v = frame.visual,
          environment = frame.id.startsWith(next.roles.environment + "-");
        textures.set(
          frame.id,
          new Texture({
            source: atlas.source,
            frame: environment
              ? new Rectangle(
                  v.x - frame.trim.x,
                  v.y - frame.trim.y,
                  frame.trim.width,
                  frame.trim.height,
                )
              : new Rectangle(v.x, v.y, v.width, v.height),
          }),
        );
      }
      if (!current()) return false;
      // New decode/textures are complete before the displayed resources are touched.
      for (const sprite of this.sprites.values()) sprite.destroy();
      this.sprites.clear();
      for (const sprite of this.tileSprites.values()) sprite.destroy();
      this.tileSprites.clear();
      this.levelId = "";
      this.releaseSkin();
      this.skin = next;
      this.bitmap = bitmap;
      this.atlas = atlas;
      this.skinTextures = textures;
      installed = true;
      this.metrics.skinId = next.id;
      this.metrics.activeTextures = textures.size;
      this.metrics.decodeMs = decodeMs;
      this.metrics.textureSetupMs = performance.now() - setupStarted;
      return true;
    } catch (error) {
      if (!current()) return false;
      throw error;
    } finally {
      signal.removeEventListener("abort", cancelReader);
      cancelReader();
      if (!installed) {
        for (const texture of textures.values()) texture.destroy();
        atlas?.destroy(true);
        if (bitmap) {
          bitmap.close();
          this.metrics.closedBitmaps++;
        }
      }
      if (this.skinLoad === controller) {
        this.skinLoad = undefined;
        this.metrics.skinLoading = false;
      }
    }
  }
  /** Bitmap decode has no abort API; return promptly and close any late result. */
  private decodeSkin(blob: Blob, signal: AbortSignal): Promise<ImageBitmap> {
    return new Promise((resolve, reject) => {
      const aborted = () =>
        reject(new DOMException("Skin load cancelled", "AbortError"));
      signal.addEventListener("abort", aborted, { once: true });
      createImageBitmap(blob).then(
        (bitmap) => {
          signal.removeEventListener("abort", aborted);
          if (signal.aborted) {
            bitmap.close();
            this.metrics.closedBitmaps++;
            return;
          }
          resolve(bitmap);
        },
        (error) => {
          signal.removeEventListener("abort", aborted);
          reject(error);
        },
      );
      if (signal.aborted) aborted();
    });
  }
  private cancelSkinLoad(): void {
    if (this.skinLoad && !this.skinLoad.signal.aborted) {
      this.metrics.skinLoadsCancelled++;
      this.skinLoad.abort();
    }
    this.skinLoad = undefined;
    this.metrics.skinLoading = false;
  }
  private releaseSkin(): void {
    for (const texture of this.skinTextures.values()) texture.destroy();
    this.skinTextures.clear();
    this.atlas?.destroy(true);
    this.atlas = undefined;
    if (this.bitmap) {
      this.bitmap.close();
      this.bitmap = undefined;
      this.metrics.closedBitmaps++;
    }
    this.metrics.activeTextures = 0;
  }
  // Renderer destruction must not clear Pixi global pools: another adopted or
  // initializing view can still own batches from those shared pools.
  dispose(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loadEpoch++;
    this.cancelSkinLoad();
    this.guardSlots.clear();
    this.cosmetic.dispose();
    this.camera?.reset();
    this.metrics.guardingActors = 0;
    this.releaseSkin();
    this.metrics.disposals++;
    if (!this.initialized) return; // init owns late-promise cleanup.
    this.app.destroy(
      { removeView: true, releaseGlobalResources: false },
      { children: true },
    );
    this.art?.dispose();
    this.art = undefined;
  }
}
