import { describe, expect, it } from "vitest";
import { validateScore } from "@onepage/project";
import { BAR_TICKS, CRYPT_SCORE_REGISTRY, CRYPT_STING_KINDS, cryptballScore, cryptScore, cryptSting } from "../src/audio-score";

describe("native Crypt score registry", () => {
  it("validates eight authored scenes and five one-shot stings", () => {
    expect(CRYPT_SCORE_REGISTRY).toHaveLength(8);
    for (const [id, title, bpm] of CRYPT_SCORE_REGISTRY) {
      const score = cryptScore(id);
      expect(validateScore(score)).toEqual({ valid: true, errors: [] });
      expect(score.title).toBe(title);
      expect(score.bpm).toBe(bpm);
      expect(score.lengthTicks).toBe((id === "menu" || id === "results" ? 16 : 32) * BAR_TICKS);
    }
    for (const kind of CRYPT_STING_KINDS) {
      const score = cryptSting(kind);
      expect(validateScore(score)).toEqual({ valid: true, errors: [] });
      expect(score.playback).toBe("one-shot");
      expect(score.loop).toBeNull();
      const lastNote = Math.max(...score.patterns.flatMap(p => p.notes.map(n => n.startTick + n.durationTicks)));
      expect(lastNote).toBeLessThan(score.lengthTicks);
    }
  });

  it("gives each sport distinct note arrangements beyond tempo", () => {
    const sports = CRYPT_SCORE_REGISTRY.filter(([id]) => id !== "menu" && id !== "results");
    const signatures = sports.map(([id]) => JSON.stringify(cryptScore(id).patterns));
    expect(new Set(signatures).size).toBe(6);
    expect(cryptballScore()).toEqual(cryptScore("cryptball"));
    expect(cryptballScore(true)).toEqual(cryptScore("menu"));
    expect(cryptScore("menu").id).not.toBe(cryptScore("results").id);
  });

  it("keeps pressure on the same complete timeline as foundation and identity", () => {
    for (const [id] of CRYPT_SCORE_REGISTRY) {
      const score = cryptScore(id);
      for (const track of score.tracks) {
        const clip = score.clips.find(c => c.trackId === track.id)!;
        const pattern = score.patterns.find(p => p.id === clip.patternId)!;
        expect(clip.startTick).toBe(0);
        expect(clip.repeats).toBe(1);
        expect(pattern.lengthTicks).toBe(score.lengthTicks);
        if (track.minEnergy === 2 && id !== "menu" && id !== "results") {
          expect(pattern.notes.length).toBeGreaterThan(0);
          expect(Math.floor(pattern.notes[0]!.startTick / BAR_TICKS)).toBe(0);
          expect(Math.floor(pattern.notes.at(-1)!.startTick / BAR_TICKS)).toBe(31);
        }
      }
    }
  });

  it("bounds authored notes and peak polyphony including pressure", () => {
    for (const [id] of CRYPT_SCORE_REGISTRY) {
      const score = cryptScore(id);
      const edges: [number, number][] = [];
      for (const pattern of score.patterns) for (const note of pattern.notes) {
        expect(note.startTick).toBeGreaterThanOrEqual(0);
        expect(note.startTick + note.durationTicks).toBeLessThanOrEqual(score.lengthTicks);
        expect(note.pitch).toBeGreaterThanOrEqual(0);
        expect(note.pitch).toBeLessThanOrEqual(127);
        expect(note.velocity).toBeLessThanOrEqual(1);
        edges.push([note.startTick, 1], [note.startTick + note.durationTicks, -1]);
      }
      edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let active = 0, peak = 0;
      for (const [, delta] of edges) { active += delta; peak = Math.max(peak, active); }
      expect(peak).toBeLessThanOrEqual(14);
    }
  });

  it("returns independent score data so callers cannot corrupt later selections", () => {
    const first = cryptScore("cryptball");
    first.patterns[0]!.notes.length = 0;
    first.patches[0]!.brightness = 1;
    expect(cryptScore("cryptball").patterns[0]!.notes.length).toBeGreaterThan(0);
    expect(cryptScore("cryptball").patches[0]!.brightness).toBe(.3);
  });
});
