import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'apps/cryptball/tests', testMatch: 'music-browser.spec.ts', workers: 1, timeout: 60000,
  outputDir: '.local-game-tests/cryptball-music-browser',
  use: { baseURL: 'http://127.0.0.1:4237', headless: true, trace: 'retain-on-failure', launchOptions: { args: ['--use-gl=angle', `--use-angle=${process.platform === 'darwin' ? 'metal' : 'swiftshader'}`, '--enable-webgl'] } },
  webServer: [
    { command: 'npm run build:cryptball:server && node dist/cryptball-server/main.mjs', env: { PORT: '2577', CRYPTBALL_ORIGINS: 'http://127.0.0.1:4237' }, url: 'http://127.0.0.1:2577/healthz', timeout: 120000 },
    { command: 'npx vite --config vite.cryptball.config.ts --host 127.0.0.1 --port 4237 --strictPort', env: { VITE_CRYPTBALL_SERVER: 'ws://127.0.0.1:2577' }, url: 'http://127.0.0.1:4237/games/cryptball/tests/music-harness.html', timeout: 120000 },
  ],
});
