import { describe, expect, it } from "vitest";
import {
  DestructionEncounter,
  ACTION_ENCOUNTER_LIMITS,
  type ActionEncounterConfiguration,
  type ActionEncounterInput,
  type ActionEncounterCheckpoint,
} from "./destruction-encounter";
import type { DamageableDefinition } from "./destruction";

const idle: ActionEncounterInput = {
  moveX: 0,
  moveY: 0,
  aimX: 0,
  aimY: 0,
  fire: false,
};
const shoot: ActionEncounterInput = { ...idle, aimX: 1, fire: true };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function object(
  id: string,
  patch: Partial<DamageableDefinition> = {},
): DamageableDefinition {
  return {
    id,
    kind: "wall",
    rect: { x: 1536, y: 0, width: 512, height: 3072 },
    hp: 4,
    team: 2,
    brokenBlocking: false,
    reward: 3,
    blast: null,
    ...patch,
  };
}
function config(
  patch: Partial<ActionEncounterConfiguration> = {},
): ActionEncounterConfiguration {
  return {
    id: "sustained-room",
    width: 4096,
    height: 3072,
    player: { x: 256, y: 1024, hp: 100 },
    enemies: [{ id: "bruiser", role: "bruiser", x: 3072, y: 1024, hp: 4096 }],
    objects: [object("breach")],
    modifiers: [],
    ...patch,
  };
}
function restore(
  c: ActionEncounterConfiguration,
  checkpoint: ActionEncounterCheckpoint,
) {
  const room = new DestructionEncounter(c);
  room.restore(checkpoint);
  return room;
}

describe("sustained P2 action consumer", () => {
  it("sustains a live room past the finite proof horizon with bounded compressed replay", () => {
    const c = config(),
      room = new DestructionEncounter(c);
    for (let tick = 0; tick < 10000; tick++) room.step(idle);
    const saved = room.save();
    expect(room.observe()).toMatchObject({
      tick: 10000,
      status: "playing",
      routeInvalidations: 0,
    });
    expect(saved.length).toBeLessThan(12000);
    expect(saved).not.toContain('"history"');
    expect(room.capture().replay).toEqual([{ ticks: 10000, input: idle }]);
    const other = new DestructionEncounter(c);
    other.load(saved);
    expect(other.save()).toBe(saved);
    expect(other.step(idle)).toEqual(room.step(idle));
  });
  it("moves through committed terrain, invalidates actual B0 route consumers, and rewards the breach once", () => {
    const c = config(),
      room = new DestructionEncounter(c);
    const first = room.step({ ...shoot, moveX: 1 });
    expect(first.routes[0]).toMatchObject({ revision: 0, path: [] });
    for (let tick = 1; tick < 7; tick++) room.step({ ...shoot, moveX: 1 });
    const breached = room.observe();
    expect(breached).toMatchObject({
      terrainRevision: 1,
      routeInvalidations: 1,
      routes: [],
      rewardTotal: 3,
    });
    expect(breached.world.objects[0].hp).toBe(0);
    const other = restore(c, room.capture());
    const next = room.step({ ...idle, moveX: 1 });
    expect(next.player.x).toBeGreaterThan(breached.player.x);
    expect(next.routes[0].path.length).toBeGreaterThan(1);
    expect(next.routes[0].revision).toBe(1);
    expect(next.enemies[0].x).toBeLessThan(breached.enemies[0].x);
    expect(other.step({ ...idle, moveX: 1 })).toEqual(next);
    for (let tick = 0; tick < 10; tick++) room.step(shoot);
    expect(room.observe().rewardTotal).toBe(3);
  });
  it("keeps blast cover for simultaneous wall removal and applies actor damage through the impulse motor", () => {
    const c = config({
      objects: [
        object("barrel", {
          kind: "prop",
          rect: { x: 1024, y: 1024, width: 128, height: 128 },
          hp: 2,
          blast: { bands: [{ radius: 2048, damage: 4 }], friendlyFire: true },
        }),
        object("cover", { hp: 2 }),
      ],
      enemies: [{ id: "ranger", role: "ranger", x: 2304, y: 1024, hp: 100 }],
    });
    const room = new DestructionEncounter(c);
    expect(room.step(shoot).world.pending).toEqual([
      { sourceId: "barrel", readyTick: 2 },
    ]);
    const checkpoint = room.capture(),
      other = restore(c, checkpoint);
    const blasted = room.step(idle);
    expect(blasted).toMatchObject({
      player: { x: 0, hp: 96, freezeTicks: 2 },
      enemies: [{ hp: 100 }],
      terrainRevision: 2,
      routeInvalidations: 2,
      rewardTotal: 6,
    });
    expect(blasted.world.destroyed).toEqual(["cover"]);
    expect(
      blasted.impulse.velocities.find((v) => v.targetId === "hero"),
    ).toMatchObject({ x: -192, y: 0 });
    expect(other.step(idle)).toEqual(blasted);
    const frozenX = blasted.player.x;
    expect(room.step({ ...idle, moveX: 1 }).player.x).toBe(frozenX);
    expect(room.step({ ...idle, moveX: 1 }).player.x).toBe(frozenX);
    expect(room.step({ ...idle, moveX: 1 }).player.x).toBe(frozenX); // retained recoil meets boundary and loses velocity
    expect(room.step({ ...idle, moveX: 1 }).player.x).toBeGreaterThan(frozenX);
  });
  it("retains blocking wrecks and their shielding while the room keeps advancing", () => {
    const c = config({
        objects: [
          object("wreck", { kind: "car", hp: 2, brokenBlocking: true }),
        ],
      }),
      room = new DestructionEncounter(c);
    room.step(shoot);
    for (let tick = 0; tick < 100; tick++) room.step({ ...idle, moveX: 1 });
    expect(room.observe()).toMatchObject({
      tick: 101,
      terrainRevision: 0,
      routeInvalidations: 0,
      rewardTotal: 3,
      player: { x: 1408 },
      routes: [{ path: [] }],
    });
    expect(restore(c, room.capture()).save()).toBe(room.save());
  });
  it("runs both reusable B0 roles, freezes gathered damage, and restores live windups exactly", () => {
    const c = config({
        objects: [],
        player: { x: 1024, y: 1024, hp: 100 },
        enemies: [
          { id: "bruiser", role: "bruiser", x: 1536, y: 1024, hp: 100 },
          { id: "ranger", role: "ranger", x: 3072, y: 1024, hp: 100 },
        ],
      }),
      room = new DestructionEncounter(c);
    const winding = room.step(idle);
    expect(winding.enemies.map((e) => e.behavior!.state)).toEqual([
      "windup",
      "windup",
    ]);
    const other = restore(c, room.capture());
    for (let i = 0; i < 12; i++)
      expect(other.step(idle)).toEqual(room.step(idle));
    expect(room.observe().player.hp).toBeLessThan(100);
    expect(room.observe().enemies.every((e) => e.behavior!.attacks > 0)).toBe(
      true,
    );
  });
  it("resets fuses, damage, rewards, behavior, routes and velocity under the explicit room reset policy", () => {
    const c = config(),
      room = new DestructionEncounter(c),
      fresh = room.save();
    for (let i = 0; i < 7; i++) room.step(shoot);
    expect(room.observe().rewardTotal).toBe(3);
    room.reset();
    expect(room.save()).toBe(fresh);
    expect(room.observe()).toMatchObject({
      tick: 0,
      rewardTotal: 0,
      terrainRevision: 0,
      routes: [],
    });
  });
  it("uses the same L1 weapon range for cardinal and diagonal aim", () => {
    const c = config({
      width: 8192,
      height: 8192,
      objects: [],
      player: { x: 256, y: 256, hp: 100 },
      enemies: [{ id: "target", role: "bruiser", x: 3756, y: 3756, hp: 100 }],
    });
    const diagonal = new DestructionEncounter(c);
    expect(diagonal.step({ ...shoot, aimY: 1 }).enemies[0].hp).toBe(100);
    const near = new DestructionEncounter({
      ...c,
      enemies: [{ id: "target", role: "bruiser", x: 2256, y: 2256, hp: 2 }],
    });
    expect(near.step({ ...shoot, aimY: 1 }).status).toBe("cleared");
    const farCardinal = new DestructionEncounter({
      ...c,
      enemies: [{ id: "target", role: "bruiser", x: 4516, y: 256, hp: 100 }],
    });
    expect(farCardinal.step(shoot).enemies[0].hp).toBe(100);
  });
  it("includes a diagonal face at displacement2048 and excludes displacement2049", () => {
    const originX = 256 + 64;
    // The 1-unit ray box's right face starts at originX+1. These target
    // left faces therefore require exactly2048 and2049 units of displacement.
    const c = config({
      width: 8192,
      height: 8192,
      objects: [],
      player: { x: 256, y: 256, hp: 100 },
      enemies: [
        { id: "target", role: "ranger", x: originX + 1 + 2048, y: 2304, hp: 2 },
      ],
    });
    expect(new DestructionEncounter(c).step({ ...shoot, aimY: 1 }).status).toBe(
      "cleared",
    );
    const beyond = new DestructionEncounter({
      ...c,
      enemies: [{ ...c.enemies[0], x: originX + 1 + 2049 }],
    });
    expect(beyond.step({ ...shoot, aimY: 1 }).enemies[0].hp).toBe(2);
  });
  it("normalizes diagonal weapon, blast and enemy knockback to the cardinal L1 request budget", () => {
    const c = config({
      width: 8192,
      height: 8192,
      objects: [],
      player: { x: 256, y: 256, hp: 100 },
      enemies: [{ id: "target", role: "ranger", x: 1536, y: 1536, hp: 100 }],
    });
    const diagonal = new DestructionEncounter(c).step({ ...shoot, aimY: 1 });
    const v = diagonal.impulse.velocities.find((v) => v.targetId === "target")!;
    // An unresisted 256+256 request moves before 64-per-axis drag; previously
    // diagonal requests were 512+512 and doubled cardinal knockback.
    expect(v).toMatchObject({ x: 192, y: 192 });
    const cardinal = new DestructionEncounter({
      ...c,
      enemies: [{ ...c.enemies[0], y: 256 }],
    }).step(shoot);
    expect(
      cardinal.impulse.velocities.find((v) => v.targetId === "target"),
    ).toMatchObject({ x: 448, y: 0 });
    const blasted = new DestructionEncounter({
      ...c,
      player: { x: 256, y: 512, hp: 100 },
      objects: [
        object("barrel", {
          kind: "prop",
          rect: { x: 512, y: 512, width: 128, height: 128 },
          hp: 2,
          blast: { bands: [{ radius: 4096, damage: 4 }], friendlyFire: true },
        }),
      ],
    });
    blasted.step(shoot);
    expect(
      blasted
        .step(idle)
        .impulse.velocities.find((v) => v.targetId === "target"),
    ).toMatchObject({ x: 192, y: 192 });
    const struck = new DestructionEncounter({
      ...c,
      player: { x: 1280, y: 1280, hp: 100 },
      enemies: [{ id: "target", role: "bruiser", x: 1536, y: 1536, hp: 100 }],
    });
    struck.step(idle);
    struck.step(idle);
    expect(struck.step(idle).player).toMatchObject({
      x: 1216,
      y: 1216,
      hp: 97,
    });
  });
  it("treats actor coordinates as top-left boxes and admits touching but rejects overlapping spawns", () => {
    const c = config({ player: { x: 1408, y: 1024, hp: 100 } });
    expect(new DestructionEncounter(c).observe().player).toMatchObject({
      x: 1408,
      y: 1024,
      width: 128,
      height: 128,
    });
    expect(
      () =>
        new DestructionEncounter({ ...c, player: { ...c.player, x: 1409 } }),
    ).toThrow(/overlaps terrain/);
    expect(
      () =>
        new DestructionEncounter({
          ...c,
          player: { ...c.player, x: 4096 - 127 },
        }),
    ).toThrow();
    const touching = config({
      objects: [],
      player: { x: 256, y: 256, hp: 100 },
      enemies: [{ id: "target", role: "bruiser", x: 384, y: 256, hp: 100 }],
    });
    expect(() => new DestructionEncounter(touching)).not.toThrow();
    expect(
      () =>
        new DestructionEncounter({
          ...touching,
          enemies: [{ ...touching.enemies[0], x: 383 }],
        }),
    ).toThrow(/Overlapping action spawns/);
  });
  it("rejects forged origin state even when every local HP/reward/terrain field agrees", () => {
    const c = config(),
      room = new DestructionEncounter(c);
    room.step(idle);
    const before = room.save();
    const forged = clone(room.capture());
    forged.state.world.objects[0].hp = 0;
    forged.state.world.rewarded = ["breach"];
    forged.state.world.rewardTotal = 3;
    forged.state.world.terrainRevision = 1;
    forged.state.world.destroyed = ["breach"];
    forged.state.routeInvalidations = 1;
    forged.state.routes = [];
    expect(() => room.restore(forged)).toThrow(/not reachable/);
    expect(room.save()).toBe(before);
    const fakeClear = clone(room.capture());
    fakeClear.state.enemies[0].hp = 0;
    fakeClear.state.status = "cleared";
    expect(() => room.restore(fakeClear)).toThrow(/not reachable/);
    expect(room.save()).toBe(before);
    const fakeMove = clone(room.capture());
    fakeMove.state.player.x++;
    expect(() => room.restore(fakeMove)).toThrow(/not reachable/);
    expect(room.save()).toBe(before);
    const old = {
      format: "p2-action-encounter-v1",
      configuration: c,
      previous: room.capture().state,
      input: idle,
      state: room.capture().state,
    };
    expect(() => room.restore(old)).toThrow(/origin-verified v2 required/);
  });
  it("bounds and canonicalizes replay work before publication and preserves the last saveable state at quotas", () => {
    const c = config(),
      room = new DestructionEncounter(c);
    for (let i = 0; i < ACTION_ENCOUNTER_LIMITS.replayRuns; i++)
      room.step({ ...idle, aimX: i % 2 ? 1 : -1 });
    let before = room.save();
    expect(() => room.step({ ...idle, aimX: -1 })).toThrow(/replay quota/);
    expect(room.save()).toBe(before);
    // Extending the final run remains admissible at the run quota.
    for (
      let i = ACTION_ENCOUNTER_LIMITS.replayRuns;
      i < ACTION_ENCOUNTER_LIMITS.replayTicks;
      i++
    )
      room.step({ ...idle, aimX: 1 });
    before = room.save();
    expect(() => room.step({ ...idle, aimX: 1 })).toThrow(/replay quota/);
    expect(room.save()).toBe(before);
    const other = new DestructionEncounter(c);
    other.load(before);
    expect(other.save()).toBe(before);
    const forged = clone(room.capture());
    forged.replay[0] = {
      ...forged.replay[0],
      ticks: ACTION_ENCOUNTER_LIMITS.replayTicks,
    };
    expect(() => room.restore(forged)).toThrow(/tick quota/);
    expect(room.save()).toBe(before);
    const split = new DestructionEncounter(c);
    split.step(idle);
    split.step(idle);
    const noncanonical = clone(split.capture());
    noncanonical.replay = [
      { ticks: 1, input: idle },
      { ticks: 1, input: idle },
    ];
    expect(() => split.restore(noncanonical)).toThrow(
      /Noncanonical action replay/,
    );
    const negative = clone(split.capture());
    negative.replay[0] = { ...negative.replay[0], ticks: -0 };
    expect(() => split.restore(negative)).toThrow();
  });
  it("allows run-level checkpoint admission to reject atomically without replaying or exposing mutable state", () => {
    const c = config(),
      room = new DestructionEncounter(c),
      before = room.save();
    expect(() =>
      room.step(idle, () => {
        throw Error("run save cap");
      }),
    ).toThrow(/run save cap/);
    expect(room.save()).toBe(before);
    room.step(idle, (candidate) => {
      expect(candidate.state.tick).toBe(1);
      candidate.state.player.hp = 1;
      expect(() => room.step(idle)).toThrow(/admission in progress/);
      expect(() => room.reset()).toThrow(/admission in progress/);
      expect(() => room.restore(candidate)).toThrow(/admission in progress/);
    });
    expect(room.observe().player.hp).toBe(100);
    expect(room.observe().tick).toBe(1);
  });
  it("marks clear/death terminal and rejects further stepping atomically", () => {
    const winConfig = config({
        objects: [],
        enemies: [{ id: "target", role: "bruiser", x: 3072, y: 1024, hp: 2 }],
      }),
      win = new DestructionEncounter(winConfig);
    expect(win.step(shoot).status).toBe("cleared");
    const save = win.save();
    expect(() => win.step(idle)).toThrow(/terminal/);
    expect(win.save()).toBe(save);
    const loseConfig = config({
        objects: [],
        player: { x: 1024, y: 1024, hp: 1 },
        enemies: [{ id: "target", role: "bruiser", x: 1536, y: 1024, hp: 100 }],
      }),
      lose = new DestructionEncounter(loseConfig);
    for (let i = 0; i < 3; i++) lose.step(idle);
    expect(lose.observe().status).toBe("defeated");
    expect(restore(loseConfig, lose.capture()).save()).toBe(lose.save());
  });
  it("rejects inconsistent state and replay atomically, including once-only and route cross-fields", () => {
    const c = config(),
      room = new DestructionEncounter(c);
    for (let i = 0; i < 8; i++) room.step(shoot);
    const before = room.capture();
    const mutations: ((c: ActionEncounterCheckpoint) => void)[] = [
      (c) => {
        c.state.player.hp--;
      },
      (c) => {
        c.state.enemies[0].behavior = {
          ...c.state.enemies[0].behavior!,
          timer: c.state.enemies[0].behavior!.timer + 1,
        };
      },
      (c) => {
        c.state.world.rewardTotal++;
      },
      (c) => {
        c.state.world.terrainRevision++;
      },
      (c) => {
        c.state.world.objects[0].hp = 1;
      },
      (c) => {
        c.state.routes[0].path.pop();
      },
      (c) => {
        c.state.impulse.velocities[0].x++;
      },
      (c) => {
        c.state.tick++;
      },
      (c) => {
        c.state.world.objects[0].id = "missing";
      },
      (c) => {
        c.state.world.rewarded = [];
      },
      (c) => {
        c.state.world.rewardTotal++;
      },
      (c) => {
        c.state.world.pending.push({
          sourceId: "breach",
          readyTick: c.state.tick + 1,
        });
      },
      (c) => {
        c.state.impulse.pending.push({
          sourceId: "bogus",
          targetId: "hero",
          x: 1,
          y: 0,
        });
      },
      (c) => {
        c.state.enemies[0].behavior = {
          ...c.state.enemies[0].behavior!,
          role: "ranger",
        };
      },
      (c) => {
        c.state.world.terrainRevision = 0;
      },
      (c) => {
        c.state.routeInvalidations = 0;
      },
      (c) => {
        c.state.player.width = 129;
      },
      (c) => {
        c.configuration = {
          ...c.configuration,
          modifiers: [
            ...c.configuration.modifiers,
            { id: "extra", healthBonus: 1, damageBonus: 0 },
          ],
        };
      },
    ];
    for (const mutate of mutations) {
      const corrupt = clone(before);
      mutate(corrupt);
      expect(() => room.restore(corrupt)).toThrow();
      expect(room.capture()).toEqual(before);
    }
    expect(() => room.load(room.save() + " ")).toThrow();
    expect(room.capture()).toEqual(before);
  });
  it("preserves the selected maximum room capacity and bounded chained effects across restore", () => {
    const objects = Array.from({ length: 64 }, (_, i) =>
      object(`object-${String(i).padStart(2, "0")}`, {
        kind: i < 8 ? "prop" : "wall",
        rect:
          i < 8
            ? { x: 512 + i * 256, y: 256, width: 64, height: 128 }
            : {
                x: 512 + ((i - 8) % 14) * 512,
                y: 4096 + Math.floor((i - 8) / 14) * 512,
                width: 128,
                height: 128,
              },
        hp: i < 8 ? 2 : 4096,
        blast:
          i < 8
            ? { bands: [{ radius: 4096, damage: 4 }], friendlyFire: true }
            : null,
      }),
    );
    const c = config({
      width: 8192,
      height: 8192,
      player: { x: 256, y: 256, hp: 4096 },
      objects,
      enemies: Array.from({ length: 8 }, (_, i) => ({
        id: `enemy-${i}`,
        role: i % 2 ? "ranger" : "bruiser",
        x: 4096 + (i % 4) * 512,
        y: 512 + Math.floor(i / 4) * 512,
        hp: 4096,
      })),
      modifiers: Array.from({ length: 8 }, (_, i) => ({
        id: `modifier-${i}`,
        damageBonus: 64,
        healthBonus: 64,
      })),
    });
    const room = new DestructionEncounter(c);
    room.step(shoot);
    for (let tick = 0; tick < 10; tick++) {
      const other = restore(c, room.capture());
      const next = room.step(idle);
      expect(other.step(idle)).toEqual(next);
      expect(next.world.counters.candidates).toBeLessThanOrEqual(512);
      expect(next.world.receipts.length).toBeLessThanOrEqual(544);
      expect(next.impulse.pending).toEqual([]);
      expect(next.impulse.velocities.length).toBe(9);
      expect(next.routes.length).toBeLessThanOrEqual(8);
    }
    expect(room.observe().world.objects.filter((o) => o.detonated).length).toBe(
      8,
    );
    expect(room.save().length).toBeLessThan(
      ACTION_ENCOUNTER_LIMITS.checkpointCharacters,
    );
  });
  it("rejects hostile data without invoking accessors and validates capacities before mutation", () => {
    const room = new DestructionEncounter(config()),
      saved = room.save();
    let called = false;
    const getter = Object.defineProperty({}, "moveX", {
      enumerable: true,
      get() {
        called = true;
        return 0;
      },
    });
    for (const value of [
      getter,
      { ...idle, moveX: -0 },
      { ...idle, fire: 1 },
      { ...idle, extra: 1 },
      { ...idle, moveX: 2 },
    ])
      expect(() => room.step(value as ActionEncounterInput)).toThrow();
    expect(called).toBe(false);
    expect(room.save()).toBe(saved);
    expect(
      () =>
        new DestructionEncounter(
          config({
            enemies: Array.from({ length: 9 }, (_, i) => ({
              id: `enemy-${i}`,
              role: "bruiser",
              x: 3072,
              y: i * 256,
              hp: 2,
            })),
          }),
        ),
    ).toThrow();
    expect(ACTION_ENCOUNTER_LIMITS.enemies).toBe(8);
  });
});
