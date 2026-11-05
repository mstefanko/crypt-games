import { describe, expect, it } from "vitest";
import { CHARACTER_ARENA_CATALOG, createCharacterArenaFixture } from "@onepage/game-simulation/character-fixture";
import { CHARACTER_ARENA_VISUAL_ASSETS, sampleCharacterPresentation, type CharacterPresentationPose } from "./character";

const pose: CharacterPresentationPose = { controller: "arena-v1", definitionId: "character-arena-v1", entityId: 1, tick: 0, x: 25, y: 90, facing: 1, action: "idle" };
const selection = { archetypeId: "arena-hero", appearanceId: "warm", displayName: "Scout" };
const sample = (p = pose, s = selection, assets = CHARACTER_ARENA_VISUAL_ASSETS, catalog = CHARACTER_ARENA_CATALOG) => sampleCharacterPresentation(catalog, s, p, assets);
describe("C1 layered presentation", () => {
  it("resolves catalog pins, preserves authored part order and samples the existing kit", () => {
    const a = sample();
    expect(a).toMatchObject({ appearanceId: "warm", assetId: "hero-atlas", animationSetId: "hero-arena", paletteId: "warm", frameId: "idle-a", x: 25, y: 90, facing: 1 });
    expect(a.parts.map(p => p.partId)).toEqual(["cape", "body"]);
    expect(a.parts.map(p => p.depth)).toEqual([0, 1]);
    // Recipe storage order is irrelevant; catalog order owns assembly.
    const assets = structuredClone(CHARACTER_ARENA_VISUAL_ASSETS);
    (assets[0].animationSets[0].clips[0].frames[0].parts as any).reverse();
    expect(sample(pose, selection, assets)).toEqual(a);
    expect(sample({ ...pose, tick: 6 }).frameId).toBe("idle-b");
    expect(sample({ ...pose, tick: 12 }).frameId).toBe("idle-a");
    expect(sample({ ...pose, tick: 6, action: "move" }).frameId).toBe("move-b");
    expect(sample({ ...pose, tick: 1000, action: "hurt" }).frameId).toBe("hurt");
    expect(sample({ ...pose, tick: 6, reducedMotion: true }).frameId).toBe("idle-a");
    expect(sample({ ...pose, facing: -1 }).facing).toBe(-1);
  });
  it("changes actual selected pixels while gameplay checkpoints and body stay exact", () => {
    const f = createCharacterArenaFixture();
    f.execute({ id: "create", revision: 0, action: { kind: "create", buildId: "scout", appearanceId: "warm", displayName: "Scout" } });
    f.start();
    const before = f.capture().arena;
    const body = f.observe().motion!.body;
    const warm = sample();
    f.execute({ id: "cool", revision: 1, action: { kind: "customize", appearanceId: "cool", displayName: "春香" } });
    const cool = sample(pose, { ...selection, ...f.observe().character.character! });
    expect(cool.parts[1].colors).not.toEqual(warm.parts[1].colors);
    expect(cool.parts[1].rows).toEqual(warm.parts[1].rows);
    expect(cool.displayName).toBe("春香");
    cool.parts[0].rows[0] = "mutated";
    cool.parts[0].colors[1] = "mutated";
    expect(sample().parts[0].rows[0]).not.toBe("mutated");
    expect(sample().parts[0].colors[1]).not.toBe("mutated");
    expect(f.capture().arena).toBe(before);
    expect(f.observe().motion!.body).toEqual(body);
  });
  it("falls back only to authored idle and rejects missing asset/controller/palette/part pins", () => {
    const fallback = structuredClone(CHARACTER_ARENA_VISUAL_ASSETS);
    (fallback[0].animationSets[0] as any).clips = fallback[0].animationSets[0].clips.filter(c => c.action === "idle");
    expect(sample({ ...pose, action: "dash" }, selection, fallback).action).toBe("idle");
    for (const change of [
      (assets: any) => { assets[0].id = "missing"; },
      (assets: any) => { assets[0].palettes = []; },
      (assets: any) => { assets[0].animationSets = []; },
      (assets: any) => { assets[0].animationSets[0].clips = []; },
      (assets: any) => { assets[0].animationSets[0].clips[0].frames[0].parts = []; },
      (assets: any) => { assets[0].animationSets[0].clips[0].frames[0].parts[0].rows[0] = "f".repeat(12); },
      (assets: any) => { assets[0].animationSets[0].clips[0].frames[0].durationTicks = 0; },
      (assets: any) => { assets.push(assets[0]); },
      (assets: any) => { assets[0].palettes.push(assets[0].palettes[0]); },
      (assets: any) => { assets[0].animationSets.push(assets[0].animationSets[0]); },
      (assets: any) => { assets[0].animationSets[0].clips.push(assets[0].animationSets[0].clips[0]); },
    ]) {
      const assets = structuredClone(CHARACTER_ARENA_VISUAL_ASSETS);
      change(assets);
      expect(() => sample(pose, selection, assets)).toThrow();
    }
    expect(() => sample({ ...pose, definitionId: "other" })).toThrow("controller");
    expect(() => sample({ ...pose, controller: "platform-combat-v1" })).toThrow("controller");
    expect(() => sample(pose, { ...selection, appearanceId: "missing" })).toThrow();
    const multiplePalettes = structuredClone(CHARACTER_ARENA_CATALOG);
    (multiplePalettes.appearances[0] as any).paletteIds = ["warm", "cool"];
    expect(() => sample(pose, selection, CHARACTER_ARENA_VISUAL_ASSETS, multiplePalettes)).toThrow();
  });
  it("rejects invalid bounded samples without changing source selections or prepared assets", () => {
    const before = JSON.stringify([CHARACTER_ARENA_CATALOG, CHARACTER_ARENA_VISUAL_ASSETS]);
    for (const change of [{ tick: -1 }, { tick: 0.5 }, { x: NaN }, { entityId: 0 }, { facing: 0 }, { action: "attack" }, { reducedMotion: 1 }])
      expect(() => sample({ ...pose, ...change } as any)).toThrow();
    const assets = structuredClone(CHARACTER_ARENA_VISUAL_ASSETS);
    (assets[0].animationSets[0].clips[0].frames[0].parts[0] as any).width = 129;
    expect(() => sample(pose, selection, assets)).toThrow();
    const many = Array(257).fill(CHARACTER_ARENA_VISUAL_ASSETS[0]);
    expect(() => sample(pose, selection, many)).toThrow();
    expect(JSON.stringify([CHARACTER_ARENA_CATALOG, CHARACTER_ARENA_VISUAL_ASSETS])).toBe(before);
  });
});

it("validates unsampled clips and later frames, and requires idle even when another action exists", () => {
  for (const change of [
    (assets: any) => { assets[0].animationSets[0].clips.find((c: any) => c.action === "dash").frames[0].parts[0].width = 0; },
    (assets: any) => { assets[0].animationSets[0].clips[0].frames[1].parts = []; },
    (assets: any) => { assets[0].animationSets[0].clips = assets[0].animationSets[0].clips.filter((c: any) => c.action !== "idle"); },
  ]) {
    const assets = structuredClone(CHARACTER_ARENA_VISUAL_ASSETS);
    change(assets);
    expect(() => sample({ ...pose, action: "move" }, selection, assets)).toThrow();
  }
});
