import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const PPQ = 480 as const;
const id = Type.String({ minLength: 1, maxLength: 128 });
const tick = Type.Integer({ minimum: 0, maximum: 10_000_000 });
const positiveTick = Type.Integer({ minimum: 1, maximum: 10_000_000 });
const unit = Type.Number({ minimum: 0, maximum: 1 });
const objectOptions = { additionalProperties: false } as const;
export const NoteSchema = Type.Object(
  {
    id,
    startTick: tick,
    durationTicks: positiveTick,
    pitch: Type.Integer({ minimum: 0, maximum: 127 }),
    velocity: unit,
  },
  objectOptions,
);
export type Note = Static<typeof NoteSchema>;
export const PatchSchema = Type.Object(
  {
    id,
    name: Type.String({ maxLength: 200 }),
    waveform: Type.Union(
      (["pulse", "triangle", "sine", "sawtooth", "noise", "harmonic-bass"] as const).map((v) =>
        Type.Literal(v),
      ),
    ),
    attack: Type.Number({ minimum: 0, maximum: 5 }),
    release: Type.Number({ minimum: 0, maximum: 10 }),
    brightness: unit,
    /** Optional one-shot envelope; omitted historical patches retain sustained gain. */
    decaySeconds: Type.Optional(Type.Number({ minimum: 0.02, maximum: 10 })),
    duty: Type.Number({ minimum: 0.05, maximum: 0.95 }),
  },
  objectOptions,
);
export type Patch = Static<typeof PatchSchema>;
export const TrackSchema = Type.Object(
  {
    id,
    name: Type.String({ maxLength: 200 }),
    role: Type.Union(
      (["melody", "bass", "harmony", "drums"] as const).map((v) =>
        Type.Literal(v),
      ),
    ),
    patchId: id,
    gain: unit,
    pan: Type.Number({ minimum: -1, maximum: 1 }),
    minEnergy: Type.Integer({ minimum: 1, maximum: 3 }),
  },
  objectOptions,
);
export type Track = Static<typeof TrackSchema>;
export const PatternSchema = Type.Object(
  {
    id,
    name: Type.String({ maxLength: 200 }),
    lengthTicks: positiveTick,
    notes: Type.Array(NoteSchema, { maxItems: 10000 }),
  },
  objectOptions,
);
export type Pattern = Static<typeof PatternSchema>;
export const ClipSchema = Type.Object(
  {
    id,
    trackId: id,
    patternId: id,
    startTick: tick,
    repeats: Type.Integer({ minimum: 1, maximum: 1024 }),
    transpose: Type.Integer({ minimum: -127, maximum: 127 }),
  },
  objectOptions,
);
export type Clip = Static<typeof ClipSchema>;
export const SectionSchema = Type.Object(
  {
    id,
    name: Type.String({ maxLength: 200 }),
    startTick: tick,
    lengthTicks: positiveTick,
  },
  objectOptions,
);
export type Section = Static<typeof SectionSchema>;
export const ScoreSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    id,
    title: Type.String({ maxLength: 200 }),
    ppq: Type.Literal(PPQ),
    bpm: Type.Number({ minimum: 20, maximum: 400 }),
    meter: Type.Tuple([
      Type.Integer({ minimum: 1, maximum: 32 }),
      Type.Union(([1, 2, 4, 8, 16, 32] as const).map((v) => Type.Literal(v))),
    ]),
    scale: Type.Object(
      {
        root: Type.Integer({ minimum: 0, maximum: 11 }),
        mode: Type.Union([
          Type.Literal("minor"),
          Type.Literal("major"),
          Type.Literal("chromatic"),
        ]),
      },
      objectOptions,
    ),
    playback: Type.Union([Type.Literal("loop"), Type.Literal("one-shot")]),
    lengthTicks: positiveTick,
    loop: Type.Union([
      Type.Object({ startTick: tick, endTick: positiveTick }, objectOptions),
      Type.Null(),
    ]),
    tracks: Type.Array(TrackSchema, { maxItems: 32 }),
    patterns: Type.Array(PatternSchema, { maxItems: 256 }),
    clips: Type.Array(ClipSchema, { maxItems: 2048 }),
    sections: Type.Array(SectionSchema, { maxItems: 256 }),
    patches: Type.Array(PatchSchema, { maxItems: 64 }),
  },
  objectOptions,
);
export type Score = Static<typeof ScoreSchema>;

export function validateScore(value: unknown): {
  valid: boolean;
  errors: string[];
} {
  const errors = [...Value.Errors(ScoreSchema, value)].map(
    (e) => `${e.path}: ${e.message}`,
  );
  if (errors.length) return { valid: false, errors };
  const score = value as Score;
  for (const [name, items] of Object.entries({
    tracks: score.tracks,
    patterns: score.patterns,
    clips: score.clips,
    sections: score.sections,
    patches: score.patches,
  })) {
    if (new Set(items.map((i) => i.id)).size !== items.length)
      errors.push(`${name}: duplicate ids`);
  }
  const patches = new Set(score.patches.map((p) => p.id));
  const tracks = new Set(score.tracks.map((t) => t.id));
  const patterns = new Map(score.patterns.map((p) => [p.id, p]));
  for (const t of score.tracks)
    if (!patches.has(t.patchId)) errors.push(`track ${t.id}: missing patch`);
  for (const p of score.patterns) {
    if (new Set(p.notes.map((n) => n.id)).size !== p.notes.length)
      errors.push(`pattern ${p.id}: duplicate note ids`);
    for (const n of p.notes)
      if (n.startTick + n.durationTicks > p.lengthTicks)
        errors.push(`note ${n.id}: exceeds pattern`);
  }
  let expandedNotes = 0;
  for (const c of score.clips) {
    const p = patterns.get(c.patternId);
    if (!tracks.has(c.trackId)) errors.push(`clip ${c.id}: missing track`);
    if (!p) {
      errors.push(`clip ${c.id}: missing pattern`);
      continue;
    }
    expandedNotes += p.notes.length * c.repeats;
    if (c.startTick + p.lengthTicks * c.repeats > score.lengthTicks)
      errors.push(`clip ${c.id}: exceeds score`);
    if (
      p.notes.some(
        (n) => n.pitch + c.transpose < 0 || n.pitch + c.transpose > 127,
      )
    )
      errors.push(`clip ${c.id}: transposed pitch out of range`);
  }
  if (expandedNotes > 100000)
    errors.push("score: expanded note limit exceeded");
  for (const s of score.sections)
    if (s.startTick + s.lengthTicks > score.lengthTicks)
      errors.push(`section ${s.id}: exceeds score`);
  if (score.playback === "loop" && !score.loop)
    errors.push("loop playback requires loop bounds");
  if (
    score.loop &&
    (score.loop.startTick >= score.loop.endTick ||
      score.loop.endTick > score.lengthTicks)
  )
    errors.push("loop: invalid bounds");
  return { valid: errors.length === 0, errors };
}
export function assertScore(value: unknown): asserts value is Score {
  const result = validateScore(value);
  if (!result.valid)
    throw new Error(`Invalid score: ${result.errors.join("; ")}`);
}
export function createBlankScore(title = "Untitled cue"): Score {
  return {
    schemaVersion: 1,
    id: "blank",
    title,
    ppq: PPQ,
    bpm: 120,
    meter: [4, 4],
    scale: { root: 0, mode: "minor" },
    playback: "loop",
    lengthTicks: 3840,
    loop: { startTick: 0, endTick: 3840 },
    tracks: [
      {
        id: "melody",
        name: "Melody",
        role: "melody",
        patchId: "lead",
        gain: 0.65,
        pan: 0,
        minEnergy: 1,
      },
    ],
    patterns: [
      {
        id: "melody-pattern",
        name: "Your melody",
        lengthTicks: 3840,
        notes: [],
      },
    ],
    clips: [
      {
        id: "melody-clip",
        trackId: "melody",
        patternId: "melody-pattern",
        startTick: 0,
        repeats: 1,
        transpose: 0,
      },
    ],
    sections: [],
    patches: [
      {
        id: "lead",
        name: "Soft pulse",
        waveform: "pulse",
        attack: 0.006,
        release: 0.08,
        brightness: 0.55,
        duty: 0.5,
      },
    ],
  };
}

export const STARTERS = [
  {
    id: "midnight-delivery",
    title: "Midnight Delivery",
    moment: "Action",
    bpm: 128,
    playback: "loop",
    description: "A nimble minor melody over a steady night-drive bass.",
    suggestedEdit: {
      trackId: "drums",
      action: "accent",
      hint: "Accent the final snare.",
    },
  },
  {
    id: "tiny-triumph",
    title: "Tiny Triumph",
    moment: "Victory",
    bpm: 150,
    playback: "one-shot",
    description: "A bright ascending fanfare with a held final chord.",
    suggestedEdit: {
      trackId: "melody",
      action: "accent",
      hint: "Give the final note a little more lift.",
    },
  },
  {
    id: "moss-lantern",
    title: "Moss Lantern",
    moment: "Explore",
    bpm: 84,
    playback: "loop",
    description: "Spacious bell-like thirds and a warm low foundation.",
    suggestedEdit: {
      trackId: "melody",
      action: "sound",
      hint: "Try a softer melody sound.",
    },
  },
  {
    id: "copper-giant",
    title: "Copper Giant",
    moment: "Boss",
    bpm: 140,
    playback: "loop",
    description: "Quick repeated pulses and offbeat percussion.",
    suggestedEdit: {
      trackId: "bass",
      action: "sound",
      hint: "Lower the bass note for a heavier footstep.",
    },
  },
  {
    id: "clockwork-steps",
    title: "Clockwork Steps",
    moment: "Puzzle",
    bpm: 120,
    playback: "loop",
    description:
      "An off-kilter little phrase that takes one unexpected extra step.",
    suggestedEdit: {
      trackId: "melody",
      action: "raise-ending",
      hint: "Raise the ending and hear the phrase turn.",
    },
  },
  {
    id: "pocket-sunrise",
    title: "Pocket Sunrise",
    moment: "Menu",
    bpm: 112,
    playback: "loop",
    description: "A bright descending theme with a gentle sustained ending.",
    suggestedEdit: {
      trackId: "melody",
      action: "raise-ending",
      hint: "Raise the last melody note.",
    },
  },
] as const;

/** Original deterministic fixtures; callers assign a fresh score identity for copies. */
export function createStarter(id: string = STARTERS[0].id): Score {
  const index = STARTERS.findIndex((s) => s.id === id);
  if (index < 0) throw new Error(`Unknown starter: ${id}`);
  const meta = STARTERS[index]!;
  const score = createBlankScore(meta.title);
  score.id = meta.id;
  score.bpm = meta.bpm;
  score.playback = meta.playback;
  score.lengthTicks = index === 4 ? 3120 : 3840;
  score.loop =
    meta.playback === "loop"
      ? { startTick: 0, endTick: score.lengthTicks }
      : null;
  score.scale = {
    root: index === 1 || index === 5 ? 0 : 9,
    mode: index === 1 || index === 5 ? "major" : "minor",
  };
  const melodies = [
    [69, 72, 76, 74, 72, 67, 69, 71],
    [60, 64, 67, 72, 76],
    [69, 76, 72, 79],
    [69, 69, 72, 69, 76, 74, 72, 71, 69, 67, 71, 72, 74, 72, 71, 67],
    [69, 72, 76, 74, 71, 67, 69],
    [76, 74, 72, 71, 69],
  ];
  const step = index === 3 ? 240 : index === 2 ? 960 : 480;
  const notes = melodies[index]!.map((pitch, n) => ({
    id: `melody-${n}`,
    pitch,
    startTick: n * step,
    durationTicks: Math.min(
      index === 1 || index === 5 ? (n === 4 ? 1920 : 360) : step * 0.75,
      score.lengthTicks - n * step,
    ),
    velocity: n % 2 ? 0.7 : 0.9,
  }));
  score.patterns[0]!.lengthTicks = score.lengthTicks;
  score.patterns[0]!.notes = notes;
  score.patches[0]!.waveform =
    index === 2 ? "sine" : index === 5 ? "triangle" : "pulse";
  score.tracks.push({
    id: "bass",
    name: "Bass",
    role: "bass",
    patchId: "bass-patch",
    gain: 0.55,
    pan: -0.12,
    minEnergy: 1,
  });
  score.patches.push({
    id: "bass-patch",
    name: "Round bass",
    waveform: "triangle",
    attack: 0.005,
    release: 0.06,
    brightness: 0.3,
    duty: 0.5,
  });
  score.patterns.push({
    id: "bass-pattern",
    name: "Foundation",
    lengthTicks: score.lengthTicks,
    notes: Array.from(
      { length: Math.ceil(score.lengthTicks / 960) },
      (_, n) => ({
        id: `bass-${n}`,
        startTick: n * 960,
        durationTicks: Math.min(720, score.lengthTicks - n * 960),
        pitch: [45, 45, 41, 43][n % 4]! + (index === 1 ? 3 : 0),
        velocity: 0.75,
      }),
    ),
  });
  score.clips.push({
    id: "bass-clip",
    trackId: "bass",
    patternId: "bass-pattern",
    startTick: 0,
    repeats: 1,
    transpose: 0,
  });
  score.tracks.push({
    id: "drums",
    name: "Rhythm",
    role: "drums",
    patchId: "noise",
    gain: 0.2,
    pan: 0.15,
    minEnergy: 3,
  });
  score.patches.push({
    id: "noise",
    name: "Dust hats",
    waveform: "noise",
    attack: 0.001,
    release: 0.025,
    brightness: 0.75,
    duty: 0.5,
  });
  score.patterns.push({
    id: "drums-pattern",
    name: "Pulse",
    lengthTicks: score.lengthTicks,
    notes: Array.from(
      { length: Math.ceil(score.lengthTicks / step) },
      (_, n) => ({
        id: `drum-${n}`,
        startTick: n * step,
        durationTicks: Math.min(60, score.lengthTicks - n * step),
        pitch: n % 4 === 0 ? 36 : n % 4 === 2 ? 38 : 42,
        velocity: n % 2 ? 0.45 : 0.7,
      }),
    ),
  });
  score.clips.push({
    id: "drums-clip",
    trackId: "drums",
    patternId: "drums-pattern",
    startTick: 0,
    repeats: 1,
    transpose: 0,
  });
  score.tracks.splice(2, 0, {
    id: "harmony",
    name: "Harmony",
    role: "harmony",
    patchId: "pad-patch",
    gain: 0.24,
    pan: 0.12,
    minEnergy: 2,
  });
  score.patches.push({
    id: "pad-patch",
    name: "Soft pad",
    waveform: "sine",
    attack: 0.08,
    release: 0.16,
    brightness: 0.35,
    duty: 0.5,
  });
  const chord = index === 1 || index === 5 ? [48, 52, 55] : [45, 48, 52];
  score.patterns.push({
    id: "harmony-pattern",
    name: "Held harmony",
    lengthTicks: score.lengthTicks,
    notes: chord.map((pitch, n) => ({
      id: `chord-${n}`,
      startTick: 0,
      durationTicks: score.lengthTicks,
      pitch,
      velocity: 0.5,
    })),
  });
  score.clips.push({
    id: "harmony-clip",
    trackId: "harmony",
    patternId: "harmony-pattern",
    startTick: 0,
    repeats: 1,
    transpose: 0,
  });
  score.sections = [
    {
      id: "phrase",
      name: "Main phrase",
      startTick: 0,
      lengthTicks: score.lengthTicks,
    },
  ];
  assertScore(score);
  return score;
}

/** Separate project resource envelope. Music-core validates the musical document
 * to keep the base project package independent of its compiler. */
export interface ExpressiveProjectResourceEnvelope<TDocument = unknown> {
  schemaVersion: 1;
  kind: "expressive-project-resource";
  id: string;
  title: string;
  document: TDocument;
}
