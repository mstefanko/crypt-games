import arrangements from "./exploration-music.json";
import { AudioEngine } from "@onepage/music-web-audio";
import { explorationStrikeSample } from "./exploration-sample.ts";
import { M2Audio, type M2AudioEngine, type Score } from "../m2-audio.ts";
/** The existing device owner applies live gain to music and transient effects.
 * Queue-capable devices use the frozen adaptive bank; score is the ordinary
 * playback fallback for injected legacy devices without queued replacement. */
export function explorationAudio(
  score: Score,
  onError: (message: string) => void,
  device: M2AudioEngine & Pick<AudioEngine, "setVolume"> = new AudioEngine(),
) {
  device.setVolume(0.5);
  const audio = new M2Audio({
    score,
    music: device.queueScore
      ? (arrangements as unknown as import("./adaptive-music.ts").MusicArrangements)
      : undefined,
    engine: device,
    onError,
    samples: [{ id: "beacon-strike", bytes: explorationStrikeSample() }],
  });
  return { audio, setVolume: (value: number) => device.setVolume(value) };
}

/** Observation-only policy: living hostile actors request high intensity.
 * No event backlog, simulation mutations, time conversion or audio clock reads. */
export function explorationMusicState(observation: {
  platform: {
    status: string;
    actors: readonly { health: number; team: number }[];
  };
}): "low" | "high" {
  return observation.platform.status === "playing" &&
    observation.platform.actors.some(
      (actor) => actor.team === 1 && actor.health > 0,
    )
    ? "high"
    : "low";
}
