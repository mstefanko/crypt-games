import { sideViewLayout, sideViewCamera } from "./side-view-layout";
import type { CombatRunSession } from "@onepage/game-simulation/combat-run-session";
import {
  AtlasLoader,
  ClipPlayer,
  Container,
  Graphics,
  Sprite,
  Text,
  type PixiPresenter,
  type PixiStage,
} from "./index";
import { PixelSceneHud, type PixelSceneHudState } from "./pixel-scene-hud";
type Observation = ReturnType<CombatRunSession["observe"]>;
interface Decoration {
  frame?: string;
  clip?: string;
  x: number;
  y: number;
  scale?: number;
  rooms?: readonly number[];
  actorType?: string;
  tint?: number;
}
export interface CombatRunScene {
  title: string;
  requiredSeals: number;
  units: number;
  floor: number;
  worldWidth: number;
  viewport: { width: number; height: number; maxScale?: number };
  palette: { backdrop: number; wallTint: number; groundTint: number };
  terrain: { floor: string; wall: string };
  scenery: readonly Decoration[];
  gate: { frame: string; x: number; y: number; width: number; height: number };
  shopRooms: readonly number[];
  actors: Record<
    string,
    {
      scale?: number;
      tint?: number;
      label?: string;
      barHeight?: number;
      clips: Record<string, string>;
      abilityPoses?: Record<string, string>;
    }
  >;
  rollTicks: number;
  outcome: { won: string; lost: string };
  controls: PixelSceneHudState["controls"];
}
interface Options {
  observe: () => Observation;
  scene: CombatRunScene;
  atlasUrl: string;
  fontUrl?: string;
  onAction: (action: string) => void;
  status?: () => string | undefined;
}
/** Retained native side-view combat scene, sampled solely from the run owner's clock. */
export class CombatRunPresenter implements PixiPresenter {
  private atlas = new AtlasLoader();
  private stage?: PixiStage;
  private world = new Container();
  private terrain = new Container();
  private actors = new Container();
  private backdrop = new Container();
  private mask = new Graphics();
  private effects = new Graphics();
  private hud = new PixelSceneHud(
    this.atlas,
    (a) => this.options.onAction(a),
    () => this.interactive,
  );
  private visuals = new Map<number, ClipPlayer>();
  private labels = new Map<number, Text>();
  private deaths = new Map<number, number>();
  private lastElapsed = 0;
  private room = -1;
  private ready = false;
  private disposed = false;
  private interactive = false;
  private scale = 1;
  private offset = { x: 0, y: 0 };
  private previousImageRendering = "";
  constructor(private options: Options) {}
  async init(stage: PixiStage) {
    this.stage = stage;
    this.previousImageRendering = stage.canvas.style.imageRendering;
    this.world.addChild(this.terrain, this.actors, this.effects);
    stage.layers.ground.addChild(this.world);
    stage.app.stage.addChildAt(this.backdrop, 0);
    stage.app.stage.addChild(this.mask);
    this.world.mask = this.mask;
    stage.layers.hud.addChild(this.hud.root);
    this.resize(stage.width, stage.height);
    await this.atlas.loadUrl(this.options.atlasUrl);
    if (this.disposed) return;
    this.hud.load(this.options.fontUrl);
    this.ready = true;
    this.render(0);
  }
  resize(width: number, height: number) {
    if (this.stage) this.stage.canvas.style.imageRendering = "pixelated";
    const layout = sideViewLayout(width, height, this.options.scene.viewport);
    this.scale = layout.scale;
    this.offset = layout.offset;
    this.mask
      .clear()
      .rect(
        this.offset.x,
        this.offset.y,
        this.options.scene.viewport.width * this.scale,
        this.options.scene.viewport.height * this.scale,
      )
      .fill(0xffffff);
    this.hud.resize(width, height);
  }
  private sprite(
    frame: string,
    x: number,
    y: number,
    width?: number,
    height?: number,
  ) {
    const f = this.atlas.manifest!.frames[frame];
    if (!f) throw Error(`Missing combat scene frame ${frame}`);
    const s = new Sprite(this.atlas.texture(frame));
    s.position.set(x, y);
    s.pivot.set(
      (f.pivot?.x ?? 0) - (f.trim?.x ?? 0),
      (f.pivot?.y ?? 0) - (f.trim?.y ?? 0),
    );
    if (width !== undefined) {
      s.pivot.set(0);
      s.width = width;
    }
    if (height !== undefined) s.height = height;
    return s;
  }
  private rebuild(o: Observation) {
    this.terrain.removeChildren().forEach((s) => s.destroy({ children: true }));
    const scene = this.options.scene;
    this.deaths.clear();
    const backdrop = new Graphics()
      .rect(0, 0, scene.worldWidth, scene.viewport.height)
      .fill(scene.palette.backdrop);
    this.terrain.addChild(backdrop);
    for (let y = 0; y < scene.floor; y += 16)
      for (let x = 0; x < scene.worldWidth; x += 16) {
        const tile = this.sprite(scene.terrain.wall, x, y, 16, 16);
        tile.tint = scene.palette.wallTint;
        this.terrain.addChild(tile);
      }
    const level = o.world.definitions.levels.find(
      (l) => l.id === o.world.levelId,
    )!;
    const size = level.tileSize,
      cols = Math.round(level.width / size);
    for (let i = 0; i < level.tiles.length; i++)
      if (level.tiles[i])
        this.terrain.addChild(
          this.sprite(
            Math.floor(i / cols) === Math.floor(scene.floor / size)
              ? scene.terrain.floor
              : scene.terrain.wall,
            (i % cols) * size,
            Math.floor(i / cols) * size,
            size,
            size,
          ),
        );
    for (const r of level.rectangles)
      for (let x = 0; x < r.width / scene.units; x += 16)
        this.terrain.addChild(
          this.sprite(
            scene.terrain.floor,
            r.x / scene.units + x,
            r.y / scene.units,
            Math.min(16, r.width / scene.units - x),
            r.height / scene.units,
          ),
        );
    // A restrained edge light separates walkable masonry from the dark room.
    const edges = new Graphics()
      .rect(0, scene.floor, scene.worldWidth, 2)
      .fill(scene.palette.groundTint);
    for (const rect of level.rectangles)
      edges
        .rect(
          rect.x / scene.units,
          rect.y / scene.units,
          rect.width / scene.units,
          1,
        )
        .fill(scene.palette.groundTint);
    this.terrain.addChild(edges);
    for (const item of scene.scenery)
      if (item.frame && (!item.rooms || item.rooms.includes(o.room))) {
        const sprite = this.sprite(item.frame, item.x, item.y);
        sprite.scale.set(item.scale ?? 1);
        if (item.tint !== undefined) sprite.tint = item.tint;
        this.terrain.addChild(sprite);
      }
    const gate = scene.gate;
    this.terrain.addChild(this.sprite(gate.frame, gate.x, gate.y));
    this.room = o.room;
  }
  render(dt: number) {
    if (!this.ready || this.disposed || !this.stage) return;
    this.interactive = dt > 0;
    const o = this.options.observe(),
      w = o.world,
      p = w.actors[0]!,
      s = p.combatState!,
      scene = this.options.scene;
    if (this.room !== o.room || o.elapsed < this.lastElapsed) this.rebuild(o);
    this.lastElapsed = o.elapsed;
    const camera = sideViewCamera(
      p.x / scene.units,
      scene.worldWidth,
      scene.viewport.width,
    );
    this.stage.camera.zoom = this.scale;
    this.stage.camera.pan(
      camera - this.offset.x / this.scale,
      -this.offset.y / this.scale,
    );
    this.effects.clear();
    const seen = new Set<number>();
    for (const a of w.actors) {
      const binding = scene.actors[a.archetypeId];
      if (!binding) continue;
      seen.add(a.id);
      let visual = this.visuals.get(a.id);
      if (!visual) {
        visual = new ClipPlayer();
        this.visuals.set(a.id, visual);
        this.actors.addChild(visual.sprite);
      }
      const mind = o.minds.find((m) => m.actorId === a.id),
        execution = a.execution;
      const pose =
        a.health <= 0
          ? "death"
          : a.combatState && a.combatState.rollTick >= 0
            ? "roll"
            : execution
              ? (binding.abilityPoses?.[execution.abilityId] ?? "attack")
              : !a.grounded && binding.clips.jump
                ? a.vy < 0
                  ? "jump"
                  : "fall"
                : Math.abs(a.vx) > 20
                  ? "run"
                  : "idle";
      const clipId = binding.clips[pose] ?? binding.clips.idle!,
        clip = this.atlas.clip(clipId);
      clip.mirrorable = true;
      const ability = execution
        ? w.definitions.abilities.find((d) => d.id === execution.abilityId)
        : undefined;
      if (a.health <= 0 && !this.deaths.has(a.id))
        this.deaths.set(a.id, o.elapsed);
      const duration = clip.metadata?.duration ?? 1;
      const phase =
        a.health <= 0
          ? Math.min(0.999, (o.elapsed - this.deaths.get(a.id)!) / duration)
          : pose === "roll"
            ? Math.min(0.999, (a.combatState?.rollTick ?? 0) / scene.rollTicks)
            : execution && ability
              ? Math.min(
                  0.999,
                  execution.tick /
                    Math.max(
                      1,
                      ability.startup + ability.active + ability.recovery,
                    ),
                )
              : (o.elapsed % duration) / duration;
      visual.sprite.tint = binding.tint ?? 0xffffff;
      visual.sprite.scale.set(binding.scale ?? 1);
      visual.sample(
        clip,
        phase,
        `${o.room}:${a.id}:${execution?.id ?? clipId}`,
        a.facing < 0,
      );
      visual.sprite.position.set(a.x / scene.units, a.y / scene.units);
      visual.sprite.alpha =
        a.health <= 0
          ? Math.max(
              0,
              1 - (o.elapsed - this.deaths.get(a.id)! - duration) / 0.4,
            )
          : a.combatState?.invulnerableTicks && w.tick % 4 < 2
            ? 0.5
            : 1;
      if (a.team === 1 && a.health > 0) {
        const max = w.definitions.archetypes.find(
            (d) => d.id === a.archetypeId,
          )!.health,
          x = Math.max(
            camera + 34,
            Math.min(camera + scene.viewport.width - 70, a.x / scene.units),
          ),
          y = a.y / scene.units - (binding.barHeight ?? 44);
        this.effects
          .rect(x - 20, y, 40, 3)
          .fill(0x30212d)
          .rect(x - 20, y, (40 * a.health) / max, 3)
          .fill(0xef9375);
        let label = this.labels.get(a.id);
        if (!label) {
          label = new Text({
            style: { fontFamily: "monospace", fontSize: 10, fill: 0xffe3a1 },
          });
          this.labels.set(a.id, label);
          this.actors.addChild(label);
        }
        label.text =
          mind?.state === "telegraph"
            ? "! INCOMING"
            : mind?.state === "commit"
              ? "STRIKE"
              : mind?.state === "recover"
                ? "OPEN"
                : binding.label
                  ? `${binding.label} · PHASE ${mind?.phase === 2 ? 2 : 1}`
                  : "";
        label.position.set(x - 32, y - 15);
        if (mind?.state === "telegraph")
          this.effects
            .rect(
              x + (a.facing < 0 ? -86 : 0),
              a.y / scene.units - 3,
              binding.label ? 86 : 48,
              3,
            )
            .fill({ color: 0xffb85b, alpha: 0.65 });
      } else {
        const label = this.labels.get(a.id);
        if (label) label.text = "";
      }
    }
    const decoration = (
      id: number,
      clipId: string,
      x: number,
      y: number,
      scale: number,
    ) => {
      seen.add(id);
      let visual = this.visuals.get(id);
      if (!visual) {
        visual = new ClipPlayer();
        this.visuals.set(id, visual);
        this.actors.addChild(visual.sprite);
      }
      const clip = this.atlas.clip(clipId),
        duration = clip.metadata?.duration ?? 1;
      visual.sprite.scale.set(scale);
      visual.sample(clip, (o.elapsed % duration) / duration, clipId);
      visual.sprite.position.set(x, y);
    };
    for (const [index, item] of scene.scenery.entries())
      if (item.clip && (!item.rooms || item.rooms.includes(o.room))) {
        if (item.actorType) {
          for (const actor of w.actors)
            if (actor.archetypeId === item.actorType && actor.health > 0)
              decoration(
                -10000 - index * 1000 - actor.id,
                item.clip,
                actor.x / scene.units + item.x,
                actor.y / scene.units + item.y,
                item.scale ?? 1,
              );
        } else
          decoration(-index - 1, item.clip, item.x, item.y, item.scale ?? 1);
      }
    for (const [id, v] of this.visuals)
      if (!seen.has(id)) {
        v.sprite.destroy();
        this.visuals.delete(id);
        this.labels.get(id)?.destroy();
        this.labels.delete(id);
      }
    for (const bolt of o.bolts)
      this.effects
        .circle(
          bolt.x / scene.units,
          bolt.y / scene.units,
          Math.max(2, bolt.radius / scene.units),
        )
        .fill(0xffd579);
    // Gate illumination communicates its authoritative cleared state.
    this.effects
      .rect(scene.gate.x, scene.gate.y, scene.gate.width, scene.gate.height)
      .stroke({ color: o.cleared ? 0xffd581 : 0x733f54, width: 2 });
    const rewards =
      o.cleared && !o.claimed && !scene.shopRooms.includes(o.room)
        ? `Choose blessing: ${o.choices.map((c, i) => `${i + 1} ${c}`).join(" · ")}`
        : "";
    const status =
      this.options.status?.() ??
      (o.won
        ? scene.outcome.won
        : o.lost
          ? scene.outcome.lost
          : rewards || o.notice);
    this.hud.update({
      title: `${scene.title} · ${o.roomName}`,
      subtitle: `HEART ${p.health}/${s.maxHealth}  ·  ${s.weapons[s.equipped]}  ·  SEALS ${o.seals}/${scene.requiredSeals}  ·  H ${s.healCharges}  ·  L ${s.skillCooldown ? Math.ceil(s.skillCooldown / 60) + "s" : s.skill}`,
      status,
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
    this.mask.destroy();
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
