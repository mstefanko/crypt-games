#!/usr/bin/env node
/** Render the exact runtime score/cue descriptors through the runtime synth and
 * Chromium OfflineAudioContext. Run: node scripts/render-cryptball-audio.mjs */
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const output = resolve('docs/evidence/cryptball-audio-2026-11-05');
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: 'vite.cryptball.config.ts', server: { port: 4258, strictPort: true, hmr: false, watch: { ignored: ["**/*"] } } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4258/games/cryptball/');
  const report = { renderer: 'Runtime renderScore / renderPerformanceVoice, Chromium OfflineAudioContext', sampleRate: 22050, musicVolume: .7, effectsVolume: .8, originalComposition: 'Bone court boogie / Knock at the crypt', samples: [] };
  for (const kind of ['match', 'title', 'overtime', 'effects']) {
    const rendered = await page.evaluate(async ({ kind, rendererUrl }) => {
      const { cryptballScore } = await import('/games/cryptball/src/audio-score.ts');
      const { effectsAuditionScore } = await import('/games/cryptball/src/audio-effects.ts');
      const { renderScore, encodeWav } = await import(rendererUrl);
      const score = kind === 'effects' ? effectsAuditionScore() : cryptballScore(kind === 'title');
      if (kind !== 'effects') score.tracks = score.tracks.map(track => ({ ...track, gain: track.gain * .7 }));
      const buffer = await renderScore(score, { sampleRate: 22050, tailSeconds: .4, energy: kind === 'overtime' ? 2 : 1 });
      let peak = 0, sum = 0, clipped = 0;
      const secondEnergy = Array.from({ length: Math.ceil(buffer.duration) }, () => ({ sum: 0, count: 0 }));
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const values = buffer.getChannelData(channel);
        for (let frame = 0; frame < values.length; frame++) {
          const value = values[frame]; peak = Math.max(peak, Math.abs(value)); sum += value * value;
          if (Math.abs(value) >= 1) clipped++;
          const second = secondEnergy[Math.floor(frame / buffer.sampleRate)]; second.sum += value * value; second.count++;
        }
      }
      const bytes = encodeWav(buffer);
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      return { wav: btoa(binary), durationSeconds: buffer.duration, peak, rms: Math.sqrt(sum / buffer.length / buffer.numberOfChannels), clippedSamples: clipped,
        rmsPerSecond: secondEnergy.map(s => Math.sqrt(s.sum / s.count)), scoreId: score.id, bars: score.lengthTicks / 1920 };
    }, { kind, rendererUrl: '/games/cryptball/@fs' + resolve('packages/music-web-audio/src/index.ts') });
    const { wav, ...measurements } = rendered;
    const bytes = Buffer.from(wav, 'base64'), file = `cryptball-${kind}.wav`;
    if (measurements.clippedSamples > 0) throw Error(`${kind}: clipped audio`);
    if (kind !== 'effects' && measurements.rmsPerSecond.slice(0, -1).some(rms => rms < .00001)) throw Error(`${kind}: unexpected silent second`);
    await writeFile(resolve(output, file), bytes);
    report.samples.push({ file, ...measurements, sha256: createHash('sha256').update(bytes).digest('hex') });
    process.stdout.write(`${file}: ${measurements.durationSeconds.toFixed(2)}s; peak=${measurements.peak.toFixed(4)}; rms=${measurements.rms.toFixed(4)}; clipped=${measurements.clippedSamples}\n`);
  }
  report.headroom = await page.evaluate(async rendererUrl => {
    const { renderScore } = await import(rendererUrl);
    const { specialCue, eventCue, EFFECT_MIX_GAIN } = await import('/games/cryptball/src/audio-effects.ts');
    const candidates = [];
    for (const kind of ['rams', 'foxes', 'owls', 'gators', 'bats', 'hornets']) for (const stage of ['tell', 'active', 'second', 'success', 'release']) candidates.push(...specialCue(kind, stage).voices);
    for (const sport of ['cryptball', 'cryptcheck']) for (const type of ['strike', 'power-bank', 'slide', 'keeper-dive', 'check', 'block', 'perfect-block', 'save', 'board', 'post', 'pass', 'trap', 'goal', 'whistle', 'puck-contact', 'ice-stop']) {
      for (const tick of [0, 1, 2]) for (const charge of [0, 24]) {
        const cue = eventCue({ type, tick, counter: 3, charge }, sport);
        if (cue) candidates.push(...cue.voices);
      }
    }
    const unique = new Map(candidates.map(voice => [JSON.stringify([voice.patch.id, voice.pitch, voice.duration, voice.gain]), voice]));
    let loudest = { peak: 0, patch: '', pitch: 0 };
    for (const voice of unique.values()) {
      const lengthTicks = Math.ceil((voice.duration + voice.patch.release + .1) * 960);
      const score = { schemaVersion: 1, id: 'cryptball-headroom', title: 'Eight voice bound', ppq: 480, bpm: 120, meter: [4,4], scale: { root: 0, mode: 'chromatic' }, playback: 'one-shot', lengthTicks, loop: null,
        tracks: [{ id: 'v', name: 'Effect at maximum slider', role: 'melody', patchId: voice.patch.id, gain: voice.gain * EFFECT_MIX_GAIN, pan: .6, minEnergy: 1 }],
        patterns: [{ id: 'p', name: 'Individual exact runtime voice', lengthTicks, notes: [{ id: 'n', startTick: 0, durationTicks: Math.round(voice.duration * 960), pitch: voice.pitch, velocity: voice.velocity ?? .6 }] }],
        clips: [{ id: 'c', trackId: 'v', patternId: 'p', startTick: 0, repeats: 1, transpose: 0 }], sections: [], patches: [voice.patch] };
      const buffer = await renderScore(score, { sampleRate: 48000, tailSeconds: .05 });
      let peak = 0;
      for (let channel = 0; channel < 2; channel++) for (const value of buffer.getChannelData(channel)) peak = Math.max(peak, Math.abs(value));
      if (peak > loudest.peak) loudest = { peak, patch: voice.patch.id, pitch: voice.pitch };
    }
    return { isolatedVoicesTested: unique.size, sampleRate: 48000, effectsSlider: 1, effectVoiceCap: 8, loudest };
  }, '/games/cryptball/@fs' + resolve('packages/music-web-audio/src/index.ts'));
  report.headroom.musicAtMaximumSlider = Math.max(...report.samples.filter(sample => sample.file !== 'cryptball-effects.wav').map(sample => sample.peak)) / .7;
  report.headroom.conservativeSumOfIndependentPeaks = report.headroom.musicAtMaximumSlider + 8 * report.headroom.loudest.peak;
  report.headroom.noClippingBound = report.headroom.conservativeSumOfIndependentPeaks < 1;
  if (!report.headroom.noClippingBound) throw Error('Eight effect voices plus music exceed conservative maximum-slider headroom bound: ' + JSON.stringify(report.headroom));
  process.stdout.write(`Eight-FX plus music maximum-slider peak bound: ${report.headroom.conservativeSumOfIndependentPeaks.toFixed(4)}\n`);
  report.liveSmoke = await page.evaluate(async rendererUrl => {
    const { AudioEngine } = await import(rendererUrl);
    const { CourtMixer, CryptballAudio } = await import('/games/cryptball/src/audio.ts');
    const { createInitialState } = await import('/games/cryptball/sim/session.ts');
    const synth = new AudioEngine(), mixer = new CourtMixer(synth), errors = [];
    const audio = new CryptballAudio(message => errors.push(message), mixer);
    const assert = (condition, message) => { if (!condition) throw Error(message); };
    const state = createInitialState();
    try {
      assert(await audio.engine.unlock(), 'Live device failed to unlock'); await audio.engine.resume();
      const starts = audio.engine.stats().transportStarts;
      audio.volumes(0, .8);
      audio.tick(state, [{ type: 'special', kind: 'hornets', tick: 0, epoch: 0, counter: 0 }]);
      assert(audio.engine.stats().acceptedSounds === 3, 'Music zero silenced effects');
      assert(mixer.activeVoiceCount - synth.activeVoiceCount === 3, 'Expected three independent special voices');
      audio.volumes(.7, 0);
      assert(mixer.activeVoiceCount === synth.activeVoiceCount, 'Effects zero retained a source');
      state.tick++;
      audio.tick(state, [{ type: 'special', kind: 'rams', tick: state.tick, epoch: 0, counter: 1 }]);
      assert(audio.engine.stats().acceptedSounds === 3, 'Effects zero admitted cue');
      assert(audio.engine.stats().transportStarts === starts, 'Volume restarted the music');
      audio.volumes(.7, .8); state.tick++;
      audio.tick(state, [{ type: 'special', kind: 'hornets', tick: state.tick, epoch: 0, counter: 2 }]);
      audio.engine.setMuted(true); assert(mixer.activeVoiceCount === 0, 'Mute retained a delayed voice');
      audio.engine.setMuted(false); await audio.engine.resume(); state.tick++;
      audio.tick(state, [{ type: 'special', kind: 'hornets', tick: state.tick, epoch: 0, counter: 3 }]);
      audio.engine.pause(); assert(mixer.activeVoiceCount === 0, 'Pause retained a delayed voice');
      await audio.engine.resume(); state.tick++;
      audio.tick(state, [{ type: 'special', kind: 'hornets', tick: state.tick, epoch: 0, counter: 4 }]);
      const context = synth.readMixTaps().preProtection.context;
      await context.suspend();
      await new Promise(resolve => setTimeout(resolve, 30));
      assert(mixer.activeVoiceCount === 0, 'Interrupted context retained an auxiliary source');
      await context.resume(); await audio.engine.resume(); state.tick++;
      audio.tick(state, [{ type: 'special', kind: 'hornets', tick: state.tick, epoch: 0, counter: 5 }]);
      audio.resetMatch();
      assert(mixer.activeVoiceCount - synth.activeVoiceCount === 0, 'Reset retained an auxiliary source');
      await audio.engine.dispose(); assert(mixer.activeVoiceCount === 0, 'Dispose retained a source');
      assert(errors.length === 0, errors.join('; '));
      return { passed: true, checks: ['real device unlock', 'music zero / effects audible', 'effects zero / music continues', 'no volume transport reset', 'mute / pause / reset / dispose cancel delayed voices', 'context suspension clears auxiliary voices'] };
    } finally { await audio.engine.dispose(); }
  }, '/games/cryptball/@fs' + resolve('packages/music-web-audio/src/index.ts'));
  process.stdout.write('Real shared-context mixer lifecycle smoke: passed\n');
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(resolve(output, 'README.md'), '# Original Cryptball audio listening samples\n\nGenerated with `node scripts/render-cryptball-audio.mjs` using the actual runtime score, patches, and renderer. No external samples or audio service. Stereo PCM16 at 22050 Hz; default game gain, no mastering or normalization.\n\nMatch: 32 bars / 144 BPM, eight-bar hook, answer, breakdown, return. Title: a complete four-bar loop. Overtime: same timeline with extra percussion/counterline, eligible immediately in game (up to 150ms scheduler lookahead).\n\nEffects reel: 0s Charge; 2s Sidestep; 4s Focus; 6s Snap; 8s Flutter including separately triggered second burst; 10s Sting. Each includes an example of authoritative success at +1s. Then 12s body thud; 12.8s strike; 13.6s stone board; 14.4s metal post; 15.2s save; 16s pass; 16.8s goal. This reel deliberately triggers success for audition; game success only follows a legal contact event.\n\nThe manifest includes render hashes, peak/RMS, clipping count, and per-second RMS. Physical speaker/headphone and phone approval remains user playtesting.\n');
} finally {
  await browser?.close(); await server.close();
}
