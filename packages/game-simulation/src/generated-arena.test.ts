import { createHash } from "node:crypto";
import { sha256Content } from "./content-hash";
import { describe, expect, it } from "vitest";
import {
  generateArenaManifest,
  validateArenaManifest,
  regenerateArenaManifest,
  freezeArenaManifest,
  editArenaRoom,
  canonicalArenaData,
  validateFrozenArenaProject,
  type GeneratedArenaRecipe,
} from "./generated-arena";
import {
  GeneratedArenaRun,
  arenaModifierStats,
  arenaRoomConfiguration,
} from "./generated-arena-run";
import { DestructionEncounter } from "./destruction-encounter";
const recipe: GeneratedArenaRecipe = {
  format: "generated-arena-recipe-v1",
  seed: 42,
  rooms: 4,
  branches: 1,
  theme: "forge",
};
function clear(run: GeneratedArenaRun) {
  for (let i = 0; i < 1000 && run.observe().phase === "active"; i++) {
    const obs = run.observe().run!.encounter!;
    if (!obs || obs.status !== "playing") break;
    const target = obs.enemies
      .filter((e) => e.hp > 0)
      .sort(
        (a, b) =>
          Math.abs(a.x - obs.player.x) +
          Math.abs(a.y - obs.player.y) -
          Math.abs(b.x - obs.player.x) -
          Math.abs(b.y - obs.player.y),
      )[0];
    const dx = target.x - obs.player.x,
      dy = target.y - obs.player.y;
    run.step({
      moveX: Math.abs(dy) < 96 && Math.abs(dx) < 512 ? -Math.sign(dx) : 0,
      moveY: Math.abs(dy) > 48 ? Math.sign(dy) : 0,
      aimX: Math.sign(dx),
      aimY: 0,
      fire: Math.abs(dy) < 96,
    });
  }
  expect(run.observe().phase).toBe("reward");
}
describe("bounded generated arena manifests", () => {
  it("sweeps 1000 fixed seeds across counts/themes and realizes actual spawn-valid P2 encounters", () => {
    const templates = new Set<string>(),
      choices = new Set<string>();
    for (let seed = 0; seed < 1000; seed++) {
      const manifest = generateArenaManifest({
        ...recipe,
        seed,
        rooms: 4 + (seed % 5),
        branches: seed % 2,
        theme: seed % 2 ? "forge" : "grove",
      });
      expect(canonicalArenaData(generateArenaManifest(manifest.recipe))).toBe(
        canonicalArenaData(manifest),
      );
      for (const room of manifest.rooms) {
        templates.add(room.templateId);
        choices.add(room.rewards.join(","));
        new DestructionEncounter(arenaRoomConfiguration(room, 20, []));
      }
    }
    expect(templates.size).toBe(16);
    expect(choices.size).toBe(7); // six reward pairs plus peaceful rooms
  });
  it("uses strong portable SHA256 over exact UTF8 canonical content", () => {
    const vectors: [string, string][] = [
      ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      [
        "abc",
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      ],
      [
        "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
      ],
    ];
    for (const [text, expected] of vectors)
      expect(sha256Content(text)).toBe(expected);
    for (const text of ["a".repeat(1000), "é😀\ud800\udc00\ud800x\udc00"])
      expect(sha256Content(text)).toBe(
        createHash("sha256").update(text).digest("hex"),
      );
    const manifest = generateArenaManifest(recipe),
      { digest, ...content } = manifest;
    expect(digest).toBe(
      `sha256:${createHash("sha256").update(canonicalArenaData(content)).digest("hex")}`,
    );
  });
  it("validates exact freezes, provenance and locks without mutating prior content", () => {
    const manifest = generateArenaManifest(recipe),
      before = canonicalArenaData(manifest);
    expect(freezeArenaManifest(manifest).manifest).toEqual(manifest);
    const next = regenerateArenaManifest(manifest, { ...recipe, seed: 100 }, [
      "room-1",
    ]);
    expect(next.rooms[1]).toEqual({ ...manifest.rooms[1], locked: true });
    expect(next.rooms[1].originSeed).toBe(42);
    expect(validateArenaManifest(next)).toEqual(next);
    expect(
      regenerateArenaManifest(next, { ...recipe, seed: 123 }).rooms[1],
    ).toEqual(next.rooms[1]);
    expect(
      regenerateArenaManifest(next, { ...recipe, seed: 123 }, []).rooms[1],
    ).toMatchObject({ locked: false, originSeed: 123 });
    expect(() =>
      regenerateArenaManifest(next, { ...recipe, branches: 0 }, ["room-1"]),
    ).toThrow(/boundary/);
    const forged = structuredClone(manifest);
    forged.rooms[1].placements[0].rect.y = 1536;
    expect(() => validateArenaManifest(forged)).toThrow();
    expect(() =>
      validateArenaManifest({ ...manifest, library: "missing" }),
    ).toThrow(/pins/);
    expect(canonicalArenaData(manifest)).toBe(before);
  });
  it("freezes and plays an explicit bounded authored edit while rejecting broken traversal/spawns", () => {
    const manifest = generateArenaManifest(recipe),
      placements = structuredClone(manifest.rooms[1].placements);
    placements[0].rect.x = 1024;
    placements[0].rect.y = 256;
    const edited = editArenaRoom(manifest, "room-1", placements);
    expect(edited.rooms[1]).toMatchObject({
      locked: true,
      edited: true,
      originSeed: 42,
    });
    expect(edited.digest).not.toBe(manifest.digest);
    const frozen = freezeArenaManifest(edited),
      run = new GeneratedArenaRun();
    run.startManifest(frozen);
    run.travel("room-1");
    expect(
      run
        .capture()
        .run!.rooms[0].encounter.configuration.objects.find(
          (o) => o.id === "cover",
        )!.rect,
    ).toEqual(placements[0].rect);
    const restored = new GeneratedArenaRun();
    restored.load(run.save());
    expect(restored.capture()).toEqual(run.capture());
    expect(
      regenerateArenaManifest(edited, { ...recipe, seed: 99 }, ["room-1"])
        .rooms[1].placements,
    ).toEqual(placements);
    const blocked = structuredClone(placements);
    blocked[0].rect.y = 1536;
    expect(() => editArenaRoom(manifest, "room-1", blocked)).toThrow(
      /traversal/,
    );
    const embedded = structuredClone(placements);
    embedded[0].rect.x = 3072;
    embedded[0].rect.y = 1536;
    expect(() => editArenaRoom(manifest, "room-1", embedded)).toThrow(/spawn/);
    expect(manifest.rooms[1].edited).toBe(false);
    expect(
      regenerateArenaManifest(edited, { ...recipe, seed: 456 }).rooms[1],
    ).toEqual(edited.rooms[1]);
    expect(
      regenerateArenaManifest(edited, { ...recipe, seed: 456 }, []).rooms[1],
    ).toMatchObject({ locked: false, edited: false, originSeed: 456 });
  });
  it("validates complete frozen wrappers and exact unedited traversal provenance", () => {
    const manifest = generateArenaManifest(recipe),
      frozen = freezeArenaManifest(manifest),
      run = new GeneratedArenaRun();
    expect(validateFrozenArenaProject(frozen)).toEqual(frozen);
    const before = run.save();
    for (const value of [
      { ...frozen, extra: true },
      { ...frozen, format: "editable-arena-project-v99" },
      { ...frozen, manifest: { ...manifest, extra: true } },
    ]) {
      expect(() => validateFrozenArenaProject(value)).toThrow();
      expect(() => run.startManifest(value)).toThrow();
      expect(run.save()).toBe(before);
    }
    const forged = structuredClone(manifest);
    forged.rooms[1].traversal.splice(1, 0, { x: 2048, y: 1600 });
    forged.work = forged.rooms.reduce(
      (sum, room) => sum + 16 + room.placements.length * room.traversal.length,
      0,
    );
    const { digest: _old, ...content } = forged;
    forged.digest = `sha256:${sha256Content(canonicalArenaData(content))}`;
    expect(() => validateArenaManifest(forged)).toThrow(/unedited traversal/);
  });
  it("rejects unsafe descriptors and malformed bounds before reading them", () => {
    let reads = 0;
    const bad = { ...recipe };
    Object.defineProperty(bad, "seed", {
      get() {
        reads++;
        return 42;
      },
      enumerable: true,
    });
    expect(() => generateArenaManifest(bad)).toThrow(/accessor/);
    expect(reads).toBe(0);
    for (const value of [
      { ...recipe, rooms: 9 },
      { ...recipe, rooms: 3 },
      { ...recipe, branches: 2 },
      { ...recipe, seed: -0 },
    ])
      expect(() => generateArenaManifest(value)).toThrow();
  });
});
describe("generated arena run lifecycle", () => {
  it("uses actual combat, exact partial continuation, seeded choices and immutable revisits", () => {
    const run = new GeneratedArenaRun();
    run.start(recipe);
    run.travel("room-1");
    for (let i = 0; i < 3; i++)
      run.step({ moveX: 0, moveY: 0, aimX: 1, aimY: 0, fire: true });
    const restored = new GeneratedArenaRun();
    restored.load(run.save());
    expect(restored.capture()).toEqual(run.capture());
    clear(run);
    clear(restored);
    expect(restored.capture()).toEqual(run.capture());
    const choice = run.observe().run!.manifest.rooms[1].rewards[0];
    run.chooseReward(choice);
    const health = run.observe().run!.health,
      room = run.capture().run!.rooms.find((s) => s.roomId === "room-1");
    run.travel("room-0");
    run.travel("room-1");
    expect(run.observe().run!.health).toBe(health);
    expect(run.capture().run!.rooms.find((s) => s.roomId === "room-1")).toEqual(
      room,
    );
    const before = run.save();
    expect(() => run.chooseReward(choice)).toThrow();
    expect(() => run.travel("missing")).toThrow();
    expect(run.save()).toBe(before);
    restored.load(run.save());
    expect(restored.capture()).toEqual(run.capture());
  });
  it("clears boss through input, keeps one durable grove unlock and resets run-only state", () => {
    const run = new GeneratedArenaRun();
    expect(() => run.start({ ...recipe, theme: "grove" })).toThrow(/unlock/);
    run.start(recipe);
    run.travel("room-1");
    clear(run);
    run.chooseReward(run.observe().run!.manifest.rooms[1].rewards[0]);
    run.travel("room-3");
    clear(run);
    run.chooseReward(run.observe().run!.manifest.rooms[3].rewards[0]);
    expect(run.observe().phase).toBe("complete");
    expect(run.observe().durableUnlock).toBe(true);
    expect(run.capture().run!.transactions.flags).toEqual([
      { id: "boss-unlock", value: true },
    ]);
    expect(run.capture().run!.transactions.revision).toBe(2);
    const restored = new GeneratedArenaRun();
    restored.load(run.save());
    expect(restored.capture()).toEqual(run.capture());
    run.reset();
    expect(run.observe()).toEqual({
      phase: "hub",
      durableUnlock: true,
      run: null,
    });
    restored.load(run.save());
    run.start({ ...recipe, theme: "grove" });
    expect(run.observe().run!.modifiers).toEqual([]);
    expect(run.observe().run!.health).toBe(20);
    const active = new GeneratedArenaRun();
    active.load(run.save());
    expect(active.capture()).toEqual(run.capture());
  });
  it("intentionally earns Grove from a validated edited Forge and observes current healed health", () => {
    let selected = generateArenaManifest(recipe);
    for (let seed = 0; !selected.rooms[1].rewards.includes("vitality"); seed++)
      selected = generateArenaManifest({ ...recipe, seed });
    const placements = structuredClone(selected.rooms[3].placements);
    placements[0].rect.x = 1024;
    placements[0].rect.y = 256;
    const edited = editArenaRoom(selected, "room-3", placements),
      run = new GeneratedArenaRun();
    run.startManifest(freezeArenaManifest(edited));
    run.travel("room-1");
    clear(run);
    run.chooseReward("vitality");
    const health = run.observe().run!.health;
    expect(run.observe().run!.encounter!.player).toMatchObject({
      hp: health,
      maxHp: 24,
    });
    const exact = run
      .capture()
      .run!.rooms.find((room) => room.roomId === "room-1")!.encounter;
    run.travel("room-0");
    run.travel("room-1");
    expect(run.observe().run!.encounterRetained).toBe(true);
    expect(run.observe().run!.encounter!.player).toMatchObject({
      hp: health,
      maxHp: 24,
    });
    expect(
      run.capture().run!.rooms.find((room) => room.roomId === "room-1")!
        .encounter,
    ).toEqual(exact);
    run.travel("room-3");
    clear(run);
    run.chooseReward(run.observe().run!.manifest.rooms[3].rewards[0]);
    expect(run.observe().durableUnlock).toBe(true);
    const restored = new GeneratedArenaRun();
    restored.load(run.save());
    restored.reset();
    restored.start({ ...recipe, theme: "grove" });
    expect(restored.observe().run!.manifest.recipe.theme).toBe("grove");
  });
  it("rejects forged clear/reward/duplicate/incomplete-unlock progression and fabricated P2 victories atomically", () => {
    const run = new GeneratedArenaRun();
    run.start(recipe);
    run.travel("room-1");
    const initial = run.capture(),
      before = run.save();
    const mutations: ((s: ReturnType<typeof run.capture>) => void)[] = [
      (s) => {
        s.run!.cleared.push("room-1");
        s.phase = "reward";
      },
      (s) => {
        s.run!.events.push({
          kind: "reward",
          reward: s.run!.manifest.rooms[1].rewards[0],
        });
        s.run!.claimed.push("room-1");
      },
      (s) => {
        s.durableUnlock = true;
        s.unlockProof = structuredClone(s.run);
        s.run = null;
        s.phase = "hub";
      },
      (s) => {
        const c = s.run!.rooms[0].encounter;
        c.replay = [
          {
            ticks: 20,
            input: { moveX: 0, moveY: 0, aimX: 1, aimY: 0, fire: false },
          },
        ];
        c.state.tick = 20;
        c.state.world.tick = 20;
        c.state.enemies[0].hp = 0;
        c.state.status = "cleared";
        s.run!.cleared.push("room-1");
        s.phase = "reward";
      },
    ];
    for (const mutate of mutations) {
      const bad = structuredClone(initial);
      mutate(bad);
      expect(() => run.restore(bad)).toThrow();
      expect(run.save()).toBe(before);
    }
    clear(run);
    run.chooseReward(run.observe().run!.manifest.rooms[1].rewards[0]);
    const claimed = run.save(),
      duplicate = run.capture();
    duplicate.run!.events.push({ ...duplicate.run!.events.at(-1)! });
    expect(() => run.restore(duplicate)).toThrow();
    expect(run.save()).toBe(claimed);
  });
  it("rejects the aggregate replay quota before the authoritative step changes state", () => {
    const run = new GeneratedArenaRun();
    run.start(recipe);
    run.travel("room-1");
    const corners = [
      { x: 256, y: 128 },
      { x: 3712, y: 128 },
      { x: 3712, y: 2816 },
      { x: 256, y: 2816 },
    ];
    let corner = 0;
    for (let tick = 0; tick < 512; tick++) {
      const p = run.observe().run!.encounter!.player,
        target = corners[corner];
      if (Math.abs(p.x - target.x) < 128 && Math.abs(p.y - target.y) < 128) {
        corner = (corner + 1) % corners.length;
      }
      const next = corners[corner];
      run.step({
        moveX: Math.sign(next.x - p.x),
        moveY: Math.sign(next.y - p.y),
        aimX: tick % 2 ? 1 : -1,
        aimY: 0,
        fire: false,
      });
    }
    expect(run.observe().phase).toBe("active");
    const before = run.save();
    expect(() =>
      run.step({ moveX: 0, moveY: 0, aimX: 1, aimY: 0, fire: false }),
    ).toThrow(/aggregate replay quota/);
    expect(run.save()).toBe(before);
    const restored = new GeneratedArenaRun();
    restored.load(before);
    expect(restored.capture()).toEqual(run.capture());
  });
  it("restores a post-unlock run above the first-run replay reservation after progression", () => {
    const run = new GeneratedArenaRun();
    run.start(recipe);
    run.travel("room-1");
    clear(run);
    run.chooseReward(run.observe().run!.manifest.rooms[1].rewards[0]);
    run.travel("room-3");
    clear(run);
    run.chooseReward(run.observe().run!.manifest.rooms[3].rewards[0]);
    run.reset();
    run.start({ ...recipe, seed: 73 });
    run.travel("room-1");
    const corners = [
      { x: 256, y: 128 },
      { x: 3712, y: 128 },
      { x: 3712, y: 2816 },
      { x: 256, y: 2816 },
    ];
    let corner = 0;
    for (let tick = 0; tick < 520; tick++) {
      const p = run.observe().run!.encounter!.player,
        target = corners[corner];
      if (Math.abs(p.x - target.x) < 128 && Math.abs(p.y - target.y) < 128)
        corner = (corner + 1) % corners.length;
      const next = corners[corner];
      run.step({
        moveX: Math.sign(next.x - p.x),
        moveY: Math.sign(next.y - p.y),
        aimX: tick % 2 ? 1 : -1,
        aimY: 0,
        fire: false,
      });
    }
    expect(run.capture().run!.rooms[0].encounter.replay.length).toBeGreaterThan(
      512,
    );
    clear(run);
    run.chooseReward(run.observe().run!.manifest.rooms[1].rewards[0]);
    run.travel("room-0");
    const before = run.save(),
      restored = new GeneratedArenaRun();
    restored.load(before);
    expect(restored.save()).toBe(before);
    run.travel("room-1");
    restored.travel("room-1");
    expect(restored.capture()).toEqual(run.capture());
  });
  it("records real defeat, preserves recovery, and restores the maximum room graph", () => {
    const dead = new GeneratedArenaRun();
    dead.start(recipe);
    dead.travel("room-1");
    for (let i = 0; i < 1000 && dead.observe().phase === "active"; i++)
      dead.step({ moveX: 0, moveY: 0, aimX: 1, aimY: 0, fire: false });
    expect(dead.observe().phase).toBe("failed");
    const failed = new GeneratedArenaRun();
    failed.load(dead.save());
    expect(failed.capture()).toEqual(dead.capture());
    const before = dead.save();
    expect(() => dead.travel("room-0")).toThrow();
    expect(dead.save()).toBe(before);
    dead.reset();
    expect(dead.observe().durableUnlock).toBe(false);
    const run = new GeneratedArenaRun();
    run.start({ ...recipe, rooms: 8, branches: 0 });
    for (let i = 1; i < 8; i++) {
      run.travel(`room-${i}`);
      if (run.observe().run!.encounter) {
        clear(run);
        run.chooseReward(run.observe().run!.manifest.rooms[i].rewards[0]);
      }
    }
    expect(run.observe().phase).toBe("complete");
    const restored = new GeneratedArenaRun();
    restored.load(run.save());
    expect(restored.capture()).toEqual(run.capture());
    expect(run.save().length).toBeLessThan(262144);
  });
  it("preserves atomic rejected saves, duplicate claims and failed generation", () => {
    const run = new GeneratedArenaRun();
    run.start(recipe);
    const before = run.save();
    for (const mutate of [
      (s: ReturnType<typeof run.capture>) => {
        s.durableUnlock = true;
      },
      (s: ReturnType<typeof run.capture>) => {
        s.run!.health = 999;
      },
      (s: ReturnType<typeof run.capture>) => {
        s.run!.manifest.rooms.pop();
      },
    ]) {
      const s = run.capture();
      mutate(s);
      expect(() => run.restore(s)).toThrow();
      expect(run.save()).toBe(before);
    }
    expect(() => run.start({ ...recipe, rooms: 99 })).toThrow();
    expect(run.save()).toBe(before);
    expect(() =>
      run.load(before.replace('"health":20', '"health":-0')),
    ).toThrow();
    expect(arenaModifierStats(["power", "focus"])).toEqual({
      damage: 4,
      maxHealth: 20,
    });
    expect(arenaModifierStats(["vitality"])).toEqual({
      damage: 2,
      maxHealth: 24,
    });
  });
});
