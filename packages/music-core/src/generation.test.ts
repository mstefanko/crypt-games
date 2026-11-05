import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertScore } from "@onepage/project";
import { compileScore } from "./runtime";
import {
  canonicalMusicData,
  defaultMusicRecipe,
  generateMusicCandidates,
  musicDataHash,
  MusicGenerationSession,
  MUSIC_ROLES,
  reproduceMusicCandidate,
  validateMusicCandidate,
  validateMusicRecipe,
} from "./generation";
import {
  MUSIC_GENERATOR_SOURCE,
  MUSIC_GENERATOR_IDENTITY,
} from "./generation-version";
import { sha256Content } from "./generation-hash";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("seeded editable symbolic Music G0", () => {
  it("pins explicit algorithm identity independently of source formatting and portable UTF8 SHA256", () => {
    expect(MUSIC_GENERATOR_IDENTITY).toBe(
      "pocket-score/music-g0/symbolic-g0-v2/algorithm-v2",
    );
    expect(MUSIC_GENERATOR_SOURCE).toBe(
      `sha256:${createHash("sha256").update(MUSIC_GENERATOR_IDENTITY).digest("hex")}`,
    );
    for (const text of ["", "abc", "é🎵", "\ud800", "x".repeat(1000)])
      expect(sha256Content(text)).toBe(
        createHash("sha256").update(text).digest("hex"),
      );
    expect(canonicalMusicData({ z: -0, a: [2, 1] })).toBe('{"a":[2,1],"z":0}');
  });
  it("retains algorithm identity and candidate bytes after whitespace and CRLF source changes", async () => {
    const source = readFileSync(
      new URL("./generation.ts", import.meta.url),
      "utf8",
    );
    const built = await build({
      stdin: {
        contents:
          source.replace(/\n/g, "\r\n") +
          "\r\n// Formatting-only checkout variant\r\n",
        resolveDir: fileURLToPath(new URL(".", import.meta.url)),
        sourcefile: "formatting-proof.ts",
        loader: "ts",
      },
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      logLevel: "silent",
    });
    const variant = await import(
      /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`
    );
    expect(variant.MUSIC_GENERATOR_SOURCE).toBe(MUSIC_GENERATOR_SOURCE);
    expect(
      variant.generateMusicCandidates(variant.defaultMusicRecipe(), 1),
    ).toEqual(generateMusicCandidates(defaultMusicRecipe(), 1));
  });
  it("retains the original editable example as exact reviewed output", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("../../../examples/music-g0/candidate.json", import.meta.url),
        "utf8",
      ),
    );
    validateMusicCandidate(fixture);
    expect(generateMusicCandidates(defaultMusicRecipe(), 1)[0]).toEqual(
      fixture,
    );
  });
  it("produces exact deterministic ordinary scores, distinct alternatives and arrangements", () => {
    const recipe = defaultMusicRecipe(98213),
      a = generateMusicCandidates(recipe, 8),
      b = generateMusicCandidates(clone(recipe), 8);
    expect(a).toEqual(b);
    expect(
      new Set(
        a.map((c) =>
          canonicalMusicData(c.scores.high.patterns.map((p) => p.notes)),
        ),
      ).size,
    ).toBe(8);
    expect(
      generateMusicCandidates(defaultMusicRecipe(1), 1)[0].scores.high.patterns,
    ).not.toEqual(
      generateMusicCandidates(defaultMusicRecipe(5), 1)[0].scores.high.patterns,
    );
    for (const c of a) {
      validateMusicCandidate(c);
      expect(reproduceMusicCandidate(c)).toEqual(c);
      for (const score of Object.values(c.scores)) {
        expect(() => assertScore(score)).not.toThrow();
        expect(compileScore(score).length).toBeLessThanOrEqual(2048);
      }
      expect(c.provenance.scoreHashes.low).not.toBe(
        c.provenance.scoreHashes.high,
      );
      expect(c.provenance.recipeHash).toBe(musicDataHash(recipe));
    }
    expect(
      generateMusicCandidates(defaultMusicRecipe(98214))[0].scores.high
        .patterns[0].notes,
    ).not.toEqual(a[0].scores.high.patterns[0].notes);
  });
  it("covers both bar counts, densities, rhythms, modes, keys and register edges", () => {
    for (const bars of [8, 16] as const)
      for (const density of [1, 2, 3] as const)
        for (const rhythm of ["quarters", "eighths"] as const)
          for (const mode of ["major", "minor"] as const) {
            const r = defaultMusicRecipe(7);
            Object.assign(r, { bars, density, rhythm });
            r.key = { root: 11, mode };
            r.harmony = Array.from({ length: bars }, (_, i) =>
              i === bars - 1 ? 0 : i % 7,
            );
            r.registers = {
              melody: [84, 96],
              bass: [24, 36],
              harmony: [48, 60],
              drums: [36, 48],
            };
            const c = generateMusicCandidates(r, 1)[0];
            for (const score of Object.values(c.scores)) {
              const events = compileScore(score);
              expect(events.length).toBeLessThanOrEqual(2048);
              for (const e of events) {
                const [min, max] =
                  r.registers[e.trackId as (typeof MUSIC_ROLES)[number]];
                expect(e.pitch).toBeGreaterThanOrEqual(min);
                expect(e.pitch).toBeLessThanOrEqual(max);
                expect(e.startTick + e.durationTicks).toBeLessThanOrEqual(
                  score.lengthTicks,
                );
                expect(Math.floor(e.startTick / 1920)).toBe(
                  Math.floor((e.startTick + e.durationTicks - 1) / 1920),
                );
              }
              // Cadence leaves a rest at the loop join and returns the melodic pitch class to tonic.
              const melody = events.filter((e) => e.trackId === "melody");
              expect(melody.at(-1)!.pitch % 12).toBe(r.key.root);
              expect(
                score.lengthTicks -
                  melody.at(-1)!.startTick -
                  melody.at(-1)!.durationTicks,
              ).toBeGreaterThanOrEqual(480);
            }
          }
  });
  it("keeps exact previews without regeneration, undoes, isolates snapshots and fails atomically", () => {
    const session = new MusicGenerationSession(),
      recipe = defaultMusicRecipe(18),
      previews = session.preview(recipe);
    const expected = clone(previews[1]);
    previews[1].scores.high.title = "external mutation";
    expect(session.keep(1)).toEqual(expected);
    const selected = session.current()!;
    selected.scores.high.title = "external selected mutation";
    expect(session.current()).toEqual(expected);
    session.preview(recipe); // Failed requests preserve a still-current preview.
    const bad = clone(recipe);
    bad.seed = -1;
    expect(() => session.preview(bad)).toThrow();
    expect(session.keep(1)).toEqual(expected);
    expect(() => session.keep(99)).toThrow();
    expect(session.current()).toEqual(expected);
    expect(session.undo()).toEqual(expected);
    expect(session.undo()).toBeNull();
  });
  it("edits ordinary scores, preserves locked edited tracks in both intensities, and records lineage", () => {
    const session = new MusicGenerationSession(),
      recipe = defaultMusicRecipe(91);
    session.preview(recipe);
    const original = session.keep(0);
    const edit = clone(original.scores.high);
    edit.patterns[0].notes[0].velocity = 0.321;
    const edited = session.editSelected("high", edit);
    expect(edited.provenance.editedIntensities).toEqual(["high"]);
    expect(edited.provenance.resultHash).not.toBe(
      original.provenance.resultHash,
    );
    expect(() => reproduceMusicCandidate(edited)).toThrow(/frozen/);
    const next = session.preview({ ...recipe, seed: 92 }, 2, [
      "melody",
      "harmony",
    ])[1];
    for (const intensity of ["low", "high"] as const)
      for (const role of ["melody", "harmony"]) {
        for (const field of ["tracks", "patches", "patterns", "clips"] as const)
          expect(
            next.scores[intensity][field].find((item) => item.id === role),
          ).toEqual(
            edited.scores[intensity][field].find((item) => item.id === role),
          );
      }
    expect(next.provenance.parentResultHash).toBe(edited.provenance.resultHash);
    expect(next.scores.high.patterns[1].notes).toEqual(
      edited.scores.high.patterns[1].notes,
    ); // bass is deliberately stable accompaniment
    expect(session.undo()).toEqual(original);
    const invalid = clone(original.scores.high);
    invalid.patterns[0].notes[0].pitch = 0;
    expect(() => session.editSelected("high", invalid)).toThrow(/register/);
    expect(session.current()).toEqual(original);
    expect(() =>
      session.preview({ ...recipe, bpm: 113 }, 2, ["melody"]),
    ).toThrow(/seed changes only/);
    expect(session.current()).toEqual(original);
  });
  it("validates regenerated roles and metadata independently of inherited locked edits", () => {
    const session = new MusicGenerationSession(),
      recipe = defaultMusicRecipe(53);
    session.preview(recipe);
    const original = session.keep(0);
    const score = clone(original.scores.high);
    score.patterns[0].notes[0].velocity = 0.123;
    score.title = "Human title";
    score.sections[0].name = "Human phrase";
    const edited = session.editSelected("high", score);
    expect(edited.provenance.editedRoles).toEqual({
      low: [],
      high: ["melody"],
    });
    expect(edited.provenance.editedMetadata.high).toEqual([
      "title",
      "sections",
    ]);
    validateMusicCandidate(edited);
    const locked = session.preview({ ...recipe, seed: 54 }, 1, ["melody"])[0];
    expect(locked.provenance.editedRoles).toEqual({
      low: [],
      high: ["melody"],
    });
    expect(locked.provenance.editedMetadata).toEqual({ low: [], high: [] });
    expect(locked.scores.high.title).not.toBe("Human title");
    const rehash = (candidate: typeof locked) => {
      candidate.provenance.scoreHashes.high = musicDataHash(
        candidate.scores.high,
      );
      const { resultHash: _ignored, ...data } = candidate.provenance;
      candidate.provenance.resultHash = musicDataHash(data);
    };
    for (const mutate of [
      (c: typeof locked) => {
        c.scores.high.patterns[1].notes[0].velocity = 0.111;
      },
      (c: typeof locked) => {
        c.scores.high.id = "forged-id";
      },
      (c: typeof locked) => {
        c.scores.high.title = "forged-title";
      },
      (c: typeof locked) => {
        c.scores.high.sections[0].name = "forged-section";
      },
      (c: typeof locked) => {
        c.scores.high.sections[0].id = "forged-section-id";
      },
    ]) {
      const forged = clone(locked);
      mutate(forged);
      rehash(forged);
      expect(() => validateMusicCandidate(forged)).toThrow(/unedited/);
      expect(() =>
        generateMusicCandidates({ ...recipe, seed: 55 }, 1, forged, ["melody"]),
      ).toThrow(/unedited/);
    }
    // An edit to a role that is regenerated is not inherited as an exemption.
    const bassOnlyLock = session.preview({ ...recipe, seed: 54 }, 1, [
      "bass",
    ])[0];
    expect(bassOnlyLock.provenance.editedRoles.high).toEqual([]);
    expect(bassOnlyLock.provenance.editedIntensities).toEqual([]);
    expect(() => reproduceMusicCandidate(bassOnlyLock, edited)).not.toThrow();
  });
  it("invalidates preview candidates on keep, edit and undo parent changes", () => {
    const session = new MusicGenerationSession(),
      recipe = defaultMusicRecipe(41);
    session.preview(recipe);
    const a = session.keep(0);
    expect(() => session.keep(1)).toThrow(/unknown preview/);
    session.preview({ ...recipe, seed: 42 }, 2, ["melody"]);
    const edit = clone(a.scores.high);
    edit.title = "Changed selected parent";
    const edited = session.editSelected("high", edit);
    expect(() => session.keep(0)).toThrow(/unknown preview/);
    expect(session.current()).toEqual(edited);
    session.preview({ ...recipe, seed: 43 }, 2, ["melody"]);
    const b = session.keep(1);
    session.preview({ ...recipe, seed: 44 }, 2, ["bass"]);
    expect(session.undo()).toEqual(edited);
    expect(() => session.keep(0)).toThrow(/unknown preview/);
    expect(session.current()).not.toEqual(b);
    expect(session.undo()).toEqual(a);
    // Failed editing preserves the preview and selected parent; keeping stays valid.
    const preview = session.preview({ ...recipe, seed: 45 }, 1, ["melody"])[0];
    const invalid = clone(a.scores.high);
    invalid.patterns[0].notes[0].pitch = 0;
    expect(() => session.editSelected("high", invalid)).toThrow();
    expect(session.keep(0)).toEqual(preview);
  });
  it("reproduces locked unedited candidates only with their exact pinned parent", () => {
    const parent = generateMusicCandidates(defaultMusicRecipe(5), 1)[0];
    const child = generateMusicCandidates(defaultMusicRecipe(6), 2, parent, [
      "melody",
    ])[1];
    expect(() => reproduceMusicCandidate(child)).toThrow(/parent/);
    expect(reproduceMusicCandidate(child, parent)).toEqual(child);
  });
  it("rejects adversarial input and oversized work before generation", () => {
    const r = defaultMusicRecipe();
    for (const count of [0, 9, Infinity, NaN, 1.5])
      expect(() => generateMusicCandidates(r, count)).toThrow();
    for (const seed of [-1, 4294967296, NaN, Infinity, 0.1])
      expect(() => validateMusicRecipe({ ...r, seed })).toThrow();
    for (const bad of [
      { ...r, extra: true },
      { ...r, version: "future" },
      { ...r, bars: 64 },
      { ...r, motif: [null, null] },
      { ...r, motif: Array(9).fill(0) },
      { ...r, harmony: Array(8).fill(4) },
      { ...r, registers: { ...r.registers, melody: [60, 61] } },
    ])
      expect(() => validateMusicRecipe(bad)).toThrow();
    expect(() =>
      generateMusicCandidates(r, 1, undefined, ["melody"]),
    ).toThrow();
    expect(() =>
      generateMusicCandidates(r, 1, undefined, ["melody", "melody"]),
    ).toThrow();
    const c = generateMusicCandidates(r, 1)[0];
    for (const field of ["resultHash", "recipeHash", "sourceHash"] as const) {
      const bad = clone(c);
      bad.provenance[field] = "sha256:" + "0".repeat(64);
      expect(() => validateMusicCandidate(bad)).toThrow();
    }
    const bad = clone(c);
    bad.scores.high.patterns[0].notes = Array(129).fill(
      bad.scores.high.patterns[0].notes[0],
    );
    expect(() => validateMusicCandidate(bad)).toThrow(/allocation/);
    const forgery = clone(c);
    forgery.scores.high.patterns[0].notes[0].velocity = 0.321;
    forgery.provenance.scoreHashes.high = musicDataHash(forgery.scores.high);
    const { resultHash: _ignored, ...forgedIdentity } = forgery.provenance;
    forgery.provenance.resultHash = musicDataHash(forgedIdentity);
    expect(() => validateMusicCandidate(forgery)).toThrow(/unedited/);
    const shifted = clone(c);
    shifted.scores.high.clips[0].repeats = 1024;
    expect(() => validateMusicCandidate(shifted)).toThrow();
  });
  it("rejects getters without invoking them, custom arrays, symbols, hidden fields and cycles", () => {
    let calls = 0;
    const getter = () => {
      calls++;
      throw Error("must not execute");
    };
    const object = Object.defineProperty({}, "x", {
      get: getter,
      enumerable: true,
    });
    const array = Object.defineProperty([0], "0", {
      get: getter,
      enumerable: true,
    });
    const hidden = Object.defineProperty({}, "x", { value: 1 });
    const symbol = { [Symbol("x")]: 1 },
      custom = Object.assign([1], { extra: 1 });
    const sparse = new Array(1);
    Object.assign(sparse, { extra: 1 });
    const cycle: unknown[] = [];
    cycle.push(cycle);
    for (const bad of [
      object,
      array,
      hidden,
      symbol,
      custom,
      sparse,
      cycle,
      new Date(),
      { x: Infinity },
      { x: undefined },
      Array(4097).fill(0),
    ])
      expect(() => canonicalMusicData(bad)).toThrow();
    expect(calls).toBe(0);
  });
});
