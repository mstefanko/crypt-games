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
