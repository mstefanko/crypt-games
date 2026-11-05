import { validatePresentationQueueSnapshot } from "../presentation/event-queue";
export { formatSettlementResources } from "../presentation/settlement-visuals";
import {
  settlementCitizenVisual,
  formatSettlementResources,
} from "../presentation/settlement-visuals";
import {
  projectIsometric,
  unprojectIsometric,
} from "../presentation/isometric";
import {
  Container,
  Graphics,
  Text,
  Sprite,
  AtlasLoader,
  ClipPlayer,
  PanelController,
  SpringTransform,
  PresentationQueue,
  ParticlePool,
  Texture,
  type PixiPresenter,
  type PixiStage,
} from "./index";
import type { SettlementSession } from "@onepage/game-simulation/settlement-session";
/** Retained village scene: cached 8x8 ground chunks, feet ordering and seasonal overlay. */
export class SettlementPresenter implements PixiPresenter {
  private atlas = new AtlasLoader();
  private snowAtlas = new AtlasLoader();
  private roofSnow = new Map<string, Sprite>();
  private roofMasks = new Map<string, Graphics>();
  private chunkRevisions = new Map<number, number>();
  private actorAtlas = new AtlasLoader();
  private clips = new Map<string, ClipPlayer>();
  private actorsReady = false;
  private ghost = new Graphics();
  private ghostSpring = new SpringTransform();
  private noticeSpring = new SpringTransform();
  private queue = new PresentationQueue();
  private particles = new ParticlePool(180);
  private panel?: PanelController;
  private panelHost?: HTMLElement;
  private inspector = "";
  private notice = "";
  private pointer = { x: 0, y: 0 };
  private weatherTime = 0;
  private weatherBudget = 0;
  private piles = new Graphics();
  private textures = new Map<string, Sprite>();
  private panX = 0;
  private panY = 0;
  private zoom = 1;
  private root = new Container();
  private chunks = new Map<number, Graphics>();
  private actors = new Map<string, Graphics>();
  private buildings = new Map<string, Graphics>();
  private buildingSignatures = new Map<string, string>();
  private cropSprites = new Map<string, Sprite>();
  private cargoSprites = new Map<string, Sprite>();
  private labels = new Map<string, Text>();
  private snow = new Graphics();
  private hud = new Text({
    text: "",
    style: { fontFamily: "Georgia", fontSize: 20, fill: 0xf3ead6 },
  });
  private stage?: PixiStage;
  private season = -1;
  private revision = -1;
  private readonly definition: SettlementSession["definition"];
  constructor(
    private session: SettlementSession,
    private assets?: {
      manifestUrl: string;
      /** Game-owned HUD copy and resource selection; IDs are passed to the owner. */
      hud?: {
        seasons: readonly string[];
        paused: string;
        residents: string;
        resources: readonly { id: string; label: string }[];
      };
      buildings: Record<string, string>;
      terrain?: Record<number, string>;
      /** Measured bake layers share owner footprint; trim/pivot determines positioning. */
      buildingArt?: Record<
        string,
        { final: string; construction: string; snow: string }
      >;
      displayScale?: number;
      crops?: { young: string; grown: string };
      cargo?: string;
      guide?: readonly string[];
      landmarks?: readonly { label: string; x: number; y: number }[];
      actorsUrl?: string;
      actorScale?: number;
      snowMaskUrl?: string;
      initialCamera?: { x: number; y: number; zoom: number };
    },
  ) {
    this.definition = session.definition;
    this.panX = assets?.initialCamera?.x ?? 0;
    this.panY = assets?.initialCamera?.y ?? 0;
    this.zoom = assets?.initialCamera?.zoom ?? 1;
  }
  async init(stage: PixiStage) {
    this.stage = stage;
    stage.camera.pan(this.panX, this.panY);
    stage.camera.zoom = this.zoom;
    stage.layers.ground.addChild(this.root);
    for (const landmark of this.assets?.landmarks ?? []) {
      const label = new Text({
        text: landmark.label,
        style: { fontFamily: "Georgia", fontSize: 13, fill: 0xf4ebd0 },
      });
      const point = this.project(landmark.x, landmark.y);
      label.position.set(point.x, point.y);
      label.anchor.set(0.5);
      label.alpha = 0.8;
      this.root.addChild(label);
    }
    stage.layers.effects.addChild(this.snow, this.particles.container);
    stage.layers.actors.addChild(this.ghost, this.piles);
    this.panelHost = document.createElement("div");
    this.panelHost.style.cssText =
      "background:#26382f;color:#efe9d7;padding:12px;font:16px/1.5 Georgia;max-height:240px;overflow:auto";
    stage.canvas.parentElement!.insertAdjacentElement(
      "afterend",
      this.panelHost,
    );
    this.panel = new PanelController(this.panelHost, "Settlement inspector");
    this.panel.element.addEventListener("pointerdown", (e) =>
      e.stopPropagation(),
    );
    this.noticeSpring.x = 20;
    this.noticeSpring.y = 18;
    this.noticeSpring.target.x = 20;
    this.noticeSpring.target.y = 18;
    stage.layers.hud.addChild(this.hud);
    this.hud.position.set(20, 18);
    if (this.assets) {
      const manifest = await this.atlas.loadUrl(this.assets.manifestUrl);
      if (this.assets.snowMaskUrl)
        await this.snowAtlas.load({
          pages: Object.fromEntries(
            Object.keys(manifest.pages).map((id) => [
              id,
              new URL(this.assets!.snowMaskUrl!, document.baseURI).href,
            ]),
          ),
          frames: manifest.frames,
        });
      if (this.assets.actorsUrl) {
        await this.actorAtlas.loadUrl(this.assets.actorsUrl);
        this.actorsReady = true;
      }
    }
  }
  resize() {}
  project(x: number, y: number) {
    const p = projectIsometric(x, y, 0, 32, 18);
    return { x: 640 + p.x, y: -300 + p.y };
  }
  inverse(x: number, y: number) {
    x = x / this.zoom + this.panX;
    y = y / this.zoom + this.panY;
    return unprojectIsometric(x - 640, y + 300, 32, 18);
  }
  input(
    dt: number,
    input: {
      held: ReadonlySet<string>;
      pointer: { x: number; y: number; pressed: boolean };
      action?: string;
      cancelled?: boolean;
    },
  ) {
    this.pointer = this.inverse(input.pointer.x, input.pointer.y);
    if (input.action) this.session.command(input.action);
    if (input.cancelled) this.session.command("cancel");
    this.panX +=
      (Number(input.held.has("ArrowRight")) -
        Number(input.held.has("ArrowLeft"))) *
      dt *
      250;
    this.panY +=
      (Number(input.held.has("ArrowDown")) -
        Number(input.held.has("ArrowUp"))) *
      dt *
      250;
    this.zoom = Math.max(
      0.6,
      Math.min(
        1.8,
        this.zoom +
          (Number(input.held.has("Equal")) - Number(input.held.has("Minus"))) *
            dt,
      ),
    );
    this.stage?.camera.pan(this.panX, this.panY);
    if (this.stage) this.stage.camera.zoom = this.zoom;
    if (input.pointer.pressed) {
      const p = this.inverse(input.pointer.x, input.pointer.y);
      if (this.session.state.placement) this.session.place(p.x, p.y);
      else {
        const person = this.session.state.people.find(
            (v) => Math.hypot(v.x - p.x, v.y - p.y) < 0.75,
          ),
          building = this.session.state.buildings.find((b) => {
            const d = this.definition.buildings.find((d) => d.id === b.type)!;
            return (
              p.x >= b.x &&
              p.x < b.x + d.size &&
              p.y >= b.y &&
              p.y < b.y + d.size
            );
          });
        if (person || building)
          this.session.command(`select:${person?.id ?? building?.id}`);
      }
    }
  }
  private visible(x: number, y: number, margin = 150) {
    const sx = (x - this.panX) * this.zoom,
      sy = (y - this.panY) * this.zoom;
    return (
      sx > -margin && sy > -margin && sx < 1280 + margin && sy < 720 + margin
    );
  }
  render(dt: number) {
    const s = this.session.state,
      season = s.season;
    this.weatherTime += dt;
    this.weatherBudget += dt;
    this.particles.update(dt);
    if (season === 3 && this.weatherBudget > 0.05) {
      this.weatherBudget = 0;
      for (let i = 0; i < 3; i++)
        this.particles.emit(
          Texture.WHITE,
          (this.weatherTime * 173 + i * 381) % 1280,
          0,
          12,
          28,
          26,
        );
    }
    const notice = s.message + s.warnings.join();
    if (notice !== this.notice) {
      this.notice = notice;
      this.queue.enqueue({
        id: `notice:${s.tick}:${notice}`,
        lane: "notices",
        duration: 0.3,
        run: () => this.noticeSpring.juice(0.04),
      });
    }
    this.queue.update(dt);
    this.noticeSpring.update(dt, this.hud);
    const selected = s.people.find((p) => p.id === s.selected),
      building = s.buildings.find((b) => b.id === s.selected),
      definition = building
        ? this.definition.buildings.find((d) => d.id === building.type)
        : undefined;
    const lines = selected
      ? [
          `${selected.id} · ${selected.job}`,
          selected.why,
          `Health ${Math.ceil(selected.health)} · hunger ${Math.floor(selected.hunger)} · cold ${Math.floor(selected.cold)}`,
          `Cargo: ${
            Object.entries(selected.cargo)
              .filter(([, n]) => n > 0)
              .map(([r, n]) => `${n} ${r}`)
              .join(", ") || "empty"
          }`,
          `Next: ${selected.queue[0]?.kind ?? "decision pending"} · route ${settlementCitizenVisual(selected).route}`,
        ]
      : building
        ? [
            definition!.name,
            building.complete
              ? `${building.assigned} workers requested`
              : `Delivered: ${Object.entries(definition!.cost)
                  .map(
                    ([resource, amount]) =>
                      `${building.materials[resource] ?? 0}/${amount} ${resource}`,
                  )
                  .join(
                    " · ",
                  )} · work ${Math.round((building.work / 12) * 100)}%`,
            `Stored here: ${formatSettlementResources(building.inventory)}`,
            ...(!building.complete
              ? [
                  "Builders must deliver every required material before work starts. Keep the gold door marker and its approach clear.",
                ]
              : []),
            `Door: ${building.x + (definition!.doorOffset?.x ?? 0)}, ${building.y + (definition!.doorOffset?.y ?? definition!.size)} · ${s.reservations.filter((reservation) => reservation.endpoint === building.id).length} delivery/storage reservations`,
          ]
        : [
            s.message,
            "Click a resident or building. Arrow keys pan, +/− zoom.",
            ...(this.assets?.guide ?? []),
          ];
    const signature = JSON.stringify(lines);
    if (signature !== this.inspector) {
      this.inspector = signature;
      this.panel?.render(
        lines,
        building
          ? [
              ...(definition?.recipe
                ? [
                    { id: "staff:1", label: "Request one worker" },
                    { id: "staff:-1", label: "Release one worker" },
                  ]
                : []),
              {
                id: "demolish",
                label: building.complete
                  ? "Demolish building"
                  : "Cancel construction",
              },
            ]
          : [],
        (id) => this.session.command(id),
      );
    }
    this.ghost.clear();
    if (s.placement) {
      const d = this.definition.buildings.find((d) => d.id === s.placement),
        size = d?.size ?? 1,
        position = this.project(
          Math.floor(this.pointer.x) + size / 2,
          Math.floor(this.pointer.y) + size / 2,
        );
      this.ghostSpring.target.x = position.x;
      this.ghostSpring.target.y = position.y;
      this.ghostSpring.update(dt, this.ghost);
      this.ghost.zIndex = position.y + 1;
      this.ghost
        .poly([-size * 16, 0, 0, size * 9, size * 16, 0, 0, -size * 9])
        .fill({ color: 0xf2e3a8, alpha: 0.3 })
        .stroke({ color: 0xfff0b3, width: 2 });
    }
    this.piles.clear();
    for (const pile of s.piles) {
      const pos = this.project(
          pile.cell % this.definition.width,
          Math.floor(pile.cell / this.definition.width),
        ),
        amount = Object.values(pile.inventory).reduce((a, b) => a + b, 0);
      this.piles
        .ellipse(pos.x, pos.y, Math.min(15, 4 + amount), 5)
        .fill(0xc4a36b);
    }
    {
      const seasonChanged = this.season !== season;
      this.season = season;
      this.revision = this.session.navigationRevision;
      for (let cy = 0; cy < Math.ceil(this.definition.height / 8); cy++)
        for (let cx = 0; cx < Math.ceil(this.definition.width / 8); cx++) {
          const id = cy * Math.ceil(this.definition.width / 8) + cx;
          let g = this.chunks.get(id);
          if (!g) {
            g = new Graphics();
            this.chunks.set(id, g);
            this.root.addChild(g);
          }
          const center = this.project(cx * 8 + 4, cy * 8 + 4);
          g.visible = this.visible(center.x, center.y, 300);
          if (
            !seasonChanged &&
            this.chunkRevisions.get(id) === (s.chunkRevisions[id] ?? 0)
          )
            continue;
          this.chunkRevisions.set(id, s.chunkRevisions[id] ?? 0);
          g.clear();
          g.removeChildren().forEach((child) => child.destroy());
          for (
            let y = cy * 8;
            y < Math.min(this.definition.height, cy * 8 + 8);
            y++
          )
            for (
              let x = cx * 8;
              x < Math.min(this.definition.width, cx * 8 + 8);
              x++
            ) {
              const t = s.terrain[y * this.definition.width + x]!,
                p = this.project(x, y),
                color =
                  t === 1
                    ? 0x547d92
                    : t === 4
                      ? 0xab9c7b
                      : season === 3
                        ? 0x8c9b85
                        : season === 2
                          ? 0x9b9461
                          : 0x7b986a;
              g.poly([
                p.x,
                p.y,
                p.x + 16,
                p.y + 9,
                p.x,
                p.y + 18,
                p.x - 16,
                p.y + 9,
              ])
                .fill(color)
                .stroke({
                  width: 0.4,
                  color: t === 1 ? 0x83b0be : 0x76916b,
                  alpha: 0.45,
                });
              if (
                season === 3 &&
                t !== 1 &&
                t !== 4 &&
                !s.buildings.some((b) => {
                  const d = this.definition.buildings.find(
                    (d) => d.id === b.type,
                  )!;
                  return (
                    x >= b.x && x < b.x + d.size && y >= b.y && y < b.y + d.size
                  );
                })
              )
                g.poly([
                  p.x,
                  p.y,
                  p.x + 16,
                  p.y + 9,
                  p.x,
                  p.y + 18,
                  p.x - 16,
                  p.y + 9,
                ]).fill({ color: 0xe7f0ed, alpha: 0.7 });
              if ((t === 2 || t === 3) && this.assets?.terrain?.[t]) {
                const key = this.assets.terrain[t];
                const decoration = new Sprite(this.atlas.texture(key));
                const frame = this.atlas.manifest?.frames[key];
                if (frame?.pivot && frame.trim)
                  decoration.anchor.set(
                    (frame.pivot.x - frame.trim.x) / frame.width,
                    (frame.pivot.y - frame.trim.y) / frame.height,
                  );
                decoration.position.set(p.x, p.y);
                decoration.scale.set(this.assets.displayScale ?? 1);
                g.addChild(decoration);
              } else if (t === 2) {
                g.ellipse(p.x + 3, p.y + 6, 9, 4).fill({
                  color: 0,
                  alpha: 0.18,
                });
                g.poly([
                  p.x,
                  p.y - 27,
                  p.x + 10,
                  p.y + 4,
                  p.x - 10,
                  p.y + 4,
                ]).fill(
                  season === 2 ? 0xaa7548 : season === 3 ? 0x7a8e83 : 0x3c6951,
                );
              }
              if (t === 3 && !this.assets?.terrain?.[t])
                g.poly([
                  p.x - 8,
                  p.y + 3,
                  p.x - 3,
                  p.y - 9,
                  p.x + 5,
                  p.y - 6,
                  p.x + 9,
                  p.y + 5,
                ]).fill(0x9ca59f);
            }
          g.cacheAsTexture(true);
          g.updateCacheTexture();
        }
    }
    const seen = new Set<string>();
    for (const b of s.buildings) {
      seen.add(b.id);
      const d = this.definition.buildings.find((d) => d.id === b.type)!,
        p = this.project(b.x + d.size / 2, b.y + d.size / 2);
      let g = this.buildings.get(b.id);
      if (!g) {
        g = new Graphics();
        this.buildings.set(b.id, g);
        this.stage!.layers.actors.addChild(g);
      }
      const signature = JSON.stringify([
        b.complete,
        Math.floor(b.work * 10),
        b.assigned,
        s.selected === b.id,
        season,
      ]);
      if (this.buildingSignatures.get(b.id) !== signature) {
        this.buildingSignatures.set(b.id, signature);
        g.clear();
        g.position.set(p.x, p.y);
        g.zIndex = p.y;
        const w = d.size * 14,
          h = d.size * 15;
        g.ellipse(5, 9, w + 8, 12).fill({ color: 0, alpha: 0.22 });
        const progress = b.complete
          ? 1
          : Math.min(0.95, 0.2 + (b.work / 12) * 0.8);
        g.poly([-w, 0, 0, 12, w, 0, 0, -12]).fill(0x716c59);
        g.rect(-w, -h * progress, w * 2, h * progress)
          .fill(d.color)
          .stroke({ color: 0xe0c99e, width: 1 });
        g.poly([
          -w - 4,
          -h * progress,
          0,
          -h * progress - 17,
          w + 4,
          -h * progress,
          0,
          -h * progress + 9,
        ]).fill(season === 3 ? 0xe9eeea : 0x755b55);
        g.rect(-4, -14, 8, 14).fill(0x4b443d);
        if (!b.complete) {
          g.moveTo(-w, -h)
            .lineTo(w, 0)
            .moveTo(w, -h)
            .lineTo(-w, 0)
            .stroke({ color: 0xdcb784, width: 2 });
        }
        if (s.selected === b.id)
          g.ellipse(0, 8, w + 7, 14).stroke({ color: 0xffeb92, width: 3 });
        let label = this.labels.get(b.id);
        if (!label) {
          label = new Text({
            text: "",
            style: { fontFamily: "sans-serif", fontSize: 10, fill: 0xfff4d2 },
          });
          this.labels.set(b.id, label);
          this.stage!.layers.actors.addChild(label);
        }
        label.text = `${d.name}${b.complete ? (b.assigned ? ` · ${b.assigned} jobs` : "") : " · building"}`;
        label.position.set(p.x - w, p.y - h - 29);
        label.zIndex = p.y + 0.1;
        if (this.assets) {
          const layers = this.assets.buildingArt?.[b.type];
          const key = layers
            ? !b.complete
              ? layers.construction
              : season === 3
                ? layers.snow
                : layers.final
            : this.assets.buildings[b.type];
          if (key) {
            const texture = this.atlas.texture(key);
            if (texture.width > 1) {
              let sprite = this.textures.get(b.id);
              if (!sprite) {
                sprite = new Sprite();
                this.textures.set(b.id, sprite);
                this.stage!.layers.actors.addChild(sprite);
              }
              sprite.texture = texture;
              const frame = this.atlas.manifest?.frames[key];
              if (layers && frame?.pivot && frame.trim) {
                sprite.anchor.set(
                  (frame.pivot.x - frame.trim.x) / frame.width,
                  (frame.pivot.y - frame.trim.y) / frame.height,
                );
                sprite.position.set(p.x, p.y);
              } else {
                sprite.anchor.set(0.5, 1);
                sprite.position.set(p.x, p.y + 10);
              }
              // Preserve the authored perspective instead of stretching each axis.
              sprite.scale.set(
                layers
                  ? (this.assets.displayScale ?? 1)
                  : (w * 2.8) / texture.width,
              );
              sprite.zIndex = p.y - 0.1;
              sprite.alpha = layers ? 1 : b.complete ? 1 : 0.35 + b.work / 20;
              sprite.visible = this.visible(p.x, p.y);
              g.visible = sprite.visible;
              label.visible = sprite.visible && this.zoom > 0.85;
              label.y =
                sprite.y -
                (frame?.pivot
                  ? frame.pivot.y - (frame.trim?.y ?? 0)
                  : texture.height) *
                  sprite.scale.y -
                14;
              if (this.assets.snowMaskUrl) {
                let snow = this.roofSnow.get(b.id),
                  mask = this.roofMasks.get(b.id);
                if (!snow) {
                  snow = new Sprite(this.snowAtlas.texture(key));
                  snow.anchor.set(0.5, 1);
                  mask = new Graphics();
                  snow.mask = mask;
                  this.roofSnow.set(b.id, snow);
                  this.roofMasks.set(b.id, mask);
                  this.stage!.layers.actors.addChild(snow, mask);
                }
                snow.position.copyFrom(sprite.position);
                snow.width = sprite.width;
                snow.height = sprite.height;
                snow.zIndex = sprite.zIndex + 0.02;
                snow.alpha = season === 3 && b.complete ? 0.75 : 0;
                snow.visible = sprite.visible && season === 3;
                mask!
                  .clear()
                  .rect(
                    sprite.x - sprite.width / 2,
                    sprite.y - sprite.height,
                    sprite.width,
                    sprite.height * 0.45,
                  )
                  .fill(0xffffff);
              }
              // Textured buildings replace the proxy body, retaining only interaction cues.
              g.clear();
              g.alpha = 1;
              if (layers) {
                const door = this.project(
                  b.x + (d.doorOffset?.x ?? 0) + 0.5,
                  b.y + (d.doorOffset?.y ?? d.size) + 0.5,
                );
                g.circle(door.x - p.x, door.y - p.y, 2.5).fill(0xf6d88e);
                if (!b.complete) {
                  g.rect(-w, 7, w * 2, 4).fill(0x3a433a);
                  g.rect(-w, 7, w * 2 * Math.min(1, b.work / 12), 4).fill(
                    0xe4cb8a,
                  );
                }
              }
              if (!b.complete && !layers)
                g.moveTo(-w, -h)
                  .lineTo(w, 0)
                  .moveTo(w, -h)
                  .lineTo(-w, 0)
                  .stroke({ color: 0xdcb784, width: 2, alpha: 0.65 });
              if (s.selected === b.id)
                g.ellipse(0, 8, w + 7, 14).stroke({
                  color: 0xffeb92,
                  width: 3,
                });
            }
          }
        }
      }
      const visible = this.visible(p.x, p.y);
      g.visible = visible;
      const sprite = this.textures.get(b.id);
      if (sprite) sprite.visible = visible;
      const label = this.labels.get(b.id);
      if (label) label.visible = visible && this.zoom > 0.85;
    }
    for (const b of s.buildings) {
      if (!this.assets?.crops || b.type !== "farm") continue;
      let crop = this.cropSprites.get(b.id);
      if (!crop) {
        crop = new Sprite();
        this.cropSprites.set(b.id, crop);
        this.stage!.layers.actors.addChild(crop);
      }
      const key =
        season === 2 ? this.assets.crops.grown : this.assets.crops.young;
      const frame = this.atlas.manifest?.frames[key];
      crop.texture = this.atlas.texture(key);
      if (frame?.pivot && frame.trim)
        crop.anchor.set(
          (frame.pivot.x - frame.trim.x) / frame.width,
          (frame.pivot.y - frame.trim.y) / frame.height,
        );
      const pos = this.project(b.x + 2, b.y + 2);
      crop.position.set(pos.x, pos.y);
      crop.scale.set(this.assets.displayScale ?? 1);
      crop.zIndex = pos.y;
      crop.visible = b.complete && season !== 3 && this.visible(pos.x, pos.y);
    }
    for (const [id, crop] of this.cropSprites)
      if (!s.buildings.some((b) => b.id === id)) {
        crop.destroy();
        this.cropSprites.delete(id);
      }
    for (const [id, g] of this.buildings)
      if (!seen.has(id)) {
        g.destroy();
        this.buildings.delete(id);
        this.buildingSignatures.delete(id);
        this.textures.get(id)?.destroy();
        this.textures.delete(id);
        this.roofSnow.get(id)?.destroy();
        this.roofSnow.delete(id);
        this.roofMasks.get(id)?.destroy();
        this.roofMasks.delete(id);
        this.labels.get(id)?.destroy();
        this.labels.delete(id);
      }
    const people = new Set(s.people.map((p) => p.id));
    for (const p of s.people) {
      let g = this.actors.get(p.id);
      if (!g) {
        g = new Graphics();
        this.actors.set(p.id, g);
        this.stage!.layers.actors.addChild(g);
      }
      const pos = this.project(p.x, p.y),
        walking = p.queue[0]?.kind === "move",
        bob = walking ? Math.sin(s.time * 14 + p.x) * 1.5 : 0;
      g.position.set(pos.x, pos.y);
      g.zIndex = pos.y;
      g.visible = this.visible(pos.x, pos.y);
      g.clear()
        .ellipse(0, 1, 5, 2)
        .fill({ color: 0, alpha: 0.25 })
        .rect(-3, -12 + bob, 6, 11)
        .fill(
          p.cold > 30 ? 0x91c9df : p.job === "laborer" ? 0xd0ad78 : 0xa2634f,
        )
        .circle(0, -15 + bob, 3)
        .fill(0xf0d4a9);
      if (Object.values(p.cargo).some((n) => n > 0))
        g.rect(2, -11, 5, 6).fill(0xc9af78);
      if (this.actorsReady) {
        let clip = this.clips.get(p.id);
        if (!clip) {
          clip = new ClipPlayer();
          this.clips.set(p.id, clip);
          this.stage!.layers.actors.addChild(clip.sprite);
        }
        const moving = p.queue[0]?.kind === "move" ? p.queue[0] : undefined;
        const next = moving?.path?.[0];
        const angle =
          next === undefined
            ? 0
            : Math.atan2(
                Math.floor(next / this.definition.width) + 0.5 - p.y,
                (next % this.definition.width) + 0.5 - p.x,
              );
        const direction = (Math.round(angle / (Math.PI / 4)) + 8) % 8;
        const mode = settlementCitizenVisual(p).mode;
        const animation = this.actorAtlas.clip(`${mode}:${direction}`);
        const duration =
          animation.frames.reduce(
            (sum, frame) => sum + (frame.duration ?? 1),
            0,
          ) || 1;
        clip.sample(
          animation,
          ((p.work?.elapsed ?? s.time) % duration) / duration,
          `${p.id}:${mode}`,
        );
        clip.sprite.position.set(pos.x, pos.y);
        clip.sprite.zIndex = pos.y - 0.1;
        clip.sprite.scale.set(this.assets?.actorScale ?? 0.29);
        clip.sprite.visible = g.visible;
        if (this.zoom < 0.85 && p.queue[0]?.kind !== "move")
          clip.sprite.alpha = 0.85;
        else clip.sprite.alpha = 1;
        g.clear();
        g.alpha = 1;
        // Retain the cargo cue without drawing the geometric person over the sprite.
        if (Object.values(p.cargo).some((n) => n > 0))
          g.roundRect(4, -15, 7, 7, 1).fill(0xc9af78);
      }
      if (this.assets?.cargo) {
        let cargo = this.cargoSprites.get(p.id);
        if (!cargo) {
          cargo = new Sprite(this.atlas.texture(this.assets.cargo));
          cargo.anchor.set(0.5, 1);
          this.cargoSprites.set(p.id, cargo);
          this.stage!.layers.actors.addChild(cargo);
        }
        cargo.position.set(pos.x + 6, pos.y - 7);
        cargo.width = 12;
        cargo.height = 12;
        cargo.zIndex = pos.y + 0.01;
        cargo.visible = g.visible && settlementCitizenVisual(p).loaded;
        if (cargo.visible) g.clear();
      }
      if (s.selected === p.id)
        g.circle(0, -8, 12).stroke({ color: 0xffeb92, width: 1 });
    }
    for (const [id, g] of this.actors)
      if (!people.has(id)) {
        g.destroy();
        this.actors.delete(id);
        this.clips.get(id)?.sprite.destroy();
        this.clips.delete(id);
        this.cargoSprites.get(id)?.destroy();
        this.cargoSprites.delete(id);
      }
    const snow = this.snow;
    snow.clear();
    if (season === 3)
      for (let i = 0; i < 85; i++) {
        const x = (i * 173 + s.time * 13) % 1280,
          y = (i * 97 + s.time * 25) % 720;
        snow.circle(x, y, 1.3).fill({ color: 0xf3fbff, alpha: 0.7 });
      }
    const copy = this.assets?.hud;
    const resources = (copy?.resources ?? []).map(
      ({ id, label }) => `${label} ${this.session.available(id)}`,
    );
    this.hud.text = `${copy?.seasons[season] ?? `Season ${season + 1}`}  ${Math.floor(s.time / 60)}:${String(Math.floor(s.time % 60)).padStart(2, "0")}   ${s.speed === 0 ? (copy?.paused ?? "Paused") : `${s.speed}×`}\n${s.people.length} ${copy?.residents ?? "people"}${resources.length ? `   ${resources.join("   ")}` : ""}`;
  }
  snapshot() {
    return {
      queue: this.queue.snapshot(),
      notice: this.notice,
      panX: this.panX,
      panY: this.panY,
      zoom: this.zoom,
      weatherTime: this.weatherTime,
      ghostSpring: this.ghostSpring.snapshot(),
      noticeSpring: this.noticeSpring.snapshot(),
    };
  }
  restore(value: ReturnType<SettlementPresenter["snapshot"]>) {
    // Validate detached data before touching the presenter, camera or transient effects.
    value = structuredClone(value);
    const finite = (n: unknown): n is number =>
      typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e9;
    const spring = (s: ReturnType<SpringTransform["snapshot"]>) =>
      s &&
      [
        s.x,
        s.y,
        s.rotation,
        s.scale,
        s.pulse,
        s.target?.x,
        s.target?.y,
        s.target?.rotation,
        s.target?.scale,
        s.velocity?.x,
        s.velocity?.y,
        s.velocity?.rotation,
        s.velocity?.scale,
      ].every(finite);
    if (
      !value ||
      typeof value.notice !== "string" ||
      value.notice.length > 16384 ||
      !finite(value.panX) ||
      !finite(value.panY) ||
      !finite(value.zoom) ||
      value.zoom < 0.1 ||
      value.zoom > 4 ||
      !finite(value.weatherTime) ||
      value.weatherTime < 0 ||
      !spring(value.ghostSpring) ||
      !spring(value.noticeSpring)
    )
      throw new Error("Invalid settlement presentation checkpoint");
    value.queue = validatePresentationQueueSnapshot(value.queue);
    this.particles.reset();
    this.weatherBudget = 0;
    this.notice = value.notice;
    this.panX = value.panX;
    this.panY = value.panY;
    this.zoom = value.zoom;
    this.weatherTime = value.weatherTime;
    this.ghostSpring.restore(value.ghostSpring);
    this.noticeSpring.restore(value.noticeSpring);
    this.queue.restore(
      value.queue,
      value.queue.pending.map((p) => ({
        id: p.id,
        lane: "notices",
        duration: 0.3,
        run: () => this.noticeSpring.juice(0.04),
      })),
    );
    this.stage?.camera.pan(this.panX, this.panY);
    if (this.stage) this.stage.camera.zoom = this.zoom;
  }
  dispose() {
    this.queue.dispose();
    this.particles.dispose();
    this.ghost.destroy();
    this.piles.destroy();
    this.panel?.dispose();
    this.panelHost?.remove();
    for (const sprite of this.cropSprites.values()) sprite.destroy();
    for (const sprite of this.cargoSprites.values()) sprite.destroy();
    this.snowAtlas.dispose();
    for (const s of this.roofSnow.values()) s.destroy();
    for (const m of this.roofMasks.values()) m.destroy();
    this.atlas.dispose();
    this.actorAtlas.dispose();
    for (const c of this.clips.values()) c.sprite.destroy();
    for (const t of this.textures.values()) t.destroy();
    this.root.destroy({ children: true });
    this.snow.destroy();
    this.hud.destroy();
    for (const g of this.actors.values()) g.destroy();
    for (const g of this.buildings.values()) g.destroy();
    for (const g of this.labels.values()) g.destroy();
  }
}
