import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "apps/cryptball/tests", testMatch: "special-input.spec.ts",
  outputDir: ".local-game-tests/cryptball-special-evidence", workers: 1,
  use: {baseURL: "http://127.0.0.1:4230", headless: true, viewport: {width:1280,height:800}, launchOptions: {args:["--use-gl=angle","--use-angle=swiftshader","--enable-webgl"]}},
  webServer: {command:"npx vite --config vite.cryptball.config.ts --host 127.0.0.1 --port 4230 --strictPort",url:"http://127.0.0.1:4230/games/cryptball/",reuseExistingServer:false,timeout:30000},
});
