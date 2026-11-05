import {
  editedClipPhase,
  spriteDirectionCount,
} from "@onepage/asset-library/sprite-atlas";
import {
  projectWithRecipe,
  unprojectWithRecipe,
} from "../presentation/isometric";
import {
  projectIsometric,
  unprojectIsometric,
} from "../presentation/isometric";
import { Assets, Sprite, ColorMatrixFilter, type Texture } from "pixi.js";
import {
  Container,
  Graphics,
  Text,
  AtlasLoader,
  ClipPlayer,
  ParticlePool,
  SpringTransform,
  PresentationQueue,
  Texture as PixiTexture,
  type PixiPresenter,
  type PixiStage,
} from "./index";
import { actionPhase } from "@onepage/game-simulation/action-timeline";
import type {
  ArenaSession,
  ArenaActor,
} from "@onepage/game-simulation/arena-session";
/** Arena scene renderer. Single primary consumer; accepts generic arena definitions. */
export class ArenaPresenter implements PixiPresenter {
  private atlas = new AtlasLoader();
  private legacy = false;
  private effectAtlas = new AtlasLoader();
  private effectReady = false;
  private contactEffects = new Map<
    number,
    { player: ClipPlayer; elapsed: number; key: string; x: number; y: number }
  >();
  private observedEffects = new Set<string>();
  private persistentEffects = new Map<
    string,
    { player: ClipPlayer; key: string }
  >();
  private effectSerial = -1000000;
  private lastDash = false;
  private dashTrailElapsed = 0;
  private previousProjectiles = new Map<
    number,
    { x: number; y: number; cast: boolean }
  >();
  private previousEchoes = new Map<number, { x: number; y: number }>();
  private previousSpecial?: { id: number; x: number; y: number };
  private observedRoom = -1;
  private spawnEffect(
    key: string,
    x: number,
    y: number,
    cue?: string,
    rotation = 0,
    scale = 0.6,
  ) {
    if (
      !this.effectReady ||
      this.legacy ||
      !this.stage ||
      (cue && this.observedEffects.has(cue))
    )
      return;
    const clip = this.effectAtlas.clip(key);
    if (!clip.frames.length) return;
    if (cue) this.observedEffects.add(cue);
    const player = new ClipPlayer();
    player.sprite.scale.set(scale);
    player.sprite.rotation = rotation;
    const recipe = this.effectAtlas.manifest?.effects?.[key];
    player.sprite.blendMode = recipe?.blend === "add" ? "add" : "normal";
    (recipe?.depth === "floor" || recipe?.depth === "ground"
      ? this.stage.layers.ground
      : this.stage.layers.effects
    ).addChild(player.sprite);
    this.contactEffects.set(this.effectSerial--, {
      player,
      elapsed: 0,
      key,
      x,
      y,
    });
  }
  private sampleEffect(
    id: string,
    key: string,
    x: number,
    y: number,
    phase: number,
    active: Set<string>,
    rotation = 0,
    scale = 0.6,
  ) {
    if (!this.effectReady || this.legacy || !this.stage) return;
    const clip = this.effectAtlas.clip(key);
    if (!clip.frames.length) return;
    active.add(id);
    let effect = this.persistentEffects.get(id);
    if (!effect) {
      const player = new ClipPlayer();
      const recipe = this.effectAtlas.manifest?.effects?.[key];
      player.sprite.blendMode = recipe?.blend === "add" ? "add" : "normal";
      (recipe?.depth === "floor" || recipe?.depth === "ground"
        ? this.stage.layers.ground
        : this.stage.layers.effects
      ).addChild(player.sprite);
      effect = { player, key };
      this.persistentEffects.set(id, effect);
    }
    effect.player.sample(clip, phase, id);
    effect.player.sprite.position.set(x, y);
    effect.player.sprite.rotation = rotation;
    effect.player.sprite.scale.set(scale);
  }
  /** Cues observe simulation transitions; they never claim contacts or apply damage. */
  private updateSimulationEffects(dt: number) {
    const s = this.session.state,
      room = this.session.room;
    if (this.observedRoom !== s.room) {
      this.observedRoom = s.room;
      this.observedEffects.clear();
      this.previousProjectiles.clear();
      this.previousEchoes.clear();
      this.previousSpecial = undefined;
      this.lastDash = false;
    }
    const active = new Set<string>(),
      hero = this.project(s.player.x, s.player.y);
    const dashing = s.dashTime > 0;
    const facing = this.project(
      s.player.x + Math.cos(s.player.facing),
      s.player.y + Math.sin(s.player.facing),
    );
    const dashAngle = Math.atan2(facing.y - hero.y, facing.x - hero.x);
    if (dashing && !this.lastDash) {
      this.spawnEffect("dash-launch", hero.x, hero.y, undefined, dashAngle);
      this.dashTrailElapsed = 0.06;
    }
    if (dashing) {
      this.dashTrailElapsed += dt;
      if (this.dashTrailElapsed >= 0.06) {
        this.spawnEffect("dash-trail", hero.x, hero.y, undefined, dashAngle);
        this.dashTrailElapsed %= 0.06;
      }
    } else if (this.lastDash) this.spawnEffect("dash-arrival", hero.x, hero.y);
    this.lastDash = dashing;
    for (const actor of s.enemies) {
      const p = this.project(actor.x, actor.y);
      if (!actor.training)
        this.spawnEffect("enemy-spawn", p.x, p.y - 15, `spawn:${actor.id}`);
      if (actor.hp <= 0)
        this.spawnEffect("enemy-death", p.x, p.y - 20, `death:${actor.id}`);
      if (actor.shieldBroken)
        this.spawnEffect(
          "armor-break",
          p.x,
          p.y - 20,
          `shield-break:${actor.id}`,
        );
    }
    s.breakables.forEach((pot, i) => {
      if (!pot.alive) {
        const p = this.project(pot.x, pot.y);
        this.spawnEffect("urn-break", p.x, p.y - 10, `pot:${i}`);
      }
    });
    for (const boon of s.boons)
      this.spawnEffect("reward-pickup", hero.x, hero.y - 20, `reward:${boon}`);
    for (const trail of s.trails ?? []) {
      const p = this.project(trail.x, trail.y);
      this.sampleEffect(
        `ember:${trail.id}`,
        "ember-wake",
        p.x,
        p.y,
        (s.time / 0.5) % 1,
        active,
      );
    }
    const echoes = new Map<number, { x: number; y: number }>();
    for (const echo of s.echoes ?? [])
      echoes.set(echo.id, { x: echo.x, y: echo.y });
    for (const [id, echo] of this.previousEchoes)
      if (!echoes.has(id)) {
        const p = this.project(echo.x, echo.y);
        this.spawnEffect("echo-cast", p.x, p.y, `echo:${id}`);
      }
    this.previousEchoes = echoes;
    const projectiles = new Map<
      number,
      { x: number; y: number; cast: boolean }
    >();
    for (const projectile of s.projectiles) {
      projectiles.set(projectile.id, {
        x: projectile.x,
        y: projectile.y,
        cast: projectile.cast ?? false,
      });
      const p = this.project(projectile.x, projectile.y);
      const q = this.project(
        projectile.x + projectile.vx,
        projectile.y + projectile.vy,
      );
      this.sampleEffect(
        `projectile:${projectile.id}`,
        "cast-projectile",
        p.x,
        p.y - 16,
        (s.time / 0.3) % 1,
        active,
        Math.atan2(q.y - p.y, q.x - p.x),
        0.4,
      );
    }
    for (const [id, projectile] of this.previousProjectiles)
      if (!projectiles.has(id)) {
        const p = this.project(projectile.x, projectile.y);
        this.spawnEffect(
          "cast-contact",
          p.x,
          p.y - 16,
          `projectile-contact:${id}`,
        );
      }
    this.previousProjectiles = projectiles;
    const action = s.player.action;
    if (action?.moveId === "special") {
      const phase = actionPhase(action);
      if (phase.phase === "tell")
        this.sampleEffect(
          `special-tell:${action.id}`,
          "special-anticipation",
          hero.x,
          hero.y,
          phase.progress,
          active,
        );
      if (phase.phase === "active")
        this.previousSpecial = { id: action.id, x: s.player.x, y: s.player.y };
    }
    if (
      this.previousSpecial &&
      (!action ||
        action.id !== this.previousSpecial.id ||
        actionPhase(action).phase === "recover")
    ) {
      const p = this.project(this.previousSpecial.x, this.previousSpecial.y);
      this.spawnEffect(
        "special-residue",
        p.x,
        p.y,
        `special-residue:${this.previousSpecial.id}`,
      );
      this.previousSpecial = undefined;
    }
    for (const { x, y, height } of this.propLayout?.torches ??
      [2, 8, 14, 17].map((x) => ({ x, y: -0.1, height: 2 }))) {
      const p = this.project(x, y);
      this.sampleEffect(
        `torch:${x}`,
        "torch-flame",
        p.x,
        p.y -
          height *
            0.8 *
            (this.atlas.manifest?.projection?.pixelsPerWorldUnit ??
              50 / Math.SQRT2),
        (s.time / 0.6 + x * 0.17) % 1,
        active,
        0,
        0.5,
      );
    }
    for (const [id, effect] of this.persistentEffects)
      if (!active.has(id)) {
        effect.player.sprite.destroy();
        this.persistentEffects.delete(id);
      }
  }
  private atlasGeneration = 0;
  private atlasPending = false;
  private atlasFailure?: string;
  get loading() {
    return (
      this.atlasPending ||
      Boolean(this.atlasFailure) ||
      Boolean(this.assets && !this.ready)
    );
  }
  get loadError() {
    return this.atlasFailure;
  }
  private static sharedTextures = new Map<
    string,
    { ready: Promise<Texture>; refs: number }
  >();
  private async acquireTexture(url: string) {
    let lease = ArenaPresenter.sharedTextures.get(url);
    if (!lease) {
      lease = { ready: Assets.load<Texture>(url), refs: 0 };
      ArenaPresenter.sharedTextures.set(url, lease);
    }
    lease.refs++;
    this.loadedUrls.add(url);
    return lease.ready;
  }
  private releaseTexture(url: string) {
    const lease = ArenaPresenter.sharedTextures.get(url);
    if (!lease) return;
    lease.refs--;
    if (!lease.refs)
      void lease.ready.then(
        () => {
          if (!lease.refs && ArenaPresenter.sharedTextures.get(url) === lease) {
            ArenaPresenter.sharedTextures.delete(url);
            void Assets.unload(url);
          }
        },
        () => {
          ArenaPresenter.sharedTextures.delete(url);
        },
      );
  }
  private clips = new Map<string, ClipPlayer>();
  private ready = false;
  private closed = false;
  private loadedUrls = new Set<string>();
  private reducedMotion =
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  private backgrounds: Sprite[] = [];
  private foregrounds: Sprite[] = [];
  private legacyPlateRequested = false;
  private impactSeen = 0;
  private particles = new ParticlePool(500);
  private uiSpring = new SpringTransform();
  private queue = new PresentationQueue();
  private boonCount = 0;
  private root = new Container();
  private ground = new Graphics();
  private props = new Map<string, Graphics | Sprite>();
  private propTextures = new Map<string, Texture>();
  private propLayout?: {
    torches?: { x: number; y: number; height: number }[];
    props?: Record<string, { pivot: { x: number; y: number }; scale?: number }>;
    occluders?: { x: number; y: number; width: number; height: number }[];
  };
  private directions = new Map<string, number>();
  private clocks = new Map<
    string,
    { mode: string; elapsed: number; instance: number }
  >();
  private flashes = new Map<string, ColorMatrixFilter>();
  private outcomeTime = 0;
  private framedRoom = -1;
  private frameDt = 0;
  private effects = new Graphics();
  private actors = new Map<string, Graphics>();
  private label = new Text({
    text: "",
    style: { fontFamily: "Georgia", fontSize: 23, fill: 0xffe7b8 },
  });
  private stage?: PixiStage;
  constructor(
    private session: ArenaSession,
    private assets?: {
      manifestUrl: string;
      legacyManifestUrl?: string;
      effectManifestUrl?: string;
      clips: Record<string, string>;
      backgrounds?: string[];
      legacyRoomBackgroundUrl?: string;
      foregrounds?: string[];
      propLayoutUrl?: string;
      props?: { pillar: string; breakable: string; [state: string]: string };
      presentation?: {
        weaponsBaked?: boolean;
        directionOffset?: number;
        directionSign?: number;
        contactPhase?: number;
        activeEndPhase?: number;
      };
      roleClips?: Record<string, string>;
      actorScale?: { player: number; enemy: number; boss: number };
    },
  ) {}
  setSession(session: ArenaSession, legacy = false) {
    const changed = this.legacy !== legacy;
    this.legacy = legacy;
    if (changed && this.ready && this.assets?.legacyManifestUrl) {
      const generation = ++this.atlasGeneration;
      this.atlasPending = true;
      this.atlasFailure = undefined;
      const next = new AtlasLoader();
      void next
        .loadUrl(
          legacy ? this.assets.legacyManifestUrl : this.assets.manifestUrl,
        )
        .then(() => {
          if (this.closed || generation !== this.atlasGeneration) {
            next.dispose();
            return;
          }
          this.atlas.dispose();
          this.atlas = next;
          this.clocks.clear();
          this.atlasPending = false;
          this.framedRoom = -1;
        })
        .catch((error: unknown) => {
          next.dispose();
          if (this.closed || generation !== this.atlasGeneration) return;
          this.atlasPending = false;
          this.atlasFailure = `Character assets could not load: ${error instanceof Error ? error.message : String(error)}`;
        });
    }
    this.session = session;
    this.particles.reset();
    this.framedRoom = -1;
    this.impactSeen = 0;
    this.boonCount = 0;
    this.outcomeTime = 0;
    this.clocks.clear();
    this.directions.clear();
    for (const effect of this.contactEffects.values())
      effect.player.sprite.destroy();
    this.contactEffects.clear();
    for (const effect of this.persistentEffects.values())
      effect.player.sprite.destroy();
    this.persistentEffects.clear();
    this.observedEffects.clear();
    this.observedRoom = -1;
    this.previousProjectiles.clear();
    this.previousEchoes.clear();
    this.previousSpecial = undefined;
    this.lastDash = false;
  }
  async init(stage: PixiStage) {
    if (this.closed) return;
    this.stage = stage;
    this.root.addChild(this.ground);
    stage.layers.effects.addChild(this.effects);
    stage.layers.ground.addChild(this.root);
    stage.layers.hud.addChild(this.label);
    this.label.position.set(24, 20);
    this.uiSpring.x = 24;
    this.uiSpring.y = 20;
    this.uiSpring.target.x = 24;
    this.uiSpring.target.y = 20;
    stage.layers.effects.addChild(this.particles.container);
    stage.camera.zoom = 1.18;
    const center = this.project(
      this.session.room.width / 2,
      this.session.room.height / 2,
    );
    stage.camera.pan(
      center.x - stage.width / 2 / 1.18,
      center.y - stage.height / 2 / 1.18,
    );
    this.framedRoom = this.session.state.room;
    if (this.assets) {
      await this.atlas.loadUrl(
        this.legacy && this.assets.legacyManifestUrl
          ? this.assets.legacyManifestUrl
          : this.assets.manifestUrl,
      );
      if (this.closed) return;
      this.ready = true;
      if (this.assets.effectManifestUrl) {
        await this.effectAtlas.loadUrl(this.assets.effectManifestUrl);
        if (this.closed) return;
        this.effectReady = true;
      }
      if (this.assets.propLayoutUrl) {
        const response = await fetch(this.assets.propLayoutUrl);
        if (!response.ok)
          throw new Error(
            `Prop layout could not load: ${this.assets.propLayoutUrl}`,
          );
        this.propLayout = await response.json();
        if (this.closed) return;
      }
      for (const [kind, url] of Object.entries(this.assets.props ?? {})) {
        const texture = await this.acquireTexture(url);
        if (this.closed) {
          if (this.loadedUrls.delete(url)) this.releaseTexture(url);
          return;
        }
        this.loadedUrls.add(url);
        this.propTextures.set(kind, texture);
      }
      for (const url of this.assets.foregrounds ?? []) {
        const texture = await this.acquireTexture(url);
        if (this.closed) {
          if (this.loadedUrls.delete(url)) this.releaseTexture(url);
          return;
        }
        this.loadedUrls.add(url);
        const sprite = new Sprite(texture);
        this.foregrounds.push(sprite);
        stage.layers.foreground.addChild(sprite);
      }
      for (const url of this.assets.backgrounds ?? []) {
        const texture = await this.acquireTexture(url);
        if (this.closed) {
          if (this.loadedUrls.delete(url)) this.releaseTexture(url);
          return;
        }
        this.loadedUrls.add(url);
        const sprite = new Sprite(texture);
        sprite.width = 1280;
        sprite.height = 720;
        this.backgrounds.push(sprite);
        this.root.addChildAt(sprite, 0);
      }
    }
  }
  resize(width: number, height: number) {
    this.label.style.wordWrap = true;
    this.label.style.wordWrapWidth = Math.max(240, width - 48);
    this.framedRoom = -1;
  }
  project(x: number, y: number) {
    return projectWithRecipe(x, y, this.atlas.manifest?.projection);
  }
  inverse(x: number, y: number) {
    const world = this.stage?.camera.inverse(x, y) ?? { x, y };
    return unprojectWithRecipe(
      world.x,
      world.y,
      this.atlas.manifest?.projection,
    );
  }
  renderOutcome(dt: number) {
    const step = Math.min(dt, Math.max(0, 0.9 - this.outcomeTime));
    this.outcomeTime += step;
    this.render(step);
  }
  render(dt: number) {
    if (this.stage) this.stage.camera.reducedMotion = this.reducedMotion;
    if (this.closed) return;
    if (this.stage) {
      this.stage.layers.actors.visible = !this.loading;
      this.stage.layers.effects.visible = !this.loading;
    }
    if (this.loading) {
      this.label.text = this.atlasFailure ?? "Preparing character assets…";
      return;
    }
    this.frameDt = dt;
    if (
      this.legacy &&
      this.session.state.room === 1 &&
      !this.legacyPlateRequested &&
      this.assets?.legacyRoomBackgroundUrl
    ) {
      this.legacyPlateRequested = true;
      const url = this.assets.legacyRoomBackgroundUrl;
      void this.acquireTexture(url)
        .then((texture) => {
          if (this.closed) {
            if (this.loadedUrls.delete(url)) this.releaseTexture(url);
            return;
          }
          const sprite = new Sprite(texture);
          sprite.width = 1280;
          sprite.height = 720;
          this.backgrounds[1] = sprite;
          this.root.addChildAt(sprite, 0);
        })
        .catch(() => {
          if (this.loadedUrls.delete(url)) this.releaseTexture(url);
        });
    }
    if (this.stage && this.framedRoom !== this.session.state.room) {
      const center = this.project(
        this.session.room.width / 2,
        this.session.room.height / 2,
      );
      const zoom = this.stage.camera.zoom;
      this.stage.camera.pan(
        center.x - this.stage.width / 2 / zoom,
        center.y - this.stage.height / 2 / zoom,
      );
      this.framedRoom = this.session.state.room;
    }
    if (this.session.state.boons.length > this.boonCount) {
      this.boonCount = this.session.state.boons.length;
      this.queue.enqueue({
        id: `boon:${this.boonCount}`,
        lane: "boons",
        duration: 0.35,
        run: () => this.uiSpring.juice(0.12),
      });
    }
    this.queue.update(dt);
    this.uiSpring.update(dt, this.label);
    this.particles.update(dt);
    const s = this.session.state,
      r = this.session.room,
      g = this.ground;
    g.clear();
    for (let i = 0; i < this.backgrounds.length; i++)
      this.backgrounds[i]!.visible = i === s.room;
    g.alpha = 1;
    const hasPlate = this.backgrounds.length > 0;
    const corners = [
      [0, 0],
      [r.width, 0],
      [r.width, r.height],
      [0, r.height],
    ].map(([x, y]) => this.project(x!, y!));
    if (!hasPlate)
      g.poly(corners.flatMap((p) => [p.x, p.y]))
        .fill(0x30283a)
        .stroke({ width: 4, color: 0x9c785a });
    if (!hasPlate)
      for (let x = 0; x < r.width; x++)
        for (let y = 0; y < r.height; y++) {
          const p = this.project(x, y);
          g.poly([
            p.x,
            p.y,
            p.x + 25,
            p.y + 15,
            p.x,
            p.y + 30,
            p.x - 25,
            p.y + 15,
          ])
            .fill((x + y) % 2 ? 0x3c3345 : 0x362e3e)
            .stroke({ width: 0.5, color: 0x554258 });
        }
    const propIds = new Set<string>();
    const drawProp = (
      id: string,
      kind: string,
      x: number,
      y: number,
      radius = 0.6,
    ) => {
      propIds.add(id);
      const p = this.project(x, y);
      g.ellipse(p.x + 5, p.y + 4, radius * 30, radius * 15).fill({
        color: 0x080b16,
        alpha: 0.5,
      });
      let view = this.props.get(id);
      if (!view) {
        const texture = this.propTextures.get(kind);
        view = texture ? new Sprite(texture) : new Graphics();
        if (view instanceof Sprite) {
          const sourceKind =
            kind === "breakable"
              ? "urn"
              : kind === "breakableBroken"
                ? "urn-broken"
                : kind === "trap-cooldown"
                  ? "trap-retracted"
                  : kind;
          const layout = this.propLayout?.props?.[sourceKind];
          if (layout) {
            view.pivot.set(layout.pivot.x, layout.pivot.y);
            view.scale.set(layout.scale ?? 1);
          } else {
            view.anchor.set(0.5, 1);
            view.width =
              kind === "pillar"
                ? 70
                : kind.startsWith("exit")
                  ? 65
                  : kind.startsWith("trap")
                    ? 70
                    : 36;
            view.height =
              kind === "pillar"
                ? 110
                : kind.startsWith("exit")
                  ? 90
                  : kind.startsWith("trap")
                    ? 35
                    : 44;
          }
        } else if (kind === "pillar")
          view
            .roundRect(-20, -85, 40, 85, 5)
            .fill(0x766579)
            .stroke({ color: 0xc5aa83, width: 2 })
            .ellipse(0, -85, 25, 12)
            .fill(0xa18a92);
        else
          view
            .ellipse(0, -20, 15, 22)
            .fill(0xa96f49)
            .stroke({ color: 0xe7b66d, width: 2 })
            .ellipse(0, -39, 11, 4)
            .fill(0x453b3e);
        this.props.set(id, view);
        this.stage!.layers.actors.addChild(view);
      }
      view.position.set(p.x, p.y);
      view.zIndex = p.y;
      const hero = this.project(s.player.x, s.player.y);
      view.alpha =
        kind === "pillar" &&
        hero.y < p.y &&
        hero.y > p.y - 110 &&
        Math.abs(hero.x - p.x) < 38
          ? 0.3
          : 1;
    };
    r.pillars.forEach((pillar, i) =>
      drawProp(
        `pillar:${s.room}:${i}`,
        "pillar",
        pillar.x,
        pillar.y,
        pillar.radius,
      ),
    );
    s.breakables.forEach((b, i) => {
      drawProp(
        `urn:${s.room}:${i}:${b.alive}`,
        b.alive ? "breakable" : "breakableBroken",
        b.x,
        b.y,
      );
    });
    if (r.hazard) {
      for (const p of corners)
        g.circle(p.x, p.y, 20 + Math.sin(s.time * 3) * 3).fill({
          color: 0xe47639,
          alpha: 0.6,
        });
    }
    if (r.trap && s.trap) {
      const p = this.project(r.trap.x, r.trap.y);
      const active = s.trap.phase === "active",
        warning = s.trap.phase === "warning";
      if (this.propTextures.has(`trap-${s.trap.phase}`))
        drawProp(
          `trap:${s.trap.phase}`,
          `trap-${s.trap.phase}`,
          r.trap.x,
          r.trap.y,
        );
      else
        g.ellipse(p.x, p.y, r.trap.radius * 31, r.trap.radius * 18)
          .fill({
            color: active ? 0xffe5ad : 0x322c37,
            alpha: active ? 0.95 : 0.8,
          })
          .stroke({
            color: warning ? 0xff8a42 : active ? 0xffcf72 : 0x69565b,
            width: warning ? 3 : 1,
          });
      if (active)
        for (let i = -2; i <= 2; i++)
          g.poly([
            p.x + i * 12 - 4,
            p.y,
            p.x + i * 12,
            p.y - 24,
            p.x + i * 12 + 4,
            p.y,
          ]).fill(0xffd2a2);
    }
    for (const trail of s.trails ?? []) {
      const p = this.project(trail.x, trail.y);
      g.ellipse(p.x, p.y, 25, 13)
        .fill({ color: 0xe96329, alpha: Math.min(0.6, trail.life) })
        .ellipse(p.x, p.y, 12, 6)
        .fill({ color: 0xffd485, alpha: Math.min(0.8, trail.life) });
    }
    for (const echo of s.echoes ?? []) {
      const p = this.project(echo.x, echo.y);
      g.ellipse(p.x, p.y, 28, 16).stroke({
        color: 0x92e9ff,
        width: 2,
        alpha: 0.6,
      });
    }
    if (r.rewardExit) {
      if (s.phase === "upgrade" && this.propTextures.has("reward"))
        drawProp("reward", "reward", r.rewardExit.x - 2, r.rewardExit.y);
      const p = this.project(r.rewardExit.x, r.rewardExit.y);
      if (this.propTextures.has(s.exitOpen ? "exit-open" : "exit-closed"))
        drawProp(
          `exit:${s.exitOpen}`,
          s.exitOpen ? "exit-open" : "exit-closed",
          r.rewardExit.x,
          r.rewardExit.y,
        );
      else
        g.roundRect(p.x - 27, p.y - 72, 54, 72, 18)
          .fill(s.exitOpen ? 0x47c7b4 : 0x352b35)
          .stroke({ color: s.exitOpen ? 0xb9ffe8 : 0xa0835e, width: 4 });
    }
    if (this.stage && this.assets?.presentation?.weaponsBaked) {
      const hero = this.project(s.player.x, s.player.y);
      const zoom = this.stage.camera.zoom;
      const cornersX = corners.map((p) => p.x),
        cornersY = corners.map((p) => p.y);
      const center = this.project(r.width / 2, r.height / 2);
      const minX = Math.min(...cornersX),
        maxX = Math.max(...cornersX) - this.stage.width / zoom;
      const minY = Math.min(...cornersY) - 100,
        maxY = Math.max(...cornersY) - this.stage.height / zoom + 80;
      this.stage.camera.follow(
        maxX >= minX
          ? Math.max(minX, Math.min(maxX, hero.x - this.stage.width / 2 / zoom))
          : center.x - this.stage.width / 2 / zoom,
        maxY >= minY
          ? Math.max(
              minY,
              Math.min(maxY, hero.y - this.stage.height / 2 / zoom),
            )
          : center.y - this.stage.height / 2 / zoom,
        40,
      );
    }
    for (const [id, view] of this.props)
      if (!propIds.has(id)) {
        view.destroy();
        this.props.delete(id);
      }
    const hidden =
      this.propLayout?.occluders?.some(
        (o) =>
          s.player.x >= o.x &&
          s.player.x <= o.x + o.width &&
          s.player.y >= o.y &&
          s.player.y <= o.y + o.height,
      ) ?? s.player.y > r.height - 3;
    for (const foreground of this.foregrounds) {
      foreground.visible = !this.legacy;
      foreground.alpha = hidden ? 0.3 : 1;
    }
    const active = [s.player, ...s.enemies];
    const ids = new Set(active.map((a) => a.id));
    for (const [id, view] of this.actors)
      if (!ids.has(id)) {
        view.destroy();
        this.actors.delete(id);
        this.clips.get(id)?.sprite.destroy();
        this.clips.delete(id);
        this.clocks.delete(id);
        this.directions.delete(id);
        this.flashes.get(id)?.destroy();
        this.flashes.delete(id);
      }
    for (const a of active) this.drawActor(a);
    this.updateSimulationEffects(dt);
    const fx = this.effects;
    fx.clear();
    for (const hit of s.impacts) {
      const contact = hit as typeof hit & {
        material?: "organic" | "armor" | "block" | "kill" | "miss";
        heading?: number;
      };
      const recipe =
        contact.material === "block"
          ? { core: 0xe5fbff, body: 0x74b7e3, radius: 12, rays: 4 }
          : contact.material === "armor"
            ? { core: 0xffffff, body: 0x9adfff, radius: 8, rays: 7 }
            : contact.material === "kill"
              ? { core: 0xfff5be, body: 0xff8e54, radius: 13, rays: 10 }
              : { core: 0xfff7d9, body: hit.color, radius: 7, rays: 5 };
      const p = this.project(hit.x, hit.y);
      const life = Math.max(0, hit.life / 0.18);
      fx.ellipse(
        p.x,
        p.y - 16,
        recipe.radius * (2 - life),
        recipe.radius * (1 - life / 2),
      ).fill({ color: recipe.body, alpha: life * 0.25 });
      fx.circle(p.x, p.y - 20, recipe.radius * life).fill({
        color: recipe.core,
        alpha: life,
      });
      if (contact.material === "block")
        fx.ellipse(p.x, p.y - 20, 18 * (2 - life), 22 * (2 - life)).stroke({
          color: recipe.core,
          width: 3 * life,
          alpha: life,
        });
      if (hit.id > this.impactSeen) {
        if (!this.reducedMotion) this.stage!.camera.shake(hit.shake, 0.1);
        this.impactSeen = hit.id;
        if (this.effectReady) {
          const key =
            contact.material === "kill"
              ? "organic-hit"
              : (contact.material ?? "organic");
          const clip = this.effectAtlas.clip(key);
          if (clip.frames.length) {
            const player = new ClipPlayer();
            player.sprite.scale.set(0.6);
            player.sprite.blendMode =
              this.effectAtlas.manifest?.effects?.[key]?.blend === "add"
                ? "add"
                : "normal";
            const depth = this.effectAtlas.manifest?.effects?.[key]?.depth;
            (depth === "floor" || depth === "ground"
              ? this.stage!.layers.ground
              : this.stage!.layers.effects
            ).addChild(player.sprite);
            this.contactEffects.set(hit.id, {
              player,
              elapsed: 0,
              key,
              x: p.x,
              y: p.y - 20,
            });
          }
        }
        for (let i = 0; i < hit.sparks; i++) {
          const a = (i / hit.sparks) * Math.PI * 2;
          this.particles.emit(
            PixiTexture.WHITE,
            p.x,
            p.y - 20,
            Math.cos(a) * 120,
            Math.sin(a) * 100,
            0.22,
          );
        }
      }
      fx.circle(p.x, p.y - 20, 7 + (0.18 - hit.life) * 75).stroke({
        color: recipe.body,
        width: 3,
        alpha: Math.max(0, hit.life / 0.18) * 0.7,
      });
      for (let i = 0; i < hit.sparks; i++) {
        const angle = (i / hit.sparks) * Math.PI * 2,
          d = (0.18 - hit.life) * 130;
        fx.moveTo(p.x + Math.cos(angle) * d, p.y - 20 + Math.sin(angle) * d)
          .lineTo(
            p.x + Math.cos(angle) * (d + 8),
            p.y - 20 + Math.sin(angle) * (d + 8),
          )
          .stroke({ width: 2, color: hit.color, alpha: hit.life / 0.18 });
      }
    }
    for (const [id, effect] of this.contactEffects) {
      const clip = this.effectAtlas.clip(effect.key),
        duration = clip.metadata?.duration ?? 0.24;
      effect.elapsed += dt;
      if (effect.elapsed >= duration) {
        effect.player.sprite.destroy();
        this.contactEffects.delete(id);
        continue;
      }
      effect.player.sample(clip, effect.elapsed / duration, `impact:${id}`);
      effect.player.sprite.position.set(effect.x, effect.y);
    }
    for (const b of s.projectiles) {
      const p = this.project(b.x, b.y);
      fx.circle(p.x, p.y - 16, b.owner === "player" ? 6 : 8)
        .fill(b.owner === "player" ? 0x8df8ed : 0xfb9276)
        .circle(p.x, p.y - 16, 11)
        .stroke({ width: 2, color: 0xffddad, alpha: 0.4 });
    }
    this.label.style.fontSize = 19;
    const boonNames = s.boons
      .map(
        (id) =>
          this.session.definition.boons.find((boon) => boon.id === id)?.name ??
          id,
      )
      .join(" · ");
    this.label.text = `${r.name}   ${s.phase === "combat" ? `Wave ${s.wave + 1}` : s.phase.toUpperCase()}\n♥ ${Math.ceil(s.player.hp)}    Dash ${s.dash > 0 ? s.dash : "0 · recharging"}    Cast ${s.cast > 0 ? s.cast.toFixed(1) : "ready"}${boonNames ? `    ${boonNames}` : ""}${s.exitOpen ? "    EXIT OPEN" : ""}${s.charge > 0 ? `    Draw ${s.charge.toFixed(2)} ${s.charge > 0.65 && s.charge < 0.95 ? "PERFECT" : ""}` : ""}`;
  }
  private drawActor(a: ArenaActor) {
    let g = this.actors.get(a.id);
    if (!g) {
      g = new Graphics();
      this.actors.set(a.id, g);
      this.stage!.layers.actors.addChild(g);
    }
    const p = this.project(a.x, a.y),
      player = a.id === "player",
      d = this.session.definition.enemies.find((e) => e.id === a.definition),
      boss = d?.role === "boss",
      scale = boss ? 1.7 : 1;
    g.position.set(p.x, p.y);
    g.zIndex = p.y;
    g.clear();
    this.ground
      .ellipse(p.x, p.y + 2, 16 * scale, 7 * scale)
      .fill({ color: 0, alpha: 0.5 });
    const phase = a.action ? actionPhase(a.action) : undefined;
    const tell = phase?.phase === "tell";
    if (a.action && phase?.phase === "active") {
      const moveId =
        a.action.moveId ?? (d?.role === "ranged" ? "cast" : "sword1");
      const key =
        moveId === "special"
          ? "special-burst"
          : moveId === "cast"
            ? "cast-projectile"
            : moveId;
      const facing = this.project(
        a.x + Math.cos(a.action.heading ?? a.facing),
        a.y + Math.sin(a.action.heading ?? a.facing),
      );
      this.spawnEffect(
        key,
        p.x,
        p.y - (key === "special-burst" ? 0 : 20),
        `action:${a.action.id}`,
        key === "special-burst"
          ? 0
          : Math.atan2(facing.y - p.y, facing.x - p.x),
      );
    }
    if (
      a.action &&
      a.action.moveId !== "cast" &&
      (tell || phase?.phase === "active") &&
      !(
        player &&
        (this.session.weapon.kind === "bow" ||
          (this.session.weapon.kind === "spear" &&
            a.action.special &&
            !a.action.sweep))
      )
    ) {
      const action = a.action as typeof a.action & { special?: boolean };
      const moveShape = player
        ? this.session.weapon.moves?.find((m) => m.id === action.moveId)
            ?.hitShape
        : undefined;
      const range =
        moveShape?.range ??
        (player
          ? this.session.attackRange(action.special ?? false)
          : boss
            ? 2.6
            : 1.7);
      const halfArc =
        moveShape?.kind === "radial"
          ? Math.PI
          : moveShape?.kind === "sector"
            ? moveShape.arc / 2
            : player && action.special
              ? Math.PI
              : player
                ? Math.acos(0.2)
                : Math.acos(0.1);
      const points: number[] = [p.x, p.y];
      for (let i = 0; i <= 32; i++) {
        const angle = a.facing - halfArc + (2 * halfArc * i) / 32;
        const q = this.project(
          a.x + Math.cos(angle) * range,
          a.y + Math.sin(angle) * range,
        );
        points.push(q.x, q.y);
      }
      if (moveShape?.kind === "capsule") {
        points.length = 0;
        const heading = action.heading ?? a.facing;
        for (let i = 0; i <= 32; i++) {
          const theta = (i / 32) * Math.PI * 2;
          const along = Math.cos(theta) > 0 ? range : 0;
          const q = this.project(
            a.x +
              Math.cos(heading) * along +
              Math.cos(theta + heading) * moveShape.radius,
            a.y +
              Math.sin(heading) * along +
              Math.sin(theta + heading) * moveShape.radius,
          );
          points.push(q.x, q.y);
        }
      }
      this.ground
        .poly(points)
        .fill({
          color: player ? 0x92f5df : 0xf36d52,
          alpha: tell ? 0.08 + (phase?.progress ?? 0) * 0.12 : 0.12,
        })
        .stroke({
          color: player ? 0x9bffed : 0xff9674,
          width: 1.5,
          alpha: 0.65,
        });
    }
    // Projectile tells describe their travel direction without promising a melee footprint.
    if (
      tell &&
      ((player &&
        (a.action?.moveId === "cast" ||
          this.session.weapon.kind === "bow" ||
          (this.session.weapon.kind === "spear" &&
            a.action?.special &&
            !a.action.sweep))) ||
        d?.role === "ranged" ||
        (boss && a.attackKind !== 1))
    ) {
      const radial = boss && a.attackKind === 2;
      const count = radial
        ? 12
        : player && this.session.weapon.kind === "bow" && a.action?.special
          ? 5
          : boss
            ? 3
            : 1;
      for (let i = 0; i < count; i++) {
        const angle = radial
          ? (i * Math.PI * 2) / count
          : a.facing + (i - (count - 1) / 2) * 0.2;
        const end = this.project(
          a.x + Math.cos(angle) * 5,
          a.y + Math.sin(angle) * 5,
        );
        this.ground
          .moveTo(p.x, p.y)
          .lineTo(end.x, end.y)
          .stroke({
            color: player ? 0x92f5df : 0xff765e,
            width: 2,
            alpha: 0.15 + (phase?.progress ?? 0) * 0.45,
          });
      }
    }
    const animated = this.ready && this.assets;
    const bob = Math.sin(this.session.state.time * 8 + a.x) * 2;
    if (!animated) {
      g.poly([
        -10 * scale,
        -8,
        -13 * scale,
        -35 * scale + bob,
        0,
        -51 * scale + bob,
        13 * scale,
        -35 * scale + bob,
        10 * scale,
        -8,
      ])
        .fill(
          a.hurt > 0 ? 0xffffff : player ? 0x68d4cd : (d?.color ?? 0xbb8888),
        )
        .stroke({ color: 0xf3ddba, width: 1 });
      g.circle(0, -53 * scale + bob, 8 * scale).fill(
        player ? 0xf4c5a1 : 0xbba8b7,
      );
    }
    const facing = projectIsometric(
      Math.cos(a.facing),
      Math.sin(a.facing),
      0,
      this.atlas.manifest?.projection?.tileWidth ?? 50,
      this.atlas.manifest?.projection?.tileHeight ?? 30,
    );
    const angle = Math.atan2(facing.y, facing.x);
    if (
      !(
        this.assets?.presentation?.weaponsBaked &&
        (!player || this.session.weapon.kind === "sword")
      )
    ) {
      if (player && this.session.weapon.kind === "bow") {
        g.arc(
          Math.cos(angle) * 14,
          Math.sin(angle) * 9 - 28,
          16,
          angle - 1.2,
          angle + 1.2,
        ).stroke({ color: 0xe6bf72, width: 3 });
        g.moveTo(
          Math.cos(angle - 1.2) * 16 + Math.cos(angle) * 14,
          Math.sin(angle - 1.2) * 16 + Math.sin(angle) * 9 - 28,
        )
          .lineTo(
            Math.cos(angle + 1.2) * 16 + Math.cos(angle) * 14,
            Math.sin(angle + 1.2) * 16 + Math.sin(angle) * 9 - 28,
          )
          .stroke({ color: 0xffefc6, width: 1 });
      } else
        g.moveTo(Math.cos(angle) * 8, Math.sin(angle) * 5 - 24)
          .lineTo(
            Math.cos(angle) *
              (player && this.session.weapon.kind === "spear" ? 52 : 30),
            Math.sin(angle) *
              (player && this.session.weapon.kind === "spear" ? 31 : 18) -
              24,
          )
          .stroke({ color: player ? 0xb3f9f4 : 0xe8c5a0, width: 4 });
    }
    if (animated) {
      let playerClip = this.clips.get(a.id);
      if (!playerClip) {
        playerClip = new ClipPlayer();
        this.clips.set(a.id, playerClip);
        this.stage!.layers.actors.addChild(playerClip.sprite);
      }
      const action = a.action as
        | (typeof a.action & {
            special?: boolean;
            sweep?: boolean;
            dashStrike?: boolean;
            moveId?: string;
            clipId?: string;
            heading?: number;
          })
        | undefined;
      const mode =
        a.hp <= 0
          ? "death"
          : (a.shieldBreak ?? 0) > 0
            ? "shield-break"
            : action?.dashStrike
              ? "dash-strike"
              : action?.clipId || action?.moveId
                ? (action.clipId ?? action.moveId!)
                : player && this.session.state.dashTime > 0
                  ? "dash"
                  : a.hurt > 0
                    ? "hurt"
                    : action
                      ? player
                        ? this.session.weapon.kind === "sword"
                          ? action.special
                            ? "special"
                            : `sword${(action.combo ?? this.session.state.combo) + 1}`
                          : this.session.weapon.kind === "spear"
                            ? action.sweep
                              ? "spear2"
                              : action.special
                                ? "spear3"
                                : "spear1"
                            : action.special
                              ? "bow-fan"
                              : "bow-release"
                        : "sword1"
                      : player && this.session.state.castPose > 0
                        ? "cast"
                        : player && this.session.state.charge > 0
                          ? this.session.state.charge > 1
                            ? "bow-hold"
                            : "bow-draw"
                          : a.moving
                            ? "run"
                            : "idle";
      const key = this.assets!.clips[mode] ?? mode;
      const calibration = this.assets!.presentation;
      const role = player ? "hero" : (d?.role ?? "melee");
      const count = this.legacy
        ? 8
        : spriteDirectionCount(this.atlas.manifest ?? {}, role, key);
      const heading = action?.heading ?? a.facing;
      let direction =
        (((Math.round(heading / ((Math.PI * 2) / count)) *
          (calibration?.directionSign ?? 1) +
          (calibration?.directionOffset ?? 0)) %
          count) +
          count) %
        count;
      const previousDirection = this.directions.get(a.id);
      if (!action && a.moving && previousDirection !== undefined) {
        const sector = (Math.PI * 2) / count;
        const calibratedHeading =
          heading * (calibration?.directionSign ?? 1) +
          (calibration?.directionOffset ?? 0) * sector;
        const delta = Math.atan2(
          Math.sin(calibratedHeading - previousDirection * sector),
          Math.cos(calibratedHeading - previousDirection * sector),
        );
        if (Math.abs(delta) < sector * 0.62) direction = previousDirection;
      }
      this.directions.set(a.id, direction);
      const prefix = this.legacy
        ? ""
        : player
          ? this.session.weapon.kind === "sword"
            ? ""
            : "legacy/"
          : (this.assets!.roleClips?.[d?.role ?? "melee"] ?? "");
      const roleClip = this.atlas.clip(`${prefix}${key}:${direction}`);
      const clip = roleClip.frames.length
        ? roleClip
        : this.atlas.clip(`${key}:${direction}`);
      let clock = this.clocks.get(a.id);
      if (!clock || clock.mode !== mode) {
        clock = { mode, elapsed: 0, instance: (clock?.instance ?? 0) + 1 };
        this.clocks.set(a.id, clock);
      } else clock.elapsed += this.frameDt;
      if (a.animation && mode !== "death") {
        clock.elapsed = a.animation.elapsed;
        clock.instance = a.animation.id;
      }
      const clipDuration =
        clip.metadata?.duration ??
        (mode === "dash"
          ? 0.18
          : mode === "cast"
            ? 0.25
            : mode === "hurt"
              ? 0.16
              : mode === "bow-draw"
                ? 1
                : 1.2);
      const contact = calibration?.contactPhase ?? 0.35,
        activeEnd = calibration?.activeEndPhase ?? 0.65;
      const actionProgress = phase
        ? editedClipPhase(
            phase.phase,
            phase.progress,
            clip.metadata?.markers ?? { contact, activeEnd },
          )
        : 1;

      playerClip.sample(
        clip,
        action &&
          (a.animation?.kind === "attack" || action.moveId !== undefined)
          ? Math.min(0.999, actionProgress)
          : a.hp <= 0
            ? Math.min(0.999, Math.max(a.deathTime ?? 0, clock.elapsed) / 0.8)
            : mode === "run"
              ? (a.locomotion ?? 0) % 1
              : mode === "idle" || mode === "bow-hold"
                ? (clock.elapsed / clipDuration) % 1
                : Math.min(0.999, clock.elapsed / clipDuration),
        `${a.id}:${mode}:${action?.id ?? clock.instance}`,
      );
      const sprite = playerClip.sprite;
      sprite.position.set(p.x, p.y);
      sprite.zIndex = p.y - 0.1;
      const sizes = this.assets?.actorScale ?? {
        player: 0.92,
        enemy: 0.72,
        boss: 1.42,
      };
      sprite.scale.set(
        this.legacy
          ? player
            ? 0.92
            : boss
              ? 1.42
              : 0.72
          : player
            ? sizes.player
            : boss
              ? sizes.boss
              : sizes.enemy,
      );
      sprite.tint = 0xffffff;
      if (
        phase?.phase === "active" &&
        a.action?.moveId !== "cast" &&
        playerClip.sampledAnchors?.weaponTip
      ) {
        const tip = playerClip.sampledAnchors.weaponTip,
          hand = playerClip.sampledAnchors.hand;
        const pivot = playerClip.sampledPivot,
          k = sprite.scale.x;
        const tx = (tip.x - pivot.x) * k,
          ty = (tip.y - pivot.y) * k;
        if (hand)
          g.moveTo((hand.x - pivot.x) * k, (hand.y - pivot.y) * k)
            .lineTo(tx, ty)
            .stroke({ color: 0xffd692, width: 5, alpha: 0.65 });
        g.circle(tx, ty, 3).fill(0xfff5cf);
      }
      let flash = this.flashes.get(a.id);
      if (!flash) {
        flash = new ColorMatrixFilter();
        this.flashes.set(a.id, flash);
      }
      flash.brightness(a.hurt > 0 && !this.reducedMotion ? 1.65 : 1, false);
      sprite.filters = a.hurt > 0 && !this.reducedMotion ? [flash] : [];
    }
    if (
      d?.role === "shield" &&
      !a.shieldBroken &&
      !(animated && this.assets?.presentation?.weaponsBaked)
    )
      g.ellipse(Math.cos(angle) * 18, Math.sin(angle) * 9 - 20, 12, 20)
        .fill(0x567a8c)
        .stroke({ color: 0xaad0d0, width: 2 });
    if (
      phase?.phase === "active" &&
      a.action?.moveId !== "cast" &&
      (player
        ? this.session.weapon.kind === "sword" ||
          (this.session.weapon.kind === "spear" &&
            (!a.action?.special || a.action.sweep))
        : d?.role !== "ranged" && (!boss || a.attackKind === 1))
    ) {
      const reach = player
        ? this.session.attackRange(a.action?.special ?? false)
        : boss
          ? 2.6
          : 1.7;
      const move = player
        ? this.session.weapon.moves?.find((m) => m.id === a.action?.moveId)
        : undefined;
      const heading = a.action?.heading ?? a.facing;
      const sweep =
        heading +
        (move?.hitShape.kind === "sector" && move.hitShape.reverse ? 1 : -1) *
          (1.25 - phase.progress * 2.5);
      const trail: number[] = [];
      for (let i = 0; i <= 16; i++) {
        const angle = sweep - 0.8 + i * 0.05;
        const q = this.project(
          a.x + Math.cos(angle) * reach,
          a.y + Math.sin(angle) * reach,
        );
        trail.push(q.x - p.x, q.y - p.y - 22);
      }
      if (move?.hitShape.kind === "capsule") {
        const end = this.project(
          a.x + Math.cos(heading) * move.hitShape.range,
          a.y + Math.sin(heading) * move.hitShape.range,
        );
        trail.splice(0, trail.length, 0, -22, end.x - p.x, end.y - p.y - 22);
      }
      if (move?.hitShape.kind === "radial")
        g.ellipse(
          0,
          0,
          move.hitShape.range * 30 * phase.progress,
          move.hitShape.range * 18 * phase.progress,
        ).stroke({ color: 0xffd291, width: 5, alpha: 1 - phase.progress });
      else
        g.poly(trail, false).stroke({
          color: player ? 0xd5fff0 : 0xffad80,
          width: 5,
          alpha: 0.75 * (1 - phase.progress * 0.5),
        });
    }
    g.rect(-20, -72 * scale, 40, 4)
      .fill(0x2b202f)
      .rect(-20, -72 * scale, (40 * a.hp) / a.maxHp, 4)
      .fill(player ? 0x86e2b2 : 0xe48672);
  }
  snapshot() {
    return {
      queue: this.queue.snapshot(),
      boonCount: this.boonCount,
      impactSeen: this.impactSeen,
      spring: this.uiSpring.snapshot(),
      clocks: [...this.clocks.entries()].map(
        ([id, clock]) => [id, { ...clock }] as const,
      ),
      outcomeTime: this.outcomeTime,
      observedEffects: [...this.observedEffects],
    };
  }
  restore(value: ReturnType<ArenaPresenter["snapshot"]>) {
    this.particles.reset();
    this.clocks = new Map(value.clocks ?? []);
    this.observedEffects = new Set(value.observedEffects ?? []);
    this.observedRoom = this.session.state.room;
    this.lastDash = this.session.state.dashTime > 0;
    this.previousProjectiles = new Map(
      this.session.state.projectiles.map((p) => [
        p.id,
        { x: p.x, y: p.y, cast: p.cast ?? false },
      ]),
    );
    this.previousEchoes = new Map(
      (this.session.state.echoes ?? []).map((e) => [e.id, { x: e.x, y: e.y }]),
    );
    this.outcomeTime = value.outcomeTime ?? 0;
    this.boonCount = value.boonCount;
    this.impactSeen = value.impactSeen;
    this.uiSpring.restore(value.spring);
    this.queue.restore(
      value.queue,
      value.queue.pending.map((p) => ({
        id: p.id,
        lane: "boons",
        duration: 0.35,
        run: () => this.uiSpring.juice(0.12),
      })),
    );
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.particles.dispose();
    this.queue.dispose();
    this.atlas.dispose();
    this.effectAtlas.dispose();
    for (const effect of this.contactEffects.values())
      effect.player.sprite.destroy();
    this.contactEffects.clear();
    for (const effect of this.persistentEffects.values())
      effect.player.sprite.destroy();
    this.persistentEffects.clear();
    this.observedEffects.clear();
    this.observedRoom = -1;
    this.previousProjectiles.clear();
    this.previousEchoes.clear();
    this.previousSpecial = undefined;
    this.lastDash = false;
    for (const url of this.loadedUrls) this.releaseTexture(url);
    this.loadedUrls.clear();
    for (const view of this.props.values()) view.destroy();

    for (const foreground of this.foregrounds) foreground.destroy();
    this.effects.destroy();
    for (const flash of this.flashes.values()) flash.destroy();
    this.flashes.clear();
    for (const c of this.clips.values()) c.sprite.destroy();
    this.root.destroy({ children: true });
    this.label.destroy();
    for (const a of this.actors.values()) a.destroy();
    this.actors.clear();
    this.directions.clear();
    this.clocks.clear();
    this.clips.clear();
    this.props.clear();
  }
}
