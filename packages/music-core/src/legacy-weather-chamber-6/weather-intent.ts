import type { ComposerWeatherObservation } from "./weather-composer";
import type { ModeId } from "./tonality";
import type { EnsembleId } from "./orchestration";
export interface MusicalIntent {
  brightness: number;
  tension: number;
  activity: number;
  weight: number;
  continuity: number;
  mode: ModeId;
  ensemble: EnsembleId;
  reason: string;
}
const bound = (v: number) => Math.max(0, Math.min(1, v));
/** Weather only supplies intentions. Threshold hysteresis uses the committed destination. */
export function weatherMusicalIntent(
  w: ComposerWeatherObservation,
  current: ModeId = "ionian",
): MusicalIntent {
  const storm = (w.stormStrength ?? 0) >= (current === "aeolian" ? 0.1 : 0.2);
  const rain = w.precipitation >= (current === "aeolian" ? 0.2 : 0.35);
  const fog = (w.fog ?? 0) >= (current === "dorian" ? 0.2 : 0.35);
  const chilly = w.thermalBand === "cold" || w.thermalBand === "chilly";
  const hot = w.thermalBand === "hot";
  const mode: ModeId =
    storm || rain
      ? "aeolian"
      : fog || chilly
        ? "dorian"
        : hot
          ? "mixolydian"
          : (w.clearingDuration ?? 0) >= 2 && (w.clearingDuration ?? 0) < 8
            ? "lydian"
            : "ionian";
  return {
    mode,
    ensemble:
      storm || rain
        ? "dark"
        : fog || chilly
          ? "reflective"
          : hot
            ? "earthy"
            : "light",
    brightness:
      mode === "lydian"
        ? 0.95
        : mode === "ionian"
          ? 0.8
          : mode === "mixolydian"
            ? 0.7
            : mode === "dorian"
              ? 0.4
              : 0.2,
    tension: bound((w.stormStrength ?? 0) * 0.8 + (w.instability ?? 0) * 0.2),
    activity: bound(w.intensity * 0.7 + w.gustiness * 0.3),
    weight: bound(
      (storm ? 0.5 : 0) + w.precipitation * 0.3 + (w.fog ?? 0) * 0.2,
    ),
    continuity: bound(0.3 + (w.fog ?? 0) * 0.6),
    reason: storm
      ? "storm"
      : rain
        ? "precipitation"
        : fog
          ? "fog"
          : chilly
            ? "chilly"
            : hot
              ? "hot and dry"
              : mode === "lydian"
                ? "clearing"
                : "settled",
  };
}
