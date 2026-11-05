import {
  GameplaySoundOwner,
  type SoundEvent,
  type SoundGesture,
  type ContinuousSound,
} from "./gameplay-sound";
import {
  GameplayMusicDirector,
  type GameplayMusicProfile,
  type GameplayMusicIntent,
} from "@onepage/music-core/gameplay-director";
import type {
  PerformanceTakeV3,
  CompiledExpressiveNote,
} from "@onepage/music-core/expressive-performance";
import {
  expressiveSynthRenderer,
  type ExpressiveVoiceHandle,
} from "./expressive-synth";
/** One audio-clock transport; voices use the existing expressive synth renderer. */
export class GameplayAudioMixer {
  private sounds: GameplaySoundOwner;
  private queue: {
    part: string;
    pitch: number;
    start: number;
    duration: number;
    velocity: number;
  }[] = [];
  private enqueue(
    part: string,
    pitch: number,
    start: number,
    duration: number,
    velocity = 0.65,
  ) {
    this.queue.push({ part, pitch, start, duration, velocity });
  }
  events(
    events: readonly SoundEvent[],
    definitions: Readonly<Record<string, SoundGesture>>,
  ) {
    if (this.timer) this.sounds.events(events, definitions);
  }
  emitters(sources: readonly ContinuousSound[]) {
    if (this.timer && !this.ended) this.sounds.update(sources);
  }
  private music: GainNode;
  private effects: GainNode;
  private master: GainNode;
  private clueGain: GainNode;
  private clueFilter: BiquadFilterNode;
  private cluePan: StereoPannerNode;
  private clueVoices: ExpressiveVoiceHandle[] = [];
  private musicLevel = 0.7;
  private endingTimer: ReturnType<typeof setTimeout> | undefined;
  private voices: ExpressiveVoiceHandle[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private director = new GameplayMusicDirector();
  private next = 0;
  private bar = 0;
  private serial = 0;
  private intent: GameplayMusicIntent = {
    identity: "ready",
    intensity: 0.3,
    progress: 0,
  };
  private musicalBoundary = Infinity;
  private adaptive = true;
  private ended = false;
  private lastEvent = "";
  public cue = "Ready";
  private readonly take: PerformanceTakeV3;
  constructor(
    private context: AudioContext,
    private profile: GameplayMusicProfile,
  ) {
    this.master = context.createGain();
    this.music = context.createGain();
    this.effects = context.createGain();
    this.clueGain = context.createGain();
    this.clueFilter = context.createBiquadFilter();
    this.clueFilter.type = "lowpass";
    this.cluePan = context.createStereoPanner();
    this.clueGain.connect(this.clueFilter);
    this.clueFilter.connect(this.cluePan);
    this.cluePan.connect(this.effects);
    this.music.connect(this.master);
    this.effects.connect(this.master);
    this.master.connect(context.destination);
    this.sounds = new GameplaySoundOwner(context, this.effects, (strength) => {
      const t = context.currentTime;
      this.music.gain.cancelScheduledValues(t);
      this.music.gain.setTargetAtTime(this.musicLevel * strength, t, 0.02);
      this.music.gain.setTargetAtTime(this.musicLevel, t + 0.18, 0.12);
    });
    const roles = ["melody", "bass", "harmony", "drums"] as const;
    this.take = {
      version: 3,
      id: "gameplay-mixer-v1",
      ppq: 480,
      lengthTicks: 460800,
      durationSeconds: 600,
      tempoMap: [{ tick: 0, microsecondsPerBeat: 625000 }],
      meterMap: [{ tick: 0, numerator: 4, denominator: 4 }],
      parts: roles.map((role, i) => ({
        id: role,
        name: role,
        role,
        gain: i === 2 ? 0.1 : 0.23,
        pan: i === 2 ? -0.25 : i === 0 ? 0.15 : 0,
      })),
      bindings: roles.map((id) => ({ id, kind: "synth", resourceId: id })),
      resources: roles.map((id, i) => ({
        id,
        kind: "synth",
        patch: {
          id,
          name: id,
          waveform: (["triangle", "sine", "pulse", "noise"] as const)[i]!,
          attack: i === 2 ? 0.06 : 0.008,
          release: i === 2 ? 0.25 : 0.08,
          brightness: i === 3 ? 0.14 : 0.32,
          duty: 0.35,
        },
      })),
      notes: [],
      controls: [],
      instruments: [],
      provenance: {
        gainCurve: "cc-square-v1",
        diagnostics: [],
        source: "Caller-authored gameplay music profile",
      },
      renderingProfile: "expressive-synth-v1",
      deviations: [],
    };
    this.settings({
      master: 0.7,
      music: 0.7,
      effects: 0.65,
      muted: false,
      adaptive: true,
    });
  }
  settings(s: {
    master: number;
    music: number;
    effects: number;
    muted: boolean;
    adaptive: boolean;
  }) {
    const clamp = (v: number) =>
      Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
    const t = this.context.currentTime;
    this.master.gain.setTargetAtTime(s.muted ? 0 : clamp(s.master), t, 0.02);
    this.musicLevel = clamp(s.music);
    this.music.gain.setTargetAtTime(this.musicLevel, t, 0.03);
    this.effects.gain.setTargetAtTime(clamp(s.effects), t, 0.02);
    this.adaptive = s.adaptive;
  }
  start() {
    if (this.timer) return;
    this.queue = [];
    this.next = this.context.currentTime + 0.06;
    this.timer = setInterval(() => this.pump(), 25);
    this.pump();
  }
  pause() {
    this.sounds.stop();
    this.queue = [];
    if (this.endingTimer) clearTimeout(this.endingTimer);
    this.endingTimer = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const voice of this.voices) voice.stop();
    this.voices = [];
  }
  reset() {
    this.pause();
    this.sounds.reset();
    this.director = new GameplayMusicDirector();
    this.bar = 0;
    this.ended = false;
    this.lastEvent = "";
    this.intent = { identity: "ready", intensity: 0.3, progress: 0 };
    this.clueVoices = [];
    this.cue = "Ready";
    this.music.gain.cancelScheduledValues(this.context.currentTime);
    this.music.gain.setTargetAtTime(
      this.musicLevel,
      this.context.currentTime,
      0.02,
    );
  }
  dispose() {
    this.pause();
    this.sounds.dispose();
    this.clueGain.disconnect();
    this.clueFilter.disconnect();
    this.cluePan.disconnect();
    this.master.disconnect();
    this.music.disconnect();
    this.effects.disconnect();
  }
  update(profile: GameplayMusicProfile, intent: GameplayMusicIntent) {
    let restart = false;
    if (profile.id !== this.profile.id) {
      restart = !!this.timer;
      this.pause();
      this.sounds.reset();
      this.profile = profile;
      this.bar = 0;
      this.director = new GameplayMusicDirector();
      this.ended = false;
      this.lastEvent = "";
    }
    this.intent = intent;
    if (restart) this.start();
    if (!intent.event) this.lastEvent = "";
    if (intent.event && intent.event !== this.lastEvent && this.timer) {
      this.lastEvent = intent.event;
      this.effect(intent.event, intent.clue ?? 0);
      if (intent.event === "win" || intent.event === "lose") {
        this.ended = true;
        this.endingTimer = setTimeout(() => this.pause(), 2200);
      }
    }
  }
  private note(
    part: string,
    pitch: number,
    start: number,
    duration: number,
    velocity = 0.65,
    effect = false,
    destination?: AudioNode,
  ) {
    let take: PerformanceTakeV3 = {
      ...this.take,
      resources: this.take.resources.map((r) => {
        const patch =
          this.profile.patches?.[
            r.id as "melody" | "bass" | "harmony" | "drums"
          ];
        return patch && r.patch ? { ...r, patch: { ...r.patch, ...patch } } : r;
      }),
    };
    if (!effect && Number.isFinite(this.musicalBoundary)) {
      const remaining = this.musicalBoundary - start;
      duration = Math.min(duration, Math.max(0.01, remaining - 0.02));
      take = {
        ...take,
        resources: take.resources.map((r) =>
          r.id === part && r.patch
            ? {
                ...r,
                patch: {
                  ...r.patch,
                  release: Math.max(
                    0.005,
                    Math.min(r.patch.release, remaining - duration - 0.005),
                  ),
                },
              }
            : r,
        ),
      };
    }
    const n: CompiledExpressiveNote = {
      id: `arcade-${this.serial++}`,
      partId: part,
      bindingId: part,
      startTick: 0,
      keyReleaseTick: 480,
      endTick: 600,
      startSeconds: 0,
      keyReleaseSeconds: duration,
      endSeconds: duration,
      pitch: Math.max(0, Math.min(127, pitch)),
      velocity,
      priority: 80,
      optional: false,
    };
    this.voices = this.voices.filter(
      (v) => v.endContextTime > this.context.currentTime,
    );
    if (this.voices.length < 64) {
      const voice = expressiveSynthRenderer.renderVoice(
        this.context,
        destination ?? (effect ? this.effects : this.music),
        take,
        n,
        start,
      );
      this.voices.push(voice);
      if (destination) this.clueVoices.push(voice);
    }
  }
  private effect(kind: string, clue: number) {
    const t = this.context.currentTime + 0.01,
      root = this.profile.theme.root;
    if (kind === "clue") {
      for (const v of this.clueVoices) v.stop();
      this.clueVoices = [];
      const patterns = this.profile.foregroundPatterns ?? [];
      if (!patterns.length) return;
      const variant =
          ((clue % patterns.length) + patterns.length) % patterns.length,
        occ = Math.max(0, Math.min(1, this.intent.occlusion ?? 0));
      this.cluePan.pan.setTargetAtTime(
        Math.max(-1, Math.min(1, this.intent.pan ?? 0)),
        t,
        0.12,
      );
      this.clueFilter.frequency.setTargetAtTime(
        18000 * (1 - occ) + 900 * occ,
        t,
        0.12,
      );
      this.clueGain.gain.setTargetAtTime(1 - occ * 0.65, t, 0.12);
      this.music.gain.cancelScheduledValues(t);
      this.music.gain.setTargetAtTime(this.musicLevel * 0.25, t, 0.03);

      const p = patterns[variant]!;
      p.notes.forEach((n, i) =>
        this.note(
          p.part,
          root + 12 + n,
          t + p.times[i]!,
          p.lengths[i]!,
          0.85,
          true,
          this.clueGain,
        ),
      );
      this.music.gain.setTargetAtTime(this.musicLevel, t + 1.05, 0.16);
      return;
    }
    if (kind === "win" || kind === "lose") {
      this.queue = [];
      this.sounds.stop();
      for (const v of this.voices) v.stop();
      this.voices = [];
      const notes = kind === "win" ? [0, 4, 7, 12] : [7, 3, 0];
      notes.forEach((p, i) =>
        this.note("melody", root + p, t + i * 0.16, 0.5, 0.8, true),
      );
      this.note("bass", root - 12, t + 0.45, 0.9, 0.7, true);
      return;
    }
    this.note(
      kind === "damage" || kind === "hit" ? "drums" : "melody",
      kind === "jump" ? root + 19 : root + 12,
      t,
      kind === "delivery" ? 0.2 : 0.065,
      0.5,
      true,
    );
  }
  private pump() {
    if (this.ended) return;
    const now = this.context.currentTime;
    if (this.next < now - 0.2) {
      this.next = now + 0.03;
      this.queue = [];
    }
    while (this.next < now + 0.14) {
      const d = this.director.decide(
          this.profile,
          this.intent,
          this.bar,
          this.adaptive,
        ),
        theme = d.theme,
        beat = 60 / theme.bpm,
        beats = theme.beatsPerBar ?? 4;
      this.cue = d.cue;
      this.musicalBoundary = this.next + beat * beats;
      const categories = this.adaptive ? this.intent.roleIds : undefined;
      const has = (role: string, fallback: boolean) =>
        categories ? categories.includes(role) : fallback;
      const cycle = this.profile.chordCycle ?? [0, 3, 4, 0];
      const phraseBars = this.profile.phraseBars ?? 8,
        phraseBar = this.bar % phraseBars;
      const chord = cycle[Math.floor(this.bar / 2) % cycle.length]!;
      const variation =
        ((Math.imul(
          Math.floor(this.bar / phraseBars) +
            (this.profile.compositionSeed ?? 17),
          1664525,
        ) >>>
          0) %
          3) -
        1;
      const pitch = (degree: number) =>
        theme.root +
        theme.scale[
          ((degree % theme.scale.length) + theme.scale.length) %
            theme.scale.length
        ]! +
        12 * Math.floor(degree / theme.scale.length);
      // Four-bar question/answer melody with authored rests and register development.
      for (let i = 0; i < 8; i++) {
        const degree =
          phraseBar === phraseBars - 1 && i >= 6
            ? 0
            : theme.motif[(this.bar * 8 + i) % theme.motif.length]! +
              (phraseBar % 4 === 2 && i === 4 ? variation : 0);
        if (!has("lead", true)) continue;
        if (i === 7 && this.bar % 2 === 0) continue;
        if (this.adaptive && this.intent.suppressLead) continue;
        if (this.adaptive && i % (this.intent.sparseLead ?? 1) !== 0) continue;
        this.enqueue(
          "melody",
          pitch(degree) + 12,
          this.next + (theme.rhythm?.[i] ?? (i * beats) / 8) * beat,
          beat * (i % 3 === 0 ? 0.65 : 0.34),
          0.6 + (i % 4 === 0 ? 0.12 : 0),
        );
      }
      if (this.adaptive && this.intent.baseDrone)
        this.enqueue(
          "bass",
          theme.root - 12,
          this.next,
          beat * (beats - 0.5),
          0.2,
        );
      if (has("pluck", false))
        for (let i = 0; i < 8; i++)
          this.enqueue(
            "melody",
            pitch(chord + [0, 2, 4, 2][i % 4]!) + 12,
            this.next + (i * beats * beat) / 8,
            beat * 0.22,
            0.48,
          );
      if (has("bass", d.roles >= 2))
        for (let i = 0; i < beats; i++)
          this.enqueue(
            "bass",
            pitch(chord + (i % 2 ? 4 : 0)) - 12,
            this.next + i * beat,
            beat * 0.65,
            0.65,
          );
      if (has("harmony", d.roles >= 3))
        for (const n of [chord, chord + 2, chord + 4])
          this.enqueue(
            "harmony",
            pitch(n),
            this.next,
            beat * (beats - 0.5),
            0.45,
          );
      if (has("percussion", d.tier >= 2))
        for (let i = 0; i < 8; i++)
          this.enqueue(
            "drums",
            i % 2 ? 46 : 36,
            this.next + (i * beats * beat) / 8,
            0.035,
            i % 2 ? 0.25 : 0.4,
          );
      if (!categories && d.tier >= 3)
        for (let i = 0; i < beats; i++)
          this.enqueue(
            "harmony",
            pitch(chord + i * 2) + 12,
            this.next + i * beat + beat / 4,
            beat * 0.25,
            0.4,
          );
      this.next += beat * beats;
      this.bar++;
    }
    this.queue.sort((a, b) => a.start - b.start);
    while (this.queue.length && this.queue[0]!.start < now + 0.14) {
      const n = this.queue.shift()!;
      if (n.start < now - 0.1) continue;
      this.note(
        n.part,
        n.pitch,
        Math.max(now + 0.005, n.start),
        n.duration,
        n.velocity,
      );
    }
  }
}
