/** C1/P1 versioned velocity channel. Arena remains the only motion/contact owner. */
import { boundedJSON, canonical, integer, record } from "@onepage/game-project/runtime";
import { createArena, encodeArenaCheckpoint, observeArena, restoreArenaCheckpoint, stepArena, validateArenaDefinition, type ArenaInput } from "./m3/arena";
import { moveArenaBody } from "./m3/arena-geometry";

export const IMPULSE_LIMITS = Object.freeze({ requests: 32, component: 2048, velocityL1: 1024, drag: 64, checkpointCharacters: 262144 });
export interface ImpulseRequest { sourceId: string; targetId: string; x: number; y: number }
interface Velocity { targetId: string; x: number; y: number; remainderX: number; remainderY: number }
export interface ArenaImpulseCheckpoint {
  format: "arena-impulse-v1";
  arena: string;
  velocities: Velocity[];
  pending: ImpulseRequest[];
  configuration: ImpulseActorPolicy[];
}
/** Reject accessors, abnormal prototypes, symbols, sparse arrays and
 * non-data values before reading any request or checkpoint field. */
function data(value: unknown, depth = 0): unknown {
  if (depth > 5) throw Error("Impulse data depth");
  if (typeof value === "string" && value.length <= IMPULSE_LIMITS.checkpointCharacters) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) return value;
  if (value === null || typeof value === "boolean") return value;
  if (!value || typeof value !== "object") throw Error("Impulse plain data required");
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 32 || keys.length !== value.length + 1) throw Error("Impulse array cap");
    return Array.from({ length: value.length }, (_, i) => {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (!d || !Object.hasOwn(d, "value") || !d.enumerable) throw Error("Impulse array accessor");
      return data(d.value, depth + 1);
    });
  }
  if (Object.getPrototypeOf(value) !== Object.prototype || keys.length > 10) throw Error("Impulse object required");
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || key === "__proto__" || !Object.hasOwn(d, "value") || !d.enumerable) throw Error("Impulse accessor/key");
    out[key] = data(d.value, depth + 1);
  }
  return out;
}
const definition = validateArenaDefinition({
  id: "arena-impulse-v1", width: 24576, height: 16384,
  walls: [{ id: "backstop", x: 12800, y: 0, width: 1024, height: 16384 }],
  player: { id: "hero", x: 5120, y: 6144, width: 2560, height: 2560, hp: 100 },
  enemies: [{ id: "target", x: 7680, y: 6144, width: 2560, height: 2560, hp: 100 }],
  moveSpeed: 256, enemySpeed: 256, projectileSpeed: 2048, projectileSize: 512, projectileTicks: 90,
  projectileDamage: 2, fireCooldown: 15, dashSpeed: 1792, dashTicks: 5, dashCooldown: 75,
  shoveRange: 2560, shoveDistance: 3072, shoveDamage: 1, shoveCooldown: 45,
  enemyDamage: 1, enemyCooldown: 40, hitstopTicks: 3, maxProjectiles: 20,
});
function world() { return createArena(definition, { gameId: "arena-impulse-proof", rulesBuildId: "arena-impulse-v1", contentId: "resistance-backstop-v1" }); }
const targets = ["hero", "target"];
function compare(a: ImpulseRequest, b: ImpulseRequest) { return a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0; }
function requests(value: unknown, ids: readonly string[] = targets): ImpulseRequest[] {
  if (!Array.isArray(value) || value.length > IMPULSE_LIMITS.requests) throw Error("Impulse request cap");
  const result = value.map(value => {
    const r = record(value, ["sourceId", "targetId", "x", "y"]);
    if (typeof r.sourceId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(r.sourceId) || !ids.includes(r.targetId as string)) throw Error("Impulse identity");
    return { sourceId: r.sourceId, targetId: r.targetId as string, x: integer(r.x, -2048, 2048), y: integer(r.y, -2048, 2048) };
  }).sort(compare);
  for (let i = 1; i < result.length; i++) if (compare(result[i - 1], result[i]) === 0) throw Error("Duplicate impulse source/target in phase");
  return result;
}
function clamp(x: number, y: number) {
  const size = Math.abs(x) + Math.abs(y);
  return size <= 1024 ? { x, y } : { x: Math.trunc(x * 1024 / size) || 0, y: Math.trunc(y * 1024 / size) || 0 };
}
function drag(v: number) { return Math.sign(v) * Math.max(0, Math.abs(v) - 64) || 0; }
export interface ImpulseActorPolicy { targetId: string; resistance256: number }
export interface ImpulseChannelState { velocities: Velocity[]; pending: ImpulseRequest[]; configuration: ImpulseActorPolicy[] }
/** Reusable finite channel. Caller supplies stable actors and the sole motor.
 * Motor returns actual displacement so blocked axes lose velocity. A caller
 * requiring world atomicity stages its world before advance (as the arena does). */
export class ImpulseChannel {
  private readonly actors: ImpulseActorPolicy[];
  private state: ImpulseChannelState;
  private advancing = false;
  constructor(value: readonly ImpulseActorPolicy[]) {
    const admitted = data(value);
    if (!Array.isArray(admitted) || !admitted.length || admitted.length > 32) throw Error("Impulse actor cap");
    this.actors = admitted.map(value => {
      const a = record(value, ["targetId", "resistance256"]);
      if (typeof a.targetId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(a.targetId)) throw Error("Impulse actor identity");
      return { targetId: a.targetId, resistance256: integer(a.resistance256, 0, 256) };
    }).sort((a, b) => a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0);
    if (new Set(this.actors.map(a => a.targetId)).size !== this.actors.length) throw Error("Duplicate impulse actor");
    this.state = { velocities: this.actors.map(a => ({ targetId: a.targetId, x: 0, y: 0, remainderX: 0, remainderY: 0 })), pending: [], configuration: this.actors.map(a => ({ ...a })) };
  }
  queue(value: readonly ImpulseRequest[]): void {
    if (this.advancing) throw Error("Impulse advance in progress");
    const admitted = requests(data(value), this.actors.map(a => a.targetId));
    const pending = requests([...this.state.pending, ...admitted], this.actors.map(a => a.targetId));
    this.state = { ...this.state, pending };
  }
  capture(): ImpulseChannelState { return { velocities: this.state.velocities.map(v => ({ ...v })), pending: this.state.pending.map(r => ({ ...r })), configuration: this.actors.map(a => ({ ...a })) }; }
  restore(value: unknown): void {
    if (this.advancing) throw Error("Impulse advance in progress");
    const root = record(data(value), ["velocities", "pending", "configuration"]);
    if (canonical(root.configuration) !== canonical(this.actors)) throw Error("Impulse policy mismatch");
    if (!Array.isArray(root.velocities) || root.velocities.length !== this.actors.length) throw Error("Impulse actor set mismatch");
    const velocities = root.velocities.map((value, i) => {
      const v = record(value, ["targetId", "x", "y", "remainderX", "remainderY"]);
      const x = integer(v.x, -1024, 1024), y = integer(v.y, -1024, 1024);
      if (v.targetId !== this.actors[i].targetId || Math.abs(x) + Math.abs(y) > 1024) throw Error("Invalid impulse velocity");
      const remainderX = integer(v.remainderX, -255, 255), remainderY = integer(v.remainderY, -255, 255);
      if ((this.actors[i].resistance256 === 0 || this.actors[i].resistance256 === 256) && (remainderX !== 0 || remainderY !== 0)) throw Error("Invalid impulse remainder");
      return { targetId: this.actors[i].targetId, x, y, remainderX, remainderY };
    });
    const pending = requests(root.pending, this.actors.map(a => a.targetId));
    if (canonical(pending) !== canonical(root.pending)) throw Error("Invalid impulse phase");
    this.state = { velocities, pending, configuration: this.actors.map(a => ({ ...a })) };
  }
  advance(statuses: readonly { targetId: string; frozen: boolean; alive: boolean }[], motor: (targetId: string, x: number, y: number) => { x: number; y: number }): void {
    if (this.advancing) throw Error("Impulse advance in progress");
    this.advancing = true;
    try {
      const admitted = data(statuses);
      if (!Array.isArray(admitted) || admitted.length !== this.actors.length) throw Error("Impulse status set mismatch");
      const status = admitted.map(value => {
        const r = record(value, ["targetId", "frozen", "alive"]);
        if (!this.actors.some(a => a.targetId === r.targetId) || typeof r.frozen !== "boolean" || typeof r.alive !== "boolean") throw Error("Impulse status mismatch");
        return r as unknown as { targetId: string; frozen: boolean; alive: boolean };
      });
      if (new Set(status.map(a => a.targetId)).size !== status.length) throw Error("Duplicate impulse status");
      const velocities = this.state.velocities.map((v, i) => {
        const actor = status.find(a => a.targetId === v.targetId)!;
        if (!actor.alive) return { targetId: v.targetId, x: 0, y: 0, remainderX: 0, remainderY: 0 };
        let numeratorX = v.remainderX, numeratorY = v.remainderY;
        const scale = 256 - this.actors[i].resistance256;
        for (const r of this.state.pending) if (r.targetId === v.targetId) {
          numeratorX += r.x * scale; numeratorY += r.y * scale;
        }
        const incomingX = Math.trunc(numeratorX / 256) || 0, incomingY = Math.trunc(numeratorY / 256) || 0;
        const remainderX = numeratorX - incomingX * 256, remainderY = numeratorY - incomingY * 256;
        const velocity = clamp(v.x + incomingX, v.y + incomingY);
        if (actor.frozen) return { targetId: v.targetId, ...velocity, remainderX, remainderY };
        const moved = motor(v.targetId, velocity.x, velocity.y);
        integer(moved.x, -1024, 1024); integer(moved.y, -1024, 1024);
        if (Math.abs(moved.x) > Math.abs(velocity.x) || Math.abs(moved.y) > Math.abs(velocity.y) || moved.x * velocity.x < 0 || moved.y * velocity.y < 0) throw Error("Impulse motor exceeded request");
        return { targetId: v.targetId, x: moved.x === velocity.x ? drag(velocity.x) : 0, y: moved.y === velocity.y ? drag(velocity.y) : 0, remainderX: moved.x === velocity.x ? remainderX : 0, remainderY: moved.y === velocity.y ? remainderY : 0 };
      });
      this.state = { velocities, pending: [], configuration: this.actors.map(a => ({ ...a })) };
    } finally { this.advancing = false; }
  }
}
const policies = [{ targetId: "hero", resistance256: 128 }, { targetId: "target", resistance256: 0 }];
/** Opt-in consumer: legacy input/contact trades finish first, then velocity moves
 * through the same arena X/Y sweep. Tick-start hit-stop retains velocity without
 * movement/drag; newly gathered hits freeze following ticks. */
export class ArenaImpulseFixture {
  private world = world();
  private channel = new ImpulseChannel(policies);
  queue(value: readonly ImpulseRequest[]): void {
    if (this.world.result !== "playing") throw Error("Impulse world is terminal");
    this.channel.queue(value);
  }
  step(value: ArenaInput) {
    const admitted = data(value) as ArenaInput;
    const staged = world();
    restoreArenaCheckpoint(staged, encodeArenaCheckpoint(this.world));
    if (staged.result !== "playing") throw Error("Impulse world is terminal");
    const frozen = new Set(staged.actors.filter(a => a.freezeTicks > 0).map(a => a.spawnId));
    stepArena(staged, admitted);
    const channel = new ImpulseChannel(policies); channel.restore(this.channel.capture());
    channel.advance(staged.actors.map(a => ({ targetId: a.spawnId, alive: a.hp > 0, frozen: frozen.has(a.spawnId) })), (id, x, y) => {
      const actor = staged.actors.find(a => a.spawnId === id)!;
      const before = { x: actor.x, y: actor.y };
      moveArenaBody(staged, actor, x, y);
      return { x: actor.x - before.x, y: actor.y - before.y };
    });
    this.world = staged; this.channel = channel;
    return this.observe();
  }
  observe() { return { arena: observeArena(this.world), ...this.channel.capture(), policy: { phase: "after-gathered-trades", frozen: "accumulate-retain-no-drag", resistance256: { hero: 128, target: 0 } } }; }
  capture(): ArenaImpulseCheckpoint { return { format: "arena-impulse-v1", arena: encodeArenaCheckpoint(this.world), ...this.channel.capture() }; }
  restore(value: unknown): void {
    const root = record(data(value), ["format", "arena", "velocities", "pending", "configuration"]);
    if (root.format !== "arena-impulse-v1" || typeof root.arena !== "string" || !Array.isArray(root.velocities) || root.velocities.length !== policies.length) throw Error("Impulse checkpoint mismatch");
    const staged = world(); restoreArenaCheckpoint(staged, root.arena);
    if (encodeArenaCheckpoint(staged) !== root.arena) throw Error("Noncanonical impulse arena");
    const channel = new ImpulseChannel(policies);
    channel.restore({ velocities: root.velocities, pending: root.pending, configuration: root.configuration });
    const state = channel.capture();
    if (state.velocities.some(v => staged.actors.find(a => a.spawnId === v.targetId)!.hp === 0 && (v.x !== 0 || v.y !== 0 || v.remainderX !== 0 || v.remainderY !== 0)) || staged.result !== "playing" && state.pending.length) throw Error("Invalid impulse phase");
    this.world = staged; this.channel = channel;
  }
  save(): string { return canonical(this.capture()); }
  load(bytes: string): void { this.restore(boundedJSON(bytes, IMPULSE_LIMITS.checkpointCharacters, { rejectNegativeZero: true })); }
}
