import type { DefenseObservation } from "@onepage/game-simulation/defense-session";
import { AtlasLoader, ClipPlayer, Container, Graphics, Sprite, Text, type PixiPresenter, type PixiStage } from "./index";
import { PixelSceneHud, type PixelSceneHudState } from "./pixel-scene-hud";
import { sideViewLayout } from "./side-view-layout";

export interface DefenseSceneDefinition {
  viewport: { width: number; height: number; maxScale?: number };
  title: string;
  houses: readonly string[];
  terrain: { floor: string; wall: string };
  hero: { scale: number; idle: string; hold: string; release: string };
  enemies: Record<string, { scale: number; run: string; attack: string; tint?: number }>;
  controls: PixelSceneHudState["controls"];
}
export interface DefensePresenterOptions {
  scene: DefenseSceneDefinition;
  observe: () => DefenseObservation;
  atlasUrl: string;
  fontUrl?: string;
  status?: () => string | undefined;
  onAction?: (action: string) => void;
  isInteractive?: () => boolean;
}
/** Retained terraced defense scene. All combat, draw and trajectory state belongs
 * to the simulation; visual clocks derive exclusively from its observation. */
export class DefensePresenter implements PixiPresenter {
  private atlas = new AtlasLoader();
  private stage?: PixiStage;
  private backdrop = new Graphics();
  private mask = new Graphics();
  private world = new Container();
  private scenery = new Container();
  private actors = new Container();
  private cues = new Graphics();
  private hero = new ClipPlayer();
  private bow = new Sprite();
  private hud = new PixelSceneHud(this.atlas, action => this.options.onAction?.(action), () => this.interactive && (this.options.isInteractive?.() ?? true));
  private buildings: { sprite: Sprite; label: Text }[] = [];
  private enemies = new Map<string, ClipPlayer>();
  private flames = new Map<number, ClipPlayer>();
  private previousHp = new Map<string, number>();
  private impacts: { x: number; y: number; at: number }[] = [];
  private arrows = new Map<string, Graphics>();
  private ready = false;
  private disposed = false;
  private interactive = false;
  private scale = 1;
  private offset = { x: 0, y: 0 };
  private oldImageRendering = "";
  private lastTick = -1;
  private wasCharging = false;
  private releasedAt = -100;
  constructor(private options: DefensePresenterOptions) {}
  async init(stage: PixiStage) {
    this.stage = stage;
    this.oldImageRendering = stage.canvas.style.imageRendering;
    stage.app.stage.addChildAt(this.backdrop, 0);
    this.world.addChild(this.scenery, this.actors, this.hero.sprite, this.bow, this.cues);
    stage.layers.ground.addChild(this.world, this.mask);
    this.world.mask = this.mask;
    stage.layers.hud.addChild(this.hud.root);
    this.hud.update({ title: "Opening the town gates…" });
    this.resize(stage.width, stage.height);
    try {
      await this.atlas.loadUrl(this.options.atlasUrl);
      if (this.disposed) return;
      this.hud.load(this.options.fontUrl);
      this.build();
      this.ready = true;
      this.render(0);
    } catch (error) {
      if (!this.disposed) this.hud.update({ title: "Town artwork could not load", status: "Reload the scene to retry." });
      throw error;
    }
  }
  resize(width: number, height: number) {
    const layout = sideViewLayout(width, height, this.options.scene.viewport);
    this.scale = layout.scale;
    this.offset = layout.offset;
    this.world.position.set(this.offset.x, this.offset.y);
    this.world.scale.set(this.scale);
    this.mask.clear().rect(this.offset.x, this.offset.y, this.options.scene.viewport.width * this.scale, this.options.scene.viewport.height * this.scale).fill(0xffffff);
    this.hud.resize(width, height);
    this.backdrop.clear().rect(0, 0, width, height).fill(0x111c2a);
    if (this.stage) {
      this.stage.canvas.style.imageRendering = "pixelated";
      this.stage.camera.pan(0, 0);
      this.stage.camera.zoom = 1;
    }
  }
  inverse(x: number, y: number) {
    return { x: (x - this.offset.x) / this.scale, y: (y - this.offset.y) / this.scale };
  }
  private sprite(frame: string) {
    const m = this.atlas.manifest?.frames[frame];
    if (!m) throw Error(`Missing defense frame ${frame}`);
    const sprite = new Sprite(this.atlas.texture(frame));
    sprite.pivot.set((m.pivot?.x ?? 0) - (m.trim?.x ?? 0), (m.pivot?.y ?? 0) - (m.trim?.y ?? 0));
    return sprite;
  }
  private build() {
    const state = this.options.observe(), scene = this.options.scene;
    const sky = new Graphics().rect(0, 0, 480, 270).fill(0x33475b);
    sky.rect(0, 55, 480, 100).fill(0x6c727a).circle(393, 37, 19).fill(0xe9c79f);
    sky.poly([0, 80, 65, 43, 133, 82, 205, 54, 290, 99, 387, 63, 480, 92, 480, 270, 0, 270]).fill(0x3e6268);
    this.scenery.addChild(sky);
    for (let i = 0; i < state.lanes.length; i++) {
      const y = state.lanes[i]!;
      const terrace = new Graphics().rect(0, y + 1, 480, 49).fill(i % 2 ? 0x34535b : 0x416069);
      terrace.rect(0, y - 2, 480, 5).fill(0xa99b80).rect(126, y - 5, 354, 4).fill(0xc5af8a);
      this.scenery.addChild(terrace);
      for (let x = 128; x < 480; x += 32) {
        const floor = this.sprite(scene.terrain.floor);
        floor.position.set(x, y); floor.width = 32; floor.height = 12; floor.tint = 0xb2b2a1;
        this.scenery.addChild(floor);
      }
      const house = this.sprite(scene.houses[i]!);
      house.anchor.set(0.5, 1); house.pivot.set(0, 0);
      house.scale.set(Math.min(62 / house.texture.width, 51 / house.texture.height));
      house.position.set(94, y - 2);
      const label = new Text({ text: "", style: { fontFamily: "monospace", fontSize: 7, fill: 0xffe4b4 } });
      label.position.set(68, y + 12);
      this.scenery.addChild(house, label);
      this.buildings.push({ sprite: house, label });
    }
    const tower = new Graphics().rect(22, 200, 43, 52).fill(0x47626c).rect(19, 199, 49, 7).fill(0xc0b59d);
    for (let x = 22; x < 65; x += 14) tower.rect(x, 193, 7, 8).fill(0xc0b59d);
    this.scenery.addChild(tower);
  }
  private sample(player: ClipPlayer, id: string, phase: number, x: number, y: number, scale: number, mirror = false) {
    const clip = this.atlas.clip(id);
    if (!clip.frames.length) throw Error(`Missing defense clip ${id}`);
    player.sprite.scale.set(scale);
    player.sample(clip, phase, id, mirror);
    player.sprite.position.set(x, y);
  }
  render(dt: number) {
    if (!this.ready || this.disposed) return;
    this.interactive = dt > 0;
    const s = this.options.observe(), scene = this.options.scene, time = s.tick / 60;
    if (s.tick < this.lastTick) { this.wasCharging = false; this.releasedAt = -100; this.previousHp.clear(); this.impacts = []; }
    if (this.wasCharging && !s.charging && s.tick > this.lastTick) this.releasedAt = time;
    this.lastTick = s.tick; this.wasCharging = s.charging;
    const releasing = time - this.releasedAt < 0.25;
    const bowFrame = `bow.draw.${s.charging ? Math.min(8, Math.floor(s.charge * 9)) : releasing ? Math.max(0, 8 - Math.floor((time - this.releasedAt) * 36)) : 0}`;
    const bm = this.atlas.manifest?.frames[bowFrame];
    if (bm) { this.bow.texture = this.atlas.texture(bowFrame); this.bow.pivot.set((bm.pivot?.x ?? 14) - (bm.trim?.x ?? 0), (bm.pivot?.y ?? 19) - (bm.trim?.y ?? 0)); this.bow.scale.set(scene.hero.scale); this.bow.position.set(s.origin.x, s.origin.y); this.bow.rotation = s.angle + Math.PI / 2; }
    this.sample(this.hero, s.charging ? scene.hero.hold : releasing ? scene.hero.release : scene.hero.idle,
      s.charging ? Math.min(0.999, s.charge) : releasing ? (time - this.releasedAt) / 0.25 : time % 1, s.origin.x - 2, s.origin.y, scene.hero.scale);
    const seen = new Set<string>();
    for (const enemy of s.enemies) {
      seen.add(enemy.id);
      let visual = this.enemies.get(enemy.id);
      if (!visual) { visual = new ClipPlayer(); this.enemies.set(enemy.id, visual); this.actors.addChild(visual.sprite); }
      const role = scene.enemies[String(enemy.kind)] ?? Object.values(scene.enemies)[0]!;
      this.sample(visual, enemy.attack > 0 ? role.attack : role.run, enemy.attack > 0 ? Math.max(0, Math.min(0.999, 1 - enemy.attack / (s.enemyKinds[enemy.kind]?.attackCadence ?? 1))) : (time * 1.4 + enemy.lane * 0.17) % 1, enemy.x, enemy.y, role.scale, true);
      visual.sprite.tint = role.tint ?? 0xffffff;
      const previous = this.previousHp.get(enemy.id);
      if (previous !== undefined && enemy.hp < previous) this.impacts.push({ x: enemy.x, y: enemy.y - 16, at: time });
      this.previousHp.set(enemy.id, enemy.hp);
    }
    for (const [id, visual] of this.enemies) if (!seen.has(id)) { this.impacts.push({ x: visual.sprite.x, y: visual.sprite.y - 15, at: time }); visual.sprite.destroy(); this.enemies.delete(id); this.previousHp.delete(id); }
    this.cues.clear();
    this.impacts = this.impacts.filter(impact => time - impact.at < 0.28);
    for (const impact of this.impacts) {
      const phase = (time - impact.at) / 0.28;
      this.cues.circle(impact.x, impact.y, 3 + phase * 9).stroke({ color: 0xffe2b1, width: 1, alpha: 1 - phase });
    }
    for (const enemy of s.enemies) {
      const maxHp = s.enemyKinds[enemy.kind]?.hp ?? enemy.hp;
      this.cues.rect(enemy.x - 9, enemy.y - 35, 18, 2).fill(0x182d35).rect(enemy.x - 9, enemy.y - 35, 18 * Math.max(0, enemy.hp / maxHp), 2).fill(0xe6c28f);
    }
    s.buildings.forEach((building, i) => {
      const y = s.lanes[i]!, visual = this.buildings[i]!;
      visual.sprite.tint = building.hp > 0 ? 0xffffff : 0x45555a;
      visual.sprite.alpha = building.hp > 0 ? 1 : 0.35;
      let flame = this.flames.get(i);
      if (building.hp < building.maxHp * 0.4 && building.hp > 0) {
        if (!flame) { flame = new ClipPlayer(); this.flames.set(i, flame); this.actors.addChild(flame.sprite); }
        this.sample(flame, "effect.flame", (time * 1.5 + i * 0.2) % 1, 103, y - 12, 0.6);
        flame.sprite.visible = true;
      } else if (flame) flame.sprite.visible = false;
      const oldHp = this.previousHp.get(`building:${i}`);
      if (oldHp !== undefined && oldHp > building.hp) this.impacts.push({ x: 114, y: y - 18, at: time });
      this.previousHp.set(`building:${i}`, building.hp);
      visual.label.text = `${building.id.toUpperCase()} ${Math.ceil(building.hp)}`;
      this.cues.rect(69, y + 7, 51, 3).fill(0x172c36).rect(69, y + 7, 51 * Math.max(0, building.hp / building.maxHp), 3).fill(building.hp > 35 ? 0x9ac7ad : 0xe9a47c);
      if (s.selected === i) this.cues.rect(65, y - 49, 60, 62).stroke({ color: 0xf6d99c, width: 1 });
    });
    const ox = s.origin.x, oy = s.origin.y, power = Math.max(0.15, s.charge);
    if (s.outcome === "playing" && s.phase === "defense") {
      for (let n = 1; n < 16; n++) {
        const t = n * 0.065, speed = s.speedBase + s.speedCharge * power;
        const x = ox + Math.cos(s.angle) * speed * t, y = oy + Math.sin(s.angle) * speed * t + s.gravity * 0.5 * t * t;
        if (x > 479 || y > 263) break;
        this.cues.circle(x, y, n % 3 === 0 ? 1.2 : 0.7).fill({ color: 0xffdfab, alpha: s.charging ? 0.8 : 0.3 });
      }
      this.cues.moveTo(ox, oy).lineTo(ox + Math.cos(s.angle) * 24, oy + Math.sin(s.angle) * 24).stroke({ width: 1, color: 0xffe5b3 });
    }
    this.cues.rect(20, 228, 47, 5).fill(0x162c36).rect(21, 229, 45 * s.charge, 3).fill(s.charge >= 0.99 ? 0xffe5a0 : 0x9fc9bc);
    this.renderArrows(s);
    if (s.outcome !== "playing") this.cues.rect(0, 0, 480, 270).fill({ color: s.outcome === "won" ? 0xffe3ae : 0x172432, alpha: 0.18 });
    this.hud.update({ title: `${scene.title} · ${s.outcome === "won" ? "DAWN RELIEF" : s.outcome === "lost" ? "THE GATE HAS FALLEN" : `WAVE ${s.wave + 1}/${s.waveCount}`}`,
      subtitle: `${s.kills} repelled · ${s.score} score · Draw ${Math.round(s.charge * 100)}%`,
      status: `${s.message}${this.options.status?.() ? ` · ${this.options.status!()}` : ""}`,
      controls: s.phase === "prepare" ? [{ text: "E / Tab · House", action: "select" }, { text: "R · Repair", action: "repair" }, { text: "U · Faster draw", action: "upgrade" }] : scene.controls });
  }
  private renderArrows(s: DefenseObservation) {
    const seen = new Set<string>();
    for (const arrow of s.arrows) {
      seen.add(arrow.id);
      let visual = this.arrows.get(arrow.id);
      if (!visual) { visual = new Graphics().moveTo(-9, 0).lineTo(3, 0).stroke({ color: 0xffe0a7, width: 1 }).poly([3, 0, 0, -2, 0, 2]).fill(0xe9e9dc); this.arrows.set(arrow.id, visual); this.actors.addChild(visual); }
      visual.position.set(arrow.x / 256, arrow.y / 256);
      visual.rotation = Math.atan2(arrow.vy, arrow.vx);
    }
    for (const [id, visual] of this.arrows) if (!seen.has(id)) { visual.destroy(); this.arrows.delete(id); }
  }
  renderOutcome() { this.render(0); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.interactive = false;
    this.world.destroy({ children: true }); this.backdrop.destroy(); this.mask.destroy(); this.hud.dispose(); this.atlas.dispose();
    this.enemies.clear(); this.arrows.clear(); this.flames.clear(); this.previousHp.clear(); this.impacts = []; this.buildings = [];
    if (this.stage) { this.stage.canvas.style.imageRendering = this.oldImageRendering; this.stage.camera.pan(0, 0); this.stage.camera.zoom = 1; }
    this.stage = undefined;
  }
}
