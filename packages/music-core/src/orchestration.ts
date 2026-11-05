import type { Patch, Track } from "@onepage/project";
export type EnsembleId = "light" | "reflective" | "dark" | "earthy";
const part = (
  id: string,
  role: Track["role"],
  patchId: string,
  gain: number,
  pan = 0,
): Track => ({
  id,
  name: id.replaceAll("-", " "),
  role,
  patchId,
  gain,
  pan,
  minEnergy: 1,
});
export const WEATHER_TRACKS: Track[] = [
  part("melody-flute", "melody", "weather-flute", 0.3, 0.1),
  part("melody-violin", "melody", "weather-violin", 0.3, 0.1),
  part("melody-marimba", "melody", "weather-marimba", 0.3, 0.1),
  part("harmony-violin", "harmony", "weather-violin", 0.16, -0.2),
  part("harmony-piano", "harmony", "weather-piano", 0.16, -0.2),
  part("bass-cello", "bass", "weather-cello", 0.35),
  part("drums-deep", "drums", "weather-deep-drum", 0.12),
];
export const WEATHER_PATCHES: Patch[] = [
  "flute",
  "violin",
  "marimba",
  "piano",
  "cello",
  "deep-drum",
].map((instrument) => ({
  id: `weather-${instrument}`,
  name: `${instrument} (synth approximation)`,
  waveform:
    instrument === "deep-drum"
      ? "noise"
      : instrument === "cello"
        ? "sine"
        : "triangle",
  attack: instrument === "violin" ? 0.04 : 0.01,
  release: 0.2,
  brightness: 0.4,
  duty: 0.5,
}));
export function ensembleParts(
  ensemble: EnsembleId,
): Record<"melody" | "harmony" | "bass" | "drums", string> {
  return {
    melody:
      ensemble === "earthy"
        ? "melody-marimba"
        : ensemble === "dark" || ensemble === "reflective"
          ? "melody-violin"
          : "melody-flute",
    harmony:
      ensemble === "dark" || ensemble === "reflective"
        ? "harmony-violin"
        : "harmony-piano",
    bass: "bass-cello",
    drums: "drums-deep",
  };
}

// Catalog entries are immutable for the lifetime of sounding voices.
WEATHER_TRACKS.forEach(Object.freeze);
WEATHER_PATCHES.forEach(Object.freeze);
Object.freeze(WEATHER_TRACKS);
Object.freeze(WEATHER_PATCHES);

// Catalog bindings are run identities, never mutable arrangement state.
WEATHER_TRACKS.forEach(Object.freeze);
WEATHER_PATCHES.forEach(Object.freeze);
Object.freeze(WEATHER_TRACKS);
Object.freeze(WEATHER_PATCHES);

/** Song catalogs extend rather than mutate frozen chamber-era identities. */
export const WEATHER_SONG_TRACKS: Track[] = [
  ...WEATHER_TRACKS,
  part("drums-snare", "drums", "weather-snare", 0.09),
  part("drums-timpani", "drums", "weather-timpani-hit", 0.12),
  part("drums-hat", "drums", "weather-closed-hat", 0.055),
  part("bass-bassoon", "bass", "weather-bassoon", 0.3),
  part("melody-bassoon", "melody", "weather-bassoon", 0.3, 0.1),
];
export const WEATHER_SONG_PATCHES: Patch[] = [
  ...WEATHER_PATCHES.map(patch => patch.id === "weather-cello" ? { ...patch, waveform: "triangle" as const } : patch),
  {
    id: "weather-timpani-hit",
    decaySeconds: 0.8,
    name: "Unpitched timpani hit (synth approximation)",
    waveform: "sine",
    attack: 0.003,
    release: 0.3,
    brightness: 0.2,
    duty: 0.5,
  },
  {
    id: "weather-snare",
    name: "Snare (synth approximation)",
    waveform: "noise",
    attack: 0.003,
    release: 0.18,
    brightness: 0.6,
    duty: 0.5,
  },
  {
    id: "weather-closed-hat",
    name: "Closed hat (synth approximation)",
    waveform: "noise",
    attack: 0.002,
    release: 0.08,
    brightness: 0.85,
    duty: 0.5,
  },
  {
    id: "weather-bassoon",
    name: "Bassoon (synth approximation)",
    waveform: "sawtooth",
    attack: 0.025,
    release: 0.3,
    brightness: 0.25,
    duty: 0.5,
  },
];
WEATHER_SONG_TRACKS.forEach(Object.freeze);
WEATHER_SONG_PATCHES.forEach(Object.freeze);
Object.freeze(WEATHER_SONG_TRACKS);
Object.freeze(WEATHER_SONG_PATCHES);

/** New low layer has a separate identity; v1 patch bytes and gains stay replayable. */
export const WEATHER_LOW_FOUNDATION_PATCH: Patch = Object.freeze({
  id: "weather-low-foundation-v1", name: "Centered harmonic bass foundation",
  waveform: "harmonic-bass", attack: 0.035, release: 0.3,
  brightness: 0.2, duty: 0.5,
});
export const WEATHER_SONG_V2_TRACKS: Track[] = [
  ...WEATHER_SONG_TRACKS, part("bass-foundation", "bass", WEATHER_LOW_FOUNDATION_PATCH.id, 0.62),
];
export const WEATHER_SONG_V2_PATCHES: Patch[] = [...WEATHER_SONG_PATCHES, WEATHER_LOW_FOUNDATION_PATCH];
WEATHER_SONG_V2_TRACKS.forEach(Object.freeze);
Object.freeze(WEATHER_SONG_V2_TRACKS);
Object.freeze(WEATHER_SONG_V2_PATCHES);
