import {
  Assets,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  Texture,
} from "pixi.js";
import type { PixiPresenter, PixiStage } from "./index";
import { GroundPlaneMesh } from "./ground-plane";
import {
  projectBillboards,
  type GroundBillboard,
  type GroundCamera,
} from "../presentation/ground-plane";
export interface KartRaceView {
  camera: GroundCamera;
  time: number;
  hud: {
    phase: string;
    countdown: number;
    notice: string;
    noticeTime: number;
    place: number;
    lap: number;
    speed: number;
    time: number;
    inventory?: string | null;
    incoming: boolean;
  };
  karts: readonly {
    id: string;
    x: number;
    y: number;
    z: number;
    heading: number;
    profile: number;
    immune: number;
    boost: number;
    drift: number;
    charge: number;
  }[];
  objects: readonly GroundBillboard[];
}
/** Native retained racing presentation. Projection consumes observations only. */
export class KartRacePresenter implements PixiPresenter {
  private root = new Container();
  private sky = new Graphics();
  private vehicles = new Container();
  private hud = new Container();
  private panels = new Graphics();
  private status = new Text({
    text: "",
    style: {
      fontFamily: "system-ui",
      fontSize: 10,
      fill: 0xffe4a6,
      fontWeight: "bold",
    },
  });
  private prompt = new Text({
    text: "",
    style: {
      fontFamily: "system-ui",
      fontSize: 9,
      fill: 0xffe4a6,
      align: "center",
      wordWrap: true,
      wordWrapWidth: 270,
    },
  });
  private plane?: GroundPlaneMesh;
  private frames: Texture[][] = [];
  private propFrames: Texture[] = [];
  private sprites = new Map<string, Sprite>();
  private decorations = new Map<string, Graphics>();
  private disposed = false;
  constructor(
    private read: () => KartRaceView,
    private track: HTMLCanvasElement,
    private artworkUrl: string,
    private width = 400,
    private height = 225,
    private horizon = 73,
  ) {}
  async init(stage: PixiStage) {
    this.root.addChild(this.sky);
    const texture = Texture.from(this.track);
    texture.source.scaleMode = "nearest";
    this.plane = new GroundPlaneMesh(
      texture,
      this.width,
      this.height,
      this.horizon,
      4000,
      4000,
    );
    this.root.addChild(this.plane.mesh, this.vehicles);
    stage.layers.ground.addChild(this.root);
    this.hud.addChild(this.panels, this.status, this.prompt);
    stage.layers.hud.addChild(this.hud);
    this.status.position.set(12, 10);
    this.prompt.anchor.set(0.5);
    this.prompt.position.set(200, 105);
    const sheet = await Assets.load<Texture>(this.artworkUrl);
    if (this.disposed) return;
    for (let profile = 0; profile < 6; profile++) {
      this.frames[profile] = [];
      for (let frame = 0; frame < 32; frame++)
        this.frames[profile]!.push(
          new Texture({
            source: sheet.source,
            frame: new Rectangle(frame * 96, profile * 96, 96, 96),
          }),
        );
    }
    this.propFrames = [0, 1].map(
      (index) =>
        new Texture({
          source: sheet.source,
          frame: new Rectangle(index * 96, 576, 96, 96),
        }),
    );
    this.render(0);
  }
  resize(_width: number, _height: number) {}
  render(_dt: number) {
    if (this.disposed || !this.plane) return;
    const state = this.read(),
      cam = state.camera;
    this.plane.update(cam);
    const h = state.hud;
    this.panels
      .clear()
      .roundRect(7, 7, 386, 33, 4)
      .fill({ color: 0x211e39, alpha: 0.88 });
    this.status.text = `${h.place} / 6    LAP ${Math.min(3, h.lap + 1)} / 3    ${Math.round(h.speed)} km/h    ${Math.floor(h.time / 60)}:${(h.time % 60).toFixed(1).padStart(4, "0")}\n${h.incoming ? "INCOMING LANTERN · " : ""}${h.inventory ? "E · " + h.inventory.toUpperCase() : "Collect a floating item box"}`;
    this.prompt.text =
      h.phase === "grid"
        ? `LANTERN RALLY\n${Math.min(3, Math.max(1, Math.ceil(h.countdown)))}\n1 Copper · 2 Jade · 3 Violet`
        : h.phase === "finish"
          ? `DELIVERIES COMPLETE\nFinished ${h.place} of 6\nEnter / Item to race again`
          : h.noticeTime > 0
            ? h.notice
            : "";
    if (this.prompt.text)
      this.panels
        .roundRect(55, 76, 290, 58, 5)
        .fill({ color: 0x211e39, alpha: 0.9 });
    this.sky
      .clear()
      .rect(0, 0, this.width, this.horizon)
      .fill(0x292847)
      .circle(316, 25, 12)
      .fill(0xf9d99d);
    for (let layer = 0; layer < 2; layer++)
      for (let i = -1; i < 16; i++) {
        const x = i * 34 - ((cam.heading * (layer ? 35 : 13)) % 34);
        this.sky
          .poly([
            x,
            this.horizon,
            x + 17,
            this.horizon - 13 - ((i * i) % 17) - layer * 3,
            x + 38,
            this.horizon,
          ])
          .fill(layer ? 0x51445e : 0x343858);
      }
    this.vehicles.sortableChildren = true;
    for (const sprite of this.sprites.values()) sprite.visible = false;
    for (const graphic of this.decorations.values()) graphic.visible = false;
    const objects = state.objects;
    const activeIds = new Set(objects.map((object) => object.id));
    for (const [id, graphic] of this.decorations)
      if (!activeIds.has(id)) {
        graphic.destroy();
        this.decorations.delete(id);
      }
    for (const b of projectBillboards(
      objects,
      cam,
      this.width,
      this.height,
      32,
    )) {
      const x = b.x,
        y = b.y,
        w = b.width,
        h = b.height;
      let g = this.decorations.get(b.id);
      if (!g) {
        g = new Graphics();
        this.decorations.set(b.id, g);
        this.vehicles.addChild(g);
      }
      g.visible = true;
      g.zIndex = -b.depth - 0.01;
      g.clear();
      if (b.id.startsWith("kart")) {
        const k = state.karts.find((k) => k.id === b.id)!;
        const frame =
          this.frames[k.profile * 2 + (k.boost > 0 ? 1 : 0)]?.[b.frame];
        if (!frame) continue;
        let sprite = this.sprites.get(k.id);
        if (!sprite) {
          sprite = new Sprite(frame);
          this.vehicles.addChild(sprite);
          this.sprites.set(k.id, sprite);
        }
        sprite.texture = frame;
        sprite.visible = true;
        sprite.position.set(x - w / 2, y - h * (58.36137669674322 / 96));
        sprite.width = w;
        sprite.height = h;
        sprite.zIndex = -b.depth;
        sprite.alpha =
          k.immune > 0 && Math.floor(state.time * 14) % 2 === 0 ? 0.45 : 1;
        g.ellipse(x, y + 1, w * 0.35, h * 0.08).fill({
          color: 0x30263b,
          alpha: 0.5,
        });
        if (k.boost > 0)
          g.poly([
            x - w * 0.22,
            y - h * 0.13,
            x,
            y + h * 0.3,
            x + w * 0.22,
            y - h * 0.13,
          ]).fill(0x8de9ff);
      } else if (b.id.startsWith("oil"))
        g.ellipse(x, y, w / 2, Math.max(1, h / 2)).fill(0x281f43);
      else if (b.id.startsWith("box"))
        g.roundRect(x - w / 2, y - h, w, h, Math.min(2, w / 4))
          .fill(0xf9cf76)
          .stroke({ color: 0xffefb8, width: 1 });
      else if (b.id.startsWith("prop")) {
        const index = Number(b.id.slice(5));
        const frame = this.propFrames[index % 7 === 0 ? 1 : 0];
        if (!frame) continue;
        let sprite = this.sprites.get(b.id);
        if (!sprite) {
          sprite = new Sprite(frame);
          this.sprites.set(b.id, sprite);
          this.vehicles.addChild(sprite);
        }
        sprite.visible = true;
        sprite.texture = frame;
        sprite.width = h * 1.5;
        sprite.height = h * 1.5;
        sprite.position.set(x - sprite.width / 2, y - sprite.height * (58.36137669674322 / 96));
        sprite.zIndex = -b.depth;
      } else
        g.circle(x, y - h / 2, Math.max(2, w / 2)).fill(
          b.id.startsWith("lantern") ? 0xffcf80 : 0xef7775,
        );
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.hud.removeFromParent();
    this.hud.destroy({ children: true });
    this.root.removeFromParent();
    this.plane?.dispose();
    this.root.destroy({ children: true });
    for (const frames of this.frames)
      for (const frame of frames) frame.destroy();
    this.sprites.clear();
    this.decorations.clear();
    this.frames = [];
    for (const frame of this.propFrames) frame.destroy();
    this.propFrames = [];
  }
}
