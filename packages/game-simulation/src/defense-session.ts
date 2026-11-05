import { checkedIncrement } from "./counters";
import {
  armDeadline,
  deadlineReady,
  remainingTicks,
  secondsToTicks,
  validateTick,
} from "./tick-deadline";
import { ProjectileOwnerV1 } from "./dynamic-projectiles";
import { TransactionOwner } from "./transactions";
import { DamageOwner } from "./damage-owner";
import { DeterministicRandom, deriveRandomSeed } from "./rng";
export type DefenseEventKind = "hit" | "damage" | "delivery" | "win" | "lose";
export interface DefenseDefinitions {
  contentId: string;
  rngNamespace?: string;
  lanes: readonly number[];
  buildings: readonly { id: string; hp: number; maxHp: number }[];
  budgets: readonly number[];
  spawnGap: number;
  activeCap: number;
  arrowCap: number;
  gravity: number;
  intermission: number;
  origin: { x: number; y: number };
  contactX: number;
  spawnX: number;
  initialAngle: number;
  minimumCharge: number;
  speedBase: number;
  speedCharge: number;
  damageBase: number;
  damageCharge: number;
  repairAmount: number;
  maxUpgrades: number;
  waveDuration: number;
  waveKinds?: readonly (readonly number[])[];
  enemyKinds: readonly {
    hp: number;
    speed: number;
    damage: number;
    cost: number;
    attackCadence: number;
  }[];
}
export interface DefenseEnemy {
  id: string;
  kind: number;
  lane: number;
  x: number;
  y: number;
  hp: number;
  attack: number;
}
export type DefenseCommand =
  | { type: "aim"; angle: number }
  | {
      type:
        | "draw-start"
        | "draw-release"
        | "draw-cancel"
        | "select-building"
        | "repair"
        | "upgrade"
        | "fire";
    };
export interface DefenseEvent {
  sequence: number;
  tick: number;
  sourceId: string;
  kind: DefenseEventKind;
}
/** Events have one destructive drain consumer. Retain newest 512; droppedEvents
 * counts cumulative evictions and is observable/checkpointed across restore. */
export class DefenseSession {
  private owner: ReturnType<typeof createDefenseOwner>;
  constructor(
    readonly definitions: DefenseDefinitions,
    readonly seed: number,
  ) {
    if (
      !definitions.contentId ||
      definitions.lanes.length !== definitions.buildings.length ||
      !definitions.budgets.length ||
      definitions.budgets.some((n) => !Number.isInteger(n) || n < 1) ||
      !definitions.enemyKinds.length
    )
      throw Error("Invalid defense definitions");
    this.owner = createDefenseOwner(definitions, seed);
  }
  command(command: DefenseCommand) {
    this.owner.command(command);
  }
  step(dt: number) {
    this.owner.step(dt);
  }
  observe() {
    return this.owner.observe();
  }
  snapshot() {
    return this.owner.snapshot();
  }
  restore(value: unknown) {
    const candidate = createDefenseOwner(this.definitions, this.seed);
    candidate.restore(value);
    this.owner = candidate;
  }
  drainEvents() {
    return this.owner.drainEvents();
  }
}
export type DefenseObservation = ReturnType<DefenseSession["observe"]>;
export type DefenseCheckpoint = ReturnType<DefenseSession["snapshot"]>;
function createDefenseOwner(definitions: DefenseDefinitions, seed: number) {
  const RULES = definitions,
    KINDS = definitions.enemyKinds;
  // Reject unsupported authored timer durations before any gameplay can advance.
  for (const seconds of [
    RULES.spawnGap,
    ...KINDS.map((kind) => kind.attackCadence),
    ...RULES.budgets.flatMap((budget) =>
      KINDS.map((kind) =>
        Math.max(RULES.spawnGap, (RULES.waveDuration / budget) * kind.cost),
      ),
    ),
  ]) {
    if (!Number.isFinite(seconds) || seconds > 3600)
      throw Error("Defense duration exceeds supported finite one-hour range");
  }
  let tick = 0,
    eventSequence = 0,
    droppedEvents = 0,
    events: DefenseEvent[] = [];
  type Enemy = DefenseEnemy;
  const rng = new DeterministicRandom([
    {
      owner: definitions.rngNamespace ?? "defense",
      name: "waves",
      seed: deriveRandomSeed(seed, "waves"),
    },
  ]);
  let health = new DamageOwner(definitions.buildings);
  const rewards = new TransactionOwner({
    id: `${definitions.contentId}-rewards`,
    resources: [],
    stats: [],
    flags: RULES.budgets.map((_, i) => `choice-${i}`),
    outcomes: RULES.budgets.map((_, i) => `choice-${i}`),
    rewardSeed: seed,
  });
  const arrows = new ProjectileOwnerV1({
    projectiles: RULES.arrowCap,
    targets: RULES.activeCap,
    maxLifetime: 3,
  });
  let enemies: Enemy[] = [],
    wave = 0,
    budget = RULES.budgets[0]!,
    phase: "prepare" | "defense" | "ended" = "prepare",
    intermissionDeadline = armDeadline(
      0,
      intermissionTicks(RULES.intermission),
    ),
    bank = 0,
    spawnDeadline = armDeadline(0, 0),
    waveTime = 0,
    serial = 0,
    charge = 0,
    angle = RULES.initialAngle,
    charging = false,
    score = 0,
    kills = 0,
    upgrades = 0,
    choice = false,
    selected = 0,
    threat = 0,
    mastery = 0,
    outcome: "playing" | "won" | "lost" = "playing",
    event: DefenseEventKind | undefined,
    pendingEvent: DefenseEventKind | undefined,
    message = "Town prepared. Aim right; hold Space or pointer to draw.";
  const attackTimers = new Map<string, { clock: number; deadline: number }>();
  const living = () => health.capture().filter((b) => b.hp > 0);
  const result = (won: boolean) => {
    outcome = won ? "won" : "lost";
    phase = "ended";
    event = won ? "win" : "lose";
    message = won
      ? "All waves survived. The town is safe."
      : "The town has fallen. Restart to defend it again.";
    arrows.clear();
  };
  const choose = (upgrade: boolean) => {
    if (phase !== "prepare" || choice) return;
    const commit = () => {
      const state = rewards.capture();
      if (state.outcomes.includes(`choice-${wave}`)) return false;
      const receipt = rewards.execute({
        id: `choice-${wave}`,
        revision: state.revision,
        outcome: `choice-${wave}`,
        operations: [{ kind: "flag", flag: `choice-${wave}`, value: true }],
      });
      return (
        receipt.id === `choice-${wave}` &&
        receipt.revision === state.revision + 1
      );
    };
    if (upgrade) {
      if (upgrades >= RULES.maxUpgrades) {
        message = "Draw upgrade already at maximum.";
        return;
      }
      if (!commit()) return;
      upgrades++;
      message = "Bow improved: faster draw.";
    } else {
      const b = health.capture()[selected]!;
      if (!b.hp) {
        message = "Destroyed buildings cannot be repaired.";
        return;
      }
      if (!commit()) return;
      health.repair(b.id, RULES.repairAmount);
      message = `${b.id} repaired by 30 HP.`;
    }
    choice = true;
    event = "delivery";
    pendingEvent = "delivery";
  };
  const allocateId = (prefix: string) => {
    const id = `${prefix}-${serial}`;
    serial = checkedIncrement(serial);
    return id;
  };
  const shoot = () => {
    if (charge < RULES.minimumCharge || phase !== "defense") return;
    const strength = Math.min(1, charge),
      speed = RULES.speedBase + RULES.speedCharge * strength;
    if (
      arrows.spawn({
        id: allocateId("arrow"),
        x: RULES.origin.x * 256,
        y: RULES.origin.y * 256,
        vx: cosine(angle) * speed * 256,
        vy: sine(angle) * speed * 256,
        gravity: RULES.gravity * 256,
        radius: 3 * 256,
        life: 3,
        damage: RULES.damageBase + RULES.damageCharge * strength,
        originX: RULES.origin.x * 256,
      })
    ) {
      message = "Arrow away";
    } else message = "Four arrows in flight — wait for a clear shot.";
  };
  const owner = {
    command(command: DefenseCommand) {
      if (command.type === "draw-cancel") {
        charge = 0;
        charging = false;
        return;
      }
      if (outcome !== "playing") return;
      switch (command.type) {
        case "aim":
          if (Number.isFinite(command.angle))
            angle = Math.max(-1.25, Math.min(0.18, command.angle));
          break;
        case "draw-start":
          if (phase === "defense") charging = true;
          break;
        case "draw-release":
          if (charging) {
            shoot();
            charge = 0;
            charging = false;
          }
          break;
        case "fire":
          if (!charging) charge = 1;
          shoot();
          charge = 0;
          charging = false;
          break;
        case "select-building":
          selected = (selected + 1) % RULES.buildings.length;
          break;
        case "repair":
          choose(false);
          break;
        case "upgrade":
          choose(true);
          break;
      }
    },
    advanceTick() {
      const dt = 1 / 60;
      event = pendingEvent;
      pendingEvent = undefined;
      if (outcome !== "playing") return;
      tick = checkedIncrement(tick);
      if (charging && phase === "defense")
        charge = Math.min(1, charge + dt * (1 + upgrades * 0.1));
      try {
        if (phase === "prepare") {
          if (deadlineReady(tick, intermissionDeadline)) {
            phase = "defense";
            spawnDeadline = armDeadline(tick, 0);
            waveTime = 0;
            message = `Wave ${wave + 1}: defend all three lanes.`;
          }
          return;
        }
        waveTime += dt;
        mastery *= decay(dt / 6);
        if (
          budget > 0 &&
          deadlineReady(tick, spawnDeadline) &&
          enemies.length < RULES.activeCap
        ) {
          let kind =
            rng.drawInteger(
              definitions.rngNamespace ?? "defense",
              "waves",
              100,
            ) < 22
              ? 2
              : rng.drawInteger(
                    definitions.rngNamespace ?? "defense",
                    "waves",
                    100,
                  ) < 30
                ? 1
                : 0;
          const allowed = RULES.waveKinds?.[wave];
          if (allowed && !allowed.includes(kind)) kind = allowed[0]!;
          if (
            KINDS[kind]!.cost > budget ||
            (wave === 0 && waveTime < 12 && kind === 2)
          )
            kind = 0;
          if (
            kind === 1 &&
            enemies.filter((e) => e.kind === 1 && e.x > 430).length >= 2
          )
            kind = 0;
          const targets = health
            .capture()
            .map((b, i) => ({ b, i }))
            .filter((x) => x.b.hp > 0);
          const lane =
            targets[
              rng.drawInteger(
                definitions.rngNamespace ?? "defense",
                "waves",
                targets.length,
              )
            ]!.i;
          enemies.push({
            id: allocateId("enemy"),
            kind,
            lane,
            x: RULES.spawnX,
            y: RULES.lanes[lane]!,
            hp: KINDS[kind]!.hp,
            attack: 0,
          });
          attackTimers.set(enemies[enemies.length - 1]!.id, {
            clock: 0,
            deadline: armDeadline(0, 0),
          });
          budget -= KINDS[kind]!.cost;
          spawnDeadline = armDeadline(
            tick,
            legacyDurationTicks(
              Math.max(
                RULES.spawnGap,
                (RULES.waveDuration / RULES.budgets[wave]!) * KINDS[kind]!.cost,
              ),
            ),
          );
        }
        const motions = enemies.map((e) => {
          if (!health.capture()[e.lane]!.hp) {
            const next = health
              .capture()
              .map((b, i) => ({ b, i }))
              .filter((x) => x.b.hp > 0)
              .sort(
                (a, b) =>
                  Math.abs(a.i - e.lane) - Math.abs(b.i - e.lane) || a.i - b.i,
              )[0];
            if (next) e.lane = next.i;
          }
          const nx = Math.max(RULES.contactX, e.x - KINDS[e.kind]!.speed * dt),
            ny =
              e.y +
              Math.sign(RULES.lanes[e.lane]! - e.y) *
                Math.min(Math.abs(RULES.lanes[e.lane]! - e.y), 24 * dt);
          return {
            id: e.id,
            x: e.x * 256,
            y: (e.y - 9) * 256,
            nextX: nx * 256,
            nextY: (ny - 9) * 256,
            radius: 9 * 256,
          };
        });
        const impacts = arrows.step(dt, motions);
        for (const hit of impacts) {
          const e = enemies.find((e) => e.id === hit.targetId);
          if (!e || e.hp <= 0) continue;
          e.hp -= hit.projectile.damage;
          mastery = Math.min(1, mastery + 0.18);
          event = "hit";
          if (e.hp <= 0) {
            kills++;
            const long = e.x - hit.projectile.originX / 256 >= 220;
            score += long ? 150 : 100;
            if (long)
              message =
                e.kind === 1
                  ? "Master shot! A moving runner at long range."
                  : "Long shot!";
          }
        }
        enemies = enemies.filter((e) => {
          if (e.hp > 0) return true;
          attackTimers.delete(e.id);
          return false;
        });
        for (const e of enemies) {
          const m = motions.find((m) => m.id === e.id)!;
          e.x = m.nextX / 256;
          e.y = m.nextY / 256 + 9;
          if (
            e.x <= RULES.contactX &&
            Math.abs(e.y - RULES.lanes[e.lane]!) < 1
          ) {
            // This clock advances only at contact, preserving paused attack work
            // while a destroyed lane makes the enemy move to another target.
            const timer = attackTimers.get(e.id)!;
            timer.clock = checkedIncrement(timer.clock);
            if (deadlineReady(timer.clock, timer.deadline)) {
              const b = health.capture()[e.lane]!;
              const damage = health.damage(b.id, KINDS[e.kind]!.damage);
              timer.deadline = armDeadline(
                timer.clock,
                legacyDurationTicks(KINDS[e.kind]!.attackCadence),
              );
              if (damage.applied) {
                event = "damage";
                message = damage.destroyed
                  ? `${b.id} destroyed! Defend the survivors.`
                  : `${b.id} under attack!`;
              }
            }
            e.attack = remainingTicks(timer.clock, timer.deadline) / 60;
          }
        }
        if (!living().length) {
          result(false);
          return;
        }
        const raw = Math.min(
          1,
          enemies.reduce(
            (n, e) =>
              n +
              ((Math.max(
                0,
                1 - (e.x - RULES.contactX) / KINDS[e.kind]!.speed / 12,
              ) *
                KINDS[e.kind]!.damage) /
                12) *
                0.35,
            0,
          ),
        );
        threat += (raw - threat) * Math.min(1, dt / (raw > threat ? 0.5 : 2));
        if (budget === 0 && enemies.length === 0) {
          score += living().length * 100;
          wave++;
          if (wave === RULES.budgets.length) {
            result(true);
            return;
          }
          phase = "prepare";
          budget = RULES.budgets[wave]!;
          intermissionDeadline = armDeadline(
            tick,
            intermissionTicks(RULES.intermission),
          );
          choice = false;
          event = "delivery";
          message = "Wave clear! R repairs selected building; U improves draw.";
        }
      } finally {
        if (event) {
          events.push({
            sequence: (eventSequence = checkedIncrement(eventSequence)),
            tick,
            sourceId: "defense",
            kind: event,
          });
          if (events.length > 512) {
            events.shift();
            droppedEvents = checkedIncrement(droppedEvents);
          }
        }
      }
    },
    step(dt: number) {
      if (outcome !== "playing" || !Number.isFinite(dt) || dt <= 0) return;
      // Preflight before consuming remainder or dispatching pending events.
      checkedIncrement(tick);
      bank += Math.min(0.05, dt);
      while (bank + 1e-12 >= 1 / 60 && outcome === "playing") {
        bank = Math.max(0, bank - 1 / 60);
        owner.advanceTick();
      }
    },
    observe() {
      return {
        seed,
        droppedEvents,
        tick,
        lanes: [...RULES.lanes],
        origin: { ...RULES.origin },
        speedBase: RULES.speedBase,
        speedCharge: RULES.speedCharge,
        gravity: RULES.gravity,
        waveCount: RULES.budgets.length,
        enemyKinds: RULES.enemyKinds.map((kind) => ({ ...kind })),
        buildings: health.capture(),
        enemies: structuredClone(enemies),
        arrows: arrows.capture(),
        wave,
        budget,
        phase,
        timer: remainingTicks(tick, intermissionDeadline) / 60,
        waveTime,
        charge,
        angle,
        charging,
        score,
        kills,
        upgrades,
        choice,
        selected,
        threat,
        mastery,
        outcome,
        message,
        event,
      };
    },
    drainEvents() {
      const result = events;
      events = [];
      return result;
    },
    snapshot() {
      return {
        version: 3 as const,
        spawnDeadline,
        attackTimers: enemies.map((e) => ({
          id: e.id,
          ...attackTimers.get(e.id)!,
        })),
        bank,
        intermissionDeadline,
        pendingEvent,
        event,
        contentId: RULES.contentId,
        seed,
        charge,
        charging,
        angle,
        tick,
        eventSequence,
        droppedEvents,
        events: structuredClone(events),
        rewards: rewards.capture(),
        health: health.capture(),
        arrows: arrows.capture(),
        enemies: structuredClone(enemies),
        wave,
        budget,
        phase,
        timer: remainingTicks(tick, intermissionDeadline) / 60,
        spawn: remainingTicks(tick, spawnDeadline) / 60,
        waveTime,
        serial,
        score,
        kills,
        upgrades,
        choice,
        selected,
        threat,
        mastery,
        outcome,
        message,
        rng: rng.capture(),
      };
    },
    restore(value: unknown) {
      const v = value as DefenseCheckpoint;
      if (
        !v ||
        ![2, 3].includes(v.version) ||
        v.contentId !== RULES.contentId ||
        v.seed !== seed
      )
        throw Error("Incompatible defense checkpoint");
      const legacy = Number(v.version) === 2;
      validateDefenseCheckpoint(v, RULES, legacy);
      // Convert detached state before publishing any restored owner state.
      const restoredSpawnDeadline = legacy
        ? armDeadline(v.tick, legacyDurationTicks(v.spawn, false))
        : v.spawnDeadline;
      const restoredEnemies = structuredClone(v.enemies);
      const restoredTimers = restoredEnemies.map((e) => {
        const timer = legacy
          ? {
              clock: 0,
              deadline: armDeadline(0, legacyDurationTicks(e.attack, false)),
            }
          : v.attackTimers.find((t) => t.id === e.id)!;
        e.attack = remainingTicks(timer.clock, timer.deadline) / 60;
        return { id: e.id, clock: timer.clock, deadline: timer.deadline };
      });
      rewards.restore(v.rewards);
      health = new DamageOwner(v.health);
      arrows.restore(v.arrows);
      enemies = restoredEnemies;
      spawnDeadline = restoredSpawnDeadline;
      attackTimers.clear();
      for (const timer of restoredTimers)
        attackTimers.set(timer.id, {
          clock: timer.clock,
          deadline: timer.deadline,
        });
      ({
        wave,
        budget,
        phase,
        waveTime,
        serial,
        score,
        kills,
        upgrades,
        choice,
        selected,
        threat,
        mastery,
        outcome,
        message,
      } = v);
      intermissionDeadline = v.intermissionDeadline;
      bank = v.bank;
      rng.restore(v.rng);
      pendingEvent = v.pendingEvent;
      charge = v.charge;
      charging = v.charging;
      angle = v.angle;
      tick = v.tick;
      eventSequence = v.eventSequence;
      droppedEvents = v.droppedEvents;
      events = structuredClone(v.events);
      event = v.event;
    },
  };
  return owner;
}

/** Bounded Taylor evaluation for the supported aim [-1.25,.18] and decay [0,.05/6]. */
function sine(x: number): number {
  let term = x,
    result = x;
  for (let n = 1; n < 10; n++) {
    term *= (-x * x) / (2 * n * (2 * n + 1));
    result += term;
  }
  return result;
}
function cosine(x: number): number {
  let term = 1,
    result = 1;
  for (let n = 1; n < 10; n++) {
    term *= (-x * x) / ((2 * n - 1) * (2 * n));
    result += term;
  }
  return result;
}
function decay(x: number): number {
  let term = 1,
    result = 1;
  for (let n = 1; n < 10; n++) {
    term *= -x / n;
    result += term;
  }
  return result;
}

/** Preserve the production 60 Hz subtraction boundary, including floating rounding.
 * Conversion runs once per intermission, never per host frame. The compatibility
 * duration is capped to one hour; new consumers should use secondsToTicks directly. */
function intermissionTicks(seconds: number): number {
  return legacyDurationTicks(seconds);
}
/** Match repeated 1/60 subtraction once at arming/legacy restore, including
 * floating residuals. Nonpositive pending legacy work is ready at the next check. */
function legacyDurationTicks(seconds: number, minimumOne = true): number {
  if (!Number.isFinite(seconds) || seconds > 3600)
    throw Error("Defense duration exceeds supported finite one-hour range");
  if (seconds <= 0) return minimumOne ? 1 : 0;
  let ticks = secondsToTicks(seconds, 60),
    remainder = seconds;
  for (let i = 0; i < ticks; i++) remainder -= 1 / 60;
  if (remainder > 0) ticks++;
  return Math.max(1, ticks);
}
function validateDefenseCheckpoint(
  v: DefenseCheckpoint,
  rules: DefenseDefinitions,
  legacy: boolean,
): void {
  const fail = () => {
    throw Error("Invalid defense checkpoint; restart required");
  };
  finiteCheckpoint(v);
  for (const key of [
    "tick",
    "eventSequence",
    "droppedEvents",
    "wave",
    "budget",
    "serial",
    "score",
    "kills",
    "upgrades",
    "selected",
  ] as const)
    validateTick(v[key]);
  validateTick(v.intermissionDeadline);
  if (v.timer !== remainingTicks(v.tick, v.intermissionDeadline) / 60) fail();
  if (!legacy) {
    validateTick(v.spawnDeadline);
    if (v.spawnDeadline - v.tick > 216001) fail();
    if (
      v.spawn !== remainingTicks(v.tick, v.spawnDeadline) / 60 ||
      !Array.isArray(v.attackTimers) ||
      !Array.isArray(v.enemies) ||
      v.attackTimers.length !== v.enemies.length
    )
      fail();
    const timerIds = new Set<string>();
    for (const timer of v.attackTimers) {
      if (!timer || typeof timer !== "object" || Array.isArray(timer)) fail();
      validateTick(timer.clock);
      validateTick(timer.deadline);
      if (timer.clock > v.tick || timer.deadline - timer.clock > 216001) fail();
      const enemy = v.enemies.find((e) => e.id === timer.id);
      if (
        !enemy ||
        timerIds.has(timer.id) ||
        enemy.attack !== remainingTicks(timer.clock, timer.deadline) / 60
      )
        fail();
      timerIds.add(timer.id);
    }
  }
  if (
    !(
      v.bank >= 0 && v.bank < (v.outcome === "playing" ? 1 / 60 : 0.05 + 1 / 60)
    ) ||
    v.wave > rules.budgets.length ||
    v.selected >= rules.buildings.length ||
    v.upgrades > rules.maxUpgrades ||
    !["prepare", "defense", "ended"].includes(v.phase) ||
    !["playing", "won", "lost"].includes(v.outcome) ||
    typeof v.message !== "string" ||
    typeof v.choice !== "boolean" ||
    typeof v.charging !== "boolean" ||
    v.charge < 0 ||
    v.charge > 1 ||
    !Array.isArray(v.enemies) ||
    v.enemies.length > rules.activeCap ||
    !Array.isArray(v.events) ||
    v.events.length > 512 ||
    v.droppedEvents > v.eventSequence ||
    !Array.isArray(v.health) ||
    v.health.length !== rules.buildings.length
  )
    fail();
  for (const k of [
    "charge",
    "angle",
    "spawn",
    "waveTime",
    "threat",
    "mastery",
  ] as const)
    if (typeof v[k] !== "number") fail();
  if (
    v.waveTime < 0 ||
    v.threat < 0 ||
    v.threat > 1 ||
    v.mastery < 0 ||
    v.mastery > 1 ||
    v.angle < -1.25 ||
    v.angle > 0.18 ||
    (v.phase === "ended") !== (v.outcome !== "playing")
  )
    fail();
  v.health.forEach((b, i) => {
    if (
      b.id !== rules.buildings[i]!.id ||
      b.maxHp !== rules.buildings[i]!.maxHp
    )
      fail();
  });
  const ids = new Set<string>();
  for (const e of v.enemies) {
    if (
      typeof e.id !== "string" ||
      ids.has(e.id) ||
      !Number.isSafeInteger(e.kind) ||
      !rules.enemyKinds[e.kind] ||
      !Number.isSafeInteger(e.lane) ||
      e.lane < 0 ||
      e.lane >= rules.lanes.length ||
      !["x", "y", "hp", "attack"].every(
        (k) => typeof e[k as keyof DefenseEnemy] === "number",
      )
    )
      fail();
    if (e.hp <= 0 || e.hp > rules.enemyKinds[e.kind]!.hp) fail();
    ids.add(e.id);
  }
  const allocated = new Set<string>();
  for (const item of [...v.enemies, ...v.arrows]) {
    if (
      typeof item.id !== "string" ||
      !/^(enemy|arrow)-(0|[1-9][0-9]*)$/.test(item.id)
    )
      fail();
    const suffix = Number(item.id.slice(item.id.indexOf("-") + 1));
    validateTick(suffix);
    if (suffix >= v.serial || allocated.has(item.id)) fail();
    allocated.add(item.id);
  }
  let previous = 0;
  for (const e of v.events) {
    validateTick(e.sequence);
    validateTick(e.tick);
    if (
      e.sequence <= previous ||
      e.sequence > v.eventSequence ||
      e.tick > v.tick ||
      e.sourceId !== "defense" ||
      !["hit", "damage", "delivery", "win", "lose"].includes(e.kind)
    )
      fail();
    previous = e.sequence;
  }
  if (
    v.event !== undefined &&
    !["hit", "damage", "delivery", "win", "lose"].includes(v.event)
  )
    fail();
  if (
    v.pendingEvent !== undefined &&
    !["hit", "damage", "delivery", "win", "lose"].includes(v.pendingEvent)
  )
    fail();
}
/** Reject cycles, exotic values and nonfinite numeric checkpoint data before commit. */
function finiteCheckpoint(value: unknown, seen = new Set<object>()): void {
  if (typeof value === "number" && !Number.isFinite(value))
    throw Error("Nonfinite checkpoint");
  if (
    value === null ||
    value === undefined ||
    ["string", "boolean", "number"].includes(typeof value)
  )
    return;
  if (typeof value !== "object" || seen.has(value))
    throw Error("Invalid checkpoint data");
  seen.add(value);
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw Error("Invalid checkpoint object");
  for (const child of Object.values(value)) finiteCheckpoint(child, seen);
  seen.delete(value);
}
