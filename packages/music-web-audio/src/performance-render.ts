import {
  createProtectedMix,
  type MixProfile,
  PROTECTED_MIX_LATENCY_FRAMES,
} from "./mix-profile";
import {
  assertPerformanceTake,
  roleGainAt,
  type PerformanceTake,
} from "@onepage/music-core/performance";
import { ticksToSeconds } from "@onepage/music-core/runtime";
import { renderPerformanceVoice, type PerformanceVoiceRenderer } from "./index";

/** Uses the same synth as live playback, with explicitly captured role-bus expression. */
export async function renderPerformanceTake(
  take: PerformanceTake,
  options: {
    sampleRate?: number;
    /** Opt-in profile; old frozen exports retain historical samples by default. */
    mixProfile?: MixProfile;
    mode?: "clean" | "planned";
    voiceRenderer?: PerformanceVoiceRenderer | null;
  } = {},
): Promise<AudioBuffer> {
  assertPerformanceTake(take);
  if (take.deviations.length && options.mode !== "planned")
    throw Error(
      "Take contains execution deviations; choose explicitly labeled planned rendering",
    );
  const sampleRate = options.sampleRate ?? 48000;
  if (![22050, 44100, 48000, 96000].includes(sampleRate))
    throw Error("Invalid sample rate");
  const renderer = options.voiceRenderer;
  if (take.version === 2 && renderer) {
    const identity = renderer.paletteIdentity;
    const expected = take.acoustic.palette;
    if (
      !identity ||
      identity.id !== expected.id ||
      identity.hash !== expected.hash
    )
      throw Error(
        "Acoustic renderer palette identity does not match captured take; select its original palette or the explicitly labeled synth approximation",
      );
  }
  const release = (patch: PerformanceTake["patches"][number]) => {
    const value =
      renderer?.releaseSeconds(patch) ?? Math.max(0.005, patch.release);
    if (!Number.isFinite(value) || value < 0.005 || value > 10)
      throw Error("Invalid renderer release");
    return value;
  };
  const limit = renderer?.maxVoices ?? 256;
  if (!Number.isInteger(limit) || limit < 1 || limit > 256)
    throw Error("Invalid renderer voice budget");
  const patches = new Map(take.patches.map((p) => [p.id, p]));
  const tracks = new Map(take.tracks.map((t) => [t.id, t]));
  const duration = Math.max(
    ticksToSeconds(take.lengthTicks, take.bpm),
    ...take.notes.map(
      (n) =>
        ticksToSeconds(n.startTick + n.durationTicks, take.bpm) +
        release(patches.get(n.patchId)!),
    ),
  );
  const protectedMix = options.mixProfile === "weather-protected-1";
  if (
    options.mixProfile &&
    !["legacy-v1", "weather-protected-1"].includes(options.mixProfile)
  )
    throw Error("Unknown mix profile");
  const frames =
    Math.ceil(duration * sampleRate) +
    (protectedMix ? PROTECTED_MIX_LATENCY_FRAMES : 0);
  if (duration > 610 || frames > 32_000_000 || frames < 1)
    throw Error("Performance render exceeds frame budget");
  // Validate the entire timeline before allocating any audio graph. A late dense
  // passage must not leave thousands of already-created nodes behind on failure.
  const ordered = [...take.notes].sort(
    (a, b) => a.startTick - b.startTick || (a.id < b.id ? -1 : 1),
  );
  let ends: number[] = [];
  for (const n of ordered) {
    const at = ticksToSeconds(n.startTick, take.bpm);
    ends = ends.filter((end) => end > at);
    if (ends.length >= limit)
      throw Error("Performance render exceeds voice budget");
    ends.push(
      at +
        ticksToSeconds(n.durationTicks, take.bpm) +
        release(patches.get(n.patchId)!),
    );
  }
  const ctx = new OfflineAudioContext(2, frames, sampleRate);
  try {
    await renderer?.prepareContext?.(ctx);
    const protection = protectedMix ? await createProtectedMix(ctx) : null;
    protection?.connect(ctx.destination);
    const buses = new Map<string, GainNode>();
    for (const role of new Set(take.tracks.map((t) => t.role))) {
      const bus = ctx.createGain();
      bus.gain.setValueAtTime(1, 0);
      bus.connect(protection ?? ctx.destination);
      buses.set(role, bus);
      const events = take.automation.filter((e) => e.role === role);
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        const from = roleGainAt(events.slice(0, i), role, event.timeSeconds);
        const end = Math.min(
          event.timeSeconds + event.rampSeconds,
          events[i + 1]?.timeSeconds ?? Infinity,
        );
        if (event.rampSeconds === 0)
          bus.gain.setValueAtTime(event.value, event.timeSeconds);
        else {
          bus.gain.setValueAtTime(from, event.timeSeconds);
          const value =
            from +
            ((event.value - from) * (end - event.timeSeconds)) /
              event.rampSeconds;
          if (end > event.timeSeconds)
            bus.gain.linearRampToValueAtTime(value, end);
        }
      }
    }
    for (const n of ordered) {
      const at = ticksToSeconds(n.startTick, take.bpm);
      (renderer?.renderVoice.bind(renderer) ?? renderPerformanceVoice)(
        ctx,
        buses.get(tracks.get(n.trackId)!.role)!,
        patches.get(n.patchId)!,
        n.pitch,
        n.velocity,
        at,
        ticksToSeconds(n.durationTicks, take.bpm),
        n.gain,
        n.pan,
        n.id,
      );
    }
    const rendered = await ctx.startRendering();
    if (!protectedMix) return rendered;
    // Remove the same declared lookahead delay used by live output-clock mapping.
    const aligned = ctx.createBuffer(
      2,
      frames - PROTECTED_MIX_LATENCY_FRAMES,
      sampleRate,
    );
    for (let c = 0; c < 2; c++)
      aligned.copyToChannel(
        rendered.getChannelData(c).subarray(PROTECTED_MIX_LATENCY_FRAMES),
        c,
      );
    return aligned;
  } finally {
    renderer?.releaseContext?.(ctx);
  }
}
