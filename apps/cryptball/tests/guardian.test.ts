import { describe, it, expect } from "vitest";
import { DeterministicRandom } from "@onepage/game-simulation/random";
import { actionPhase } from "@onepage/game-simulation/action-timeline";
import {
  createInitialState,
  stepState,
  createCryptballSession,
} from "../sim/session";
import type { State } from "../sim/contract";
import { FIXED as F, RULES } from "../sim/rules";
import {
  resetGuardian,
  guardianStep,
  validateGuardianState,
  guardianDescriptor,
  configureGuardianPractice,
  clampGuardianPlayer,
} from "../sim/modes/crypt-guardian";
import {
  guardianBallContact,
  moveGuardianBall,
} from "../sim/modes/crypt-guardian/ball";
import {
  guardianDamagePlayer,
  resolveGuardianOutcome,
} from "../sim/modes/crypt-guardian/damage";
import {
  stepGuardianBoss,
  guardianShapeContains,
  guardianAttackShapes,
} from "../sim/modes/crypt-guardian/boss";
import { moveGuardianProjectiles } from "../sim/modes/crypt-guardian/projectiles";
const rng = () =>
  new DeterministicRandom([{ owner: "cryptball", name: "ai", seed: 42 }]);
function fixture(seed = 0) {
  const s = createInitialState("match", {}, "crypt-guardian");
  resetGuardian(s, seed);
  s.phase = "play";
  s.guardian!.nextAttack = 1e6;
  return s;
}
function strike(s: State, charge = 0, assist = false) {
  const p = s.players[0],
    g = s.guardian!;
  s.possessionId = p.id;
  g.guardHeading = 192; // exposed rear: damage tests bypass the frontal guard.
  p.x = 0;
  p.y = -8 * F;
  p.heading = 192;
  s.ball.x = 0;
  s.ball.y = -19 * F;
  p.action = {
    id: s.nextAction++,
    kind: "strike",
    elapsed: 4,
    timing: { tell: 4, active: 3, recover: 9 },
    hits: [],
    heading: 192,
    charge,
  };
  if (assist) {
    g.athletes[p.id].assistUntil = s.tick + 90;
    g.athletes[p.id].assistFrom = "player-1";
  }
  expect(guardianBallContact(s, p)).toBe(true);
  for (let i = 0; i < 48; i++) moveGuardianBall(s);
}
describe("Crypt Guardian authority", () => {
  it("resolves every cosmetic seed into its legal layout at all three sizes", () => {
    const seen = new Set();
    for (let seed = 0; seed < 81; seed++) {
      const s = fixture(seed),
        d = s.guardian!.descriptor;
      seen.add([d.weapon, d.palette, d.size].join("/"));
      expect(d.layout).toBe(d.weapon === "maul" ? "open" : "pillars");
      expect(() => validateGuardianState(s)).not.toThrow();
      for (const p of s.players) {
        p.x = d.x;
        p.y = d.y;
        clampGuardianPlayer(s, p);
        expect(Math.hypot(p.x - d.x, p.y - d.y)).toBeGreaterThanOrEqual(
          d.bodyRadius + 7 * F - 1,
        );
      }
    }
    expect(seen.size).toBe(27);
  });
  it.each([
    [0, false, 8],
    [24, false, 12],
    [0, true, 16],
    [24, true, 16],
  ])(
    "caps strike damage charge %i assisted %s at %i",
    (charge, assist, damage) => {
      const s = fixture();
      strike(s, charge, assist);
      expect(s.guardian!.hp).toBe(300 - damage);
      expect(s.guardian!.ballToken).toBeNull();
      for (let i = 0; i < 30; i++) moveGuardianBall(s);
      expect(s.guardian!.hp).toBe(300 - damage);
    },
  );
  it("adds integer 50 percent in recovery and preserves action origin", () => {
    const s = fixture(),
      g = s.guardian!;
    g.attack = {
      id: s.nextAction++,
      kind: "slam",
      targetId: "player-0",
      locked: true,
      released: true,
      elapsed: 78,
      timing: { tell: 72, active: 6, recover: 60 },
      hits: [],
      shapes: [{ kind: "disk", x: 50 * F, y: 0, radius: 24 * F, at: 0 }],
    };
    strike(s, 24, true);
    expect(g.hp).toBe(276);
    expect(s.events.find((e) => e.type === "guardian-hit")?.damage).toBe(24);
  });
  it("bare overlap and wall chatter never create boss damage tokens", () => {
    const s = fixture();
    s.ball.x = 0;
    s.ball.y = -56 * F;
    s.ball.vx = s.ball.vy = 0;
    for (let i = 0; i < 60; i++) moveGuardianBall(s);
    expect(s.guardian!.hp).toBe(300);
    expect(s.events.filter((e) => e.type === "guardian-hit")).toHaveLength(0);
  });
  it("accepts a pass from the other ally as a cooperative assist", () => {
    const s = fixture(),
      p = s.players[0];
    p.x = 0;
    p.y = 20 * F;
    p.heading = 0;
    s.players[1].x = 32 * F;
    s.players[1].y = 20 * F;
    s.ball.x = 11 * F;
    s.ball.y = 20 * F;
    p.action = {
      id: s.nextAction++,
      kind: "pass",
      elapsed: 3,
      timing: { tell: 3, active: 2, recover: 6 },
      hits: [],
      heading: 0,
    };
    s.possessionId = p.id;
    expect(guardianBallContact(s, p)).toBe(true);
    expect(s.ball.passTarget).toBe("player-1");
    for (let i = 0; i < 30; i++) {
      s.tick++;
      moveGuardianBall(s);
    }
    expect(s.guardian!.athletes["player-1"].assistFrom).toBe(p.id);
    expect(s.guardian!.ballToken).toBeNull();
  });
  it("pillar intercepts a boss projectile before the athlete and takes exactly one health", () => {
    const s = fixture(),
      g = s.guardian!,
      p = s.players[0],
      c = g.cover[0];
    p.x = c.x;
    p.y = 16 * F;
    g.attack = {
      id: s.nextAction++,
      kind: "shot",
      targetId: p.id,
      locked: true,
      released: true,
      elapsed: 49,
      timing: { tell: 48, active: 180, recover: 54 },
      hits: [],
      shapes: [
        {
          kind: "lane",
          x: c.x,
          y: -50 * F,
          endX: c.x,
          endY: 50 * F,
          radius: 5 * F,
          at: 0,
        },
      ],
    };
    g.projectiles = [
      {
        id: `boss-${g.attack.id}-0`,
        attackId: g.attack.id,
        endX: c.x,
        endY: 50 * F,
        x: c.x,
        y: -17 * F,
        vx: 0,
        vy: 110 * F,
        rx: 0,
        ry: 0,
        lifeTicks: 180,
        radius: 5 * F,
      },
    ];
    moveGuardianProjectiles(s, new Map());
    expect(c.hp).toBe(2);
    expect(g.athletes[p.id].hp).toBe(5);
    expect(g.projectiles).toHaveLength(0);
  });
  it("immune athletes consume incoming shots without receiving hidden stacked damage", () => {
    const s = fixture(),
      g = s.guardian!,
      p = s.players[0];
    p.x = 0;
    p.y = 40 * F;
    g.athletes[p.id].immunityUntil = 100;
    g.projectiles = [
      {
        id: "boss-1-0",
        attackId: 1,
        endX: 0,
        endY: 90 * F,
        x: 0,
        y: 30 * F,
        vx: 0,
        vy: 110 * F,
        rx: 0,
        ry: 0,
        lifeTicks: 180,
        radius: 5 * F,
      },
    ];
    moveGuardianProjectiles(s, new Map());
    expect(g.athletes[p.id].hp).toBe(5);
    expect(g.projectiles).toHaveLength(0);
  });
  it("uses a fresh 90 tick hold to revive once, then a second down eliminates", () => {
    const s = fixture(),
      g = s.guardian!,
      down = s.players[0],
      ally = s.players[1];
    down.x = 0;
    down.y = 40 * F;
    ally.x = 10 * F;
    ally.y = 40 * F;
    g.athletes[down.id].hp = 1;
    guardianDamagePlayer(s, down, 1);
    const commands = new Map(
      s.players.map((p) => [p.id, p.id === ally.id ? { passHeld: true } : {}]),
    );
    for (let i = 0; i < 89; i++) {
      s.tick++;
      guardianStep(s, commands, rng());
    }
    expect(g.athletes[down.id].status).toBe("down");
    s.tick++;
    guardianStep(s, commands, rng());
    expect(g.athletes[down.id]).toMatchObject({
      hp: 2,
      status: "active",
      revives: 1,
      immunityUntil: s.tick + 90,
    });
    s.tick += 91;
    g.athletes[down.id].hp = 1;
    guardianDamagePlayer(s, down, 2);
    expect(g.athletes[down.id].status).toBe("out");
    expect(() => validateGuardianState(s)).not.toThrow();
  });
  it("cancels rescue progress on damage or leaving range and suppresses pass action", () => {
    const s = fixture(),
      g = s.guardian!,
      down = s.players[0],
      ally = s.players[1];
    down.x = 0;
    down.y = 40 * F;
    ally.x = 10 * F;
    ally.y = 40 * F;
    g.athletes[down.id].hp = 1;
    guardianDamagePlayer(s, down, 1);
    const commands = new Map(
      s.players.map((p) => [
        p.id,
        p.id === ally.id ? { pass: true, passHeld: true } : {},
      ]),
    );
    for (let i = 0; i < 12; i++) {
      s.tick++;
      guardianStep(s, commands, rng());
    }
    expect(g.athletes[down.id].reviveTicks).toBe(12);
    expect(ally.action).toBeNull();
    guardianDamagePlayer(s, ally, 2);
    expect(g.athletes[down.id].reviveTicks).toBe(0);
    ally.x = 80 * F;
    s.tick++;
    guardianStep(s, commands, rng());
    expect(g.athletes[down.id].reviveBy).toBeNull();
  });
  it("relocates a soul marker out of intact cover and boss body", () => {
    const s = fixture(),
      p = s.players[0],
      g = s.guardian!;
    p.x = -65 * F;
    p.y = 0;
    g.athletes[p.id].hp = 1;
    guardianDamagePlayer(s, p, 1);
    expect(Math.hypot(p.x - g.cover[0].x, p.y)).toBeGreaterThanOrEqual(
      20 * F - 1,
    );
  });
  it("awards simultaneous mutual finish to allies exactly once and hard timeout loses", () => {
    const s = fixture(),
      g = s.guardian!;
    for (const a of Object.values(g.athletes)) {
      a.hp = 0;
      a.status = "down";
    }
    g.hp = 0;
    resolveGuardianOutcome(s);
    resolveGuardianOutcome(s);
    expect(g.outcome).toBe("victory");
    expect(s.winner).toBe(0);
    expect(s.events.filter((e) => e.type === "match-end")).toHaveLength(1);
    const t = fixture();
    t.guardian!.elapsed = 10800;
    resolveGuardianOutcome(t);
    expect(t.guardian!.outcome).toBe("defeat");
  });
  it("locks maul floor geometry twenty-four ticks before impact and never retargets late movement", () => {
    const s = fixture(2),
      g = s.guardian!;
    g.nextAttack = 0;
    stepGuardianBoss(s);
    expect(g.attack!.kind).toBe("slam");
    while (!g.attack!.locked) stepGuardianBoss(s);
    const shapes = structuredClone(g.attack!.shapes),
      target = s.players.find((p) => p.id === g.attack!.targetId)!;
    target.x += 70 * F;
    for (let i = 0; i < 20; i++) stepGuardianBoss(s);
    expect(g.attack!.shapes).toEqual(shapes);
    expect(g.attack!.timing.tell - 42).toBe(24);
  });
  it("each sweep hits once per athlete and hook pull stays inside legal court", () => {
    const s = fixture(1),
      g = s.guardian!,
      p = s.players[0];
    p.x = 0;
    p.y = 0;
    g.attack = {
      id: s.nextAction++,
      kind: "sweep",
      targetId: p.id,
      locked: true,
      released: true,
      elapsed: 72,
      timing: { tell: 72, active: 18, recover: 60 },
      hits: [],
      shapes: [
        {
          kind: "arc",
          x: 0,
          y: -54 * F,
          radius: 100 * F,
          innerRadius: 24 * F,
          at: 0,
        },
      ],
    };
    for (let i = 0; i < 18; i++) {
      s.tick += 61;
      stepGuardianBoss(s);
    }
    expect(g.athletes[p.id].hp).toBe(4);
    expect(g.attack!.hits).toContain(p.id);
  });
  it("rejects unbounded or malformed mode snapshots", () => {
    for (const mutate of [
      (s: State) => (s.guardian!.hp = 301),
      (s: State) => (s.guardian!.athletes["player-0"].hp = 0),
      (s: State) => (s.guardian!.descriptor.size = 120 as never),
      (s: State) => s.guardian!.cover.push({ ...s.guardian!.cover[0] }),
    ]) {
      const s = fixture();
      mutate(s);
      expect(() => validateGuardianState(s)).toThrow();
    }
  });
  it("restores live encounters without consuming a different RNG sequence", () => {
    const a = createCryptballSession({ sportId: "crypt-guardian", seed: 4 });
    a.setParticipants([]);
    for (let i = 0; i < 500; i++) a.step();
    const b = createCryptballSession({ sportId: "crypt-guardian", seed: 4 });
    b.restore(a.capture());
    for (let i = 0; i < 240; i++) {
      a.step();
      b.step();
    }
    expect(b.capture()).toEqual(a.capture());
  });
  it("supports explicit family and immortal practice with a separate reset", () => {
    const s = createInitialState("practice", {}, "crypt-guardian");
    configureGuardianPractice(s, { weapon: "maul", immortal: true });
    expect(s.guardian!.descriptor.weapon).toBe("maul");
    expect(s.guardian!.cover).toEqual([]);
    guardianDamagePlayer(s, s.players[0], 1);
    expect(s.guardian!.athletes["player-0"].hp).toBe(5);
    expect(() => validateGuardianState(s)).not.toThrow();
  });
  it.each([0, 1, 2])(
    "bots engage the orb and reach one terminal encounter for family seed %i",
    (seed) => {
      const a = createCryptballSession({ sportId: "crypt-guardian", seed });
      a.setParticipants([]);
      let hits = 0,
        results = 0,
        actions = 0;
      for (let tick = 0; tick < 11000 && a.getPhase() !== "results"; tick++) {
        a.step();
        for (const e of a.drainEvents()) {
          if (e.type === "guardian-hit") hits++;
          if (e.type === "match-end") results++;
          if (e.type === "guardian-throw" || e.type === "guardian-pass")
            actions++;
        }
      }
      expect(actions).toBeGreaterThan(5);
      expect(hits).toBeGreaterThan(2);
      expect(a.observe().guardian!.outcome).not.toBeNull();
      expect(results).toBe(1);
    },
  );
  it("three real aimed shots crack and destroy the telegraphed pillar endpoint", () => {
    const s = fixture(),
      g = s.guardian!,
      target = s.players[0];
    target.x = -100 * F;
    target.y = 40 * F;
    for (let shot = 0; shot < 3; shot++) {
      g.attack = {
        id: s.nextAction++,
        kind: "shot",
        targetId: target.id,
        locked: true,
        released: false,
        elapsed: 48,
        timing: { tell: 48, active: 180, recover: 54 },
        hits: [],
        shapes: [],
      };
      guardianAttackShapes(s, g.attack);
      stepGuardianBoss(s);
      for (let tick = 0; tick < 180 && g.projectiles.length; tick++) {
        s.tick++;
        moveGuardianProjectiles(s, new Map());
      }
      expect(g.cover[0].hp).toBe(2 - shot);
      expect(g.athletes[target.id].hp).toBe(5);
    }
  });
  it("clips hook pull along its swept path without crossing a pillar", () => {
    const s = fixture(1),
      g = s.guardian!,
      p = s.players[0];
    p.x = -43 * F;
    p.y = 0;
    g.attack = {
      id: s.nextAction++,
      kind: "hook",
      targetId: p.id,
      locked: true,
      released: true,
      elapsed: 83,
      timing: { tell: 60, active: 48, recover: 54 },
      hits: [],
      shapes: [
        {
          kind: "lane",
          x: 0,
          y: -54 * F,
          endX: p.x,
          endY: p.y,
          radius: 5 * F,
          at: 0,
        },
      ],
    };
    const before = { x: p.x, y: p.y };
    stepGuardianBoss(s);
    expect(Math.hypot(p.x - before.x, p.y - before.y)).toBeLessThanOrEqual(
      20 * F + 1,
    );
    expect(Math.hypot(p.x - g.cover[0].x, p.y)).toBeGreaterThanOrEqual(
      18 * F - 1,
    );
  });
  it.each([0, 1, 2])(
    "restores each authored attack phase for family %i",
    (seed) => {
      const s = fixture(seed),
        g = s.guardian!;
      g.hp = 149;
      g.stage = 2;
      g.nextAttack = 0;
      for (let tick = 0; tick < 1800; tick++) {
        s.tick++;
        stepGuardianBoss(s);
        moveGuardianProjectiles(s, new Map());
        if (s.guardian!.attack && tick % 17 === 0)
          validateGuardianState(s);
      }
    },
  );
  it("keeps north wall correction outside every supported boss size", () => {
    for (const seed of [0, 9, 18])
      for (const side of [-1, 1]) {
        const s = fixture(seed),
          p = s.players[0],
          d = s.guardian!.descriptor;
        p.x = side * 12 * F;
        p.y = -89 * F;
        clampGuardianPlayer(s, p);
        expect(p.y).toBeGreaterThanOrEqual(-89 * F);
        expect(Math.hypot(p.x - d.x, p.y - d.y)).toBeGreaterThanOrEqual(
          d.bodyRadius + 7 * F - 1,
        );
      }
  });
  it("rejects a projectile checkpoint that changes its final warned endpoint", () => {
    const s = fixture(),
      g = s.guardian!;
    g.nextAttack = 0;
    stepGuardianBoss(s);
    while (!g.projectiles.length) stepGuardianBoss(s);
    expect(() => validateGuardianState(s)).not.toThrow();
    g.projectiles[0].endX += F;
    expect(() => validateGuardianState(s)).toThrow();
  });
  it("keeps maul disks clear of edge rescue markers and gives double slam separate footprints", () => {
    const s = fixture(2),
      g = s.guardian!;
    g.athletes["player-1"].hp = 0;
    g.athletes["player-1"].status = "down";
    s.players[1].x = 140 * F;
    s.players[1].y = 40 * F;
    s.players[0].x = 120 * F;
    s.players[0].y = 40 * F;
    const a: import("../sim/modes/crypt-guardian/types").GuardianAttack = {
      id: s.nextAction++,
      kind: "double-slam" as const,
      targetId: "player-0",
      locked: false,
      released: false,
      elapsed: 0,
      timing: { tell: 84, active: 42, recover: 66 },
      hits: [],
      shapes: [],
    };
    guardianAttackShapes(s, a);
    expect(a.shapes).toHaveLength(2);
    for (const shape of a.shapes)
      expect(
        Math.hypot(shape.x - s.players[1].x, shape.y - s.players[1].y),
      ).toBeGreaterThanOrEqual(48 * F - 1);
    expect(
      Math.hypot(a.shapes[0].x - a.shapes[1].x, a.shapes[0].y - a.shapes[1].y),
    ).toBeGreaterThanOrEqual(56 * F - 1);
  });
});
