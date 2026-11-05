import type { ArenaClock, ArenaDefinition, ArenaSession } from "./arena-session";
import { canonicalJson } from "./session-protocol";

type RecordValue = Record<string, any>;
/** Detached, bounded validation. No live owner writes occur until this returns.
 * Legacy state-only payloads are deliberately rejected: restart the encounter. */
export function validateArenaCheckpoint(value: unknown, definition: ArenaDefinition,
  seed: number, contentId: string, clock: ArenaClock): ReturnType<ArenaSession["snapshot"]> {
  let nodes = 0;
  function bounded(v: unknown, depth = 0): void {
    if (++nodes > 100000 || depth > 24) throw Error("Arena checkpoint budget");
    if (typeof v === "string" && v.length > 4096) throw Error("Arena string budget");
    if (Array.isArray(v) && v.length > 4096) throw Error("Arena array budget");
    if (v && typeof v === "object") for (const x of Object.values(v)) bounded(x, depth + 1);
  }
  bounded(value);
  const s = JSON.parse(canonicalJson(value)) as RecordValue;
  function ok(condition: unknown): asserts condition { if (!condition) throw Error("Invalid arena checkpoint"); }
  const obj = (x: any): x is RecordValue => !!x && typeof x === "object" && !Array.isArray(x);
  const num = (x: any) => typeof x === "number" && Number.isFinite(x);
  const nonnegative = (x: any) => num(x) && x >= 0;
  const integer = (x: any) => Number.isSafeInteger(x) && x >= 0;
  const strings = (x: any) => Array.isArray(x) && x.every((v: any) => typeof v === "string");
  const numeric = (x: any, keys: string[]) => { ok(obj(x)); for (const k of keys) ok(num(x[k])); };
  const optionalNumbers = (x: any, keys: string[]) => { for (const k of keys) if (x[k] !== undefined) ok(num(x[k])); };
  const optionalStrings = (x: any, keys: string[]) => { for (const k of keys) ok(x[k] === undefined || typeof x[k] === "string"); };
  const contact = (x: any) => {
    optionalNumbers(x, ["actionId", "x", "y", "heading", "damage"]);
    optionalStrings(x, ["moveId", "targetId", "effectId"]);
    ok(x.material === undefined || ["organic", "armor", "block", "kill", "miss"].includes(x.material));
    ok(x.outcome === undefined || ["hit", "blocked", "killed", "miss"].includes(x.outcome));
  };
  const bools = (x: any, keys: string[], optional = false) => { for (const k of keys) ok((optional && x[k] === undefined) || typeof x[k] === "boolean"); };
  const array = (x: any, visit: (x: any) => void) => { ok(Array.isArray(x)); x.forEach(visit); };
  ok(obj(s) && obj(s.checkpoint));
  const c = s.checkpoint;
  ok(c.version === 2 && c.seed === seed && c.contentId === contentId && c.rulesBuildId === `${clock}/event-ticks-v1`);
  ok(integer(c.ticks) && nonnegative(c.remainder) && c.remainder < 1 / 60);
  if (clock === "legacy-delta-v1") ok(c.remainder === 0 && c.pendingInput === null);
  if (c.pendingInput !== null) {
    numeric(c.pendingInput, ["x", "y", "aimX", "aimY"]);
    optionalNumbers(c.pendingInput, ["movementScale"]);
    bools(c.pendingInput, ["attack", "attackHeld", "attackReleased", "dash", "cast", "special"]);
    bools(c.pendingInput, ["cancelled"], true);
    ok(c.pendingInput.command === undefined || typeof c.pendingInput.command === "string");
  }
  numeric(s, ["time", "room", "wave", "dash", "dashRecharge", "dashTime", "cast", "nextId", "spawnTimer", "combo", "charge", "sequence", "scaleElapsed", "scaleCooldown", "buffer", "castPose"]);
  ok(integer(s.room) && s.room < definition.rooms.length && integer(s.wave) && integer(s.nextId) && integer(s.sequence));
  ok(nonnegative(s.time) && Number.isSafeInteger(Math.floor(s.time * 60)) && nonnegative(s.scaleCooldown));
  let highestAllocated = 0;
  const allocated = (id: any) => { ok(integer(id)); highestAllocated = Math.max(highestAllocated, id); };
  ok(["prepare", "combat", "upgrade", "won", "lost"].includes(s.phase));
  ok(definition.weapons.some(w => w.id === s.weapon));
  for (const key of ["boons", "offered", "spawn", "messages"]) ok(strings(s[key]));
  ok(s.boons.every((id: string) => definition.boons.some(b => b.id === id)));
  ok(s.offered.every((id: string) => definition.boons.some(b => b.id === id)));
  ok(s.spawn.every((id: string) => definition.enemies.some(e => e.id === id)));
  optionalNumbers(s, ["dashSpeedScale", "comboRemaining", "inputClock", "commandOrder"]);
  if (s.inputClock !== undefined) ok(nonnegative(s.inputClock) && Number.isSafeInteger(Math.floor(s.inputClock * 60)));
  if (s.commandOrder !== undefined) ok(integer(s.commandOrder));
  bools(s, ["exitOpen", "rewardSelected"], true);
  function actor(a: any, player = false) {
    numeric(a, ["x", "y", "hp", "maxHp", "facing", "cooldown", "hurt"]);
    ok(typeof a.id === "string" && a.id.length > 0 && a.maxHp > 0);
    if (player) ok(a.id === "player");
    else if (/^enemy-[0-9]+$/.test(a.id)) allocated(Number(a.id.slice(6)));
    ok(player ? a.definition === "player" : definition.enemies.some(e => e.id === a.definition));
    optionalNumbers(a, ["invulnerable", "hurtProtection", "attackKind", "locomotion", "stagger", "deathTime", "shieldBreak"]);
    bools(a, ["moving", "training", "shieldBroken"], true);
    if (a.recoil !== undefined) numeric(a.recoil, ["x", "y", "remaining"]);
    if (a.animation !== undefined) {
      numeric(a.animation, ["id", "elapsed"]); allocated(a.animation.id);
      ok(["idle", "run", "dash", "cast", "charge", "hurt", "death", "attack"].includes(a.animation.kind));
    }
    if (a.action !== undefined) {
      const action = a.action;
      numeric(action, ["id", "elapsed"]); allocated(action.id); ok(strings(action.hits));
      numeric(action.timing, ["tell", "active", "recover"]);
      for (const k of ["tell", "active", "recover"]) ok(nonnegative(action.timing[k]));
      optionalNumbers(action.timing, ["cancelAfter", "comboAfter"]);
      optionalNumbers(action, ["heading", "charge", "combo"]);
      bools(action, ["special", "sweep", "dashStrike"], true);
      for (const k of ["moveId", "clipId"]) ok(action[k] === undefined || typeof action[k] === "string");
    }
  }
  actor(s.player, true);
  const ids = new Set<string>([s.player.id]);
  array(s.enemies, a => { actor(a); ok(!ids.has(a.id)); ids.add(a.id); });
  ok(Array.isArray(s.projectiles) && s.projectiles.length <= 96);
  const projectileIds = new Set<number>();
  array(s.projectiles, p => {
    numeric(p, ["id", "x", "y", "vx", "vy", "life", "damage"]);
    allocated(p.id);
    ok(integer(p.id) && typeof p.owner === "string" && strings(p.hits));
    ok(!projectileIds.has(p.id)); projectileIds.add(p.id);
    ok(nonnegative(p.damage));
    bools(p, ["returning", "cast"], true); optionalNumbers(p, ["actionId"]);
    if (p.actionId !== undefined) allocated(p.actionId);
  });
  array(s.breakables, b => { numeric(b, ["x", "y"]); bools(b, ["alive"]); });
  array(s.impacts, i => { numeric(i, ["id", "x", "y", "life", "shake", "sparks", "color"]); contact(i); allocated(i.id); });
  const commandKinds = new Set<string>();
  const commandOrders = new Set<number>();
  if (s.commands !== undefined) array(s.commands, command => {
    numeric(command, ["at", "order", "aim", "heading"]);
    ok(["attack", "dash", "special", "cast"].includes(command.kind) && integer(command.order));
    ok(!commandOrders.has(command.order)); commandOrders.add(command.order);
    ok(!commandKinds.has(command.kind)); commandKinds.add(command.kind);
    ok(integer(s.commandOrder) && command.order <= s.commandOrder);
    ok(nonnegative(command.at) && num(s.inputClock) && command.at <= s.inputClock);
  });
  if (s.inputEdges !== undefined) bools(s.inputEdges, ["dash", "special", "cast"]);
  if (s.trap !== undefined) {
    numeric(s.trap, ["elapsed", "cycle"]); ok(strings(s.trap.hits));
    ok(["warning", "active", "cooldown"].includes(s.trap.phase));
  }
  if (s.trails !== undefined) array(s.trails, t => { numeric(t, ["x", "y", "life", "id"]); ok(strings(t.hits)); allocated(t.id); });
  if (s.echoes !== undefined) array(s.echoes, e => { numeric(e, ["x", "y", "delay", "id"]); allocated(e.id); });
  ok(obj(s.triggerMemory));
  for (const key of ["lastAt", "uses", "actions", "turns"]) {
    ok(obj(s.triggerMemory[key]));
    for (const v of Object.values(s.triggerMemory[key])) ok(key === "lastAt" || key === "uses" ? num(v) : typeof v === "string");
  }
  ok(integer(c.droppedEvents) && Array.isArray(c.events) && c.events.length <= 512);
  let previous = 0;
  array(c.events, event => {
    ok(obj(event) && integer(event.sequence) && event.sequence > previous && event.sequence <= s.sequence);
    ok(integer(event.tick) && event.tick <= c.ticks && event.sourceId === "arena" && typeof event.kind === "string");
    if (event.payload !== undefined) { numeric(event.payload, ["pan"]); contact(event.payload); if (event.payload.actionId !== undefined) allocated(event.payload.actionId); }
    previous = event.sequence;
  });
  ok(s.nextId > highestAllocated);
  return s as ReturnType<ArenaSession["snapshot"]>;
}
