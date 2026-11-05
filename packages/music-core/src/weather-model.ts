import type { WeatherObservation } from "./bar-planner";

export type FrontKind = "cold" | "warm";
export interface WeatherFront {
  id: string;
  kind: FrontKind;
  x: number;
  speed: number;
  moisture: number;
  instability: number;
}
export interface WeatherCell {
  id: number;
  x: number;
  y: number;
  cloud: number;
  rain: number;
}
export interface WeatherEvent {
  id: string;
  tick: number;
  kind:
    | "passage"
    | "rain-start"
    | "rain-end"
    | "convection-start"
    | "fog-start"
    | "fog-end"
    | "lightning";
  frontId?: string;
}
export type WeatherCommand = { tick: number } & (
  | {
      type: "add-front";
      kind: FrontKind;
      x?: number;
      moisture?: number;
      instability?: number;
    }
  | {
      type:
        | "set-moisture"
        | "set-instability"
        | "set-temperature"
        | "set-solar-heating";
      value: number;
    }
  | { type: "set-wind"; x: number; y: number }
  | { type: "move-observer"; x: number; y: number }
  | { type: "set-musical-intensity"; value: number | null }
  | { type: "pause"; value: boolean }
);
export interface WeatherSample {
  temperature: number;
  moisture: number;
  instability: number;
  lift: number;
  cloudCover: number;
  precipitation: number;
}
export type ThermalBand = "cold" | "chilly" | "temperate" | "hot";
export interface RichWeatherObservation extends WeatherObservation {
  tick: number;
  frontId?: string;
  frontPassage: boolean;
  precipitationPattern: "dry" | "steady" | "showers";
  interaction: number;
  windDirection: number;
  temperature: number;
  temperatureTrend: number;
  thermalBand: ThermalBand;
  fog: number;
  visibility: number;
  stormStrength: number;
  lightning: boolean;
  solarHeating: number;
  moisture: number;
  instability: number;
  wind: number;
  cloudCover: number;
  lift: number;
  convection: number;
  frontDistance: number;
  passage: boolean;
  clearingDuration: number;
  autoIntensity: number;
  /** Fraction of the target observation contributed by an approaching front (0..0.1). */
  regionalContribution: number;
  events: WeatherEvent[];
}
export interface WeatherState {
  version: 1;
  seed: number;
  rng: number;
  tick: number;
  phase: number;
  weatherTick: number;
  nextFrontId: number;
  fronts: WeatherFront[];
  cells: WeatherCell[];
  observer: { x: number; y: number };
  wind: { x: number; y: number };
  moisture: number;
  instability: number;
  /** Relative background air temperature, not degrees Celsius. */
  temperature: number;
  solarHeating: number;
  fog: number;
  foggy: boolean;
  lightningCooldown: number;
  paused: boolean;
  musicalIntensity: number | null;
  events: WeatherEvent[];
  observation: RichWeatherObservation;
  /** Serialized hysteresis counters and signed distances preserve replay at any phase. */
  rainDwell: number;
  raining: boolean;
  convecting: boolean;
  previousDistances: Record<string, number>;
}
const clamp = (v: number, lo = 0, hi = 1) =>
  Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));
function random(s: WeatherState): number {
  s.rng = (Math.imul(s.rng, 1664525) + 1013904223) >>> 0;
  return s.rng / 4294967296;
}
const emptyObservation = (): RichWeatherObservation => ({
  id: "weather:0",
  tick: 0,
  frontPassage: false,
  precipitationPattern: "dry",
  interaction: 0,
  windDirection: 0,
  front: "clear",
  intensity: 0,
  autoIntensity: 0,
  regionalContribution: 0,
  precipitation: 0,
  gustiness: 0,
  temperature: 0.5,
  temperatureTrend: 0,
  thermalBand: "temperate",
  fog: 0,
  visibility: 1,
  stormStrength: 0,
  lightning: false,
  solarHeating: 0.6,
  moisture: 0,
  instability: 0,
  wind: 0,
  cloudCover: 0,
  lift: 0,
  convection: 0,
  frontDistance: 1,
  passage: false,
  clearingDuration: 0,
  events: [],
});
export function createWeatherState(seed: number): WeatherState {
  const s: WeatherState = {
    version: 1,
    seed: seed >>> 0,
    rng: (seed ^ 0x77656174) >>> 0,
    tick: 0,
    phase: 0,
    weatherTick: 0,
    nextFrontId: 1,
    fronts: [],
    cells: [],
    observer: { x: 0.5, y: 0.5 },
    wind: { x: 0.12, y: 0.025 },
    moisture: 0.6,
    instability: 0.25,
    temperature: 0.5,
    solarHeating: 0.6,
    fog: 0,
    foggy: false,
    lightningCooldown: 0,
    paused: false,
    musicalIntensity: null,
    events: [],
    observation: emptyObservation(),
    rainDwell: 0,
    raining: false,
    convecting: false,
    previousDistances: {},
  };
  // Sixteen persistent, advected cloud/rain reservoirs; no particle spawning allocation.
  s.cells = Array.from({ length: 16 }, (_, id) => ({
    id,
    x: ((id % 4) + 0.5) / 4,
    y: (Math.floor(id / 4) + 0.5) / 4,
    cloud: 0,
    rain: 0,
  }));
  s.fronts.push({
    id: "front:0",
    kind: random(s) < 0.5 ? "cold" : "warm",
    x: 0.12,
    speed: 0.008 + random(s) * 0.005,
    moisture: 0.6,
    instability: 0.25,
  });
  s.observation = deriveObservation(s, 0.5);
  return s;
}
/** Parallel north/south boundaries advance eastward. Faster boundaries stop before
 * crossing; occlusion is intentionally outside this illustrative topology. Front
 * propagation is independent of wind and advected cloud reservoir locations.
 * Narrow cold lift / broad warm lift = max(0,1-|x-front.x|/width).
 * Temperature is derived from the advancing air mass, never a cell random walk. */
export function sampleWeather(
  s: WeatherState,
  x: number,
  y: number,
): WeatherSample {
  x = clamp(x);
  y = clamp(y);
  let temperature = s.temperature,
    lift = 0,
    moisture = s.moisture,
    instability = s.instability;
  for (const f of s.fronts) {
    const distance = x - f.x;
    const influence = clamp(
      1 - Math.abs(distance) / (f.kind === "cold" ? 0.13 : 0.28),
    );
    lift = Math.max(lift, influence);
    temperature +=
      (f.kind === "cold" ? -0.24 : 0.24) * clamp((f.x - x + 0.08) / 0.16);
    moisture += (f.moisture - s.moisture) * influence;
    instability += (f.instability - s.instability) * influence;
  }
  let cloudCover = 0,
    precipitation = 0,
    weights = 0;
  for (const c of s.cells) {
    const weight = 1 / (0.025 + (x - c.x) ** 2 + (y - c.y) ** 2);
    weights += weight;
    cloudCover += c.cloud * weight;
    precipitation += c.rain * weight;
  }
  return {
    temperature: clamp(temperature),
    moisture: clamp(moisture),
    instability: clamp(instability),
    lift: clamp(lift),
    cloudCover: cloudCover / weights,
    precipitation: precipitation / weights,
  };
}
function deriveObservation(
  s: WeatherState,
  previousTemperature: number,
  smooth = false,
): RichWeatherObservation {
  const local = sampleWeather(s, s.observer.x, s.observer.y);
  // The listener remains authoritative: only a westward/upstream approaching
  // boundary within half the map contributes, with at most 10% weight. This is
  // an artistic anticipation policy, not atmospheric transport or remote rain.
  const approaching = s.fronts
    .filter((f) => f.x < s.observer.x && s.observer.x - f.x < 0.5)
    .sort((a, b) => b.x - a.x)[0];
  const regionalContribution = approaching
    ? 0.1 * clamp(1 - (s.observer.x - approaching.x) / 0.5)
    : 0;
  const regional = approaching
    ? sampleWeather(s, approaching.x, s.observer.y)
    : local;
  const blended = { ...local };
  for (const key of Object.keys(blended) as (keyof WeatherSample)[])
    blended[key] =
      local[key] * (1 - regionalContribution) +
      regional[key] * regionalContribution;
  const nearest = [...s.fronts].sort(
    (a, b) => Math.abs(a.x - s.observer.x) - Math.abs(b.x - s.observer.x),
  )[0];
  const distance = nearest ? Math.abs(nearest.x - s.observer.x) : 1;
  const wind = clamp(Math.hypot(s.wind.x, s.wind.y));
  // Compute convection eligibility at each source BEFORE blending; combining
  // wet stable local air with dry unstable regional air cannot invent a storm.
  const activity = (v: WeatherSample) =>
    clamp((v.instability - 0.55) / 0.45) * v.precipitation * v.lift;
  const convection =
    activity(local) * (1 - regionalContribution) +
    activity(regional) * regionalContribution;
  // Storm diagnosis is strictly local; regional anticipation cannot cause lightning.
  const stormStrength =
    clamp((local.instability - 0.55) / 0.45) *
    clamp((local.moisture - 0.5) / 0.5) *
    local.lift *
    clamp((local.cloudCover - 0.2) / 0.6);
  const autoIntensity = clamp(
    0.55 * blended.precipitation + 0.2 * wind + 0.25 * convection,
  );
  const target: RichWeatherObservation = {
    ...blended,
    regionalContribution,
    thermalBand:
      local.temperature < 0.22
        ? "cold"
        : local.temperature < 0.42
          ? "chilly"
          : local.temperature > 0.73
            ? "hot"
            : "temperate",
    fog: s.fog,
    visibility: 1 - 0.9 * s.fog,
    stormStrength,
    lightning: false,
    solarHeating: s.solarHeating,
    id: `weather:${s.tick}`,
    tick: s.tick,
    front: distance < 0.35 ? nearest!.kind : "clear",
    ...(nearest ? { frontId: nearest.id } : {}),
    frontPassage: s.events.some((e) => e.kind === "passage"),
    precipitationPattern:
      local.precipitation < 0.04
        ? "dry"
        : nearest?.kind === "warm"
          ? "steady"
          : "showers",
    interaction: 0,
    windDirection: Math.atan2(s.wind.y, s.wind.x),
    frontDistance: clamp(distance),
    temperatureTrend: clamp(
      (local.temperature - previousTemperature) * 10,
      -1,
      1,
    ),
    wind,
    gustiness: clamp(wind * (0.2 + local.lift * 0.6)),
    convection,
    autoIntensity,
    intensity: s.musicalIntensity ?? autoIntensity,
    passage: s.events.some((e) => e.kind === "passage"),
    clearingDuration:
      local.precipitation < 0.04 && local.cloudCover < 0.2
        ? s.observation.clearingDuration + 0.1
        : 0,
    events: s.events.map((e) => ({ ...e })),
  };
  if (smooth) {
    // EMA at deterministic dt=.1: y += .75*(target-y). 98.4% of a
    // step is reached in 300ms (93.75% in 200ms). Previous observation IS
    // serialized filter state; no frame-clock, RNG or manual-intensity input.
    for (const key of [
      "temperature",
      "moisture",
      "instability",
      "lift",
      "cloudCover",
      "precipitation",
      "wind",
      "gustiness",
      "convection",
      "autoIntensity",
      "frontDistance",
    ] as const)
      target[key] =
        s.observation[key] + 0.75 * (target[key] - s.observation[key]);
    target.temperatureTrend = clamp(
      (target.temperature - previousTemperature) * 10,
      -1,
      1,
    );
    const angle = Math.atan2(
      Math.sin(target.windDirection - s.observation.windDirection),
      Math.cos(target.windDirection - s.observation.windDirection),
    );
    target.windDirection = s.observation.windDirection + 0.75 * angle;
    target.intensity = s.musicalIntensity ?? target.autoIntensity;
  }
  return target;
}
export function observeWeather(s: WeatherState): RichWeatherObservation {
  return {
    ...s.observation,
    intensity: s.musicalIntensity ?? s.observation.autoIntensity,
    events: s.observation.events.map((e) => ({ ...e })),
  };
}
/** Commands apply at their exact 60Hz tick, before divider advancement. Supply a
 * replay log on every call or just commands for the current tick; future entries
 * are ignored. All mutable simulation state (including RNG and phase) is saved. */
export function stepWeather(
  saved: WeatherState,
  commands: readonly WeatherCommand[] = [],
): WeatherState {
  const s = structuredClone(saved);
  for (const c of commands) {
    if (c.tick !== s.tick) continue;
    switch (c.type) {
      case "add-front": {
        if (s.fronts.length >= 4) break;
        const x = clamp(c.x ?? 0.02);
        if (s.fronts.some((f) => Math.abs(f.x - x) < 0.025)) break;
        s.fronts.push({
          id: `front:${s.nextFrontId++}`,
          kind: c.kind,
          x,
          speed: c.kind === "cold" ? 0.014 : 0.009,
          moisture: clamp(c.moisture ?? s.moisture),
          instability: clamp(c.instability ?? s.instability),
        });
        break;
      }
      case "set-temperature":
        s.temperature = clamp(c.value);
        break;
      case "set-solar-heating":
        s.solarHeating = clamp(c.value);
        break;
      case "set-moisture":
        s.moisture = clamp(c.value);
        s.fronts.forEach((f) => (f.moisture = s.moisture));
        break;
      case "set-instability":
        s.instability = clamp(c.value);
        s.fronts.forEach((f) => (f.instability = s.instability));
        break;
      case "set-wind":
        s.wind = { x: clamp(c.x, -1, 1), y: clamp(c.y, -1, 1) };
        break;
      case "move-observer":
        s.observer = { x: clamp(c.x), y: clamp(c.y) };
        break;
      case "set-musical-intensity":
        s.musicalIntensity = c.value === null ? null : clamp(c.value);
        break;
      case "pause":
        s.paused = c.value;
        break;
    }
  }
  s.tick++;
  if (s.paused) return s;
  s.phase = (s.phase + 1) % 6;
  if (s.phase !== 0) return s;
  s.weatherTick++;
  s.events = [];
  const event = (kind: WeatherEvent["kind"], frontId?: string) => {
    if (s.events.length < 8)
      s.events.push({
        id: `weather-event:${s.tick}:${s.events.length}`,
        tick: s.tick,
        kind,
        ...(frontId ? { frontId } : {}),
      });
  };
  s.fronts.sort((a, b) => b.x - a.x);
  let ahead = 1.4;
  for (const f of s.fronts) {
    const oldDistance = s.previousDistances[f.id] ?? f.x - s.observer.x;
    // Small bounded seeded disturbance sampled only by the weather clock.
    f.x = Math.min(
      ahead - 0.025,
      f.x + f.speed * 0.1 * (0.98 + random(s) * 0.04),
    );
    ahead = f.x;
    const distance = f.x - s.observer.x;
    if (oldDistance < 0 && distance >= 0) event("passage", f.id);
    s.previousDistances[f.id] = distance;
  }
  const departed = s.fronts.some((f) => f.x >= 1.25);
  s.fronts = s.fronts.filter((f) => f.x < 1.25);
  // Replace a departed system from the west, giving indefinite seeded evolution.
  // Moisture and instability vary independently; neither is derived from kind.
  if (departed && s.fronts.length < 4 && !s.fronts.some((f) => f.x < 0.05)) {
    s.fronts.push({
      id: `front:${s.nextFrontId++}`,
      kind: random(s) < 0.5 ? "cold" : "warm",
      x: 0,
      speed: 0.008 + random(s) * 0.008,
      moisture: clamp(s.moisture + (random(s) - 0.5) * 0.35),
      instability: clamp(s.instability + (random(s) - 0.5) * 0.4),
    });
  }
  s.previousDistances = Object.fromEntries(
    s.fronts.map((f) => [
      f.id,
      s.previousDistances[f.id] ?? f.x - s.observer.x,
    ]),
  );
  for (const cell of s.cells) {
    cell.x = (cell.x + s.wind.x * 0.003 + 1) % 1;
    cell.y = (cell.y + s.wind.y * 0.003 + 1) % 1;
    const field = sampleWeather(s, cell.x, cell.y);
    // Relative reservoirs integrated at dt=.1: condensation requires moisture
    // and lift. Rain requires accumulated cloud and moisture; convection ALSO
    // requires independent instability. Source/sink caps prevent instant toggles.
    const condensation = clamp((field.moisture - 0.25) / 0.75) * field.lift;
    cell.cloud = clamp(
      cell.cloud + 0.1 * (condensation * 0.6 - cell.cloud * 0.09),
    );
    const rainSource =
      clamp((cell.cloud - 0.28) / 0.72) *
      clamp((field.moisture - 0.35) / 0.65) *
      field.lift;
    cell.rain = clamp(cell.rain + 0.1 * (rainSource * 0.8 - cell.rain * 0.22));
  }
  const surface = sampleWeather(s, s.observer.x, s.observer.y);
  // Illustrative radiation-fog reservoir: moist, stable air, surface cooling and
  // light wind. This is not a dew-point calculation or a model of advection fog.
  const calm = clamp(1 - Math.hypot(s.wind.x, s.wind.y) / 0.3);
  const cooling = (1 - s.solarHeating) * (1 - surface.cloudCover * 0.7);
  const fogSource =
    clamp((surface.moisture - 0.65) / 0.35) *
    calm *
    cooling *
    (1 - surface.instability) *
    clamp((0.7 - surface.temperature) / 0.4);
  s.fog = clamp(
    s.fog +
      0.1 *
        (fogSource * 0.5 -
          s.fog * (0.04 + s.solarHeating * 0.5 + (1 - calm) * 0.7)),
  );
  const foggy = s.fog > (s.foggy ? 0.12 : 0.25);
  if (foggy !== s.foggy) event(foggy ? "fog-start" : "fog-end");
  s.foggy = foggy;
  const previousTemperature = s.observation.temperature;
  s.observation = deriveObservation(s, previousTemperature, true);
  const wet = s.observation.precipitation > (s.raining ? 0.035 : 0.065);
  s.rainDwell = wet !== s.raining ? s.rainDwell + 1 : 0;
  if (s.rainDwell >= 10) {
    s.raining = wet;
    s.rainDwell = 0;
    event(wet ? "rain-start" : "rain-end");
  }
  const convecting = s.observation.convection > (s.convecting ? 0.025 : 0.06);
  if (convecting && !s.convecting) event("convection-start");
  s.convecting = convecting;
  s.lightningCooldown = Math.max(0, s.lightningCooldown - 1);
  if (s.observation.stormStrength > 0.12 && s.lightningCooldown === 0) {
    event("lightning");
    // Seed-independent cadence avoids consuming the front-motion random stream.
    s.lightningCooldown = 25 + (((s.seed ^ s.weatherTick) >>> 0) % 26);
    s.observation.lightning = true;
  }
  s.observation.events = s.events.map((e) => ({ ...e }));
  return s;
}
export type WeatherFixture =
  | "dry-cold"
  | "moist-warm"
  | "unstable-cold"
  | "clearing";
export function createWeatherFixture(
  kind: WeatherFixture,
  seed = 1,
): WeatherState {
  const s = createWeatherState(seed);
  s.moisture = kind === "dry-cold" || kind === "clearing" ? 0.08 : 0.95;
  s.instability = kind === "unstable-cold" ? 0.95 : 0.15;
  s.fronts =
    kind === "clearing"
      ? []
      : [
          {
            id: "front:0",
            kind: kind === "moist-warm" ? "warm" : "cold",
            x: 0.48,
            speed: 0.004,
            moisture: s.moisture,
            instability: s.instability,
          },
        ];
  s.observation = deriveObservation(s, 0.5);
  return s;
}

export type WeatherRecipe =
  | "fog"
  | "thunderstorm"
  | "chilly"
  | "hot"
  | "clear"
  | "rain";
/** Apply to a fresh seeded state. Recipes set ingredients, never force an outcome. */
export function weatherRecipeCommands(
  recipe: WeatherRecipe,
  tick = 0,
): WeatherCommand[] {
  const settings = {
    fog: [1, 0.05, 0.28, 0, 0.02],
    thunderstorm: [1, 1, 0.65, 0.8, 0.22],
    chilly: [0.12, 0.15, 0.3, 0.35, 0.12],
    hot: [0.08, 0.25, 0.94, 1, 0.12],
    clear: [0.15, 0.15, 0.55, 0.6, 0.12],
    rain: [1, 0.15, 0.5, 0.35, 0.12],
  }[recipe];
  const [moisture, instability, temperature, solar, wind] = settings;
  return [
    { tick, type: "set-moisture", value: moisture! },
    { tick, type: "set-instability", value: instability! },
    { tick, type: "set-temperature", value: temperature! },
    { tick, type: "set-solar-heating", value: solar! },
    { tick, type: "set-wind", x: wind!, y: 0 },
    { tick, type: "move-observer", x: 0.5, y: 0.5 },
    ...(recipe === "rain" || recipe === "thunderstorm"
      ? [
          {
            tick,
            type: "add-front" as const,
            kind: "warm" as const,
            x: 0.48,
            moisture: moisture!,
            instability: instability!,
          },
        ]
      : []),
  ];
}
