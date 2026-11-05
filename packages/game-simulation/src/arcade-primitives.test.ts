import { UnderworldController } from "../../../apps/audio-arcade/src/controller";
import { canonicalJson } from "./session-protocol";
import { ArenaSession } from "./arena-session";
import { underworldContent } from "../../../apps/audio-arcade/src/games/underworld/content";
import { describe, it, expect } from "vitest";
import { ProjectileOwnerV1 } from "./dynamic-projectiles";
import { DamageOwner } from "./damage-owner";
import { ProductionJobs } from "./production-jobs";
describe("arcade reusable owners", () => {
  it("hits a crossing moving target once with stable tie breaking", () => {
    const p = new ProjectileOwnerV1();
    p.spawn({
      id: "a",
      x: 0,
      y: 0,
      vx: 100,
      vy: 0,
      gravity: 0,
      radius: 1,
      life: 1,
      damage: 4,
      originX: 0,
    });
    const t = { x: 5, y: 5, nextX: 5, nextY: -5, radius: 1 };
    const hits = p.step(0.1, [
      { ...t, id: "z" },
      { ...t, id: "b" },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.targetId).toBe("b");
    expect(p.capture()).toHaveLength(0);
    expect(p.step(0.1, [])).toHaveLength(0);
  });
  it("reports destruction only on the living to destroyed edge", () => {
    const h = new DamageOwner([{ id: "house", hp: 8, maxHp: 10 }]);
    expect(h.damage("house", 8).destroyed).toBe(true);
    expect(h.damage("house", 8).destroyed).toBe(false);
    expect(h.repair("house", 10)).toBe(0);
  });
  it("keeps output on worker until storage accepts it", () => {
    const p = new ProductionJobs(
      { width: 3, height: 1, revision: 0, costs: [1, 1, 1] },
      0,
      [{ id: "worker", cell: 0 }],
      [
        {
          id: "fish",
          cell: 2,
          workSeconds: 0.1,
          resource: "food",
          quantity: 2,
          repeat: true,
          enabled: true,
        },
      ],
      0.1,
    );
    p.assign("worker", "fish");
    let delivered = 0;
    for (let i = 0; i < 10; i++) p.step(0.1, () => false);
    expect(p.workers[0]!.payload?.quantity).toBe(2);
    p.step(0.1, (_, n) => {
      delivered += n;
      return true;
    });
    expect(delivered).toBe(2);
    expect(p.workers[0]!.payload).toBeNull();
  });
});
it("does not sweep targets beyond projectile expiry and restores atomically", () => {
  const p = new ProjectileOwnerV1();
  const arrow = {
    id: "short",
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    gravity: 0,
    radius: 1,
    life: 0.01,
    damage: 1,
    originX: 0,
  };
  p.spawn(arrow);
  expect(
    p.step(0.1, [
      { id: "target", x: 10, y: 0, nextX: -10, nextY: 0, radius: 1 },
    ]),
  ).toHaveLength(0);
  p.spawn({ ...arrow, id: "kept", life: 1 });
  const saved = p.capture();
  expect(() => p.restore([{ ...arrow, radius: -1 }])).toThrow();
  expect(p.capture()).toEqual(saved);
  expect(() =>
    p.step(0.1, [{ id: "a", x: NaN, y: 0, nextX: 0, nextY: 0, radius: 1 }]),
  ).toThrow();
});
it("delivers existing cargo after a producer is disabled", () => {
  const p = new ProductionJobs(
    { width: 2, height: 1, revision: 0, costs: [1, 1] },
    0,
    [{ id: "w", cell: 1 }],
    [
      {
        id: "job",
        cell: 1,
        workSeconds: 0.1,
        resource: "food",
        quantity: 2,
        repeat: true,
        enabled: true,
      },
    ],
    0.1,
  );
  p.assign("w", "job");
  p.step(0.1, () => false);
  p.jobs[0]!.enabled = false;
  let delivered = 0;
  for (let i = 0; i < 4; i++)
    p.step(0.1, (_, n) => {
      delivered += n;
      return true;
    });
  expect(delivered).toBe(2);
  expect(p.workers[0]!.job).toBeNull();
  expect(p.workers[0]!.payload).toBeNull();
});
it("rejects invalid production identities and nonfinite timing", () => {
  const grid = { width: 1, height: 1, revision: 0, costs: [1] };
  const job = {
    id: "job",
    cell: 0,
    workSeconds: NaN,
    resource: "food",
    quantity: 2,
    repeat: true,
    enabled: true,
  };
  expect(
    () => new ProductionJobs(grid, 0, [{ id: "w", cell: 0 }], [job]),
  ).toThrow();
  expect(
    () =>
      new ProductionJobs(
        grid,
        0,
        [
          { id: "w", cell: 0 },
          { id: "w", cell: 0 },
        ],
        [],
      ),
  ).toThrow();
  expect(() => new ProductionJobs(grid, 0, [], [], NaN)).toThrow();
});

describe("Underworld action and encounter simulation", () => {
  const idle = { x: 0, y: 0, aimX: 10, aimY: 6, attack: false, attackHeld: false, attackReleased: false, special: false, dash: false, cast: false };
  function session() {
    const arena = new ArenaSession(underworldContent, 1);
    arena.command("start");
    arena.state.spawn = [];
    arena.state.enemies = [{ id: "dummy", definition: "runner", x: 15, y: 6, hp: 500, maxHp: 500, facing: Math.PI, cooldown: 0, hurt: 0, training: true }];
    return arena;
  }
  it("expires commands in unscaled time during hitstop and checkpoints pending input", () => {
    const arena = session();
    arena.state.nextId = 91;
    arena.state.player.action = { id: 90, elapsed: 0, timing: { tell: 1, active: 1, recover: 1, cancelAfter: 2 }, hits: [] };
    arena.step(0.01, { ...idle, special: true });
    expect(arena.state.commands?.map((c) => c.kind)).toEqual(["special"]);
    const saved = arena.snapshot();
    saved.scaleElapsed = -0.025;
    saved.scaleCooldown = 0.12;
    const restored = session();
    restored.restore(saved);
    for (let n = 0; n < 13; n++) restored.step(0.01, idle);
    expect(restored.state.commands).toEqual([]);
    arena.restore(saved);
    arena.step(0, { ...idle, cancelled: true });
    expect(arena.state.commands).toEqual([]);
    expect(arena.state.inputClock).toBe(saved.inputClock);
  });
  it("preserves dash direction and ends protection when dash strike activates", () => {
    const arena = session();
    arena.step(0.01, { ...idle, dash: true, x: 0, y: 1 });
    arena.step(0.01, { ...idle, attack: true });
    expect(arena.state.player.action?.moveId).toBe("dash-strike");
    expect(arena.state.player.action?.heading).toBeCloseTo(Math.PI / 2);
    expect(arena.state.player.invulnerable).toBeGreaterThan(0);
    arena.step(0.03, idle);
    expect(arena.state.player.invulnerable).toBe(0);
    expect(arena.state.dashTime).toBe(0);
    // A real hit after activation must retain its independent hurt protection.
    arena.state.player.invulnerable = 0.65;
    arena.state.player.hurtProtection = 0.65;
    arena.step(0.01, idle);
    expect(arena.state.player.invulnerable).toBeCloseTo(0.64);
  });
  it("clears on zero-time pause without spawning or resolving active contact", () => {
    const arena = new ArenaSession(underworldContent);
    arena.command("start");
    const before = arena.snapshot();
    arena.step(0, { ...idle, cancelled: true });
    const after = arena.snapshot();
    expect(after.enemies).toEqual(before.enemies);
    expect(after.spawn).toEqual(before.spawn);
    expect(after.nextId).toBe(before.nextId);
    expect(after.time).toBe(before.time);
    expect(arena.drainEvents()).toEqual([]);
  });
  it("chooses newest legal commands, resolves tied commands by priority and consumes once", () => {
    const arena = session();
    arena.step(0.01, { ...idle, attack: true, cast: true, special: true, dash: true });
    expect(arena.state.dash).toBe(1);
    expect(arena.state.player.action).toBeUndefined();
    expect(arena.state.commands?.map((c) => c.kind)).not.toContain("dash");
    arena.clearCommands();
    const checkpoint = arena.snapshot();
    const restored = session(); restored.restore(checkpoint);
    for (let i = 0; i < 10; i++) { arena.step(0.01, idle); restored.step(0.01, idle); }
    expect(restored.snapshot()).toEqual(arena.snapshot());
  });
  it("releases cast at its simulation marker and restores windup without duplicate projectiles", () => {
    const arena = session();
    arena.step(0.04, { ...idle, cast: true });
    expect(arena.state.player.action?.clipId).toBe("cast");
    expect(arena.state.projectiles).toHaveLength(0);
    const restored = session(); restored.restore(arena.snapshot());
    restored.step(0.04, idle);
    expect(restored.state.projectiles).toHaveLength(0);
    restored.step(0.03, idle);
    expect(restored.state.projectiles).toHaveLength(1);
    restored.step(0.02, idle);
    expect(restored.state.projectiles).toHaveLength(1);
    expect(restored.drainEvents().filter((event) => event.kind === "castRelease")).toHaveLength(1);
  });
  it("executes a buffered dash with its captured heading and does not queue a whole combo from one press", () => {
    const arena = session();
    arena.step(0.01, { ...idle, attack: true });
    arena.step(0.04, { ...idle, dash: true, x: 0, y: 1 });
    for (let i = 0; i < 12; i++) arena.step(0.01, { ...idle, x: 1, y: 0 });
    expect(arena.state.player.facing).toBeCloseTo(Math.PI / 2);
    arena.clearCommands();
    const single = session();
    single.step(0.01, { ...idle, attack: true });
    for (let i = 0; i < 100; i++) single.step(0.01, idle);
    expect(single.drainEvents().filter((event) => event.kind === "windup")).toHaveLength(1);
  });
  it("claims each action target once and reports a move-specific contact", () => {
    const arena = session();
    const enemy = arena.state.enemies[0]!;
    enemy.x = 4.5;
    arena.step(0.05, { ...idle, attack: true });
    arena.step(0.03, idle);
    const hp = enemy.hp;
    expect(hp).toBeLessThan(500);
    for (let n = 0; n < 6; n++) arena.step(0.01, idle);
    expect(enemy.hp).toBe(hp);
    expect(arena.drainEvents().some((e) => e.payload?.moveId === "sword1" && e.payload.targetId === "dummy" && e.payload.damage! > 0)).toBe(true);
    expect(underworldContent.weapons[0]!.moves!.map((m) => m.hitShape.kind)).toEqual(["capsule", "sector", "sector", "capsule", "capsule", "radial"]);
  });
  it("claims one spike hit per actor each cycle and demonstrates a nonrecursive cast echo", () => {
    const arena = session();
    const enemy = arena.state.enemies[0]!;
    const trap = arena.room.trap!;
    enemy.x = trap.x; enemy.y = trap.y;
    arena.state.trap = { elapsed: 0.59, cycle: 0, phase: "warning", hits: [] };
    arena.step(0.02, idle);
    const hp = enemy.hp;
    arena.step(0.04, idle);
    expect(enemy.hp).toBe(hp);
    expect(arena.state.trap!.hits).toContain(enemy.id);
    arena.state.boons = ["echo-cast"];
    arena.state.player.x = 3; arena.state.player.y = 6;
    enemy.x = 5; enemy.y = 6; enemy.invulnerable = 0;
    arena.step(0.01, { ...idle, cast: true });
    for (let i = 0; i < 100; i++) arena.step(0.01, idle);
    expect(arena.drainEvents().filter((event) => event.kind === "echoCast")).toHaveLength(1);
    expect(arena.state.echoes).toEqual([]);
  });
  it("breaks the shield once with special and keeps front blocks explicit", () => {
    const arena = session();
    const enemy = arena.state.enemies[0]!;
    enemy.definition = "guard"; enemy.x = 4.5; enemy.y = 6;
    arena.step(0.05, { ...idle, attack: true });
    arena.step(0.03, idle);
    expect(enemy.hp).toBe(500);
    expect(arena.drainEvents().some((event) => event.payload?.outcome === "blocked")).toBe(true);
    for (let i = 0; i < 30; i++) arena.step(0.01, idle);
    arena.step(0.01, { ...idle, special: true });
    for (let i = 0; i < 80; i++) arena.step(0.01, idle);
    expect(enemy.shieldBroken).toBe(true);
    expect(arena.drainEvents().filter((event) => event.kind === "shieldBreak")).toHaveLength(1);
  });
  it("offers two behavior boons, opens the physical exit and keeps a demonstration target", () => {
    const arena = session();
    arena.state.wave = 1;
    arena.state.enemies = [];
    arena.step(0.01, idle);
    expect(arena.state.phase).toBe("upgrade");
    expect(arena.state.offered).toEqual(["ember-wake", "echo-cast"]);
    arena.command("boon:ember-wake");
    expect(arena.state.exitOpen).toBe(true);
    expect(arena.state.enemies.some((e) => e.training)).toBe(true);
    const dummy = arena.state.enemies.find((e) => e.training)!;
    expect(dummy.cooldown).toBe(0);
    expect(() => canonicalJson(arena.snapshot())).not.toThrow();
    const position = { x: dummy.x, y: dummy.y };
    arena.step(0.01, idle);
    expect({ x: dummy.x, y: dummy.y }).toEqual(position);
    expect(dummy.cooldown).toBe(0);
    expect(dummy.action).toBeUndefined();
    arena.step(0.01, { ...idle, dash: true });
    expect(arena.state.trails?.length).toBeGreaterThan(0);
    arena.state.player.x = arena.room.rewardExit!.x;
    arena.state.player.y = arena.room.rewardExit!.y;
    arena.state.dashTime = 0;
    arena.step(0.01, idle);
    expect(arena.state.phase).toBe("won");
    expect(arena.state.boons).toContain("ember-wake");
  });
});

it.each(["ember-wake", "echo-cast"])("completes the encounter and demonstrates %s through ordinary input", (boon) => {
  const arena = new ArenaSession(underworldContent, 1);
  const idle = { x: 0, y: 0, aimX: 10, aimY: 6, attack: false, attackHeld: false, attackReleased: false, special: false, dash: false, cast: false };
  arena.command("start");
  let rewardAt = 0;
  for (let tick = 0; tick < 7200 && arena.state.phase !== "won" && arena.state.phase !== "lost"; tick++) {
    const s = arena.state, p = s.player;
    if (s.phase === "upgrade") { rewardAt = tick / 60; arena.command(`boon:${boon}`); }
    const target = s.enemies.filter((e) => e.hp > 0).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
    const point = s.exitOpen && tick / 60 > rewardAt + 4 ? arena.room.rewardExit! : target ?? { x: 13, y: 6 };
    const distance = Math.hypot(point.x - p.x, point.y - p.y);
    const move = distance > (s.exitOpen && point === arena.room.rewardExit ? 0.2 : 1.3);
    arena.step(1 / 60, { ...idle, x: move ? (point.x - p.x) / Math.max(distance, 0.01) : 0, y: move ? (point.y - p.y) / Math.max(distance, 0.01) : 0, aimX: point.x, aimY: point.y, attackHeld: !s.exitOpen, special: tick % 54 === 0, cast: tick % 181 === 0, dash: !!s.exitOpen && tick % 91 === 0 });
  }
  console.log(`encounter ${boon}: reward ${rewardAt.toFixed(2)}s, phase ${arena.state.phase}, simulation ${arena.state.time.toFixed(2)}s, hp ${arena.state.player.hp}`);
  expect(arena.state.phase).toBe("won");
  expect(arena.state.boons).toContain(boon);
});


describe("Underworld standard controller translation", () => {
  function pad(axes = [0, 0, 0, 0], pressed: number[] = []) {
    return { index: 0, connected: true, mapping: "standard", axes, buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), touched: false, value: pressed.includes(i) ? 1 : 0 })) } as unknown as Gamepad;
  }
  it("maps analog movement and aim, attack hold and one-shot action edges", () => {
    const controller = new UnderworldController();
    controller.poll([pad()]);
    const input = controller.poll([pad([1, 0, 0, -1], [0, 1, 2, 3, 9])])!;
    expect(input).toMatchObject({ x: 1, y: 0, aimX: 0, aimY: -1, attack: true, attackHeld: true, dash: true, special: true, cast: true, pause: true });
    expect(controller.poll([pad([1, 0, 0, -1], [0, 1, 2, 3, 9])])).toMatchObject({ attack: false, attackHeld: true, dash: false, special: false, cast: false, pause: false });
    expect(controller.poll([pad()])!.attackReleased).toBe(true);
    expect(controller.poll([pad([0.1, 0.1, 0.1, 0.1])])).toMatchObject({ x: 0, y: 0, aimX: 0, aimY: 0 });
  });
  it("requires neutral after pause/disconnect and ignores nonstandard pads", () => {
    const controller = new UnderworldController();
    controller.poll([pad()]);
    controller.poll([pad([], [0])]);
    controller.clear();
    expect(controller.poll([pad([], [0])])).toBeUndefined();
    controller.poll([pad()]);
    expect(controller.poll([pad([], [0])])!.attack).toBe(true);
    expect(controller.poll([])!.disconnected).toBe(true);
    expect(controller.poll([pad([], [1])])).toBeUndefined();
    controller.poll([pad()]);
    expect(controller.poll([{ ...pad(), mapping: "" }])!.disconnected).toBe(true);
  });
});
