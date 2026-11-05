import {
  formatCalendarDate,
  type EvidenceField,
  type EvidenceValue,
} from "@onepage/game-simulation/document-rules";
import type { InspectionShiftObservation } from "@onepage/game-simulation/inspection-shift-session";
import { DeskInteraction, containsPoint } from "../presentation/desk";
import {
  AtlasLoader,
  Container,
  Graphics,
  Sprite,
  Text,
  type PixiPresenter,
  type PixiStage,
} from "./index";

export interface DeskSceneDefinition {
  title: string;
  backdrop: string;
  portraits: readonly string[];
}
export interface DeskPresenterOptions {
  scene: DeskSceneDefinition;
  atlasUrl: string;
  observe: () => InspectionShiftObservation;
  onAction: (id: string) => void;
  onSelect: (id: string) => void;
}
interface Hit {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  field?: boolean;
}
const display = (value: EvidenceValue) =>
  typeof value === "object" ? formatCalendarDate(value) : String(value);
/** Native retained document desk. Spatial state is cosmetic; every decision goes
 * back through the inspection owner. The readable DOM transcript is also a full
 * keyboard/touch path when the graphics viewport is too small for paper text. */
export class DeskPresenter implements PixiPresenter {
  private atlas = new AtlasLoader();
  private root = new Container();
  private papers = new Container();
  private ui = new Container();
  private scenery = new Container();
  private desk = new DeskInteraction();
  private views = new Map<
    string,
    {
      root: Container;
      title: Text;
      rows: Text[];
      selection: Graphics;
      stamp: Text;
    }
  >();
  private portrait = new Sprite();
  private hits: Hit[] = [];
  private stage?: PixiStage;
  private panel?: HTMLDetailsElement;
  private panelKey = "";
  private caseId = "";
  private visualKey = "";
  private ready = false;
  private disposed = false;
  private active = false;
  private book = false;
  private inspect = false;
  private cursor = 0;
  private scale = 1;
  private offset = { x: 0, y: 0 };
  private cancelListener = () => this.cancel();
  constructor(private options: DeskPresenterOptions) {}
  async init(stage: PixiStage) {
    this.stage = stage;
    stage.layers.hud.addChild(this.root);
    this.root.addChild(this.scenery, this.portrait, this.papers, this.ui);
    this.scenery.addChild(new Graphics().rect(0, 0, 1000, 700).fill(0x182e38));
    this.panel = document.createElement("details");
    this.panel.open = window.matchMedia("(max-width: 700px)").matches;
    this.panel.className = "game-panel-content";
    this.panel.setAttribute(
      "aria-label",
      "Inspection desk: readable documents and controls",
    );
    stage.canvas.parentElement?.after(this.panel);
    stage.canvas.addEventListener("pointercancel", this.cancelListener);
    window.addEventListener("blur", this.cancelListener);
    this.resize(stage.width, stage.height);
    await this.atlas.loadUrl(this.options.atlasUrl);
    if (this.disposed) return;
    const background = new Sprite(
      this.atlas.texture(this.options.scene.backdrop),
    );
    background.position.set(610, 0);
    background.width = 384;
    background.height = 608;
    background.alpha = 0.45;
    this.scenery.addChild(background);
    for (const [frame, x, y, scale] of [
      ["office.desk", 480, 330, 3],
      ["office.cabinet", 250, 130, 2],
      ["office.lamp", 870, 115, 2],
    ] as const) {
      const prop = new Sprite(this.atlas.texture(frame));
      prop.position.set(x, y);
      prop.scale.set(scale);
      this.scenery.addChild(prop);
    }
    this.scenery.addChild(
      new Graphics()
        .rect(0, 300, 1000, 400)
        .fill({ color: 0x302b29, alpha: 0.78 }),
    );
    this.portrait.position.set(58, 140);
    this.portrait.scale.set(3);
    this.ready = true;
    this.render(0);
  }
  resize(width: number, height: number) {
    this.cancel();
    this.scale = Math.min(width / 1000, height / 700);
    this.offset = {
      x: (width - 1000 * this.scale) / 2,
      y: (height - 700 * this.scale) / 2,
    };
    this.root.position.set(this.offset.x, this.offset.y);
    this.root.scale.set(this.scale);
  }
  inverse(x: number, y: number) {
    return {
      x: (x - this.offset.x) / this.scale,
      y: (y - this.offset.y) / this.scale,
    };
  }
  cancel() {
    this.desk.cancel();
  }
  get inspecting() {
    return this.inspect;
  }
  action(id: string) {
    if (id === "book") {
      this.book = !this.book;
      this.inspect = false;
      this.cancel();
    } else if (id === "inspect") {
      this.inspect = !this.inspect;
      this.book = false;
      this.cancel();
    } else if (id === "next-paper") {
      const objects = this.desk.objects,
        i = objects.findIndex((p) => p.id === this.desk.focus);
      const object = objects[(i + 1) % objects.length];
      if (object) {
        this.desk.focus = object.id;
        this.desk.objects = objects.filter((p) => p !== object).concat(object);
      }
    } else if (id === "field" || id === "previous-field") {
      const ids = this.fieldIds();
      this.cursor =
        (this.cursor + (id === "field" ? 1 : -1) + ids.length) %
        Math.max(1, ids.length);
      const paper = this.options
        .observe()
        .current?.papers.find((p) =>
          p.fields.some((f) => f.id === ids[this.cursor]),
        );
      if (paper) {
        this.desk.focus = paper.id;
        this.inspect = true;
        this.book = false;
      } else if (ids[this.cursor]?.startsWith("rule:")) this.book = true;
    } else if (id === "select") {
      const field = this.fieldIds()[this.cursor];
      if (field) this.options.onSelect(field);
    } else this.options.onAction(id);
  }
  pointer(input: {
    x: number;
    y: number;
    pressed: boolean;
    down: boolean;
    released: boolean;
  }) {
    if (
      !this.active ||
      this.caseId !== (this.options.observe().current?.state.id ?? "")
    ) {
      this.cancel();
      return;
    }
    const p = this.inverse(input.x, input.y);
    if (input.pressed) {
      const hit = [...this.hits]
        .reverse()
        .find((h) => containsPoint(h, p.x, p.y));
      if (hit) {
        if (hit.field) this.options.onSelect(hit.id);
        else this.action(hit.id);
        return;
      }
      if (!this.book && !this.inspect) {
        this.desk.begin(p.x, p.y);
      }
    }
    if (input.down && this.desk.dragging)
      this.desk.move(p.x, p.y, { x: 210, y: 145, width: 770, height: 420 });
    if (input.released) {
      this.desk.end(p.x, p.y);
    }
  }
  private fieldIds() {
    const s = this.options.observe();
    return [
      ...s.fields.map((f) => f.id),
      ...s.rules.map((r) => `rule:${r.id}`),
    ];
  }
  private text(
    parent: Container,
    text: string,
    x: number,
    y: number,
    size = 16,
    fill = 0xeaddc0,
    width = 940,
  ) {
    const label = new Text({
      text,
      style: {
        fontFamily: "Georgia, serif",
        fontSize: size,
        fill,
        wordWrap: true,
        wordWrapWidth: width,
        lineHeight: size * 1.3,
      },
    });
    label.position.set(x, y);
    parent.addChild(label);
    return label;
  }
  private button(
    id: string,
    text: string,
    x: number,
    y: number,
    width: number,
    color = 0x314b52,
  ) {
    this.ui.addChild(
      new Graphics()
        .roundRect(x, y, width, 38, 4)
        .fill(color)
        .stroke({ color: 0xa9936f, width: 1 }),
    );
    this.text(this.ui, text, x + 10, y + 10, 15);
    this.hits.push({ id, x, y, width, height: 38 });
  }
  private field(
    parent: Container,
    f: EvidenceField,
    x: number,
    y: number,
    width: number,
    selected: readonly string[],
    globalX = x,
    globalY = y,
  ) {
    const focus = this.fieldIds()[this.cursor] === f.id;
    parent.addChild(
      new Graphics().rect(x, y, width, 29).fill({
        color: selected.includes(f.id) ? 0xd5b477 : focus ? 0xe5d4ab : 0xeaddc0,
        alpha: 0.95,
      }),
    );
    this.text(
      parent,
      `${f.label}: ${display(f.value)}`,
      x + 5,
      y + 5,
      14,
      0x253632,
      width - 10,
    );
    this.hits.push({
      id: f.id,
      x: globalX,
      y: globalY,
      width,
      height: 29,
      field: true,
    });
  }
  render(dt: number) {
    this.active = dt > 0;
    if (!this.active) this.cancel();
    if (!this.ready || this.disposed) return;
    const s = this.options.observe();
    const visualKey = JSON.stringify([
      Math.ceil(s.clock),
      s.current,
      s.phase,
      s.message,
      s.selected,
      s.coins,
      s.health,
      s.rules,
      s.rent,
      s.food,
      s.heat,
      this.book,
      this.inspect,
      this.cursor,
      this.desk.capture(),
      this.active,
    ]);
    if (visualKey === this.visualKey) return;
    this.visualKey = visualKey;
    const id = s.current?.state.id ?? "";
    if (id !== this.caseId) {
      this.caseId = id;
      this.cursor = 0;
      this.cancel();
      this.views.forEach((v) => v.root.destroy({ children: true }));
      this.views.clear();
      this.desk.objects = [];
      this.desk.focus = null;
      this.inspect = false;
      this.book = false;
    }
    this.ui.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.hits = [];
    this.ui.addChild(
      new Graphics()
        .rect(0, 0, 1000, 88)
        .fill({ color: 0x142c36, alpha: 0.96 })
        .rect(0, 641, 1000, 59)
        .fill(0x152b34),
    );
    this.text(this.ui, this.options.scene.title, 24, 15, 25, 0xf4d59a);
    this.text(
      this.ui,
      `NIGHT ${s.shift + 1} · ${formatCalendarDate(s.today)} · ${Math.ceil(s.clock)}s · ${s.coins} COINS · HOUSEHOLD ${s.health}/3`,
      24,
      53,
      16,
    );
    this.text(this.ui, s.message, 22, 653, 17, 0xf2d399, 955);
    this.portrait.visible = !!s.current && s.phase === "desk";
    this.papers.visible = s.phase === "desk" && !this.inspect && !this.book;
    if (s.current) {
      this.portrait.texture = this.atlas.texture(
        this.options.scene.portraits[
          s.current.portrait % this.options.scene.portraits.length
        ]!,
      );
      // Atlas frames are trimmed: preserve native proportions, not the untrimmed cell ratio.
      this.portrait.scale.set(3);
      this.text(this.ui, s.current.name, 20, 100, 19, 0xf4d59a, 190);
      s.current.statement.forEach((f, i) =>
        this.field(this.ui, f, 16, 292 + i * 34, 185, s.selected),
      );
      this.text(this.ui, s.current.story, 18, 409, 15, 0xeaddc0, 180);
      for (const [i, p] of s.current.papers.entries()) {
        let v = this.views.get(p.id);
        if (!v) {
          const root = new Container(),
            mask = new Graphics().rect(0, 0, 310, 252).fill(0xffffff),
            body = new Container();
          root.addChild(
            new Graphics()
              .rect(5, 6, 310, 252)
              .fill({ color: 0x000000, alpha: 0.3 }),
            new Graphics().rect(0, 0, 310, 252).fill(p.color),
            body,
            mask,
          );
          body.mask = mask;
          const title = this.text(body, p.title, 14, 13, 18, 0x273f3b),
            rows = p.fields.map((f, j) =>
              this.text(body, "", 18, 54 + j * 32, 14, 0x293b37, 275),
            );
          const selection = new Graphics();
          body.addChildAt(selection, 0);
          const stamp = this.text(body, "", 80, 215, 22, 0x216948);
          stamp.rotation = -0.08;
          v = { root, title, rows, selection, stamp };
          this.views.set(p.id, v);
          this.papers.addChild(root);
          this.desk.objects.push({
            id: p.id,
            x: 230 + i * 138,
            y: 186 + i * 43,
            width: 310,
            height: 252,
          });
          this.desk.focus = p.id;
        }
        v.selection.clear();
        p.fields.forEach((f, j) => {
          v!.rows[j]!.text = `${f.label}: ${display(f.value)}`;
          if (s.selected.includes(f.id))
            v!.selection.rect(12, 50 + j * 32, 286, 29).fill(0xd8b478);
        });
        v.stamp.text = s.current.state.decision?.toUpperCase() ?? "";
      }
      for (const object of this.desk.objects) {
        const v = this.views.get(object.id);
        if (v) {
          v.root.position.set(object.x, object.y);
          this.papers.setChildIndex(v.root, this.papers.children.length - 1);
        }
      }
      // Only the exposed top paper has field hit regions; drag headers to reorder.
      const top = this.desk.objects.at(-1),
        paper = s.current.papers.find((p) => p.id === top?.id);
      if (top && paper && this.papers.visible)
        paper.fields.forEach((f, j) =>
          this.hits.push({
            id: f.id,
            x: top.x + 12,
            y: top.y + 50 + j * 32,
            width: 286,
            height: 29,
            field: true,
          }),
        );
    }
    if (s.phase === "desk") {
      this.field(
        this.ui,
        { id: "calendar.today", label: "Calendar", value: s.today },
        16,
        555,
        190,
        s.selected,
      );
      if (this.book) this.rulebook(s.rules, s.selected);
      else if (this.inspect && s.current) {
        this.ui.addChild(
          new Graphics().rect(222, 117, 756, 421).fill(0xe7ddbf),
        );
        const p =
          s.current.papers.find((p) => p.id === this.desk.focus) ??
          s.current.papers[0];
        if (p) {
          this.text(
            this.ui,
            `${p.title} · Tab changes paper`,
            241,
            133,
            24,
            0x2a3d38,
          );
          p.fields.forEach((f, i) =>
            this.field(this.ui, f, 242, 190 + i * 49, 710, s.selected),
          );
        }
      }
      const buttons = [
        ["bell", "B · Bell"],
        ["book", "R · Rules"],
        ["inspect", "I · Inspect"],
        ["ask", "Q · Ask"],
        ["admit", "A · Admit"],
        ["refuse", "D · Refuse"],
        ["return", "E · Return"],
      ];
      buttons.forEach(([id, label], i) =>
        this.button(
          id!,
          label!,
          18 + i * 140,
          592,
          132,
          id === "admit" ? 0x315b49 : id === "refuse" ? 0x794942 : 0x314b52,
        ),
      );
    } else {
      this.ui.addChild(
        new Graphics()
          .roundRect(24, 104, 952, 521, 6)
          .fill({ color: 0x142b35, alpha: 0.97 }),
      );
      if (s.phase === "bulletin") {
        this.text(
          this.ui,
          "NIGHT BULLETIN / NORTHBANK FERRY AUTHORITY",
          45,
          122,
          24,
          0xf4d59a,
        );
        this.rulebook(s.rules, s.selected, 160);
        this.button("bell", "B · Acknowledge and open queue", 45, 570, 420);
      } else {
        this.text(
          this.ui,
          s.phase === "end" ? "THE LAST FERRY" : "HOUSEHOLD SETTLEMENT",
          45,
          128,
          28,
          0xf4d59a,
        );
        this.text(this.ui, s.message, 45, 180, 22, 0xeaddc0, 880);
        this.text(
          this.ui,
          `${s.processed} travelers processed · ${s.citations} citations · ${s.coins} coins remaining`,
          45,
          270,
          20,
        );
        this.text(
          this.ui,
          s.narratives.slice(-5).join("\n"),
          45,
          315,
          17,
          0xbdd0c8,
          880,
        );
        if (s.phase === "settlement") {
          this.button(
            "rent",
            `${s.rent ? "PAID" : "1 · Pay"} rent · 10`,
            45,
            490,
            270,
          );
          this.button(
            "food",
            `${s.food ? "BOUGHT" : "2 · Buy"} food · 6`,
            335,
            490,
            270,
          );
          this.button(
            "heat",
            `${s.heat ? "BOUGHT" : "3 · Buy"} heat · 4`,
            625,
            490,
            270,
          );
          this.button("continue", "N · Finish night", 45, 557, 850);
        }
      }
    }
    this.renderPanel(s);
  }
  private rulebook(
    rules: InspectionShiftObservation["rules"],
    selected: readonly string[],
    y = 135,
  ) {
    if (y === 135)
      this.ui.addChild(new Graphics().rect(222, 117, 756, 430).fill(0xe7ddbf));
    rules.forEach((r, i) => {
      const yy = y + i * 46;
      this.ui.addChild(
        new Graphics()
          .rect(240, yy, 714, 43)
          .fill(selected.includes(`rule:${r.id}`) ? 0xcba970 : 0xdad1b3),
      );
      this.text(this.ui, r.text, 249, yy + 5, 15, 0x293d38, 694);
      this.hits.push({
        id: `rule:${r.id}`,
        x: 240,
        y: yy,
        width: 714,
        height: 43,
        field: true,
      });
    });
  }
  private renderPanel(s: InspectionShiftObservation) {
    if (!this.panel) return;
    const key = JSON.stringify([
      s.current,
      s.phase,
      s.rules,
      s.selected,
      s.message,
      s.coins,
      s.food,
      s.heat,
      s.rent,
      this.active,
    ]);
    if (key === this.panelKey) return;
    this.panelKey = key;
    const focused = (document.activeElement as HTMLElement)?.dataset.deskChoice;
    this.panel.replaceChildren();
    const heading = document.createElement("summary");
    heading.textContent = "Readable documents and accessible desk controls";
    this.panel.append(heading);
    const add = (id: string, label: string, field = false) => {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.deskChoice = id;
      b.textContent = `${s.selected.includes(id) ? "Selected · " : ""}${label}`;
      b.disabled = !this.active;
      b.onclick = () => {
        const current = this.options.observe();
        if (
          this.active &&
          current.phase === s.phase &&
          current.current?.state.id === s.current?.state.id
        ) {
          if (field) this.options.onSelect(id);
          else this.action(id);
        }
      };
      this.panel!.append(b);
    };
    const credit = document.createElement("p");
    credit.textContent =
      "Artwork: LimeZu · Modern Interiors / Modern Exteriors";
    this.panel.append(credit);
    const prose = document.createElement("p");
    prose.textContent = s.current
      ? `${s.current.name}: ${s.current.story}`
      : s.message;
    this.panel.append(prose);
    s.rules.forEach((r) => add(`rule:${r.id}`, r.text, true));
    if (s.current) {
      for (const p of s.current.papers) {
        const title = document.createElement("h4");
        title.textContent = p.title;
        this.panel.append(title);
        p.fields.forEach((f) =>
          add(f.id, `${f.label}: ${display(f.value)}`, true),
        );
      }
      s.current.statement.forEach((f) =>
        add(f.id, `Statement ${f.label}: ${display(f.value)}`, true),
      );
      add("calendar.today", `Calendar: ${formatCalendarDate(s.today)}`, true);
    }
    const controls =
      s.phase === "settlement"
        ? [
            ["rent", "Pay rent 10"],
            ["food", "Buy food 6"],
            ["heat", "Buy heat 4"],
            ["continue", "Finish night"],
          ]
        : s.phase === "bulletin"
          ? [["bell", "Acknowledge bulletin"]]
          : s.phase === "end"
            ? []
            : [
                ["bell", "Next traveler"],
                ["ask", "Question discrepancy"],
                ["admit", "Stamp admit"],
                ["refuse", "Stamp refuse"],
                ["return", "Return papers"],
              ];
    controls.forEach(([id, label]) => add(id!, label!));
    if (focused)
      this.panel
        .querySelector<HTMLElement>(
          `[data-desk-choice="${CSS.escape(focused)}"]`,
        )
        ?.focus({ preventScroll: true });
  }
  renderOutcome() {
    this.render(0);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    this.stage?.canvas.removeEventListener(
      "pointercancel",
      this.cancelListener,
    );
    window.removeEventListener("blur", this.cancelListener);
    this.panel?.remove();
    this.root.destroy({ children: true });
    this.atlas.dispose();
    this.views.clear();
  }
}
