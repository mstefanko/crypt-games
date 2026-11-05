import { describe, expect, it } from "vitest";
import { DamageableWorld, canonicalDestructionData, DESTRUCTION_LIMITS } from "./destruction";
import type { DamageableDefinition, DestructionConfiguration, DestructionInput } from "./destruction";
import { DestructionFixture } from "./destruction-fixture";
import { queryGeometry } from "./geometry";

function object(id = "target", patch: Partial<DamageableDefinition> = {}): DamageableDefinition {
  return { id, kind: "prop", rect: { x: 100, y: 0, width: 20, height: 20 }, hp: 4, team: 1, brokenBlocking: false, reward: 2, blast: null, ...patch };
}
function configuration(objects: DamageableDefinition[] = [object()]): DestructionConfiguration { return { objects }; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
const breach = { moveX: 256, hits: [
  { eventId: "shot-b", sourceId: "hero", targetId: "breakable-wall", damage: 2 },
  { eventId: "shot-a", sourceId: "hero", targetId: "breakable-wall", damage: 2 },
], ignite: ["barrel-a"] };
const empty: DestructionInput = { hits: [], ignite: [] };
function barrel(id: string, x: number, y = 0, patch: Partial<DamageableDefinition> = {}): DamageableDefinition {
  return object(id, { rect: { x, y, width: 20, height: 20 }, blast: { bands: [{ radius: 4096, damage: 4 }], friendlyFire: true }, ...patch });
}

describe("P2 bounded whole-object destruction", () => {
  it("gathers simultaneous hits, transitions/rewards once, and exposes an atomic terrain revision", () => {
    const world = new DamageableWorld(configuration());
    const previous = world.collisionShapes();
    const state = world.step({ hits: [
      { eventId: "b", sourceId: "player-b", targetId: "target", damage: 2 },
      { eventId: "a", sourceId: "player-a", targetId: "target", damage: 2 },
    ], ignite: [] });
    expect(state).toMatchObject({ terrainRevision: 1, rewardTotal: 2, destroyed: ["target"], rewarded: ["target"] });
    expect(state.receipts.map(r => [r.eventId, r.damage])).toEqual([["hit:1:a", 2], ["hit:1:b", 2]]);
    const query = { kind: "sweep" as const, rect: { x: 0, y: 0, width: 10, height: 10 }, delta: { x: 200, y: 0 } };
    expect(queryGeometry(previous, query).contacts.map(c => c.bodyId)).toEqual(["target"]);
    expect(queryGeometry(world.collisionShapes(), query).contacts).toEqual([]);
    const again = world.step({ hits: [{ eventId: "a", sourceId: "player-a", targetId: "target", damage: 4 }], ignite: [] });
    expect(again).toMatchObject({ terrainRevision: 1, rewardTotal: 2, destroyed: [], rewarded: ["target"] });
    expect(again.receipts[0]).toMatchObject({ outcome: "inactive", damage: 0 });
  });
  it("keeps same-tick cover, queues chains for the next tick, and lets the consumer enter only next tick", () => {
    const fixture = new DestructionFixture();
    const tick1 = fixture.step(breach);
    expect(tick1.body.x).toBe(636);
    expect(tick1.world).toMatchObject({ terrainRevision: 1, destroyed: ["barrel-a", "barrel-b", "breakable-wall"], pending: [{ sourceId: "barrel-b", readyTick: 2 }], rewardTotal: 4 });
    expect(tick1.world.receipts.find(r => r.targetId === "sheltered-prop")).toMatchObject({ outcome: "covered", damage: 0 });
    expect(tick1.world.objects.find(o => o.id === "sheltered-prop")!.hp).toBe(4);
    const paused = fixture.capture();
    fixture.observe(); fixture.observe();
    expect(fixture.capture()).toEqual(paused); // Inspection/pause cannot advance fuses or queues.
    const tick2 = fixture.step({ moveX: 256, ...empty });
    expect(tick2.body.x).toBe(892);
    expect(tick2.world).toMatchObject({ terrainRevision: 2, destroyed: ["sheltered-prop"], pending: [], rewardTotal: 7 });
    expect(tick2.world.receipts.find(r => r.targetId === "sheltered-prop")).toMatchObject({ sourceId: "barrel-b", outcome: "damage", damage: 4 });
    const after = fixture.step({ moveX: 0, hits: [], ignite: ["barrel-a", "barrel-b"] });
    expect(after.world.receipts).toEqual([]);
    expect(after.world.rewardTotal).toBe(7);
  });
  it("moves away from a touching wall after stopping, including after exact restore", () => {
    const fixture = new DestructionFixture();
    expect(fixture.step({ moveX: 256, ...empty }).body.x).toBe(636);
    expect(fixture.step({ moveX: 1, ...empty }).body.x).toBe(636);
    const contact = fixture.capture();
    const restored = new DestructionFixture(); restored.restore(contact);
    const away = fixture.step({ moveX: -256, ...empty });
    expect(away.body.x).toBe(380);
    expect(restored.step({ moveX: -256, ...empty })).toEqual(away);
    expect(fixture.step({ moveX: 256, ...empty }).body.x).toBe(636);
    expect(fixture.step({ moveX: 0, ...empty }).body.x).toBe(636);
    expect(fixture.step({ moveX: -1, ...empty }).body.x).toBe(635);
    expect(fixture.observe().world.terrainRevision).toBe(0);
  });
  it("accepts final-tick destruction and drains the longest eight-source chain without accepting new commands", () => {
    const config = configuration(Array.from({ length: 8 }, (_, i) => barrel(`barrel-${i}`, i * 128, 0, { rect: { x: i * 128, y: 0, width: 2, height: 2 }, blast: { bands: [{ radius: 128, damage: 4 }], friendlyFire: true } })));
    const world = new DamageableWorld(config);
    for (let tick = 0; tick < 63; tick++) world.step();
    const last = world.step({ hits: [{ eventId: "last-shot", sourceId: "hero", targetId: "barrel-0", damage: 4 }], ignite: [] });
    expect(last).toMatchObject({ tick: 64, pending: [{ sourceId: "barrel-0", readyTick: 65 }] });
    const atHorizon = world.capture();
    for (const command of [
      { hits: [{ eventId: "too-late", sourceId: "hero", targetId: "barrel-7", damage: 4 }], ignite: [] },
      { hits: [], ignite: ["barrel-7"] },
    ]) {
      expect(() => world.step(command)).toThrow(/tick cap/);
      expect(world.capture()).toEqual(atHorizon);
    }
    const restored = new DamageableWorld(config); restored.restore(atHorizon);
    for (let source = 0; source < 8; source++) {
      const state = world.step();
      expect(state.tick).toBe(65 + source);
      expect(state.objects.filter(o => o.detonated).map(o => o.id)).toEqual(Array.from({ length: source + 1 }, (_, i) => `barrel-${i}`));
      expect(restored.step()).toEqual(state);
    }
    expect(world.observe()).toMatchObject({ tick: 72, pending: [], rewardTotal: 16 });
    expect(world.observe().objects.every(o => o.hp === 0 && o.detonated)).toBe(true);
    const finished = world.save();
    const revisited = new DamageableWorld(config); revisited.load(finished);
    expect(revisited.save()).toBe(finished);
    expect(() => world.step()).toThrow(/tick cap/);
    expect(world.save()).toBe(finished);
    const idle = new DamageableWorld(configuration());
    for (let tick = 0; tick < 64; tick++) idle.step();
    const noPending = idle.save();
    expect(() => idle.step()).toThrow(/tick cap/);
    expect(idle.save()).toBe(noPending);
  });
  it("freezes the fixture motor during final-tick blast drain and rejects movement atomically", () => {
    const fixture = new DestructionFixture();
    for (let tick = 0; tick < 63; tick++) fixture.step();
    const last = fixture.step(breach);
    expect(last).toMatchObject({ body: { x: 636 }, world: { tick: 64, pending: [{ sourceId: "barrel-b", readyTick: 65 }] } });
    const saved = fixture.save();
    expect(() => fixture.step({ moveX: -256, ...empty })).toThrow(/movement cannot advance/);
    expect(fixture.save()).toBe(saved);
    const drained = fixture.step();
    expect(drained).toMatchObject({ body: { x: 636 }, world: { tick: 65, pending: [], destroyed: ["sheltered-prop"] } });
    const restored = new DestructionFixture(); restored.load(saved);
    expect(restored.step()).toEqual(drained);
    const finished = fixture.capture();
    const revisited = new DestructionFixture(); revisited.restore(finished);
    expect(revisited.capture()).toEqual(finished);
    expect(() => fixture.step()).toThrow(/tick cap/);
    expect(fixture.capture()).toEqual(finished);
  });
  it("retains authored blocking wrecks and their binary cover after death", () => {
    const world = new DamageableWorld(configuration([
      barrel("source", 0), object("wreck", { kind: "car", rect: { x: 40, y: -20, width: 20, height: 80 }, brokenBlocking: true }), object("sheltered"),
    ]));
    const first = world.step({ hits: [{ eventId: "wreck", sourceId: "hero", targetId: "wreck", damage: 4 }], ignite: [] });
    expect(first.terrainRevision).toBe(0);
    expect(world.collisionShapes().map(s => s.bodyId)).toContain("wreck");
    const second = world.step({ hits: [], ignite: ["source"] });
    expect(second.receipts.find(r => r.targetId === "sheltered")).toMatchObject({ outcome: "covered" });
    expect(second.objects.find(o => o.id === "sheltered")!.hp).toBe(4);
    expect(second.rewarded).toEqual(["source", "wreck"]);
  });
  it("uses integer center-distance damage bands, boundary inclusivity and team policy", () => {
    const config = configuration([
      barrel("source", -1, -1, { rect: { x: -1, y: -1, width: 2, height: 2 }, team: 0, blast: { bands: [{ radius: 100, damage: 4 }, { radius: 200, damage: 2 }], friendlyFire: false } }),
      object("edge", { rect: { x: 99, y: -1, width: 2, height: 2 } }),
      object("outer", { rect: { x: -1, y: 199, width: 2, height: 2 } }),
      object("outside-center", { rect: { x: -202, y: -1, width: 2, height: 2 } }),
      object("friendly", { team: 0, rect: { x: -1, y: -101, width: 2, height: 2 } }),
    ]);
    const state = new DamageableWorld(config).step({ hits: [], ignite: ["source"] });
    expect(state.objects.find(o => o.id === "edge")!.hp).toBe(0);
    expect(state.objects.find(o => o.id === "outer")!.hp).toBe(2);
    expect(state.receipts.find(r => r.targetId === "friendly")).toMatchObject({ outcome: "team", damage: 0 });
    expect(state.objects.find(o => o.id === "outside-center")!.hp).toBe(4);
    // A large rectangle intersects the outer circle, but its center is outside.
    const outside = configuration([barrel("source", -1, -1, { rect: { x: -1, y: -1, width: 2, height: 2 }, blast: { bands: [{ radius: 200, damage: 4 }], friendlyFire: true } }), object("large", { rect: { x: 199, y: -1, width: 100, height: 2 } })]);
    expect(new DamageableWorld(outside).step({ hits: [], ignite: ["source"] }).receipts).toEqual([]);
  });
  it("keeps blast candidates and cover independent of authored/input order", () => {
    const defs = [barrel("source-b", -100, 500), barrel("source-a", 0), object("wall", { rect: { x: 50, y: -20, width: 20, height: 80 } }), object("target")];
    const left = new DamageableWorld(configuration(defs));
    const right = new DamageableWorld(configuration([...defs].reverse()));
    const command = { hits: [{ eventId: "z", sourceId: "hero", targetId: "wall", damage: 2 }, { eventId: "a", sourceId: "hero", targetId: "wall", damage: 2 }], ignite: ["source-b", "source-a"] };
    expect(left.step(command)).toEqual(right.step({ hits: [...command.hits].reverse(), ignite: [...command.ignite].reverse() }));
    expect(left.save()).toBe(right.save());
  });
  it("preserves all effects in the combined maximum workload and proves finite work counts", () => {
    const defs = Array.from({ length: 64 }, (_, i) => object(`object-${String(i).padStart(2, "0")}`, { hp: 4096, rect: { x: 0, y: 0, width: 1, height: 1 }, blast: i < 8 ? { bands: [{ radius: 4096, damage: 1024 }], friendlyFire: true } : null }));
    const world = new DamageableWorld(configuration(defs));
    const command = { hits: Array.from({ length: 32 }, (_, i) => ({ eventId: `hit-${i}`, sourceId: "hero", targetId: defs[63].id, damage: 1024 })), ignite: defs.slice(0, 8).map(o => o.id) };
    const state = world.step(command);
    expect(state.counters).toEqual({ candidates: 512, coverRays: 504, coverTests: 31248 });
    expect(state.receipts).toHaveLength(536);
    expect(state.objects.every(o => o.hp === 0)).toBe(true);
    expect(state.destroyed).toHaveLength(64);
    expect(state.rewardTotal).toBe(128);
    expect(state.pending).toEqual([]);
    expect(state.terrainRevision).toBe(1);
    const saved = world.save();
    const restored = new DamageableWorld(configuration([...defs].reverse())); restored.load(saved);
    expect(restored.step()).toEqual(world.step());
    for (let tick = 2; tick < 64; tick++) world.step();
    const before = world.capture();
    expect(() => world.step(command)).toThrow(/tick cap/);
    expect(world.capture()).toEqual(before);
  });
  it("retains the maximum admitted history and identity lengths inside the exact codec budget", () => {
    const targetId = "target-" + "t".repeat(57);
    const config = configuration([object(targetId)]);
    const world = new DamageableWorld(config);
    const command = { hits: Array.from({ length: 32 }, (_, i) => ({ eventId: String(i).padStart(2, "0") + "e".repeat(62), sourceId: "s".repeat(64), targetId, damage: 1024 })), ignite: [] };
    for (let tick = 0; tick < 64; tick++) world.step(command);
    const bytes = world.save();
    expect(bytes.length).toBeLessThan(DESTRUCTION_LIMITS.checkpointCharacters);
    const restored = new DamageableWorld(config); restored.load(bytes);
    expect(restored.save()).toBe(bytes);
    const fixture = new DestructionFixture();
    for (let tick = 0; tick < 64; tick++) fixture.step({ moveX: 0, hits: command.hits.map(h => ({ ...h, targetId: "breakable-wall" })), ignite: [] });
    const fixtureBytes = fixture.save();
    expect(fixtureBytes.length).toBeLessThan(DESTRUCTION_LIMITS.checkpointCharacters);
    const restoredFixture = new DestructionFixture(); restoredFixture.load(fixtureBytes);
    expect(restoredFixture.save()).toBe(fixtureBytes);
  });
  it("rejects unsupported capacities, geometry, policies and numeric values at admission", () => {
    const invalid: unknown[] = [
      configuration(Array.from({ length: 65 }, (_, i) => object(`o-${i}`))),
      configuration(Array.from({ length: 9 }, (_, i) => barrel(`b-${i}`, i * 20))),
      configuration([object(), object()]),
      configuration([object("bad", { hp: 0 })]), configuration([object("bad", { hp: 4097 })]),
      configuration([object("bad", { rect: { x: 262140, y: 0, width: 20, height: 20 } })]),
      configuration([barrel("bad", 261000)]),
      configuration([barrel("bad", 0, 0, { blast: { bands: [{ radius: 4097, damage: 4 }], friendlyFire: true } })]),
      configuration([barrel("bad", 0, 0, { blast: { bands: [{ radius: 100, damage: 1 }, { radius: 100, damage: 2 }], friendlyFire: true } })]),
    ];
    for (const config of invalid) expect(() => new DamageableWorld(config as DestructionConfiguration)).toThrow();
    const world = new DamageableWorld(configuration([barrel("barrel", 0), object()]));
    const before = world.capture();
    for (const command of [
      { hits: Array.from({ length: 33 }, (_, i) => ({ eventId: `h-${i}`, sourceId: "hero", targetId: "target", damage: 1 })), ignite: [] },
      { hits: [{ eventId: "h", sourceId: "hero", targetId: "missing", damage: 1 }], ignite: [] },
      { hits: [{ eventId: "h", sourceId: "hero", targetId: "target", damage: -1 }], ignite: [] },
      { hits: [{ eventId: "h", sourceId: "hero", targetId: "target", damage: 1025 }], ignite: [] },
      { hits: [], ignite: ["barrel", "barrel"] }, { hits: [], ignite: ["target"] },
      { hits: [], ignite: [], extra: 1 },
    ]) {
      expect(() => world.step(command)).toThrow(); expect(world.capture()).toEqual(before);
    }
  });
  it("restores exact mid-damage, queued-chain, destroyed and revisited state with identical continuation", () => {
    const fixture = new DestructionFixture();
    const initial = fixture.capture();
    fixture.step({ moveX: 0, hits: [{ eventId: "chip", sourceId: "hero", targetId: "wreck", damage: 2 }], ignite: [] });
    const partial = fixture.capture();
    fixture.step(breach);
    const pending = fixture.capture();
    const next = fixture.step({ moveX: 256, ...empty });
    const final = fixture.capture();
    for (const checkpoint of [initial, partial, pending, final]) {
      const restored = new DestructionFixture(); restored.restore(checkpoint);
      expect(restored.capture()).toEqual(checkpoint);
      const detached = restored.observe(); detached.body.x = 999; detached.world.objects[0].hp = 999;
      expect(restored.capture()).toEqual(checkpoint);
    }
    const restored = new DestructionFixture(); restored.load(canonicalDestructionData(pending));
    expect(restored.step({ moveX: 256, ...empty })).toEqual(next);
    expect(restored.save()).toBe(fixture.save());
    const world = new DamageableWorld(pending.world.configuration); world.restore(pending.world);
    expect(world.step()).toEqual(next.world);
  });
  it("rejects every inconsistent future-affecting field atomically", () => {
    const fixture = new DestructionFixture(); fixture.step(breach);
    const before = fixture.capture();
    const mutations: ((s: ReturnType<DestructionFixture["capture"]>) => void)[] = [
      s => { s.world.state.objects[0].hp = 1; },
      s => { s.world.state.objects[0].detonated = false; },
      s => { s.world.state.pending[0].readyTick++; },
      s => { s.world.state.pending[0].sourceId = "barrel-a"; },
      s => { s.world.state.terrainRevision++; },
      s => { s.world.state.rewardTotal++; },
      s => { s.world.state.rewarded.pop(); },
      s => { s.world.state.receipts[0] = { ...s.world.state.receipts[0], damage: 999 }; },
      s => { s.world.state.counters.coverTests++; },
      s => { (s.world.history as DestructionInput[]).pop(); },
      s => { (s.body as { x: number }).x++; },
      s => { (s.commands as unknown[]).pop(); },
      s => { (s.world.configuration.objects[0].rect as { x: number }).x++; },
      s => { Object.assign(s, { extra: true }); },
    ];
    for (const mutate of mutations) {
      const corrupt = clone(before); mutate(corrupt);
      expect(() => fixture.restore(corrupt)).toThrow(); expect(fixture.capture()).toEqual(before);
      const world = new DamageableWorld(before.world.configuration); world.restore(before.world);
      if (canonicalDestructionData(corrupt.world) !== canonicalDestructionData(before.world)) {
        expect(() => world.restore(corrupt.world)).toThrow(); expect(world.capture()).toEqual(before.world);
      }
    }
    expect(() => fixture.load(fixture.save() + " ")).toThrow(/Noncanonical/);
    expect(() => fixture.load(fixture.save().replace('"x":636', '"x":-0'))).toThrow();
    expect(fixture.capture()).toEqual(before);
  });
  it("rejects hostile data without invoking accessors, including sparse arrays, symbols and negative zero", () => {
    let called = false;
    const getter = Object.defineProperty({}, "tick", { enumerable: true, get() { called = true; throw Error("getter ran"); } });
    const hidden = Object.defineProperty({}, "tick", { enumerable: false, value: 1 });
    const sparse: unknown[] = []; sparse.length = 1;
    for (const value of [getter, hidden, sparse, Object.assign([], { extra: 1 }), { [Symbol("bad")]: 1 }, { tick: -0 }, { tick: NaN }, new Date(), Object.create(null), { tick: undefined }]) expect(() => canonicalDestructionData(value)).toThrow();
    expect(called).toBe(false);
    const cycle: { self?: unknown } = {}; cycle.self = cycle;
    expect(() => canonicalDestructionData(cycle)).toThrow(/cap/);
    expect(DESTRUCTION_LIMITS.pending).toBe(DESTRUCTION_LIMITS.explosives);
  });
});
