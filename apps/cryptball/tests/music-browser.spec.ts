import { expect, test, type Page } from '@playwright/test';
async function harness(page: Page) {
  await page.goto('/games/cryptball/tests/music-harness.html');
  await page.evaluate(async () => {
    const { CourtMixer, CryptballAudio } = await import('../src/audio.ts');
    const { createCryptballSession } = await import('../sim/session.ts');
    const mixer = new CourtMixer(), synth = (mixer as any).synth, errors: string[] = [];
    const audio = new CryptballAudio((message: string) => errors.push(message), mixer);
    Object.assign(window, { musicTest: { synth, mixer, audio, errors, createCryptballSession } });
    document.querySelector('#unlock')!.addEventListener('click', () => { void audio.engine.unlock().then(() => audio.engine.resume()); });
  });
  await page.click('#unlock');
  await expect.poll(() => page.evaluate(() => (window as any).musicTest.synth.isPlaying)).toBe(true);
}
test('real audio track buses ramp pressure, retain transport, and preserve independent volumes', async ({ page }) => {
  await harness(page);
  const report = await page.evaluate(async () => {
    const t = (window as any).musicTest;
    const state = t.createCryptballSession({ sportId: 'cryptcheck' }).observe();
    state.phase = 'play'; state.remainingTicks = 60 * 60;
    t.audio.observeMusic(state, { matchId: 'browser', epoch: 1, generation: 0, snapshotSeq: 1 }, 0);
    await new Promise(r => setTimeout(r, 200));
    const origin = t.synth.transportOrigin;
    const tracks = t.synth.trackBuses as Map<string, GainNode>;
    const pressure = tracks.get('pressure-pulse')!;
    const initial = pressure.gain.value;
    const automation: { at: number; ramp: number; accepted: boolean }[] = [];
    const setGain = t.synth.setTrackGain.bind(t.synth);
    t.synth.setTrackGain = (id: string, gain: number, at: number, ramp: number) => {
      const accepted = setGain(id, gain, at, ramp); automation.push({ at, ramp, accepted }); return accepted;
    };
    state.tick++; state.remainingTicks = 10 * 60;
    t.audio.observeMusic(state, { matchId: 'browser', epoch: 1, generation: 0, snapshotSeq: 2 }, 0);
    await new Promise(r => setTimeout(r, 4000));
    const raised = pressure.gain.value;
    t.audio.volumes(.2, 0);
    await new Promise(r => setTimeout(r, 250));
    const musicGain = t.synth.readMixTaps().music.gain.value;
    const unchanged = t.synth.transportOrigin === origin;
    const effect = t.mixer.tryPreviewNote({ id: 'test', kind: 'sine', gain: .1 }, 60);
    t.audio.volumes(0, .8);
    await new Promise(r => setTimeout(r, 250));
    const mutedMusic = t.synth.readMixTaps().music.gain.value;
    await t.audio.engine.dispose();
    return { initial, raised, musicGain, mutedMusic, unchanged, origin, automation, effectBlocked: effect === null, errors: t.errors };
  });
  expect(report.initial).toBe(0); expect(report.raised).toBeCloseTo(1, 2);
  expect(report.musicGain).toBeCloseTo(.2, 2); expect(report.mutedMusic).toBeLessThan(.001);
  expect(report.automation).toHaveLength(2);
  for (const event of report.automation) {
    expect(event.accepted).toBe(true); expect(event.ramp).toBeCloseTo(240 / 144, 5);
    const boundary = (event.at - report.origin) / (240 / 144);
    expect(boundary).toBeCloseTo(Math.round(boundary), 5);
  }
  expect(report.unchanged).toBe(true); expect(report.effectBlocked).toBe(true); expect(report.errors).toEqual([]);
});

test('two real clients select confirmed sport and retain identity through suspended input and reconnect', async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const pages = await Promise.all(contexts.map(context => context.newPage()));
    for (const [index, page] of pages.entries()) {
      await harness(page);
      const roomId = index ? await pages[0].evaluate(() => (window as any).musicTest.client.lobby.roomId) : null;
      await page.evaluate(async ({ index, roomId }) => {
        const { createOnlineSession } = await import('../src/online/session.ts');
        const t = (window as any).musicTest;
        t.client = createOnlineSession({ endpoint: 'ws://127.0.0.1:2577', sportId: 'cryptcheck', name: 'Music QA' });
        await t.client.connect(index ? 'join' : 'private', roomId ?? undefined);
        t.timer = setInterval(() => {
          t.client.update();
          const snapshot = t.client.musicObservation();
          if (snapshot) { t.audio.observeMusic(snapshot.state, snapshot.stamp, snapshot.controlledTeam); t.latest = snapshot; }
        }, 20);
      }, { index, roomId });
    }
    await expect.poll(() => pages[0].evaluate(() => (window as any).musicTest.client.lobby?.seats.filter((seat: any) => seat.ready).length)).toBe(2);
    await pages[0].evaluate(() => (window as any).musicTest.client.start());
    for (const page of pages) {
      await expect.poll(() => page.evaluate(() => (window as any).musicTest.latest?.state.sportId), { timeout: 15000 }).toBe('cryptcheck');
      await expect.poll(() => page.evaluate(() => (window as any).musicTest.mixer.scene)).toBe('cryptcheck');
    }
    const initial = await pages[0].evaluate(() => (window as any).musicTest.latest.stamp);
    await pages[0].evaluate(() => (window as any).musicTest.client.suspend());
    const tick = await pages[0].evaluate(() => (window as any).musicTest.latest.state.tick);
    await expect.poll(() => pages[0].evaluate(() => (window as any).musicTest.latest.state.tick)).toBeGreaterThan(tick);
    await contexts[0].setOffline(true);
    await pages[0].waitForTimeout(300);
    await contexts[0].setOffline(false);
    await expect.poll(() => pages[0].evaluate(() => (window as any).musicTest.latest.stamp.generation), { timeout: 20000 }).toBeGreaterThan(initial.generation);
    const report = await pages[0].evaluate(() => {
      const t = (window as any).musicTest;
      return { matchId: t.latest.stamp.matchId, scene: t.mixer.scene, errors: t.errors, running: t.synth.isPlaying };
    });
    expect(report.matchId).toBe(initial.matchId); expect(report.scene).toBe('cryptcheck'); expect(report.running).toBe(true); expect(report.errors).toEqual([]);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('host selects every sport and returns through local pause and title without audio errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/games/cryptball/');
  for (const sport of ['cryptball', 'cryptkick', 'rift-volley', 'cryptcheck', 'crypt-dodge', 'crypt-guardian']) {
    await page.locator(`button[data-sport="${sport}"]`).click();
    await page.getByRole('button', { name: 'Single player', exact: true }).click();
    await expect.poll(async () => {
      const resume = page.getByRole('button', { name: 'Resume', exact: true });
      if (await resume.isVisible()) await resume.click();
      return await page.locator('#overlay').isHidden();
    }, { timeout: 30000 }).toBe(true);
    await expect(page.locator('canvas')).toHaveAttribute('data-sport-id', sport);
    await expect(page.locator('#notice')).toHaveText('');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Time out', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Title', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Single player', exact: true })).toBeVisible();
    await expect(page.locator('#notice')).toHaveText('');
  }
  expect(errors).toEqual([]);
});
