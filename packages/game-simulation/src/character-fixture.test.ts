import { describe, expect, it } from "vitest";
import {
  createCharacterArenaFixture,
  type CharacterArenaFixture,
} from "./character-fixture";
import type { CharacterSessionAction } from "./character-session";
const submit = (f: CharacterArenaFixture, action: CharacterSessionAction) =>
  f.execute({
    id: `change-${f.observe().character.revision}`,
    revision: f.observe().character.revision,
    action,
  });
const created = () => {
  const f = createCharacterArenaFixture();
  submit(f, {
    kind: "create",
    buildId: "scout",
    appearanceId: "warm",
    displayName: "Scout",
  });
  return f;
};
const input = (fire = false) => ({
  moveX: 0,
  moveY: 0,
  aim: 0,
  fire,
  dash: false,
  shove: false,
});
describe("C1 actual arena consumer", () => {
  it("rejects equipment history after the saved encounter boundary atomically", () => {
    const f = created();
    f.start();
    f.step(input(true));
    const before = f.save();
    const altered = created();
    submit(altered, { kind: "equip", slotId: "weapon", itemId: "sword" });
    submit(altered, { kind: "equip", slotId: "weapon", itemId: null });
    // A valid standalone session returns to the same arena stats, but includes
    // gameplay edits after revision one, when this encounter already started.
    const forged = { ...f.capture(), session: altered.capture().session };
    expect(() => f.restore(forged)).toThrow("locked");
    expect(f.save()).toBe(before);
    for (const startRevision of [null, 0, -0, 2, 1.5, "1"]) {
      expect(() => f.restore({ ...f.capture(), startRevision })).toThrow();
      expect(f.save()).toBe(before);
    }
    expect(() =>
      f.restore({ ...f.capture(), format: "c1-character-arena-v1" }),
    ).toThrow();
    const prestart = created();
    expect(() =>
      prestart.restore({ ...prestart.capture(), startRevision: 1 }),
    ).toThrow();
  });
  it("creates, equips, saves and reopens before actual spawn/movement/combat", () => {
    const base = created();
    const equipped = created();
    submit(equipped, { kind: "equip", slotId: "weapon", itemId: "sword" });
    submit(equipped, { kind: "equip", slotId: "boots", itemId: "boots" });
    const reopened = createCharacterArenaFixture();
    reopened.load(equipped.save());
    expect(reopened.save()).toBe(equipped.save());
    base.start();
    reopened.start();
    expect(reopened.observe().arena!.actors[0].hp).toBe(4);
    base.step({ ...input(), moveX: 127 });
    reopened.step({ ...input(), moveX: 127 });
    expect(
      reopened.observe().arena!.actors[0].x - base.observe().arena!.actors[0].x,
    ).toBe(256);
    for (let tick = 0; tick < 12; tick++) {
      base.step(input(tick === 0));
      reopened.step(input(tick === 0));
    }
    expect(base.observe().arena!.actors[1].hp).toBe(6);
    expect(reopened.observe().arena!.actors[1].hp).toBe(4);
    expect(() =>
      submit(reopened, { kind: "equip", slotId: "weapon", itemId: null }),
    ).toThrow("locked");
  });
  it("keeps exact gameplay bytes through live cosmetic swaps, save/reopen and continuation", () => {
    const a = created();
    const b = created();
    a.start();
    b.start();
    for (let tick = 0; tick < 5; tick++) {
      a.step(input(tick === 0));
      b.step(input(tick === 0));
    }
    expect(a.observe().arena!.projectiles.length).toBeGreaterThan(0);
    submit(b, { kind: "customize", appearanceId: "cool", displayName: "春香" });
    expect(b.capture().arena).toBe(a.capture().arena);
    const resumed = createCharacterArenaFixture();
    resumed.load(b.save());
    expect(resumed.save()).toBe(b.save());
    for (let tick = 0; tick < 80; tick++) {
      const command = { ...input(tick % 17 === 0), moveY: tick < 10 ? 127 : 0 };
      a.step(command);
      b.step(command);
      resumed.step(command);
      expect(b.capture().arena).toBe(a.capture().arena);
      expect(resumed.save()).toBe(b.save());
    }
    expect(b.observe().character.character!.appearanceId).toBe("cool");
  });
  it("stages both owners on corrupt character/arena rejection", () => {
    const f = created();
    f.start();
    f.step(input(true));
    const before = f.save();
    const bad = f.capture();
    const arena = JSON.parse(bad.arena!);
    arena.actors[0].hp = 99;
    (bad as any).arena = JSON.stringify(arena);
    expect(() => f.restore(bad)).toThrow();
    expect(f.save()).toBe(before);
    const forged = f.capture();
    (forged.session.character as any).displayName = "forged";
    expect(() => f.restore(forged)).toThrow();
    expect(f.save()).toBe(before);
    let reads = 0;
    const getter = f.capture();
    Object.defineProperty(getter, "arena", {
      enumerable: true,
      get: () => {
        reads++;
        return null;
      },
    });
    expect(() => f.restore(getter)).toThrow("envelope");
    expect(reads).toBe(0);
    const symbol = f.capture();
    (symbol as any)[Symbol("extra")] = null;
    expect(() => f.restore(symbol)).toThrow("envelope");
    expect(() =>
      f.restore(Object.assign(Object.create({}), f.capture())),
    ).toThrow("envelope");
    const command: any = { id: "getter", revision: 1 };
    Object.defineProperty(command, "action", {
      enumerable: true,
      get: () => {
        reads++;
        return { kind: "customize" };
      },
    });
    expect(() => f.execute(command)).toThrow();
    expect(reads).toBe(0);
    expect(f.save()).toBe(before);
  });
});
