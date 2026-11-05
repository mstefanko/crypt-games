import { describe, expect, it } from "vitest";
import {
  weatherRecipeCommands,
  createWeatherFixture,
  createWeatherState,
  observeWeather,
  sampleWeather,
  stepWeather,
  type WeatherCommand,
  type WeatherState,
} from "./weather-model";
function run(
  s: WeatherState,
  ticks: number,
  commands: WeatherCommand[] = [],
): WeatherState {
  for (let i = 0; i < ticks; i++) s = stepWeather(s, commands);
  return s;
}
describe("bounded causal weather", () => {
  it("serializes the six-tick phase and replays independent of frame grouping", () => {
    const commands: WeatherCommand[] = [
      { tick: 11, type: "set-moisture", value: 0.9 },
      { tick: 80, type: "move-observer", x: 0.3, y: 0.7 },
      { tick: 97, type: "set-wind", x: 0.4, y: -0.2 },
    ];
    const direct = run(createWeatherState(42), 600, commands);
    let grouped = createWeatherState(42);
    for (const count of [17, 43, 1, 239, 300])
      grouped = run(JSON.parse(JSON.stringify(grouped)), count, commands);
    expect(grouped).toEqual(direct);
    expect(direct.weatherTick).toBe(100);
    expect(run(createWeatherState(42), 5).weatherTick).toBe(0);
  });
  it("requires moisture for rain and independent instability for convection", () => {
    const dry = observeWeather(run(createWeatherFixture("dry-cold"), 1800));
    const warm = observeWeather(run(createWeatherFixture("moist-warm"), 1800));
    const storm = observeWeather(
      run(createWeatherFixture("unstable-cold"), 1800),
    );
    expect(dry.precipitation).toBe(0);
    expect(dry.convection).toBe(0);
    expect(warm.precipitation).toBeGreaterThan(0.1);
    expect(warm.convection).toBe(0);
    expect(storm.convection).toBeGreaterThan(0.01);
  });
  it("manual musical intensity leaves all weather and RNG untouched", () => {
    const start = createWeatherFixture("unstable-cold");
    const auto = run(start, 600),
      manual = run(start, 600, [
        { tick: 0, type: "set-musical-intensity", value: 1 },
      ]);
    expect(manual.fronts).toEqual(auto.fronts);
    expect(manual.cells).toEqual(auto.cells);
    expect(manual.rng).toBe(auto.rng);
    expect(observeWeather(manual).intensity).toBe(1);
    expect(observeWeather(manual).autoIntensity).toBe(
      observeWeather(auto).autoIntensity,
    );
    expect(start.tick).toBe(0);
  });
  it("caps fronts, prevents crossing, bounds fields and event storage", () => {
    const commands: WeatherCommand[] = Array.from({ length: 20 }, (_, i) => ({
      tick: 0,
      type: "add-front",
      kind: "cold",
      x: i / 25,
      moisture: 10,
      instability: 10,
    }));
    let s = run(createWeatherState(6), 1200, commands);
    expect(s.fronts.length).toBeLessThanOrEqual(4);
    expect(s.cells).toHaveLength(16);
    expect(s.events.length).toBeLessThanOrEqual(8);
    for (let y = 0; y < 36; y++)
      for (let x = 0; x < 64; x++)
        for (const v of Object.values(sampleWeather(s, x / 63, y / 35))) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
    const xs = s.fronts.map((f) => f.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++)
      expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(0.024999);
  });
  it("decays reservoirs during clearing and pauses weather without losing replay commands", () => {
    let s = createWeatherFixture("clearing");
    s.cells.forEach((c) => {
      c.cloud = 0.7;
      c.rain = 0.7;
    });
    const cleared = run(s, 1800);
    expect(observeWeather(cleared).precipitation).toBeLessThan(0.01);
    const paused = run(s, 30, [
      { tick: 0, type: "pause", value: true },
      { tick: 20, type: "pause", value: false },
    ]);
    expect(paused.weatherTick).toBe(1);
    expect(paused.phase).toBe(4);
    expect(paused.tick).toBe(30);
  });
  it("smooths command steps at the weather clock with serialized filter memory", () => {
    const s = createWeatherFixture("clearing");
    const first = run(s, 6, [
      { tick: 0, type: "set-moisture", value: 1 },
      { tick: 0, type: "set-musical-intensity", value: 0.9 },
    ]);
    expect(observeWeather(first).moisture).toBeCloseTo(
      0.08 + 0.75 * (1 - 0.08),
    );
    expect(observeWeather(first).intensity).toBe(0.9);
    const replay = run(JSON.parse(JSON.stringify(first)), 12);
    expect(replay).toEqual(run(first, 12));
    expect(observeWeather(replay).moisture).toBeGreaterThan(0.98);
    expect(replay.rng).toBe(s.rng);
  });
  it("adds only a bounded approaching-region contribution and never changes physical samples", () => {
    const s = createWeatherFixture("dry-cold");
    s.observer = { x: 0.9, y: 0.5 };
    s.fronts[0]!.x = 0.55;
    s.fronts[0]!.moisture = 1;
    const physical = sampleWeather(s, 0.9, 0.5);
    const observed = observeWeather(run(s, 120));
    expect(observed.regionalContribution).toBeGreaterThan(0);
    expect(observed.regionalContribution).toBeLessThanOrEqual(0.1);
    expect(observed.moisture).toBeGreaterThan(physical.moisture);
    expect(observed.moisture - physical.moisture).toBeLessThan(0.1);
    expect(sampleWeather(s, 0.9, 0.5)).toEqual(physical);
    const passed = structuredClone(s);
    passed.fronts[0]!.x = 0.95;
    expect(observeWeather(run(passed, 6)).regionalContribution).toBe(0);
  });
});

describe("expanded local weather", () => {
  it("forms radiation fog only with moist stable calm cooling air and disperses under heating", () => {
    const initial = createWeatherFixture("clearing");
    const commands: WeatherCommand[] = [
      { tick: 0, type: "set-moisture", value: 1 },
      { tick: 0, type: "set-temperature", value: 0.25 },
      { tick: 0, type: "set-solar-heating", value: 0 },
      { tick: 0, type: "set-wind", x: 0.02, y: 0 },
    ];
    const fog = run(initial, 600, commands);
    expect(fog.observation.fog).toBeGreaterThan(0.5);
    expect(fog.observation.visibility).toBeLessThan(0.55);
    expect(fog.observation.thermalBand).toBe("chilly");
    expect(
      run(fog, 600, [{ tick: fog.tick, type: "set-solar-heating", value: 1 }])
        .fog,
    ).toBeLessThan(0.02);
    const dry = run(
      initial,
      600,
      commands.filter((c) => c.type !== "set-moisture"),
    );
    expect(dry.fog).toBe(0);
    expect(run(JSON.parse(JSON.stringify(fog)), 120)).toEqual(run(fog, 120));
  });
  it("gates local lightning on storm ingredients and bounds event cadence", () => {
    const storm = createWeatherFixture("unstable-cold", 2);
    storm.fronts[0]!.speed = 0;
    storm.cells.forEach((c) => {
      c.cloud = 0.95;
      c.rain = 0.8;
    });
    let s = storm,
      flashes = 0;
    for (let i = 0; i < 360; i++) {
      s = stepWeather(s);
      if (s.phase === 0 && s.observation.lightning) {
        flashes++;
        expect(s.observation.stormStrength).toBeGreaterThan(0.12);
        expect(s.events.some((e) => e.kind === "lightning")).toBe(true);
      }
    }
    expect(flashes).toBeGreaterThan(0);
    expect(flashes).toBeLessThanOrEqual(3);
    const stable = structuredClone(storm);
    stable.instability = 0;
    stable.fronts[0]!.instability = 0;
    expect(run(stable, 360).observation.stormStrength).toBe(0);
    const hot = run(createWeatherFixture("clearing"), 6, [
      { tick: 0, type: "set-temperature", value: 1 },
    ]);
    expect(hot.observation.thermalBand).toBe("hot");
    expect(hot.observation.stormStrength).toBe(0);
  });
});

it("ingredient recipes develop their advertised conditions within twenty seconds", () => {
  const recipe = (name: Parameters<typeof weatherRecipeCommands>[0]) =>
    run(createWeatherState(5), 1200, weatherRecipeCommands(name));
  expect(recipe("fog").observation.fog).toBeGreaterThan(0.25);
  expect(recipe("hot").observation.thermalBand).toBe("hot");
  expect(recipe("chilly").observation.thermalBand).toBe("chilly");
  expect(recipe("clear").observation.precipitation).toBeLessThan(0.04);
  expect(recipe("rain").observation.precipitation).toBeGreaterThan(0.04);
  let storm = createWeatherState(5),
    peak = 0,
    flashes = 0;
  for (let i = 0; i < 1200; i++) {
    storm = stepWeather(storm, weatherRecipeCommands("thunderstorm"));
    peak = Math.max(peak, storm.observation.stormStrength);
    if (storm.phase === 0 && storm.observation.lightning) flashes++;
  }
  expect(peak).toBeGreaterThan(0.12);
  expect(flashes).toBeGreaterThan(0);
});
