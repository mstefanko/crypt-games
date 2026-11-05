import { checkedIncrement } from "./counters";
import { canonicalJson } from "./session-protocol";
import { sha256Content } from "./content-hash";
import { validateArenaCheckpoint } from "./arena-checkpoint";
import { allocateEncounterWaves } from "./arena-encounter";
import {
  actionPhase,
  claimActionHit,
  TimeScaleCurve,
  type ActionInstance,
  type ActionTiming,
} from "./action-timeline";
import {
  modifiedStat,
  eligibleTriggers,
  markTrigger,
  createTriggerMemory,
  RuleBudget,
  type TriggerMemory,
  type StatModifier,
} from "./rules";
/** Single-consumer genre owner: continuous ground combat; content supplied by arcade. */
export interface ArenaMoveDefinition {
  id: string;
  clipId: string;
  timing: ActionTiming;
  damage: number;
  hitShape: { kind: "sector"; range: number; arc: number; reverse?: boolean } | { kind: "capsule"; range: number; radius: number } | { kind: "radial"; range: number };
  displacement: number;
  displacementCurve?: "linear" | "ease-out";
  recoil: number;
  aimLock: number;
  nextMoves: string[];
  presentationEvents?: { windup?: string; active?: string; contact?: string };
}
export interface ArenaContact {
  pan: number;
  actionId: number;
  moveId: string;
  targetId: string;
  x: number;
  y: number;
  heading: number;
  material: "organic" | "armor" | "block" | "kill" | "miss";
  damage: number;
  outcome: "hit" | "blocked" | "killed" | "miss";
  effectId?: string;
}
interface ArenaCommand { kind: "attack" | "dash" | "special" | "cast"; at: number; order: number; aim: number; heading: number; }
export interface ArenaWeapon {
  id: string;
  name: string;
  kind: "sword" | "spear" | "bow";
  damage: number;
  range: number;
  timing: ActionTiming;
  specialDamage: number;
  specialRange: number;
  moves?: ArenaMoveDefinition[];
  impacts?: Partial<
    Record<
      "organic" | "armored" | "shielded",
      {
        stagger: number;
        knockback: number;
        shake: number;
        sparks: number;
        sound: string;
      }
    >
  >;
}
export interface ArenaEnemyDefinition {
  id: string;
  name: string;
  role: "melee" | "ranged" | "shield" | "boss";
  health: number;
  speed: number;
  damage: number;
  cost: number;
  timing: ActionTiming;
  color: number;
  attackDisplacement?: number;
  material?: "organic" | "armored" | "shielded";
}
export interface ArenaBoon {
  id: string;
  name: string;
  description: string;
  modifiers?: StatModifier[];
  proc?: "chain" | "heal" | "ember-wake" | "echo-cast";
}
export interface ArenaRoom {
  name: string;
  width: number;
  height: number;
  pillars: { x: number; y: number; radius: number }[];
  breakables: { x: number; y: number }[];
  waves: string[][];
  boss?: string;
  waveBudgets?: number[];
  spawnRoles?: string[];
  spawnInterval?: number;
  hazard?: number;
  trap?: { x: number; y: number; radius: number; warning: number; active: number; cooldown: number; damage: number };
  rewardExit?: { x: number; y: number; boons: string[] };
}
export interface ArenaDefinition {
  weapons: ArenaWeapon[];
  enemies: ArenaEnemyDefinition[];
  boons: ArenaBoon[];
  rooms: ArenaRoom[];
}
export interface ArenaActor {
  id: string;
  definition: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  facing: number;
  cooldown: number;
  action?: ActionInstance;
  hurt: number;
  invulnerable?: number;
  hurtProtection?: number;
  animation?: {
    kind:
      | "idle"
      | "run"
      | "dash"
      | "cast"
      | "charge"
      | "hurt"
      | "death"
      | "attack";
    id: number;
    elapsed: number;
  };
  attackKind?: number;
  moving?: boolean;
  locomotion?: number;
  stagger?: number;
  deathTime?: number;
  recoil?: { x: number; y: number; remaining: number };
  training?: boolean;
  shieldBroken?: boolean;
  shieldBreak?: number;
}
export interface ArenaProjectile {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  damage: number;
  owner: string;
  returning?: boolean;
  cast?: boolean;
  actionId?: number;
  hits: string[];
}
export interface ArenaState {
  time: number;
  room: number;
  wave: number;
  phase: "prepare" | "combat" | "upgrade" | "won" | "lost";
  player: ArenaActor;
  enemies: ArenaActor[];
  projectiles: ArenaProjectile[];
  weapon: string;
  boons: string[];
  dash: number;
  dashRecharge: number;
  dashTime: number;
  dashSpeedScale?: number;
  cast: number;
  nextId: number;
  spawn: string[];
  spawnTimer: number;
  combo: number;
  charge: number;
  comboRemaining?: number;
  breakables: { x: number; y: number; alive: boolean }[];
  messages: string[];
  offered: string[];
  triggerMemory: TriggerMemory;
  sequence: number;
  scaleElapsed: number;
  scaleCooldown: number;
  buffer: number;
  impacts: {
    id: number;
    x: number;
    y: number;
    life: number;
    shake: number;
    sparks: number;
    color: number;
    moveId?: string;
    material?: ArenaContact["material"];
    outcome?: ArenaContact["outcome"];
    heading?: number;
  }[];
  castPose: number;
  inputClock?: number;
  commands?: ArenaCommand[];
  commandOrder?: number;
  inputEdges?: { dash: boolean; special: boolean; cast: boolean };
  trap?: { elapsed: number; cycle: number; phase: "warning" | "active" | "cooldown"; hits: string[] };
  exitOpen?: boolean;
  rewardSelected?: boolean;
  trails?: { x: number; y: number; life: number; hits: string[]; id: number }[];
  echoes?: { x: number; y: number; delay: number; id: number }[];
}
export interface ArenaInput {
  movementScale?: number;
  x: number;
  y: number;
  aimX: number;
  aimY: number;
  attack: boolean;
  attackHeld: boolean;
  attackReleased: boolean;
  special: boolean;
  dash: boolean;
  cast: boolean;
  command?: string;
  cancelled?: boolean;
}
export type ArenaClock = "legacy-delta-v1" | "fixed-60-v2";
/** v2 is opt-in until human combat acceptance. Legacy step clamps gameplay delta
 * to 50ms; v2 clamps host accumulation to 50ms and runs at most three 60Hz ticks.
 * Input buffers/hit-stop advance on unscaled ticks; combat uses hit-stop scale.
 * Edges arriving between ticks are retained once; latest continuous input wins.
 * Events use unscaled owner ticks: fixed kernel ticks in v2, positive-delta
 * call count in legacy mode. Snapshot v2 includes pending input/events and identity. Old state-only saves
 * require restart: their missing events/clock cannot be reconstructed. */
export class ArenaSession {
  state: ArenaState;
  private scale = new TimeScaleCurve();
  private events: {
    sequence: number;
    tick: number;
    sourceId: string;
    kind: string;
    payload?: { pan: number } & Partial<ArenaContact>;
  }[] = [];
  private sequence = 0;
  private droppedEvents = 0;
  private buffer = 0;
  private remainder = 0;
  private ticks = 0;
  private pendingInput: ArenaInput | null = null;
  private readonly contentId: string;
  constructor(
    readonly definition: ArenaDefinition,
    readonly seed = 1,
    readonly clock: ArenaClock = "legacy-delta-v1",
  ) {
    if (!Number.isSafeInteger(seed) || !["legacy-delta-v1", "fixed-60-v2"].includes(clock)) throw Error("Invalid arena identity");
    this.contentId = sha256Content(canonicalJson(definition));
    this.state = {
      time: 0,
      room: 0,
      wave: 0,
      phase: "prepare",
      player: {
        id: "player",
        definition: "player",
        x: 3,
        y: 6,
        hp: 100,
        maxHp: 100,
        facing: 0,
        cooldown: 0,
        hurt: 0,
      },
      enemies: [],
      projectiles: [],
      weapon: definition.weapons[0]!.id,
      boons: [],
      dash: 2,
      dashRecharge: 0,
      dashTime: 0,
      cast: 0,
      nextId: 1,
      spawn: [],
      spawnTimer: 0,
      combo: -1,
      charge: 0,
      breakables: [],
      messages: ["Choose a weapon and a blessing, then depart."],
      offered: definition.boons.map((b) => b.id),
      triggerMemory: createTriggerMemory(),
      sequence: 0,
      scaleElapsed: 1,
      scaleCooldown: 0,
      buffer: 0,
      impacts: [],
      castPose: 0,
    };
    this.resetRoom();
  }
  get room() {
    return this.definition.rooms[this.state.room]!;
  }
  get weapon() {
    return this.definition.weapons.find((w) => w.id === this.state.weapon)!;
  }
  attackRange(special = false) {
    return this.stat(
      special ? this.weapon.specialRange : this.weapon.range,
      "area",
      [special ? "special" : "attack"],
    );
  }
  private stat(base: number, key: string, tags: string[] = []) {
    return modifiedStat(
      base,
      key,
      this.state.boons.flatMap(
        (id) => this.definition.boons.find((b) => b.id === id)?.modifiers ?? [],
      ),
      tags,
    );
  }
  command(command: string) {
    const s = this.state;
    if (
      command.startsWith("weapon:") &&
      ["prepare", "upgrade"].includes(s.phase) &&
      this.definition.weapons.some((w) => w.id === command.slice(7))
    )
      s.weapon = command.slice(7);
    if (
      command.startsWith("boon:") &&
      ["prepare", "upgrade"].includes(s.phase)
    ) {
      const id = command.slice(5);
      if (
        s.offered.includes(id) &&
        !s.boons.includes(id) &&
        s.boons.length < (s.phase === "prepare" ? 1 : 2)
      )
        { s.boons.push(id);
          if (s.phase === "upgrade" && this.room.rewardExit) {
            s.rewardSelected = true;
            s.exitOpen = true;
            s.phase = "combat";
            this.clearCommands();
            const d = this.definition.enemies.find((e) => e.role === "melee")!;
            s.enemies.push({ id: "training-target", definition: d.id, x: this.room.rewardExit.x - 2, y: this.room.rewardExit.y, hp: 500, maxHp: 500, facing: Math.PI, cooldown: 0, hurt: 0, training: true });
            this.emit("reward");
          }
        }
    }
    if (command === "start" && s.phase === "prepare") {
      if (!this.room.rewardExit && s.boons.length === 0 && s.offered[0]) s.boons.push(s.offered[0]);
      s.phase = "combat";
      this.beginWave();
    }
    if (command === "continue" && s.phase === "upgrade") {
      if (this.room.rewardExit) return;
      s.room++;
      s.wave = 0;
      s.phase = "combat";
      this.resetRoom();
      this.beginWave();
    }
  }
  clearCommands() {
    this.state.commands = [];
    this.state.inputEdges = { dash: false, special: false, cast: false };
    this.buffer = 0;
    this.state.charge = 0;
  }
  private resetRoom() {
    this.clearCommands();
    this.state.trap = { elapsed: 0, cycle: 0, phase: "warning", hits: [] };
    this.state.trails = [];
    this.state.echoes = [];
    this.state.exitOpen = false;
    this.state.rewardSelected = false;
    if (this.room.rewardExit) this.state.offered = [];
    this.state.projectiles = [];
    this.state.enemies = [];
    this.state.player.action = undefined;
    this.state.player.hurt = 0;
    this.state.player.invulnerable = 0;
    this.state.player.hurtProtection = 0;
    this.state.player.animation = undefined;
    this.state.dashTime = 0;
    this.state.castPose = 0;
    this.state.charge = 0;
    this.state.combo = -1;
    this.state.comboRemaining = 0;
    this.buffer = 0;
    this.state.player.x = 3;
    this.state.player.y = this.room.height / 2;
    this.state.breakables = this.room.breakables.map((b) => ({
      ...b,
      alive: true,
    }));
  }
  private beginWave() {
    const waves = this.room.waveBudgets
      ? allocateEncounterWaves(
          this.definition.enemies.filter((e) =>
            this.room.spawnRoles?.includes(e.id),
          ),
          this.room.waveBudgets,
          this.seed,
        )
      : this.room.waves;
    this.state.spawn = [...(waves[this.state.wave] ?? [])];
    if (this.room.boss && this.state.wave === 0)
      this.state.spawn.push(this.room.boss);
    this.state.spawnTimer = 0;
  }
  private proc(hook: string, target: ArenaActor, action?: ActionInstance) {
    const s = this.state;
    const context = {
      hook,
      now: s.time,
      actionId: String(action?.id ?? s.nextId),
      turnId: String(s.room),
      sources: ["direct"],
    };
    const triggers = s.boons.flatMap((id) => {
      const b = this.definition.boons.find((b) => b.id === id);
      return b?.proc && (b.proc === "chain" || b.proc === "heal")
        ? [
            {
              id: b.id,
              hook: b.proc === "chain" ? "attack" : "kill",
              effects: [b.proc],
              oncePerAction: b.proc === "chain",
              cooldown: b.proc === "chain" ? 0.2 : 0,
              excludedSources: ["proc"],
              maxStacks: 1,
            },
          ]
        : [];
    });
    const budget = new RuleBudget(16);
    for (const trigger of eligibleTriggers(
      triggers,
      { flags: {}, stats: {}, inventory: {} },
      context,
      s.triggerMemory,
    )) {
      budget.step();
      markTrigger(trigger.id, context, s.triggerMemory);
      for (const effect of trigger.effects) {
        budget.step();
        if (effect === "heal")
          s.player.hp = Math.min(s.player.maxHp, s.player.hp + 3);
        else {
          const next = s.enemies.find(
            (n) =>
              n !== target &&
              n.hp > 0 &&
              Math.hypot(n.x - target.x, n.y - target.y) < 4,
          );
          if (next) this.damage(next, 12, s.player, undefined, true);
        }
      }
    }
  }
  private emit(kind: string, x = this.state.player.x, contact?: Partial<ArenaContact>) {
    // Single consumer, retain newest 512; expose cumulative loss in checkpoint.
    if (this.events.length === 512) { this.events.shift(); this.droppedEvents++; }
    this.events.push({
      sequence: ++this.sequence,
      tick: this.ticks,
      sourceId: "arena",
      kind,
      payload: { pan: (x / this.room.width) * 2 - 1, ...contact },
    });
  }
  drainEvents() {
    return this.events.splice(0);
  }
  private move(a: ArenaActor, dx: number, dy: number) {
    const oldX = a.x,
      oldY = a.y;
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.15));
    for (let j = 0; j < n; j++) {
      for (const axis of ["x", "y"] as const) {
        const value = axis === "x" ? dx / n : dy / n;
        const x = a.x + (axis === "x" ? value : 0),
          y = a.y + (axis === "y" ? value : 0);
        if (
          x > 0.45 &&
          y > 0.45 &&
          x < this.room.width - 0.45 &&
          y < this.room.height - 0.45 &&
          !this.state.breakables.some((b) => b.alive && Math.hypot(x - b.x, y - b.y) < 0.65) &&
          !this.room.pillars.some(
            (p) => Math.hypot(x - p.x, y - p.y) < p.radius + 0.35,
          )
        )
          a[axis] += value;
      }
    }
    const distance = Math.hypot(a.x - oldX, a.y - oldY);
    if (distance > 0.00001) {
      a.moving = true;
      a.locomotion = (a.locomotion ?? 0) + distance * 0.3;
    }
  }
  private damage(
    target: ArenaActor,
    amount: number,
    source: ArenaActor,
    action?: ActionInstance,
    proc = false,
  ) {
    if (
      target.hp <= 0 ||
      (target.invulnerable ?? 0) > 0 ||
      (action && !claimActionHit(action, target.id))
    )
      return;
    const def = this.definition.enemies.find((e) => e.id === target.definition);
    const angle = Math.atan2(source.y - target.y, source.x - target.x);
    if (
      def?.role === "shield" &&
      Math.cos(angle - target.facing) > 0.35 &&
      !target.shieldBroken &&
      (!target.action || actionPhase(target.action).phase !== "recover") &&
      !action?.special
    ) {
      this.state.impacts.push({ id: this.state.nextId++, x: target.x, y: target.y, life: 0.14, shake: 1, sparks: 8, color: 0xc5efff, moveId: action?.moveId, material: "block", outcome: "blocked", heading: angle + Math.PI });
      this.scale.request();
      this.emit("shield", target.x, { actionId: action?.id ?? 0, moveId: action?.moveId ?? "projectile", targetId: target.id, x: target.x, y: target.y, heading: angle + Math.PI, material: "block", damage: 0, outcome: "blocked" });
      return;
    }
    if (def?.role === "shield" && action?.special && !target.shieldBroken) {
      target.shieldBroken = true;
      target.shieldBreak = 0.45;
      target.action = undefined;
      this.emit("shieldBreak", target.x, { actionId: action.id, moveId: action.moveId, targetId: target.id, x: target.x, y: target.y, heading: angle + Math.PI, material: "armor", outcome: "hit" });
    }
    const material =
      def?.material ??
      (def?.role === "shield"
        ? "shielded"
        : def?.role === "boss"
          ? "armored"
          : "organic");
    const impact = (source.id === "player"
      ? this.weapon.impacts?.[material]
      : undefined) ?? {
      stagger: 0.12,
      knockback: 0.22,
      shake: 3,
      sparks: 6,
      sound: "hit",
    };
    const backAttack =
      target.id !== "player" && Math.cos(angle - target.facing) < -0.4;
    target.hp = Math.max(0, target.hp - amount * (backAttack ? 1.25 : 1));
    target.stagger = impact.stagger;
    // A reaction cancels the interrupted tell; never damage from a hidden attack.
    if (target.id !== "player") target.action = undefined;
    this.state.impacts.push({
      id: this.state.nextId++,
      x: target.x,
      y: target.y,
      life: 0.18,
      shake: impact.shake,
      sparks: impact.sparks,
      color: material === "organic" ? 0xffbc83 : 0xc5efff,
      moveId: action?.moveId,
      material: target.hp <= 0 ? "kill" : material === "organic" ? "organic" : "armor",
      outcome: target.hp <= 0 ? "killed" : "hit",
      heading: angle + Math.PI,
    });
    this.state.impacts = this.state.impacts.slice(-64);
    target.hurt = 0.18;
    target.invulnerable = target.id === "player" ? 0.65 : 0;
    target.hurtProtection = target.id === "player" ? 0.65 : 0;
    target.animation = {
      kind: target.hp > 0 ? "hurt" : "death",
      id: this.state.nextId++,
      elapsed: 0,
    };
    if (target.hp <= 0) {
      target.action = undefined;
      target.deathTime = 0;
    }
    const move = this.weapon.moves?.find((m) => m.id === action?.moveId);
    const recoil = move?.recoil ?? impact.knockback;
    target.recoil = { x: Math.cos(angle + Math.PI) * recoil / 0.14, y: Math.sin(angle + Math.PI) * recoil / 0.14, remaining: 0.14 };
    this.emit(target.id === "player" ? "damage" : move?.presentationEvents?.contact ?? impact.sound, target.x, {
      actionId: action?.id ?? 0, moveId: action?.moveId ?? "projectile", targetId: target.id,
      x: target.x, y: target.y, heading: angle + Math.PI,
      material: target.hp <= 0 ? "kill" : material === "organic" ? "organic" : "armor",
      damage: amount * (backAttack ? 1.25 : 1), outcome: target.hp <= 0 ? "killed" : "hit",
    });
    this.scale.request((move?.recoil ?? 0) > 0.4);
    if (target.id !== "player" && !proc && source.id === "player")
      this.proc("attack", target, action);
    if (target.hp === 0 && target.id !== "player") {
      this.proc("kill", target, action);
      this.emit("delivery", target.x);
    }
  }
  private sweptMoveHits(move: ArenaMoveDefinition, from: ArenaActor, to: ArenaActor, target: ArenaActor, action: ActionInstance) {
    const samples = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 0.15));
    for (let i = 0; i <= samples; i++) if (this.moveHits(move, { ...to, x: from.x + (to.x - from.x) * i / samples, y: from.y + (to.y - from.y) * i / samples }, target, action)) return true;
    return false;
  }
  private moveHits(move: ArenaMoveDefinition, source: ArenaActor, target: { x: number; y: number }, action: ActionInstance) {
    const dx = target.x - source.x, dy = target.y - source.y;
    const heading = action.heading ?? source.facing;
    const forward = dx * Math.cos(heading) + dy * Math.sin(heading);
    const side = -dx * Math.sin(heading) + dy * Math.cos(heading);
    const shape = move.hitShape;
    if (shape.kind === "radial") return Math.hypot(dx, dy) < shape.range + 0.35;
    if (shape.kind === "capsule") return Math.hypot(forward - Math.max(0, Math.min(shape.range, forward)), side) < shape.radius + 0.35;
    const progress = actionPhase(action).progress;
    const center = (shape.reverse ? -1 : 1) * (progress - 0.5) * shape.arc * 0.35;
    return Math.hypot(dx, dy) < shape.range + 0.35 && Math.abs(Math.atan2(side, forward) - center) < shape.arc * (0.35 + progress * 0.15);
  }
  private projectile(
    a: ArenaActor,
    angle: number,
    damage: number,
    speed = 9,
    returning = false,
  ) {
    if (this.state.projectiles.length >= 96) return;
    this.state.projectiles.push({
      id: this.state.nextId++,
      x: a.x,
      y: a.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: returning ? 1.4 : 2.5,
      damage,
      owner: a.id,
      returning,
      hits: [],
    });
  }
  private castImpact(projectile: ArenaProjectile) {
    if (!projectile.cast) return;
    projectile.cast = false;
    this.emit("castContact", projectile.x, { actionId: projectile.actionId ?? projectile.id, moveId: "cast", x: projectile.x, y: projectile.y, heading: Math.atan2(projectile.vy, projectile.vx) });
    if (this.state.boons.some((id) => this.definition.boons.find((boon) => boon.id === id)?.proc === "echo-cast")) {
      this.state.echoes ??= [];
      this.state.echoes.push({ x: projectile.x, y: projectile.y, delay: 0.22, id: projectile.actionId ?? projectile.id });
    }
  }
  step(realDt: number, input: ArenaInput) {
    if (!Number.isFinite(realDt) || realDt < 0) throw Error("Invalid arena delta");
    for (const value of [input.x, input.y, input.aimX, input.aimY, input.movementScale ?? 1])
      if (!Number.isFinite(value)) throw Error("Invalid arena input");
    for (const value of [input.attack, input.attackHeld, input.attackReleased, input.special, input.dash, input.cast])
      if (typeof value !== "boolean") throw Error("Invalid arena input");
    if ((input.cancelled !== undefined && typeof input.cancelled !== "boolean") ||
      (input.command !== undefined && typeof input.command !== "string")) throw Error("Invalid arena input");
    if (this.clock === "legacy-delta-v1") {
      // Legacy ticks count explicit positive-delta kernel calls, not 60Hz time.
      // A paused command is stamped with the last completed owner tick.
      if (realDt > 0) this.ticks = checkedIncrement(this.ticks);
      this.advanceKernel(realDt, input); return;
    }
    // Preflight the complete host batch before cancellation/input/clock writes.
    const accumulated = this.remainder + Math.min(0.05, realDt);
    const accruedTicks = Math.floor((accumulated + 1e-12) * 60);
    if (!Number.isSafeInteger(this.ticks + accruedTicks)) throw Error("Arena tick overflow");
    if (input.cancelled) {
      this.clearCommands();
      this.pendingInput = null;
      if (realDt === 0) return;
    }
    const previous = this.pendingInput;
    this.pendingInput = { ...input,
      attack: input.attack || !!previous?.attack,
      attackReleased: input.attackReleased || !!previous?.attackReleased,
      dash: input.dash || !!previous?.dash,
      cast: input.cast || !!previous?.cast,
      special: input.special || !!previous?.special,
      command: input.command ?? previous?.command,
    };
    this.remainder += Math.min(0.05, realDt);
    while (this.remainder + 1e-12 >= 1 / 60) {
      const next = this.pendingInput!;
      this.ticks++;
      this.advanceKernel(1 / 60, next);
      this.remainder = Math.max(0, this.remainder - 1 / 60);
      this.pendingInput = { ...input, attack: false, attackReleased: false, command: undefined };
    }
    // Only unconsumed edge work belongs in a checkpoint. Held controls are
    // supplied by the next host call, including after a restore.
    if (this.remainder < 1e-12) { this.remainder = 0; this.pendingInput = null; }
  }
  private advanceKernel(realDt: number, input: ArenaInput) {
    const s = this.state;
    s.inputClock = (s.inputClock ?? 0) + Math.max(0, realDt);
    if (input.cancelled) {
      this.clearCommands();
      if (realDt <= 0) return;
    }
    if (input.cancelled)
      input = {
        ...input,
        x: 0,
        y: 0,
        attack: false,
        attackHeld: false,
        attackReleased: false,
        special: false,
        dash: false,
        cast: false,
      };
    if (input.command) this.command(input.command);
    if (s.phase !== "combat") {
      const dt = Math.min(0.05, realDt);
      this.advancePresentation(dt);
      for (const impact of s.impacts) impact.life -= dt;
      s.impacts = s.impacts.filter((i) => i.life > 0);
      return;
    }
    const dt = Math.min(0.05, realDt) * this.scale.step(realDt);
    s.time += dt;
    for (const a of [s.player, ...s.enemies]) {
      a.moving = false;
      a.hurt = Math.max(0, a.hurt - dt);
      a.shieldBreak = Math.max(0, (a.shieldBreak ?? 0) - dt);
      a.invulnerable = Math.max(0, (a.invulnerable ?? 0) - dt);
      a.hurtProtection = Math.max(0, (a.hurtProtection ?? 0) - dt);
      if (a.recoil) {
        const span = Math.min(dt, a.recoil.remaining);
        this.move(a, a.recoil.x * span, a.recoil.y * span);
        a.recoil.remaining -= span;
        if (a.recoil.remaining <= 0) a.recoil = undefined;
      }
    }
    s.comboRemaining = Math.max(0, (s.comboRemaining ?? 0) - dt);
    if (s.comboRemaining === 0 && !s.player.action) s.combo = -1;
    for (const impact of s.impacts) impact.life -= dt;
    s.impacts = s.impacts.filter((i) => i.life > 0);
    s.castPose = Math.max(0, s.castPose - dt);
    const p = s.player;
    const previousPlayer = { ...p };
    if (input.cancelled) {
      s.charge = 0;
      this.buffer = 0;
    }
    const aim = Math.atan2(input.aimY - p.y, input.aimX - p.x);
    if (!p.action && s.dashTime <= 0) p.facing = aim;
    s.cast = Math.max(0, s.cast - dt);
    s.dashTime = Math.max(0, s.dashTime - dt);
    s.dashRecharge += dt;
    const maxDash = this.stat(2, "dash");
    if (s.dashRecharge >= 0.65 && s.dash < maxDash) {
      s.dash++;
      s.dashRecharge = 0;
    }
    const edges = s.inputEdges ?? { dash: false, special: false, cast: false };
    s.commands = (s.commands ?? []).filter((c) => s.inputClock! - c.at <= 0.12 + 1e-9);
    for (const kind of ["attack", "cast", "special", "dash"] as const) {
      if ((kind === "attack" ? input.attack : input[kind] && !edges[kind]) && !input.cancelled) {
        s.commands = s.commands.filter((c) => c.kind !== kind);
        s.commands.push({ kind, at: s.inputClock!, order: s.commandOrder = (s.commandOrder ?? 0) + 1, aim, heading: Math.hypot(input.x, input.y) > 0.1 ? Math.atan2(input.y, input.x) : aim });
      }
    }
    s.inputEdges = { dash: input.dash, special: input.special, cast: input.cast };
    const legal = (kind: ArenaCommand["kind"]) => kind === "dash"
      ? s.dash > 0 && (!p.action || (p.action.elapsed >= (p.action.timing.cancelAfter ?? Infinity) && (!this.weapon.moves?.length || !!this.weapon.moves.find((m) => m.id === p.action?.moveId)?.nextMoves.includes("dash"))))
      : kind === "cast" ? s.cast === 0 && !p.action && s.dashTime <= 0
      : (!p.action && (kind !== "special" || s.dashTime <= 0)) || (!!p.action && kind === "attack" && this.weapon.kind === "sword" && actionPhase(p.action).phase === "recover" && p.action.elapsed >= (p.action.timing.comboAfter ?? Infinity));
    const priority = { attack: 0, cast: 1, special: 2, dash: 3 };
    const selected = [...s.commands].filter((c) => legal(c.kind)).sort((a, b) => b.at - a.at || priority[b.kind] - priority[a.kind] || b.order - a.order)[0];
    if (selected) s.commands = s.commands.filter((c) => c !== selected);
    input = { ...input, dash: selected?.kind === "dash", special: selected?.kind === "special", cast: selected?.kind === "cast" };
    this.buffer = selected?.kind === "attack" || (!selected && input.attackHeld && this.weapon.kind === "sword" && legal("attack")) ? 0.12 : 0;
    if (
      input.dash &&
      s.dash > 0 &&
      (!p.action || p.action.elapsed >= (p.action.timing.cancelAfter ?? 0))
    ) {
      s.dash--;
      s.dashTime = 0.16;
      s.dashSpeedScale =
        Math.hypot(input.x, input.y) > 0.1 ? (input.movementScale ?? 1) : 1;
      p.invulnerable = Math.max(p.invulnerable ?? 0, 0.1);
      p.animation = { kind: "dash", id: s.nextId++, elapsed: 0 };
      s.charge = 0;
      p.action = undefined;
      p.facing =
        selected?.heading ?? (Math.hypot(input.x, input.y) > 0.1 ? Math.atan2(input.y, input.x) : aim);
      if (s.boons.some((id) => this.definition.boons.find((b) => b.id === id)?.proc === "ember-wake")) {
        s.trails ??= [];
        s.trails.push({ x: p.x, y: p.y, life: 0.8, hits: [], id: s.nextId++ });
      }
      this.emit("jump");
    }
    const movement = Math.hypot(input.x, input.y);
    if (s.dashTime > 0) {
      this.move(
        p,
        Math.cos(p.facing) * dt * 18 * (s.dashSpeedScale ?? 1),
        Math.sin(p.facing) * dt * 18 * (s.dashSpeedScale ?? 1),
      );
      if (s.boons.some((id) => this.definition.boons.find((b) => b.id === id)?.proc === "ember-wake") && dt > 0) {
        s.trails ??= [];
        const last = s.trails.at(-1);
        if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 0.4) s.trails.push({ x: p.x, y: p.y, life: 0.8, hits: [], id: s.nextId++ });
        s.trails = s.trails.slice(-32);
      }
    } else if (movement > 0) {
      const phase = p.action ? actionPhase(p.action).phase : undefined;
      const mobility =
        phase === "tell"
          ? 0.35
          : phase === "active"
            ? 0.2
            : phase === "recover"
              ? 0.65
              : s.charge > 0
                ? 0.55
                : 1;
      this.move(
        p,
        (input.x / movement) * dt * 4.5 * mobility * (input.movementScale ?? 1),
        (input.y / movement) * dt * 4.5 * mobility * (input.movementScale ?? 1),
      );
    }
    if (
      !p.action &&
      s.dashTime <= 0 &&
      (this.weapon.kind === "bow" || this.weapon.kind === "spear") &&
      input.attackHeld
    )
      s.charge = Math.min(1.4, s.charge + dt);
    const bowRelease =
      this.weapon.kind === "bow" &&
      ((input.attackReleased && s.charge > 0) ||
        (input.attack && s.dashTime > 0));
    const sweep =
      this.weapon.kind === "spear" && input.attackReleased && s.charge > 0.4;
    if (
      ((this.buffer > 0 && this.weapon.kind !== "bow") ||
        bowRelease ||
        input.special ||
        sweep) &&
      (!p.action ||
        (this.weapon.kind === "sword" &&
          !input.special &&
          actionPhase(p.action).phase === "recover" &&
          p.action.elapsed >= (p.action.timing.comboAfter ?? Infinity)) ||
        (sweep && p.action.elapsed > 0.3))
    ) {
      const priorMove = this.weapon.moves?.find((m) => m.id === p.action?.moveId);
      p.action = {
        id: s.nextId++,
        elapsed: 0,
        timing:
          input.special || sweep
            ? { tell: 0.22, active: 0.16, recover: 0.32 }
            : this.weapon.timing,
        hits: [],
      };
      p.facing = s.dashTime > 0 ? p.facing : (selected?.aim ?? aim);
      (
        p.action as ActionInstance & { special?: boolean; charge?: number }
      ).special = input.special || sweep;
      (
        p.action as ActionInstance & { sweep?: boolean; dashStrike?: boolean }
      ).sweep = sweep;
      (p.action as ActionInstance & { dashStrike?: boolean }).dashStrike =
        !p.action.special && s.dashTime > 0;
      (p.action as ActionInstance & { charge?: number }).charge = s.charge;
      this.buffer = 0;
      s.charge = 0;
      s.combo = p.action.special || p.action.dashStrike ? -1 : (s.combo + 1) % 3;
      s.comboRemaining = 0.9;
      p.action.combo = Math.max(0, s.combo);
      const moveId = p.action.special ? "special" : p.action.dashStrike ? "dash-strike" : `sword${s.combo + 1}`;
      const chainedMove = priorMove?.nextMoves.find((id) => id.startsWith("sword"));
      const resolvedMoveId = priorMove && !p.action.special && !p.action.dashStrike && chainedMove ? chainedMove : moveId;
      const move = this.weapon.moves?.find((m) => m.id === resolvedMoveId);
      p.action.moveId = move?.id;
      p.action.clipId = move?.clipId;
      p.action.heading = p.facing;
      if (move) p.action.timing = { ...move.timing };
      this.emit(move?.presentationEvents?.windup ?? "windup", p.x, { actionId: p.action.id, moveId: p.action.moveId, x: p.x, y: p.y, heading: p.facing });
    }
    if (input.cast && s.cast === 0 && !p.action && s.dashTime <= 0) {
      const move = this.weapon.moves?.find((m) => m.id === "cast");
      if (move) {
        p.facing = selected?.aim ?? aim;
        p.action = { id: s.nextId++, moveId: move.id, clipId: move.clipId, heading: p.facing, elapsed: 0, timing: { ...move.timing }, hits: [] };
      } else {
        this.projectile(p, selected?.aim ?? aim, 22, 11);
        const cast = s.projectiles.at(-1);
        if (cast) { cast.cast = true; cast.actionId = s.nextId++; }
      }
      s.combo = -1;
      s.comboRemaining = 0;
      s.cast = 3;
      s.castPose = 0.32;
      p.animation = { kind: "cast", id: s.nextId++, elapsed: 0 };
      this.emit("clue");
    }
    if (p.action) {
      const a = p.action as ActionInstance & {
        special?: boolean;
        charge?: number;
        sweep?: boolean;
        dashStrike?: boolean;
      };
      const before = actionPhase(a).phase;
      const move = this.weapon.moves?.find((m) => m.id === a.moveId);
      if (move && a.elapsed < move.aimLock) { a.heading = aim; p.facing = aim; }
      const previousElapsed = a.elapsed;
      a.elapsed += dt;
      if (move) {
        const duration = move.timing.tell + move.timing.active;
        const curve = (elapsed: number) => {
          const t = Math.min(1, elapsed / duration);
          return move.displacementCurve === "linear" ? t : 1 - (1 - t) * (1 - t);
        };
        const step = move.displacement * (curve(a.elapsed) - curve(previousElapsed));
        this.move(p, Math.cos(a.heading ?? p.facing) * step, Math.sin(a.heading ?? p.facing) * step);
      }
      const phase = actionPhase(a).phase;
      if (a.dashStrike && before === "tell" && phase !== "tell") { p.invulnerable = p.hurtProtection ?? 0; s.dashTime = 0; }
      if (before === "tell" && phase !== "tell" && a.moveId !== "cast")
        this.emit(move?.presentationEvents?.active ?? (a.moveId === "cast" ? "castRelease" : this.weapon.kind === "sword" ? "swordSwish" : "attack"), p.x, { actionId: a.id, moveId: a.moveId, x: p.x, y: p.y, heading: a.heading ?? p.facing });
      if (phase === "active" && a.moveId === "cast" && !a.hits.includes("fired")) {
        a.hits.push("fired");
        this.projectile(p, a.heading ?? p.facing, move?.damage ?? 22, 11);
        const projectile = s.projectiles.at(-1);
        if (projectile) { projectile.cast = true; projectile.actionId = a.id; }
        this.emit("castRelease", p.x, { actionId: a.id, moveId: "cast", x: p.x, y: p.y, heading: a.heading ?? p.facing });
      }
      if (phase === "active" && a.moveId !== "cast") {
        const damage =
          this.stat(
            move?.damage ?? (a.special ? this.weapon.specialDamage : this.weapon.damage),
            "damage",
            [a.special ? "special" : "attack", this.weapon.kind],
          ) *
          (move ? 1 : (1 + (s.combo === 2 ? 0.35 : 0)) * (a.dashStrike ? 1.5 : 1));
        if (
          this.weapon.kind === "bow" ||
          (this.weapon.kind === "spear" && a.special && !a.sweep)
        ) {
          if (!a.hits.includes("fired")) {
            a.hits.push("fired");
            const perfect = (a.charge ?? 0) > 0.65 && (a.charge ?? 0) < 0.95;
            for (
              let j = 0;
              j < (a.special && this.weapon.kind === "bow" ? 5 : 1);
              j++
            )
              this.projectile(
                p,
                p.facing +
                  (a.special && this.weapon.kind === "bow"
                    ? (j - 2) * 0.17
                    : 0),
                damage * (perfect ? this.stat(1.8, "charge") : 1),
                this.weapon.kind === "spear" ? 10 : 13,
                this.weapon.kind === "spear",
              );
          }
        } else
          for (const e of s.enemies) {
            const distance = Math.hypot(e.x - p.x, e.y - p.y),
              angle = Math.atan2(e.y - p.y, e.x - p.x);
            if (
              move ? this.sweptMoveHits(move, previousPlayer, p, e, a) : distance < this.attackRange(a.special ?? false) &&
              (a.special || Math.cos(angle - p.facing) > 0.2)
            ) {
              this.damage(e, damage, p, a);
            }
          }
        for (const b of s.breakables)
          if (
            b.alive &&
            (move ? this.moveHits(move, p, b, a) : Math.hypot(b.x - p.x, b.y - p.y) <
              this.attackRange(a.special ?? false) &&
            (a.special ||
              Math.cos(Math.atan2(b.y - p.y, b.x - p.x) - p.facing) > 0.2))
          ) {
            b.alive = false;
            p.hp = Math.min(100, p.hp + 2);
            this.emit("urnBreak", b.x);
          }
      }
      if (phase === "done") {
        if (!a.hits.length) this.emit("miss", p.x, { actionId: a.id, moveId: a.moveId ?? this.weapon.id, targetId: "", x: p.x, y: p.y, heading: p.facing, material: "miss", damage: 0, outcome: "miss" });
        p.action = undefined;
      }
      void before;
    }
    s.spawnTimer -= dt;
    if (
      s.spawn.length &&
      s.spawnTimer <= 0 &&
      s.enemies.filter((e) => e.hp > 0).length < 12
    ) {
      const id = s.spawn.shift()!,
        d = this.definition.enemies.find((e) => e.id === id)!;
      const n = s.nextId++;
      s.enemies.push({
        id: `enemy-${n}`,
        definition: id,
        x: this.room.width - 2 - (n % 3),
        y: 2 + ((n * 3) % Math.max(1, this.room.height - 4)),
        hp: d.health,
        maxHp: d.health,
        facing: Math.PI,
        cooldown: 0.8 + (n % 3) * 0.35,
        hurt: 0,
      });
      s.spawnTimer = this.room.spawnInterval ?? 0.65;
    }
    for (const e of s.enemies) {
      if (e.hp <= 0) {
        continue;
      }
      // Training is the explicit disabled-AI flag; its finite cooldown is never advanced.
      if (e.training) continue;
      e.stagger = Math.max(0, (e.stagger ?? 0) - dt);
      if (e.stagger > 0) continue;
      const d = this.definition.enemies.find((v) => v.id === e.definition)!;
      e.cooldown -= dt;
      const angle = Math.atan2(p.y - e.y, p.x - e.x),
        distance = Math.hypot(p.x - e.x, p.y - e.y),
        boss = d.role === "boss",
        phaseTwo = boss && e.hp < e.maxHp * 0.5;
      if (!e.action) {
        e.facing = angle;
        if (distance > (d.role === "ranged" ? 6 : 1.6)) {
          const obstacle = this.room.pillars.find((o) => {
            const dx = o.x - e.x,
              dy = o.y - e.y;
            return (
              dx * Math.cos(angle) + dy * Math.sin(angle) > 0 &&
              Math.abs(dx * Math.sin(angle) - dy * Math.cos(angle)) <
                o.radius + 0.55 &&
              Math.hypot(dx, dy) < o.radius + 2
            );
          });
          const steer = obstacle
            ? angle + (e.id.charCodeAt(e.id.length - 1) % 2 ? 1 : -1) * 1.2
            : angle;
          this.move(
            e,
            Math.cos(steer) * d.speed * dt,
            Math.sin(steer) * d.speed * dt,
          );
          for (const other of s.enemies)
            if (
              other !== e &&
              other.hp > 0 &&
              Math.hypot(other.x - e.x, other.y - e.y) < 0.7
            )
              this.move(e, (e.x - other.x) * dt, (e.y - other.y) * dt);
        }
        if (e.cooldown <= 0 && (distance < 2 || d.role === "ranged" || boss)) {
          if (boss) e.attackKind = ((e.attackKind ?? -1) + 1) % 3;
          e.action = {
            id: s.nextId++,
            elapsed: 0,
            timing: {
              ...d.timing,
              recover: d.timing.recover * (phaseTwo ? 0.6 : 1),
            },
            hits: [],
          };
        }
      } else {
        const a = e.action;
        a.elapsed += dt;
        if (actionPhase(a).phase === "active") {
          if (d.attackDisplacement) this.move(e, Math.cos(e.facing) * d.attackDisplacement * dt / d.timing.active, Math.sin(e.facing) * d.attackDisplacement * dt / d.timing.active);
          if (boss && e.attackKind === 1)
            this.move(
              e,
              Math.cos(e.facing) * dt * 12,
              Math.sin(e.facing) * dt * 12,
            );
          if (
            (d.role === "ranged" || (boss && e.attackKind !== 1)) &&
            !a.hits.includes("fired")
          ) {
            a.hits.push("fired");
            const radial = boss && e.attackKind === 2,
              count = radial ? 12 : phaseTwo ? 7 : boss ? 3 : 1;
            for (let j = 0; j < count; j++)
              this.projectile(
                e,
                radial
                  ? (j / count) * Math.PI * 2
                  : e.facing + (j - (count - 1) / 2) * 0.2,
                d.damage,
                phaseTwo ? 6 : 4,
              );
          }
          if (Math.hypot(p.x - e.x, p.y - e.y) < (boss ? 2.6 : 1.7) && Math.cos(Math.atan2(p.y - e.y, p.x - e.x) - e.facing) > 0.1)
            this.damage(p, d.damage, e, a);
        }
        if (actionPhase(a).phase === "done") {
          e.action = undefined;
          e.cooldown = boss ? 0.5 : 1;
        }
      }
    }
    for (const b of s.projectiles) {
      b.life -= dt;
      if (b.returning && b.life < 0.7) {
        const angle = Math.atan2(p.y - b.y, p.x - b.x);
        b.vx = Math.cos(angle) * 11;
        b.vy = Math.sin(angle) * 11;
      }
      const steps = Math.max(
        1,
        Math.ceil((Math.hypot(b.vx, b.vy) * dt) / 0.15),
      );
      for (let j = 0; j < steps && b.life > 0; j++) {
        b.x += (b.vx * dt) / steps;
        b.y += (b.vy * dt) / steps;
        if (
          this.room.pillars.some(
            (o) => Math.hypot(b.x - o.x, b.y - o.y) < o.radius,
          ) ||
          b.x < 0 ||
          b.y < 0 ||
          b.x > this.room.width ||
          b.y > this.room.height
        ) {
          b.life = 0;
          this.castImpact(b);
          break;
        }
        const pot = s.breakables.find((pot) => pot.alive && Math.hypot(pot.x - b.x, pot.y - b.y) < 0.45);
        if (pot) { pot.alive = false; b.life = 0; this.castImpact(b); this.emit("urnBreak", pot.x); break; }
        const targets = b.owner === "player" ? s.enemies : [p];
        for (const target of targets)
          if (
            target.hp > 0 &&
            !b.hits.includes(target.id) &&
            Math.hypot(target.x - b.x, target.y - b.y) < 0.55
          ) {
            b.hits.push(target.id);
            this.damage(target, b.damage, {
              ...(b.owner === "player"
                ? p
                : (s.enemies.find((e) => e.id === b.owner) ?? p)),
              id: b.owner,
              // Projectile contact direction remains correct after its shooter moves or dies.
              x: b.x - b.vx,
              y: b.y - b.vy,
            }, { id: b.actionId ?? b.id, moveId: b.cast ? "cast" : "projectile", elapsed: 0, timing: { tell: 0, active: 1, recover: 0 }, hits: [] });
            this.castImpact(b);
            if (!b.returning) b.life = 0;
          }
      }
    }
    s.projectiles = s.projectiles.filter((b) => b.life > 0);
    s.enemies = s.enemies.filter((e) => e.hp > 0 || (e.deathTime ?? 0) < 0.8);
    if (this.room.trap) {
      const config = this.room.trap;
      const trap = s.trap ??= { elapsed: 0, cycle: 0, phase: "warning", hits: [] };
      trap.elapsed += dt;
      const length = config.warning + config.active + config.cooldown;
      while (trap.elapsed >= length) { trap.elapsed -= length; trap.cycle++; trap.hits = []; }
      trap.phase = trap.elapsed < config.warning ? "warning" : trap.elapsed < config.warning + config.active ? "active" : "cooldown";
      if (trap.phase === "active") for (const actor of [p, ...s.enemies]) {
        if (actor.hp > 0 && !trap.hits.includes(actor.id) && Math.hypot(actor.x - config.x, actor.y - config.y) < config.radius + 0.3 && (actor.invulnerable ?? 0) <= 0) {
          trap.hits.push(actor.id);
          this.damage(actor, config.damage, { ...p, id: "spike-trap", x: config.x, y: config.y });
        }
      }
    }
    for (const trail of s.trails ?? []) {
      trail.life -= dt;
      for (const enemy of s.enemies) if (enemy.hp > 0 && !trail.hits.includes(enemy.id) && Math.hypot(enemy.x - trail.x, enemy.y - trail.y) < 1) {
        trail.hits.push(enemy.id);
        this.damage(enemy, 12, { ...p, x: trail.x, y: trail.y }, { id: trail.id, moveId: "ember-wake", timing: { tell: 0, active: 1, recover: 0 }, elapsed: 0, hits: [] }, true);
      }
    }
    s.trails = s.trails?.filter((trail) => trail.life > 0);
    for (const echo of s.echoes ?? []) {
      echo.delay -= dt;
      if (echo.delay <= 0) {
        const action = { id: echo.id, moveId: "echo-cast", timing: { tell: 0, active: 1, recover: 0 }, elapsed: 0, hits: [] };
        for (const enemy of s.enemies) if (Math.hypot(enemy.x - echo.x, enemy.y - echo.y) < 1.3) this.damage(enemy, 11, { ...p, x: echo.x, y: echo.y }, action, true);
        this.emit("echoCast", echo.x, { actionId: echo.id, moveId: "echo-cast", x: echo.x, y: echo.y });
      }
    }
    s.echoes = s.echoes?.filter((echo) => echo.delay > 0);
    if (s.exitOpen && this.room.rewardExit && Math.hypot(p.x - this.room.rewardExit.x, p.y - this.room.rewardExit.y) < 0.85) {
      s.phase = "won";
      this.clearCommands();
      this.emit("win");
    }
    if (
      this.room.hazard &&
      Math.min(p.x, p.y, this.room.width - p.x, this.room.height - p.y) <
        this.room.hazard &&
      (p.invulnerable ?? 0) <= 0
    )
      this.damage(p, 4, {
        ...p,
        id: "hazard",
        x: this.room.width / 2,
        y: this.room.height / 2,
      });
    if (p.hp <= 0) {
      s.phase = "lost";
      this.clearCommands();
      this.emit("lose");
    } else if (!s.exitOpen && !s.spawn.length && !s.enemies.some((e) => e.hp > 0)) {
      if (
        s.wave + 1 <
        (this.room.waveBudgets?.length ?? this.room.waves.length)
      ) {
        s.wave++;
        this.beginWave();
      } else if (this.room.rewardExit) {
        s.phase = "upgrade";
        s.offered = [...this.room.rewardExit.boons];
        this.clearCommands();
        this.emit("discovery");
      } else if (s.room + 1 < this.definition.rooms.length) {
        s.phase = "upgrade";
        s.offered = this.definition.boons
          .filter((b) => !s.boons.includes(b.id))
          .map((b) => b.id)
          .sort(
            (a, b) =>
              ((a.charCodeAt(0) + this.seed) % 7) -
              ((b.charCodeAt(0) + this.seed) % 7),
          )
          .slice(0, 3);
        this.emit("discovery");
      } else {
        s.phase = "won";
        this.emit("win");
      }
    }
    this.advancePresentation(dt);
  }
  /** Independent state clocks; gait remains distance-driven in locomotion. */
  private advancePresentation(dt: number) {
    const s = this.state;
    for (const actor of [s.player, ...s.enemies]) {
      const player = actor.id === "player";
      const kind =
        actor.hp <= 0
          ? "death"
          : player && s.dashTime > 0
            ? "dash"
            : actor.hurt > 0
              ? "hurt"
              : actor.action
                ? "attack"
                : player && s.castPose > 0
                  ? "cast"
                  : player && s.charge > 0
                    ? "charge"
                    : actor.moving
                      ? "run"
                      : "idle";
      const id = kind === "attack" ? actor.action!.id : undefined;
      if (
        actor.animation?.kind !== kind ||
        (id !== undefined && actor.animation.id !== id)
      )
        actor.animation = { kind, id: id ?? s.nextId++, elapsed: 0 };
      else actor.animation.elapsed += dt;
      if (kind === "death") actor.deathTime = actor.animation.elapsed;
    }
  }
  snapshot() {
    return structuredClone({ ...this.state,
      sequence: this.sequence, scaleElapsed: this.scale.elapsed,
      scaleCooldown: this.scale.cooldown, buffer: this.buffer,
      checkpoint: { version: 2 as const, seed: this.seed, contentId: this.contentId,
        rulesBuildId: `${this.clock}/event-ticks-v1`, remainder: this.remainder, ticks: this.ticks,
        pendingInput: this.pendingInput, events: this.events, droppedEvents: this.droppedEvents },
    });
  }
  restore(value: unknown) {
    const candidate = validateArenaCheckpoint(value, this.definition, this.seed, this.contentId, this.clock);
    const { checkpoint, ...state } = candidate;
    this.state = state;
    this.events = checkpoint.events;
    this.droppedEvents = checkpoint.droppedEvents;
    this.sequence = state.sequence;
    this.scale.elapsed = state.scaleElapsed;
    this.scale.cooldown = state.scaleCooldown;
    this.buffer = state.buffer;
    this.remainder = checkpoint.remainder;
    this.ticks = checkpoint.ticks;
    this.pendingInput = checkpoint.pendingInput;
  }
}
