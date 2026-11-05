/** Rasterize the existing authoritative team marks before cloth composition. */
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../../', import.meta.url));
const out = `${root}apps/cryptball/art-src/banners-v1`;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
 const page = await browser.newPage({ viewport: { width: 64, height: 64 }, deviceScaleFactor: 1 });
 for (const id of ['rams','foxes','owls','gators','bats','hornets']) {
  const svg = readFileSync(`${root}apps/cryptball/public/assets/teams/${id}.svg`, 'utf8');
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:64px;height:64px}</style>${svg}`);
  await page.screenshot({ path: `${out}/emblem-${id}.png`, omitBackground: true });
 }
} finally { await browser.close(); }
const result = spawnSync(`${root}.venv-assets/bin/python`, [`${root}scripts/game-assets/import-cryptball-banners.py`], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
