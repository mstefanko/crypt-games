import type { Score } from "@onepage/project";

// Runtime boundary is deliberately free of the authoring schema/compiler. Check
// shape and allocation/expansion limits before compiling untrusted portable data.
type Check = (value: unknown) => boolean;
const num =
  (min: number, max: number, integer = false): Check =>
  (v) =>
    typeof v === "number" &&
    Number.isFinite(v) &&
    v >= min &&
    v <= max &&
    (!integer || Number.isInteger(v));
const text =
  (max: number, min = 0): Check =>
  (v) =>
    typeof v === "string" && v.length >= min && v.length <= max;
const oneOf =
  (...values: unknown[]): Check =>
  (v) =>
    values.includes(v);
const list =
  (max: number, check: Check): Check =>
  (v) => {
    if (!Array.isArray(v) || v.length > max) return false;
    for (let i = 0; i < v.length; i++)
      if (!Object.hasOwn(v, i) || !check(v[i])) return false;
    return true;
  };
const object =
  (fields: Record<string, Check>, optional: Record<string, Check> = {}): Check =>
  (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const entries = Object.entries(v);
    return (
      Object.keys(fields).every(key => Object.hasOwn(v, key)) &&
      entries.every(([key, value]) =>
        Object.hasOwn(fields, key) ? fields[key](value) :
          Object.hasOwn(optional, key) && optional[key](value),
      )
    );
  };
const id = text(128, 1),
  tick = num(0, 10_000_000, true),
  positiveTick = num(1, 10_000_000, true),
  unit = num(0, 1);
const note = object({
  id,
  startTick: tick,
  durationTicks: positiveTick,
  pitch: num(0, 127, true),
  velocity: unit,
});
const schema = object({
  schemaVersion: oneOf(1),
  id,
  title: text(200),
  ppq: oneOf(480),
  bpm: num(20, 400),
  meter: (v) =>
    Array.isArray(v) &&
    v.length === 2 &&
    num(1, 32, true)(v[0]) &&
    oneOf(1, 2, 4, 8, 16, 32)(v[1]),
  scale: object({
    root: num(0, 11, true),
    mode: oneOf("minor", "major", "chromatic"),
  }),
  playback: oneOf("loop", "one-shot"),
  lengthTicks: positiveTick,
  loop: (v) =>
    v === null || object({ startTick: tick, endTick: positiveTick })(v),
  tracks: list(
    32,
    object({
      id,
      name: text(200),
      role: oneOf("melody", "bass", "harmony", "drums"),
      patchId: id,
      gain: unit,
      pan: num(-1, 1),
      minEnergy: num(1, 3, true),
    }),
  ),
  patterns: list(
    256,
    object({
      id,
      name: text(200),
      lengthTicks: positiveTick,
      notes: list(10_000, note),
    }),
  ),
  clips: list(
    2048,
    object({
      id,
      trackId: id,
      patternId: id,
      startTick: tick,
      repeats: num(1, 1024, true),
      transpose: num(-127, 127, true),
    }),
  ),
  sections: list(
    256,
    object({ id, name: text(200), startTick: tick, lengthTicks: positiveTick }),
  ),
  patches: list(
    64,
    object({
      id,
      name: text(200),
      waveform: oneOf("pulse", "triangle", "sine", "sawtooth", "noise", "harmonic-bass"),
      attack: num(0, 5),
      release: num(0, 10),
      brightness: unit,
      duty: num(0.05, 0.95),
    }, { decaySeconds: num(0.02, 10) }),
  ),
});
export function assertPlayableScore(value: unknown): asserts value is Score {
  if (!schema(value))
    throw new Error("Invalid score: playback document shape/bounds");
  const score = value as Score;
  const reject = (message: string): never => {
    throw new Error(`Invalid score: ${message}`);
  };
  for (const items of [
    score.tracks,
    score.patterns,
    score.clips,
    score.sections,
    score.patches,
  ])
    if (new Set(items.map((item) => item.id)).size !== items.length)
      reject("duplicate ids");
  const patches = new Set(score.patches.map((patch) => patch.id));
  const tracks = new Set(score.tracks.map((track) => track.id));
  const patterns = new Map(
    score.patterns.map((pattern) => [pattern.id, pattern]),
  );
  for (const track of score.tracks)
    if (!patches.has(track.patchId)) reject("missing patch");
  for (const pattern of score.patterns) {
    if (
      new Set(pattern.notes.map((note) => note.id)).size !==
      pattern.notes.length
    )
      reject("duplicate note ids");
    if (
      pattern.notes.some(
        (note) => note.startTick + note.durationTicks > pattern.lengthTicks,
      )
    )
      reject("note exceeds pattern");
  }
  let expanded = 0;
  for (const clip of score.clips) {
    const pattern = patterns.get(clip.patternId);
    if (!tracks.has(clip.trackId)) reject("missing track");
    if (!pattern) reject("missing pattern");
    expanded += pattern!.notes.length * clip.repeats;
    if (expanded > 100_000) reject("expanded note limit exceeded");
    if (
      clip.startTick + pattern!.lengthTicks * clip.repeats >
      score.lengthTicks
    )
      reject("clip exceeds score");
    if (
      pattern!.notes.some(
        (note) =>
          note.pitch + clip.transpose < 0 || note.pitch + clip.transpose > 127,
      )
    )
      reject("transposed pitch out of range");
  }
  for (const section of score.sections)
    if (section.startTick + section.lengthTicks > score.lengthTicks)
      reject("section exceeds score");
  if (
    (score.playback === "loop" && !score.loop) ||
    (score.loop &&
      (score.loop.startTick >= score.loop.endTick ||
        score.loop.endTick > score.lengthTicks))
  )
    reject("invalid loop bounds");
}
