import { NineSliceSprite } from "pixi.js";
import { AtlasLoader, Container, Sprite, Text } from "./index";

export interface PixelSceneHudState {
  title?: string;
  subtitle?: string;
  status?: string;
  controls?: readonly { frame?: string; text: string; action?: string }[];
}
/** Shared acquired pixel UI: sliced panels, readable labels and actual input prompts. */
export class PixelSceneHud {
  readonly root = new Container();
  private title = new Text({
    style: {
      fontFamily: "monospace",
      fontSize: 24,
      fontWeight: "bold",
      fill: 0xf3e6ba,
    },
  });
  private subtitle = new Text({
    style: { fontFamily: "monospace", fontSize: 14, fill: 0x93b8bd },
  });
  private status = new Text({
    style: {
      fontFamily: "monospace",
      fontSize: 16,
      fill: 0xf4e4be,
      wordWrap: true,
      wordWrapWidth: 700,
    },
  });
  private controls = new Container();
  private panels: NineSliceSprite[] = [];
  private controlKey = "";
  private fontFace?: FontFace;
  private disposed = false;
  private width = 768;
  private height = 512;
  constructor(
    private atlas: AtlasLoader,
    private onAction?: (action: string) => void,
    private isInteractive: () => boolean = () => true,
  ) {
    this.root.addChild(this.title, this.subtitle, this.status, this.controls);
  }
  load(fontUrl?: string) {
    this.panels = [0, 1].map(() => {
      const panel = new NineSliceSprite({
        texture: this.atlas.texture("ui.panel"),
        leftWidth: 3,
        rightWidth: 3,
        topHeight: 3,
        bottomHeight: 3,
      });
      panel.alpha = 0.94;
      this.root.addChildAt(panel, 0);
      return panel;
    });
    this.resize(this.width, this.height);
    if (fontUrl && typeof FontFace !== "undefined")
      void new FontFace("CollectionPixel", `url(${fontUrl})`)
        .load()
        .then((font) => {
          if (this.disposed) return;
          document.fonts.add(font);
          this.fontFace = font;
          for (const text of [this.title, this.subtitle, this.status])
            text.style.fontFamily = "CollectionPixel, monospace";
        })
        .catch(() => {});
  }
  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.title.position.set(28, 19);
    this.subtitle.position.set(29, 49);
    this.status.position.set(28, height - 82);
    this.status.style.wordWrapWidth = width - 56;
    this.controls.position.set(28, height - 41);
    this.panels.forEach((panel, i) => {
      panel.position.set(16, i ? height - 94 : 10);
      panel.width = width - 32;
      panel.height = i ? 83 : 65;
    });
  }
  update(state: PixelSceneHudState) {
    this.title.text = state.title ?? "";
    this.subtitle.text = state.subtitle ?? "";
    this.status.text = state.status ?? "";
    const key = JSON.stringify(state.controls ?? []);
    if (key === this.controlKey) return;
    this.controlKey = key;
    this.controls
      .removeChildren()
      .forEach((child) => child.destroy({ children: true }));
    let x = 0;
    for (const control of state.controls ?? []) {
      const group = new Container();
      group.x = x;
      if (control.frame) {
        const sprite = new Sprite(this.atlas.texture(control.frame));
        sprite.width = 19;
        sprite.scale.y = sprite.scale.x;
        group.addChild(sprite);
      }
      const text = new Text({
        text: control.text,
        style: { fontFamily: "monospace", fontSize: 14, fill: 0xaec4cd },
      });
      text.position.set(control.frame ? 25 : 0, 3);
      group.addChild(text);
      if (control.action) {
        group.eventMode = "static";
        group.cursor = "pointer";
        group.on("pointertap", () => {
          if (this.isInteractive()) this.onAction?.(control.action!);
        });
      }
      this.controls.addChild(group);
      x += text.x + text.width + 22;
    }
  }
  dispose() {
    this.disposed = true;
    if (this.fontFace) document.fonts.delete(this.fontFace);
    this.root.destroy({ children: true });
  }
}
