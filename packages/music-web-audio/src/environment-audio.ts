/** Auxiliary audio shares its owner's device/master and never consumes music slots. */
export interface NoiseBedOptions {
  seed: number;
  level: number;
  filterHz: number;
  pan?: number;
  kind?: "lowpass" | "highpass" | "bandpass";
  rampSeconds?: number;
  /** Explicit opt-in: legacy two-second seeded buffer semantics stay unchanged. */
  profile?: "weather-evolving-1";
  texture?: "wind" | "rain";
  gustiness?: number;
  activity?: number;
}
export interface ScheduledSampleOptions {
  atContextTime?: number;
  gain?: number;
  pan?: number;
  duck?: { gain: number; holdSeconds?: number; releaseSeconds?: number };
}
const valid = (v: number, lo: number, hi: number) =>
  Number.isFinite(v) && v >= lo && v <= hi;
interface Duck {
  at: number;
  gain: number;
  hold: number;
  release: number;
}
const evolvingContexts = new WeakMap<AudioContext, Promise<void>>();
export class EnvironmentAudio {
  private evolvingBeds = new Map<
    string,
    {
      node: AudioWorkletNode;
      seed: number;
      texture: "wind" | "rain";
      targets: readonly number[];
    }
  >();
  private evolvingReady = false;
  private disposed = false;
  private evolvingFailed = false;
  private processorFailures = 0;
  /** Static same-origin worklet; no blob/eval or CSP exceptions. */
  async prepareEvolvingProfile() {
    if (this.disposed) throw Error("Environment owner disposed");
    let pending = evolvingContexts.get(this.ctx);
    if (!pending) {
      pending = this.ctx.audioWorklet.addModule(
        new URL("./environment-texture-worklet.js?no-inline", import.meta.url)
          .href,
      );
      evolvingContexts.set(this.ctx, pending);
      pending.catch(() => evolvingContexts.delete(this.ctx));
    }
    await pending;
    if (this.disposed || this.ctx.state !== "running")
      throw Error("Environment preparation cancelled");
    this.evolvingReady = true;
  }
  readResources() {
    return {
      logicalBeds: this.beds.size + this.evolvingBeds.size,
      legacyBufferBytes: [...this.beds.values()].reduce(
        (n, b) => n + (b.source.buffer?.length ?? 0) * 4,
        0,
      ),
      evolvingProcessors: this.evolvingBeds.size,
      internalTextureLayers: this.evolvingBeds.size * 2,
      effects: this.effects.size,
      processorFailures: this.processorFailures,
    };
  }
  private effects = new Map<() => void, number>();
  private beds = new Map<
    string,
    {
      source: AudioBufferSourceNode;
      gain: GainNode;
      filter: BiquadFilterNode;
      pan: StereoPannerNode;
      seed: number;
      kind: string;
    }
  >();
  private ducks = new Set<Duck>();
  private bus: GainNode;
  constructor(
    private ctx: AudioContext,
    private master: GainNode,
    private music: GainNode,
  ) {
    this.bus = ctx.createGain();
    this.bus.connect(master);
  }
  get captureTap(): AudioNode {
    return this.bus;
  }
  setVolume(gain: number, rampSeconds: number) {
    const now = this.ctx.currentTime,
      p = this.bus.gain;
    if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(now);
    else {
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
    }
    p.linearRampToValueAtTime(gain, now + rampSeconds);
  }
  dispose() {
    this.disposed = true;
    this.stop();
    this.bus.disconnect();
  }
  schedule(buffer: AudioBuffer, o: ScheduledSampleOptions = {}) {
    const ctx = this.ctx,
      now = ctx.currentTime,
      at = o.atContextTime ?? now;
    this.prune();
    if (
      ctx.state !== "running" ||
      !valid(at, now, now + 10) ||
      !valid(o.gain ?? 0.7, 0, 1) ||
      !valid(o.pan ?? 0, -1, 1) ||
      this.effects.size >= 4 ||
      (o.duck &&
        (!this.validDuck(
          o.duck.gain,
          o.duck.holdSeconds ?? 0.3,
          o.duck.releaseSeconds ?? 0.7,
          at,
          now,
        ) ||
          this.ducks.size >= 16))
    )
      return null;
    const source = ctx.createBufferSource(),
      gain = ctx.createGain(),
      pan = ctx.createStereoPanner();
    source.buffer = buffer;
    gain.gain.setValueAtTime(o.gain ?? 0.7, at);
    pan.pan.setValueAtTime(o.pan ?? 0, at);
    source.connect(gain);
    gain.connect(pan);
    pan.connect(this.bus);
    let done = false;
    const duck = o.duck
      ? this.addDuck(
          o.duck.gain,
          o.duck.holdSeconds ?? 0.3,
          o.duck.releaseSeconds ?? 0.7,
          at,
        )
      : null;
    const cleanup = () => {
      if (done) return;
      done = true;
      source.disconnect();
      gain.disconnect();
      pan.disconnect();
      this.effects.delete(stop);
    };
    const stop = () => {
      if (done) return;
      source.stop();
      if (duck) {
        this.ducks.delete(duck);
        this.automate();
      }
      cleanup();
    };
    source.onended = cleanup;
    this.effects.set(stop, at + buffer.duration);
    source.start(at);
    return stop;
  }
  private prune() {
    for (const [stop, end] of this.effects)
      if (end <= this.ctx.currentTime) stop();
    for (const d of this.ducks)
      if (d.at + d.hold + d.release <= this.ctx.currentTime)
        this.ducks.delete(d);
  }
  private validDuck(
    g: number,
    h: number,
    r: number,
    at: number,
    now = this.ctx.currentTime,
  ) {
    return (
      valid(g, 0, 1) &&
      valid(h, 0, 3) &&
      valid(r, 0.01, 3) &&
      valid(at, now, now + 10)
    );
  }
  duck(gain: number, hold = 0.3, release = 0.7, at?: number) {
    const now = this.ctx.currentTime;
    at ??= now;
    this.prune();
    if (!this.validDuck(gain, hold, release, at, now) || this.ducks.size >= 16)
      return false;
    this.addDuck(gain, hold, release, at);
    return true;
  }
  private addDuck(gain: number, hold: number, release: number, at: number) {
    const d = { gain, hold, release, at };
    this.ducks.add(d);
    this.automate();
    return d;
  }
  private automate() {
    const now = this.ctx.currentTime,
      p = this.music.gain,
      ds = [...this.ducks];
    const envelope = (d: Duck, t: number) =>
      t < d.at - 0.01
        ? 1
        : t < d.at
          ? 1 + ((d.gain - 1) * (t - d.at + 0.01)) / 0.01
          : t <= d.at + d.hold
            ? d.gain
            : Math.min(
                1,
                d.gain + ((1 - d.gain) * (t - d.at - d.hold)) / d.release,
              );
    const value = (t: number) => Math.min(1, ...ds.map((d) => envelope(d, t)));
    const times = new Set<number>([now]);
    for (const d of ds)
      for (const t of [
        d.at - 0.01,
        d.at,
        d.at + d.hold,
        d.at + d.hold + d.release,
      ])
        if (t >= now) times.add(t);
    // Every envelope is linear between these endpoints. Add all pairwise
    // crossings, including release/hold and attack/release intersections.
    const breaks = [...times].sort((a, b) => a - b);
    for (let i = 1; i < breaks.length; i++) {
      const lo = breaks[i - 1],
        hi = breaks[i];
      for (let a = 0; a < ds.length; a++)
        for (let b = a + 1; b < ds.length; b++) {
          const left = envelope(ds[a], lo) - envelope(ds[b], lo),
            right = envelope(ds[a], hi) - envelope(ds[b], hi);
          if (left * right < 0)
            times.add(lo + ((hi - lo) * left) / (left - right));
        }
    }
    p.cancelScheduledValues(now);
    p.setValueAtTime(value(now), now);
    for (const t of [...times].sort((a, b) => a - b)) {
      if (t <= now) continue;
      p.linearRampToValueAtTime(value(t), t);
    }
  }
  setBed(id: string, o: NoiseBedOptions) {
    const kind = o.kind ?? "lowpass";
    if (
      this.disposed ||
      this.ctx.state !== "running" ||
      !/^[a-z][a-z0-9-]{0,31}$/.test(id) ||
      !Number.isSafeInteger(o.seed) ||
      !valid(o.level, 0, 1) ||
      !valid(o.filterHz, 20, 20000) ||
      !valid(o.pan ?? 0, -1, 1) ||
      !valid(o.rampSeconds ?? 0.2, 0.01, 2) ||
      !["lowpass", "highpass", "bandpass"].includes(kind)
    )
      return false;
    if (o.profile !== undefined && o.profile !== "weather-evolving-1")
      return false;
    if (o.profile === "weather-evolving-1") {
      if (
        !this.evolvingReady ||
        !["wind", "rain"].includes(o.texture ?? "") ||
        !valid(o.gustiness ?? 0, 0, 1) ||
        !valid(o.activity ?? 0, 0, 1)
      )
        return false;
      return this.setEvolvingBed(id, o);
    }
    if (this.evolvingBeds.has(id)) this.stopBed(id);
    let b = this.beds.get(id);
    if (b && (b.seed !== o.seed || b.kind !== kind)) {
      this.stopBed(id);
      b = undefined;
    }
    if (!b) {
      if (this.beds.size + this.evolvingBeds.size >= 2) return false;
      const source = this.ctx.createBufferSource(),
        gain = this.ctx.createGain(),
        filter = this.ctx.createBiquadFilter(),
        pan = this.ctx.createStereoPanner(),
        buffer = this.ctx.createBuffer(
          1,
          Math.min(48000, this.ctx.sampleRate) * 2,
          Math.min(48000, this.ctx.sampleRate),
        ),
        data = buffer.getChannelData(0);
      let state = o.seed >>> 0;
      for (let i = 0; i < data.length; i++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        data[i] = state / 2147483648 - 1;
      }
      source.buffer = buffer;
      source.loop = true;
      filter.type = kind;
      gain.gain.setValueAtTime(0, this.ctx.currentTime);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(pan);
      pan.connect(this.bus);
      b = { source, gain, filter, pan, seed: o.seed, kind };
      this.beds.set(id, b);
      source.start(this.ctx.currentTime);
    }
    const now = this.ctx.currentTime,
      end = now + (o.rampSeconds ?? 0.2);
    for (const [p, value] of [
      [b.gain.gain, o.level],
      [b.filter.frequency, o.filterHz],
      [b.pan.pan, o.pan ?? 0],
    ] as const) {
      if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(now);
      else {
        p.cancelScheduledValues(now);
        p.setValueAtTime(p.value, now);
      }
      p.linearRampToValueAtTime(value, end);
    }
    return true;
  }
  private setEvolvingBed(id: string, o: NoiseBedOptions) {
    if (this.evolvingFailed) return false;
    let bed = this.evolvingBeds.get(id);
    if (
      this.beds.has(id) ||
      (bed && (bed.seed !== o.seed || bed.texture !== o.texture))
    ) {
      this.stopBed(id);
      bed = undefined;
    }
    if (!bed) {
      if (this.beds.size + this.evolvingBeds.size >= 2) return false;
      const node = new AudioWorkletNode(this.ctx, "weather-evolving-1", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { seed: o.seed, texture: o.texture },
      });
      node.onprocessorerror = () => {
        // Latch failure until explicit stop/start; 10-Hz observations must not
        // turn a processor fault into an unbounded retry/allocation loop.
        if (this.evolvingBeds.get(id)?.node !== node) return;
        this.processorFailures++;
        this.evolvingFailed = true;
        this.stopBed(id);
      };
      node.connect(this.bus);
      bed = { node, seed: o.seed, texture: o.texture!, targets: [] };
      this.evolvingBeds.set(id, bed);
    }
    const targets = [
      o.level,
      o.filterHz,
      Math.max(-0.22, Math.min(0.22, o.pan ?? 0)),
      o.gustiness ?? 0,
      o.activity ?? 0,
    ];
    const names = ["level", "filterHz", "pan", "gustiness", "activity"];
    targets.forEach((value, index) => {
      // Motion runs continuously inside the worklet. Stable observations add no
      // automation; changing targets only drives its 650ms exponential smoother.
      if (value !== bed!.targets[index])
        bed!.node.parameters
          .get(names[index])!
          .setValueAtTime(value, this.ctx.currentTime);
    });
    bed.targets = targets;
    return true;
  }
  stopBed(id: string) {
    const evolving = this.evolvingBeds.get(id);
    if (evolving) {
      evolving.node.port.postMessage("stop");
      evolving.node.port.close();
      evolving.node.disconnect();
      this.evolvingBeds.delete(id);
    }
    const b = this.beds.get(id);
    if (!b) return;
    b.source.stop();
    b.source.disconnect();
    b.filter.disconnect();
    b.gain.disconnect();
    b.pan.disconnect();
    this.beds.delete(id);
  }
  stop() {
    this.evolvingFailed = false;
    for (const stop of [...this.effects.keys()]) stop();
    for (const id of [...this.beds.keys(), ...this.evolvingBeds.keys()])
      this.stopBed(id);
    this.ducks.clear();
    this.music.gain.cancelScheduledValues(this.ctx.currentTime);
    this.music.gain.setValueAtTime(1, this.ctx.currentTime);
  }
}
