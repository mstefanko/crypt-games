import { describe, expect, it } from "vitest";
import { CharacterMotionFixture, inspectCharacterArenaMotion } from "./character-motion";
import { CHARACTER_ARENA_CATALOG, createCharacterArenaFixture } from "./character-fixture";
import { createArena, validateArenaDefinition, stepArena, encodeArenaCheckpoint } from "./m3/arena";

const input = (extra = {}) => ({ moveX: 0, moveY: 0, aim: 0, fire: false, dash: false, shove: false, ...extra });
describe("character motion/impulse authority seam", () => {
  it("maps C0 controller/body metadata to the sole real arena owner", () => {
    const f = new CharacterMotionFixture();
    const before = f.observe();
    expect(before.characters.map(c => c.placementId)).toEqual(["hero", "target"]);
    expect(before.characters[0]).toMatchObject({ controller: "arena-v1", definitionId: "character-motion-arena-v1", entityId: 1, owners: { motion: "arena-v1", body: "profile-definition" } });
    expect(before.characters[0].body).toEqual(before.characters[0].hurt);
    before.characters[0].body.width = 1;
    before.characters[0].state.hp = 99;
    expect(f.observe().characters[0].body.width).toBe(2560);
    expect(f.observe().characters[0].state.hp).toBe(4);
    const c1 = createCharacterArenaFixture();
    c1.execute({ id: "create", revision: 0, action: { kind: "create", buildId: "scout", appearanceId: "warm", displayName: "Scout" } });
    c1.start();
    expect(c1.observe().motion).toMatchObject({ definitionId: "character-arena-v1", body: { width: 2560, height: 2560 }, owners: { motion: "arena-v1" } });
    const saved = c1.capture().arena;
    c1.execute({ id: "cool", revision: 1, action: { kind: "customize", appearanceId: "cool", displayName: "Cool" } });
    expect(c1.capture().arena).toBe(saved);
    expect(c1.observe().motion!.body.width).toBe(2560);
  });
  it("finishes gathered shove/contact/projectile trades then clips the impulse through the real motor", () => {
    const f = new CharacterMotionFixture();
    const after = f.step(input({ shove: true, fire: true }));
    const [hero, target] = after.arena.actors;
    expect(hero.hp).toBe(3); // enemy touch trades with the shove/projectile
    expect(target.hp).toBe(5); // one shove damage plus two projectile damage
    expect(target.x).toBe(40 * 256); // stops flush at the wall x=50 with width=10
    expect(target.x + target.width).toBe(after.arena.walls[0].x);
    expect(hero.freezeTicks).toBe(3);
    expect(target.freezeTicks).toBe(3);
    expect(after.arena.projectiles).toEqual([]);
    expect(after.characters[1].body.x).toBe(target.x);
    for (let i = 0; i < 3; i++) {
      const frozen = f.step(input());
      expect(frozen.arena.actors[1].x).toBe(target.x);
      expect(frozen.arena.actors[1].hp).toBe(5);
    }
    expect(f.step(input()).arena.actors[1].x).toBe(target.x - 256);
  });
  it("retains dash ownership during freeze and exact restored continuation", () => {
    const f = new CharacterMotionFixture();
    f.step(input({ dash: true, shove: true, fire: true }));
    expect(f.observe().characters[0].state).toMatchObject({ dashTicks: 4, freezeTicks: 3 });
    const midHitstop = f.save();
    const resumed = new CharacterMotionFixture();
    resumed.load(midHitstop);
    expect(resumed.save()).toBe(midHitstop);
    for (let tick = 0; tick < 80; tick++) {
      const command = input({ moveX: tick < 16 ? 127 : 0, aim: tick < 12 ? 0 : 128, fire: tick % 19 === 0, shove: tick === 48 });
      expect(resumed.step(command)).toEqual(f.step(command));
      expect(resumed.save()).toBe(f.save());
    }
  });
  it("stages invalid saves, body/identity/owner changes and command failures atomically", () => {
    const f = new CharacterMotionFixture();
    f.step(input({ shove: true }));
    const before = f.save();
    const saved = f.capture();
    const changes = [
      (a: any) => { a.rulesBuildId = "other"; },
      (a: any) => { a.actors[0].width = 20; },
      (a: any) => { a.actors[1].x = 49 * 256; },
      (a: any) => { a.actors[0].motionEpoch = 1; },
      (a: any) => { a.actors[1].freezeTicks = 4; },
    ];
    for (const alter of changes) {
      const changed = JSON.parse(saved.arena);
      alter(changed);
      expect(() => f.restore({ ...saved, arena: JSON.stringify(changed) })).toThrow();
      expect(f.save()).toBe(before);
    }
    for (const bytes of ["{", before.replace('"format":', '"format":"duplicate","format":'), before.replace('"character-arena-motion-v1"', '"future"'), " ".repeat(262145)]) {
      expect(() => f.load(bytes)).toThrow();
      expect(f.save()).toBe(before);
    }
    let reads = 0;
    const accessor = { ...saved };
    Object.defineProperty(accessor, "arena", { enumerable: true, get: () => { reads++; return saved.arena; } });
    expect(() => f.restore(accessor)).toThrow("accessor");
    const command = input();
    Object.defineProperty(command, "moveX", { enumerable: true, get: () => { reads++; return 0; } });
    expect(() => f.step(command)).toThrow("accessor");
    expect(reads).toBe(0);
    for (const bad of [input({ moveX: 128 }), input({ moveX: -0 }), input({ aim: 1.5 }), input({ fire: "yes" }), input({ extra: true }), input({ edges: [{ action: "dash", kind: "released" }] })]) {
      expect(() => f.step(bad as any)).toThrow();
      expect(f.save()).toBe(before);
    }
    expect(() => f.restore({ ...saved, [Symbol("extra")]: 1 })).toThrow();
    expect(() => f.restore(Object.assign(Object.create({}), saved))).toThrow();
  });
  it("rejects catalog/controller or definition mismatch rather than creating visual bodies", () => {
    const f = new CharacterMotionFixture();
    const source = JSON.parse(f.capture().arena);
    // Use a separately prepared world with the same bounded geometry but a different definition.
    const definition = validateArenaDefinition({
      id: "different", width: 96 * 256, height: 64 * 256, walls: [],
      player: { id: "hero", x: 0, y: 0, width: 256, height: 256, hp: 4 },
      enemies: [{ id: "target", x: 256, y: 0, width: 256, height: 256, hp: 4 }],
      moveSpeed: 0, enemySpeed: 0, projectileSpeed: 256, projectileSize: 1, projectileTicks: 1, projectileDamage: 1, fireCooldown: 1,
      dashSpeed: 0, dashTicks: 1, dashCooldown: 1, shoveRange: 0, shoveDistance: 0, shoveDamage: 1, shoveCooldown: 1, enemyDamage: 1, enemyCooldown: 1, hitstopTicks: 0, maxProjectiles: 1,
    });
    const world = createArena(definition, { gameId: source.gameId, rulesBuildId: source.rulesBuildId, contentId: source.contentId });
    expect(() => inspectCharacterArenaMotion(world, CHARACTER_ARENA_CATALOG, "hero")).toThrow("mismatch");
    expect(() => inspectCharacterArenaMotion(world, CHARACTER_ARENA_CATALOG, "unknown")).toThrow("mismatch");
  });
});

it("rejects noncanonical embedded arena bytes without adoption", () => {
  const f = new CharacterMotionFixture(), before = f.save(), saved = f.capture();
  expect(() => f.restore({ ...saved, arena: JSON.stringify(JSON.parse(saved.arena), null, 2) })).toThrow(/Noncanonical/);
  expect(f.save()).toBe(before);
});

it("enforces combined displacement, clips blocked shoves, and clears lethal hit-stop", () => {
  // Diagnostic worlds isolate the existing arena motor, with no second motion owner.
  const d = {
    id: "edge-motion", width: 96 * 256, height: 64 * 256,
    walls: [{ id: "wall", x: 40 * 256, y: 0, width: 4 * 256, height: 64 * 256 }],
    player: { id: "hero", x: 20 * 256, y: 24 * 256, width: 10 * 256, height: 10 * 256, hp: 4 },
    enemies: [{ id: "target", x: 30 * 256, y: 24 * 256, width: 10 * 256, height: 10 * 256, hp: 2 }],
    moveSpeed: 256, enemySpeed: 0, projectileSpeed: 2048, projectileSize: 512,
    projectileTicks: 90, projectileDamage: 2, fireCooldown: 15,
    dashSpeed: 1792, dashTicks: 5, dashCooldown: 75,
    shoveRange: 2560, shoveDistance: 3072, shoveDamage: 1, shoveCooldown: 45,
    enemyDamage: 1, enemyCooldown: 40, hitstopTicks: 3, maxProjectiles: 20,
  };
  expect(() => validateArenaDefinition({ ...d, enemySpeed: 1, shoveDistance: 8192 })).toThrow(/displacement/);
  expect(() => validateArenaDefinition({ ...d, enemySpeed: 0, shoveDistance: 8192 })).not.toThrow();
  for (const hp of [1, 2]) {
    const w = createArena(validateArenaDefinition({ ...d, enemies: [{ ...d.enemies[0], hp }] }),
      { gameId: "test", rulesBuildId: "test", contentId: "test" });
    stepArena(w, input({ shove: true }));
    expect(w.actors[1].x).toBe(30 * 256);
    expect(w.actors[1].hp).toBe(hp - 1);
    expect(w.actors[1].freezeTicks).toBe(hp === 1 ? 0 : 3);
    expect(w.result).toBe(hp === 1 ? "won" : "playing");
    expect(encodeArenaCheckpoint(w)).toContain('"hp":' + (hp - 1));
  }
});
