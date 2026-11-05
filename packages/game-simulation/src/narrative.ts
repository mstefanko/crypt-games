import { canonicalJson } from "./session-protocol";
import { sha256Content } from "./content-hash";
/** Single primary consumer: authored investigative narrative; shared rules and live navigation. */
import { DeterministicRandom } from "./rng";
import {
  applyStateEffect,
  evaluateCondition,
  modifiedStat,
  type RuleCondition,
  type RuleState,
  type StateEffect,
  type StatModifier,
  RuleBudget,
} from "./rules";
import { LiveNavigation } from "./live-navigation";
export interface NarrativeCheck {
  id: string;
  skill: string;
  difficulty: number;
  color: "white" | "red";
  success: string;
  failure: string;
  successEffects?: NarrativeEffect[];
  failureEffects?: NarrativeEffect[];
}
export type NarrativeEffect =
  | StateEffect
  | { kind: "reopen"; check: string }
  | { kind: "thought"; id: string }
  | { kind: "quest"; key: string; value: number }
  | { kind: "scene"; id: string };
export interface NarrativeOption {
  id: string;
  label: string;
  next: string;
  condition?: RuleCondition;
  effects?: NarrativeEffect[];
}
export interface NarrativeNode {
  id: string;
  speaker: string;
  text: string;
  kind: "line" | "choice" | "check" | "effect" | "return" | "end";
  next?: string;
  options?: NarrativeOption[];
  check?: NarrativeCheck;
  effects?: NarrativeEffect[];
  ending?: string;
  passive?: { skill: string; difficulty: number; text: string };
}
export interface NarrativeScene {
  id: string;
  name: string;
  width: number;
  height: number;
  palette?: { background: number; ground: number; wall: number };
  backgroundUrl?: string;
  portraitUrls?: string[];
  walkable: boolean[];
  spawn: number;
  hotspots: {
    id: string;
    name: string;
    cell: number;
    node: string;
    kind: "npc" | "object";
    portraitIndex?: number;
    color: number;
  }[];
}
export interface NarrativeDefinition {
  title: string;
  contentId?: string;
  actorAtlasUrl?: string;
  portraitUrls?: string[];
  start: string;
  skills: string[];
  profiles: { id: string; name: string; skills: Record<string, number> }[];
  nodes: NarrativeNode[];
  scenes: NarrativeScene[];
  clothing: { id: string; name: string; modifiers: StatModifier[] }[];
  thoughts: {
    id: string;
    name: string;
    temporary: StatModifier[];
    permanent: StatModifier[];
  }[];
  failureNode: string;
}
export interface CheckOutcome {
  success: boolean;
  dice: [number, number];
  failedAt: number;
  attempts: number;
  reopened: boolean;
}
export interface NarrativeState extends RuleState {
  revision: number;
  node: string;
  scene: string;
  baseSkills: Record<string, number>;
  points: number;
  clothing: string[];
  thoughts: { id: string; progress: number }[];
  checks: Record<string, CheckOutcome>;
  history: { speaker: string; text: string }[];
  consumed: string[];
  ending?: string;
  player: { x: number; y: number; phase?: number; facing?: number };
  path: number[];
  pendingHotspot?: string;
  pendingGoal?: number;
  reveal?: { dice: [number, number]; success: boolean; remaining: number };
  profile: string;
  cues: { id: number; kind: string }[];
  cueCursor: number;
  nextCue: number;
}
export function checkChance(skill: number, difficulty: number): number {
  let wins = 0;
  for (let a = 1; a <= 6; a++)
    for (let b = 1; b <= 6; b++)
      if (
        (a === 6 && b === 6) ||
        (!(a === 1 && b === 1) && a + b + skill >= difficulty)
      )
        wins++;
  return wins / 36;
}
export type NarrativeObservation<T> = T extends object
  ? { readonly [K in keyof T]: NarrativeObservation<T[K]> }
  : T;
export class NarrativeSession {
  #state: NarrativeState;
  #seed: number;
  get seed(): number {
    return this.#seed;
  }
  #definition: NarrativeDefinition;
  #contentId: string;
  get state(): NarrativeObservation<NarrativeState> {
    return structuredClone(this.#state);
  }
  get definition(): NarrativeDefinition {
    return structuredClone(this.#definition);
  }
  #random: DeterministicRandom;
  #navigation: LiveNavigation;
  #requestId?: number;
  constructor(definition: NarrativeDefinition, seed: number) {
    this.#seed = seed;
    this.#definition = structuredClone(definition);
    this.#contentId = sha256Content(canonicalJson(this.#definition));
    const profile = definition.profiles[0],
      scene = definition.scenes[0];
    this.#random = new DeterministicRandom([
      { name: "checks", owner: "narrative", seed: seed >>> 0 },
    ]);
    this.#state = {
      revision: 0,
      node: definition.start,
      scene: scene.id,
      baseSkills: { ...profile.skills },
      points: 1,
      clothing: [],
      thoughts: [],
      checks: {},
      history: [],
      consumed: [],
      cues: [],
      cueCursor: 0,
      nextCue: 1,
      profile: profile.id,
      flags: {},
      stats: { health: 3, morale: 3 },
      inventory: { medicine: 1, comfort: 1 },
      player: {
        x: scene.spawn % scene.width,
        y: Math.floor(scene.spawn / scene.width),
      },
      path: [],
    };
    this.#navigation = this.makeNavigation();
    this.enter(definition.start);
  }
  private makeNavigation(): LiveNavigation {
    const scene = this.scene;
    return new LiveNavigation({
      width: scene.width,
      height: scene.height,
      walkable: scene.walkable,
    });
  }
  get scene(): NarrativeScene {
    return structuredClone(
      this.#definition.scenes.find((s) => s.id === this.#state.scene)!,
    );
  }
  get node(): NarrativeNode {
    return structuredClone(
      this.#definition.nodes.find((n) => n.id === this.#state.node)!,
    );
  }
  skill(id: string): number {
    const mods = [
      ...this.#definition.clothing
        .filter((c) => this.#state.clothing.includes(c.id))
        .flatMap((c) => c.modifiers),
      ...this.#state.thoughts.flatMap((t) => {
        const d = this.#definition.thoughts.find((d) => d.id === t.id)!;
        return t.progress >= 3 ? d.permanent : d.temporary;
      }),
    ];
    return modifiedStat(
      (this.#state.baseSkills[id] ?? 1) + (this.#state.stats[id] ?? 0),
      id,
      mods,
    );
  }
  private context(): RuleState {
    return {
      ...this.#state,
      stats: {
        ...this.#state.stats,
        ...Object.fromEntries(
          this.#definition.skills.map((s) => [s, this.skill(s)]),
        ),
      },
      facts: {
        ...this.#state.facts,
        ...Object.fromEntries(
          Object.entries(this.#state.checks).map(([id, c]) => [
            id,
            c.success ? "success" : "failure",
          ]),
        ),
      },
    };
  }
  get options(): NarrativeOption[] {
    return (this.node.options ?? []).filter((o) =>
      evaluateCondition(o.condition, this.context()),
    );
  }
  get canCheck(): boolean {
    const c = this.node.check;
    if (!c) return false;
    const old = this.#state.checks[c.id];
    return (
      !old ||
      (!old.success &&
        c.color === "white" &&
        (old.reopened || this.#state.baseSkills[c.skill] > old.failedAt))
    );
  }
  get chance(): number {
    const c = this.node.check;
    return c ? checkChance(this.skill(c.skill), c.difficulty) : 0;
  }
  private cue(kind: string): void {
    this.#state.cues.push({ id: this.#state.nextCue++, kind });
    if (this.#state.cues.length > 128) this.#state.cues.shift();
  }
  private effect(e: NarrativeEffect): void {
    const s = this.#state;
    switch (e.kind) {
      case "reopen":
        if (s.checks[e.check]) s.checks[e.check].reopened = true;
        break;
      case "thought":
        if (!s.thoughts.some((t) => t.id === e.id) && s.thoughts.length < 2)
          s.thoughts.push({ id: e.id, progress: 0 });
        break;
      case "quest":
        s.stats[e.key] = e.value;
        break;
      case "scene": {
        if (this.#requestId !== undefined)
          this.#navigation.retire(this.#requestId);
        this.#requestId = undefined;
        s.pendingGoal = undefined;
        s.pendingHotspot = undefined;
        s.scene = e.id;
        s.path = [];
        const scene = this.scene;
        s.player = {
          x: scene.spawn % scene.width,
          y: Math.floor(scene.spawn / scene.width),
        };
        this.#navigation = this.makeNavigation();
        break;
      }
      default:
        if (
          e.kind === "flag" &&
          e.key === "evidence" &&
          e.value &&
          !s.flags[e.key]
        )
          this.cue("evidence");
        applyStateEffect(s, e);
        if (
          e.kind === "flag" &&
          e.key === "evidence" &&
          e.value &&
          !s.flags["evidence-point"]
        ) {
          s.points++;
          s.flags["evidence-point"] = true;
        }
    }
  }
  private progress(): void {
    for (const t of this.#state.thoughts) {
      if (t.progress === 2) this.cue("thought");
      t.progress = Math.min(3, t.progress + 1);
    }
    if (!this.#state.flags["evidence-point"] && this.#state.flags.evidence) {
      this.#state.points++;
      this.#state.flags["evidence-point"] = true;
    }
  }
  private enter(id: string): void {
    const budget = new RuleBudget(64);
    let next: string | undefined = id;
    while (next) {
      budget.step();
      const node = this.#definition.nodes.find((n) => n.id === next);
      if (!node) throw Error(`Unknown narrative node: ${next}`);
      this.#state.node = node.id;
      const token = `node:${node.id}`;
      if (node.kind === "effect") {
        if (!this.#state.consumed.includes(token)) {
          for (const e of node.effects ?? []) this.effect(e);
          this.#state.consumed.push(token);
        } else
          for (const e of node.effects ?? [])
            if (e.kind === "scene") this.effect(e);
        next = node.next;
        continue;
      }
      if (!this.#state.consumed.includes(token)) {
        for (const e of node.effects ?? []) this.effect(e);
        this.#state.consumed.push(token);
      }
      if (node.kind === "end") this.#state.ending = node.ending ?? node.id;
      if (node.kind !== "return") {
        this.cue("speaker");
        this.#state.history.push({ speaker: node.speaker, text: node.text });
        if (
          node.passive &&
          this.skill(node.passive.skill) + 6 >= node.passive.difficulty
        ) {
          this.cue(
            `skill-${this.#definition.skills.indexOf(node.passive.skill)}`,
          );
          this.#state.history.push({
            speaker: node.passive.skill,
            text: node.passive.text,
          });
        }
      }
      break;
    }
    if (this.#state.stats.health <= 0 || this.#state.stats.morale <= 0) {
      if (this.#state.node !== this.#definition.failureNode)
        this.enter(this.#definition.failureNode);
    }
  }
  private transaction(action: () => void): void {
    const before = structuredClone(this.#state),
      rng = this.#random.capture();
    try {
      action();
      this.#state.revision++;
    } catch (error) {
      this.#state = before;
      this.#random.restore(rng);
      this.#navigation = this.makeNavigation();
      throw error;
    }
  }
  choose(id: string, revision = this.#state.revision): void {
    if (
      revision !== this.#state.revision ||
      this.#state.ending ||
      this.#state.reveal
    )
      return;
    const option = this.options.find((o) => o.id === id);
    if (!option) return;
    this.transaction(() => {
      this.#state.history.push({ speaker: "You", text: option.label });
      for (const effect of option.effects ?? []) this.effect(effect);
      this.progress();
      this.enter(option.next);
    });
  }
  continue(): void {
    if (this.#state.ending || this.#state.reveal) return;
    if (this.node.next)
      this.transaction(() => {
        this.progress();
        this.enter(this.node.next!);
      });
  }
  roll(): void {
    if (!this.canCheck || this.#state.reveal) return;
    this.transaction(() => {
      const c = this.node.check!,
        a = this.#random.drawInteger("narrative", "checks", 6) + 1,
        b = this.#random.drawInteger("narrative", "checks", 6) + 1;
      const success =
        (a === 6 && b === 6) ||
        (!(a === 1 && b === 1) && a + b + this.skill(c.skill) >= c.difficulty);
      this.#state.checks[c.id] = {
        success,
        dice: [a, b],
        failedAt: this.#state.baseSkills[c.skill],
        attempts: (this.#state.checks[c.id]?.attempts ?? 0) + 1,
        reopened: false,
      };
      for (const e of (success ? c.successEffects : c.failureEffects) ?? [])
        this.effect(e);
      this.progress();
      this.enter(success ? c.success : c.failure);
      this.#state.reveal = { dice: [a, b], success, remaining: 1 };
    });
  }
  invest(skill: string): void {
    if (
      this.#state.reveal ||
      !this.#definition.skills.includes(skill) ||
      !this.#state.points ||
      this.#state.baseSkills[skill] >= 6
    )
      return;
    this.#state.points--;
    this.#state.baseSkills[skill]++;
    this.#state.revision++;
  }
  wear(id: string): void {
    if (this.#state.reveal) return;
    if (!this.#definition.clothing.some((c) => c.id === id)) return;
    this.#state.clothing = this.#state.clothing.includes(id)
      ? this.#state.clothing.filter((c) => c !== id)
      : [...this.#state.clothing, id];
    this.#state.revision++;
  }
  profile(id: string): void {
    if (this.#state.revision > 0) return;
    const p = this.#definition.profiles.find((p) => p.id === id);
    if (p) {
      this.#state.profile = id;
      this.#state.baseSkills = { ...p.skills };
    }
  }
  leaveConversation(): void {
    if (this.#state.reveal || this.#state.ending) return;
    const node = this.#definition.nodes.find((n) => n.kind === "return");
    if (node) {
      this.#state.node = node.id;
      this.#state.revision++;
    }
  }
  recover(kind: "health" | "morale"): void {
    if (this.#state.reveal) return;
    const item = kind === "health" ? "medicine" : "comfort";
    if (this.#state.inventory[item] > 0 && !this.#state.ending) {
      this.#state.inventory[item]--;
      this.#state.stats[kind] = Math.min(3, this.#state.stats[kind] + 1);
      this.#state.revision++;
    }
  }
  walk(cell: number, hotspot?: string): void {
    if (this.#state.ending || this.#state.reveal) return;
    const target = this.scene.hotspots.find((h) => h.id === hotspot);
    if (
      !Number.isInteger(cell) ||
      !this.scene.walkable[cell] ||
      (hotspot !== undefined && (!target || target.cell !== cell))
    )
      return;
    if (this.#requestId !== undefined) this.#navigation.retire(this.#requestId);
    const scene = this.scene;
    const start =
      Math.round(this.#state.player.y) * scene.width +
      Math.round(this.#state.player.x);
    this.#requestId = this.#navigation.request(start, cell);
    this.#state.pendingHotspot = hotspot;
    this.#state.pendingGoal = cell;
    this.#state.path = [];
  }
  dismissReveal(): void {
    this.#state.reveal = undefined;
  }
  update(dt: number): void {
    if (!Number.isFinite(dt) || dt < 0 || dt > 0.1)
      throw Error("Narrative step must be between 0 and .1 seconds");
    if (this.#state.reveal) {
      this.#state.reveal.remaining = Math.max(
        0,
        this.#state.reveal.remaining - dt,
      );
      if (this.#state.reveal.remaining <= 1e-9) this.dismissReveal();
    }
    this.#navigation.step();
    if (this.#requestId !== undefined) {
      const result = this.#navigation.result(this.#requestId);
      if (result?.status === "complete") {
        this.#state.path = result.path.slice(1);
        this.#navigation.retire(this.#requestId);
        this.#requestId = undefined;
        this.#state.pendingGoal = undefined;
      } else if (result && ["unreachable", "stale"].includes(result.status)) {
        this.#navigation.retire(this.#requestId);
        this.#requestId = undefined;
        this.#state.pendingGoal = undefined;
        this.#state.pendingHotspot = undefined;
      }
    }
    const previous = { ...this.#state.player };
    let remaining = Math.min(dt, 0.1) * 3;
    while (remaining > 0 && this.#state.path.length) {
      const target = this.#state.path[0],
        x = target % this.scene.width,
        y = Math.floor(target / this.scene.width),
        dx = x - this.#state.player.x,
        dy = y - this.#state.player.y,
        d = Math.hypot(dx, dy);
      if (d <= remaining) {
        this.#state.player = { ...this.#state.player, x, y };
        this.#state.path.shift();
        remaining -= d;
      } else {
        this.#state.player.x += (dx / d) * remaining;
        this.#state.player.y += (dy / d) * remaining;
        remaining = 0;
      }
    }
    const dx = this.#state.player.x - previous.x,
      dy = this.#state.player.y - previous.y;
    this.#state.player.phase =
      ((previous.phase ?? 0) + dt * (Math.hypot(dx, dy) > 0.001 ? 1.8 : 0.3)) %
      1;
    if (Math.hypot(dx, dy) > 0.001)
      this.#state.player.facing =
        (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8;
    if (
      !this.#state.path.length &&
      this.#requestId === undefined &&
      this.#state.pendingHotspot
    ) {
      const h = this.scene.hotspots.find(
        (h) => h.id === this.#state.pendingHotspot,
      );
      this.#state.pendingHotspot = undefined;
      if (
        h &&
        ((h.cell % this.scene.width) - this.#state.player.x) ** 2 +
          (Math.floor(h.cell / this.scene.width) - this.#state.player.y) ** 2 <=
          2.25
      )
        this.transaction(() => this.enter(h.node));
    }
  }
  snapshot(): unknown {
    return {
      identity: {
        kind: "narrative",
        version: 1,
        contentId: this.#contentId,
        rulesBuildId: "narrative-v1",
        seed: this.seed,
      },
      state: structuredClone(this.#state),
      random: this.#random.capture(),
      navigation: this.#navigation.snapshot(),
      requestId: this.#requestId,
    };
  }
  restore(value: unknown): void {
    const snap = structuredClone(value) as {
      identity?: {
        kind: string;
        version: number;
        contentId: string;
        rulesBuildId: string;
        seed: number;
      };
      state: NarrativeState;
      random: unknown;
      navigation?: ReturnType<LiveNavigation["snapshot"]>;
      requestId?: number;
    };
    const invalid = (): never => {
      throw Error("Invalid narrative snapshot");
    };
    if (!snap || !snap.state) invalid();
    if (
      snap.identity &&
      (snap.identity.kind !== "narrative" ||
        snap.identity.version !== 1 ||
        snap.identity.contentId !== this.#contentId ||
        snap.identity.rulesBuildId !== "narrative-v1" ||
        snap.identity.seed !== this.seed)
    )
      invalid();
    const state = snap.state;
    validateNarrativeState(state, this.#definition);
    const random = new DeterministicRandom(
      this.#random
        .capture()
        .streams.map(({ name, owner, seed }) => ({ name, owner, seed })),
    );
    random.restore(snap.random);
    const scene = this.#definition.scenes.find((s) => s.id === state.scene)!;
    const navigation = new LiveNavigation({
      width: scene.width,
      height: scene.height,
      walkable: scene.walkable,
    });
    let requestId = snap.requestId;
    if (snap.navigation) {
      navigation.restore(snap.navigation);
      if (
        (requestId === undefined) !== (state.pendingGoal === undefined) ||
        snap.navigation.searches.length !== (requestId === undefined ? 0 : 1)
      )
        invalid();
      if (
        snap.navigation.cells.some((v, i) => v !== scene.walkable[i]) ||
        (requestId !== undefined &&
          (!Number.isSafeInteger(requestId) || !navigation.result(requestId)))
      )
        invalid();
    } else if (state.pendingGoal !== undefined) {
      requestId = navigation.request(
        Math.round(state.player.y) * scene.width + Math.round(state.player.x),
        state.pendingGoal,
      );
    }
    this.#state = state;
    this.#random = random;
    this.#navigation = navigation;
    this.#requestId = requestId;
  }
}
function validateNarrativeState(
  s: NarrativeState,
  d: NarrativeDefinition,
): void {
  const fail = (): never => {
    throw Error("Invalid narrative snapshot");
  };
  const integer = (n: unknown, min = 0) =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= min;
  const record = (o: unknown): o is Record<string, unknown> =>
    !!o && typeof o === "object" && !Array.isArray(o);
  const dense = (o: unknown): void => {
    if (typeof o === "number" && !Number.isFinite(o)) fail();
    if (Array.isArray(o)) {
      if (Object.keys(o).length !== o.length) fail();
      for (const v of o) dense(v);
    } else if (o && typeof o === "object")
      for (const v of Object.values(o)) dense(v);
  };
  dense(s);
  const scene = d.scenes.find((x) => x.id === s.scene);
  if (
    !scene ||
    !d.nodes.some((x) => x.id === s.node) ||
    !integer(s.revision) ||
    !integer(s.points) ||
    !d.profiles.some((p) => p.id === s.profile)
  )
    fail();
  const cell = (n: unknown) =>
    integer(n) && scene!.walkable[n as number] === true;
  if (
    !record(s.baseSkills) ||
    d.skills.some((k) => !integer(s.baseSkills[k], 1) || s.baseSkills[k] > 6) ||
    !record(s.stats) ||
    Object.values(s.stats).some(
      (v) => typeof v !== "number" || !Number.isFinite(v),
    ) ||
    !integer(s.stats.health) ||
    s.stats.health > 3 ||
    !integer(s.stats.morale) ||
    s.stats.morale > 3 ||
    !record(s.inventory) ||
    Object.values(s.inventory).some((v) => !integer(v)) ||
    !record(s.flags) ||
    Object.values(s.flags).some((v) => typeof v !== "boolean")
  )
    fail();
  if (
    !Array.isArray(s.clothing) ||
    s.clothing.some((id) => !d.clothing.some((c) => c.id === id)) ||
    new Set(s.clothing).size !== s.clothing.length ||
    !Array.isArray(s.thoughts) ||
    s.thoughts.length > 2 ||
    s.thoughts.some(
      (t) =>
        !t ||
        !d.thoughts.some((x) => x.id === t.id) ||
        !integer(t.progress) ||
        t.progress > 3,
    )
  )
    fail();
  if (
    !Array.isArray(s.history) ||
    s.history.some(
      (h) => !h || typeof h.speaker !== "string" || typeof h.text !== "string",
    ) ||
    !Array.isArray(s.consumed) ||
    s.consumed.some((t) => !d.nodes.some((n) => t === `node:${n.id}`)) ||
    !record(s.checks)
  )
    fail();
  for (const [id, c] of Object.entries(s.checks))
    if (
      !d.nodes.some((n) => n.check?.id === id) ||
      !c ||
      typeof c.success !== "boolean" ||
      typeof c.reopened !== "boolean" ||
      !integer(c.attempts, 1) ||
      !integer(c.failedAt, 1) ||
      !Array.isArray(c.dice) ||
      c.dice.length !== 2 ||
      c.dice.some((v) => !integer(v, 1) || v > 6)
    )
      fail();
  if (
    !s.player ||
    !Number.isFinite(s.player.x) ||
    !Number.isFinite(s.player.y) ||
    !cell(Math.round(s.player.y) * scene!.width + Math.round(s.player.x)) ||
    !Array.isArray(s.path) ||
    s.path.some((n) => !cell(n))
  )
    fail();
  let x = s.player.x,
    y = s.player.y;
  for (const n of s.path) {
    const nx = n % scene!.width,
      ny = Math.floor(n / scene!.width);
    if ((nx - x) ** 2 + (ny - y) ** 2 > 1.002001) fail();
    x = nx;
    y = ny;
  }
  if (
    s.player.phase !== undefined &&
    (!Number.isFinite(s.player.phase) ||
      s.player.phase < 0 ||
      s.player.phase >= 1)
  )
    fail();
  if (
    s.player.facing !== undefined &&
    (!integer(s.player.facing) || s.player.facing > 7)
  )
    fail();
  if (
    s.tags !== undefined &&
    (!Array.isArray(s.tags) || s.tags.some((v) => typeof v !== "string"))
  )
    fail();
  if (
    s.facts !== undefined &&
    (!record(s.facts) ||
      Object.values(s.facts).some(
        (v) => !["number", "string", "boolean"].includes(typeof v),
      ))
  )
    fail();
  if (s.pendingGoal !== undefined && !cell(s.pendingGoal)) fail();
  if (
    s.pendingHotspot !== undefined &&
    !scene!.hotspots.some(
      (h) =>
        h.id === s.pendingHotspot &&
        (s.pendingGoal === undefined || h.cell === s.pendingGoal),
    )
  )
    fail();
  if (
    s.ending !== undefined &&
    !d.nodes.some((n) => n.kind === "end" && (n.ending ?? n.id) === s.ending)
  )
    fail();
  if (
    s.reveal &&
    (!Array.isArray(s.reveal.dice) ||
      s.reveal.dice.length !== 2 ||
      s.reveal.dice.some((n) => !integer(n, 1) || n > 6) ||
      typeof s.reveal.success !== "boolean" ||
      !Number.isFinite(s.reveal.remaining) ||
      s.reveal.remaining < 0 ||
      s.reveal.remaining > 1)
  )
    fail();
  if (
    !integer(s.cueCursor) ||
    !integer(s.nextCue, 1) ||
    !Array.isArray(s.cues) ||
    s.cues.length > 128 ||
    s.cues.some(
      (c, i) =>
        !c ||
        !integer(c.id, 1) ||
        c.id >= s.nextCue ||
        (i > 0 && c.id <= s.cues[i - 1].id) ||
        typeof c.kind !== "string",
    )
  )
    fail();
}
