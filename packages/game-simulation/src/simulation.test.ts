import { describe, expect, it } from "vitest";
import rawContent from "../../../examples/game-m1/definitions.json";
import { UNIT, validateDefinitions } from "../../game-project/src/index";
import type {
  Action,
  GameDefinitions,
  InputFrame,
} from "../../game-project/src/runtime";
import { body, candidates, makeIndex, moveActor } from "./collision";
import {
  cancelFrame,
  createInputDecoder,
  decodeInputRecords,
  neutralHeld,
} from "./input";
import { createWorld, observe, step } from "./simulation";
import {
  firstDifference,
  restoreCheckpoint,
  serializeCheckpoint,
} from "./checkpoint";
import { runReplayFixture } from "./replay";
import type { World } from "./types";
const identity = {
  rulesBuildId: "rules-test-actual-bytes",
  contentId: "content-test-actual-bytes",
};
function definitions(edit?: (raw: typeof rawContent) => void): GameDefinitions {
  const raw = JSON.parse(JSON.stringify(rawContent)) as typeof rawContent;
  edit?.(raw);
  return validateDefinitions(raw);
}
function world(): World {
  return createWorld(
    definitions((raw) => {
      raw.archetypes[1].ai = "none";
    }),
    identity,
  );
}
function press(w: World, action: Action): InputFrame {
  const frame = cancelFrame(w.decoder);
  frame.slots[0].held[action] = true;
  frame.slots[0].edges.push({ action, kind: "pressed" });
  return frame;
}
function placeOnPlatform(w: World): void {
  const a = w.actors[0],
    p = w.platforms[0];
  a.x = p.x + 24 * UNIT;
  a.y = p.y;
  a.vx = 0;
  a.vy = 0;
  moveActor(w, a, 0, 0);
}

describe("integer indexed collision and controller", () => {
  it("resolves a fractional position to an exact wall and floor boundary X then Y", () => {
    const w = world(),
      a = w.actors[0];
    a.x = 265 * UNIT + 17;
    a.y = 150 * UNIT;
    moveActor(w, a, 640, 4000);
    expect(a.x).toBe(266 * UNIT);
    expect(a.y).toBe(160 * UNIT);
    expect(a.grounded).toBe(true);
  });
  it("queries only swept cells and deduplicates rectangle buckets in stable order", () => {
    const w = world();
    expect(candidates(w, { x: 0, y: 0, width: UNIT, height: UNIT })).toEqual(
      [],
    );
    const contacts = candidates(w, {
      x: 260 * UNIT,
      y: 140 * UNIT,
      width: 64 * UNIT,
      height: 32 * UNIT,
    });
    expect(contacts.filter((x) => x.id === "rect:low-step")).toHaveLength(1);
    expect(contacts.map((x) => x.id)).toEqual(contacts.map((x) => x.id).sort());
  });
  it("one-way permits ascent, catches a downward crossing, and ignores exact side edges", () => {
    const w = world(),
      a = w.actors[0];
    a.x = 120 * UNIT;
    a.y = 130 * UNIT;
    moveActor(w, a, 0, -20 * UNIT);
    expect(a.y).toBe(110 * UNIT);
    a.y = 111 * UNIT;
    moveActor(w, a, 0, 3 * UNIT);
    expect(a.y).toBe(112 * UNIT);
    expect(a.grounded).toBe(true);
    a.x = 106 * UNIT;
    a.y = 111 * UNIT;
    moveActor(w, a, 0, 3 * UNIT);
    expect(a.y).toBe(114 * UNIT);
    expect(a.grounded).toBe(false);
  });
  it("retains a grounded contact across tile seams", () => {
    const w = world(),
      a = w.actors[0];
    for (let i = 0; i < 30; i++) {
      moveActor(w, a, 133, 96);
      expect(a.y).toBe(160 * UNIT);
      expect(a.grounded).toBe(true);
    }
  });
  it("uses content coyote boundary and consumes the jump once", () => {
    const w = world(),
      a = w.actors[0];
    a.x = 32 * UNIT;
    a.y = 100 * UNIT;
    a.grounded = false;
    a.coyoteTicks = 1;
    step(w, press(w, "jump"));
    expect(a.vy).toBeLessThan(0);
    expect(a.coyoteTicks).toBe(0);
    expect(a.jumpBuffer).toBe(0);
    const late = world();
    late.actors[0].y = 100 * UNIT;
    late.actors[0].grounded = false;
    late.actors[0].coyoteTicks = 0;
    step(late, press(late, "jump"));
    expect(late.actors[0].vy).toBeGreaterThan(0);
  });
  it("buffers a jump before landing and jumps on the following tick", () => {
    const w = world(),
      a = w.actors[0];
    a.y = 159 * UNIT;
    a.vy = 512;
    a.grounded = false;
    step(w, press(w, "jump"));
    expect(a.grounded).toBe(true);
    expect(a.jumpBuffer).toBe(5);
    step(w);
    expect(a.vy).toBeLessThan(0);
    expect(a.grounded).toBe(false);
  });
  it("opposing digital directions resolve neutral and quantized axis deadzone is 16", () => {
    const w = world(),
      x = w.actors[0].x;
    const f = press(w, "left");
    f.slots[0].held.right = true;
    f.slots[0].edges.push({ action: "right", kind: "pressed" });
    f.slots[0].axes.moveX = 127;
    step(w, f);
    expect(w.actors[0].x).toBe(x);
    step(w, cancelFrame(w.decoder));
    const g = cancelFrame(w.decoder);
    g.slots[0].axes.moveX = 16;
    step(w, g);
    expect(w.actors[0].x).toBe(x);
    g.slots[0].axes.moveX = 17;
    step(w, g);
    expect(w.actors[0].x).toBeGreaterThan(x);
  });
  it("carries a rider, dismounts on jump, and resumes its path", () => {
    const w = world();
    placeOnPlatform(w);
    const a = w.actors[0],
      x = a.x,
      p = w.platforms[0];
    step(w);
    expect(a.x).toBe(x + UNIT);
    expect(a.riderId).toBe(p.id);
    step(w, press(w, "jump"));
    expect(a.riderId).toBeNull();
    expect(a.y).toBeLessThan(p.y);
    const px = p.x;
    step(w);
    expect(p.x).toBe(px + UNIT);
  });
  it("blocks and retries a platform carry crossing a one-unit solid wall without advancing phase", () => {
    const w = world();
    placeOnPlatform(w);
    const a = w.actors[0],
      p = w.platforms[0],
      oldX = p.x,
      oldActor = a.x;
    const rect = {
      id: "thin",
      x: a.x + 6 * UNIT + 1,
      y: p.y - 24 * UNIT,
      width: 1,
      height: 24 * UNIT,
      oneWay: false,
    };
    const level = w.definitions.levels[0];
    w.index = makeIndex({ ...level, rectangles: [...level.rectangles, rect] });
    const events = step(w);
    expect(p.blocked).toBe(true);
    expect(p.x).toBe(oldX);
    expect(a.x).toBe(oldActor);
    expect(events.some((e) => e.type === "platform-blocked")).toBe(true);
    step(w);
    expect(p.x).toBe(oldX);
    w.index = makeIndex(level);
    step(w);
    expect(p.blocked).toBe(false);
    expect(p.x).toBe(oldX + UNIT);
  });
  it("keeps carry plus self-motion within the total 32px per tick cap", () => {
    const d = definitions((raw) => {
      raw.archetypes[0].speed = 8192;
      raw.archetypes[1].ai = "none";
      raw.levels[0].platforms[0].speed = 1024;
    });
    const w = createWorld(d, identity);
    placeOnPlatform(w);
    const x = w.actors[0].x;
    step(w, press(w, "right"));
    expect(w.actors[0].x - x).toBe(8192);
  });
  it("bounds oversized push separation rather than moving bodies beyond the actor cap", () => {
    const d = definitions((raw) => {
      for (const a of raw.archetypes) {
        a.push.width = 65536;
        a.push.x = -32768;
        a.ai = "none";
      }
      raw.levels[0].spawns[1].x = raw.levels[0].spawns[0].x + UNIT;
    });
    const w = createWorld(d, identity),
      starts = w.actors.map((a) => a.x);
    step(w);
    for (const [i, a] of w.actors.entries())
      expect(Math.abs(a.x - starts[i])).toBeLessThanOrEqual(8192);
  });
});

describe("participant combat and flow", () => {
  function duel(): World {
    const d = definitions((raw) => {
      raw.archetypes[1].ai = "none";
      raw.levels[0].spawns[0].x = 200 * UNIT;
      raw.levels[0].spawns[1].x = 220 * UNIT;
      raw.levels[0].spawns[1].slot = 1;
    });
    return createWorld(d, identity);
  }
  it("keeps a killed platform rider checkpoint valid while the platform continues", () => {
    const d = definitions((raw) => {
      const p = raw.levels[0].platforms[0];
      raw.levels[0].spawns[0].x = p.x + 8 * UNIT;
      raw.levels[0].spawns[0].y = p.y;
      raw.levels[0].spawns[1].x = p.x + 28 * UNIT;
      raw.levels[0].spawns[1].y = p.y;
      raw.archetypes[1].health = 1;
      raw.archetypes[1].ai = "none";
    });
    const w = createWorld(d, identity);
    step(w, press(w, "attack"));
    for (let i = 0; i < 100; i++) {
      step(w);
      const checkpoint = serializeCheckpoint(w);
      expect(
        serializeCheckpoint(restoreCheckpoint(d, identity, checkpoint)),
      ).toBe(checkpoint);
    }
    expect(w.actors[1].health).toBe(0);
    expect(w.actors[1].riderId).toBeNull();
  });
  it("continues an unrelated actor's motion during participant freeze", () => {
    const d = definitions((raw) => {
      raw.archetypes[1].ai = "none";
      raw.levels[0].spawns.push({
        ...raw.levels[0].spawns[0],
        id: "unrelated",
        slot: 2,
        x: 80 * UNIT,
        team: 2,
      });
    });
    const w = createWorld(d, identity),
      a = w.actors[0],
      other = w.actors[2],
      x = other.x;
    a.freezeTicks = 4;
    const frame = cancelFrame(w.decoder);
    frame.slots[2].held.right = true;
    frame.slots[2].edges.push({ action: "right", kind: "pressed" });
    step(w, frame);
    for (let i = 0; i < 3; i++) step(w);
    expect(other.x).toBe(x + 4 * d.archetypes[0].speed);
    expect(a.freezeTicks).toBe(0);
  });
  it("gathers symmetric attacks before damage so both trade and active frames deduplicate", () => {
    const w = duel();
    const frame = press(w, "attack");
    frame.slots[1].held.attack = true;
    frame.slots[1].edges.push({ action: "attack", kind: "pressed" });
    let hits = step(w, frame).filter((e) => e.type === "hit").length;
    for (let i = 0; i < 6; i++)
      hits += step(w).filter((e) => e.type === "hit").length;
    expect(hits).toBe(2);
    expect(w.actors.map((a) => a.health)).toEqual([10, 6]);
    expect(w.actors.every((a) => a.freezeTicks === 4)).toBe(true);
    for (let i = 0; i < 12; i++)
      hits += step(w).filter((e) => e.type === "hit").length;
    expect(hits).toBe(2);
  });
  it("freezes participants for exactly N following ticks while platforms and tick keep moving", () => {
    const w = duel();
    step(w, press(w, "attack"));
    for (let i = 0; i < 6; i++) step(w);
    const a = w.actors[0],
      timer = a.execution!.tick,
      x = a.x,
      px = w.platforms[0].x;
    expect(a.freezeTicks).toBe(4);
    for (let i = 0; i < 4; i++) {
      step(w);
      expect(a.x).toBe(x);
      expect(a.execution!.tick).toBe(timer);
    }
    expect(a.freezeTicks).toBe(0);
    expect(w.platforms[0].x).toBe(px + 4 * UNIT);
    step(w);
    expect(a.execution!.tick).toBe(timer + 1);
  });
  it("accepts buffered edges during freeze and freezes buffer expiration; cancel clears them", () => {
    const w = world(),
      a = w.actors[0];
    a.freezeTicks = 3;
    step(w, press(w, "heavy"));
    expect(a.attackBuffer).toBe(6);
    expect(a.execution).toBeNull();
    step(w);
    expect(a.attackBuffer).toBe(6);
    step(w, cancelFrame(w.decoder));
    expect(a.attackBuffer).toBe(0);
    expect(a.bufferedAbility).toBeNull();
    step(w);
    expect(a.execution).toBeNull();
  });
  it("same-tick tap attacks, but a same-tick cancel never initiates an attack", () => {
    const w = world(),
      f = press(w, "attack");
    f.slots[0].held.attack = false;
    f.slots[0].edges.push({ action: "attack", kind: "released" });
    step(w, f);
    expect(w.actors[0].execution?.abilityId).toBe("quick-strike");
    const c = world(),
      g = press(c, "attack");
    g.slots[0].held.attack = false;
    g.slots[0].edges.push({ action: "attack", kind: "cancel" });
    step(c, g);
    expect(c.actors[0].execution).toBeNull();
  });
  it("uses second strike entirely from authored data", () => {
    const w = world();
    step(w, press(w, "heavy"));
    expect(w.actors[0].execution?.abilityId).toBe("heavy-strike");
    for (let i = 0; i < 11; i++) step(w);
    expect(observe(w).actors[0].hit).not.toBeNull();
    expect(w.actors[0].execution?.tick).toBe(12);
  });
  it("guard produces guard damage and no knockback", () => {
    const w = duel(),
      f = press(w, "attack");
    f.slots[1].held.guard = true;
    f.slots[1].edges.push({ action: "guard", kind: "pressed" });
    step(w, f);
    let events = [] as ReturnType<typeof step>;
    for (let i = 0; i < 6; i++) events = step(w);
    expect(events.some((e) => e.type === "guard")).toBe(true);
    expect(w.actors[1].health).toBe(8);
    expect(w.actors[1].vx).toBe(0);
  });
  it("death wins over a simultaneous goal and restart increments identity epochs", () => {
    const w = world(),
      a = w.actors[0];
    a.x = 600 * UNIT;
    a.health = 0;
    const id = a.id,
      epoch = a.motionEpoch;
    step(w);
    expect(w.status).toBe("lost");
    step(w, { slots: [], commands: [{ type: "restart" }] });
    expect(w.status).toBe("playing");
    expect(w.actors[0].id).toBeGreaterThan(id);
    expect(w.actors[0].motionEpoch).toBeGreaterThan(epoch);
  });
  it("transitions the two authored rooms and reaches the final objective", () => {
    const w = world();
    w.actors[0].x = 600 * UNIT;
    step(w);
    expect(w.levelId).toBe("room-2");
    expect(w.campaign.visitedLevelIds).toEqual(["room-1", "room-2"]);
    w.actors[0].x = 600 * UNIT;
    step(w);
    expect(w.status).toBe("won");
  });
  it("observations are detached across subsequent steps and caller edits", () => {
    const w = world(),
      o = observe(w),
      bytes = JSON.stringify(o);
    step(w, press(w, "right"));
    expect(JSON.stringify(o)).toBe(bytes);
    (o.goal as { x: number }).x = 0;
    expect(w.definitions.levels[0].goal.x).not.toBe(0);
  });
  it("faces a close target behind the enemy before initiating a stationary strike", () => {
    const d = definitions((raw) => {
      raw.levels[0].spawns[0].x = raw.levels[0].spawns[1].x + 20 * UNIT;
    });
    const w = createWorld(d, identity);
    for (let i = 0; i < 10; i++) step(w);
    expect(w.actors[1].facing).toBe(1);
    expect(w.actors[0].health).toBeLessThan(12);
  });
});

describe("exact bounded checkpoint and replay", () => {
  it("restores jumping, attacking, frozen, and carried states to identical future bytes", () => {
    for (const mechanic of ["jump", "attack", "freeze", "carry"]) {
      const w = world();
      if (mechanic === "jump") step(w, press(w, "jump"));
      if (mechanic === "attack") step(w, press(w, "attack"));
      if (mechanic === "freeze") {
        w.actors[0].freezeTicks = 4;
        step(w);
      }
      if (mechanic === "carry") {
        placeOnPlatform(w);
        step(w);
      }
      const bytes = serializeCheckpoint(w),
        r = restoreCheckpoint(w.definitions, identity, bytes);
      expect(serializeCheckpoint(r)).toBe(bytes);
      for (let i = 0; i < 30; i++) {
        step(w);
        step(r);
      }
      expect(serializeCheckpoint(r)).toBe(serializeCheckpoint(w));
    }
  });
  it.each([
    "snapshotVersion",
    "gameId",
    "rulesBuildId",
    "contentId",
    "scenarioId",
    "initialPlayerSlots",
    "levelId",
  ])("rejects incompatible %s atomically", (field) => {
    const w = world(),
      before = serializeCheckpoint(w),
      raw = JSON.parse(before);
    raw[field] =
      field === "snapshotVersion"
        ? 2
        : field === "initialPlayerSlots"
          ? [1]
          : "missing";
    expect(() =>
      restoreCheckpoint(w.definitions, identity, JSON.stringify(raw)),
    ).toThrow();
    expect(serializeCheckpoint(w)).toBe(before);
  });
  it.each([
    "unknown",
    "fraction",
    "unsafe",
    "velocity",
    "timer",
    "counter",
    "axis",
    "ledger",
    "rider",
    "embedded",
    "grounded",
  ])("rejects forged future state: %s", (kind) => {
    const w = world(),
      raw = JSON.parse(serializeCheckpoint(w));
    if (kind === "unknown") raw.actors[0].secret = 1;
    if (kind === "fraction") raw.actors[0].x = 1.5;
    if (kind === "unsafe") raw.tick = Number.MAX_SAFE_INTEGER + 1;
    if (kind === "velocity") raw.actors[0].vx = 8193;
    if (kind === "timer") raw.actors[0].jumpBuffer = 7;
    if (kind === "counter") raw.nextEntityId = 1;
    if (kind === "axis") raw.decoder.slots[0].axes.moveX = 128;
    if (kind === "ledger")
      raw.actors[0].execution = {
        id: 1,
        abilityId: "quick-strike",
        tick: 7,
        hits: [{ targetId: 999, count: 1, lastTick: 0 }],
      };
    if (kind === "rider") raw.actors[0].riderId = "missing";
    if (kind === "embedded") raw.actors[0].y = 170 * UNIT;
    if (kind === "grounded") {
      raw.actors[0].y = 100 * UNIT;
      raw.actors[0].grounded = true;
    }
    expect(() =>
      restoreCheckpoint(w.definitions, identity, JSON.stringify(raw)),
    ).toThrow();
  });
  it("reports the first differing component path", () => {
    const w = world(),
      a = serializeCheckpoint(w);
    w.actors[0].jumpBuffer = 1;
    expect(firstDifference(a, serializeCheckpoint(w))).toBe(
      "/actors/0/jumpBuffer",
    );
    expect(firstDifference(a, a)).toBeNull();
  });
  it("fails before overflowing a future tick counter", () => {
    const w = world();
    w.tick = Number.MAX_SAFE_INTEGER;
    const bytes = serializeCheckpoint(w);
    expect(() => step(w)).toThrow("counter exhausted");
    expect(serializeCheckpoint(w)).toBe(bytes);
  });
  it("compares 10,000 complete ticks and active restores across display schedules", () => {
    const d = definitions(),
      a = runReplayFixture(d, identity, 10000, [1]),
      b = runReplayFixture(d, identity, 10000, [0, 5, 2, 0, 1, 3]);
    expect(b.checkpoints).toEqual(a.checkpoints);
    expect(b.final).toBe(a.final);
    expect(a.coverage.jumps).toBeGreaterThan(100);
    expect(a.coverage.hits).toBeGreaterThan(50);
    expect(a.coverage.guards).toBeGreaterThanOrEqual(16);
    expect(a.coverage.freezeTicks).toBeGreaterThan(300);
    expect(a.coverage.carriedTicks).toBeGreaterThan(200);
    expect(a.coverage.activeRestores).toBeGreaterThan(800);
    expect(a.coverage.restarts).toBe(33);
  });
});

describe("semantic input decoder", () => {
  it("retains held patches and axes but consumes press/release/cancel edges once", () => {
    const d = createInputDecoder();
    const f = decodeInputRecords(d, 0, [
      {
        tick: 0,
        slot: 0,
        sequence: 0,
        heldPatch: { attack: false },
        axesPatch: { moveX: 71 },
        edges: [
          { action: "attack", kind: "pressed" },
          { action: "attack", kind: "released" },
        ],
      },
    ]);
    expect(f.slots[0].edges).toHaveLength(2);
    const next = decodeInputRecords(d, 1, []);
    expect(next.slots[0].edges).toEqual([]);
    expect(next.slots[0].axes.moveX).toBe(71);
    expect(next.slots[0].held.attack).toBe(false);
  });
  it("rejects held disagreement, unknown fields, unordered sequences, fractions and transition overflow atomically", () => {
    const bad = [
      { tick: 0, slot: 0, sequence: 0, heldPatch: { attack: true }, edges: [] },
      { tick: 0, slot: 0, sequence: 0, edges: [], unknown: 1 },
      { tick: 0, slot: 0, sequence: 0.5, edges: [] },
      {
        tick: 0,
        slot: 0,
        sequence: 0,
        edges: Array.from({ length: 33 }, () => ({
          action: "attack",
          kind: "cancel",
        })),
      },
    ];
    for (const item of bad) {
      const d = createInputDecoder(),
        before = JSON.stringify(d);
      expect(() => decodeInputRecords(d, 0, [item as never])).toThrow();
      expect(JSON.stringify(d)).toBe(before);
    }
    const d = createInputDecoder();
    expect(() =>
      decodeInputRecords(d, 0, [
        { tick: 0, slot: 0, sequence: 1, edges: [] },
        { tick: 0, slot: 0, sequence: 0, edges: [] },
      ]),
    ).toThrow();
  });
});
