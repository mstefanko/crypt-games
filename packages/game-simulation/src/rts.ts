import {
  createBehaviorActor,
  stepBehavior,
  BEHAVIOR_DESCRIPTORS,
  type BehaviorActor,
} from "./behavior";
import { canonicalNavigationData as canonical } from "./navigation-data";
import {
  SustainedNavigationScheduler,
  type SustainedNavigationCheckpoint,
  type SustainedNavigationState,
  type SustainedNavigationSummary,
  type SustainedNavigationOptions,
} from "./navigation-service";
import type { NavigationGrid } from "./navigation";

export const RTS_LIMITS = Object.freeze({
  units: 32,
  selected: 16,
  commandsPerTick: 8,
  queuedCommands: 8,
  navigationQuota: 128,
  aiCadence: 4,
  retryTicks: 8,
  resourceNodes: 2,
  resourcePerNode: 256,
  credits: 552,
  producers: 2,
  productionPerProducer: 2,
  productionCost: 20,
  productionTicks: 12,
});
export type RtsEconomyCommand =
  | { kind: "train"; producerId: number }
  | { kind: "cancel-production"; jobId: number };
export type RtsCommand =
  | RtsEconomyCommand
  | { kind: "gather"; unitIds: number[]; nodeId: number }
  | { kind: "pause"; paused: boolean }
  | { kind: "move"; unitIds: number[]; destination: number }
  | { kind: "stop"; unitIds: number[] }
  | { kind: "attack"; unitIds: number[]; targetId: number };
export type RtsOrder =
  | { kind: "idle" }
  | { kind: "move"; destination: number }
  | { kind: "attack"; targetId: number }
  | { kind: "gather"; nodeId: number };
export interface RtsProductionJob {
  id: number;
  producerId: number;
  remaining: number;
  status: "training" | "population" | "exit-blocked";
}
export interface RtsEconomy {
  credits: number;
  nodes: { id: number; cell: number; remaining: number }[];
  producers: { id: number; cell: number }[];
  jobs: RtsProductionJob[];
  nextJobId: number;
  harvested: number;
  spent: number;
  refunded: number;
  produced: number;
  cancelled: number;
}
function initialEconomy(): RtsEconomy {
  return {
    credits: 40,
    nodes: [28 * 64 + 22, 31 * 64 + 22].map((cell, i) => ({
      id: i + 1,
      cell,
      remaining: 256,
    })),
    producers: [27 * 64 + 22, 33 * 64 + 22].map((cell, i) => ({
      id: i + 1,
      cell,
    })),
    jobs: [],
    nextJobId: 1,
    harvested: 0,
    spent: 0,
    refunded: 0,
    produced: 0,
    cancelled: 0,
  };
}
type TacticalCommand = Exclude<
  RtsCommand,
  { kind: "pause" } | RtsEconomyCommand
>;
export interface RtsUnit {
  id: number;
  team: 0 | 1;
  cell: number;
  health: number;
  order: RtsOrder;
  requestId: number | null;
  routeCursor: number;
  blockedTicks: number;
  cooldown: number;
  behavior: BehaviorActor | null;
  targetId: number | null;
  goal: number | null;
  retryAt: number;
  moveStatus: "idle" | "moving" | "arrived" | "blocked";
}
export interface RtsState {
  tick: number;
  paused: boolean;
  units: RtsUnit[];
  pendingCommands: TacticalCommand[];
  economy: RtsEconomy;
  commandsThisTick: number;
  counters: {
    commands: number;
    moves: number;
    blocked: number;
    replans: number;
    attacks: number;
    deaths: number;
  };
}
export interface RtsObservation extends RtsState {
  grid: NavigationGrid;
  navigation: SustainedNavigationState;
}
/** Detached render/control view with no navigation frontier, distance or route arrays. */
export interface RtsPresentationObservation extends RtsState {
  grid: NavigationGrid;
  navigation: SustainedNavigationSummary;
}
export interface RtsCheckpoint {
  format: "rts-tactical-v2";
  state: RtsState;
  navigation: SustainedNavigationCheckpoint;
}
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const add = (n: number, amount = 1) =>
  Math.min(Number.MAX_SAFE_INTEGER, n + amount);
function integer(
  v: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): asserts v is number {
  if (
    typeof v !== "number" ||
    !Number.isSafeInteger(v) ||
    Object.is(v, -0) ||
    v < min ||
    v > max
  )
    throw Error("Invalid RTS integer");
}
function fields(
  v: unknown,
  keys: readonly string[],
): asserts v is Record<string, unknown> {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.getPrototypeOf(v) !== Object.prototype ||
    Reflect.ownKeys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    throw Error("Invalid RTS fields");
}
/** A fixed original skirmish: 32 mobiles, one movement class, one 64x64 map. */
export function createRtsGrid(): NavigationGrid {
  const costs = Array(4096).fill(1);
  for (let y = 0; y < 64; y++)
    if (y !== 30 && y !== 31 && y !== 32 && y !== 33) costs[y * 64 + 32] = 0;
  return { width: 64, height: 64, revision: 0, costs };
}
function initialState(): RtsState {
  return {
    tick: 0,
    paused: true,
    commandsThisTick: 0,
    pendingCommands: [],
    economy: initialEconomy(),
    units: Array.from({ length: 32 }, (_, i) => ({
      id: i + 1,
      team: i < 16 ? 0 : 1,
      cell: (28 + Math.floor((i % 16) / 4)) * 64 + (i < 16 ? 24 : 37) + (i % 4),
      health: 12,
      order: { kind: "idle" },
      requestId: null,
      routeCursor: 0,
      blockedTicks: 0,
      cooldown: 0,
      behavior:
        i < 16
          ? null
          : {
              ...createBehaviorActor(i % 2 ? "ranger" : "bruiser"),
              position: 0,
            },
      targetId: null,
      goal: null,
      retryAt: 0,
      moveStatus: "idle",
    })),
    counters: {
      commands: 0,
      moves: 0,
      blocked: 0,
      replans: 0,
      attacks: 0,
      deaths: 0,
    },
  };
}
function validateEconomy(e: RtsEconomy): void {
  fields(e, [
    "credits",
    "nodes",
    "producers",
    "jobs",
    "nextJobId",
    "harvested",
    "spent",
    "refunded",
    "produced",
    "cancelled",
  ]);
  integer(e.credits, 0, RTS_LIMITS.credits);
  integer(e.nextJobId, 1);
  integer(e.harvested, 0, 512);
  integer(e.produced, 0, 27);
  integer(e.cancelled, 0, Math.floor(Number.MAX_SAFE_INTEGER / 20));
  integer(e.spent, 0);
  integer(e.refunded, 0);
  if (
    !Array.isArray(e.nodes) ||
    e.nodes.length !== 2 ||
    !Array.isArray(e.producers) ||
    e.producers.length !== 2 ||
    !Array.isArray(e.jobs) ||
    e.jobs.length > 4
  )
    throw Error("RTS economy bounds");
  const initial = initialEconomy();
  for (let i = 0; i < 2; i++) {
    fields(e.nodes[i], ["id", "cell", "remaining"]);
    fields(e.producers[i], ["id", "cell"]);
    integer(e.nodes[i].remaining, 0, 256);
    if (
      e.nodes[i].id !== i + 1 ||
      e.nodes[i].cell !== initial.nodes[i].cell ||
      canonical(e.producers[i]) !== canonical(initial.producers[i])
    )
      throw Error("RTS economy identity");
  }
  let prior = 0;
  for (const job of e.jobs) {
    fields(job, ["id", "producerId", "remaining", "status"]);
    integer(job.id, prior + 1, e.nextJobId - 1);
    prior = job.id;
    integer(job.producerId, 1, 2);
    integer(job.remaining, 0, RTS_LIMITS.productionTicks);
    if (
      !["training", "population", "exit-blocked"].includes(job.status) ||
      job.remaining > 0 !== (job.status === "training")
    )
      throw Error("RTS production status");
    const siblings = e.jobs.filter((j) => j.producerId === job.producerId);
    if (
      siblings.length > 2 ||
      (siblings[0] !== job &&
        (job.remaining !== RTS_LIMITS.productionTicks ||
          job.status !== "training"))
    )
      throw Error("RTS production ordering");
  }
  if (
    e.harvested !== 512 - e.nodes.reduce((n, node) => n + node.remaining, 0) ||
    e.spent !==
      RTS_LIMITS.productionCost * (e.produced + e.cancelled + e.jobs.length) ||
    e.refunded !== RTS_LIMITS.productionCost * e.cancelled ||
    e.nextJobId !== e.produced + e.cancelled + e.jobs.length + 1 ||
    e.credits !== 40 + e.harvested - e.spent + e.refunded
  )
    throw Error("RTS economy conservation");
}
/** Host-owned observation hooks; callbacks must not re-enter simulation methods.
 * Hooks and the equivalent point-search strategy are excluded from authority. */
export interface RtsSimulationOptions {
  navigation?: SustainedNavigationOptions;
  onNavigationAdvance?: (event: {
    phase: "before" | "after";
    tick: number;
  }) => void;
  onNavigationRequest?: (event: {
    tick: number;
    requestId: number;
    unitId: number;
    team: 0 | 1;
    orderKind: RtsOrder["kind"];
    goal: number;
  }) => void;
}
/** Deterministic 32-slot combat/economy consumer; purchases never advance world time. */
export class RtsTacticalSimulation {
  private navigation: SustainedNavigationScheduler;
  private readonly options: RtsSimulationOptions;
  private state = initialState();
  constructor(options: RtsSimulationOptions = {}) {
    this.options = {
      ...options,
      navigation: options.navigation ? { ...options.navigation } : undefined,
    };
    this.navigation = new SustainedNavigationScheduler(
      createRtsGrid(),
      this.options.navigation,
    );
  }
  private observeNavigationAdvance(phase: "before" | "after"): void {
    if (!this.options.onNavigationAdvance) return;
    try {
      this.options.onNavigationAdvance({ phase, tick: this.state.tick });
    } catch {
      /* Diagnostics cannot fail an authoritative tick. */
    }
  }
  private distance(a: number, b: number): number {
    return (
      Math.abs((a % 64) - (b % 64)) +
      Math.abs(Math.floor(a / 64) - Math.floor(b / 64))
    );
  }
  private validateCommand(value: unknown, checkTerrain = true): RtsCommand {
    canonical(value);
    if (!value || typeof value !== "object") throw Error("Invalid RTS command");
    const c = value as RtsCommand;
    if (c.kind === "pause") {
      fields(c, ["kind", "paused"]);
      if (typeof c.paused !== "boolean") throw Error("Invalid RTS pause");
      return copy(c);
    }
    if (c.kind === "train") {
      fields(c, ["kind", "producerId"]);
      integer(c.producerId, 1, RTS_LIMITS.producers);
      return copy(c);
    }
    if (c.kind === "cancel-production") {
      fields(c, ["kind", "jobId"]);
      integer(c.jobId, 1);
      return copy(c);
    }
    if (
      c.kind !== "move" &&
      c.kind !== "stop" &&
      c.kind !== "attack" &&
      c.kind !== "gather"
    )
      throw Error("Unknown RTS command");
    fields(
      c,
      c.kind === "move"
        ? ["kind", "unitIds", "destination"]
        : c.kind === "gather"
          ? ["kind", "unitIds", "nodeId"]
          : c.kind === "attack"
            ? ["kind", "unitIds", "targetId"]
            : ["kind", "unitIds"],
    );
    if (
      !Array.isArray(c.unitIds) ||
      c.unitIds.length < 1 ||
      c.unitIds.length > 16 ||
      new Set(c.unitIds).size !== c.unitIds.length
    )
      throw Error("RTS selection bound");
    for (const id of c.unitIds) {
      integer(id, 1, 16);
      if (!this.state.units[id - 1].health)
        throw Error("RTS selected unit dead");
    }
    if (c.kind === "gather") {
      integer(c.nodeId, 1, RTS_LIMITS.resourceNodes);
      if (c.unitIds.some((id, i) => i > 0 && id <= c.unitIds[i - 1]))
        throw Error("RTS gather selection must be sorted");
    }
    if (c.kind === "move") {
      integer(c.destination, 0, 4095);
      if (checkTerrain && !this.navigation.isPassable(c.destination))
        throw Error("RTS blocked destination");
    }
    if (c.kind === "attack") {
      integer(c.targetId, 17, 32);
      if (!this.state.units[c.targetId - 1].health)
        throw Error("RTS target dead");
    }
    return { ...copy(c), unitIds: [...c.unitIds].sort((a, b) => a - b) };
  }
  private clearRoute(u: RtsUnit): void {
    if (u.requestId !== null) {
      const status = this.navigation.status(u.requestId);
      if (status === "queued" || status === "searching")
        this.navigation.cancel(u.requestId);
      this.navigation.release(u.requestId);
    }
    u.requestId = null;
    u.routeCursor = 0;
    u.blockedTicks = 0;
  }
  private apply(c: TacticalCommand): void {
    for (const id of c.unitIds) {
      const u = this.state.units[id - 1];
      // An earlier queued command can lose its target to combat only after resuming.
      if (!u.health) continue;
      this.clearRoute(u);
      u.goal = null;
      u.retryAt = this.state.tick;
      u.moveStatus = c.kind === "move" ? "moving" : "idle";
      u.order =
        c.kind === "stop"
          ? { kind: "idle" }
          : c.kind === "move"
            ? { kind: "move", destination: c.destination }
            : c.kind === "gather"
              ? { kind: "gather", nodeId: c.nodeId }
              : { kind: "attack", targetId: c.targetId };
    }
  }
  /** Apply a command without materializing a full debug observation. */
  applyCommand(value: RtsCommand): void {
    const c = this.validateCommand(value);
    if (
      c.kind !== "pause" &&
      !this.state.paused &&
      this.state.commandsThisTick >= 8
    )
      throw Error("RTS command rate cap");
    if (
      c.kind !== "pause" &&
      c.kind !== "train" &&
      c.kind !== "cancel-production" &&
      this.state.paused &&
      this.state.pendingCommands.length >= 8
    )
      throw Error("RTS paused queue cap");
    if (c.kind === "train") {
      const e = this.state.economy;
      if (
        e.jobs.filter((j) => j.producerId === c.producerId).length >=
        RTS_LIMITS.productionPerProducer
      )
        throw Error("RTS production queue cap");
      if (e.credits < RTS_LIMITS.productionCost)
        throw Error("RTS insufficient credits");
      if (
        e.nextJobId === Number.MAX_SAFE_INTEGER ||
        e.spent > Number.MAX_SAFE_INTEGER - RTS_LIMITS.productionCost
      )
        throw Error("RTS production identity cap");
      e.credits -= RTS_LIMITS.productionCost;
      e.spent += RTS_LIMITS.productionCost;
      e.jobs.push({
        id: e.nextJobId++,
        producerId: c.producerId,
        remaining: RTS_LIMITS.productionTicks,
        status: "training",
      });
    } else if (c.kind === "cancel-production") {
      const e = this.state.economy;
      const index = e.jobs.findIndex((j) => j.id === c.jobId);
      if (index < 0) throw Error("RTS unknown production job");
      if (e.refunded > Number.MAX_SAFE_INTEGER - RTS_LIMITS.productionCost)
        throw Error("RTS refund counter cap");
      e.jobs.splice(index, 1);
      e.credits += RTS_LIMITS.productionCost;
      e.refunded += RTS_LIMITS.productionCost;
      e.cancelled++;
    } else if (c.kind === "pause") {
      if (!c.paused && this.state.paused) {
        for (const queued of this.state.pendingCommands) this.apply(queued);
        this.state.pendingCommands = [];
      }
      this.state.paused = c.paused;
    } else if (this.state.paused) this.state.pendingCommands.push(c);
    else this.apply(c);
    if (c.kind !== "pause" && !this.state.paused) this.state.commandsThisTick++;
    this.state.counters.commands = add(this.state.counters.commands);
  }
  /** Compatibility API: apply a command and return the full detached observation. */
  command(value: RtsCommand): RtsObservation {
    this.applyCommand(value);
    return this.observe();
  }
  /** Author-controlled revisioned obstacle edits; occupied cells may not be blocked. */
  setTerrain(value: NavigationGrid): RtsObservation {
    canonical(value);
    // Navigation validates the complete envelope before mutation; occupancy check precedes it.
    if (
      !Array.isArray(value.costs) ||
      this.state.units.some((u) => u.health && !value.costs[u.cell])
    )
      throw Error("RTS terrain blocks live unit");
    this.navigation.setTerrain(value);
    for (const u of this.state.units) {
      this.clearRoute(u);
      u.retryAt = this.state.tick;
    }
    return this.observe();
  }
  private hurt(target: RtsUnit, damage: number): void {
    if (!target.health) return;
    target.health = Math.max(0, target.health - damage);
    this.state.counters.attacks = add(this.state.counters.attacks);
    if (!target.health) {
      this.clearRoute(target);
      target.order = { kind: "idle" };
      target.goal = null;
      target.targetId = null;
      target.moveStatus = "idle";
      this.state.counters.deaths = add(this.state.counters.deaths);
    }
  }
  private setGoal(u: RtsUnit, goal: number | null): void {
    if (u.goal !== goal) {
      // Finish an in-flight route toward the sampled target. Chasing a moving
      // target must neither cancel every frontier nor bypass collision backoff.
      if (goal !== null && u.requestId !== null) return;
      this.clearRoute(u);
      u.goal = goal;
    }
  }
  private decide(u: RtsUnit): void {
    if (u.team === 0) {
      if (u.cooldown) u.cooldown--;
      if (u.order.kind === "gather") {
        const e = this.state.economy,
          node = e.nodes[u.order.nodeId - 1];
        if (!node.remaining) {
          u.order = { kind: "idle" };
          this.setGoal(u, null);
        } else if (this.distance(u.cell, node.cell) <= 1) {
          this.setGoal(u, null);
          node.remaining--;
          e.credits++;
          e.harvested++;
        } else this.setGoal(u, node.cell);
        return;
      }
      if (u.order.kind === "move") {
        if (u.cell === u.order.destination) {
          this.clearRoute(u);
          u.order = { kind: "idle" };
          u.moveStatus = "arrived";
          u.goal = null;
        } else this.setGoal(u, u.order.destination);
        return;
      }
      if (u.order.kind === "attack") {
        const t = this.state.units[u.order.targetId - 1];
        if (!t.health) {
          u.order = { kind: "idle" };
          this.setGoal(u, null);
          return;
        }
        if (this.distance(u.cell, t.cell) <= 1) {
          this.setGoal(u, null);
          if (!u.cooldown) {
            this.hurt(t, 2);
            u.cooldown = 4;
          }
        } else this.setGoal(u, t.cell);
      } else this.setGoal(u, null);
      return;
    }
    let target =
      u.targetId === null ? undefined : this.state.units[u.targetId - 1];
    if (
      (!target?.health && u.behavior!.state !== "windup") ||
      (this.state.tick % 4 === 0 && u.behavior!.state === "approach")
    ) {
      target = this.state.units
        .filter((t) => t.team === 0 && t.health)
        .sort(
          (a, b) =>
            this.distance(u.cell, a.cell) - this.distance(u.cell, b.cell) ||
            a.id - b.id,
        )[0];
      u.targetId = target?.id ?? null;
    }
    if (!target) {
      u.behavior = {
        ...stepBehavior(
          { ...u.behavior!, position: 0 },
          { target: 32, threatened: false },
        ).actor,
        position: 0,
      };
      this.setGoal(u, null);
      return;
    }
    // B0 owns typed windup/recovery/retreat timers; N0 owns actual 2D movement.
    const result = stepBehavior(
      { ...u.behavior!, position: 0 },
      {
        target: Math.min(32, this.distance(u.cell, target.cell)),
        threatened: u.health <= 3,
      },
    );
    u.behavior = { ...result.actor, position: 0 };
    if (result.damage) this.hurt(target, result.damage); // Committed windup intent, like B0.
    if (
      u.behavior.state === "approach" &&
      this.distance(u.cell, target.cell) >
        BEHAVIOR_DESCRIPTORS[u.behavior.role].range
    )
      this.setGoal(u, target.cell);
    else if (u.behavior.state === "retreat") {
      const x = u.cell % 64,
        y = Math.floor(u.cell / 64);
      const options = [
        y ? u.cell - 64 : -1,
        x < 63 ? u.cell + 1 : -1,
        y < 63 ? u.cell + 64 : -1,
        x ? u.cell - 1 : -1,
      ].filter((n) => n >= 0 && this.navigation.isPassable(n));
      options.sort(
        (a, b) =>
          this.distance(b, target!.cell) - this.distance(a, target!.cell) ||
          a - b,
      );
      this.setGoal(u, options[0] ?? null);
    } else this.setGoal(u, null);
  }
  private produce(): void {
    const e = this.state.economy;
    for (const producer of e.producers) {
      const job = e.jobs.find((j) => j.producerId === producer.id);
      if (!job) continue;
      if (job.remaining > 0) job.remaining--;
      if (job.remaining > 0) continue;
      const unit = this.state.units.find((u) => u.team === 0 && !u.health);
      if (!unit) {
        job.status = "population";
        continue;
      }
      const occupied = new Set(
        this.state.units.filter((u) => u.health).map((u) => u.cell),
      );
      // Fixed N/E/S/W order; no remote spawn or deletion when every exit is blocked.
      const x = producer.cell % 64,
        y = Math.floor(producer.cell / 64);
      const cell = [
        y > 0 ? producer.cell - 64 : -1,
        x < 63 ? producer.cell + 1 : -1,
        y < 63 ? producer.cell + 64 : -1,
        x > 0 ? producer.cell - 1 : -1,
      ].find(
        (c) => c >= 0 && this.navigation.isPassable(c) && !occupied.has(c),
      );
      if (cell === undefined) {
        job.status = "exit-blocked";
        continue;
      }
      Object.assign(unit, {
        cell,
        health: 12,
        order: { kind: "idle" },
        requestId: null,
        routeCursor: 0,
        blockedTicks: 0,
        cooldown: 0,
        behavior: null,
        targetId: null,
        goal: null,
        retryAt: this.state.tick,
        moveStatus: "idle",
      });
      // A replacement is a new life in a stable slot. Discard old committed
      // windups/routes so an opponent cannot hit it remotely via the dead ID.
      for (const opponent of this.state.units)
        if (opponent.team === 1 && opponent.targetId === unit.id) {
          this.clearRoute(opponent);
          opponent.goal = null;
          opponent.targetId = null;
          if (opponent.behavior!.state === "windup")
            opponent.behavior = {
              ...opponent.behavior!,
              state: "recover",
              timer: BEHAVIOR_DESCRIPTORS[opponent.behavior!.role].recovery,
              transitions: add(opponent.behavior!.transitions),
            };
        }
      e.produced++;
      e.jobs.splice(e.jobs.indexOf(job), 1);
    }
  }
  /** Advance authority without materializing a detached RTS observation. */
  advance(): void {
    if (this.state.paused) return;
    if (
      this.state.tick === Number.MAX_SAFE_INTEGER ||
      !this.navigation.canRequest(32)
    )
      throw Error("RTS tick/request identity cap");
    this.state.tick++;
    this.state.commandsThisTick = 0;
    for (const u of this.state.units) if (u.health) this.decide(u);
    for (const u of this.state.units)
      if (
        u.health &&
        u.goal !== null &&
        u.cell !== u.goal &&
        u.requestId === null &&
        this.state.tick >= u.retryAt
      ) {
        u.requestId = this.navigation.request({
          algorithm: "astar",
          start: u.cell,
          goal: u.goal,
        });
        if (this.options.onNavigationRequest) {
          try {
            this.options.onNavigationRequest({
              tick: this.state.tick,
              requestId: u.requestId,
              unitId: u.id,
              team: u.team,
              orderKind: u.order.kind,
              goal: u.goal,
            });
          } catch {
            /* Diagnostics cannot fail an authoritative request. */
          }
        }
        u.routeCursor = 0;
        this.state.counters.replans = add(this.state.counters.replans);
      }
    this.observeNavigationAdvance("before");
    this.navigation.advance(128);
    this.observeNavigationAdvance("after");
    const occupied = new Set(
      this.state.units.filter((u) => u.health).map((u) => u.cell),
    );
    for (const u of this.state.units)
      if (u.health && u.requestId !== null) {
        const status = this.navigation.status(u.requestId);
        if (status === undefined) throw Error("RTS navigation request missing");
        if (status === "found") {
          const next = this.navigation.nextRouteCell(
            u.requestId,
            u.routeCursor,
          );
          if (next === undefined) {
            this.clearRoute(u);
            if (u.order.kind === "move") {
              u.order = { kind: "idle" };
              u.moveStatus = "arrived";
            }
            u.goal = null;
          } else if (!occupied.has(next) && this.navigation.isPassable(next)) {
            occupied.delete(u.cell);
            occupied.add(next);
            u.cell = next;
            u.routeCursor++;
            u.blockedTicks = 0;
            this.state.counters.moves = add(this.state.counters.moves);
          } else {
            u.blockedTicks++;
            this.state.counters.blocked = add(this.state.counters.blocked);
            if (u.blockedTicks >= 3) {
              this.clearRoute(u);
              u.retryAt = add(this.state.tick, 8);
              if (u.order.kind === "move") {
                u.order = { kind: "idle" };
                u.goal = null;
                u.moveStatus = "blocked";
              }
            }
          }
        } else if (status !== "queued" && status !== "searching") {
          this.clearRoute(u);
          u.retryAt = add(this.state.tick, 8);
          if (u.order.kind === "move") {
            u.order = { kind: "idle" };
            u.goal = null;
            u.moveStatus = "blocked";
          }
        }
      }
    this.produce();
  }
  step(): RtsObservation {
    this.advance();
    return this.observe();
  }
  observe(): RtsObservation {
    const navigation = this.navigation.observe();
    return { ...copy(this.state), grid: copy(navigation.grid), navigation };
  }
  observePresentation(): RtsPresentationObservation {
    return {
      ...copy(this.state),
      grid: this.navigation.observeTerrain(),
      navigation: this.navigation.observeSummary(),
    };
  }
  capture(): RtsCheckpoint {
    return {
      format: "rts-tactical-v2",
      state: copy(this.state),
      navigation: this.navigation.capture(),
    };
  }
  restore(value: unknown): void {
    if (canonical(value).length > 8 * 1024 * 1024)
      throw Error("RTS checkpoint byte cap");
    fields(value, ["format", "state", "navigation"]);
    const legacy = value.format === "rts-tactical-v1";
    if (legacy) {
      // The historical codec had no economy. Migration starts a fresh untouched economy.
      fields(value.state, [
        "tick",
        "paused",
        "units",
        "pendingCommands",
        "commandsThisTick",
        "counters",
      ]);
      value = {
        ...value,
        format: "rts-tactical-v2",
        state: { ...value.state, economy: initialEconomy() },
      };
    }
    fields(value, ["format", "state", "navigation"]);
    if (value.format !== "rts-tactical-v2")
      throw Error("Incompatible RTS checkpoint");
    const nav = new SustainedNavigationScheduler(
      createRtsGrid(),
      this.options.navigation,
    );
    nav.restore(value.navigation);
    fields(value.state, [
      "tick",
      "paused",
      "units",
      "pendingCommands",
      "commandsThisTick",
      "counters",
      "economy",
    ]);
    const s = value.state as unknown as RtsState;
    integer(s.tick, 0);
    integer(s.commandsThisTick, 0, 8);
    if (
      typeof s.paused !== "boolean" ||
      !Array.isArray(s.units) ||
      s.units.length !== 32 ||
      !Array.isArray(s.pendingCommands) ||
      s.pendingCommands.length > 8 ||
      (!s.paused && s.pendingCommands.length)
    )
      throw Error("RTS state bounds");
    if (
      legacy &&
      (s.units.some((u) => u.order?.kind === "gather") ||
        s.pendingCommands.some((c) => c.kind === "gather"))
    )
      throw Error("Legacy RTS checkpoint cannot contain gather orders");
    const n = nav.observe();
    if (n.tick !== s.tick) throw Error("RTS/navigation tick mismatch");
    fields(s.counters, [
      "commands",
      "moves",
      "blocked",
      "replans",
      "attacks",
      "deaths",
    ]);
    for (const v of Object.values(s.counters)) integer(v, 0);
    validateEconomy(s.economy);
    const occupied = new Set<number>(),
      requests = new Set<number>();
    for (let i = 0; i < s.units.length; i++) {
      const u = s.units[i];
      fields(u, [
        "id",
        "team",
        "cell",
        "health",
        "order",
        "requestId",
        "routeCursor",
        "blockedTicks",
        "cooldown",
        "behavior",
        "targetId",
        "goal",
        "retryAt",
        "moveStatus",
      ]);
      if (u.id !== i + 1 || u.team !== (i < 16 ? 0 : 1))
        throw Error("RTS stable unit identity");
      integer(u.cell, 0, 4095);
      integer(u.health, 0, 12);
      integer(u.routeCursor, 0, 4095);
      integer(u.blockedTicks, 0, 2);
      integer(u.cooldown, 0, 4);
      integer(u.retryAt, 0, add(s.tick, RTS_LIMITS.retryTicks));
      if (u.requestId !== null && u.retryAt > s.tick)
        throw Error("RTS route during backoff");
      if (
        !["idle", "moving", "arrived", "blocked"].includes(u.moveStatus) ||
        (u.moveStatus === "moving") !== (u.order.kind === "move") ||
        (u.team === 1 && u.moveStatus !== "idle")
      )
        throw Error("RTS move status");
      if (u.goal !== null) {
        integer(u.goal, 0, 4095);
      }
      if (u.targetId !== null) {
        integer(u.targetId, 1, 16);
        if (u.team !== 1) throw Error("RTS opponent target");
      }
      if (u.health && (!n.grid.costs[u.cell] || occupied.has(u.cell)))
        throw Error("RTS occupied cells");
      if (u.health) occupied.add(u.cell);
      if (
        !u.health &&
        (u.requestId !== null ||
          u.order.kind !== "idle" ||
          u.goal !== null ||
          u.targetId !== null)
      )
        throw Error("RTS dead unit orders");
      if (u.team === 0) {
        if (u.behavior !== null) throw Error("RTS player behavior");
      } else {
        if (
          !u.behavior ||
          u.behavior.role !== (i % 2 ? "ranger" : "bruiser") ||
          u.behavior.position !== 0
        )
          throw Error("RTS behavior identity");
        if (u.health && u.behavior.state === "windup" && u.targetId === null)
          throw Error("RTS missing windup target");
        stepBehavior(u.behavior, { target: 0, threatened: false }); // Shared typed state/timer validation, no mutation.
      }
      if (u.order.kind === "idle") fields(u.order, ["kind"]);
      else if (u.order.kind === "move") {
        fields(u.order, ["kind", "destination"]);
        integer(u.order.destination, 0, 4095);
      } else if (u.order.kind === "attack") {
        fields(u.order, ["kind", "targetId"]);
        integer(u.order.targetId, 17, 32);
      } else if (u.order.kind === "gather") {
        fields(u.order, ["kind", "nodeId"]);
        integer(u.order.nodeId, 1, RTS_LIMITS.resourceNodes);
      } else throw Error("RTS order");
      if (
        u.team === 0 &&
        u.goal !== null &&
        (u.order.kind === "idle" ||
          (u.order.kind === "move" && u.goal !== u.order.destination) ||
          (u.order.kind === "gather" &&
            u.goal !== s.economy.nodes[u.order.nodeId - 1].cell))
      )
        throw Error("RTS goal/order mismatch");
      if (u.team === 1 && u.order.kind !== "idle")
        throw Error("RTS opponent orders");
      if (u.requestId !== null) {
        integer(u.requestId, 1);
        const search = n.searches.find((r) => r.id === u.requestId);
        if (
          !u.health ||
          requests.has(u.requestId) ||
          !search ||
          search.goal !== u.goal ||
          search.terrainRevision !== n.grid.revision ||
          !["queued", "searching", "found"].includes(search.status)
        )
          throw Error("RTS route ownership");
        requests.add(u.requestId);
        if (search.status === "found") {
          if (search.path[u.routeCursor] !== u.cell)
            throw Error("RTS route cursor");
        } else if (u.routeCursor !== 0 || search.start !== u.cell)
          throw Error("RTS pending position");
      } else if (u.routeCursor !== 0) throw Error("RTS unused route cursor");
    }
    if (
      requests.size !== n.searches.length ||
      s.counters.deaths !==
        s.units.filter((u) => !u.health).length + s.economy.produced
    )
      throw Error("RTS ownership/death counters");
    const staged = new RtsTacticalSimulation();
    staged.state = copy(s);
    staged.navigation = nav;
    for (const c of s.pendingCommands) {
      if (!["move", "stop", "attack", "gather"].includes(c.kind))
        throw Error("RTS queued command kind");
      if (canonical(staged.validateCommand(c, false)) !== canonical(c))
        throw Error("RTS noncanonical pending command");
    }
    this.state = staged.state;
    this.navigation = staged.navigation;
  }
}
