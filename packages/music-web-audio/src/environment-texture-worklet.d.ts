export class WeatherTexture {
  constructor(seed: number, kind: "wind" | "rain", rate: number);
  frames: number;
  outputLeft: number;
  outputRight: number;
  processInto(
    level: number,
    filterHz: number,
    pan: number,
    gustiness: number,
    activity: number,
  ): void;
}
