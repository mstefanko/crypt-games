/** weather-evolving-1: deterministic continuous noise, no PCM loops or UI timers.
 * Per processor: one shared wash and one quiet independent detail layer; two
 * logical beds therefore bound this graph to four internal texture layers.
 * Time is rendered frames since start: suspension freezes motion; stop/replay
 * recreates the seed at t=0. No physical wind-distance scale is implied. */
export class WeatherTexture {
  constructor(seed, kind, rate) {
    this.kind = kind;
    this.rate = rate;
    this.smoothing = 1 - Math.exp(-1 / (rate * 0.65));
    this.washLowCoefficient = 1 - Math.exp((-2 * Math.PI * 45) / rate);
    this.detailCoefficient =
      1 - Math.exp((-2 * Math.PI * (kind === "rain" ? 4200 : 900)) / rate);
    this.detailLowCoefficient =
      1 - Math.exp((-2 * Math.PI * (kind === "rain" ? 950 : 100)) / rate);
    this.noiseState = seed >>> 0 || 1;
    this.motionState = ((seed >>> 0) ^ 0x9e3779b9) >>> 0;
    this.frames = 0;
    this.wash = 0;
    this.washLow = 0;
    this.detail = 0;
    this.detailLow = 0;
    this.level = 0;
    this.pan = 0;
    this.activity = 0;
    this.gustiness = 0;
    this.filterHz = kind === "wind" ? 420 : 1700;
    this.gust = this.segment(0, 0.5, "gust");
    this.drift = this.segment(0, 0.8, "drift");
    this.surface = this.segment(0, 0.5, "surface");
    this.outputLeft = 0;
    this.outputRight = 0;
  }
  random(motion = false) {
    const key = motion ? "motionState" : "noiseState";
    this[key] = (Math.imul(this[key], 1664525) + 1013904223) >>> 0;
    return this[key] / 4294967296;
  }
  segment(at, from, kind) {
    const r = this.random(true);
    const duration =
      kind === "gust"
        ? 3 + r * 9
        : kind === "drift"
          ? 15 + r * 30
          : 0.35 + r * 2.25;
    const target = this.random(true);
    const to =
      kind === "gust"
        ? target < 0.32
          ? 0.08 + target * 0.5
          : 0.35 + target * 0.65
        : kind === "drift"
          ? 0.65 + target * 0.35
          : 0.15 + target * 0.85;
    return { at, end: at + duration, from, to, kind };
  }
  motion(key, time) {
    let s = this[key];
    if (time >= s.end) s = this[key] = this.segment(s.end, s.to, s.kind);
    const t = Math.min(1, Math.max(0, (time - s.at) / (s.end - s.at)));
    return s.from + (s.to - s.from) * t * t * (3 - 2 * t);
  }
  /** No per-sample allocations. Inputs are bounded by AudioParam descriptors. */
  processInto(level, filterHz, pan, gustiness, activity) {
    const time = this.frames++ / this.rate;
    const slow = this.smoothing;
    this.level += slow * (level - this.level);
    this.pan += slow * (pan - this.pan);
    this.gustiness += slow * (gustiness - this.gustiness);
    this.activity += slow * (activity - this.activity);
    this.filterHz += slow * (filterHz - this.filterHz);
    const gust = this.motion("gust", time),
      drift = this.motion("drift", time),
      surface = this.motion("surface", time);
    const cutoff = Math.min(
      this.rate * 0.4,
      this.filterHz * (0.78 + drift * 0.22 + gust * 0.25),
    );
    const a = 1 - Math.exp((-2 * Math.PI * cutoff) / this.rate);
    this.wash += a * (this.random() * 2 - 1 - this.wash);
    this.washLow += this.washLowCoefficient * (this.wash - this.washLow);
    this.detail +=
      this.detailCoefficient * (this.random() * 2 - 1 - this.detail);
    this.detailLow +=
      this.detailLowCoefficient * (this.detail - this.detailLow);
    const depth = this.kind === "wind" ? 0.2 + 0.75 * this.gustiness : 0.16;
    const envelope = (1 - depth + depth * gust) * (0.8 + 0.2 * drift);
    const wash =
      (this.wash - this.washLow) * (this.kind === "wind" ? 2.2 : 1.35);
    const detail =
      (this.detail - this.detailLow) *
      (this.kind === "rain" ? 0.05 + this.activity * 0.065 : 0.065) *
      surface;
    // Shared centered wash keeps a strong mono sum. Opposed detail is quiet;
    // pan tendency/motion never exceeds .28 in this profile.
    const tendency = Math.max(
      -0.28,
      Math.min(0.28, this.pan + (drift - 0.825) * 0.22),
    );
    const angle = ((tendency + 1) * Math.PI) / 4;
    const amplitude = this.level * envelope;
    this.outputLeft = amplitude * (wash * Math.cos(angle) + detail * 0.7);
    this.outputRight = amplitude * (wash * Math.sin(angle) - detail * 0.7);
  }
}
if (typeof registerProcessor !== "undefined")
  registerProcessor(
    "weather-evolving-1",
    class extends AudioWorkletProcessor {
      static get parameterDescriptors() {
        return [
          {
            name: "level",
            defaultValue: 0,
            minValue: 0,
            maxValue: 1,
            automationRate: "k-rate",
          },
          {
            name: "filterHz",
            defaultValue: 1000,
            minValue: 20,
            maxValue: 20000,
            automationRate: "k-rate",
          },
          {
            name: "pan",
            defaultValue: 0,
            minValue: -0.22,
            maxValue: 0.22,
            automationRate: "k-rate",
          },
          {
            name: "gustiness",
            defaultValue: 0,
            minValue: 0,
            maxValue: 1,
            automationRate: "k-rate",
          },
          {
            name: "activity",
            defaultValue: 0,
            minValue: 0,
            maxValue: 1,
            automationRate: "k-rate",
          },
        ];
      }
      constructor(options) {
        super();
        this.texture = new WeatherTexture(
          options.processorOptions.seed,
          options.processorOptions.texture,
          sampleRate,
        );
        this.stopped = false;
        this.port.onmessage = (event) => {
          if (event.data === "stop") this.stopped = true;
        };
      }
      process(_inputs, outputs, p) {
        if (this.stopped) return false;
        const output = outputs[0];
        for (let i = 0; i < output[0].length; i++) {
          this.texture.processInto(
            p.level[0],
            p.filterHz[0],
            p.pan[0],
            p.gustiness[0],
            p.activity[0],
          );
          output[0][i] = this.texture.outputLeft;
          output[1][i] = this.texture.outputRight;
        }
        return true;
      }
    },
  );
