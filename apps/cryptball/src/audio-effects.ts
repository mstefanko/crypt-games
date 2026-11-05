import type { Patch, Score } from "@onepage/game-runtime/audio";
import type { CryptballEvent, SportId } from "./contract";
import type { TeamId } from "../sim/team-identities";
import { cryptPatch } from "./audio-score";

export const EFFECT_MIX_GAIN = 1.1;
const patches = {
  horn: cryptPatch("ram-horn", "pulse", .25, .17, .09, .009, .3),
  rush: cryptPatch("ram-rush", "noise", .22, .16, .06),
  swish: cryptPatch("fox-swish", "noise", .67, .065, .035),
  step: cryptPatch("fox-step", "triangle", .3, .027, .018),
  glass: cryptPatch("owl-glass", "sine", .7, .22, .14),
  clack: cryptPatch("gator-clack", "pulse", .38, .025, .018, .002, .16),
  scrape: cryptPatch("gator-scrape", "noise", .34, .13, .06),
  wing: cryptPatch("bat-wing", "noise", .17, .06, .04, .008),
  buzz: cryptPatch("hornet-buzz", "sawtooth", .44, .085, .04, .007),
  crack: cryptPatch("hornet-crack", "noise", .83, .025, .025),
  body: cryptPatch("body-thud", "triangle", .16, .065, .035),
  strike: cryptPatch("ball-strike", "noise", .58, .033, .025),
  board: cryptPatch("stone-board", "noise", .2, .052, .035),
  metal: cryptPatch("metal-post", "sine", .81, .26, .17),
  save: cryptPatch("keeper-save", "triangle", .48, .1, .065),
  pass: cryptPatch("pass-flick", "triangle", .55, .045, .028),
  whistle: cryptPatch("match-whistle", "pulse", .72, .14, .07, .01, .5),
  goal: cryptPatch("goal-bell", "triangle", .62, .27, .13),
  stick: cryptPatch("stick-tick", "pulse", .25, .022, .02),
  rubber: cryptPatch("puck-board", "triangle", .13, .037, .025),
};
export interface CueVoice { patch: Patch; pitch: number; duration: number; delay?: number; gain?: number; velocity?: number }
export interface AudioCue { voices: CueVoice[]; priority?: boolean; duck?: boolean }
const voice = (patch: Patch, pitch: number, duration: number, delay = 0, gain = .64): CueVoice => ({ patch, pitch, duration, delay, gain });

/** Stages deliberately have different timbres; only authoritative contact calls success. */
export function specialCue(kind: TeamId, stage: "tell" | "active" | "second" | "success" | "release"): AudioCue {
  let voices: CueVoice[];
  if (stage === "success") {
    voices = kind === "rams" ? [voice(patches.body, 31, .14), voice(patches.horn, 48, .12, .015, .35)]
      : kind === "foxes" ? [voice(patches.step, 82, .045), voice(patches.swish, 91, .06, .035, .35)]
      : kind === "owls" ? [voice(patches.glass, 84, .12), voice(patches.glass, 91, .16, .065, .4)]
      : kind === "gators" ? [voice(patches.clack, 46, .045), voice(patches.body, 39, .08, .025)]
      : kind === "bats" ? [voice(patches.wing, 67, .07), voice(patches.step, 79, .055, .055)]
      : [voice(patches.crack, 74, .055), voice(patches.buzz, 79, .08, .025, .35)];
  } else if (kind === "rams") voices = stage === "active" ? [voice(patches.rush, 38, .25, 0, .48)] : [voice(patches.horn, 36, .12), voice(patches.horn, 43, .13, .065, .34)];
  else if (kind === "foxes") voices = [voice(patches.swish, 81, .11), voice(patches.step, 72, .04, .07, .4)];
  else if (kind === "owls") voices = [voice(patches.glass, 79, .13, 0, .5), voice(patches.glass, 86, .17, .075, .46)];
  else if (kind === "gators") voices = stage === "active" ? [voice(patches.scrape, 58, .2, 0, .42)] : [voice(patches.clack, 58, .04), voice(patches.clack, 46, .06, .05, .5)];
  else if (kind === "bats") voices = [voice(patches.wing, stage === "second" ? 69 : 57, .07), voice(patches.wing, stage === "second" ? 74 : 62, .065, .085, .5)];
  else voices = stage === "release" ? [voice(patches.crack, 77, .055), voice(patches.buzz, 84, .065, .025, .3)] : [voice(patches.buzz, 55, .065, 0, .36), voice(patches.buzz, 62, .065, .06, .4), voice(patches.buzz, 67, .09, .12, .42)];
  return { voices, priority: true, duck: stage === "success" || kind === "rams" && stage === "tell" };
}

export function eventCue(event: CryptballEvent, sport: SportId): AudioCue | null {
  const type = event.type, hockey = sport === "cryptcheck";
  if (type === "match-end" && (sport === "crypt-dodge" || sport === "crypt-guardian")) return null;
  if (["special", "special-burst", "special-success", "special-release"].includes(type)) {
    if (!["rams", "foxes", "owls", "gators", "bats", "hornets"].includes(String(event.kind))) return null;
    return specialCue(event.kind as TeamId, type === "special" ? "tell" : type === "special-burst" ? "second" : type === "special-success" ? "success" : "release");
  }
  // Cryptcheck publishes the actual puck contact separately from action admission.
  if (hockey && ["strike", "pass", "trap", "slide"].includes(type)) return null;
  const seed = typeof event.counter === "number" ? event.counter : event.tick;
  const variation = Math.abs(seed * 17 + event.tick * 7) % 3 - 1;
  const gain = .54 + (Math.abs(seed * 13) % 5) * .025;
  const one = (patch: Patch, pitch: number, duration = .085, priority = false): AudioCue => ({ voices: [voice(patch, pitch + variation, duration, 0, gain)], priority });
  if (["dodge-catch", "guardian-catch"].includes(type)) return one(patches.save, 76, .12, true);
  if (["dodge-ding", "guardian-damage"].includes(type)) return {voices:[voice(patches.body,42,.1,0,.4),voice(patches.glass,85,.08,.02,.25)],priority:true};
  if (["dodge-out", "guardian-down", "guardian-out"].includes(type)) return {voices:[voice(patches.glass,72,.2,0,.3),voice(patches.glass,60,.28,.1,.25)],priority:true};
  if (type === "guardian-revive") return {voices:[voice(patches.save,67,.12,0,.4),voice(patches.glass,79,.18,.09,.35)],priority:true};
  if (["dodge-possession-warning", "dodge-possession-transfer"].includes(type)) return one(patches.whistle, 87, .12, true);
  if (type === "guardian-tell") {
    const weapon=String(event.weapon??event.kind);
    return {voices:weapon.includes("hook")||weapon.includes("sweep")?[voice(patches.metal,56,.12,0,.32),voice(patches.metal,63,.14,.14,.3)]:weapon.includes("slam")||weapon.includes("maul")||weapon.includes("proximity")?[voice(patches.body,30,.2,0,.4),voice(patches.horn,37,.18,.2,.3)]:[voice(patches.buzz,55,.08,0,.3),voice(patches.buzz,62,.08,.1,.32),voice(patches.buzz,67,.12,.2,.35)],priority:true};
  }
  if(type === "guardian-release") return one(patches.rush,42,.14,true);
  if(["guardian-cover-hit","guardian-cover-crack"].includes(type))return one(patches.crack,58,.09);
  if(type === "guardian-cover-break")return {voices:[voice(patches.board,35,.18,0,.4),voice(patches.crack,45,.14,.06,.3)],priority:true};
  if(type === "guardian-hit")return Number(event.damage)===0 ? one(patches.metal,67,.1,true) : {voices:[voice(patches.body,32,.14,0,.5),voice(patches.crack,49,.08,0,.25)],priority:true};
  if(["guardian-victory","dodge-round-end"].includes(type))return {voices:[voice(patches.goal,72,.25,0,.4),voice(patches.goal,79,.3,.1,.35),voice(patches.goal,84,.35,.2,.3)],priority:true,duck:true};
  if(type === "guardian-defeat")return {voices:[voice(patches.horn,43,.3,0,.35),voice(patches.horn,36,.4,.15,.3)],priority:true};
  if(type === "guardian-block")return one(patches.metal,65,.12,true);
  if(type === "guardian-stagger")return {voices:[voice(patches.body,28,.15),voice(patches.glass,71,.2,.05,.35)],priority:true};
  if(type === "guardian-deflect-tell")return one(patches.buzz,78,.13,true);
  if(type === "guardian-deflect")return one(patches.metal,82,.1,true);
  if(["dodge-throw", "guardian-throw"].includes(type))return one(patches.strike,50,.07);
  if(["dodge-pass", "guardian-pass"].includes(type))return one(patches.pass,69,.06);
  if (type === "goal" || type === "rally-point" || type === "match-end") return { voices: [voice(patches.goal, 72, .3, 0, .48), voice(patches.goal, 79, .3, .08, .4), voice(patches.goal, 84, .4, .16, .36)], priority: true, duck: true };
  if (["horn", "whistle", "overtime", "ready", "restart"].includes(type)) return one(patches.whistle, 91, .18, true);
  if (type === "save") return { voices: [voice(patches.body, 43, .085), voice(patches.save, 72, .12, .025, .5)], priority: true, duck: true };
  if (type === "perfect-block") return { voices: [voice(patches.body, 48, .07), voice(patches.glass, 91, .15, .02, .42)], priority: true };
  if (["check", "check-resist", "block", "slide-contact"].includes(type)) return one(patches.body, type === "check" ? 34 : 46, .1);
  if (type === "post") return one(patches.metal, 86, .2);
  if (type === "board") return one(hockey ? patches.rubber : patches.board, hockey ? 38 : 49, .07);
  if (["ice-stop", "skate-push", "dash", "slide", "keeper-dive"].includes(type)) return one(patches.scrape, type === "keeper-dive" ? 53 : 63, .13);
  if (type === "puck-contact") return one(patches.stick, 62, .045);
  if (type === "pass") return one(patches.pass, 69, .06);
  if (type === "trap") return one(patches.body, 46, .055);
  if (type === "volley-contact") return one(event.kind === "set" ? patches.glass : event.kind === "dig" ? patches.save : patches.strike, event.kind === "set" ? 77 : event.kind === "dig" ? 62 : 48, .09);
  if (type === "strike" || type === "power-bank") return one(patches.strike, typeof event.charge === "number" && event.charge >= 24 ? 39 : 48, .065);
  return null;
}

/** A listening reel made out of the runtime cue descriptors, not substitute audio. */
export function effectsAuditionScore(): Score {
  const scheduled: { at: number; voice: CueVoice }[] = [];
  const teams: TeamId[] = ["rams", "foxes", "owls", "gators", "bats", "hornets"];
  const cueAt = (at: number, cue: AudioCue) => cue.voices.forEach(voice => scheduled.push({ at: at + (voice.delay ?? 0), voice }));
  teams.forEach((team,i) => {
    cueAt(i * 2, specialCue(team, "tell"));
    if (team === "rams" || team === "gators") cueAt(i * 2 + .22, specialCue(team, "active"));
    if (team === "bats") cueAt(i * 2 + .6, specialCue(team, "second"));
    if (team === "hornets") cueAt(i * 2 + .55, specialCue(team, "release"));
    cueAt(i * 2 + 1, specialCue(team, "success"));
  });
  ["check", "strike", "board", "post", "save", "pass", "goal"].forEach((type,i) => cueAt(12 + i * .8, eventCue({ type, tick: i, counter: i }, "cryptball")!));
  const lengthTicks = 18 * 960;
  return { schemaVersion: 1, id: "cryptball-effects-audition", title: "Six specials, then body / strike / stone / post / save / pass / goal", ppq: 480, bpm: 120, meter: [4,4], scale: { root: 0, mode: "chromatic" }, playback: "one-shot", lengthTicks, loop: null,
    tracks: Object.values(patches).map(patch => ({ id: patch.id, name: patch.name, role: "melody", patchId: patch.id, gain: .8, pan: 0, minEnergy: 1 })),
    // Reuse one pattern per voice because the renderer owns the exact note envelope.
    patterns: scheduled.map(({ at, voice },i) => ({ id: `p${i}`, name: voice.patch.name, lengthTicks, notes: [{ id: `n${i}`, startTick: Math.round(at * 960), durationTicks: Math.max(1, Math.round(voice.duration * 960)), pitch: voice.pitch, velocity: (voice.velocity ?? .6) * (voice.gain ?? .64) * EFFECT_MIX_GAIN }] })),
    clips: scheduled.map(({ voice },i) => ({ id: `c${i}`, trackId: voice.patch.id, patternId: `p${i}`, startTick: 0, repeats: 1, transpose: 0 })), sections: [], patches: Object.values(patches),
  };
}
