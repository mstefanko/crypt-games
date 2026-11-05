import { describe, it, expect, vi } from "vitest";
import type {
  CaveContent,
  CaveDirection,
} from "@onepage/game-project/cave-types";
import { CaveRescueOwner, type CaveCheckpoint } from "./cave-rescue";
import {
  caveCheckpointAdmissionBound,
  caveProgressAdmissionBound,
  caveDataBytes,
} from "./cave-save";
import { TerrainField } from "./terrain-field";
import { CaveNavigation } from "./cave-navigation";
import { caveActorRect, moveCaveActor } from "./cave-motor";
import { stageCaveSupport, createCaveSupport } from "./cave-support";
import site from "../../../examples/game-cave-rescue/site.json";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function content(): CaveContent {
  const c = clone(site) as unknown as {
    -readonly [K in keyof CaveContent]: CaveContent[K];
  };
  c.id = "test-cave";
  c.cells = Array(16384).fill(0);
  c.protected = Array(16384).fill(false);
  c.player = { id: "player", x: 4096, y: 4096, hp: 100 };
  c.drones = [{ id: "drone", x: 20480, y: 4096 }];
  c.extraction = { x: 2048, y: 2048, width: 8192, height: 8192 };
  for (let y = 2; y < 10; y++)
    for (let x = 2; x < 10; x++) (c.protected as boolean[])[y * 128 + x] = true;
  for (let y = 4; y < 6; y++)
    for (let x = 20; x < 22; x++)
      (c.protected as boolean[])[y * 128 + x] = true;
  c.roof = { nodes: [], edges: [], zones: [], braceSockets: [] };
  c.tools = {
    ...c.tools,
    chargeDamage: 20,
    chargeRadius: 4096,
    chargeFuse: 3,
    charges: 4,
    braces: 2,
    drillDamage: 1024,
    roofDamage: 20,
  };
  return c;
}
function roofContent(): CaveContent {
  const c = content(),
    cells = [...c.cells];
  cells[12 * 128 + 12] = 1;
  return {
    ...c,
    cells,
    roof: {
      nodes: [
        { id: "anchor", anchorCells: [12 * 128 + 12] },
        { id: "brace-node", anchorCells: [] },
      ],
      edges: [],
      zones: [
        {
          id: "roof",
          rect: { x: 12288, y: 10240, width: 4096, height: 4096 },
          nodeIds: ["anchor", "brace-node"],
        },
      ],
      braceSockets: [
        { id: "socket", nodeId: "brace-node", x: 13312, y: 11264 },
      ],
    },
  };
}
describe("Cave Rescue staged authority", () => {
  it("stages N0 forks without altering the original search state", () => {
    const f = new TerrainField(content()),
      nav = new CaveNavigation(f),
      actors = [{ id: "drone", x: 126 * 1024, y: 126 * 1024 }];
    nav.advance(f, actors, { x: 2048, y: 2048 });
    const before = nav.capture(),
      fork = nav.fork();
    fork.advance(f, actors, { x: 2048, y: 2048 });
    expect(nav.capture()).toEqual(before);
    expect(fork.capture()).not.toEqual(before);
  });
  it("retains the complete previous tick when staged navigation fails after excavating", () => {
    const c = content(),
      cells = [...c.cells];
    cells[4 * 128 + 10] = 1;
    cells[5 * 128 + 10] = 1;
    const owner = new CaveRescueOwner({
        ...c,
        cells,
        player: { ...c.player, x: 8192 },
      }),
      before = owner.capture(),
      original = CaveNavigation.prototype.advance;
    const failure = vi
      .spyOn(CaveNavigation.prototype, "advance")
      .mockImplementation(function (this: CaveNavigation, ...args) {
        original.apply(this, args);
        throw Error("staged navigation failure");
      });
    try {
      expect(() => owner.step({ drill: true })).toThrow(/staged/);
    } finally {
      failure.mockRestore();
    }
    expect(owner.capture()).toEqual(before);
    expect(owner.observe().diagnostics.entries).toHaveLength(0);
  });
  it("never serializes JSON while admitting routes and publishing excavation projections", () => {
    const c = content(),
      cells = [...c.cells],
      protectedCells = [...c.protected];
    for (let y = 0; y < 128; y++) cells[y * 128 + 12] = 1;
    for (let y = 4; y < 6; y++)
      for (let x = 14; x < 16; x++) protectedCells[y * 128 + x] = true;
    const owner = new CaveRescueOwner({
      ...c,
      cells,
      protected: protectedCells,
      drones: [{ id: "drone", x: 14 * 1024, y: 4096 }],
    });
    let sawPending = false,
      sawFollowing = false;
    const stringify = vi.spyOn(JSON, "stringify").mockImplementation(() => {
      throw Error("per-tick serialization");
    });
    try {
      for (let i = 0; i < 180; i++) {
        const state = owner.step({ moveX: 1, aim: "right", drill: i >= 12 });
        sawPending ||= state.navigation.pending > 0;
        sawFollowing ||= state.drones[0].mode === "following";
      }
    } finally {
      stringify.mockRestore();
    }
    const state = owner.observe();
    expect(sawPending).toBe(true);
    expect(sawFollowing).toBe(true);
    expect(state.terrain.terrainRevision).toBeGreaterThan(0);
    expect(state.navigation.cohortRevision).toBeGreaterThan(0);
    expect(owner.capture().navigation.scheduler.state.nextId).toBeGreaterThan(
      2,
    );
    expect(state.navigation.work.completed).toBeGreaterThan(0);
  });
  it("uses the admission proof for maximal content and seven N0 searches", () => {
    expect(caveCheckpointAdmissionBound(524288, 7)).toBeLessThan(
      4 * 1024 * 1024,
    );
    expect(caveProgressAdmissionBound(524288)).toBeLessThan(1024 * 1024);
  });
  it("moves using fine cells, preserves wall slide and touching policy", () => {
    const c = content(),
      cells = [...c.cells];
    cells[4 * 128 + 10] = 1;
    cells[5 * 128 + 10] = 1;
    const f = new TerrainField({ ...c, cells });
    expect(moveCaveActor(f, { x: 8192, y: 4096 }, 362, 362)).toEqual({
      x: 8192,
      y: 4458,
    });
    expect(caveActorRect({ x: 1, y: 2 }).width).toBe(2048);
  });
  it("rejects non-string direction commands and restored aims without mutating authority", () => {
    const owner = new CaveRescueOwner(content()),
      before = owner.capture();
    for (const aim of [["right"], { direction: "right" }, [], null]) {
      expect(() =>
        owner.step({
          aim: aim as unknown as CaveDirection,
          drill: true,
          charge: true,
        }),
      ).toThrow();
      expect(owner.capture()).toEqual(before);
    }
    const invalid = clone(before);
    invalid.state.aim = ["right"] as unknown as CaveDirection;
    expect(() => owner.restore(invalid)).toThrow(/aim/);
    expect(owner.capture()).toEqual(before);
  });
  it("queries usable tools from the same predicted pose as admission without spending resources", () => {
    const c = content(),
      roof = {
        nodes: [{ id: "node", anchorCells: [] }],
        edges: [],
        zones: [],
        braceSockets: [
          { id: "used", nodeId: "node", x: 5120, y: 5120 },
          { id: "far", nodeId: "node", x: 8192, y: 5120 },
        ],
      } satisfies CaveContent["roof"];
    const owner = new CaveRescueOwner({ ...c, roof }),
      before = owner.capture();
    expect(owner.toolAvailability()).toEqual({
      charge: true,
      braceSockets: ["used", "far"],
    });
    expect(owner.capture()).toEqual(before);
    owner.step({ brace: "used" });
    expect(owner.toolAvailability().braceSockets).toEqual(["far"]);
    owner.step({ brace: owner.toolAvailability().braceSockets[0] });
    expect(owner.toolAvailability().braceSockets).toEqual([]);
    expect(owner.observe().inventory.braces).toBe(0);
    const edgeOwner = new CaveRescueOwner({
        ...c,
        roof: {
          ...roof,
          braceSockets: [{ id: "edge", nodeId: "node", x: 6144, y: 5120 }],
        },
        tools: { ...c.tools, braceReach: 1024 },
      }),
      edgeBefore = edgeOwner.capture();
    expect(edgeOwner.toolAvailability().braceSockets).toEqual(["edge"]);
    expect(edgeOwner.toolAvailability({ moveX: -1 }).braceSockets).toEqual([]);
    expect(edgeOwner.capture()).toEqual(edgeBefore);
    expect(() => edgeOwner.step({ moveX: -1, brace: "edge" })).toThrow(/brace/);
    expect(edgeOwner.capture()).toEqual(edgeBefore);
  });
  it("reports obstructed and exhausted tools and orders equal-distance sockets by ASCII identity", () => {
    const c = content(),
      cells = [...c.cells];
    cells[5 * 128 + 6] = 1;
    const obstructed = new CaveRescueOwner({
        ...c,
        cells,
        extraction: { ...c.extraction, width: 4096 },
      }),
      before = obstructed.capture();
    expect(obstructed.toolAvailability({ aim: "right" }).charge).toBe(false);
    expect(() => obstructed.step({ charge: true })).toThrow(/charge/);
    expect(obstructed.capture()).toEqual(before);
    const roof = {
      nodes: [{ id: "node", anchorCells: [] }],
      edges: [],
      zones: [],
      braceSockets: [
        { id: "z-socket", nodeId: "node", x: 6144, y: 5120 },
        { id: "a-socket", nodeId: "node", x: 4096, y: 5120 },
      ],
    } satisfies CaveContent["roof"];
    expect(
      new CaveRescueOwner({ ...c, roof }).toolAvailability().braceSockets,
    ).toEqual(["a-socket", "z-socket"]);
    expect(
      new CaveRescueOwner({
        ...c,
        roof,
        tools: { ...c.tools, braces: 0, charges: 0 },
      }).toolAvailability(),
    ).toEqual({ charge: false, braceSockets: [] });
  });
  it("does not let a corner behind the charge shield an exposed player moving away diagonally", () => {
    const c = content(),
      cells = [...c.cells];
    cells[4 * 128 + 6] = 1;
    const owner = new CaveRescueOwner({
      ...c,
      cells,
      extraction: { ...c.extraction, width: 4096 },
    });
    owner.step({ charge: true });
    owner.step({ moveX: -1, moveY: 1 });
    owner.step();
    owner.step();
    expect(owner.observe().player.hp).toBe(80);
    expect(owner.observe().events.some((e) => e.kind === "player-damage")).toBe(
      true,
    );
  });
  it("retains later precommit cover after ignoring an origin-only corner contact", () => {
    const c = content(),
      cells = [...c.cells],
      protectedCells = [...c.protected];
    cells[4 * 128 + 6] = 1;
    cells[6 * 128 + 5] = 1;
    protectedCells[4 * 128 + 6] = false;
    protectedCells[6 * 128 + 5] = false;
    const owner = new CaveRescueOwner({
      ...c,
      cells,
      protected: protectedCells,
      extraction: { ...c.extraction, width: 4096, height: 4096 },
      tools: { ...c.tools, chargeDamage: 32 },
    });
    owner.step({ charge: true });
    const pending = owner.capture();
    pending.state.player.x = 4096;
    pending.state.player.y = 7168;
    owner.restore(pending);
    owner.step();
    owner.step();
    owner.step();
    const state = owner.observe();
    expect(state.player.hp).toBe(100);
    expect(state.terrain.cells[4 * 128 + 6]).toBe(0);
    expect(state.terrain.cells[6 * 128 + 5]).toBe(0);
  });
  it("bounds diagonal travel to the same two-pixel speed envelope", () => {
    const owner = new CaveRescueOwner(content()),
      before = owner.observe().player;
    owner.step({ moveX: 1, moveY: 1 });
    const after = owner.observe().player,
      dx = after.x - before.x,
      dy = after.y - before.y;
    expect(dx).toBe(362);
    expect(dx * dx + dy * dy).toBeLessThanOrEqual(512 * 512);
  });
  it("rejects invalid tools and duplicate input atomically, with no resource spend", () => {
    const owner = new CaveRescueOwner(content());
    const before = owner.capture();
    expect(() => owner.step({ brace: "missing", charge: true })).toThrow();
    expect(owner.capture()).toEqual(before);
    owner.step({ sequence: 1 });
    const after = owner.capture();
    expect(() => owner.step({ sequence: 1 })).toThrow();
    expect(owner.capture()).toEqual(after);
  });
  it("has nonblocking actors and immune drones; defeat and reset are complete flows", () => {
    const c = content(),
      owner = new CaveRescueOwner({
        ...c,
        drones: [...c.drones, { id: "base-drone", x: 4096, y: 4096 }],
        tools: { ...c.tools, chargeDamage: 100 },
      });
    owner.step({ charge: true });
    for (let i = 0; i < 3; i++) owner.step();
    expect(owner.observe().status).toBe("defeated");
    expect(owner.observe().drones[1].rescued).toBe(true);
    expect(owner.observe().drones[0]).not.toHaveProperty("hp");
    owner.restart();
    expect(owner.observe().player.hp).toBe(100);
    expect(owner.observe().inventory.charges).toBe(4);
  });
  it("installs an admitted brace before same-tick warning expiry and never repeats collapse", () => {
    const c = roofContent(),
      f = new TerrainField(c),
      initial = createCaveSupport(c, f),
      tx = f.stageDamage([
        { id: 12 * 128 + 12, damage: 1024, causes: ["test"] },
      ]);
    tx.commit();
    let state = stageCaveSupport(c, f, initial, undefined).state;
    expect(state.zones[0].remaining).toBe(120);
    for (let i = 0; i < 119; i++)
      state = stageCaveSupport(c, f, state, undefined).state;
    expect(state.zones[0].remaining).toBe(1);
    const braced = stageCaveSupport(c, f, state, "socket");
    expect(braced.events.map((e) => e.kind)).toEqual(["roof-supported"]);
    const collapsed = stageCaveSupport(c, f, state, undefined);
    expect(collapsed.events[0].kind).toBe("roof-collapse");
    expect(stageCaveSupport(c, f, collapsed.state, undefined).events).toEqual(
      [],
    );
  });
  it("admits the last-tick brace before roof damage in the actual owner transaction", () => {
    const c = roofContent(),
      field = new TerrainField(c);
    field
      .stageDamage([{ id: 12 * 128 + 12, damage: 1024, causes: ["test"] }])
      .commit();
    const saved = new CaveRescueOwner(c).capture();
    saved.terrain = field.snapshot();
    saved.state.tick = 120;
    saved.state.stateRevision = 120;
    saved.state.lastSequence = 120;
    saved.state.player.x = 12288;
    saved.state.player.y = 10240;
    saved.state.support = {
      braces: [],
      zones: [{ id: "roof", status: "warning", remaining: 1 }],
    };
    saved.state.ore = field.rewardTotal;
    saved.navigation = new CaveNavigation(field).capture();
    const owner = new CaveRescueOwner(c);
    owner.restore(saved);
    owner.step({ brace: "socket" });
    expect(owner.observe().events.map((e) => e.kind)).toEqual([
      "brace-installed",
      "roof-supported",
    ]);
    expect(owner.observe().player.hp).toBe(100);
    expect(owner.observe().inventory.braces).toBe(1);
    const failed = new CaveRescueOwner(c);
    failed.restore(saved);
    failed.step();
    expect(failed.observe().player.hp).toBe(80);
    expect(failed.observe().support.zones[0].status).toBe("collapsed");
    const after = failed.capture();
    const restored = new CaveRescueOwner(c);
    restored.restore(after);
    restored.step();
    expect(restored.observe().player.hp).toBe(80);
  });
  it("restores exact pending charge, input cooldown and in-flight route continuation", () => {
    const owner = new CaveRescueOwner(content(), "build-a");
    for (let i = 0; i < 24; i++) owner.step({ moveX: 1, drill: true });
    owner.step({ charge: true });
    const saved = owner.capture(),
      restored = new CaveRescueOwner(content(), "build-a");
    restored.restore(saved);
    expect(restored.capture()).toEqual(saved);
    for (let i = 0; i < 30; i++) {
      const cmd = { moveX: (i < 6 ? 1 : 0) as 0 | 1, drill: i % 2 === 0 };
      owner.step(cmd);
      restored.step(cmd);
      expect(restored.capture()).toEqual(owner.capture());
    }
    expect(() =>
      new CaveRescueOwner(content(), "build-b").restore(saved),
    ).toThrow(/identity/);
  });
  it("strictly rejects unknown/getter/sparse/deep imports and leaves previous state intact", () => {
    const owner = new CaveRescueOwner(content()),
      before = owner.capture();
    const malformed = clone(before) as CaveCheckpoint & { extra?: number };
    malformed.extra = 1;
    expect(() => owner.restore(malformed)).toThrow();
    const getter = clone(before);
    Object.defineProperty(getter.state.player, "hp", {
      get() {
        throw Error("getter executed");
      },
      enumerable: true,
    });
    expect(() => owner.restore(getter)).toThrow(/properties/);
    const sparse = clone(before);
    delete (sparse.terrain.hp as number[])[0];
    expect(() => owner.restore(sparse)).toThrow();
    expect(owner.capture()).toEqual(before);
  });
  it("rejects a cohort that blocks an initially clear protected extraction node", () => {
    const owner = new CaveRescueOwner(content()),
      before = owner.capture(),
      bad = clone(before);
    bad.navigation.scheduler.state.grid.costs[65] = 0;
    expect(() => owner.restore(bad)).toThrow(/projection/);
    expect(owner.capture()).toEqual(before);
  });
  it("exports safe-base progress, preserves terrain/rewards/inventory and refuses hazards", () => {
    const owner = new CaveRescueOwner(content());
    owner.step({ charge: true });
    expect(() => owner.captureProgress()).toThrow(/safe/);
    for (let i = 0; i < 3; i++) owner.step();
    const progress = owner.captureProgress();
    expect(caveDataBytes(progress)).toBeLessThan(1024 * 1024);
    const other = new CaveRescueOwner(content());
    other.restoreProgress(progress);
    expect(other.observe().inventory.charges).toBe(3);
    expect(other.observe().player.hp).toBe(owner.observe().player.hp);
  });
  it("releases extracted drone routes and restores a completed mission exactly", () => {
    const owner = new CaveRescueOwner(content());
    for (let i = 0; i < 24; i++) owner.step({ moveX: 1 });
    for (let i = 0; i < 24; i++) owner.step({ moveX: -1 });
    for (let i = 0; i < 150 && owner.observe().status === "playing"; i++)
      owner.step();
    expect(owner.observe().status).toBe("complete");
    const saved = owner.capture(),
      restored = new CaveRescueOwner(content());
    restored.restore(saved);
    expect(restored.capture()).toEqual(saved);
  });
  it("keeps diagnostic evidence byte bounded and explicitly reports truncation", () => {
    const owner = new CaveRescueOwner(content());
    for (let i = 0; i < 125; i++) owner.step();
    expect(owner.observe().diagnostics.entries).toHaveLength(120);
    expect(owner.observe().diagnostics.truncated).toBe(true);
    expect(owner.observe().diagnostics.bytes).toBeLessThanOrEqual(
      2 * 1024 * 1024,
    );
  });
  it("finishes persistent navigation cohorts despite repeated live terrain publication", () => {
    const c = content(),
      f = new TerrainField(c),
      nav = new CaveNavigation(f),
      actors = [{ id: "drone", x: 126 * 1024, y: 126 * 1024 }];
    nav.advance(f, actors, { x: 2048, y: 2048 });
    for (let i = 1; i <= 40; i++) {
      nav.publishTerrain(f, i);
      nav.advance(f, actors, { x: 2048, y: 2048 });
    }
    expect(nav.mode("drone")).toBe("following");
    expect(nav.observe().work.completed).toBeGreaterThan(0);
  });
});

it("freezes cave motor protected boundaries and endpoint-search compatibility vectors", () => {
  const c = content();
  const field = new TerrainField(c);
  expect(moveCaveActor(field, {x: 0, y: 4096}, -512, 0)).toEqual({x:0,y:4096});
  expect(moveCaveActor(field, {x: 4096, y: 4096}, 0, 0)).toEqual({x:4096,y:4096});
  expect(moveCaveActor(field, {x: 4096, y: 4096}, 362, 362)).toEqual({x:4458,y:4458});
  expect(() => moveCaveActor(field,{x:4096,y:4096},363,363)).toThrow('speed cap');
  const cells = [...c.cells];
  cells[4*128+10] = 1;
  const wall = new TerrainField({...c,cells});
  expect(moveCaveActor(wall,{x:8192,y:4096},512,0)).toEqual({x:8192,y:4096});
  // Existing penetration can escape through a clear endpoint; no depenetration is performed.
  expect(moveCaveActor(wall,{x:8704,y:4096},-512,0)).toEqual({x:8192,y:4096});
});
