import { DamageableWorld, canonicalDestructionData, DESTRUCTION_LIMITS } from "./destruction";
import type { DamageableDefinition, DestructionCheckpoint, DestructionHit } from "./destruction";
import { queryGeometry } from "./geometry";
import type { GeometryRect } from "./geometry";

function definitions(): DamageableDefinition[] {
  const blast = { bands: [{ radius: 2048, damage: 4 }], friendlyFire: true };
  return [
    { id: "barrel-a", kind: "prop", rect: { x: 0, y: 0, width: 128, height: 128 }, hp: 2, team: 0, brokenBlocking: false, reward: 1, blast },
    { id: "barrel-b", kind: "prop", rect: { x: 0, y: 1000, width: 128, height: 128 }, hp: 4, team: 0, brokenBlocking: false, reward: 1, blast },
    { id: "breakable-wall", kind: "wall", rect: { x: 700, y: -100, width: 128, height: 512 }, hp: 4, team: 1, brokenBlocking: false, reward: 2, blast: null },
    { id: "sheltered-prop", kind: "prop", rect: { x: 1200, y: 0, width: 128, height: 128 }, hp: 4, team: 1, brokenBlocking: false, reward: 3, blast: null },
    { id: "wreck", kind: "car", rect: { x: 2500, y: 100, width: 256, height: 256 }, hp: 4, team: 1, brokenBlocking: true, reward: 4, blast: null },
  ];
}
function freeze(value: DamageableDefinition): DamageableDefinition {
  return Object.freeze({ ...value, rect: Object.freeze(value.rect), blast: value.blast && Object.freeze({ ...value.blast, bands: Object.freeze(value.blast.bands.map(b => Object.freeze(b))) }) });
}
/** Presentation facts are detached from every fixture's authored definitions. */
export const DESTRUCTION_FIXTURE_OBJECTS: readonly DamageableDefinition[] = Object.freeze(definitions().map(freeze));
export interface DestructionFixtureCommand {
  readonly moveX: number;
  readonly hits: readonly DestructionHit[];
  readonly ignite: readonly string[];
}
export interface DestructionFixtureCheckpoint {
  readonly format: "p2-destruction-fixture-v1";
  readonly world: DestructionCheckpoint;
  readonly body: GeometryRect;
  readonly commands: readonly DestructionFixtureCommand[];
}
/** Consumer proof: a P0-owned horizontal motor reads the current collision revision
 * before destruction commits. It can enter a new opening only next tick. No N0
 * routes/caches or impulse owner exist in this bounded fixture. No step = pause. */
export class DestructionFixture {
  private world = new DamageableWorld({ objects: definitions() });
  private body: GeometryRect = { x: 500, y: 160, width: 64, height: 64 };
  private commands: DestructionFixtureCommand[] = [];
  step(value: DestructionFixtureCommand = { moveX: 0, hits: [], ignite: [] }) {
    canonicalDestructionData(value);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3 || !Object.hasOwn(value, "moveX") || !Object.hasOwn(value, "hits") || !Object.hasOwn(value, "ignite") || !Number.isSafeInteger(value.moveX) || Object.is(value.moveX, -0) || Math.abs(value.moveX) > 512) throw Error("Invalid destruction fixture command");
    if (this.world.observe().tick >= DESTRUCTION_LIMITS.ticks && value.moveX !== 0) throw Error("Destruction tick cap: movement cannot advance during blast drain");
    const contact = queryGeometry(this.world.collisionShapes(), { kind: "sweep", rect: this.body, delta: { x: value.moveX, y: 0 } }).contacts[0];
    const dx = contact ? Math.trunc(value.moveX * contact.time.n / contact.time.d) : value.moveX;
    // The world stages validation and effects. Publish the motor only on success.
    this.world.step({ hits: value.hits, ignite: value.ignite });
    this.body = { ...this.body, x: this.body.x + dx };
    this.commands.push(JSON.parse(JSON.stringify(value)) as DestructionFixtureCommand);
    return this.observe();
  }
  observe() { return { world: this.world.observe(), body: { ...this.body }, collisionShapes: this.world.collisionShapes() }; }
  capture(): DestructionFixtureCheckpoint {
    return { format: "p2-destruction-fixture-v1", world: this.world.capture(), body: { ...this.body }, commands: JSON.parse(JSON.stringify(this.commands)) as DestructionFixtureCommand[] };
  }
  restore(value: unknown): void {
    const canonical = canonicalDestructionData(value);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 4 || !Object.hasOwn(value, "format") || !Object.hasOwn(value, "world") || !Object.hasOwn(value, "body") || !Object.hasOwn(value, "commands")) throw Error("Invalid destruction fixture checkpoint");
    const root = value as DestructionFixtureCheckpoint;
    if (root.format !== "p2-destruction-fixture-v1" || !Array.isArray(root.commands) || root.commands.length > DESTRUCTION_LIMITS.lifetimeTicks) throw Error("Incompatible destruction fixture checkpoint");
    const staged = new DestructionFixture();
    for (const command of root.commands) staged.step(command);
    if (canonical !== canonicalDestructionData(staged.capture())) throw Error("Inconsistent destruction fixture checkpoint");
    this.world = staged.world; this.body = staged.body; this.commands = staged.commands;
  }
  save(): string { return canonicalDestructionData(this.capture()); }
  load(bytes: string): void {
    if (typeof bytes !== "string" || bytes.length > DESTRUCTION_LIMITS.checkpointCharacters) throw Error("Destruction checkpoint cap");
    const value: unknown = JSON.parse(bytes);
    if (canonicalDestructionData(value) !== bytes) throw Error("Noncanonical destruction checkpoint bytes");
    this.restore(value);
  }
}
