/** P2 whole-object durability. Gameplay owns hit admission; P0/P1 own queries. */
import { geometrySegment, queryGeometry } from "./geometry";
import type { GeometryRect, GeometryShape, GeometryVector } from "./geometry";
import { queryCircleGeometry, validateGeometryCircle } from "./circle-geometry";

export const DESTRUCTION_LIMITS = Object.freeze({
  objects: 64, explosives: 8, hitsPerTick: 32, ticks: 64, drainTicks: 8, lifetimeTicks: 72,
  blastRadius: 4096, damage: 1024, hp: 4096, bands: 3,
  candidatesPerTick: 512, coverRaysPerTick: 512, coverTestsPerTick: 32768,
  pending: 8, receiptsPerTick: 544, checkpointCharacters: 1048576,
});
export interface DestructionBlast {
  /** Ascending radii; damage must not increase with distance. Center-distance bands. */
  readonly bands: readonly { readonly radius: number; readonly damage: number }[];
  readonly friendlyFire: boolean;
}
export interface DamageableDefinition {
  readonly id: string;
  readonly kind: "wall" | "prop" | "car";
  readonly rect: GeometryRect;
  readonly hp: number;
  readonly team: number;
  /** A destroyed car can remain a blocking, shielding wreck. */
  readonly brokenBlocking: boolean;
  readonly reward: number;
  readonly blast: DestructionBlast | null;
}
export interface DestructionConfiguration { readonly objects: readonly DamageableDefinition[] }
export interface DestructionHit {
  readonly eventId: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly damage: number;
}
export interface DestructionInput {
  readonly hits: readonly DestructionHit[];
  /** Explicit ignition; already detonated sources are harmless no-ops. */
  readonly ignite: readonly string[];
}
export interface DamageableState { id: string; hp: number; detonated: boolean }
export interface DestructionReceipt {
  readonly eventId: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly kind: "hit" | "blast";
  readonly outcome: "damage" | "covered" | "team" | "inactive";
  /** Gathered damage, including overkill. All eligible effects trade this tick. */
  readonly damage: number;
}
export interface DestructionState {
  tick: number;
  terrainRevision: number;
  objects: DamageableState[];
  pending: { sourceId: string; readyTick: number }[];
  rewarded: string[];
  rewardTotal: number;
  destroyed: string[];
  receipts: DestructionReceipt[];
  counters: { candidates: number; coverRays: number; coverTests: number };
}
export interface DestructionCheckpoint {
  readonly format: "p2-destruction-v1";
  readonly configuration: DestructionConfiguration;
  readonly history: readonly DestructionInput[];
  readonly state: DestructionState;
}
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function order(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) throw Error("Invalid destruction fields");
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) throw Error("Destruction integer outside bounds");
  return value;
}
function identity(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9:_.\/-]*$/.test(value)) throw Error("Invalid destruction identity");
  return value;
}
/** Strict bounded plain-data codec. Inspect descriptors before reading values. */
export function canonicalDestructionData(value: unknown): string {
  let nodes = 0;
  function plain(v: unknown, depth: number): unknown {
    if (++nodes > 65536 || depth > 12) throw Error("Destruction data cap");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") { integer(v, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER); return v; }
    if (typeof v === "string") { if (v.length > 128) throw Error("Destruction string cap"); return v; }
    if (!v || typeof v !== "object") throw Error("Destruction plain data required");
    const keys = Reflect.ownKeys(v);
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype || v.length > 1024 || keys.length !== v.length + 1) throw Error("Destruction array cap/prototype");
      const result: unknown[] = [];
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d || !Object.hasOwn(d, "value") || !d.enumerable) throw Error("Destruction array property");
        result.push(plain(d.value, depth + 1));
      }
      return result;
    }
    if (Object.getPrototypeOf(v) !== Object.prototype || keys.length > 24 || keys.some(k => typeof k !== "string")) throw Error("Destruction object required");
    const result: Record<string, unknown> = {};
    for (const key of (keys as string[]).sort()) {
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (key.length > 64 || key === "__proto__" || !Object.hasOwn(d, "value") || !d.enumerable) throw Error("Destruction data property");
      result[key] = plain(d.value, depth + 1);
    }
    return result;
  }
  const bytes = JSON.stringify(plain(value, 0));
  if (bytes.length > DESTRUCTION_LIMITS.checkpointCharacters) throw Error("Destruction checkpoint cap");
  return bytes;
}
function anchor(rect: GeometryRect): GeometryVector {
  return { x: rect.x + Math.floor(rect.width / 2), y: rect.y + Math.floor(rect.height / 2) };
}
function shape(object: DamageableDefinition): GeometryShape {
  return { bodyId: object.id, shapeId: "body", owner: "p2-world", category: "world", region: "body", sensor: false, priority: 0, rect: copy(object.rect) };
}
function configuration(value: unknown): DestructionConfiguration {
  canonicalDestructionData(value);
  const root = fields(value, ["objects"]);
  if (!Array.isArray(root.objects) || root.objects.length > DESTRUCTION_LIMITS.objects) throw Error("Destruction object cap");
  const objects = root.objects.map(value => {
    const o = fields(value, ["id", "kind", "rect", "hp", "team", "brokenBlocking", "reward", "blast"]);
    const r = fields(o.rect, ["x", "y", "width", "height"]);
    const rect = { x: integer(r.x, -262144, 262144), y: integer(r.y, -262144, 262144), width: integer(r.width, 1, 262144), height: integer(r.height, 1, 262144) };
    if (!["wall", "prop", "car"].includes(o.kind as string) || typeof o.brokenBlocking !== "boolean") throw Error("Unsupported destruction object policy");
    let blast: DestructionBlast | null = null;
    if (o.blast !== null) {
      const b = fields(o.blast, ["bands", "friendlyFire"]);
      if (!Array.isArray(b.bands) || b.bands.length < 1 || b.bands.length > DESTRUCTION_LIMITS.bands || typeof b.friendlyFire !== "boolean") throw Error("Invalid destruction blast");
      const bands = b.bands.map(value => {
        const band = fields(value, ["radius", "damage"]);
        return { radius: integer(band.radius, 1, DESTRUCTION_LIMITS.blastRadius), damage: integer(band.damage, 1, DESTRUCTION_LIMITS.damage) };
      });
      if (bands.some((b, i) => i > 0 && (b.radius <= bands[i - 1].radius || b.damage > bands[i - 1].damage))) throw Error("Invalid destruction damage bands");
      validateGeometryCircle({ ...anchor(rect), radius: bands[bands.length - 1].radius });
      blast = { bands, friendlyFire: b.friendlyFire };
    }
    return { id: identity(o.id), kind: o.kind as DamageableDefinition["kind"], rect, hp: integer(o.hp, 1, DESTRUCTION_LIMITS.hp), team: integer(o.team, 0, 3), brokenBlocking: o.brokenBlocking, reward: integer(o.reward, 0, 64), blast };
  }).sort((a, b) => order(a.id, b.id));
  if (objects.some((o, i) => i > 0 && objects[i - 1].id === o.id)) throw Error("Duplicate destruction object");
  if (objects.filter(o => o.blast).length > DESTRUCTION_LIMITS.explosives) throw Error("Destruction explosive cap");
  queryGeometry(objects.map(shape), { kind: "overlap", rect: { x: 0, y: 0, width: 1, height: 1 } });
  return { objects };
}
function input(value: unknown, config: DestructionConfiguration): DestructionInput {
  canonicalDestructionData(value);
  const root = fields(value, ["hits", "ignite"]);
  if (!Array.isArray(root.hits) || root.hits.length > DESTRUCTION_LIMITS.hitsPerTick || !Array.isArray(root.ignite) || root.ignite.length > DESTRUCTION_LIMITS.explosives) throw Error("Destruction input cap");
  const hits = root.hits.map(value => {
    const hit = fields(value, ["eventId", "sourceId", "targetId", "damage"]);
    const targetId = identity(hit.targetId);
    if (!config.objects.some(o => o.id === targetId)) throw Error("Unknown damageable target");
    return { eventId: identity(hit.eventId), sourceId: identity(hit.sourceId), targetId, damage: integer(hit.damage, 1, DESTRUCTION_LIMITS.damage) };
  }).sort((a, b) => order(a.eventId, b.eventId));
  if (hits.some((hit, i) => i > 0 && hit.eventId === hits[i - 1].eventId)) throw Error("Duplicate destruction hit event");
  const ignite = root.ignite.map(value => {
    const id = identity(value);
    if (!config.objects.some(o => o.id === id && o.blast)) throw Error("Unknown explosive source");
    return id;
  }).sort(order);
  if (ignite.some((id, i) => i > 0 && id === ignite[i - 1])) throw Error("Duplicate destruction ignition");
  return { hits, ignite };
}
/** Shared P2 transition: no journal and no lifetime policy. Callers validate their
 * state and command horizon; the historical finite proof keeps its own caps. */
export function advanceDestructionState(config: DestructionConfiguration, before: DestructionState, value: DestructionInput): DestructionState {
  if (before.tick >= Number.MAX_SAFE_INTEGER - 1) throw Error("Destruction clock exhausted");
  const admitted = input(value, config);
  const staged = copy(before), terrain = destructionCollisionShapes(config, before);
  staged.tick++; staged.destroyed = []; staged.receipts = []; staged.pending = [];
  staged.counters = { candidates: 0, coverRays: 0, coverTests: 0 };
  const damage = config.objects.map(() => 0);
  for (const hit of admitted.hits) {
    const index = before.objects.findIndex(o => o.id === hit.targetId), alive = before.objects[index].hp > 0;
    staged.receipts.push({ ...hit, eventId: `hit:${staged.tick}:${hit.eventId}`, kind: "hit", outcome: alive ? "damage" : "inactive", damage: alive ? hit.damage : 0 });
    if (alive) damage[index] += hit.damage;
  }
  const active = [...new Set([...before.pending.map(p => p.sourceId), ...admitted.ignite])].sort(order).filter(id => !before.objects.find(o => o.id === id)!.detonated);
  for (const sourceId of active) {
    const sourceIndex = config.objects.findIndex(o => o.id === sourceId), source = config.objects[sourceIndex], blast = source.blast!;
    staged.objects[sourceIndex].detonated = true;
    damage[sourceIndex] += source.hp; // ignition destroys the source exactly once
    const origin = anchor(source.rect), radius = blast.bands[blast.bands.length - 1].radius;
    const candidates = queryCircleGeometry(config.objects.map(o => ({ ...shape(o), kind: "rect" as const })), { kind: "overlap", circle: { ...origin, radius } }).contacts;
    staged.counters.candidates += candidates.length;
    for (const candidate of candidates) {
      if (candidate.bodyId === sourceId) continue;
      const index = config.objects.findIndex(o => o.id === candidate.bodyId), target = config.objects[index], point = anchor(target.rect);
      const delta = { x: point.x - origin.x, y: point.y - origin.y }, distance2 = delta.x * delta.x + delta.y * delta.y;
      const band = blast.bands.find(b => distance2 <= b.radius * b.radius);
      if (!band) continue; // P1 shape candidates, then declared center-distance metric
      let outcome: DestructionReceipt["outcome"] = "damage";
      if (before.objects[index].hp === 0) outcome = "inactive";
      else if (!blast.friendlyFire && source.team === target.team) outcome = "team";
      else {
        staged.counters.coverRays++;
        // One stable anchor sample. P0 parallel/corner grazing follows its open-interior policy.
        const blockers = terrain.filter(s => s.bodyId !== sourceId && s.bodyId !== target.id);
        // Test all blockers, rather than exiting early, to keep work counts stable.
        const covered = blockers.map(s => geometrySegment(origin, delta, s.rect)).some(Boolean);
        staged.counters.coverTests += blockers.length;
        if (covered) outcome = "covered";
      }
      const amount = outcome === "damage" ? band.damage : 0;
      staged.receipts.push({ eventId: `blast:${staged.tick}:${sourceId}`, sourceId, targetId: target.id, kind: "blast", outcome, damage: amount });
      damage[index] += amount;
    }
  }
  let terrainChanged = false;
  config.objects.forEach((definition, index) => {
    const object = staged.objects[index];
    object.hp = Math.max(0, before.objects[index].hp - damage[index]);
    if (before.objects[index].hp > 0 && object.hp === 0) {
      staged.destroyed.push(object.id);
      if (!definition.brokenBlocking) terrainChanged = true;
      if (!staged.rewarded.includes(object.id)) {
        staged.rewarded.push(object.id); staged.rewardTotal += definition.reward;
      }
      if (definition.blast && !object.detonated) staged.pending.push({ sourceId: object.id, readyTick: staged.tick + 1 });
    }
  });
  if (terrainChanged) staged.terrainRevision++;
  staged.rewarded.sort(order);
  // Capacities follow from validated source/target counts; never silently drop effects.
  if (staged.pending.length > DESTRUCTION_LIMITS.pending || staged.receipts.length > DESTRUCTION_LIMITS.receiptsPerTick) throw Error("Destruction capacity invariant");
  return staged;
}
export function admitDestructionConfiguration(value: unknown): DestructionConfiguration { return configuration(value); }
export function destructionCollisionShapes(config: DestructionConfiguration, state: DestructionState): GeometryShape[] {
  return config.objects.filter((o, i) => state.objects[i].hp > 0 || o.brokenBlocking).map(shape);
}
/** Maximum 64 whole objects and 8 once-only explosive sources; no callbacks,
 * fracture, repair or physical fragments. Room/run resets create a new world.
 * Every effect uses pre-commit terrain. New collision is visible after step. */
export class DamageableWorld {
  private readonly configuration: DestructionConfiguration;
  private history: DestructionInput[] = [];
  private state: DestructionState;
  constructor(value: DestructionConfiguration) {
    this.configuration = configuration(value);
    this.state = { tick: 0, terrainRevision: 0, objects: this.configuration.objects.map(o => ({ id: o.id, hp: o.hp, detonated: false })), pending: [], rewarded: [], rewardTotal: 0, destroyed: [], receipts: [], counters: { candidates: 0, coverRays: 0, coverTests: 0 } };
  }
  collisionShapes(): GeometryShape[] {
    return destructionCollisionShapes(this.configuration, this.state);
  }
  observe(): DestructionState { return copy(this.state); }
  step(value: DestructionInput = { hits: [], ignite: [] }): DestructionState {
    if (this.state.tick >= DESTRUCTION_LIMITS.lifetimeTicks) throw Error("Destruction tick cap");
    const admitted = input(value, this.configuration);
    // After the command horizon, finish already accepted effects only. At most
    // eight authored once-only sources can add eight queued detonation ticks.
    if (this.state.tick >= DESTRUCTION_LIMITS.ticks && (admitted.hits.length || admitted.ignite.length || this.state.pending.length === 0)) throw Error("Destruction tick cap: only pending blasts may drain with empty input");
    const staged = advanceDestructionState(this.configuration, this.state, admitted);
    if (staged.tick === DESTRUCTION_LIMITS.lifetimeTicks && staged.pending.length) throw Error("Destruction drain capacity invariant");
    this.state = staged; this.history.push(copy(admitted));
    return this.observe();
  }
  capture(): DestructionCheckpoint { return { format: "p2-destruction-v1", configuration: copy(this.configuration), history: copy(this.history), state: this.observe() }; }
  restore(value: unknown): void {
    const canonical = canonicalDestructionData(value), root = fields(value, ["format", "configuration", "history", "state"]);
    if (root.format !== "p2-destruction-v1" || canonicalDestructionData(root.configuration) !== canonicalDestructionData(this.configuration)) throw Error("Incompatible destruction checkpoint");
    if (!Array.isArray(root.history) || root.history.length > DESTRUCTION_LIMITS.lifetimeTicks) throw Error("Destruction history cap");
    const staged = new DamageableWorld(this.configuration);
    for (const command of root.history) staged.step(command);
    // Bounded replay validates complete HP, queue, once-only flags, rewards,
    // receipts, counters, revision and canonical journal ordering before publishing.
    if (canonical !== canonicalDestructionData(staged.capture())) throw Error("Inconsistent destruction checkpoint");
    this.state = staged.state; this.history = staged.history;
  }
  save(): string { return canonicalDestructionData(this.capture()); }
  load(bytes: string): void {
    if (typeof bytes !== "string" || bytes.length > DESTRUCTION_LIMITS.checkpointCharacters) throw Error("Destruction checkpoint cap");
    // JSON.parse erases negative zero only when reserialized; the codec rejects it first.
    const value: unknown = JSON.parse(bytes);
    if (canonicalDestructionData(value) !== bytes) throw Error("Noncanonical destruction checkpoint bytes");
    this.restore(value);
  }
}
