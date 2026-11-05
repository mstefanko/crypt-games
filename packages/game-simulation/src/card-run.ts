/** Single-consumer card genre owner. App supplies all names, prices and scoring tables. */
import { DeterministicRandom } from "./rng";
import {
  standardDeck,
  shuffleCards,
  transferCards,
  type PlayingCard,
  type CardZones,
  type CardSuit,
} from "./card-zones";
import { classifyPoker, type PokerCategory } from "./poker";
import {
  RuleBudget,
  evaluateCondition,
  type RuleCondition,
  type EffectTrace,
} from "./rules";
export type CardModifierEffect =
  | "chips"
  | "heart-mult"
  | "pair-mult"
  | "short-mult"
  | "multiply"
  | "retrigger"
  | "held-king-money"
  | "growing-chips"
  | "last-multiply"
  | "fragile-multiply"
  | "discard-chips"
  | "copy";
export interface CardModifierDefinition {
  id: string;
  name: string;
  description: string;
  price: number;
  effect: CardModifierEffect;
  value: number;
  condition?: RuleCondition;
}
export interface CardConsumableDefinition {
  id: string;
  name: string;
  description: string;
  price: number;
  effect: "remove" | "duplicate" | "suit" | "chips" | "mult" | "level";
}
export interface CardRunDefinition {
  title: string;
  targets: readonly number[];
  base: Record<PokerCategory, { chips: number; mult: number }>;
  modifiers: readonly CardModifierDefinition[];
  consumables: readonly CardConsumableDefinition[];
  startingModifiers?: string[];
}
export interface OwnedModifier {
  instanceId: string;
  definitionId: string;
  growth: number;
}
export interface CardScoreResult {
  transactionId: number;
  category: PokerCategory;
  chips: number;
  mult: number;
  score: number;
  trace: readonly EffectTrace[];
}
export interface CardRunState {
  revision: number;
  deck: PlayingCard[];
  zones: CardZones;
  selected: string[];
  modifiers: OwnedModifier[];
  consumables: string[];
  levels: Record<string, number>;
  encounter: number;
  score: number;
  hands: number;
  discards: number;
  money: number;
  phase: "blind" | "reveal" | "shop" | "won" | "lost";
  boss: "suit" | "no-discards" | "unique-category";
  bossSuit: CardSuit;
  firstCategory?: PokerCategory;
  offers: string[];
  consumableOffer: string;
  rerolls: number;
  nextId: number;
  lastResult?: CardScoreResult;
  revealCursor: number;
  revealDelay: number;
  postRevealPhase?: "blind" | "shop" | "won" | "lost";
  error?: string;
}
export type CardRunObservation<T> = T extends object
  ? { readonly [K in keyof T]: CardRunObservation<T[K]> }
  : T;

export class CardRunSession {
  #state: CardRunState;
  #definition: CardRunDefinition;
  #seed: number;
  get seed(): number {
    return this.#seed;
  }
  get state(): CardRunObservation<CardRunState> {
    return structuredClone(this.#state);
  }
  get definition(): CardRunObservation<CardRunDefinition> {
    return structuredClone(this.#definition);
  }
  #random: DeterministicRandom;
  constructor(definition: CardRunDefinition, seed: number) {
    this.#seed = seed;
    this.#definition = structuredClone(definition);
    this.#random = new DeterministicRandom([
      { name: "cards", owner: "card-run", seed: seed >>> 0 },
    ]);
    this.#state = {
      revision: 0,
      deck: standardDeck(),
      zones: { draw: [], hand: [], discard: [], played: [] },
      selected: [],
      modifiers: (definition.startingModifiers ?? []).map(
        (definitionId, i) => ({
          instanceId: `modifier-${i}`,
          definitionId,
          growth: 0,
        }),
      ),
      consumables: [],
      levels: {},
      encounter: 0,
      score: 0,
      hands: 4,
      discards: 3,
      money: 8,
      phase: "blind",
      boss: "suit",
      bossSuit: "spades",
      offers: [],
      consumableOffer: "",
      rerolls: 0,
      nextId: 20,
      revealCursor: 0,
      revealDelay: 0,
    };
    this.beginBlind();
  }
  private draw = (max: number) =>
    this.#random.drawInteger("card-run", "cards", max);
  private fill(): void {
    while (this.#state.zones.hand.length < 8 && this.#state.zones.draw.length)
      this.#state.zones = transferCards(this.#state.zones, "draw", "hand", [
        this.#state.zones.draw[0],
      ]);
  }
  private beginBlind(): void {
    const s = this.#state;
    s.zones = {
      draw: shuffleCards(
        s.deck.map((c) => c.id),
        this.draw,
      ),
      hand: [],
      discard: [],
      played: [],
    };
    s.phase = "blind";
    s.hands = 4;
    s.discards = 3;
    s.score = 0;
    s.firstCategory = undefined;
    s.selected = [];
    if (s.encounter % 3 === 0) {
      s.boss = (["suit", "no-discards", "unique-category"] as const)[
        this.draw(3)
      ];
      s.bossSuit = (["hearts", "diamonds", "clubs", "spades"] as const)[
        this.draw(4)
      ];
    }
    if (this.isBoss && s.boss === "no-discards") s.discards = 0;
    this.fill();
  }
  get isBoss(): boolean {
    return this.#state.encounter % 3 === 2;
  }
  get target(): number {
    return this.#definition.targets[this.#state.encounter];
  }
  get cards(): readonly CardRunObservation<PlayingCard>[] {
    return structuredClone(
      this.#state.zones.hand.map(
        (id) => this.#state.deck.find((c) => c.id === id)!,
      ),
    );
  }
  toggle(id: string): void {
    const s = this.#state;
    if (s.phase !== "blind" || !s.zones.hand.includes(id)) return;
    if (s.selected.includes(id))
      s.selected = s.selected.filter((x) => x !== id);
    else if (s.selected.length < 5) s.selected.push(id);
  }
  reorder(from: number, to: number): void {
    if (this.#state.phase !== "blind" && this.#state.phase !== "shop") return;
    const list = this.#state.modifiers;
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 0 ||
      to < 0 ||
      from >= list.length ||
      to >= list.length
    )
      return;
    list.splice(to, 0, list.splice(from, 1)[0]);
    this.#state.revision++;
  }
  reorderHand(from: number, to: number): void {
    const s = this.#state;
    if (
      s.phase !== "blind" ||
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 0 ||
      to < 0 ||
      from >= s.zones.hand.length ||
      to >= s.zones.hand.length
    )
      return;
    s.zones.hand.splice(to, 0, s.zones.hand.splice(from, 1)[0]);
    s.revision++;
  }
  discard(): void {
    const s = this.#state;
    if (s.phase !== "blind" || !s.discards || !s.selected.length) return;
    s.zones = transferCards(s.zones, "hand", "discard", s.selected);
    s.selected = [];
    s.discards--;
    s.revision++;
    this.fill();
  }
  private resolve(): { state: CardRunState; result: CardScoreResult } {
    const s = structuredClone(this.#state),
      budget = new RuleBudget(64),
      trace: EffectTrace[] = [];
    const cards = s.zones.hand
      .filter((id) => s.selected.includes(id))
      .map((id) => s.deck.find((c) => c.id === id)!);
    const hand = classifyPoker(cards);
    if (
      this.isBoss &&
      s.boss === "unique-category" &&
      s.firstCategory === hand.category
    )
      throw Error("This category is barred by the encounter");
    const level = s.levels[hand.category] ?? 0;
    let chips = this.#definition.base[hand.category].chips + level * 10,
      mult = (this.#definition.base[hand.category].mult + level) * 1000,
      money = 0;
    const step = (
      source: string,
      operation: "chips" | "mult" | "multiply" | "money",
      value: number,
    ) => {
      budget.step();
      const before =
        operation === "chips"
          ? chips
          : operation === "money"
            ? money
            : mult / 1000;
      if (operation === "chips") chips += value;
      else if (operation === "money") money += value;
      else if (operation === "mult") mult += Math.round(value * 1000);
      else mult = Math.round(mult * value);
      const after =
        operation === "chips"
          ? chips
          : operation === "money"
            ? money
            : mult / 1000;
      if (!Number.isSafeInteger(chips) || !Number.isSafeInteger(mult))
        throw Error("Score exceeds safe integer bounds");
      trace.push({ source, operation, before, after });
    };
    trace.push({
      source: hand.category,
      operation: "base",
      before: 0,
      after: chips,
    });
    const eligible = s.modifiers.filter((m) => {
      const d = this.#definition.modifiers.find(
        (x) => x.id === m.definitionId,
      )!;
      return evaluateCondition(d.condition, {
        flags: {},
        inventory: {},
        stats: { played: cards.length, discards: s.discards, hands: s.hands },
        facts: { category: hand.category },
      });
    });
    const scoreCard = (card: PlayingCard) => {
      step(
        card.id,
        "chips",
        this.isBoss && s.boss === "suit" && card.suit === s.bossSuit
          ? 0
          : card.rank === 14
            ? 11
            : Math.min(10, card.rank),
      );
      if (card.enhancement === "chips") step(card.id, "chips", 30);
      if (card.enhancement === "mult") step(card.id, "mult", 4);
      if (card.edition === "foil") step(card.id, "chips", 20);
      for (const [index, m] of eligible.entries()) {
        const d = this.#definition.modifiers.find(
          (x) => x.id === m.definitionId,
        )!;
        if (d.effect === "heart-mult" && card.suit === "hearts")
          step(m.instanceId, "mult", d.value);
        if (d.effect === "copy" && card.suit === "hearts") {
          const previous = s.modifiers[s.modifiers.indexOf(m) - 1],
            source =
              previous &&
              this.#definition.modifiers.find(
                (x) => x.id === previous.definitionId,
              );
          if (source?.effect === "heart-mult" && eligible.includes(previous))
            step(m.instanceId, "mult", source.value);
        }
      }
    };
    const contributing = cards.filter((c) => hand.contributing.includes(c.id));
    for (const card of contributing) scoreCard(card);
    for (const source of eligible) {
      if (
        contributing.length &&
        this.#definition.modifiers.find((d) => d.id === source.definitionId)
          ?.effect === "retrigger"
      ) {
        budget.step();
        trace.push({
          source: source.instanceId,
          operation: "retrigger",
          before: 0,
          after: 1,
        });
        scoreCard(contributing[0]);
      }
    }

    const apply = (
      m: OwnedModifier,
      d: CardModifierDefinition,
      copiedGrowth?: number,
    ) => {
      switch (d.effect) {
        case "chips":
          step(m.instanceId, "chips", d.value);
          break;
        case "pair-mult":
          if (
            [
              "pair",
              "two-pair",
              "full-house",
              "three-kind",
              "four-kind",
            ].includes(hand.category)
          )
            step(m.instanceId, "mult", d.value);
          break;
        case "short-mult":
          if (cards.length <= 3) step(m.instanceId, "mult", d.value);
          break;
        case "multiply":
        case "fragile-multiply":
          step(m.instanceId, "multiply", d.value);
          break;
        case "last-multiply":
          if (s.hands === 1) step(m.instanceId, "multiply", d.value);
          break;
        case "growing-chips":
          if (d.id === m.definitionId) m.growth += d.value;
          step(
            m.instanceId,
            "chips",
            d.id === m.definitionId ? m.growth : (copiedGrowth ?? 0),
          );
          break;
        case "discard-chips":
          step(m.instanceId, "chips", d.value * s.discards);
          break;
      }
    };
    for (let i = 0; i < eligible.length; i++) {
      const m = eligible[i],
        d = this.#definition.modifiers.find((x) => x.id === m.definitionId)!;
      if (d.effect === "copy") {
        const previous = s.modifiers[s.modifiers.indexOf(m) - 1];
        const source =
          previous &&
          this.#definition.modifiers.find(
            (x) => x.id === previous.definitionId,
          );
        if (
          source &&
          eligible.includes(previous) &&
          !["copy", "retrigger", "held-king-money", "heart-mult"].includes(
            source.effect,
          )
        )
          apply(m, { ...source }, previous.growth);
      } else apply(m, d);
    }
    budget.step();
    const score = Math.floor((chips * mult) / 1000);
    if (!Number.isSafeInteger(score))
      throw Error("Score exceeds safe integer bounds");
    trace.push({
      source: "hand",
      operation: "score",
      before: s.score,
      after: s.score + score,
    });
    s.score += score;
    s.money += money;
    s.hands--;
    s.firstCategory ??= hand.category;
    s.zones = transferCards(s.zones, "hand", "played", s.selected);
    s.selected = [];
    s.revision++;
    const result = {
      transactionId: s.revision,
      category: hand.category,
      chips,
      mult: mult / 1000,
      score,
      trace: Object.freeze(trace.map((t) => Object.freeze(t))),
    };
    s.lastResult = result;
    s.phase = "reveal";
    s.revealCursor = 0;
    s.revealDelay = 0;
    return { state: s, result };
  }
  preview(): CardRunObservation<CardScoreResult> | undefined {
    try {
      return this.resolve().result;
    } catch {
      return undefined;
    }
  }
  play(): void {
    if (this.#state.phase !== "blind" || !this.#state.selected.length) return;
    const original = this.#state,
      rng = this.#random.capture();
    try {
      this.#state = this.resolve().state;
      const s = this.#state;
      if (s.score >= this.target) {
        const previousMoney = s.money;
        for (const m of s.modifiers) {
          const d = this.#definition.modifiers.find(
            (d) => d.id === m.definitionId,
          )!;
          if (d.effect === "held-king-money")
            s.money +=
              Math.min(
                3,
                s.zones.hand.filter(
                  (id) => s.deck.find((c) => c.id === id)?.rank === 13,
                ).length,
              ) * d.value;
        }
        s.money += 4 + s.hands;
        s.lastResult = {
          ...s.lastResult!,
          trace: Object.freeze([
            ...s.lastResult!.trace,
            Object.freeze({
              source: "round",
              operation: "money",
              before: previousMoney,
              after: s.money,
            }),
          ]),
        };
        s.modifiers = s.modifiers.filter(
          (m) =>
            this.#definition.modifiers.find((d) => d.id === m.definitionId)
              ?.effect !== "fragile-multiply",
        );
        if (s.encounter === this.#definition.targets.length - 1)
          s.postRevealPhase = "won";
        else {
          s.postRevealPhase = "shop";
          s.rerolls = 0;
          this.rollShop();
        }
      } else if (s.hands === 0) s.postRevealPhase = "lost";
      else {
        s.postRevealPhase = "blind";
        this.fill();
      }
    } catch (error) {
      this.#state = original;
      this.#random.restore(rng);
      this.#state.error = String(error);
    }
  }
  /** Explicit simulation-time reveal cadence; scoring was committed by play(). */
  stepReveal(dt: number): void {
    if (!Number.isFinite(dt) || dt < 0)
      throw Error("Invalid card reveal delta");
    const s = this.#state;
    if (s.phase !== "reveal" || !s.lastResult) return;
    s.revealDelay += dt;
    while (s.phase === "reveal" && s.revealDelay + 1e-12 >= 0.16) {
      s.revealDelay = Math.max(0, s.revealDelay - 0.16);
      this.advanceReveal();
    }
  }
  /** Presentation progress only: committed hand effects are never evaluated here. */
  advanceReveal(_dt = 0, skip = false): void {
    const s = this.#state;
    if (s.phase !== "reveal" || !s.lastResult) return;
    s.revealCursor = skip
      ? s.lastResult.trace.length
      : Math.min(s.lastResult.trace.length, s.revealCursor + 1);
    if (s.revealCursor === s.lastResult.trace.length) {
      s.revealDelay = 0;
      s.phase = s.postRevealPhase ?? "blind";
      s.postRevealPhase = undefined;
    }
  }
  private rollShop(): void {
    const s = this.#state;
    s.offers = shuffleCards(
      this.#definition.modifiers.map((d) => d.id),
      this.draw,
    ).slice(0, 2);
    if (s.encounter === 0 && s.rerolls === 0)
      s.offers[0] =
        this.#definition.modifiers.find((d) => d.price <= s.money)?.id ??
        s.offers[0];
    s.consumableOffer =
      this.#definition.consumables[
        this.draw(this.#definition.consumables.length)
      ].id;
  }
  buy(id: string): void {
    const s = this.#state;
    if (s.phase !== "shop") return;
    const d = this.#definition.modifiers.find((d) => d.id === id);
    if (
      d &&
      s.offers.includes(id) &&
      s.modifiers.length < 5 &&
      s.money >= d.price
    ) {
      s.money -= d.price;
      s.modifiers.push({
        instanceId: `modifier-${s.nextId++}`,
        definitionId: id,
        growth: 0,
      });
      s.offers = s.offers.filter((x) => x !== id);
      s.revision++;
      return;
    }
    const c = this.#definition.consumables.find((c) => c.id === id);
    if (
      c &&
      s.consumableOffer === id &&
      s.consumables.length < 2 &&
      s.money >= c.price
    ) {
      s.money -= c.price;
      s.consumables.push(id);
      s.consumableOffer = "";
      s.revision++;
    }
  }
  sell(instanceId: string): void {
    const s = this.#state;
    if (s.phase !== "shop") return;
    const m = s.modifiers.find((m) => m.instanceId === instanceId);
    if (!m) return;
    s.money += Math.floor(
      this.#definition.modifiers.find((d) => d.id === m.definitionId)!.price /
        2,
    );
    s.modifiers = s.modifiers.filter((x) => x !== m);
    s.revision++;
  }
  reroll(): void {
    const s = this.#state;
    if (s.phase !== "shop" || s.money < 5 + s.rerolls) return;
    s.money -= 5 + s.rerolls++;
    this.rollShop();
    s.revision++;
  }
  next(): void {
    if (this.#state.phase !== "shop") return;
    this.#state.encounter++;
    this.beginBlind();
    this.#state.revision++;
  }
  use(
    index: number,
    targetId: string,
    suit: CardSuit = "hearts",
    category: PokerCategory = "pair",
  ): void {
    const s = this.#state;
    if (
      !["shop", "blind"].includes(s.phase) ||
      !Number.isInteger(index) ||
      !["hearts", "diamonds", "clubs", "spades"].includes(suit) ||
      !Object.hasOwn(this.#definition.base, category)
    )
      return;
    const d = this.#definition.consumables.find(
      (d) => d.id === s.consumables[index],
    );
    const card = s.deck.find((c) => c.id === targetId);
    if (!d || (d.effect !== "level" && !card)) return;
    switch (d.effect) {
      case "remove":
        if (s.deck.length <= 1) return;
        s.deck = s.deck.filter((c) => c !== card);
        for (const key of Object.keys(s.zones) as (keyof CardZones)[])
          s.zones[key] = s.zones[key].filter((id) => id !== targetId);
        s.selected = s.selected.filter((id) => id !== targetId);
        break;
      case "duplicate": {
        const c = { ...card!, id: `card-copy-${s.nextId++}` };
        s.deck.push(c);
        break;
      }
      case "suit":
        card!.suit = suit;
        break;
      case "chips":
      case "mult":
        card!.enhancement = d.effect;
        break;
      case "level":
        s.levels[category] = (s.levels[category] ?? 0) + 1;
        break;
    }
    s.consumables.splice(index, 1);
    s.revision++;
  }
  snapshot(): unknown {
    return {
      version: 1,
      identity: JSON.stringify(this.#definition),
      seed: this.seed,
      state: structuredClone(this.#state),
      random: this.#random.capture(),
    };
  }
  restore(value: unknown): void {
    const snap = structuredClone(value) as {
      version: number;
      identity: string;
      seed: number;
      state: CardRunState;
      random: unknown;
    };
    // Legacy Lucky saves predate content identity. Validate their complete state and
    // seeded RNG, then emit the identity-bearing format on the next save.
    const legacy =
      snap &&
      Object.keys(snap).length === 2 &&
      Object.hasOwn(snap, "state") &&
      Object.hasOwn(snap, "random");
    if (
      !snap ||
      (!legacy &&
        (Object.keys(snap).length !== 5 ||
          snap.version !== 1 ||
          snap.seed !== this.seed ||
          snap.identity !== JSON.stringify(this.#definition)))
    )
      throw Error("Incompatible card run snapshot");
    validateCardRunState(snap.state, this.#definition);
    const random = new DeterministicRandom(
      this.#random
        .capture()
        .streams.map(({ name, owner, seed }) => ({ name, owner, seed })),
    );
    random.restore(snap.random);
    this.#random = random;
    this.#state = snap.state;
  }
}

/** Validate the complete candidate before committing either state or randomness. */
function validateCardRunState(
  value: unknown,
  definition: CardRunDefinition,
): asserts value is CardRunState {
  const fail = (): never => {
    throw Error("Invalid card run snapshot");
  };
  const object = (v: unknown): Record<string, any> => {
    if (
      !v ||
      typeof v !== "object" ||
      Array.isArray(v) ||
      Object.getPrototypeOf(v) !== Object.prototype
    )
      fail();
    return v as Record<string, any>;
  };
  const integer = (
    v: unknown,
    min = 0,
    max = Number.MAX_SAFE_INTEGER,
  ): boolean =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
  const strings = (v: unknown, max: number): v is string[] =>
    Array.isArray(v) &&
    v.length <= max &&
    v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 128);
  const unique = (v: readonly string[]) => new Set(v).size === v.length;
  const categories = Object.keys(definition.base);
  const suits = ["hearts", "diamonds", "clubs", "spades"];
  const s = object(value);
  const required = [
    "revision",
    "deck",
    "zones",
    "selected",
    "modifiers",
    "consumables",
    "levels",
    "encounter",
    "score",
    "hands",
    "discards",
    "money",
    "phase",
    "boss",
    "bossSuit",
    "offers",
    "consumableOffer",
    "rerolls",
    "nextId",
    "revealCursor",
    "revealDelay",
  ];
  const optional = ["firstCategory", "lastResult", "postRevealPhase", "error"];
  if (
    required.some((k) => !Object.hasOwn(s, k)) ||
    Object.keys(s).some((k) => !required.includes(k) && !optional.includes(k))
  )
    fail();
  for (const k of ["revision", "rerolls", "nextId", "revealCursor"])
    if (!integer(s[k])) fail();
  if (
    typeof s.revealDelay !== "number" ||
    !Number.isFinite(s.revealDelay) ||
    s.revealDelay < 0 ||
    s.revealDelay >= 0.16 ||
    (s.phase !== "reveal" && s.revealDelay !== 0)
  )
    fail();
  const finite = (v: unknown): boolean =>
    typeof v === "number" &&
    Number.isFinite(v) &&
    Math.abs(v) <= Number.MAX_SAFE_INTEGER;
  if (!integer(s.score, -Number.MAX_SAFE_INTEGER) || !finite(s.money)) fail();
  if (
    !integer(s.encounter, 0, definition.targets.length - 1) ||
    !integer(s.hands, 0, 4) ||
    !integer(s.discards, 0, 3) ||
    !["blind", "reveal", "shop", "won", "lost"].includes(s.phase) ||
    !["suit", "no-discards", "unique-category"].includes(s.boss) ||
    !suits.includes(s.bossSuit) ||
    (s.firstCategory !== undefined && !categories.includes(s.firstCategory)) ||
    (s.error !== undefined && typeof s.error !== "string")
  )
    fail();
  if (!Array.isArray(s.deck) || s.deck.length < 1 || s.deck.length > 10000)
    fail();
  for (const raw of s.deck) {
    const c = object(raw);
    if (
      typeof c.id !== "string" ||
      !c.id ||
      c.id.length > 128 ||
      !integer(c.rank, 2, 14) ||
      !suits.includes(c.suit) ||
      (c.enhancement !== undefined &&
        !["chips", "mult"].includes(c.enhancement)) ||
      (c.edition !== undefined && c.edition !== "foil") ||
      (c.seal !== undefined && typeof c.seal !== "string") ||
      Object.keys(c).some(
        (k) =>
          !["id", "rank", "suit", "enhancement", "edition", "seal"].includes(k),
      )
    )
      fail();
  }
  const ids = s.deck.map((c: PlayingCard) => c.id);
  if (!unique(ids)) fail();
  const allocated = [
    ...ids,
    ...(Array.isArray(s.modifiers)
      ? s.modifiers.map((m: OwnedModifier) => m?.instanceId)
      : []),
  ];
  if (
    allocated.some(
      (id) =>
        typeof id === "string" &&
        /^(card-copy-|modifier-)\d+$/.test(id) &&
        Number(id.match(/\d+$/)![0]) >= s.nextId,
    )
  )
    fail();
  const zones = object(s.zones);
  const zoneKeys = ["draw", "hand", "discard", "played"];
  if (
    Object.keys(zones).length !== 4 ||
    zoneKeys.some((k) => !strings(zones[k], ids.length))
  )
    fail();
  const zoned = zoneKeys.flatMap((k) => zones[k]);
  // Duplicated cards enter the deck immediately and join zones at the next blind.
  if (
    !unique(zoned) ||
    zoned.some((id) => !ids.includes(id)) ||
    zones.hand.length > 8 ||
    !strings(s.selected, 5) ||
    !unique(s.selected) ||
    s.selected.some((id: string) => !zones.hand.includes(id))
  )
    fail();
  if (!Array.isArray(s.modifiers) || s.modifiers.length > 5) fail();
  for (const raw of s.modifiers) {
    const m = object(raw);
    if (
      Object.keys(m).length !== 3 ||
      typeof m.instanceId !== "string" ||
      !m.instanceId ||
      !definition.modifiers.some((d) => d.id === m.definitionId) ||
      !finite(m.growth)
    )
      fail();
  }
  if (
    !unique(s.modifiers.map((m: OwnedModifier) => m.instanceId)) ||
    !strings(s.consumables, 2) ||
    s.consumables.some(
      (id: string) => !definition.consumables.some((d) => d.id === id),
    ) ||
    !strings(s.offers, 2) ||
    s.offers.some(
      (id: string) => !definition.modifiers.some((d) => d.id === id),
    ) ||
    typeof s.consumableOffer !== "string" ||
    (s.consumableOffer !== "" &&
      !definition.consumables.some((d) => d.id === s.consumableOffer))
  )
    fail();
  const levels = object(s.levels);
  if (
    Object.entries(levels).some(
      ([k, v]) => !categories.includes(k) || !integer(v),
    )
  )
    fail();
  if (s.lastResult !== undefined) {
    const r = object(s.lastResult);
    if (
      Object.keys(r).length !== 6 ||
      !integer(r.transactionId, 1, s.revision) ||
      !categories.includes(r.category) ||
      !integer(r.chips, -Number.MAX_SAFE_INTEGER) ||
      typeof r.mult !== "number" ||
      !Number.isFinite(r.mult) ||
      !integer(r.score, -Number.MAX_SAFE_INTEGER) ||
      !Array.isArray(r.trace) ||
      r.trace.length > 128
    )
      fail();
    for (const raw of r.trace) {
      const t = object(raw);
      if (
        Object.keys(t).length !== 4 ||
        typeof t.source !== "string" ||
        ![
          "base",
          "chips",
          "mult",
          "multiply",
          "money",
          "retrigger",
          "score",
        ].includes(t.operation) ||
        typeof t.before !== "number" ||
        !Number.isFinite(t.before) ||
        typeof t.after !== "number" ||
        !Number.isFinite(t.after)
      )
        fail();
    }
    if (s.revealCursor > r.trace.length) fail();
  } else if (s.revealCursor !== 0 || s.phase === "reveal") fail();
  if (s.phase === "reveal") {
    if (
      !["blind", "shop", "won", "lost"].includes(s.postRevealPhase) ||
      s.selected.length
    )
      fail();
  } else if (s.postRevealPhase !== undefined) fail();
  const phase = s.postRevealPhase ?? s.phase;
  if (
    (phase === "blind" && s.hands === 0) ||
    ((phase === "shop" || phase === "won") &&
      s.score < definition.targets[s.encounter]) ||
    (phase === "won" && s.encounter !== definition.targets.length - 1) ||
    (phase === "shop" && s.encounter === definition.targets.length - 1) ||
    (phase === "lost" &&
      (s.hands !== 0 || s.score >= definition.targets[s.encounter]))
  )
    fail();
}
