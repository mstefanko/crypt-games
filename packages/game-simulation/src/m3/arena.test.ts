import { arenaBenchmarkDefinition, createArenaBenchmark } from "../../../../examples/game-m3/arena-benchmark";
import { DEFAULT_ARENA_DEFINITION } from "../../../../examples/game-m3/project";
import { describe, expect, it } from "vitest";
import {
  AIM_DIRECTIONS,
  advanceArena,
  arenaAimVelocity,
  createArena,
  encodeArenaCheckpoint,
  observeArena,
  quantizeArenaAim,
  restartArena,
  restoreArenaCheckpoint,
  stepArena,
  validateArenaDefinition,
} from "./arena";
import { moveArenaBody, sweepArenaContact } from "./arena-geometry";
import type { ArenaDefinition, ArenaInput, ArenaWorld } from "./arena";

const U = 256;
const ID = {
  gameId: "arena-test",
  rulesBuildId: "source:test",
  contentId: "content:test",
};
const idle: ArenaInput = {
  moveX: 0,
  moveY: 0,
  aim: 0,
  fire: false,
  dash: false,
  shove: false,
};
function definition(patch: Partial<ArenaDefinition> = {}): ArenaDefinition {
  return validateArenaDefinition({
    ...DEFAULT_ARENA_DEFINITION,
    width: 200 * U,
    height: 120 * U,
    walls: [],
    player: {
      id: "player",
      x: 10 * U,
      y: 50 * U,
      width: 10 * U,
      height: 10 * U,
      hp: 5,
    },
    enemies: [
      {
        id: "enemy",
        x: 100 * U,
        y: 50 * U,
        width: 10 * U,
        height: 10 * U,
        hp: 5,
      },
    ],
    enemySpeed: 0,
    ...patch,
  });
}
function world(patch: Partial<ArenaDefinition> = {}): ArenaWorld {
  return createArena(definition(patch), ID, 73);
}
function corrupt(w: ArenaWorld, change: (o: any) => void): void {
  const previous = encodeArenaCheckpoint(w),
    o = JSON.parse(previous);
  change(o);
  expect(() => restoreArenaCheckpoint(w, JSON.stringify(o))).toThrow();
  expect(encodeArenaCheckpoint(w)).toBe(previous);
}

describe("arena integer aim and bounded geometry", () => {
  it("commits all 256 directions and uses stable quantization without runtime trig", () => {
    expect(AIM_DIRECTIONS).toHaveLength(256);
    expect(AIM_DIRECTIONS[0]).toEqual([65536, 0]);
    expect(AIM_DIRECTIONS[64]).toEqual([0, 65536]);
    expect(AIM_DIRECTIONS[128]).toEqual([-65536, 0]);
    expect(AIM_DIRECTIONS[192]).toEqual([0, -65536]);
    for (let i = 0; i < 256; i++) {
      expect(AIM_DIRECTIONS[i].every(Number.isSafeInteger)).toBe(true);
      expect(quantizeArenaAim(...AIM_DIRECTIONS[i])).toBe(i);
      const velocity = arenaAimVelocity(i, 32768);
      expect(velocity[0] ** 2 + velocity[1] ** 2).toBeLessThanOrEqual(
        32768 ** 2,
      );
      expect(velocity.some((v) => Object.is(v, -0))).toBe(false);
    }
    expect(quantizeArenaAim(0, 0)).toBe(0);
    expect(() => quantizeArenaAim(16777217, 0)).toThrow();
    expect(() => arenaAimVelocity(256, 10)).toThrow();
    expect(() => arenaAimVelocity(0, 32769)).toThrow();
    expect(Object.isFrozen(AIM_DIRECTIONS[0])).toBe(true);
  });

  it("slides X then Y over the whole displacement and clamps room bounds", () => {
    const w = world({
      moveSpeed: 8192,
      walls: [{ id: "wall", x: 30 * U, y: 40 * U, width: U, height: 50 * U }],
    });
    stepArena(w, { ...idle, moveX: 127, moveY: 127 });
    expect(w.actors[0].x).toBe(20 * U);
    expect(w.actors[0].y).toBe(66 * U);
    moveArenaBody(w, w.actors[0], -8192, 0);
    expect(w.actors[0].x).toBe(0);
    moveArenaBody(w, w.actors[0], 0, -8192);
    expect(w.actors[0].y).toBe(34 * U);
    moveArenaBody(w, w.actors[0], 0, -8192);
    expect(w.actors[0].y).toBe(2 * U);
    moveArenaBody(w, w.actors[0], 0, -8192);
    expect(w.actors[0].y).toBe(0);
    expect(() => moveArenaBody(w, w.actors[0], 8193, 0)).toThrow();
  });

  it("handles exact edges, corner grazing and moving away from a contact", () => {
    const body = { x: 0, y: 0, width: 1, height: 1 };
    expect(
      sweepArenaContact(body, 100, 0, { x: 50, y: 0, width: 1, height: 1 }),
    ).toEqual({ n: 49, d: 100 });
    // X overlap ends exactly when Y overlap begins: a single corner point.
    expect(
      sweepArenaContact(body, 100, 100, { x: 50, y: 52, width: 1, height: 1 }),
    ).toBeNull();
    // Genuine entry at the end of a tick has positive overlap duration after
    // that point; clipping slab exit to t=1 must not turn it into a graze.
    expect(
      sweepArenaContact(body, 49, 0, { x: 50, y: 0, width: 1, height: 1 }),
    ).toEqual({ n: 49, d: 49 });
    expect(
      sweepArenaContact(body, 50, 50, { x: 50, y: 52, width: 1, height: 1 }),
    ).toBeNull();
    expect(
      sweepArenaContact(body, -100, 0, { x: 1, y: 0, width: 1, height: 1 }),
    ).toBeNull();
    expect(
      sweepArenaContact(body, 100, 0, { x: 50, y: 1, width: 1, height: 1 }),
    ).toBeNull();
    expect(
      sweepArenaContact(body, 100, 100, { x: 50, y: 50, width: 1, height: 1 }),
    ).toEqual({ n: 49, d: 100 });
  });

  it("rejects oversized/embedded/duplicate content and copies immutable definitions", () => {
    for (const patch of [
      { moveSpeed: 8193 },
      { projectileSpeed: 32769 },
      { width: 16777217 },
      { enemySpeed: 8192, shoveDistance: 1 },
      { dashTicks: 60, dashCooldown: 20 },
    ])
      expect(() => definition(patch)).toThrow();
    expect(() =>
      definition({
        walls: [{ id: "bad", x: 10 * U, y: 50 * U, width: U, height: U }],
      }),
    ).toThrow();
    expect(() => definition({ enemies: [] })).toThrow();
    const raw = JSON.parse(JSON.stringify(definition()));
    const w = createArena(raw, ID);
    raw.player.x = 99;
    expect(w.definition.player.x).toBe(10 * U);
    expect(Object.isFrozen(w.definition.player)).toBe(true);
    const duplicate = {
      ...raw,
      walls: [
        { id: "a", x: 0, y: 0, width: 1, height: 1 },
        { id: "a", x: 2, y: 0, width: 1, height: 1 },
      ],
    };
    expect(() => validateArenaDefinition(duplicate)).toThrow();
  });
});

describe("arena real contacts and gameplay", () => {
  it("sweeps fast projectiles through thin enemies and stops on thin walls", () => {
    const w = world({ projectileSpeed: 128 * U });
    stepArena(w, { ...idle, fire: true });
    expect(w.actors[1].hp).toBe(4);
    expect(w.projectiles).toHaveLength(0);
    const blocked = world({
      projectileSpeed: 128 * U,
      walls: [{ id: "thin", x: 50 * U, y: 0, width: 1, height: 120 * U }],
    });
    stepArena(blocked, { ...idle, fire: true });
    expect(blocked.actors[1].hp).toBe(5);
    expect(blocked.projectiles).toHaveLength(0);
  });

  it("lets a projectile graze a wall corner and hit the enemy beyond it", () => {
    const w = world({
      player: { id: "player", x: 10, y: 10, width: 1, height: 1, hp: 5 },
      enemies: [{ id: "enemy", x: 100, y: 100, width: 1, height: 1, hp: 5 }],
      walls: [{ id: "grazed-corner", x: 50, y: 52, width: 1, height: 1 }],
      projectileSize: 1,
      projectileSpeed: 256,
    });
    stepArena(w, { ...idle, aim: 32, fire: true });
    expect(w.actors[1].hp).toBe(4);
    expect(w.projectiles).toHaveLength(0);
  });

  it("registers fast enemy touch across a one-unit player along actual wall-resolved segments", () => {
    const player = {
      id: "player",
      x: 50 * U,
      y: 50 * U,
      width: 1,
      height: 1,
      hp: 5,
    };
    const enemy = {
      id: "enemy",
      x: 40 * U,
      y: 50 * U,
      width: 1,
      height: 1,
      hp: 5,
    };
    const w = world({
      player,
      enemies: [enemy],
      projectileSize: 1,
      enemySpeed: 32 * U,
      shoveDistance: 0,
    });
    stepArena(w, idle);
    expect(w.actors[1].x).toBe(72 * U);
    expect(w.actors[0].hp).toBe(4);
    expect(w.actors.map((a) => a.freezeTicks)).toEqual([4, 4]);
    const vertical = world({
      player,
      enemies: [{ ...enemy, x: player.x, y: 40 * U }],
      projectileSize: 1,
      enemySpeed: 32 * U,
      shoveDistance: 0,
    });
    stepArena(vertical, idle);
    expect(vertical.actors[1].y).toBe(72 * U);
    expect(vertical.actors[0].hp).toBe(4);
    const before = encodeArenaCheckpoint(w),
      restored = world({
        player,
        enemies: [enemy],
        projectileSize: 1,
        enemySpeed: 32 * U,
        shoveDistance: 0,
      });
    restoreArenaCheckpoint(restored, before);
    for (let i = 0; i < 10; i++) {
      advanceArena(w, idle);
      advanceArena(restored, idle);
    }
    expect(encodeArenaCheckpoint(restored)).toBe(encodeArenaCheckpoint(w));

    const blocked = world({
      player,
      enemies: [enemy],
      projectileSize: 1,
      enemySpeed: 32 * U,
      shoveDistance: 0,
      walls: [{ id: "separator", x: 45 * U, y: 0, width: 1, height: 120 * U }],
    });
    stepArena(blocked, idle);
    expect(blocked.actors[1].x).toBe(45 * U - 1);
    expect(blocked.actors[0].hp).toBe(5);

    // The X segment is on the old row; a straight diagonal sweep would invent
    // a contact here even though neither resolved axis segment meets the player.
    const around = world({
      player: { ...player, x: 50 * U, y: 50 * U },
      enemies: [{ ...enemy, y: 40 * U }],
      projectileSize: 1,
      enemySpeed: 32 * U,
      shoveDistance: 0,
    });
    stepArena(around, idle);
    expect(around.actors[0].hp).toBe(5);
  });

  it("resolves rational wall/enemy ties in favor of terrain", () => {
    const w = world({
      projectileSize: U,
      projectileSpeed: 128 * U,
      player: {
        id: "player",
        x: 10 * U,
        y: 15 * U,
        width: 10 * U,
        height: 10 * U,
        hp: 5,
      },
      enemies: [
        {
          id: "enemy",
          x: 60 * U,
          y: 20 * U,
          width: 10 * U,
          height: 10 * U,
          hp: 5,
        },
      ],
      walls: [{ id: "tie", x: 60 * U, y: 0, width: U, height: 20 * U }],
    });
    stepArena(w, { ...idle, fire: true });
    expect(w.actors[1].hp).toBe(5);
    expect(w.projectiles).toHaveLength(0);
  });

  it("resolves coincident enemies in stable authored ID order", () => {
    const a = {
      id: "z",
      x: 100 * U,
      y: 50 * U,
      width: 10 * U,
      height: 10 * U,
      hp: 5,
    };
    const w = world({
      projectileSpeed: 128 * U,
      enemies: [a, { ...a, id: "a" }],
    });
    stepArena(w, { ...idle, fire: true });
    expect(w.actors.map((a) => [a.spawnId, a.hp])).toEqual([
      ["player", 5],
      ["a", 4],
      ["z", 5],
    ]);
  });

  it("despawns at bounds and lifetime and honors projectile capacity", () => {
    const w = world({ projectileSpeed: 128 * U });
    stepArena(w, { ...idle, aim: 128, fire: true });
    expect(w.projectiles).toHaveLength(0);
    const expires = world({ projectileTicks: 1 });
    stepArena(expires, { ...idle, fire: true });
    expect(expires.projectiles).toHaveLength(0);
    const capped = world({
      fireCooldown: 1,
      maxProjectiles: 1,
      projectileSpeed: 1,
    });
    for (let i = 0; i < 50; i++) stepArena(capped, { ...idle, fire: true });
    expect(capped.projectiles).toHaveLength(1);
    expect(capped.nextEntityId).toBe(4);
  });

  it("freezes participants for following ticks while AI and projectiles continue, buffering commands", () => {
    const w = world({
      height: 200 * U,
      enemySpeed: U,
      projectileSpeed: 40 * U,
      fireCooldown: 1,
      enemies: [
        { id: "a", x: 50 * U, y: 50 * U, width: 10 * U, height: 10 * U, hp: 5 },
        {
          id: "b",
          x: 150 * U,
          y: 80 * U,
          width: 10 * U,
          height: 10 * U,
          hp: 5,
        },
      ],
    });
    stepArena(w, { ...idle, fire: true });
    expect(w.actors[0].freezeTicks).toBe(4);
    expect(w.actors[1].freezeTicks).toBe(4);
    const x = w.actors[1].x,
      ai = w.actors[1].aiTicks,
      other = w.actors[2].x;
    stepArena(w, { ...idle, fire: true, aim: 64, moveX: 127 });
    expect(w.actors[1].x).toBe(x);
    expect(w.actors[1].aiTicks).toBe(ai);
    expect(w.actors[2].x).toBeLessThan(other);
    expect(w.actors[0].fireBuffer).toBe(6);
    for (let i = 0; i < 3; i++) stepArena(w, { ...idle, aim: 64 });
    expect(w.actors[0].freezeTicks).toBe(0);
    stepArena(w, { ...idle, aim: 64 });
    expect(w.projectiles).toHaveLength(1);
    const y = w.projectiles[0].y;
    w.actors[0].freezeTicks = 2;
    stepArena(w, { ...idle, aim: 64 });
    expect(w.projectiles[0].y).toBeGreaterThan(y);
  });

  it("cancels buffered actions during hitstop and cancels movement", () => {
    const w = world();
    w.actors[0].freezeTicks = 2;
    stepArena(w, { ...idle, fire: true, dash: true, shove: true });
    stepArena(w, { ...idle, cancel: true });
    for (let i = 0; i < 4; i++)
      stepArena(w, { ...idle, moveX: 127, cancel: true });
    expect(w.projectiles).toHaveLength(0);
    expect(w.actors[0].x).toBe(10 * U);
    expect(w.actors[0].dashTicks).toBe(0);
  });

  it("preserves cancel→press, press→cancel and press→release within one tick", () => {
    const afterCancel = world();
    stepArena(afterCancel, {
      ...idle,
      edges: [
        { action: "dash", kind: "cancel" },
        { action: "dash", kind: "pressed" },
        { action: "dash", kind: "released" },
      ],
    });
    expect(afterCancel.actors[0].dashCooldown).toBe(75);
    expect(afterCancel.actors[0].x).toBe(17 * U);
    const canceledPress = world();
    stepArena(canceledPress, {
      ...idle,
      edges: [
        { action: "dash", kind: "pressed" },
        { action: "dash", kind: "cancel" },
      ],
    });
    expect(canceledPress.actors[0].dashCooldown).toBe(0);
    expect(canceledPress.actors[0].x).toBe(10 * U);
    const tap = world();
    stepArena(tap, {
      ...idle,
      edges: [
        { action: "fire", kind: "pressed" },
        { action: "fire", kind: "released" },
      ],
    });
    expect(tap.projectiles).toHaveLength(1);
    expect(tap.held).toEqual({ fire: false, dash: false, shove: false });
    const explicit = world();
    stepArena(explicit, {
      ...idle,
      cancel: true,
      shove: true,
      edges: [{ action: "shove", kind: "pressed" }],
    });
    expect(explicit.actors[0].shoveCooldown).toBe(45);
  });

  it("serializes held decoding and accepts fresh ordered presses during freeze after pause cancels", () => {
    const w = world();
    w.actors[0].freezeTicks = 2;
    stepArena(w, {
      ...idle,
      dash: true,
      edges: [{ action: "dash", kind: "pressed" }],
    });
    expect(w.actors[0].dashBuffer).toBe(6);
    const bytes = encodeArenaCheckpoint(w),
      restored = world();
    restoreArenaCheckpoint(restored, bytes);
    const controls: ArenaInput = {
      ...idle,
      fire: true,
      edges: [
        { action: "fire", kind: "cancel" },
        { action: "dash", kind: "cancel" },
        { action: "shove", kind: "cancel" },
        { action: "fire", kind: "pressed" },
      ],
    };
    stepArena(w, controls);
    stepArena(restored, controls);
    expect(w.actors[0].dashBuffer).toBe(0);
    expect(w.actors[0].fireBuffer).toBe(6);
    expect(encodeArenaCheckpoint(restored)).toBe(encodeArenaCheckpoint(w));
    const released: ArenaInput = {
      ...idle,
      edges: [{ action: "fire", kind: "released" }],
    };
    stepArena(w, released);
    stepArena(restored, released);
    expect(w.projectiles).toHaveLength(1);
    expect(encodeArenaCheckpoint(restored)).toBe(encodeArenaCheckpoint(w));
  });

  it("validates ordered held transitions and limits before consuming anything", () => {
    const w = world(),
      before = encodeArenaCheckpoint(w);
    for (const controls of [
      { ...idle, fire: true, edges: [] },
      { ...idle, edges: [{ action: "fire", kind: "released" }] },
      {
        ...idle,
        fire: true,
        edges: [
          { action: "fire", kind: "pressed" },
          { action: "fire", kind: "pressed" },
        ],
      },
      {
        ...idle,
        edges: Array.from({ length: 33 }, () => ({
          action: "fire",
          kind: "cancel",
        })),
      },
      { ...idle, edges: [{ action: "attack", kind: "pressed" }] },
    ]) {
      expect(() => stepArena(w, controls as ArenaInput)).toThrow();
      expect(encodeArenaCheckpoint(w)).toBe(before);
    }
    corrupt(w, (o) => (o.held.fire = 1));
    corrupt(w, (o) => (o.held.extra = false));
  });

  it("dashes through bounded movement and shoves against wall clearance", () => {
    const w = world({
      walls: [{ id: "wall", x: 30 * U, y: 0, width: U, height: 120 * U }],
    });
    stepArena(w, { ...idle, dash: true });
    expect(w.actors[0].x).toBe(17 * U);
    for (let i = 0; i < 4; i++) stepArena(w, idle);
    expect(w.actors[0].x).toBe(20 * U);
    const shoved = world({
      enemies: [
        {
          id: "enemy",
          x: 25 * U,
          y: 50 * U,
          width: 10 * U,
          height: 10 * U,
          hp: 5,
        },
      ],
      walls: [{ id: "wall", x: 40 * U, y: 0, width: U, height: 120 * U }],
    });
    stepArena(shoved, { ...idle, shove: true });
    expect(shoved.actors[1].hp).toBe(4);
    expect(shoved.actors[1].x).toBe(30 * U);
    expect(shoved.actors[1].freezeTicks).toBe(4);
    const blocked = world({
      shoveRange: 32 * U,
      enemies: [
        {
          id: "enemy",
          x: 35 * U,
          y: 50 * U,
          width: 10 * U,
          height: 10 * U,
          hp: 5,
        },
      ],
      walls: [{ id: "wall", x: 25 * U, y: 0, width: U, height: 120 * U }],
    });
    stepArena(blocked, { ...idle, shove: true });
    expect(blocked.actors[1].hp).toBe(5);
  });

  it("gathers trades before damage and gives player death result priority", () => {
    const w = world({
      player: { ...definition().player, hp: 1 },
      enemies: [
        {
          id: "enemy",
          x: 15 * U,
          y: 50 * U,
          width: 10 * U,
          height: 10 * U,
          hp: 1,
        },
      ],
      projectileSpeed: 128 * U,
    });
    stepArena(w, { ...idle, fire: true });
    expect(w.actors.map((a) => a.hp)).toEqual([0, 0]);
    expect(w.result).toBe("lost");
    const previous = encodeArenaCheckpoint(w);
    stepArena(w, { ...idle, fire: true });
    expect(encodeArenaCheckpoint(w)).toBe(previous);
    const previousNext = w.nextEntityId;
    restartArena(w);
    expect(w.result).toBe("playing");
    expect(w.tick).toBe(0);
    expect(w.actors[0].id).toBe(previousNext);
    expect(w.actors[0].motionEpoch).toBe(1);
    expect(w.actors.map((a) => a.hp)).toEqual([1, 1]);
    expect(w.projectiles).toHaveLength(0);
  });

  it("wins when the last enemy dies and exposes only detached observations", () => {
    const w = world({ projectileSpeed: 128 * U, projectileDamage: 5 });
    const old = observeArena(w);
    const current = stepArena(w, { ...idle, fire: true });
    expect(current.result).toBe("won");
    expect(old.actors[1].hp).toBe(5);
    current.actors[0].x = 123;
    expect(w.actors[0].x).toBe(10 * U);
  });

  it("clears death hit-stop while retaining surviving participant freeze", () => {
    const enemy = definition().enemies[0];
    const w = world({
      projectileSpeed: 128 * U,
      projectileDamage: 5,
      enemies: [enemy, { ...enemy, id: "survivor", y: 90 * U }],
    });
    stepArena(w, { ...idle, fire: true });
    expect(w.result).toBe("playing");
    expect(w.actors.map((a) => [a.hp, a.freezeTicks])).toEqual([
      [5, 4],
      [0, 0],
      [5, 0],
    ]);
    const checkpoint = encodeArenaCheckpoint(w);
    restoreArenaCheckpoint(w, checkpoint);
    expect(encodeArenaCheckpoint(w)).toBe(checkpoint);
    corrupt(w, (o) => (o.actors[1].freezeTicks = 1));
    for (let i = 0; i < 4; i++) advanceArena(w, idle);
    expect(w.actors.map((a) => a.freezeTicks)).toEqual([0, 0, 0]);
  });

  it("rejects invalid inputs and fails ID/counter exhaustion before mutation", () => {
    const w = world();
    const previous = encodeArenaCheckpoint(w);
    expect(() => stepArena(w, { ...idle, moveX: 128 })).toThrow();
    expect(encodeArenaCheckpoint(w)).toBe(previous);
    for (const key of ["nextEntityId", "tick"] as const) {
      const exhausted = world();
      exhausted[key] = Number.MAX_SAFE_INTEGER;
      const before = encodeArenaCheckpoint(exhausted);
      expect(() => advanceArena(exhausted, { ...idle, fire: true })).toThrow();
      expect(encodeArenaCheckpoint(exhausted)).toBe(before);
    }
    const retry = world();
    retry.nextEntityId = Number.MAX_SAFE_INTEGER - 1;
    const before = encodeArenaCheckpoint(retry);
    expect(() => restartArena(retry)).toThrow();
    expect(encodeArenaCheckpoint(retry)).toBe(before);
  });
});

describe("arena exact checkpoints and reproducible scenes", () => {
  it("rejects actor ID gaps and player AI counters without mutating the current world", () => {
    const w = world();
    advanceArena(w, idle);
    corrupt(w, (o) => {
      o.actors[1].id = 3;
      o.nextEntityId = 4;
    });
    corrupt(w, (o) => {
      o.actors[0].id = 2;
      o.actors[1].id = 3;
      o.nextEntityId = 4;
    });
    corrupt(w, (o) => (o.actors[0].aiTicks = 1));
    restartArena(w);
    const bytes = encodeArenaCheckpoint(w);
    restoreArenaCheckpoint(w, bytes);
    expect(encodeArenaCheckpoint(w)).toBe(bytes);
    corrupt(w, (o) => {
      o.restartCount = 2;
      for (const actor of o.actors) actor.motionEpoch = 2;
    });
  });
  it("resumes full bytes through buffered hitstop, dash, projectiles, AI and retry", () => {
    const a = world({ enemySpeed: 32, projectileSpeed: 128 }),
      b = world({ enemySpeed: 32, projectileSpeed: 128 });
    for (let i = 0; i < 1000; i++) {
      const controls = {
        ...idle,
        moveX: i % 60 < 30 ? 127 : -127,
        moveY: i % 80 < 40 ? 127 : -127,
        aim: i % 256,
        fire: i % 13 === 0,
        dash: i % 70 === 0,
        shove: i % 43 === 0,
      };
      advanceArena(a, controls);
      advanceArena(b, controls);
      if (i % 37 === 0) restoreArenaCheckpoint(b, encodeArenaCheckpoint(a));
      expect(encodeArenaCheckpoint(a)).toBe(encodeArenaCheckpoint(b));
      if (a.result !== "playing") {
        restartArena(a);
        restartArena(b);
      }
    }
  });

  it("strictly rejects unknown, mismatched, malformed and overbounded state atomically", () => {
    const w = world({ projectileSpeed: 1 });
    stepArena(w, { ...idle, fire: true, dash: true });
    const mutations: ((o: any) => void)[] = [
      (o) => o.snapshotVersion++,
      (o) => (o.profile = "grid"),
      (o) => (o.gameId = "other"),
      (o) => (o.rulesBuildId = "other"),
      (o) => (o.contentId = "other"),
      (o) => (o.definitionId = "other"),
      (o) => o.seed++,
      (o) => (o.unknown = 1),
      (o) => (o.actors[0].x = -1),
      (o) => (o.actors[0].hp = 999),
      (o) => (o.actors[0].aim = 256),
      (o) => (o.actors[0].fireBuffer = 7),
      (o) => o.actors[0].motionEpoch++,
      (o) => o.actors[0].width++,
      (o) => (o.actors[1].id = o.actors[0].id),
      (o) => o.actors.reverse(),
      (o) => o.actors.pop(),
      (o) => (o.result = "won"),
      (o) => o.projectiles[0].ownerId++,
      (o) => (o.projectiles[0].vx = 42),
      (o) => (o.projectiles[0].remainingTicks = 0),
      (o) => o.projectiles[0].width++,
      (o) => (o.projectiles[0].id = o.actors[1].id),
      (o) => (o.nextEntityId = o.projectiles[0].id),
      (o) => (o.tick = 0),
    ];
    for (const mutate of mutations) corrupt(w, mutate);
    const before = encodeArenaCheckpoint(w);
    for (const bytes of [
      '{"snapshotVersion":1,"snapshotVersion":1}',
      " ".repeat(2097153),
      "[".repeat(33) + "0" + "]".repeat(33),
      before.replace('"tick":1', '"tick":-0'),
    ]) {
      expect(() => restoreArenaCheckpoint(w, bytes)).toThrow();
      expect(encodeArenaCheckpoint(w)).toBe(before);
    }
  });

  it("prepares real 40/20 and 100/100 active benchmark content through firing", () => {
    for (const [actors, projectiles] of [
      [40, 20],
      [100, 100],
    ]) {
      const w = createArenaBenchmark(actors, projectiles, ID),
        checkpoint = encodeArenaCheckpoint(w);
      expect(w.actors.filter((a) => a.hp > 0)).toHaveLength(actors);
      expect(w.projectiles).toHaveLength(projectiles);
      for (let i = 0; i < 1000; i++) advanceArena(w, idle);
      expect(w.actors.filter((a) => a.hp > 0)).toHaveLength(actors);
      expect(w.projectiles).toHaveLength(projectiles);
      expect(w.result).toBe("playing");
      restoreArenaCheckpoint(w, checkpoint);
      expect(encodeArenaCheckpoint(w)).toBe(checkpoint);
      expect(arenaBenchmarkDefinition(actors).enemies).toHaveLength(actors - 1);
    }
  });
});
