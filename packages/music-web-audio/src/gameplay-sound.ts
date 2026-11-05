import { EnvironmentAudio } from "./environment-audio";
export interface SoundLayer {
  onset?: number;
  pan?: number;
  attack?: number;
  endFilterHz?: number;
  waveform?: OscillatorType | "noise";
  frequency?: number;
  endFrequency?: number;
  duration?: number;
  gain?: number;
  filterHz?: number;
  priority?: number;
}
export interface SoundGesture extends SoundLayer {
  /** At most six layers and three seeded material variants per gesture. */
  layers?: readonly SoundLayer[];
  variants?: readonly (readonly SoundLayer[])[];
  waveform?: OscillatorType | "noise";
  frequency?: number;
  endFrequency?: number;
  duration?: number;
  gain?: number;
  filterHz?: number;
  priority?: number;
}
export interface SoundEvent {
  sequence: number;
  tick: number;
  /** Optional shared AudioContext onset; bounded to the admission horizon. */
  audioTime?: number;
  sourceId: string;
  kind: string;
  payload?: {
    gain?: number;
    pitch?: number;
    pan?: number;
    [key: string]: unknown;
  };
}
export interface ContinuousSound {
  id: string;
  kind: "noise" | "motor" | "wind" | "water" | "rain" | "hum" | "charge";
  family?: string;
  filterHz?: number;
  gain: number;
  frequency: number;
  pan?: number;
  seed?: number;
}
const clamp = (v: number, min: number, max: number) =>
  Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : min;
/** Bounded one-shot gestures and persistent source-owned voices. No game-specific event labels. */
export class GameplaySoundOwner {
  private environment: EnvironmentAudio;
  private dummyMusic: GainNode;
  private noise: AudioBuffer;
  private sequence = -1;
  private beds = new Set<string>();
  private motors = new Map<
    string,
    {
      osc: OscillatorNode;
      harmonic: OscillatorNode;
      gain: GainNode;
      pan: StereoPannerNode;
      filter: BiquadFilterNode;
    }
  >();
  private effects = new Set<{ stop: () => void; priority: number }>();
  constructor(
    private ctx: AudioContext,
    private destination: AudioNode,
    private duck: (strength: number) => void,
  ) {
    this.dummyMusic = ctx.createGain();
    this.environment = new EnvironmentAudio(
      ctx,
      destination as GainNode,
      this.dummyMusic,
    );
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    let seed = 41973;
    for (let i = 0; i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = (seed / 4294967296) * 2 - 1;
    }
  }
  events(
    events: readonly SoundEvent[],
    definitions: Readonly<Record<string, SoundGesture>>,
  ) {
    for (const event of events) {
      if (event.sequence <= this.sequence) continue;
      this.sequence = event.sequence;
      const definition = definitions[event.kind];
      if (definition) {
        const variants = definition.variants?.slice(0, 3);
        const variant = variants?.length
          ? variants[
              (Math.imul(event.sequence + 1, 1664525) >>> 0) % variants.length
            ]
          : undefined;
        const layers = variant ?? definition.layers;
        for (const layer of (layers?.length ? layers : [definition]).slice(
          0,
          6,
        )) {
          this.play(
            { ...definition, ...layer },
            event.payload,
            event.audioTime,
          );
        }
      }
    }
  }
  private play(d: SoundLayer, p: SoundEvent["payload"], audioTime?: number) {
    const priority = d.priority ?? 30;
    if (this.effects.size >= 32) {
      const victim = [...this.effects].sort(
        (a, b) => a.priority - b.priority,
      )[0];
      if (!victim || victim.priority > priority) return;
      victim.stop();
    }
    const now =
        Math.max(
          this.ctx.currentTime,
          Math.min(audioTime ?? this.ctx.currentTime, this.ctx.currentTime + 2),
        ) + clamp(d.onset ?? 0, 0, 1),
      duration = clamp(d.duration ?? 0.12, 0.015, 3),
      gain = this.ctx.createGain(),
      filter = this.ctx.createBiquadFilter(),
      pan = this.ctx.createStereoPanner();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(
      clamp(
        d.filterHz ?? (d.waveform === "noise" ? (d.frequency ?? 5000) : 12000),
        40,
        18000,
      ),
      now,
    );
    if (d.waveform === "noise" && d.endFrequency)
      filter.frequency.exponentialRampToValueAtTime(
        clamp(d.endFrequency, 40, 18000),
        now + duration,
      );
    if (d.endFilterHz)
      filter.frequency.exponentialRampToValueAtTime(
        clamp(d.endFilterHz, 40, 18000),
        now + duration,
      );
    pan.pan.value = clamp((p?.pan ?? 0) + (d.pan ?? 0), -1, 1);
    const source =
      d.waveform === "noise"
        ? this.ctx.createBufferSource()
        : this.ctx.createOscillator();
    if (source instanceof AudioBufferSourceNode) {
      source.buffer = this.noise;
      source.loop = true;
    } else {
      source.type = d.waveform === "noise" ? "sine" : (d.waveform ?? "sine");
      const pitch = clamp(p?.pitch ?? 1, 0.25, 4);
      source.frequency.setValueAtTime(
        clamp((d.frequency ?? 220) * pitch, 20, 16000),
        now,
      );
      source.frequency.exponentialRampToValueAtTime(
        clamp((d.endFrequency ?? d.frequency ?? 220) * pitch, 20, 16000),
        now + duration,
      );
    }
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(
      clamp((d.gain ?? 0.15) * (p?.gain ?? 1), 0.0001, 0.7),
      now + clamp(d.attack ?? 0.006, 0.001, duration * 0.5),
    );
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(pan);
    pan.connect(this.destination);
    let stopped = false;
    const handle = {
      priority,
      stop: () => {
        if (stopped) return;
        stopped = true;
        try {
          source.stop();
        } catch {}
        source.disconnect();
        filter.disconnect();
        gain.disconnect();
        pan.disconnect();
        this.effects.delete(handle);
      },
    };
    this.effects.add(handle);
    source.onended = () => handle.stop();
    source.start(now);
    source.stop(now + duration + 0.02);
    if (priority >= 80) this.duck(0.55);
  }
  update(sources: readonly ContinuousSound[]) {
    const wanted = new Set<string>();
    // Semantic families select their loudest nearby source; reuse keyed graphs.
    const families = new Map<string, ContinuousSound>();
    for (const source of sources) {
      const key = source.family ?? source.id;
      if (!families.has(key) || families.get(key)!.gain < source.gain)
        families.set(key, source);
    }
    for (const source of [...families.values()]
      .sort((a, b) => b.gain - a.gain)
      .slice(0, 8)) {
      const id = `s-${source.id
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .slice(0, 28)}`;
      wanted.add(id);
      const gain = clamp(source.gain, 0, 0.45),
        frequency = clamp(source.frequency, 20, 18000),
        pan = clamp(source.pan ?? 0, -1, 1);
      if (["noise", "wind", "water", "rain"].includes(source.kind)) {
        this.beds.add(id);
        this.environment.setBed(id, {
          seed: source.seed ?? 193,
          level: gain,
          filterHz: source.filterHz ?? frequency,
          pan,
          rampSeconds: 0.09,
        });
        continue;
      }
      let motor = this.motors.get(id);
      if (!motor) {
        const osc = this.ctx.createOscillator(),
          harmonic = this.ctx.createOscillator(),
          g = this.ctx.createGain(),
          p = this.ctx.createStereoPanner(),
          filter = this.ctx.createBiquadFilter();
        osc.type = source.kind === "motor" ? "sawtooth" : "sine";
        harmonic.type = "triangle";
        filter.type = "lowpass";
        osc.connect(filter);
        harmonic.connect(filter);
        filter.connect(g);
        g.connect(p);
        p.connect(this.destination);
        g.gain.value = 0;
        osc.start();
        harmonic.start();
        motor = { osc, harmonic, gain: g, pan: p, filter };
        this.motors.set(id, motor);
      }
      const t = this.ctx.currentTime;
      motor.osc.frequency.setTargetAtTime(frequency, t, 0.08);
      motor.harmonic.frequency.setTargetAtTime(frequency * 2.01, t, 0.1);
      motor.gain.gain.setTargetAtTime(gain * 0.18, t, 0.08);
      motor.pan.pan.setTargetAtTime(pan, t, 0.08);
      motor.filter.frequency.setTargetAtTime(clamp(source.filterHz ?? 12000, 40, 18000), t, 0.1);
    }
    for (const id of this.beds)
      if (!wanted.has(id)) {
        this.environment.stopBed(id);
        this.beds.delete(id);
      }
    for (const [id, m] of this.motors)
      if (!wanted.has(id)) {
        m.osc.stop();
        m.harmonic.stop();
        m.osc.disconnect();
        m.harmonic.disconnect();
        m.gain.disconnect();
        m.pan.disconnect();
        m.filter.disconnect();
        this.motors.delete(id);
      }
  }
  stop() {
    this.environment.stop();
    this.beds.clear();
    for (const h of [...this.effects]) h.stop();
    for (const m of this.motors.values()) {
      m.osc.stop();
      m.harmonic.stop();
      m.osc.disconnect();
      m.harmonic.disconnect();
      m.gain.disconnect();
      m.pan.disconnect();
      m.filter.disconnect();
    }
    this.motors.clear();
  }
  reset() {
    this.stop();
    this.sequence = -1;
  }
  dispose() {
    this.stop();
    this.environment.dispose();
    this.dummyMusic.disconnect();
  }
}
