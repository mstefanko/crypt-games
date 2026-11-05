import { assertScore, type Score, type Note } from "@onepage/project";
import { compileScore } from "./runtime";
import { sha256Content } from "./generation-hash";
import { MUSIC_GENERATOR_SOURCE } from "./generation-version";
export {
  MUSIC_GENERATOR_SOURCE,
  MUSIC_GENERATOR_IDENTITY,
} from "./generation-version";

export const MUSIC_GENERATOR_VERSION = "symbolic-g0-v2" as const;
export const MUSIC_ROLES = ["melody", "bass", "harmony", "drums"] as const;
export type MusicRole = (typeof MUSIC_ROLES)[number];
export type MusicIntensity = "low" | "high";
export const MUSIC_EDITABLE_METADATA = ["id", "title", "sections"] as const;
export type MusicMetadataField = (typeof MUSIC_EDITABLE_METADATA)[number];
export interface MusicRecipe {
  version: typeof MUSIC_GENERATOR_VERSION;
  seed: number;
  bars: 8 | 16;
  bpm: number;
  meter: [4, 4];
  key: { root: number; mode: "major" | "minor" };
  /** Scale degrees, with null representing an intentional rest. */
  motif: (number | null)[];
  /** One scale-degree triad root per bar; the last bar must resolve to tonic. */
  harmony: number[];
  registers: Record<MusicRole, [number, number]>;
  rhythm: "quarters" | "eighths";
  density: 1 | 2 | 3;
  form: "ABAC";
  roles: ["melody", "bass", "harmony", "drums"];
  energyPlan: ["low", "high"];
}
export interface MusicCandidate {
  scores: Record<MusicIntensity, Score>;
  provenance: {
    version: typeof MUSIC_GENERATOR_VERSION;
    sourceHash: string;
    recipe: MusicRecipe;
    recipeHash: string;
    alternative: number;
    scoreHashes: Record<MusicIntensity, string>;
    lockedRoles: MusicRole[];
    editedIntensities: MusicIntensity[];
    editedRoles: Record<MusicIntensity, MusicRole[]>;
    editedMetadata: Record<MusicIntensity, MusicMetadataField[]>;
    parentResultHash: string | null;
    resultHash: string;
  };
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function fail(message: string): never {
  throw new Error(`Music G0: ${message}`);
}
/** Canonical JSON uses ordinal object keys, preserves array order and normalizes -0.
 * Only finite numbers, dense arrays and plain own data are accepted, before hashing. */
export function canonicalMusicData(value: unknown): string {
  let nodes = 0;
  function walk(v: unknown, depth: number): unknown {
    if (++nodes > 40000 || depth > 12) fail("document work limit");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number")
      return Number.isFinite(v)
        ? Object.is(v, -0)
          ? 0
          : v
        : fail("nonfinite number");
    if (typeof v === "string")
      return v.length <= 2048 ? v : fail("string limit");
    if (Array.isArray(v)) {
      if (
        Object.getPrototypeOf(v) !== Array.prototype ||
        v.length > 4096 ||
        Reflect.ownKeys(v).length !== v.length + 1
      )
        fail("array limit or extra fields");
      const result: unknown[] = [];
      for (let i = 0; i < v.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(v, String(i));
        if (
          !descriptor ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, "value")
        )
          fail("dense data arrays required");
        result.push(walk(descriptor.value, depth + 1));
      }
      return result;
    }
    if (
      !v ||
      typeof v !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(v))
    )
      fail("plain JSON required");
    const ownKeys = Reflect.ownKeys(v);
    if (ownKeys.length > 64 || ownKeys.some((key) => typeof key !== "string"))
      fail("object limit or symbol fields");
    const keys = (ownKeys as string[]).sort();
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
      if (
        key === "__proto__" ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      )
        fail("unsafe object field");
      result[key] = walk(descriptor.value, depth + 1);
    }
    return result;
  }
  const bytes = JSON.stringify(walk(value, 0));
  if (bytes.length > 262144) fail("document byte limit");
  return bytes;
}
export const musicDataHash = (v: unknown): string =>
  `sha256:${sha256Content(canonicalMusicData(v))}`;
function fields(
  v: unknown,
  keys: string[],
): asserts v is Record<string, unknown> {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).sort().join() !== [...keys].sort().join()
  )
    fail("unexpected fields");
}
function integer(v: unknown, min: number, max: number): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}
export function validateMusicRecipe(
  value: unknown,
): asserts value is MusicRecipe {
  canonicalMusicData(value);
  fields(value, [
    "version",
    "seed",
    "bars",
    "bpm",
    "meter",
    "key",
    "motif",
    "harmony",
    "registers",
    "rhythm",
    "density",
    "form",
    "roles",
    "energyPlan",
  ]);
  if (
    value.version !== MUSIC_GENERATOR_VERSION ||
    !integer(value.seed, 0, 4294967295) ||
    ![8, 16].includes(value.bars as number) ||
    !integer(value.bpm, 60, 180)
  )
    fail("version, seed, bars or tempo");
  if (
    JSON.stringify(value.meter) !== "[4,4]" ||
    value.form !== "ABAC" ||
    JSON.stringify(value.roles) !== JSON.stringify(MUSIC_ROLES) ||
    JSON.stringify(value.energyPlan) !== '["low","high"]'
  )
    fail("unsupported meter/form/roles/energy plan");
  fields(value.key, ["root", "mode"]);
  if (
    !integer(value.key.root, 0, 11) ||
    !["major", "minor"].includes(value.key.mode as string)
  )
    fail("key");
  if (
    !Array.isArray(value.motif) ||
    value.motif.length < 2 ||
    value.motif.length > 8 ||
    !value.motif.every((v) => v === null || integer(v, 0, 6)) ||
    value.motif.every((v) => v === null)
  )
    fail("motif");
  if (
    !Array.isArray(value.harmony) ||
    value.harmony.length !== value.bars ||
    !value.harmony.every((v) => integer(v, 0, 6)) ||
    value.harmony.at(-1) !== 0
  )
    fail("harmony must end at tonic");
  if (
    !["quarters", "eighths"].includes(value.rhythm as string) ||
    ![1, 2, 3].includes(value.density as number)
  )
    fail("rhythm/density");
  fields(value.registers, [...MUSIC_ROLES]);
  for (const role of MUSIC_ROLES) {
    const range = value.registers[role];
    if (
      !Array.isArray(range) ||
      range.length !== 2 ||
      !integer(range[0], 24, 96) ||
      !integer(range[1], 24, 96) ||
      range[1] - range[0] < 12 ||
      range[1] - range[0] > 36
    )
      fail("register requires 12–36 semitones within MIDI 24–96");
  }
}
export function defaultMusicRecipe(seed = 1): MusicRecipe {
  return {
    version: MUSIC_GENERATOR_VERSION,
    seed,
    bars: 8,
    bpm: 112,
    meter: [4, 4],
    key: { root: 0, mode: "minor" },
    motif: [0, 2, 4, null, 3, 2, 1, 0],
    harmony: [0, 5, 3, 4, 0, 5, 4, 0],
    registers: {
      melody: [60, 84],
      bass: [36, 55],
      harmony: [48, 72],
      drums: [36, 60],
    },
    rhythm: "eighths",
    density: 2,
    form: "ABAC",
    roles: [...MUSIC_ROLES],
    energyPlan: ["low", "high"],
  };
}
function resolvedScore(
  recipe: MusicRecipe,
  alternative: number,
  intensity: MusicIntensity,
): Score {
  let state = (recipe.seed + alternative * 2654435761) >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const scale =
    recipe.key.mode === "major"
      ? [0, 2, 4, 5, 7, 9, 11]
      : [0, 2, 3, 5, 7, 8, 10];
  const pitch = (role: MusicRole, degree: number, previous?: number) => {
    const pc = (recipe.key.root + scale[((degree % 7) + 7) % 7]) % 12;
    const [min, max] = recipe.registers[role];
    const choices: number[] = [];
    for (let p = min; p <= max; p++) if (p % 12 === pc) choices.push(p);
    return choices.sort(
      (a, b) =>
        Math.abs(a - (previous ?? (min + max) / 2)) -
          Math.abs(b - (previous ?? (min + max) / 2)) || a - b,
    )[0];
  };
  const length = recipe.bars * 1920;
  const score: Score = {
    schemaVersion: 1,
    id: `g0-${recipe.seed}-${alternative}-${intensity}`,
    title: `Seed ${recipe.seed} · variation ${alternative + 1} · ${intensity}`,
    ppq: 480,
    bpm: recipe.bpm,
    meter: [4, 4],
    scale: clone(recipe.key),
    playback: "loop",
    lengthTicks: length,
    loop: { startTick: 0, endTick: length },
    tracks: [],
    patches: [],
    patterns: [],
    clips: [],
    sections: [],
  };
  for (let part = 0; part < 4; part++)
    score.sections.push({
      id: `phrase-${part}`,
      name: "ABAC"[part],
      startTick: (part * length) / 4,
      lengthTicks: length / 4,
    });
  for (const role of MUSIC_ROLES) {
    score.tracks.push({
      id: role,
      name: role,
      role,
      patchId: role,
      gain: role === "drums" ? 0.18 : role === "melody" ? 0.5 : 0.3,
      pan: role === "harmony" ? -0.2 : 0,
      minEnergy: 1,
    });
    score.patches.push({
      id: role,
      name: role,
      waveform:
        role === "drums"
          ? "noise"
          : role === "bass"
            ? "triangle"
            : role === "melody"
              ? "pulse"
              : "sine",
      attack: 0.01,
      release: 0.04,
      brightness: 0.5,
      duty: 0.5,
    });
    const notes: Note[] = [];
    const add = (
      bar: number,
      tick: number,
      duration: number,
      p: number,
      velocity = 0.7,
    ) =>
      notes.push({
        id: `${role}-${notes.length}`,
        startTick: bar * 1920 + tick,
        durationTicks: Math.min(duration, 1920 - tick),
        pitch: p,
        velocity,
      });
    let previous: number | undefined;
    // Each role has an independent deterministic stream: changing another role cannot
    // advance this role's choices. A/A' repeat; B responds; C cadences with a rest.
    for (let bar = 0; bar < recipe.bars; bar++) {
      const chord = recipe.harmony[bar],
        phrase = Math.floor(bar / (recipe.bars / 4));
      const phraseEnd = (bar + 1) % (recipe.bars / 4) === 0;
      if (role === "melody") {
        const step =
          recipe.rhythm === "quarters" || intensity === "low" ? 480 : 240;
        for (let tick = 0; tick < 1920; tick += step) {
          const choice = next();
          if (phraseEnd && tick > 960) continue;
          if (phraseEnd && tick === 960) {
            const p = pitch(role, chord, previous);
            previous = p;
            add(bar, tick, step - 30, p);
            continue;
          }
          const motif =
            recipe.motif[Math.floor(tick / step) % recipe.motif.length];
          if (
            motif === null ||
            (tick > 0 &&
              (choice >>> 16) % 4 >=
                recipe.density + (intensity === "high" ? 1 : 0))
          )
            continue;
          const degree =
            phraseEnd && tick === 0
              ? chord
              : motif + (phrase === 1 ? 2 : phrase === 3 ? 0 : alternative % 2);
          const p = pitch(role, degree, previous);
          previous = p;
          add(bar, tick, step - 30, p);
        }
      } else if (role === "bass") {
        for (let beat = 0; beat < (intensity === "high" ? 4 : 2); beat++)
          add(
            bar,
            beat * (intensity === "high" ? 480 : 960),
            420,
            pitch(role, chord + (beat % 2 ? 4 : 0)),
            0.8,
          );
      } else if (role === "harmony") {
        for (const degree of [chord, chord + 2, chord + 4])
          add(
            bar,
            0,
            intensity === "high" ? 1380 : 900,
            pitch(role, degree),
            0.45,
          );
      } else {
        const step = intensity === "high" ? 240 : 960;
        for (let tick = 0; tick < 1920; tick += step)
          add(
            bar,
            tick,
            60,
            recipe.registers.drums[0] + (tick % 960 === 480 ? 2 : 0),
            tick % 960 === 0 ? 0.7 : 0.4,
          );
      }
    }
    score.patterns.push({ id: role, name: role, lengthTicks: length, notes });
    score.clips.push({
      id: role,
      trackId: role,
      patternId: role,
      startTick: 0,
      repeats: 1,
      transpose: 0,
    });
  }
  return score;
}
function checkScore(score: Score, recipe: MusicRecipe): void {
  // A narrow preflight bounds schema and compilation work before either expands
  // events. General Score ceilings deliberately remain unchanged.
  if (
    !score ||
    !Array.isArray(score.patterns) ||
    score.patterns.length !== 4 ||
    !score.patterns.every(
      (p) => p && Array.isArray(p.notes) && p.notes.length <= 128,
    ) ||
    !Array.isArray(score.clips) ||
    score.clips.length !== 4
  )
    fail("generator score allocation limit");
  assertScore(score);
  if (
    score.bpm !== recipe.bpm ||
    score.lengthTicks !== recipe.bars * 1920 ||
    JSON.stringify(score.meter) !== "[4,4]" ||
    score.playback !== "loop" ||
    score.loop?.startTick !== 0 ||
    score.loop.endTick !== score.lengthTicks ||
    canonicalMusicData(score.scale) !== canonicalMusicData(recipe.key)
  )
    fail("score transport/key differs from recipe");
  if (
    score.tracks.length !== 4 ||
    score.patterns.length !== 4 ||
    score.clips.length !== 4 ||
    score.patches.length !== 4 ||
    score.sections.length !== 4
  )
    fail("score shape");
  for (const field of ["tracks", "patches", "patterns", "clips"] as const) {
    if (
      canonicalMusicData(score[field].map((item) => item.id)) !==
      canonicalMusicData(MUSIC_ROLES)
    )
      fail("role material ordering");
  }
  for (const role of MUSIC_ROLES) {
    const track = score.tracks.find((t) => t.id === role),
      pattern = score.patterns.find((p) => p.id === role),
      clip = score.clips.find((c) => c.id === role);
    if (
      !track ||
      track.role !== role ||
      track.patchId !== role ||
      !pattern ||
      pattern.lengthTicks !== score.lengthTicks ||
      !clip ||
      clip.trackId !== role ||
      clip.patternId !== role ||
      clip.repeats !== 1 ||
      clip.startTick !== 0 ||
      clip.transpose !== 0 ||
      !score.patches.some((p) => p.id === role)
    )
      fail("role/clip shape");
    const [min, max] = recipe.registers[role];
    for (const note of pattern.notes)
      if (
        note.pitch < min ||
        note.pitch > max ||
        note.startTick + note.durationTicks > score.lengthTicks ||
        Math.floor(note.startTick / 1920) !==
          Math.floor((note.startTick + note.durationTicks - 1) / 1920)
      )
        fail("note register/bar boundary");
  }
  for (let i = 0; i < 4; i++)
    if (
      score.sections[i].startTick !== (i * score.lengthTicks) / 4 ||
      score.sections[i].lengthTicks !== score.lengthTicks / 4
    )
      fail("phrase boundaries");
  const events = compileScore(score);
  if (events.length > 2048) fail("expanded event limit");
  for (const role of MUSIC_ROLES) {
    const edges = events
      .filter((e) => e.trackId === role)
      .flatMap((e) => [
        [e.startTick, 1],
        [e.startTick + e.durationTicks, -1],
      ])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let voices = 0;
    for (const [, delta] of edges)
      if ((voices += delta) > (role === "harmony" ? 3 : 1))
        fail("polyphony limit");
    for (let bar = 0; bar < recipe.bars; bar++)
      if (
        events.filter(
          (e) =>
            e.trackId === role &&
            e.startTick >= bar * 1920 &&
            e.startTick < (bar + 1) * 1920,
        ).length > 8
      )
        fail("bar density");
  }
}
function roleMaterial(score: Score, role: MusicRole): unknown[] {
  return (["tracks", "patches", "patterns", "clips"] as const).map((field) =>
    score[field].find((item) => item.id === role),
  );
}
function editedIntensitySummary(
  provenance: MusicCandidate["provenance"],
): MusicIntensity[] {
  return (["low", "high"] as const).filter(
    (i) =>
      provenance.editedRoles[i].length > 0 ||
      provenance.editedMetadata[i].length > 0,
  );
}
function identity(candidate: MusicCandidate): string {
  const { resultHash: _ignored, ...data } = candidate.provenance;
  return musicDataHash(data);
}
export function validateMusicCandidate(
  value: unknown,
): asserts value is MusicCandidate {
  canonicalMusicData(value);
  fields(value, ["scores", "provenance"]);
  fields(value.scores, ["low", "high"]);
  fields(value.provenance, [
    "version",
    "sourceHash",
    "recipe",
    "recipeHash",
    "alternative",
    "scoreHashes",
    "lockedRoles",
    "editedIntensities",
    "editedRoles",
    "editedMetadata",
    "parentResultHash",
    "resultHash",
  ]);
  const c = value as unknown as MusicCandidate,
    p = c.provenance;
  validateMusicRecipe(p.recipe);
  if (
    p.version !== MUSIC_GENERATOR_VERSION ||
    p.sourceHash !== MUSIC_GENERATOR_SOURCE ||
    p.recipeHash !== musicDataHash(p.recipe) ||
    !integer(p.alternative, 0, 7)
  )
    fail("provenance identity");
  fields(p.scoreHashes, ["low", "high"]);
  fields(p.editedRoles, ["low", "high"]);
  fields(p.editedMetadata, ["low", "high"]);
  for (const intensity of ["low", "high"] as const) {
    const roles = p.editedRoles[intensity],
      metadata = p.editedMetadata[intensity];
    if (
      !Array.isArray(roles) ||
      canonicalMusicData(roles) !==
        canonicalMusicData(MUSIC_ROLES.filter((role) => roles.includes(role)))
    )
      fail("edited role provenance");
    if (
      !Array.isArray(metadata) ||
      canonicalMusicData(metadata) !==
        canonicalMusicData(
          MUSIC_EDITABLE_METADATA.filter((field) => metadata.includes(field)),
        )
    )
      fail("edited metadata provenance");
  }
  if (
    !Array.isArray(p.editedIntensities) ||
    canonicalMusicData(p.editedIntensities) !==
      canonicalMusicData(editedIntensitySummary(p))
  )
    fail("edited intensity provenance");
  if (
    !Array.isArray(p.lockedRoles) ||
    p.lockedRoles.length > 4 ||
    new Set(p.lockedRoles).size !== p.lockedRoles.length ||
    p.lockedRoles.some((r) => !MUSIC_ROLES.includes(r)) ||
    canonicalMusicData(p.lockedRoles) !==
      canonicalMusicData(
        MUSIC_ROLES.filter((r) => p.lockedRoles.includes(r)),
      ) ||
    (p.lockedRoles.length === 0
      ? p.parentResultHash !== null
      : typeof p.parentResultHash !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(p.parentResultHash))
  )
    fail("lock provenance");
  for (const intensity of ["low", "high"] as const) {
    checkScore(c.scores[intensity], p.recipe);
    if (p.scoreHashes[intensity] !== musicDataHash(c.scores[intensity]))
      fail("score hash");
    const expected = resolvedScore(p.recipe, p.alternative, intensity);
    // Score-level data is independently checked even when some tracks are locked
    // or edited. Only explicitly declared human metadata edits bypass equality.
    const metadata = (score: Score) => {
      const {
        tracks: _tracks,
        patches: _patches,
        patterns: _patterns,
        clips: _clips,
        ...data
      } = score;
      for (const field of p.editedMetadata[intensity])
        delete (data as Partial<Score>)[field];
      return data;
    };
    if (
      canonicalMusicData(metadata(c.scores[intensity])) !==
      canonicalMusicData(metadata(expected))
    )
      fail("unedited metadata differs from pinned generator");
    for (const role of MUSIC_ROLES.filter(
      (role) =>
        !p.lockedRoles.includes(role) &&
        !p.editedRoles[intensity].includes(role),
    )) {
      if (
        canonicalMusicData(roleMaterial(c.scores[intensity], role)) !==
        canonicalMusicData(roleMaterial(expected, role))
      )
        fail("unlocked unedited role differs from pinned generator");
    }
  }

  if (p.resultHash !== identity(c)) fail("result hash");
}
/** Pure bounded generation. Locks copy full editable track/pattern/clip/patch bytes
 * from a validated selected result. The parent recipe must match transport and key. */
export function generateMusicCandidates(
  recipe: MusicRecipe,
  count = 2,
  previous?: MusicCandidate,
  lockedRoles: MusicRole[] = [],
): MusicCandidate[] {
  validateMusicRecipe(recipe);
  if (
    !integer(count, 1, 8) ||
    !Array.isArray(lockedRoles) ||
    lockedRoles.length > 4 ||
    new Set(lockedRoles).size !== lockedRoles.length ||
    lockedRoles.some((r) => !MUSIC_ROLES.includes(r))
  )
    fail("candidate/lock limit");
  if (lockedRoles.length) {
    if (!previous) fail("locks require a selected parent");
    validateMusicCandidate(previous);
    // Permit only seed changes while locking; edits to transport, register or motif
    // require explicit unlock to avoid misleading recipe provenance.
    if (
      canonicalMusicData({ ...recipe, seed: 0 }) !==
      canonicalMusicData({ ...previous.provenance.recipe, seed: 0 })
    )
      fail("locked regeneration permits seed changes only");
  }
  return Array.from({ length: count }, (_, alternative) => {
    const scores = {
      low: resolvedScore(recipe, alternative, "low"),
      high: resolvedScore(recipe, alternative, "high"),
    };
    if (lockedRoles.length)
      for (const intensity of ["low", "high"] as const)
        for (const role of lockedRoles) {
          const from = previous!.scores[intensity],
            to = scores[intensity];
          to.tracks[to.tracks.findIndex((t) => t.id === role)] = clone(
            from.tracks.find((t) => t.id === role)!,
          );
          to.patterns[to.patterns.findIndex((p) => p.id === role)] = clone(
            from.patterns.find((p) => p.id === role)!,
          );
          to.clips[to.clips.findIndex((c) => c.id === role)] = clone(
            from.clips.find((c) => c.id === role)!,
          );
          to.patches[to.patches.findIndex((p) => p.id === role)] = clone(
            from.patches.find((p) => p.id === role)!,
          );
        }
    const candidate: MusicCandidate = {
      scores,
      provenance: {
        version: MUSIC_GENERATOR_VERSION,
        sourceHash: MUSIC_GENERATOR_SOURCE,
        recipe: clone(recipe),
        recipeHash: musicDataHash(recipe),
        alternative,
        scoreHashes: {
          low: musicDataHash(scores.low),
          high: musicDataHash(scores.high),
        },
        lockedRoles: MUSIC_ROLES.filter((r) => lockedRoles.includes(r)),
        editedIntensities: [],
        editedRoles: {
          low: lockedRoles.length
            ? previous!.provenance.editedRoles.low.filter((role) =>
                lockedRoles.includes(role),
              )
            : [],
          high: lockedRoles.length
            ? previous!.provenance.editedRoles.high.filter((role) =>
                lockedRoles.includes(role),
              )
            : [],
        },
        editedMetadata: { low: [], high: [] },
        parentResultHash: lockedRoles.length
          ? previous!.provenance.resultHash
          : null,
        resultHash: "",
      },
    };
    candidate.provenance.editedIntensities = editedIntensitySummary(
      candidate.provenance,
    );
    candidate.provenance.resultHash = identity(candidate);
    validateMusicCandidate(candidate);
    return candidate;
  });
}
/** Reproduction is exact for generated candidates. Edited scores remain frozen
 * editable artifacts; their human edits cannot be inferred from a seed. */
export function reproduceMusicCandidate(
  candidate: MusicCandidate,
  parent?: MusicCandidate,
): MusicCandidate {
  validateMusicCandidate(candidate);
  if (candidate.provenance.editedIntensities.length)
    fail("edited candidates must retain frozen Score bytes");
  const p = candidate.provenance;
  if (
    p.lockedRoles.length &&
    (!parent || parent.provenance.resultHash !== p.parentResultHash)
  )
    fail("exact locked parent required");
  const result = generateMusicCandidates(
    p.recipe,
    p.alternative + 1,
    parent,
    p.lockedRoles,
  )[p.alternative];
  if (canonicalMusicData(result) !== canonicalMusicData(candidate))
    fail("candidate differs from pinned reproduction");
  return result;
}
/** Keeping stores the exact preview, never invokes generation, and isolates callers.
 * History is bounded independently from preview candidates. */
export class MusicGenerationSession {
  private selected: MusicCandidate | null = null;
  private history: (MusicCandidate | null)[] = [];
  private previews: MusicCandidate[] = [];
  current(): MusicCandidate | null {
    return clone(this.selected);
  }
  preview(
    recipe: MusicRecipe,
    count = 2,
    locks: MusicRole[] = [],
  ): MusicCandidate[] {
    const generated = generateMusicCandidates(
      recipe,
      count,
      this.selected ?? undefined,
      locks,
    );
    this.previews = generated;
    return clone(generated);
  }
  keep(index: number): MusicCandidate {
    if (!integer(index, 0, this.previews.length - 1)) fail("unknown preview");
    this.history.push(this.selected);
    if (this.history.length > 16) this.history.shift();
    this.selected = clone(this.previews[index]);
    this.previews = [];
    return clone(this.selected);
  }
  /** Apply an ordinary editable Score to the selected intensity. Failed edits leave
   * selection/history/previews unchanged; edits are explicitly marked in sidecar. */
  editSelected(intensity: MusicIntensity, score: unknown): MusicCandidate {
    if (!this.selected || !["low", "high"].includes(intensity))
      fail("select a candidate before editing");
    canonicalMusicData(score);
    const edited = clone(this.selected!);
    edited.scores[intensity] = clone(score) as Score;
    checkScore(edited.scores[intensity], edited.provenance.recipe);
    edited.provenance.editedRoles[intensity] = MUSIC_ROLES.filter(
      (role) =>
        edited.provenance.editedRoles[intensity].includes(role) ||
        canonicalMusicData(roleMaterial(edited.scores[intensity], role)) !==
          canonicalMusicData(
            roleMaterial(this.selected!.scores[intensity], role),
          ),
    );
    edited.provenance.editedMetadata[intensity] =
      MUSIC_EDITABLE_METADATA.filter(
        (field) =>
          edited.provenance.editedMetadata[intensity].includes(field) ||
          canonicalMusicData(edited.scores[intensity][field]) !==
            canonicalMusicData(this.selected!.scores[intensity][field]),
      );
    edited.provenance.editedIntensities = editedIntensitySummary(
      edited.provenance,
    );
    edited.provenance.scoreHashes[intensity] = musicDataHash(score);
    edited.provenance.resultHash = identity(edited);
    validateMusicCandidate(edited);
    this.history.push(this.selected);
    if (this.history.length > 16) this.history.shift();
    this.selected = edited;
    this.previews = [];
    return clone(edited);
  }
  undo(): MusicCandidate | null {
    if (this.history.length) {
      this.selected = this.history.pop()!;
      this.previews = [];
    }
    return this.current();
  }
}
