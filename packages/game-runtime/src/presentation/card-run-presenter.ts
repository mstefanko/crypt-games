import { validatePresentationQueueSnapshot } from "./event-queue";
import { cardRowLayout, CardDragController } from "./card-table-layout";
import {
  CardFeltFilter,
  vectorCardIcon,
  type CardTableArtwork,
} from "./card-table-art";
import { CardFoilFilter } from "./surface-filters";
/** Card genre presentation; single consumer card-run, composed with shared Pixi springs/queue/panels. */
import { CardRunSession } from "@onepage/game-simulation/card-run";
import {
  Container,
  Graphics,
  Text,
  Sprite,
  AtlasLoader,
  SpringTransform,
  PresentationQueue,
  PanelController,
  type PixiPresenter,
  type PixiStage,
} from "../pixi";
interface CardView {
  root: Container;
  spring: SpringTransform;
  label: Text;
  selected: boolean;
  signature: string;
  flip: number;
  face?: Sprite;
  textureKey?: string;
  outline: Graphics;
}
export function validateCardRunPresentation(
  value: unknown,
):
  | { queue?: ReturnType<PresentationQueue["snapshot"]>; visible?: string }
  | undefined {
  if (value === undefined) return undefined;
  const saved = structuredClone(value) as {
    queue?: ReturnType<PresentationQueue["snapshot"]>;
    visible?: string;
  };
  if (
    !saved ||
    typeof saved !== "object" ||
    Array.isArray(saved) ||
    (saved.visible !== undefined && typeof saved.visible !== "string")
  )
    throw Error("Invalid Lucky presentation checkpoint");
  if (saved.queue !== undefined)
    saved.queue = validatePresentationQueueSnapshot(saved.queue);
  return saved;
}
export class CardRunPresenter implements PixiPresenter {
  private reduced =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  private felt = new CardFeltFilter();
  private decoration = new Container();
  private artKey = "";
  private foil = new CardFoilFilter(0.045);
  private clock = 0;
  private atlas = new AtlasLoader();
  private root = new Container();
  private cards = new Map<string, CardView>();
  private modifierViews = new Map<
    string,
    { root: Container; spring: SpringTransform }
  >();
  private modifierDrag?: { id: string; x: number; y: number; moved: boolean };
  private stage!: PixiStage;
  private panel?: PanelController;
  private status = new Text({
    text: "",
    style: {
      fill: 0xf9e9bf,
      fontFamily: "Georgia",
      fontSize: 22,
      wordWrap: true,
      wordWrapWidth: 880,
    },
  });
  private queue = new PresentationQueue();
  private transaction = -1;
  private panelKey = "";
  private drag = new CardDragController();
  private pointer?: { id: string; x: number; y: number; drag: boolean };
  private visible = "";
  private hovered?: string;
  private restoredQueue?: ReturnType<PresentationQueue["snapshot"]>;
  constructor(
    readonly session: CardRunSession,
    readonly assets?: { cards: string; art?: CardTableArtwork },
    readonly cue?: (kind: string, pitch: number) => void,
  ) {}
  async init(stage: PixiStage): Promise<void> {
    this.stage = stage;
    stage.layers.hud.addChild(this.root);
    const colors = this.assets?.art?.felt ?? {
      base: 0x164b42,
      edge: 0xb29558,
      thread: 0x86a38b,
    };
    const table = new Graphics()
      .roundRect(18, 18, 1244, 684, 30)
      .fill(colors.base)
      .stroke({ color: colors.edge, width: 3 });
    table.filters = [this.felt];
    this.root.addChild(table);
    const stitching = new Graphics()
      .roundRect(31, 31, 1218, 658, 23)
      .stroke({ color: colors.thread, width: 1, alpha: 0.35 })
      .ellipse(640, 355, 540, 240)
      .stroke({ color: colors.edge, width: 2, alpha: 0.16 });
    for (let i = 0; i < 70; i++) {
      const x = 46 + i * 17;
      stitching
        .moveTo(x, 40)
        .lineTo(x + 6, 40)
        .moveTo(x, 680)
        .lineTo(x + 6, 680)
        .stroke({ color: colors.edge, width: 1, alpha: 0.5 });
    }
    this.root.addChild(stitching, this.decoration);
    this.status.position.set(45, 40);
    this.root.addChild(this.status);
    const host = document.createElement("div");
    host.className = "native-card-panel";
    host.style.cssText =
      "position:relative;padding:12px;background:#122b28;color:#f3e8cc;font:16px Georgia;display:block";
    stage.canvas.parentElement!.insertAdjacentElement("afterend", host);
    this.panel = new PanelController(host, "Card table controls");
    this.panel.element.addEventListener("pointerdown", (e) =>
      e.stopPropagation(),
    );
    if (this.assets) await this.atlas.loadUrl(this.assets.cards);
  }
  resize(): void {}
  cancelInput(): void {
    this.drag.cancel();
    this.hovered = undefined;
    this.pointer = undefined;
    this.modifierDrag = undefined;
    for (const view of this.cards.values()) view.root.skew.set(0, 0);
    for (const view of this.modifierViews.values()) view.root.skew.set(0, 0);
  }
  fastForwardReveal(): void {
    this.queue.fastForward();
  }
  input(action: string): void {
    const s = this.session;
    if (action === "play") s.play();
    else if (action === "discard") s.discard();
    else if (action === "hand-left" || action === "hand-right") {
      const state = s.state;
      const from = state.zones.hand.indexOf(state.selected[0]);
      s.reorderHand(from, from + (action === "hand-left" ? -1 : 1));
    } else if (action === "skip") {
      this.fastForwardReveal();
      s.advanceReveal(0, true);
    } else if (action === "next") s.next();
    else if (action === "reroll") s.reroll();
    else if (action.startsWith("select:")) s.toggle(action.slice(7));
  }
  private artwork(): void {
    const s = this.session.state,
      art = this.assets?.art;
    if (!art) return;
    const key = JSON.stringify([
      s.phase,
      s.money,
      s.consumables,
      s.consumableOffer,
      s.boss,
      s.encounter,
    ]);
    if (key === this.artKey) return;
    this.artKey = key;
    this.decoration
      .removeChildren()
      .forEach((c) => c.destroy({ children: true }));
    const heading = new Text({
      text: "FIELD KIT",
      style: {
        fontFamily: "Georgia",
        fontSize: 12,
        fill: 0xb6c2ab,
        letterSpacing: 3,
      },
    });
    heading.position.set(180, 572);
    this.decoration.addChild(heading);
    for (const [i, d] of this.session.definition.consumables.entries()) {
      const iconDefinition = art.consumables[d.id];
      if (!iconDefinition) continue;
      const icon = vectorCardIcon(iconDefinition);
      icon.position.set(245 + i * 155, 620);
      const owned = s.consumables.filter((id) => id === d.id).length,
        offered = s.phase === "shop" && s.consumableOffer === d.id;
      icon.alpha = owned || offered ? 1 : 0.42;
      const label = new Text({
        text: `${iconDefinition.label}${offered ? ` · $${d.price}` : owned ? ` · ${owned}` : ""}`,
        style: { fill: 0xf4e7c2, fontFamily: "Georgia", fontSize: 12 },
      });
      label.anchor.set(0.5, 0);
      label.y = 34;
      icon.addChild(label);
      icon.eventMode = "static";
      icon.cursor = owned || offered ? "pointer" : "default";
      icon.on("pointertap", () => {
        if (offered) this.session.buy(d.id);
        else {
          const index = this.session.state.consumables.indexOf(d.id);
          if (index >= 0)
            this.session.use(
              index,
              this.session.state.selected[0] ?? this.session.state.deck[0].id,
            );
        }
      });
      this.decoration.addChild(icon);
    }
    for (const [i, [id, definition]] of Object.entries(art.bosses).entries()) {
      const badge = vectorCardIcon(definition);
      badge.scale.set(0.7);
      badge.position.set(1015 + i * 85, 111);
      badge.alpha = id === s.boss ? 1 : 0.2;
      this.decoration.addChild(badge);
    }
    const label = new Text({
      text: `${this.session.isBoss ? "ACTIVE" : "ANTE"} RESTRICTION`,
      style: {
        fill: 0xe2c997,
        fontFamily: "Georgia",
        fontSize: 11,
        letterSpacing: 1,
      },
    });
    label.position.set(965, 67);
    this.decoration.addChild(label);
  }
  private updatePanel(): void {
    const session = this.session,
      s = session.state,
      key = JSON.stringify([
        s.revision,
        s.phase,
        s.selected,
        s.money,
        s.offers,
        s.consumableOffer,
        s.consumables,
        s.error,
      ]);
    if (key === this.panelKey) return;
    this.panelKey = key;
    const lines = [
      `${session.definition.title} · Encounter ${s.encounter + 1}/6 · ${s.score}/${session.target} · $${s.money}`,
      `${s.hands} hands · ${s.discards} discards · Deck ${s.deck.length}`,
    ];
    if (s.encounter === 0 && s.phase === "blind")
      lines.push(...(this.assets?.art?.guide ?? []));
    if (session.isBoss || s.encounter % 3 === 1)
      lines.push(
        `Restriction: ${s.boss === "suit" ? `${s.bossSuit} contribute zero rank chips` : s.boss === "no-discards" ? "No discards" : "First category cannot be repeated"}`,
      );
    if (s.lastResult) {
      lines.push(
        `Last hand: ${s.lastResult.category} · ${s.lastResult.chips} × ${s.lastResult.mult} = ${s.lastResult.score}`,
      );
      lines.push(
        ...s.lastResult.trace.map(
          (step) =>
            `${step.source}: ${step.operation} ${step.before} → ${step.after}`,
        ),
      );
    }
    if (s.error) lines.push(s.error);
    const choices: { id: string; label: string; disabled?: boolean }[] = [];
    if (s.phase === "blind") {
      choices.push(
        { id: "play", label: "Play selected", disabled: !s.selected.length },
        {
          id: "discard",
          label: "Discard selected",
          disabled: !s.selected.length || !s.discards,
        },
      );
      const selectedIndex = s.zones.hand.indexOf(s.selected[0]);
      choices.push(
        {
          id: "hand-left",
          label: "Move first selected card left",
          disabled: selectedIndex <= 0,
        },
        {
          id: "hand-right",
          label: "Move first selected card right",
          disabled:
            selectedIndex < 0 || selectedIndex === s.zones.hand.length - 1,
        },
      );
      const p = session.preview();
      if (p)
        lines.push(
          `Preview: ${p.category} · ${p.chips} × ${p.mult} = ${p.score}`,
        );
      for (const c of session.cards)
        choices.push({
          id: `select:${c.id}`,
          label: `${s.selected.includes(c.id) ? "✓ " : ""}${c.rank === 14 ? "A" : c.rank === 13 ? "K" : c.rank === 12 ? "Q" : c.rank === 11 ? "J" : c.rank} ${c.suit}`,
        });
    }
    if (s.phase === "reveal")
      choices.push({ id: "skip", label: "Finish score reveal" });
    if (s.phase === "shop") {
      lines.push("Shop: reorder your modifier row before the next encounter.");
      for (const id of s.offers) {
        const d = session.definition.modifiers.find((d) => d.id === id)!;
        lines.push(`${d.name}: ${d.description}`);
        choices.push({
          id: `buy:${id}`,
          label: `Buy ${d.name} $${d.price}`,
          disabled: s.money < d.price || s.modifiers.length >= 5,
        });
      }
      const c = session.definition.consumables.find(
        (c) => c.id === s.consumableOffer,
      );
      if (c)
        choices.push({
          id: `buy:${c.id}`,
          label: `Buy ${c.name} $${c.price}`,
          disabled: s.money < c.price || s.consumables.length >= 2,
        });
      choices.push(
        {
          id: "reroll",
          label: `Reroll $${5 + s.rerolls}`,
          disabled: s.money < 5 + s.rerolls,
        },
        { id: "next", label: "Enter next encounter" },
      );
    }
    for (let i = 0; i < s.modifiers.length; i++) {
      const m = s.modifiers[i],
        d = session.definition.modifiers.find((d) => d.id === m.definitionId)!;
      lines.push(
        `${i + 1}. ${d.name} — ${d.description}${m.growth ? ` (+${m.growth} stored)` : ""}`,
      );
      if (i > 0)
        choices.push({
          id: `left:${i}`,
          label: `Move ${d.name} left`,
          disabled: s.phase === "reveal",
        });
      if (i < s.modifiers.length - 1)
        choices.push({
          id: `right:${i}`,
          label: `Move ${d.name} right`,
          disabled: s.phase === "reveal",
        });
      if (s.phase === "shop")
        choices.push({
          id: `sell:${m.instanceId}`,
          label: `Sell ${d.name} $${Math.floor(d.price / 2)}`,
        });
    }
    for (let i = 0; i < s.consumables.length; i++) {
      const d = session.definition.consumables.find(
        (d) => d.id === s.consumables[i],
      )!;
      choices.push({
        id: `use:${i}`,
        label: `Use ${d.name}${d.effect === "level" ? " on Pair" : " on selected/first card"}`,
        disabled: !["blind", "shop"].includes(s.phase),
      });
    }
    if (s.phase === "won")
      lines.push("The final ledger is balanced. Run complete.");
    if (s.phase === "lost")
      lines.push("Out of hands. Restart with the shell button.");
    this.panel?.render(lines, choices, (id) => {
      if (id.startsWith("buy:")) session.buy(id.slice(4));
      else if (id.startsWith("sell:")) session.sell(id.slice(5));
      else if (id.startsWith("left:"))
        session.reorder(+id.slice(5), +id.slice(5) - 1);
      else if (id.startsWith("right:"))
        session.reorder(+id.slice(6), +id.slice(6) + 1);
      else if (id.startsWith("use:"))
        session.use(+id.slice(4), s.selected[0] ?? s.deck[0].id);
      else this.input(id);
    });
  }
  render(dt: number): void {
    this.clock += dt;
    this.felt.update(this.reduced ? 0 : this.clock);
    this.artwork();
    this.foil.update(this.clock, 0, 0, this.reduced);
    const s = this.session.state;
    if (
      s.phase === "reveal" &&
      s.lastResult &&
      this.transaction !== s.lastResult.transactionId
    ) {
      this.queue.clear();
      this.transaction = s.lastResult.transactionId;
      const trace = s.lastResult.trace;
      const descriptors = trace.map((step, i) => ({
        id: `${this.transaction}:${i}`,
        lane: "score",
        duration: 0.16,
        blocking: true,
        run: (skipped?: boolean) => {
          if (!skipped || i === trace.length - 1)
            this.cue?.(
              step.operation === "multiply"
                ? "multiply"
                : step.operation === "score"
                  ? "score"
                  : "tick",
              1 + Math.min(i, 24) * 0.035,
            );
          this.visible = `${step.source}: ${step.operation} ${step.before} → ${step.after}`;
        },
      }));
      if (this.restoredQueue) {
        this.queue.restore(this.restoredQueue, descriptors);
        this.restoredQueue = undefined;
      } else
        for (const event of descriptors.slice(s.revealCursor))
          this.queue.enqueue(event);
    }

    this.queue.update(dt);
    this.status.text =
      s.phase === "reveal"
        ? this.visible
        : `${this.session.definition.title}     ${s.score.toLocaleString()} / ${this.session.target.toLocaleString()}`;
    const ids = new Set(s.zones.hand);
    for (const [id, v] of this.cards)
      if (!ids.has(id)) {
        v.root.destroy({ children: true });
        this.cards.delete(id);
      }
    const cards = this.session.cards;
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const signature = `${card.rank}:${card.suit}:${card.enhancement ?? ""}`;
      let view = this.cards.get(card.id);
      if (view && view.signature !== signature) {
        view.root.destroy({ children: true });
        this.cards.delete(card.id);
        view = undefined;
      }
      if (!view) {
        const root = new Container(),
          spring = new SpringTransform(),
          red = card.suit === "hearts" || card.suit === "diamonds";
        root.eventMode = "static";
        root.cursor = "pointer";
        root.addChild(
          new Graphics()
            .roundRect(-49, -66, 104, 144, 10)
            .fill({ color: 0x020d0b, alpha: 0.4 }),
          new Graphics()
            .roundRect(-54, -76, 104, 144, 10)
            .fill(0xfff6df)
            .stroke({
              color: card.enhancement ? 0xe9b146 : 0xd4c5a6,
              width: 3,
            }),
        );
        const ranks: Record<number, string> = {
            11: "J",
            12: "Q",
            13: "K",
            14: "A",
          },
          symbols = { hearts: "♥", diamonds: "♦", clubs: "♣", spades: "♠" };
        let face: Sprite | undefined, textureKey: string | undefined;
        if (this.assets) {
          const rank =
            card.rank === 14
              ? "A"
              : card.rank === 13
                ? "K"
                : card.rank === 12
                  ? "Q"
                  : card.rank === 11
                    ? "J"
                    : String(card.rank).padStart(2, "0");
          textureKey =
            this.assets.art?.cards?.faces?.[`${card.suit}.${card.rank}`] ??
            this.assets.art?.cards?.face ??
            `card_${card.suit}_${rank}`;
          face = new Sprite(
            this.atlas.texture(this.assets.art?.cards?.back ?? "card_back"),
          );
          face.anchor.set(0.5);
          face.width = 100;
          face.height = 140;
          face.y = -5;
          if (!this.assets.art?.cards) face.filters = [this.foil];
          root.addChild(face);
          const layers = this.assets.art?.cards;
          for (const frame of [
            layers?.border,
            card.enhancement ? layers?.editions?.[card.enhancement] : undefined,
          ]) {
            if (!frame) continue;
            const layer = new Sprite(this.atlas.texture(frame));
            layer.anchor.set(0.5);
            layer.width = 100;
            layer.height = 140;
            layer.y = -5;
            root.addChild(layer);
          }
        }
        const label = new Text({
          text: `${ranks[card.rank] ?? card.rank}\n${symbols[card.suit]}`,
          style: {
            fontFamily: "Georgia",
            fontSize: 32,
            fill: this.assets?.art?.cards
              ? red
                ? 0xffb5a8
                : 0xfff4d7
              : red
                ? 0xb23542
                : 0x183d43,
            align: "center",
          },
        });
        label.anchor.set(0.5);
        label.y = -8;
        if (!this.assets || this.assets.art?.cards) root.addChild(label);
        const outline = new Graphics();
        root.addChild(outline);
        spring.x = 640;
        spring.y = 760;
        root.on("pointerdown", (event) => {
          const p = event.getLocalPosition(this.root);
          if (this.session.state.phase !== "blind") return;
          this.drag.begin(card.id, p.x, p.y);
          this.pointer = { id: card.id, x: p.x, y: p.y, drag: false };
        });
        root.on("pointermove", (event) => {
          const local = event.getLocalPosition(root);
          this.foil.update(this.clock, local.x / 100, local.y / 140);
          if (!this.reduced)
            root.skew.set(
              Math.max(-0.06, Math.min(0.06, local.y / 1000)),
              Math.max(-0.05, Math.min(0.05, local.x / 1200)),
            );
          if (this.pointer?.id === card.id) {
            const p = event.getLocalPosition(this.root);
            this.pointer.drag = this.drag.move(card.id, p.x, p.y);
            if (this.pointer.drag) {
              spring.target.x = p.x;
              spring.target.y = p.y;
            }
          }
        });
        const release = () => {
          if (this.pointer?.id === card.id) {
            const gesture = this.drag.release(card.id);
            if (gesture === "tap") this.session.toggle(card.id);
            else if (gesture === "drop") {
              const from = this.session.state.zones.hand.indexOf(card.id),
                n = this.session.state.zones.hand.length,
                to = cardRowLayout(n, 1120, 108, 125).index(
                  spring.target.x - 80,
                );
              this.session.reorderHand(from, Math.max(0, Math.min(n - 1, to)));
            }
            this.pointer = undefined;
          }
        };
        root.on("pointerup", release);
        root.on("pointerupoutside", release);
        root.on("pointerover", () => {
          this.hovered = card.id;
        });
        root.on("pointerout", () => {
          root.skew.set(0, 0);
          if (this.hovered === card.id) this.hovered = undefined;
        });
        root.on("pointercancel", () => {
          if (!this.reduced) root.skew.set(0, 0);
          this.drag.cancel();
          this.pointer = undefined;
        });
        this.root.addChild(root);
        view = {
          root,
          spring,
          label,
          selected: false,
          signature,
          flip: 0,
          face,
          textureKey,
          outline,
        };
        this.cards.set(card.id, view);
      }
      const selected = s.selected.includes(card.id);
      view.outline.clear();
      if (selected || this.hovered === card.id)
        view.outline.roundRect(-55, -77, 108, 146, 8).stroke({
          color: selected
            ? (this.assets?.art?.states?.selected ?? 0xffdc7d)
            : (this.assets?.art?.states?.focus ?? 0xffffff),
          width: selected ? 4 : 2,
        });
      view.root.alpha =
        s.phase === "blind"
          ? 1
          : (this.assets?.art?.states?.disabledAlpha ?? 0.65);
      if (selected !== view.selected) {
        if (!this.reduced) view.spring.juice(0.08);
        view.selected = selected;
      }
      if (this.pointer?.id !== card.id || !this.pointer.drag) {
        view.spring.target.x =
          80 + cardRowLayout(cards.length, 1120, 108, 125).x(i);
        view.spring.target.y =
          460 + (selected ? -35 : 0) + Math.abs(i - (cards.length - 1) / 2) * 4;
      }
      view.spring.target.rotation = (i - (cards.length - 1) / 2) * 0.025;
      view.spring.update(dt, view.root);
      view.flip = this.reduced ? 1 : Math.min(1, view.flip + dt * 5);
      if (view.flip >= 0.5 && view.face && view.textureKey)
        view.face.texture = this.atlas.texture(view.textureKey);
      view.root.scale.x *= Math.max(
        0.06,
        Math.abs(Math.cos(view.flip * Math.PI)),
      );
    }
    for (let i = 0; i < s.modifiers.length; i++) {
      const m = s.modifiers[i],
        d = this.session.definition.modifiers.find(
          (d) => d.id === m.definitionId,
        )!;
      let v = this.modifierViews.get(m.instanceId);
      if (!v) {
        const root = new Container(),
          spring = new SpringTransform(),
          color = [
            0xb38340, 0xab4757, 0x6d8c89, 0x517e9a, 0x8899a2, 0xa18ba1,
            0xd2b370, 0x6f9e79, 0x7d6569, 0x92b6b6, 0x9f9273, 0x747481,
          ][
            this.session.definition.modifiers.findIndex(
              (item) => item.id === d.id,
            ) % 12
          ];
        root.addChild(
          new Graphics()
            .roundRect(-72, -55, 144, 110, 9)
            .fill({ color, alpha: this.assets?.art?.modifiers?.[d.id] ? 0 : 1 })
            .stroke({
              color: 0xf4d8a0,
              width: this.assets?.art?.modifiers?.[d.id] ? 0 : 2,
            }),
        );
        const art = new Graphics()
          .circle(0, -12, 25)
          .stroke({ color: 0xf4dfb0, width: 3 });
        const count =
          3 +
          (this.session.definition.modifiers.findIndex(
            (item) => item.id === d.id,
          ) %
            6);
        for (let j = 0; j < count; j++) {
          const a = (j / count) * Math.PI * 2;
          art
            .moveTo(0, -12)
            .lineTo(Math.cos(a) * 34, Math.sin(a) * 34 - 12)
            .stroke({ color: 0x283a3c, width: 3 });
        }
        const frame = this.assets?.art?.modifiers?.[d.id];
        if (frame) {
          const illustration = new Sprite(this.atlas.texture(frame));
          illustration.anchor.set(0.5);
          illustration.width = 100;
          illustration.height = 130;
          illustration.y = -10;
          root.addChild(illustration);
        } else root.addChild(art);
        const name = new Text({
          text: d.name,
          style: {
            fontFamily: "Georgia",
            fontSize: 15,
            fill: 0xfff1cf,
            align: "center",
            wordWrap: true,
            wordWrapWidth: 135,
          },
        });
        name.anchor.set(0.5, 0);
        name.y = 58;
        root.addChild(name);
        root.eventMode = "static";
        root.cursor = "grab";
        root.on("pointerdown", (event) => {
          if (this.session.state.phase === "reveal") return;
          const p = event.getLocalPosition(this.root);
          this.modifierDrag = {
            id: m.instanceId,
            x: p.x,
            y: p.y,
            moved: false,
          };
        });
        root.on("pointermove", (event) => {
          const local = event.getLocalPosition(root);
          this.foil.update(this.clock, local.x / 100, local.y / 140);
          if (!this.reduced)
            root.skew.set(
              Math.max(-0.06, Math.min(0.06, local.y / 1000)),
              Math.max(-0.05, Math.min(0.05, local.x / 1200)),
            );
          if (this.modifierDrag?.id !== m.instanceId) return;
          const p = event.getLocalPosition(this.root);
          if (
            Math.hypot(p.x - this.modifierDrag.x, p.y - this.modifierDrag.y) >
            10
          )
            this.modifierDrag.moved = true;
          if (this.modifierDrag.moved) {
            spring.target.x = p.x;
            spring.target.y = p.y;
          }
        });
        const release = () => {
          if (this.modifierDrag?.id === m.instanceId) {
            if (this.modifierDrag.moved) {
              const from = this.session.state.modifiers.findIndex(
                  (m) => m.instanceId === this.modifierDrag!.id,
                ),
                to = Math.max(
                  0,
                  Math.min(
                    this.session.state.modifiers.length - 1,
                    cardRowLayout(
                      this.session.state.modifiers.length,
                      980,
                      150,
                      190,
                    ).index(spring.target.x - 150),
                  ),
                );
              this.session.reorder(from, to);
            }
            this.modifierDrag = undefined;
          }
        };
        root.on("pointerup", release);
        root.on("pointerupoutside", release);
        root.on("pointercancel", () => {
          this.modifierDrag = undefined;
        });
        spring.x = 150 + cardRowLayout(s.modifiers.length, 980, 150, 190).x(i);
        spring.y = 230;
        this.root.addChild(root);
        v = { root, spring };
        this.modifierViews.set(m.instanceId, v);
      }
      if (this.modifierDrag?.id !== m.instanceId || !this.modifierDrag.moved) {
        v.spring.target.x =
          150 + cardRowLayout(s.modifiers.length, 980, 150, 190).x(i);
        v.spring.target.y = 230;
      }
      v.spring.update(dt, v.root);
    }
    for (const [id, v] of this.modifierViews)
      if (!s.modifiers.some((m) => m.instanceId === id)) {
        v.root.destroy({ children: true });
        this.modifierViews.delete(id);
      }
    this.updatePanel();
  }
  snapshot(): unknown {
    return { queue: this.queue.snapshot(), visible: this.visible };
  }
  restore(value: unknown): void {
    const saved = validateCardRunPresentation(value);
    this.transaction = -1;
    this.queue.clear();
    this.restoredQueue = saved?.queue;
    this.visible = saved?.visible ?? "";
  }
  dispose(): void {
    this.queue.clear();
    const host = this.panel?.element.parentElement;
    this.panel?.dispose();
    host?.remove();
    this.root.destroy({ children: true });
    this.atlas.dispose();
    this.foil.destroy();
    this.felt.destroy();
    this.cards.clear();
  }
}
