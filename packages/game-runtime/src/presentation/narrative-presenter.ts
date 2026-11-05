import { validatePresentationQueueSnapshot } from "./event-queue";
/** Provisional investigative-narrative presenter. Authored scene composition stays in descriptors. */
import { Container, Graphics, Text, Rectangle, Ellipse } from "pixi.js";
import type { NarrativeCommand } from "@onepage/game-simulation/narrative-protocol";
import { NarrativeSession } from "@onepage/game-simulation/narrative";
import {
  PanelController,
  PresentationQueue,
  AtlasLoader,
  ClipPlayer,
  type PixiStage,
  type PixiPresenter,
} from "../pixi";
/** Validate/detach presentation before a wrapper commits simulation restore. */
export function validateNarrativePresentation(value: unknown):
  | {
      queue?: ReturnType<PresentationQueue["snapshot"]>;
      cueCursor?: number;
      revealId?: number;
      pendingCues?: { id: string; kind: string }[];
      textScale?: number;
    }
  | undefined {
  if (value === undefined) return undefined;
  const v = structuredClone(value) as {
    queue?: ReturnType<PresentationQueue["snapshot"]>;
    cueCursor?: number;
    revealId?: number;
    pendingCues?: { id: string; kind: string }[];
    textScale?: number;
  };
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    (v.cueCursor !== undefined &&
      (!Number.isSafeInteger(v.cueCursor) || v.cueCursor < 0)) ||
    (v.revealId !== undefined &&
      (!Number.isSafeInteger(v.revealId) || v.revealId < -1)) ||
    (v.textScale !== undefined && ![16, 18, 22].includes(v.textScale))
  )
    throw Error("Invalid narrative presentation");
  if (v.queue !== undefined)
    v.queue = validatePresentationQueueSnapshot(v.queue);
  if (
    v.pendingCues !== undefined &&
    (!Array.isArray(v.pendingCues) ||
      v.pendingCues.length > 256 ||
      Object.keys(v.pendingCues).length !== v.pendingCues.length ||
      new Set(v.pendingCues.map((c) => c?.id)).size !== v.pendingCues.length ||
      v.pendingCues.some(
        (c) =>
          !c ||
          typeof c.id !== "string" ||
          !/^(narrative|dice):[0-9]+$/.test(c.id) ||
          typeof c.kind !== "string" ||
          !v.queue?.pending.some((p) => p.id === c.id),
      ))
  )
    throw Error("Invalid narrative pending cues");
  return v;
}
export interface NarrativeActorArt {
  role: string;
  scale: number;
  facing: "left" | "right" | "up" | "down";
  clips: { idle: string; walk: string; interact: string };
  anchor?: { x: number; y: number };
}
export interface NarrativeSceneArt {
  bounds: { x: number; y: number; width: number; height: number };
  grid: { x: number; y: number; cellWidth: number; cellHeight: number };
  background: number;
  tileLayers: {
    frame?: string;
    color?: number;
    x: number;
    y: number;
    columns: number;
    rows: number;
    cellWidth: number;
    cellHeight: number;
  }[];
  props: {
    frame: string;
    x: number;
    y: number;
    scale: number;
    layer: "ground" | "occluder";
    foot?: number;
  }[];
  actors: Record<string, NarrativeActorArt>;
  hotspots: Record<
    string,
    { shape: "rectangle" | "circle"; width: number; height: number }
  >;
  weather?: "rain";
}
export interface NarrativePresentationDefinition {
  atlasUrl: string;
  scenes: Record<string, NarrativeSceneArt>;
}
export class NarrativePresenter implements PixiPresenter {
  private disposed = false;
  private atlas = new AtlasLoader();
  private actor = new ClipPlayer();
  private ready = false;
  private npcClips: { clip: ClipPlayer; art: NarrativeActorArt }[] = [];
  private sceneActors: Container[] = [];
  private queue = new PresentationQueue();
  private queueSnapshot?: ReturnType<PresentationQueue["snapshot"]>;
  private revealId = -1;
  private pendingCueKinds = new Map<string, string>();
  private cueCursor = 0;
  private clock = 0;
  private root = new Container();
  private player = new Container();
  private panel?: PanelController;
  private stage!: PixiStage;
  private sceneId = "";
  private key = "";
  private textScale = 18;
  private rain?: Graphics;
  constructor(
    readonly session: NarrativeSession,
    readonly cue: ((kind: string, pitch?: number) => void) | undefined,
    readonly presentation: NarrativePresentationDefinition,
    readonly issue: (command: NarrativeCommand) => boolean,
  ) {}
  async init(stage: PixiStage): Promise<void> {
    this.stage = stage;
    this.resize();
    stage.layers.ground.addChild(this.root);
    stage.layers.actors.addChild(this.player);
    const host = document.createElement("div");
    host.style.cssText =
      "background:#252f35;color:#f1e5ce;padding:20px;font:18px/1.6 Georgia;max-height:540px;overflow:auto;border-top:3px solid #b7a983";
    stage.canvas.parentElement!.append(host);
    this.panel = new PanelController(host, "Conversation and character");
    this.panel.element.addEventListener("pointerdown", (e) =>
      e.stopPropagation(),
    );
    this.panel.element.addEventListener("keydown", (event) => {
      // The shell owns numeric shortcuts; native buttons own Enter/Space.
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const buttons = [
          ...this.panel!.element.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        ];
        const current = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        buttons[
          (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
            buttons.length
        ]?.focus();
        event.preventDefault();
      }
      event.stopPropagation();
    });
    await this.atlas.loadUrl(this.presentation.atlasUrl);
    if (this.disposed) return;
    this.ready = true;
    this.player.addChild(this.actor.sprite);
  }
  resize(): void {
    this.stage.canvas.style.imageRendering = "pixelated";
  }
  private point(cell: number) {
    const scene = this.session.scene,
      grid = this.presentation.scenes[scene.id].grid;
    return {
      x: grid.x + (cell % scene.width) * grid.cellWidth,
      y: grid.y + Math.floor(cell / scene.width) * grid.cellHeight,
    };
  }
  private frame(id: string, x: number, y: number, scale: number): Container {
    const clip = new ClipPlayer();
    const f = this.atlas.manifest!.frames[id];
    clip.sample({ frames: [{ texture: this.atlas.texture(id), ...f }] }, 0, id);
    const holder = new Container();
    holder.position.set(x, y);
    holder.scale.set(scale);
    holder.addChild(clip.sprite);
    return holder;
  }
  private scene(): void {
    this.npcClips = [];
    for (const actor of this.sceneActors) actor.destroy({ children: true });
    this.sceneActors = [];
    this.root.removeChildren().forEach((c) => c.destroy({ children: true }));
    const scene = this.session.scene,
      art = this.presentation.scenes[scene.id];
    const bg = new Graphics().rect(0, 0, 1280, 720).fill(art.background);
    this.root.addChild(bg);
    bg.eventMode = "static";
    bg.on("pointertap", (event) => {
      const p = event.getLocalPosition(this.root),
        grid = art.grid;
      const x = Math.round((p.x - grid.x) / grid.cellWidth),
        y = Math.round((p.y - grid.y) / grid.cellHeight);
      if (
        p.x >= art.bounds.x &&
        p.y >= art.bounds.y &&
        p.x <= art.bounds.x + art.bounds.width &&
        p.y <= art.bounds.y + art.bounds.height &&
        x >= 0 &&
        y >= 0 &&
        x < scene.width &&
        y < scene.height
      )
        this.issue({ kind: "walk", cell: y * scene.width + x });
    });
    for (const layer of art.tileLayers) {
      for (let y = 0; y < layer.rows; y++)
        for (let x = 0; x < layer.columns; x++) {
          const px = layer.x + x * layer.cellWidth,
            py = layer.y + y * layer.cellHeight;
          if (layer.frame) {
            const tile = this.frame(layer.frame, px, py, 1);
            tile.width = layer.cellWidth;
            tile.height = layer.cellHeight;
            this.root.addChild(tile);
          } else
            this.root.addChild(
              new Graphics()
                .rect(px, py, layer.cellWidth, layer.cellHeight)
                .fill(layer.color ?? art.background),
            );
        }
    }
    for (const prop of art.props) {
      const object = this.frame(prop.frame, prop.x, prop.y, prop.scale);
      if (prop.layer === "occluder") {
        object.zIndex = prop.foot ?? prop.y;
        this.stage.layers.actors.addChild(object);
        this.sceneActors.push(object);
      } else this.root.addChild(object);
    }
    const title = new Text({
      text: scene.name,
      style: { fill: 0xffefc4, fontFamily: "Georgia", fontSize: 30 },
    });
    title.position.set(36, 22);
    this.root.addChild(title);
    const subtitle = new Text({
      text: "Click a named person or place · Walk first, then investigate",
      style: { fill: 0xc1cbd0, fontFamily: "Georgia", fontSize: 17 },
    });
    subtitle.position.set(36, 62);
    this.root.addChild(subtitle);
    for (const hotspot of scene.hotspots) {
      const p = this.point(hotspot.cell),
        object = new Container();
      object.position.set(p.x, p.y);
      object.zIndex = p.y;
      const actorArt = art.actors[hotspot.id];
      if (actorArt) {
        const clip = new ClipPlayer();
        clip.sprite.scale.set(actorArt.scale);
        object.addChild(clip.sprite);
        this.npcClips.push({ clip, art: actorArt });
      }
      const region = art.hotspots[hotspot.id];
      const affordance = new Graphics();
      if (region.shape === "circle")
        affordance
          .ellipse(0, 4, region.width / 2, region.height / 3)
          .fill({ color: 0xf1d899, alpha: 0.13 })
          .stroke({ color: 0xd0b678, width: 1 });
      else
        affordance
          .roundRect(
            -region.width / 2,
            -region.height,
            region.width,
            region.height,
            4,
          )
          .fill({ color: 0xf1d899, alpha: 0.1 })
          .stroke({ color: 0xd0b678, width: 1 });
      object.addChildAt(affordance, 0);
      object.hitArea =
        region.shape === "circle"
          ? new Ellipse(
              0,
              -region.height / 3,
              region.width / 2,
              region.height * 0.7,
            )
          : new Rectangle(
              -region.width / 2,
              -region.height,
              region.width,
              region.height + 28,
            );
      object.eventMode = "static";
      object.cursor = "pointer";
      const label = new Text({
        text: hotspot.name,
        style: {
          fill: 0xffefd0,
          fontFamily: "Georgia",
          fontSize: 17,
          dropShadow: { color: 0x15212b, blur: 2, distance: 2 },
        },
      });
      label.anchor.set(0.5, 0);
      label.y = 12;
      object.addChild(label);
      object.on("pointertap", () =>
        this.issue({ kind: "walk", cell: hotspot.cell, hotspot: hotspot.id }),
      );
      this.stage.layers.actors.addChild(object);
      this.sceneActors.push(object);
    }
    this.rain = undefined;
    if (art.weather === "rain") {
      this.rain = new Graphics();
      this.root.addChild(this.rain);
    }
    this.sceneId = scene.id;
  }
  private controls(): void {
    const s = this.session.state,
      node = this.session.node,
      key = JSON.stringify([
        s.revision,
        s.node,
        s.history.length,
        s.reveal?.success,
        !!s.reveal,
        s.ending,
      ]);
    if (key === this.key) return;
    this.key = key;
    const revision = s.revision;
    const lines = s.history.slice(-3).map((h) => `${h.speaker}: ${h.text}`);
    lines.push(
      `Health ${s.stats.health}/3 · Morale ${s.stats.morale}/3 · Skill points ${s.points}`,
    );
    lines.push(
      this.session.definition.skills
        .map((id) => `${id} ${this.session.skill(id)}`)
        .join(" · "),
    );
    for (const t of s.thoughts)
      lines.push(
        `${this.session.definition.thoughts.find((d) => d.id === t.id)!.name}: ${t.progress >= 3 ? "Complete" : `${t.progress}/3 conversations`}`,
      );
    if (s.reveal)
      lines.push(
        `Dice ${s.reveal.dice.join(" + ")} · ${s.reveal.success ? "Success" : "Failure"}`,
      );
    const choices: { id: string; label: string; disabled?: boolean }[] = [];
    if (!s.ending) {
      for (const [i, o] of this.session.options.entries())
        choices.push({
          id: `choose:${o.id}`,
          label: `${i + 1}. ${o.label}`,
          disabled: !!s.reveal,
        });
      if (node.kind === "check") {
        const c = node.check!;
        lines.push(
          `${c.color === "white" ? "White" : "Red"} ${c.skill} ${c.difficulty} · ${Math.round(this.session.chance * 100)}%`,
        );
        choices.push({
          id: "roll",
          label: this.session.canCheck
            ? "Roll dice"
            : "Check locked — invest in its skill or find evidence",
          disabled: !this.session.canCheck || !!s.reveal,
        });
        choices.push({ id: "leave", label: "Return to exploration" });
      }
      if (node.next)
        choices.push({
          id: "continue",
          label: "Continue",
          disabled: !!s.reveal,
        });
      for (const skill of this.session.definition.skills)
        choices.push({
          id: `invest:${skill}`,
          label: `Invest in ${skill}`,
          disabled: s.points === 0 || s.baseSkills[skill] >= 6,
        });
      for (const c of this.session.definition.clothing)
        choices.push({
          id: `wear:${c.id}`,
          label: `${s.clothing.includes(c.id) ? "Remove" : "Wear"} ${c.name}`,
        });
      choices.push(
        {
          id: "health",
          label: "Use medicine",
          disabled: !s.inventory.medicine || s.stats.health >= 3,
        },
        {
          id: "morale",
          label: "Use comfort item",
          disabled: !s.inventory.comfort || s.stats.morale >= 3,
        },
      );
      if (s.revision === 0)
        for (const p of this.session.definition.profiles)
          choices.push({ id: `profile:${p.id}`, label: `Profile: ${p.name}` });
    }
    this.panel?.render(lines, choices, (id) => {
      if (id.startsWith("choose:"))
        this.issue({ kind: "choose", id: id.slice(7), revision });
      else if (id === "roll") this.issue({ kind: "roll" });
      else if (id === "continue") this.issue({ kind: "continue" });
      else if (id.startsWith("invest:"))
        this.issue({ kind: "invest", skill: id.slice(7) });
      else if (id.startsWith("wear:"))
        this.issue({ kind: "wear", id: id.slice(5) });
      else if (id.startsWith("profile:")) {
        this.issue({ kind: "profile", id: id.slice(8) });
        this.key = "";
      } else if (id === "health" || id === "morale")
        this.issue({ kind: "recover", stat: id });
      else if (id === "leave") this.issue({ kind: "leave" });
    });
    const index = this.session.scene.hotspots
      .filter((h) => h.kind === "npc")
      .findIndex((h) => node.speaker.startsWith(h.name.split(" · ")[0]));
    const matched = this.session.scene.hotspots.filter((h) => h.kind === "npc")[
      index
    ];
    if (this.panel) {
      this.panel.element.style.fontSize = `${this.textScale}px`;
      const heading = document.createElement("h2");
      heading.textContent = node.speaker || this.session.scene.name;
      heading.style.cssText =
        "font:600 22px/1.3 Georgia;margin:0 0 12px;color:#fff0c4";
      this.panel.element.prepend(heading);
      const portraitId = matched?.id ?? "investigator";
      const frame = this.atlas.manifest?.frames[`${portraitId}.idle.down.0`];
      if (frame && this.atlas.manifest) {
        const image = document.createElement("div");
        image.setAttribute("role", "img");
        image.setAttribute("aria-label", node.speaker);
        image.style.cssText = `float:right;width:${frame.width * 2}px;height:${frame.height * 2}px;margin:0 0 12px 16px;border:2px solid #b7a983;background-image:url("${this.atlas.manifest.pages[frame.pageId]}");background-position:-${frame.x * 2}px -${frame.y * 2}px;background-size:${this.atlas.texture(`${portraitId}.idle.down.0`).source.width * 2}px auto;image-rendering:pixelated;background-color:#343d42`;
        this.panel.element.prepend(image);
      }
      const tools = document.createElement("div");
      tools.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin:12px 0";
      for (const size of [16, 18, 22]) {
        const button = document.createElement("button");
        button.textContent = `Text ${size}`;
        button.setAttribute("aria-pressed", String(size === this.textScale));
        button.onclick = () => {
          this.textScale = size;
          this.panel!.element.style.fontSize = `${size}px`;
          for (const control of tools.querySelectorAll("button"))
            control.setAttribute("aria-pressed", String(control === button));
        };
        tools.append(button);
      }
      this.panel.element.append(tools);
    }
  }
  snapshot(): unknown {
    const queue = structuredClone(this.queueSnapshot ?? this.queue.snapshot());
    return {
      queue,
      pendingCues: queue.pending.flatMap((p) =>
        this.pendingCueKinds.has(p.id)
          ? [{ id: p.id, kind: this.pendingCueKinds.get(p.id)! }]
          : [],
      ),
      cueCursor: this.cueCursor,
      revealId: this.revealId,
      textScale: this.textScale,
    };
  }
  restore(value: unknown): void {
    const saved = validateNarrativePresentation(value);
    // An absent presentation starts a fresh acknowledgement history after rewind.
    this.queueSnapshot = saved?.queue ?? {
      epoch: 0,
      paused: [],
      seen: [],
      pending: [],
    };
    this.pendingCueKinds = new Map(
      saved?.pendingCues?.map((c) => [c.id, c.kind]),
    );
    this.cueCursor = saved?.cueCursor ?? 0;
    this.textScale = [16, 18, 22].includes(saved?.textScale ?? 18)
      ? (saved?.textScale ?? 18)
      : 18;
    // Historical presentation saves did not retain the reveal acknowledgement.
    // Treat their current reveal as already presented; pending dice still rebind below.
    this.revealId =
      saved?.revealId ??
      (saved && this.session.state.reveal ? this.session.state.revision : -1);
    this.key = "";
    this.sceneId = "";
    this.queue.clear();
  }
  render(dt: number): void {
    if (!this.ready || this.disposed) return;
    this.clock += dt;
    const state = this.session.state;
    const voiceDescriptors = state.cues.map((cue) => ({
      id: `narrative:${cue.id}`,
      lane: "voice",
      duration: 0.25,
      blocking: false,
      run: (skipped?: boolean) => {
        if (!skipped) this.cue?.(cue.kind);
      },
    }));
    const diceEvent = state.reveal
      ? {
          id: `dice:${state.revision}`,
          lane: "dialogue",
          duration: 0,
          blocking: false,
          run: (skipped?: boolean) => {
            if (!skipped)
              this.cue?.(
                state.reveal!.success ? "check-success" : "check-failure",
              );
          },
        }
      : undefined;
    const persistedDescriptors = [...this.pendingCueKinds].map(
      ([id, kind]) => ({
        id,
        lane: id.startsWith("dice:") ? "dialogue" : "voice",
        duration: id.startsWith("dice:") ? 0 : 0.25,
        blocking: false,
        run: (skipped?: boolean) => {
          if (!skipped) this.cue?.(kind);
        },
      }),
    );
    if (this.queueSnapshot) {
      this.queue.restore(this.queueSnapshot, [
        ...voiceDescriptors,
        ...(diceEvent ? [diceEvent] : []),
        ...persistedDescriptors,
      ]);
      this.queueSnapshot = undefined;
    }
    const seen = new Set(this.queue.snapshot().seen);
    for (let i = 0; i < state.cues.length; i++)
      if (state.cues[i].id > this.cueCursor) {
        // Advance acknowledgement only once the descriptor has entered the queue.
        if (
          seen.has(voiceDescriptors[i].id) ||
          this.queue.enqueue(voiceDescriptors[i])
        )
          this.cueCursor = state.cues[i].id;
        else break;
      }
    if (diceEvent && this.revealId !== state.revision) {
      if (seen.has(diceEvent.id) || this.queue.enqueue(diceEvent))
        this.revealId = state.revision;
    }
    for (const cue of state.cues)
      this.pendingCueKinds.set(`narrative:${cue.id}`, cue.kind);
    if (diceEvent)
      this.pendingCueKinds.set(
        diceEvent.id,
        state.reveal!.success ? "check-success" : "check-failure",
      );
    this.queue.update(dt);
    const pendingIds = new Set(this.queue.snapshot().pending.map((p) => p.id));
    for (const id of this.pendingCueKinds.keys())
      if (!pendingIds.has(id)) this.pendingCueKinds.delete(id);
    if (this.sceneId !== state.scene) this.scene();
    const scene = this.session.scene,
      art = this.presentation.scenes[scene.id],
      p = state.player,
      actor = art.actors.investigator;
    this.player.position.set(
      art.grid.x + p.x * art.grid.cellWidth,
      art.grid.y + p.y * art.grid.cellHeight,
    );
    this.player.zIndex = this.player.y;
    this.actor.sprite.scale.set(actor.scale);
    const direction = [
      "right",
      "down",
      "down",
      "down",
      "left",
      "up",
      "up",
      "up",
    ][p.facing ?? 2];
    const action = state.path.length ? "walk" : "idle";
    this.actor.sample(
      this.atlas.clip(actor.clips[action].replace("{facing}", direction)),
      p.phase ?? 0,
      action,
    );
    if (actor.anchor)
      this.actor.sprite.pivot.set(actor.anchor.x, actor.anchor.y);
    for (const { clip, art: a } of this.npcClips) {
      const hotspot = scene.hotspots.find((h) => h.id === a.role);
      const speaking =
        hotspot &&
        this.session.node.speaker.startsWith(hotspot.name.split(" · ")[0]);
      const action = speaking ? "interact" : "idle";
      clip.sample(
        this.atlas.clip(a.clips[action].replace("{facing}", a.facing)),
        speaking ? (this.clock * 0.7) % 1 : 0,
        `${a.role}:${action}`,
      );
    }
    if (this.rain) {
      this.rain.clear();
      const reduced =
        typeof matchMedia === "function" &&
        matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!reduced)
        for (let i = 0; i < 40; i++) {
          const x = (i * 137 + this.clock * 22) % 1280,
            y = (i * 83 + this.clock * 160) % 720;
          this.rain
            .moveTo(x, y)
            .lineTo(x - 3, y + 10)
            .stroke({ color: 0xb8ced9, alpha: 0.18, width: 1 });
        }
    }
    this.controls();
  }
  dispose(): void {
    this.disposed = true;
    this.queue.clear();
    this.atlas.dispose();
    const host = this.panel?.element.parentElement;
    this.panel?.dispose();
    host?.remove();
    for (const actor of this.sceneActors) actor.destroy({ children: true });
    this.sceneActors = [];
    this.root.destroy({ children: true });
    this.player.destroy({ children: true });
  }
}
